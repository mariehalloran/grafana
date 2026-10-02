import { defer, from, type Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import {
  type DataFrame,
  type DataQueryRequest,
  type DataQueryResponse,
  type DataSourceInstanceSettings,
  FieldType,
  LoadingState,
  type ScopedVars,
  toDataFrame,
} from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv, type TemplateSrv } from '@grafana/runtime';
import { GraphDrawStyle, LineInterpolation } from '@grafana/schema';

import { type AzureMonitorQuery } from '../types/query';
import { type AzureMonitorDataSourceJsonData } from '../types/types';

import { getEntityHealthMetrics } from './entityHealthMetrics';
import { ArmHealthModelsClient, type HealthModelsClients, type HealthModelsResourceClient } from './healthModelsClient';
import {
  type HealthModel,
  type HealthModelEntity,
  type HealthModelEntityHistoryTransition,
  type HealthModelRelationship,
  type HealthModelResourceId,
  type HealthModelTimeRange,
} from './types';

const ENTITY_HISTORY_CONCURRENCY = 10;

export default class AzureHealthModelsDatasource extends DataSourceWithBackend<
  AzureMonitorQuery,
  AzureMonitorDataSourceJsonData
> {
  private readonly healthModelsClients: HealthModelsClients;

  constructor(
    instanceSettings: DataSourceInstanceSettings<AzureMonitorDataSourceJsonData>,
    private readonly templateSrv: TemplateSrv = getTemplateSrv(),
    healthModelsClients?: HealthModelsClients
  ) {
    super(instanceSettings);
    const resourceClient: HealthModelsResourceClient = {
      get: <T>(path: string) => this.getResource<T>(path),
      post: <T>(path: string, body: Record<string, string | number>) => this.postResource<T>(path, body),
    };
    const armClient = new ArmHealthModelsClient(resourceClient);
    this.healthModelsClients = healthModelsClients ?? {
      controlPlane: armClient,
      entityData: armClient,
    };
  }

  filterQuery(query: AzureMonitorQuery): boolean {
    return Boolean(query.azureHealthModels?.healthModelId);
  }

  applyTemplateVariables(target: AzureMonitorQuery, scopedVars: ScopedVars): AzureMonitorQuery {
    const healthModelId = target.azureHealthModels?.healthModelId;
    return {
      ...target,
      subscription: target.subscription ? this.templateSrv.replace(target.subscription, scopedVars) : undefined,
      azureHealthModels: {
        ...target.azureHealthModels,
        healthModelId: healthModelId ? this.templateSrv.replace(healthModelId, scopedVars) : undefined,
      },
    };
  }

  query(options: DataQueryRequest<AzureMonitorQuery>): Observable<DataQueryResponse> {
    const range = {
      from: options.range.from.toISOString(),
      to: options.range.to.toISOString(),
    };
    return defer(() => from(this.loadFrames(options.targets, range))).pipe(
      map((data) => ({
        data,
        state: LoadingState.Done,
      }))
    );
  }

  getHealthModels(subscriptionId: string): Promise<HealthModel[]> {
    return this.healthModelsClients.controlPlane.listHealthModels(subscriptionId);
  }

  private async loadFrames(targets: AzureMonitorQuery[], range: HealthModelTimeRange): Promise<DataFrame[]> {
    const targetFrames = await Promise.all(
      targets.map(async (target) => {
        const healthModelId = target.azureHealthModels?.healthModelId;
        if (!healthModelId) {
          return [];
        }

        const resourceId = parseHealthModelResourceId(healthModelId);
        if (target.subscription && resourceId.subscriptionId.toLowerCase() !== target.subscription.toLowerCase()) {
          throw new Error('The selected Health Model does not belong to the selected subscription.');
        }

        if (target.azureHealthModels?.resultFormat === 'timeSeries') {
          const entities = await this.healthModelsClients.entityData.listEntities(healthModelId, range.to);
          return this.loadEntityHistoryFrames(target.refId, healthModelId, entities, range);
        }

        const [entities, relationships] = await Promise.all([
          this.healthModelsClients.entityData.listEntities(healthModelId, range.to),
          this.healthModelsClients.controlPlane.listRelationships(healthModelId, range.to),
        ]);

        return nodeGraphFrames(target.refId, entities, relationships);
      })
    );

    return targetFrames.flat();
  }

  private async loadEntityHistoryFrames(
    refId: string,
    healthModelId: string,
    entities: HealthModelEntity[],
    range: HealthModelTimeRange
  ): Promise<DataFrame[]> {
    const frames: DataFrame[] = [];

    for (let index = 0; index < entities.length; index += ENTITY_HISTORY_CONCURRENCY) {
      const entityBatch = entities.slice(index, index + ENTITY_HISTORY_CONCURRENCY);
      frames.push(
        ...(await Promise.all(
          entityBatch.map(async (entity) => {
            const history = await this.healthModelsClients.entityData.getEntityHistory(
              healthModelId,
              entity.name,
              range
            );
            return entityHistoryFrame(refId, entity, history, range);
          })
        ))
      );
    }

    return frames;
  }
}

