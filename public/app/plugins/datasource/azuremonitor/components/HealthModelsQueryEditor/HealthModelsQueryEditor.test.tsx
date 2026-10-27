import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps } from 'react';

import { getTemplateSrv } from '@grafana/runtime';
import { mockComboboxRect } from '@grafana/test-utils';

import { AzureQueryType } from '../../dataquery.gen';
import createMockDatasource from '../../mocks/datasource';
import { type AzureHealthModel } from '../../types/types';

import HealthModelsQueryEditor from './HealthModelsQueryEditor';

const subscription = '11111111-1111-1111-1111-111111111111';
const otherSubscription = '22222222-2222-2222-2222-222222222222';
const modelId = `/subscriptions/${subscription}/resourceGroups/rg-one/providers/Microsoft.CloudHealth/healthmodels/model`;
const otherModelId = `/subscriptions/${subscription}/resourceGroups/rg-two/providers/Microsoft.CloudHealth/healthmodels/model`;
const newSubscriptionModelId = `/subscriptions/${otherSubscription}/resourceGroups/rg-three/providers/Microsoft.CloudHealth/healthmodels/new-model`;

jest.mock('@grafana/runtime', () => {
  const templateSrv = {
    replace: jest.fn(),
    getVariables: jest.fn(),
    containsTemplate: jest.fn(),
    updateTimeRange: jest.fn(),
  };
  return {
    ...jest.requireActual('@grafana/runtime'),
    getTemplateSrv: () => templateSrv,
  };
});

function setup(overrides: Partial<ComponentProps<typeof HealthModelsQueryEditor>> = {}) {
  const props: ComponentProps<typeof HealthModelsQueryEditor> = {
    query: { refId: 'A', queryType: AzureQueryType.AzureHealthModels, subscription },
    datasource: createMockDatasource({
      getSubscriptions: jest.fn().mockResolvedValue([
        { text: 'Subscription One', value: subscription },
        { text: 'Subscription Two', value: otherSubscription },
      ]),
      getHealthModels: jest.fn().mockResolvedValue([
        { id: modelId, name: 'model' },
        { id: otherModelId, name: 'model' },
      ]),
    }),
    onChange: jest.fn(),
    setError: jest.fn(),
    variableOptionGroup: { label: 'Template Variables', options: [{ label: '$subscription', value: '$subscription' }] },
    ...overrides,
  };
  return { ...render(<HealthModelsQueryEditor {...props} />), ...props, user: userEvent.setup() };
}

