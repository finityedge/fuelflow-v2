import type { FindingsSheet } from '@fuelflow/shared';
import { apiClient, readError } from './api.js';

export interface FindingsParams {
  /** Required by the endpoint, and by the document: a findings sheet is about one station. */
  stationId: string;
  periodDays?: number;
}

/**
 * The free-audit findings sheet, assembled in one request.
 *
 * One call rather than three because the sheet's whole value is that its parts agree. The
 * server composes the totals, the exceptions and the headline sentences from the same pass, so
 * a client that fetched the dashboard and the leakage screen itself and laid them out together
 * would be rebuilding — with its own arithmetic — the exact document this endpoint exists to
 * make impossible to get wrong.
 */
export async function getFindingsSheet(params: FindingsParams): Promise<FindingsSheet> {
  const query = new URLSearchParams({ stationId: params.stationId });
  if (params.periodDays !== undefined) {
    query.set('periodDays', String(params.periodDays));
  }

  const res = await apiClient(`/findings?${query.toString()}`);

  if (!res.ok) {
    throw await readError(res, 'The findings sheet could not be assembled.');
  }

  return (await res.json()) as FindingsSheet;
}
