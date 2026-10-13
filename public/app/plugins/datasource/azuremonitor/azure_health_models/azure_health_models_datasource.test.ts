import { lastValueFrom } from 'rxjs';

import { type DataQueryRequest, dateTime, type Field, FieldType } from '@grafana/data';
import { GraphDrawStyle, LineInterpolation } from '@grafana/schema';

import { AzureQueryType } from '../dataquery.gen';
import { createMockInstanceSetttings } from '../mocks/instanceSettings';
import createMockQuery from '../mocks/query';
import { type AzureMonitorQuery } from '../types/query';

import AzureHealthModelsDatasource, { parseHealthModelResourceId } from './azure_health_models_datasource';
import { type HealthModelsControlPlaneClient, type HealthModelsEntityClient } from './healthModelsClient';
import { HEALTH_MODELS_API_VERSION } from './types';

const subscriptionId = '11111111-1111-1111-1111-111111111111';
const healthModelResourceId = `/subscriptions/${subscriptionId}/resourceGroups/rg-one/providers/Microsoft.CloudHealth/healthmodels/model-one`;
const queryRange = {
  from: dateTime('2026-01-01T00:00:00Z'),
  to: dateTime('2026-01-02T03:04:05Z'),
  raw: { from: 'now-1d', to: 'now' },
};
const queryTimestamp = encodeURIComponent(queryRange.to.toISOString());