export function parseHealthModelResourceId(healthModelId: string): HealthModelResourceId {
  const match =
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.CloudHealth\/healthmodels\/([^/?#]+)$/i.exec(
      healthModelId
    );

  if (!match) {
    throw new Error('The selected value is not a valid Microsoft.CloudHealth Health Model resource ID.');
  }

  const [, subscriptionId, resourceGroupName, healthModelName] = match;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId) ||
    resourceGroupName === '.' ||
    resourceGroupName === '..' ||
    healthModelName === '.' ||
    healthModelName === '..' ||
    /%(2f|5c)/i.test(resourceGroupName) ||
    /%(2f|5c)/i.test(healthModelName)
  ) {
    throw new Error('The selected value is not a valid Microsoft.CloudHealth Health Model resource ID.');
  }

  return {
    subscriptionId,
    resourceGroupName,
    healthModelName,
  };
}

/** Health states in a fixed order so the enum field's numeric values are stable. */
const HEALTH_STATES = ['Healthy', 'Degraded', 'Unhealthy', 'Unknown'];
const HEALTH_STATE_TEXT_COLORS = ['green', 'orange', 'red', 'gray'];

function healthStateValue(healthState?: string): number {
  const index = HEALTH_STATES.indexOf(healthState ?? 'Unknown');
  return index === -1 ? HEALTH_STATES.indexOf('Unknown') : index;
}

function entityHistoryFrame(
  refId: string,
  entity: HealthModelEntity,
  history: HealthModelEntityHistoryTransition[],
  range: HealthModelTimeRange
): DataFrame {
  const rangeStart = Date.parse(range.from);
  const rangeEnd = Date.parse(range.to);
  const transitions = history
    .map((transition) => {
      const timestamp = Date.parse(transition.occurredAt);
      if (Number.isNaN(timestamp)) {
        throw new Error(`Entity history returned an invalid timestamp for "${entity.name}".`);
      }
      return { transition, timestamp };
    })
    .filter(({ timestamp }) => timestamp >= rangeStart && timestamp <= rangeEnd)
    .sort((left, right) => left.timestamp - right.timestamp);
  const firstState = transitions[0]?.transition.previousState ?? entity.properties?.healthState;
  const times = [rangeStart];
  const states = [healthStateValue(firstState)];

  for (const { transition, timestamp } of transitions) {
    const state = healthStateValue(transition.newState);
    if (times[times.length - 1] === timestamp) {
      states[states.length - 1] = state;
    } else {
      times.push(timestamp);
      states.push(state);
    }
  }

  const endState = healthStateValue(entity.properties?.healthState ?? transitions.at(-1)?.transition.newState);
  if (times[times.length - 1] === rangeEnd) {
    states[states.length - 1] = endState;
  } else {
    times.push(rangeEnd);
    states.push(endState);
  }

  const displayName = entity.properties?.displayName;
  const seriesName = displayName && displayName !== entity.name ? `${displayName} (${entity.name})` : entity.name;

  return toDataFrame({
    name: entity.name,
    refId,
    fields: [
      {
        name: 'Time',
        type: FieldType.time,
        values: times,
      },
      {
        name: 'healthState',
        type: FieldType.enum,
        values: states,
        labels: { entityName: entity.name },
        config: {
          displayName: seriesName,
          custom: {
            drawStyle: GraphDrawStyle.Line,
            lineInterpolation: LineInterpolation.StepAfter,
          },
          type: { enum: { text: HEALTH_STATES, color: HEALTH_STATE_TEXT_COLORS } },
        },
      },
    ],
  });
}

