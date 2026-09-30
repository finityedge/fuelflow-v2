import type { AttendantProfilesResponse } from '@fuelflow/shared';
import { apiClient, readError } from './api.js';

export interface AttendantProfilesParams {
  /** One station's people. Omitted means every station the signed-in user may see. */
  stationId?: string;
  periodDays?: number;
}

/**
 * The whole profiling screen in one request.
 *
 * The per-person totals, the alerts and the shift-by-shift trend all come from one pass over the
 * same reports, so splitting them would let a person's headline figure disagree with the shifts
 * plotted underneath it — on a screen whose entire job is to point at a specific person.
 */
export async function getAttendantProfiles(
  params: AttendantProfilesParams = {}
): Promise<AttendantProfilesResponse> {
  const query = new URLSearchParams();
  if (params.stationId) {
    query.set('stationId', params.stationId);
  }
  if (params.periodDays !== undefined) {
    query.set('periodDays', String(params.periodDays));
  }

  const res = await apiClient(`/attendants/profiles${query.size > 0 ? `?${query.toString()}` : ''}`);

  if (!res.ok) {
    throw await readError(res, 'The attendant figures could not be loaded.');
  }

  return (await res.json()) as AttendantProfilesResponse;
}