function createMockControlPlaneClient(
  overrides: Partial<HealthModelsControlPlaneClient> = {}
): HealthModelsControlPlaneClient {
  return {
    listHealthModels: jest.fn().mockResolvedValue([]),
    listRelationships: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function createMockEntityClient(overrides: Partial<HealthModelsEntityClient> = {}): HealthModelsEntityClient {
  return {
    listEntities: jest.fn().mockResolvedValue([]),
    getEntityHistory: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('AzureHealthModelsDatasource', () => {
  it('loads Health Models directly from the Microsoft.CloudHealth ARM API', async () => {
    const datasource = new AzureHealthModelsDatasource(createMockInstanceSetttings());
    const getResource = jest.spyOn(datasource, 'getResource').mockResolvedValue({
      value: [
        {
          id: healthModelResourceId,
          name: 'model-one',
          type: 'Microsoft.CloudHealth/healthmodels',
        },
      ],
    });

    const models = await datasource.getHealthModels(subscriptionId);

    expect(models).toHaveLength(1);
    expect(getResource).toHaveBeenCalledWith(
      `azuremonitor/subscriptions/${subscriptionId}/providers/Microsoft.CloudHealth/healthmodels?api-version=${HEALTH_MODELS_API_VERSION}`
    );
  });

  it('rejects a Health Model resource ID from another subscription', async () => {
    const datasource = new AzureHealthModelsDatasource(createMockInstanceSetttings());
    const query = createMockQuery({
      queryType: AzureQueryType.AzureHealthModels,
      subscription: '22222222-2222-2222-2222-222222222222',
      azureHealthModels: { healthModelResourceId },
    });

    await expect(
      lastValueFrom(
        datasource.query({
          targets: [query],
          range: queryRange,
        } as DataQueryRequest<AzureMonitorQuery>)
      )
    ).rejects.toThrow('does not belong to the selected subscription');
  });

  it('loads graph entity data and relationships through independently configured clients', async () => {
    const controlPlaneClient = createMockControlPlaneClient();
    const entityClient = createMockEntityClient({
      listEntities: jest.fn().mockResolvedValue([
        {
          id: `${healthModelResourceId}/entities/entity-one`,
          name: 'entity-one',
          type: 'Microsoft.CloudHealth/healthmodels/entities',
          properties: { displayName: 'Entity One', healthState: 'Healthy' },
        },
      ]),
    });
    const datasource = new AzureHealthModelsDatasource(createMockInstanceSetttings(), undefined, {
      controlPlane: controlPlaneClient,
      entityData: entityClient,
    });
    const getResource = jest.spyOn(datasource, 'getResource');
    const query = createMockQuery({
      queryType: AzureQueryType.AzureHealthModels,
      subscription: subscriptionId,
      azureHealthModels: { healthModelResourceId },
    });

    const response = await lastValueFrom(
      datasource.query({
        targets: [query],
        range: queryRange,
      } as DataQueryRequest<AzureMonitorQuery>)
    );

    expect(response.data.map((frame) => frame.name)).toEqual(['nodes', 'edges']);
    expect(response.data[0].fields.find((field: Field) => field.name === 'title')?.values).toEqual(['Entity One']);
    expect(jest.mocked(entityClient.listEntities)).toHaveBeenCalledWith(
      healthModelResourceId,
      '2026-01-02T03:04:05.000Z'
    );
    expect(jest.mocked(controlPlaneClient.listRelationships)).toHaveBeenCalledWith(
      healthModelResourceId,
      '2026-01-02T03:04:05.000Z'
    );
    expect(getResource).not.toHaveBeenCalled();
  });

  it('loads timeline entities and history through the entity client without requesting relationships', async () => {
    const controlPlaneClient = createMockControlPlaneClient();
    const entityClient = createMockEntityClient({
      listEntities: jest.fn().mockResolvedValue([
        {
          id: `${healthModelResourceId}/entities/entity-one`,
          name: 'entity-one',
          type: 'Microsoft.CloudHealth/healthmodels/entities',
          properties: { displayName: 'Entity One', healthState: 'Degraded' },
        },
      ]),
      getEntityHistory: jest.fn().mockResolvedValue([
        {
          previousState: 'Healthy',
          newState: 'Degraded',
          occurredAt: '2026-01-01T01:00:00Z',
        },
      ]),
    });
    const datasource = new AzureHealthModelsDatasource(createMockInstanceSetttings(), undefined, {
      controlPlane: controlPlaneClient,
      entityData: entityClient,
    });
    const query = createMockQuery({
      queryType: AzureQueryType.AzureHealthModels,
      subscription: subscriptionId,
      azureHealthModels: { healthModelResourceId, resultFormat: 'timeSeries' },
    });

    const response = await lastValueFrom(
      datasource.query({
        targets: [query],
        range: queryRange,
      } as DataQueryRequest<AzureMonitorQuery>)
    );

    expect(response.data[0].fields.find((field: Field) => field.name === 'healthState')?.values).toEqual([0, 1, 1]);
    expect(jest.mocked(entityClient.listEntities)).toHaveBeenCalledWith(
      healthModelResourceId,
      '2026-01-02T03:04:05.000Z'
    );
    expect(jest.mocked(entityClient.getEntityHistory)).toHaveBeenCalledWith(healthModelResourceId, 'entity-one', {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T03:04:05.000Z',
    });
    expect(controlPlaneClient.listRelationships).not.toHaveBeenCalled();
  });

  it('returns paginated entity history as stepwise time series over the query range', async () => {
    const datasource = new AzureHealthModelsDatasource(createMockInstanceSetttings());
    const getResource = jest.spyOn(datasource, 'getResource').mockResolvedValue({
      value: [
        {
          id: `${healthModelResourceId}/entities/entity-one`,
          name: 'entity-one',
          type: 'Microsoft.CloudHealth/healthmodels/entities',
          properties: {
            displayName: 'Entity One',
            healthState: 'Healthy',
          },
        },
      ],
    });
    const postResource = jest
      .spyOn(datasource, 'postResource')
      .mockResolvedValueOnce({
        entityName: 'entity-one',
        history: [
          {
            previousState: 'Healthy',
            newState: 'Degraded',
            occurredAt: '2026-01-01T01:00:00Z',
            reason: 'Signal degraded',
          },
        ],
        nextMarker: 'page-two',
      })
      .mockResolvedValueOnce({
        entityName: 'entity-one',
        history: [
          {
            previousState: 'Degraded',
            newState: 'Healthy',
            occurredAt: '2026-01-01T02:00:00Z',
            reason: 'Signal recovered',
          },
        ],
      });
    const query = createMockQuery({
      queryType: AzureQueryType.AzureHealthModels,
      subscription: subscriptionId,
      azureHealthModels: { healthModelResourceId, resultFormat: 'timeSeries' },
    });

    const response = await lastValueFrom(
      datasource.query({
        targets: [query],
        range: queryRange,
      } as DataQueryRequest<AzureMonitorQuery>)
    );

    expect(response.data).toHaveLength(1);
    const frame = response.data[0];
    expect(frame.name).toBe('entity-one');
    expect(frame.meta).toBeUndefined();
    expect(frame.fields[0]).toMatchObject({
      name: 'Time',
      type: FieldType.time,
      values: [1767225600000, 1767229200000, 1767232800000, 1767323045000],
    });
    expect(frame.fields[1]).toMatchObject({
      name: 'healthState',
      type: FieldType.enum,
      values: [0, 1, 0, 0],
      labels: { entityName: 'entity-one' },
      config: {
        displayName: 'Entity One (entity-one)',
        custom: {
          drawStyle: GraphDrawStyle.Line,
          lineInterpolation: LineInterpolation.StepAfter,
        },
        type: {
          enum: {
            text: ['Healthy', 'Degraded', 'Unhealthy', 'Unknown'],
            color: ['green', 'orange', 'red', 'gray'],
          },
        },
      },
    });
    expect(getResource).toHaveBeenCalledTimes(1);
    expect(getResource).toHaveBeenCalledWith(
      `azuremonitor${healthModelResourceId}/entities?api-version=${HEALTH_MODELS_API_VERSION}&timestamp=${queryTimestamp}`
    );
    const historyPath = `azuremonitor${healthModelResourceId}/entities/entity-one/getHistory?api-version=${HEALTH_MODELS_API_VERSION}`;
    expect(postResource).toHaveBeenNthCalledWith(1, historyPath, {
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-01-02T03:04:05.000Z',
      top: 1000,
    });
    expect(postResource).toHaveBeenNthCalledWith(2, historyPath, {
      nextMarker: 'page-two',
      top: 1000,
    });
  });

  it('extends the end snapshot state across ranges without history transitions', async () => {
    const datasource = new AzureHealthModelsDatasource(createMockInstanceSetttings());
    jest.spyOn(datasource, 'getResource').mockResolvedValue({
      value: [
        {
          id: `${healthModelResourceId}/entities/entity-one`,
          name: 'entity-one',
          type: 'Microsoft.CloudHealth/healthmodels/entities',
          properties: {
            healthState: 'Unhealthy',
          },
        },
      ],
    });
    jest.spyOn(datasource, 'postResource').mockResolvedValue({
      entityName: 'entity-one',
      history: [],
    });
    const query = createMockQuery({
      queryType: AzureQueryType.AzureHealthModels,
      subscription: subscriptionId,
      azureHealthModels: { healthModelResourceId, resultFormat: 'timeSeries' },
    });

    const response = await lastValueFrom(
      datasource.query({
        targets: [query],
        range: queryRange,
      } as DataQueryRequest<AzureMonitorQuery>)
    );

    expect(response.data[0].fields[0].values).toEqual([1767225600000, 1767323045000]);
    expect(response.data[0].fields[1].values).toEqual([2, 2]);
  });

  it('parses a Microsoft.CloudHealth Health Model resource ID', () => {
    expect(parseHealthModelResourceId(healthModelResourceId)).toEqual({
      subscriptionId,
      resourceGroupName: 'rg-one',
      healthModelName: 'model-one',
    });
  });

  it('rejects encoded path separators in a Health Model resource ID', () => {
    expect(() =>
      parseHealthModelResourceId(
        `/subscriptions/${subscriptionId}/resourceGroups/rg%2Fother/providers/Microsoft.CloudHealth/healthmodels/model-one`
      )
    ).toThrow('not a valid Microsoft.CloudHealth Health Model resource ID');
  });
  it('returns node graph frames by default', async () => {
    const datasource = new AzureHealthModelsDatasource(createMockInstanceSetttings());
    const getResource = jest.spyOn(datasource, 'getResource').mockImplementation(async (path: string) => {
      if (path.includes('/entities?')) {
        return {
          value: [
            {
              id: 'a',
              name: 'parent-entity',
              type: 't',
              properties: { displayName: 'Parent', healthState: 'Healthy' },
            },
            { id: 'b', name: 'child-entity', type: 't', properties: { displayName: 'Child', healthState: 'Degraded' } },
          ],
        };
      }
      if (path.includes('/relationships?')) {
        return {
          value: [
            {
              id: 'r1',
              name: 'rel-one',
              type: 't',
              properties: { parentEntityName: 'parent-entity', childEntityName: 'child-entity' },
            },
            // References an entity outside the model, so it must be dropped.
            {
              id: 'r2',
              name: 'rel-two',
              type: 't',
              properties: { parentEntityName: 'parent-entity', childEntityName: 'missing-entity' },
            },
          ],
        };
      }
      throw new Error(`Unexpected resource path: ${path}`);
    });

    const query = createMockQuery({
      queryType: AzureQueryType.AzureHealthModels,
      subscription: subscriptionId,
      azureHealthModels: { healthModelResourceId },
    });

    const response = await lastValueFrom(
      datasource.query({
        targets: [query],
        range: queryRange,
      } as DataQueryRequest<AzureMonitorQuery>)
    );

    expect(response.data.map((frame) => frame.name)).toEqual(['nodes', 'edges']);
    expect(response.data[0].meta?.preferredVisualisationType).toBe('nodeGraph');
    const nodeField = (name: string) => response.data[0].fields.find((field: Field) => field.name === name)?.values;
    expect(nodeField('id')).toEqual(['parent-entity', 'child-entity']);
    expect(nodeField('title')).toEqual(['Parent', 'Child']);

    const edgeField = (name: string) => response.data[1].fields.find((field: Field) => field.name === name)?.values;
    expect(edgeField('source')).toEqual(['parent-entity']);
    expect(edgeField('target')).toEqual(['child-entity']);
    expect(getResource).toHaveBeenCalledTimes(2);
    expect(getResource).toHaveBeenCalledWith(
      `azuremonitor${healthModelResourceId}/entities?api-version=${HEALTH_MODELS_API_VERSION}&timestamp=${queryTimestamp}`
    );
    expect(getResource).toHaveBeenCalledWith(
      `azuremonitor${healthModelResourceId}/relationships?api-version=${HEALTH_MODELS_API_VERSION}&timestamp=${queryTimestamp}`
    );
  });
});
