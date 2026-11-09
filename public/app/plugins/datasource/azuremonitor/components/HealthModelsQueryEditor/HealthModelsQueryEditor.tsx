import { useEffect, useState } from 'react';

import { type TimeRange } from '@grafana/data';
import { EditorFieldGroup, EditorRow, EditorRows } from '@grafana/plugin-ui';
import { type ComboboxOption } from '@grafana/ui';

import { AzureHealthModelsQueryType, AzureQueryType } from '../../dataquery.gen';
import type Datasource from '../../datasource';
import { type AzureMonitorQuery } from '../../types/query';
import { type AzureMonitorErrorish, type VariableOptionGroup } from '../../types/types';

import HealthModelField from './HealthModelField';
import HealthModelsQueryTypeField from './HealthModelsQueryTypeField';
import SubscriptionField from './SubscriptionField';

interface HealthModelsQueryEditorProps {
  query: AzureMonitorQuery;
  datasource: Datasource;
  subscriptionId?: string;
  range?: TimeRange;
  variableOptionGroup?: VariableOptionGroup;
  onChange: (newQuery: AzureMonitorQuery) => void;
  setError: (source: string, error: AzureMonitorErrorish | undefined) => void;
}

const SUBSCRIPTIONS_ERROR_SOURCE = 'health-models-subscriptions';
const HEALTH_MODELS_ERROR_SOURCE = 'health-models-list';
const HEALTH_MODELS_DATA_PLANE_ERROR_SOURCE = 'health-models-data-plane';
const DEFAULT_HEALTH_MODELS_QUERY_TYPE = AzureHealthModelsQueryType.EntityHealthSnapshot;
const HEALTH_MODELS_QUERY_TYPES = new Set<AzureHealthModelsQueryType>([
  AzureHealthModelsQueryType.EntityHealthSnapshot,
  AzureHealthModelsQueryType.EntityHealthHistory,
]);