/** Health state colours, fixed because frames are built outside React and have no theme access. */
const HEALTH_STATE_COLORS: Record<string, string> = {
  healthy: '#3FB950',
  degraded: '#D29922',
  unhealthy: '#F85149',
  unknown: '#8B949E',
};

/**
 * Builds the two frames the Node Graph panel expects: nodes keyed by `id`, and edges referencing
 * those ids through `source` and `target`.
 *
 * Entities are keyed by `name` rather than `displayName` because relationships reference names and
 * display names are not unique within a model.
 */
function nodeGraphFrames(
  refId: string,
  entities: HealthModelEntity[],
  relationships: HealthModelRelationship[]
): DataFrame[] {
  const metrics = new Map(entities.map((entity) => [entity.name, getEntityHealthMetrics(entity)]));
  const known = new Set(entities.map((entity) => entity.name));

  // An edge to an entity outside the model would render as a ghost node with no health state.
  const edges = relationships.filter((relationship) => {
    const parent = relationship.properties?.parentEntityName;
    const child = relationship.properties?.childEntityName;
    return parent && child && known.has(parent) && known.has(child);
  });

  const nodes = toDataFrame({
    name: 'nodes',
    refId,
    meta: { preferredVisualisationType: 'nodeGraph' },
    fields: [
      { name: 'id', type: FieldType.string, values: entities.map((entity) => entity.name) },
      {
        name: 'title',
        type: FieldType.string,
        values: entities.map((entity) => entity.properties?.displayName ?? entity.name),
      },
      {
        name: 'subtitle',
        type: FieldType.string,
        values: entities.map((entity) => entity.properties?.healthState ?? 'Unknown'),
      },
      {
        name: 'mainstat',
        type: FieldType.string,
        values: entities.map((entity) => {
          const metric = metrics.get(entity.name);
          if (!metric?.signals.length) {
            return entity.properties?.healthState ?? 'Unknown';
          }
          const healthy = metric.signals.filter((signal) => signal.healthState?.toLowerCase() === 'healthy').length;
          return `${healthy}/${metric.signals.length} signals`;
        }),
      },
      {
        name: 'color',
        type: FieldType.string,
        values: entities.map(
          (entity) =>
            HEALTH_STATE_COLORS[(entity.properties?.healthState ?? 'unknown').toLowerCase()] ??
            HEALTH_STATE_COLORS.unknown
        ),
      },
      {
        name: 'detail__impact',
        type: FieldType.string,
        values: entities.map((entity) => entity.properties?.impact ?? '--'),
        config: { displayName: 'Impact' },
      },
      {
        name: 'detail__alerts',
        type: FieldType.string,
        values: entities.map((entity) => metrics.get(entity.name)?.alertSeverities.join(', ') || '--'),
        config: { displayName: 'Alerts' },
      },
    ],
  });

  const edgeFrame = toDataFrame({
    name: 'edges',
    refId,
    meta: { preferredVisualisationType: 'nodeGraph' },
    fields: [
      { name: 'id', type: FieldType.string, values: edges.map((relationship) => relationship.name) },
      {
        name: 'source',
        type: FieldType.string,
        values: edges.map((relationship) => relationship.properties!.parentEntityName!),
      },
      {
        name: 'target',
        type: FieldType.string,
        values: edges.map((relationship) => relationship.properties!.childEntityName!),
      },
      {
        name: 'mainstat',
        type: FieldType.string,
        values: edges.map((relationship) => relationship.properties?.displayName ?? relationship.name),
      },
    ],
  });

  return [nodes, edgeFrame];
}
