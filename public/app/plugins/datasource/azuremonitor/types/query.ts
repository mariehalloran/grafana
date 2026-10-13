import { type AzureMonitorQuery as AzureMonitorQueryBase, type AzureQueryType } from '../dataquery.gen';

/**
 * Represents the query as it moves through the frontend query editor and datasource files.
 * It can represent new queries that are still being edited, so all properties are optional
 */
// Narrow the shared queryType string to this datasource's generated enum.
export interface AzureMonitorQuery extends AzureMonitorQueryBase {
  queryType?: AzureQueryType;
}
