import type { TankLeakageResponse } from '@fuelflow/shared';
import { apiClient } from './api.js';

export interface TankLeakageParams {
  /** One station's tanks. Omitted means every station the signed-in user may see. */
  stationId?: string;
  periodDays?: number;
}

/**
 * The whole leakage screen in one request.
 *
 * The per-tank totals, the alerts and the per-shift trend all come from one pass over the same
 * reports, so splitting them would let a tank's headline figure disagree with the shifts
 * plotted underneath it — on a screen whose entire job is to point at a specific tank.
 */
export async function getTankLeakage(params: TankLeakageParams = {}): Promise<TankLeakageResponse> {
  const query = new URLSearchParams();
  if (params.stationId) {
    query.set('stationId', params.stationId);
  }
  if (params.periodDays !== undefined) {
    query.set('periodDays', String(params.periodDays));
  }

  const res = await apiClient(`/tanks/leakage${query.size > 0 ? `?${query.toString()}` : ''}`);

  if (!res.ok) {
    throw new Error('The tank figures could not be loaded.');
  }

  return (await res.json()) as TankLeakageResponse;
}
