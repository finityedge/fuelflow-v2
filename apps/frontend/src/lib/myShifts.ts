import type { MyAttendantProfile } from '@fuelflow/shared';
import { apiClient, readError } from './api.js';

/**
 * The signed-in person's own record.
 *
 * Named for what the person is asking — "how did my shifts come out" — rather than for the
 * endpoint, which is `/attendants/me`. The type keeps the API's name because it is the API's
 * shape, and this is the only caller.
 *
 * No station is passed, and there is none to pass: the record decides which station's reports
 * answer this. A `stationId` here would be a parameter a caller could try to use to ask after
 * somebody else, and the endpoint refuses to have one.
 */
export async function getMyShifts(options: { periodDays?: number } = {}): Promise<MyAttendantProfile> {
  const query = new URLSearchParams();
  if (options.periodDays !== undefined) {
    query.set('periodDays', String(options.periodDays));
  }

  const res = await apiClient(`/attendants/me${query.size > 0 ? `?${query.toString()}` : ''}`);

  if (!res.ok) {
    throw await readError(res, 'Your shift figures could not be loaded.');
  }

  return (await res.json()) as MyAttendantProfile;
}