const HealthModelsQueryEditor = ({
  query,
  datasource,
  subscriptionId,
  range,
  variableOptionGroup,
  onChange,
  setError,
}: HealthModelsQueryEditorProps) => {
  const [subscriptions, setSubscriptions] = useState<Array<ComboboxOption<string>>>([]);
  const [healthModels, setHealthModels] = useState<Array<ComboboxOption<string>>>([]);
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(true);
  const [loadingHealthModels, setLoadingHealthModels] = useState(Boolean(query.subscription || subscriptionId));
  const selectedSubscription = query.subscription || subscriptionId || subscriptions[0]?.value;
  const selectedHealthModelResourceId = query.azureHealthModels?.healthModelResourceId;
  const selectedHealthModelsQueryType = query.azureHealthModels?.queryType;
  const dataplaneUrl = query.azureHealthModels?.dataplaneUrl;
  const entity = datasource.datasourceInstanceSettings?.jsonData.healthModelsEntityPath;
  const timestamp = range?.to.toISOString();
  const subscriptionOptions = variableOptionGroup
    ? [
        ...subscriptions,
        ...variableOptionGroup.options.map((option) => ({
          label: option.label,
          value: option.value,
          group: variableOptionGroup.label,
        })),
      ]
    : subscriptions;

  useEffect(() => {
    let canceled = false;

    datasource
      .getSubscriptions()
      .then((results) => {
        if (!canceled) {
          setSubscriptions(
            results.map((subscription) => ({
              label: subscription.text,
              value: subscription.value,
              description: subscription.value,
            }))
          );
          setError(SUBSCRIPTIONS_ERROR_SOURCE, undefined);
        }
      })
      .catch((error) => {
        if (!canceled) {
          setError(SUBSCRIPTIONS_ERROR_SOURCE, error);
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoadingSubscriptions(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [datasource, setError]);

  useEffect(() => {
    let canceled = false;

    if (!selectedSubscription) {
      setError(HEALTH_MODELS_ERROR_SOURCE, undefined);
      return;
    }

    datasource
      .getHealthModels(selectedSubscription)
      .then((results) => {
        if (!canceled) {
          const options = results.map((healthModel) => ({
            label: healthModel.text,
            value: healthModel.value,
            description: healthModel.value,
          }));

          setHealthModels(options);
          setError(HEALTH_MODELS_ERROR_SOURCE, undefined);
        }
      })
      .catch((error) => {
        if (!canceled) {
          setError(HEALTH_MODELS_ERROR_SOURCE, error);
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoadingHealthModels(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [datasource, selectedSubscription, setError]);

  useEffect(() => {
    let canceled = false;
    if (!selectedSubscription || !selectedHealthModelResourceId || dataplaneUrl) {
      return;
    }

    setError(HEALTH_MODELS_DATA_PLANE_ERROR_SOURCE, undefined);
    datasource.azureHealthModelsDatasource
      .getDataplaneUrl()
      .then((url) => {
        if (!canceled) {
          onChange({
            ...query,
            subscription: selectedSubscription,
            azureHealthModels: {
              ...query.azureHealthModels,
              dataplaneUrl: url,
            },
          });
        }
      })
      .catch((error) => {
        if (!canceled) {
          setError(HEALTH_MODELS_DATA_PLANE_ERROR_SOURCE, error);
        }
      });

    return () => {
      canceled = true;
    };
  }, [dataplaneUrl, datasource, onChange, query, selectedHealthModelResourceId, selectedSubscription, setError]);

  useEffect(() => {
    let canceled = false;
    if (!selectedSubscription || !selectedHealthModelResourceId || !dataplaneUrl) {
      return;
    }
    setError(HEALTH_MODELS_DATA_PLANE_ERROR_SOURCE, undefined);

    if (!entity) {
      setError(HEALTH_MODELS_DATA_PLANE_ERROR_SOURCE, new Error('The Health Models entity path is not configured'));
      return;
    }

    datasource.azureHealthModelsDatasource
      .getEntityHealth(dataplaneUrl, entity, timestamp ?? new Date().toISOString())
      .then((result) => {
        if (!canceled) {
          console.log('Azure Monitor Health Models dataplane response', result);
          setError(HEALTH_MODELS_DATA_PLANE_ERROR_SOURCE, undefined);
        }
      })
      .catch((error) => {
        if (!canceled) {
          setError(HEALTH_MODELS_DATA_PLANE_ERROR_SOURCE, error);
        }
      });

    return () => {
      canceled = true;
    };
  }, [dataplaneUrl, datasource, entity, selectedSubscription, selectedHealthModelResourceId, setError, timestamp]);

  useEffect(() => {
    const topHealthModelResourceId = healthModels[0]?.value;
    if (!topHealthModelResourceId || !selectedSubscription) {
      return;
    }

    if (selectedHealthModelResourceId && healthModels.some((model) => model.value === selectedHealthModelResourceId)) {
      return;
    }

    onChange({
      ...query,
      subscription: selectedSubscription,
      azureHealthModels: {
        ...query.azureHealthModels,
        healthModelResourceId: topHealthModelResourceId,
        dataplaneUrl: undefined,
        queryType: query.azureHealthModels?.queryType ?? DEFAULT_HEALTH_MODELS_QUERY_TYPE,
      },
    });
  }, [healthModels, onChange, query, selectedHealthModelResourceId, selectedSubscription]);

  useEffect(() => {
    if (!selectedHealthModelResourceId || selectedHealthModelsQueryType) {
      return;
    }

    onChange({
      ...query,
      subscription: selectedSubscription,
      queryType: AzureQueryType.AzureHealthModels,
      azureHealthModels: {
        ...query.azureHealthModels,
        healthModelResourceId: selectedHealthModelResourceId,
        queryType: DEFAULT_HEALTH_MODELS_QUERY_TYPE,
      },
    });
  }, [onChange, query, selectedHealthModelResourceId, selectedHealthModelsQueryType, selectedSubscription]);

  const onSubscriptionChange = (selection: ComboboxOption<string>) => {
    setHealthModels([]);
    setLoadingHealthModels(Boolean(selection.value));
    onChange({
      ...query,
      subscription: selection.value,
      azureHealthModels: {
        ...query.azureHealthModels,
        healthModelResourceId: undefined,
        dataplaneUrl: undefined,
      },
    });
  };

  const onHealthModelChange = (selection: ComboboxOption<string>) => {
    onChange({
      ...query,
      subscription: selectedSubscription,
      queryType: AzureQueryType.AzureHealthModels,
      azureHealthModels: {
        ...query.azureHealthModels,
        healthModelResourceId: selection.value,
        dataplaneUrl: selection.value === selectedHealthModelResourceId ? dataplaneUrl : undefined,
        queryType: query.azureHealthModels?.queryType ?? DEFAULT_HEALTH_MODELS_QUERY_TYPE,
      },
    });
  };

  const onQueryTypeChange = (selection: ComboboxOption<AzureHealthModelsQueryType>) => {
    if (!selection.value || !HEALTH_MODELS_QUERY_TYPES.has(selection.value)) {
      return;
    }

    onChange({
      ...query,
      subscription: selectedSubscription,
      queryType: AzureQueryType.AzureHealthModels,
      azureHealthModels: {
        ...query.azureHealthModels,
        healthModelResourceId: selectedHealthModelResourceId,
        queryType: selection.value,
      },
    });
  };

  return (
    <EditorRows>
      <EditorRow>
        <EditorFieldGroup>
          <SubscriptionField
            subscriptions={subscriptionOptions}
            selectedSubscription={selectedSubscription}
            loadingSubscriptions={loadingSubscriptions}
            onSubscriptionChange={onSubscriptionChange}
          />
          <HealthModelField
            healthModels={healthModels}
            selectedHealthModelResourceId={selectedHealthModelResourceId}
            loadingHealthModels={loadingHealthModels}
            hasSelectedSubscription={Boolean(selectedSubscription)}
            onHealthModelChange={onHealthModelChange}
          />
          <HealthModelsQueryTypeField
            selectedHealthModelsQueryType={selectedHealthModelsQueryType}
            disabled={!selectedHealthModelResourceId}
            onQueryTypeChange={onQueryTypeChange}
          />
        </EditorFieldGroup>
      </EditorRow>
    </EditorRows>
  );
};

export default HealthModelsQueryEditor;
