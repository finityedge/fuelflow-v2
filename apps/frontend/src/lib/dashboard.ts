import type { DashboardSummary } from '@fuelflow/shared';
import { apiClient } from './api.js';

export interface DashboardParams {
  /** One station's figures. Omitted means every station the signed-in user may see. */
  stationId?: string;
  periodDays?: number;
}

/**
 * The whole dashboard in one request.
 *
 * The totals, the trend and the recent table all come from the same pass over the same
 * reports, so splitting them into three calls could show a manager a total that disagrees
 * with the rows printed underneath it.
 */
export async function getDashboard(params: DashboardParams = {}): Promise<DashboardSummary> {
  const query = new URLSearchParams();
  if (params.stationId) {
    query.set('stationId', params.stationId);
  }
  if (params.periodDays !== undefined) {
    query.set('periodDays', String(params.periodDays));
  }

  const res = await apiClient(`/dashboard${query.size > 0 ? `?${query.toString()}` : ''}`);
  return (await res.json()) as DashboardSummary;
}
