import { fetchAllArmPages, routeNames } from '../utils/common';

import {
  type ArmListResponse,
  HEALTH_MODELS_API_VERSION,
  type HealthModel,
  type HealthModelEntity,
  type HealthModelEntityHistoryResponse,
  type HealthModelEntityHistoryTransition,
  type HealthModelRelationship,
  type HealthModelTimeRange,
} from './types';

const ENTITY_HISTORY_PAGE_SIZE = 1000;

export interface HealthModelsResourceClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: Record<string, string | number>): Promise<T>;
}

export interface HealthModelsControlPlaneClient {
  listHealthModels(subscriptionId: string): Promise<HealthModel[]>;
  listRelationships(healthModelId: string, timestamp: string): Promise<HealthModelRelationship[]>;
}

export interface HealthModelsEntityClient {
  listEntities(healthModelId: string, timestamp: string): Promise<HealthModelEntity[]>;
  getEntityHistory(
    healthModelId: string,
    entityName: string,
    range: HealthModelTimeRange
  ): Promise<HealthModelEntityHistoryTransition[]>;
}

export interface HealthModelsClients {
  controlPlane: HealthModelsControlPlaneClient;
  entityData: HealthModelsEntityClient;
}

export class ArmHealthModelsClient implements HealthModelsControlPlaneClient, HealthModelsEntityClient {
  private readonly resourcePath = routeNames.azureMonitor;

  constructor(private readonly resourceClient: HealthModelsResourceClient) {}

  listHealthModels(subscriptionId: string): Promise<HealthModel[]> {
    const collectionPath = `/subscriptions/${subscriptionId}/providers/Microsoft.CloudHealth/healthmodels`;
    return fetchAllArmPages<HealthModel>(
      this.resourcePath,
      `${this.resourcePath}${collectionPath}?api-version=${HEALTH_MODELS_API_VERSION}`,
      (path) => this.resourceClient.get<ArmListResponse<HealthModel>>(path)
    );
  }

  listEntities(healthModelId: string, timestamp: string): Promise<HealthModelEntity[]> {
    return this.listCollection<HealthModelEntity>(`${healthModelId}/entities`, timestamp);
  }

  listRelationships(healthModelId: string, timestamp: string): Promise<HealthModelRelationship[]> {
    return this.listCollection<HealthModelRelationship>(`${healthModelId}/relationships`, timestamp);
  }

  async getEntityHistory(
    healthModelId: string,
    entityName: string,
    range: HealthModelTimeRange
  ): Promise<HealthModelEntityHistoryTransition[]> {
    const query = new URLSearchParams({ 'api-version': HEALTH_MODELS_API_VERSION });
    const path = `${this.resourcePath}${healthModelId}/entities/${encodeURIComponent(entityName)}/getHistory?${query.toString()}`;
    let response = await this.resourceClient.post<HealthModelEntityHistoryResponse>(path, {
      startAt: range.from,
      endAt: range.to,
      top: ENTITY_HISTORY_PAGE_SIZE,
    });
    const history = [...response.history];
    const seenMarkers = new Set<string>();

    while (response.nextMarker) {
      if (seenMarkers.has(response.nextMarker)) {
        throw new Error(`Entity history pagination returned the same marker more than once for "${entityName}".`);
      }
      seenMarkers.add(response.nextMarker);
      response = await this.resourceClient.post<HealthModelEntityHistoryResponse>(path, {
        nextMarker: response.nextMarker,
        top: ENTITY_HISTORY_PAGE_SIZE,
      });
      history.push(...response.history);
    }

    return history;
  }

  private listCollection<T>(collectionPath: string, timestamp: string): Promise<T[]> {
    const query = new URLSearchParams({
      'api-version': HEALTH_MODELS_API_VERSION,
      timestamp,
    });
    return fetchAllArmPages<T>(this.resourcePath, `${this.resourcePath}${collectionPath}?${query.toString()}`, (path) =>
      this.resourceClient.get<ArmListResponse<T>>(path)
    );
  }
}
