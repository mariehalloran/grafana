import { DataSourceWithBackend, getTemplateSrv, type TemplateSrv } from '@grafana/runtime';

import { type AzureMonitorQuery } from '../types/query';
import {
  type AzureAPIResponse,
  type AzureMonitorDataSourceInstanceSettings,
  type AzureMonitorDataSourceJsonData,
} from '../types/types';
import { fetchAllArmPages, routeNames } from '../utils/common';

interface HealthModelResource {
  id: string;
  name: string;
}

const HEALTH_MODELS_API_VERSION = '2026-11-01';

export default class AzureHealthModelsDatasource extends DataSourceWithBackend<
  AzureMonitorQuery,
  AzureMonitorDataSourceJsonData
> {
  resourcePath: string;
  defaultSubscriptionId?: string;

  constructor(
    instanceSettings: AzureMonitorDataSourceInstanceSettings,
    private readonly templateSrv: TemplateSrv = getTemplateSrv()
  ) {
    super(instanceSettings);
    this.resourcePath = routeNames.azureMonitor;
    this.defaultSubscriptionId = instanceSettings.jsonData.subscriptionId;
  }

  getDataplaneUrl(): Promise<string> {
    // Local .env provisioning supplies this until ARM endpoint discovery is available.
    const url = this.datasourceInstanceSettings.jsonData.healthModelsDataplaneUrl;
    if (!url) {
      return Promise.reject(new Error('The Health Models dataplane URL is not configured'));
    }
    return Promise.resolve(url);
  }

  getEntityHealth(dataplaneUrl: string, entity: string, timeline: string): Promise<unknown> {
    return this.getResource<unknown>(
      routeNames.healthModels,
      { dataplaneUrl, path: entity, timestamp: timeline },
      { showErrorAlert: false }
    );
  }

  async getHealthModels(subscriptionId: string): Promise<Array<{ text: string; value: string }>> {
    const resolvedSubscriptionId = this.templateSrv.replace(subscriptionId || this.defaultSubscriptionId || '');
    if (!resolvedSubscriptionId) {
      return [];
    }

    const value = await fetchAllArmPages<HealthModelResource>(
      this.resourcePath,
      `${this.resourcePath}/subscriptions/${resolvedSubscriptionId}/providers/Microsoft.CloudHealth/healthmodels?api-version=${HEALTH_MODELS_API_VERSION}`,
      (path) => this.getResource<AzureAPIResponse<HealthModelResource>>(path)
    );

    return value
      .filter((model) => Boolean(model.id))
      .map((model) => ({
        text: model.name || model.id,
        value: model.id,
      }));
  }
}
