import type { Station } from '@fuelflow/shared';
import { apiClient } from './api.js';

/**
 * The stations this user may see.
 *
 * The backend already narrows the list to the user's tenant and assignments, so this
 * returns exactly what that person is allowed to pick from. No client-side filtering.
 */
export async function listStations(): Promise<Station[]> {
  const res = await apiClient('/stations');
  if (!res.ok) {
    throw new Error('Stations could not be loaded.');
  }
  const body = (await res.json()) as { stations: Station[] };
  return body.stations;
}
