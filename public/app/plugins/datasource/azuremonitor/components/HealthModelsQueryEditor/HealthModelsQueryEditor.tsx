import { useEffect, useMemo, useState } from 'react';

import { t } from '@grafana/i18n';
import { EditorFieldGroup, EditorRow, EditorRows } from '@grafana/plugin-ui';
import { Combobox, type ComboboxOption } from '@grafana/ui';

import type Datasource from '../../datasource';
import { type AzureMonitorQuery } from '../../types/query';
import { type AzureMonitorErrorish, type AzureMonitorOption } from '../../types/types';
import { Field } from '../shared/Field';

interface Props {
  query: AzureMonitorQuery;
  datasource: Datasource;
  subscriptionId?: string;
  onChange: (query: AzureMonitorQuery) => void;
  variableOptionGroup: { label: string; options: AzureMonitorOption[] };
  setError: (source: string, error: AzureMonitorErrorish | undefined) => void;
}

const SUBSCRIPTIONS_ERROR = 'health-models-subscriptions';
const MODELS_ERROR = 'health-models-list';

export default function HealthModelsQueryEditor({
  query,
  datasource,
  subscriptionId,
  onChange,
  variableOptionGroup,
  setError,
}: Props) {
  const [subscriptions, setSubscriptions] = useState<Array<ComboboxOption<string>>>([]);
  const [healthModels, setHealthModels] = useState<Array<ComboboxOption<string>>>([]);
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(true);
  const [loadingHealthModels, setLoadingHealthModels] = useState(false);
  const selectedSubscription = query.subscription || subscriptionId || subscriptions[0]?.value;
  const selectedModel = query.azureHealthModels?.healthModelResourceId;

  useEffect(() => {
    let canceled = false;
    setLoadingSubscriptions(true);
    setError(SUBSCRIPTIONS_ERROR, undefined);
    datasource
      .getSubscriptions()
      .then((results) => {
        if (!canceled) {
          setSubscriptions(results.map(({ text, value }) => ({ label: text, value, description: value })));
        }
      })
      .catch((error) => {
        if (!canceled) {
          setError(SUBSCRIPTIONS_ERROR, error);
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoadingSubscriptions(false);
        }
      });
    return () => {
      canceled = true;
      setError(SUBSCRIPTIONS_ERROR, undefined);
    };
  }, [datasource, setError]);

  useEffect(() => {
    if (!query.subscription && selectedSubscription) {
      onChange({ ...query, subscription: selectedSubscription });
    }
  }, [onChange, query, selectedSubscription]);

  useEffect(() => {
    let canceled = false;
    setHealthModels([]);
    setError(MODELS_ERROR, undefined);
    setLoadingHealthModels(Boolean(selectedSubscription));
    if (selectedSubscription) {
      datasource
        .getHealthModels(selectedSubscription)
        .then((models) => {
          if (!canceled) {
            setHealthModels(
              models.map(({ id, name }) => ({
                value: id,
                label: `${name} (${id.split('/')[4]})`,
                description: id,
              }))
            );
          }
        })
        .catch((error) => {
          if (!canceled) {
            setError(MODELS_ERROR, error);
          }
        })
        .finally(() => {
          if (!canceled) {
            setLoadingHealthModels(false);
          }
        });
    }
    return () => {
      canceled = true;
      setError(MODELS_ERROR, undefined);
    };
  }, [datasource, selectedSubscription, setError]);

  const subscriptionOptions = useMemo(
    () => [
      ...subscriptions,
      ...variableOptionGroup.options.map(({ label, value }) => ({
        label,
        value,
        group: variableOptionGroup.label,
      })),
    ],
    [subscriptions, variableOptionGroup]
  );

  return (
    <EditorRows>
      <EditorRow>
        <EditorFieldGroup>
          <Field label={t('components.health-models-query-editor.label-subscription', 'Subscription')}>
            <Combobox
              aria-label={t('components.health-models-query-editor.label-subscription', 'Subscription')}
              options={subscriptionOptions}
              value={selectedSubscription}
              loading={loadingSubscriptions}
              width={36}
              onChange={({ value }) =>
                onChange({
                  ...query,
                  subscription: value,
                  azureHealthModels: { ...query.azureHealthModels, healthModelResourceId: undefined },
                })
              }
            />
          </Field>
          <Field label={t('components.health-models-query-editor.label-health-model', 'Health Model')}>
            <Combobox
              aria-label={t('components.health-models-query-editor.label-health-model', 'Health Model')}
              options={healthModels}
              value={selectedModel}
              loading={loadingHealthModels}
              disabled={!selectedSubscription}
              width={48}
              onChange={({ value }) =>
                onChange({
                  ...query,
                  subscription: selectedSubscription,
                  azureHealthModels: { ...query.azureHealthModels, healthModelResourceId: value },
                })
              }
            />
          </Field>
        </EditorFieldGroup>
      </EditorRow>
    </EditorRows>
  );
}