describe('HealthModelsQueryEditor', () => {
  beforeAll(() => {
    mockComboboxRect();
  });

  beforeEach(() => {
    jest.mocked(getTemplateSrv().replace).mockImplementation((value) => value ?? '');
  });

  it('distinguishes models with the same name by resource group and stores the full selected ARM ID', async () => {
    const { user, onChange, query, datasource } = setup();
    await user.click(screen.getByRole('combobox', { name: 'Health Model' }));
    expect(await screen.findByRole('option', { name: /model \(rg-one\)/ })).toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: /model \(rg-two\)/ }));
    expect(datasource.getHealthModels).toHaveBeenCalledWith(subscription);
    expect(onChange).toHaveBeenLastCalledWith({
      ...query,
      subscription,
      azureHealthModels: { healthModelResourceId: otherModelId },
    });
  });

  it('clears the selected model when a different subscription is selected', async () => {
    const { user, query, onChange } = setup({
      query: {
        refId: 'A',
        queryType: AzureQueryType.AzureHealthModels,
        subscription,
        azureHealthModels: { healthModelResourceId: modelId },
      },
    });
    await user.click(screen.getByRole('combobox', { name: 'Subscription' }));
    await user.click(await screen.findByRole('option', { name: /Subscription Two/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...query,
      subscription: otherSubscription,
      azureHealthModels: { healthModelResourceId: undefined },
    });
  });

  it('offers subscription template variables and persists the variable rather than its resolved value', async () => {
    const { user, onChange, query } = setup();
    await user.click(screen.getByRole('combobox', { name: 'Subscription' }));
    await user.click(await screen.findByRole('option', { name: '$subscription' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...query,
      subscription: '$subscription',
      azureHealthModels: { healthModelResourceId: undefined },
    });
  });

  it.each([
    { name: 'configured default', defaultSubscription: otherSubscription, expected: otherSubscription },
    { name: 'first available subscription', defaultSubscription: undefined, expected: subscription },
  ])('persists the $name when the query has no subscription', async ({ defaultSubscription, expected }) => {
    const query = { refId: 'A', queryType: AzureQueryType.AzureHealthModels };
    const { onChange, datasource } = setup({ query, subscriptionId: defaultSubscription });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...query, subscription: expected }));
    expect(datasource.getHealthModels).toHaveBeenCalledWith(expected);
  });

  it('disables model selection until a subscription is available', () => {
    const { datasource } = setup({
      query: { refId: 'A', queryType: AzureQueryType.AzureHealthModels },
      datasource: createMockDatasource({
        getSubscriptions: jest.fn().mockReturnValue(new Promise(() => {})),
        getHealthModels: jest.fn(),
      }),
    });
    expect(screen.getByRole('combobox', { name: 'Health Model' })).toBeDisabled();
    expect(datasource.getHealthModels).not.toHaveBeenCalled();
  });

  it('shows loading while the Health Models lookup is pending', async () => {
    const { user } = setup({
      datasource: createMockDatasource({
        getSubscriptions: jest.fn().mockResolvedValue([]),
        getHealthModels: jest.fn().mockReturnValue(new Promise(() => {})),
      }),
    });
    await user.click(screen.getByRole('combobox', { name: 'Health Model' }));
    expect(await screen.findByText('Loading options...')).toBeInTheDocument();
  });

  it.each([
    { name: 'subscription lookup', method: 'getSubscriptions', source: 'health-models-subscriptions' },
    { name: 'Health Models lookup', method: 'getHealthModels', source: 'health-models-list' },
  ] as const)('reports $name failures to the editor error handler', async ({ method, source }) => {
    const error = new Error('Permission denied');
    const datasource = createMockDatasource({
      getSubscriptions: jest.fn().mockResolvedValue([]),
      getHealthModels: jest.fn().mockResolvedValue([]),
    });
    datasource[method].mockRejectedValue(error);
    const { setError } = setup({ datasource });
    await waitFor(() => expect(setError).toHaveBeenCalledWith(source, error));
  });

  it('ignores a stale model response after the subscription changes', async () => {
    let resolveOld!: (models: AzureHealthModel[]) => void;
    const oldRequest = new Promise<AzureHealthModel[]>((resolve) => {
      resolveOld = resolve;
    });
    const datasource = createMockDatasource({
      getSubscriptions: jest.fn().mockResolvedValue([]),
      getHealthModels: jest
        .fn()
        .mockReturnValueOnce(oldRequest)
        .mockResolvedValue([{ id: newSubscriptionModelId, name: 'new-model' }]),
    });
    const props = setup({ datasource });
    props.rerender(<HealthModelsQueryEditor {...props} query={{ ...props.query, subscription: otherSubscription }} />);
    await waitFor(() => expect(datasource.getHealthModels).toHaveBeenLastCalledWith(otherSubscription));
    await act(async () => {
      resolveOld([{ id: modelId, name: 'old-model' }]);
    });
    await props.user.click(screen.getByRole('combobox', { name: 'Health Model' }));
    expect(await screen.findByRole('option', { name: /new-model/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /old-model/ })).not.toBeInTheDocument();
  });

  it('reloads models and clears the previous selection when a subscription variable changes value', async () => {
    jest
      .mocked(getTemplateSrv().replace)
      .mockImplementation((value) => (value === '$subscription' ? subscription : (value ?? '')));
    const datasource = createMockDatasource({
      getSubscriptions: jest.fn().mockResolvedValue([]),
      getHealthModels: jest
        .fn()
        .mockResolvedValueOnce([{ id: modelId, name: 'model' }])
        .mockResolvedValueOnce([{ id: newSubscriptionModelId, name: 'new-model' }]),
    });
    const props = setup({
      datasource,
      query: {
        refId: 'A',
        queryType: AzureQueryType.AzureHealthModels,
        subscription: '$subscription',
        azureHealthModels: { healthModelResourceId: modelId },
      },
    });
    await props.user.click(screen.getByRole('combobox', { name: 'Health Model' }));
    expect(await screen.findByRole('option', { name: /model \(rg-one\)/ })).toBeInTheDocument();
    await props.user.keyboard('{Escape}');

    jest
      .mocked(getTemplateSrv().replace)
      .mockImplementation((value) => (value === '$subscription' ? otherSubscription : (value ?? '')));
    props.rerender(<HealthModelsQueryEditor {...props} />);

    await waitFor(() => expect(datasource.getHealthModels).toHaveBeenCalledTimes(2));
    expect(datasource.getHealthModels).toHaveBeenLastCalledWith(otherSubscription);
    expect(props.onChange).toHaveBeenLastCalledWith({
      ...props.query,
      azureHealthModels: { healthModelResourceId: undefined },
    });
    await props.user.click(screen.getByRole('combobox', { name: 'Health Model' }));
    expect(await screen.findByRole('option', { name: /new-model \(rg-three\)/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /model \(rg-one\)/ })).not.toBeInTheDocument();
  });
});
