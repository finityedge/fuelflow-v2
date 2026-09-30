import type {
  AttendantSummary,
  StationDetail,
  StationSummary,
  TankSummary,
} from '@fuelflow/shared';
import { apiClient, readError } from './api.js';

/**
 * The stations this user may see.
 *
 * The backend already narrows the list to the user's tenant and assignments, so this
 * returns exactly what that person is allowed to pick from. No client-side filtering.
 *
 * `includeInactive` is for the settings screen and nowhere else. Every other screen is
 * asking "which station shall I show you figures for", and a retired station has no new
 * figures to show. Settings is the one screen that has to be able to reach a station nobody
 * is filing against any more, because that is the only place it can be brought back.
 */
export async function listStations(options?: {
  includeInactive?: boolean;
}): Promise<StationSummary[]> {
  const query = options?.includeInactive ? '?includeInactive=true' : '';
  const res = await apiClient(`/stations${query}`);
  if (!res.ok) {
    throw new Error('Stations could not be loaded.');
  }
  const body = (await res.json()) as { stations: StationSummary[] };
  return body.stations;
}

/**
 * One station and everything set up on it: its tanks, the people named on its reports, and the
 * logins that can reach it.
 *
 * Used by the settings screen, which is the page this response was shaped for, and by the
 * profiling screen for the attendant list a stray name is joined to.
 */
export async function getStationDetail(stationId: string): Promise<StationDetail> {
  const res = await apiClient(`/stations/${encodeURIComponent(stationId)}`);
  if (!res.ok) {
    throw await readError(res, 'That station could not be loaded.');
  }
  return (await res.json()) as StationDetail;
}

/** What a station can be created as. Everything but the name has a server-side default. */
export interface CreateStationInput {
  name: string;
  location?: string | null;
  varianceThreshold?: number;
}

/**
 * Stand up a station.
 *
 * The first one matters: registering creates a tenant and an owner and no station at all, so
 * without this an owner who has just signed up has a dashboard with nothing behind it and no
 * way to put anything there. Owner-only on the server.
 */
export async function createStation(body: CreateStationInput): Promise<StationSummary> {
  const res = await apiClient('/stations', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    throw await readError(res, 'That station could not be created.');
  }
  const payload = (await res.json()) as { station: StationSummary };
  return payload.station;
}

/** What a station can be changed to. Omitted fields are left alone. */
export interface UpdateStationInput {
  name?: string;
  location?: string | null;
  varianceThreshold?: number;
  isActive?: boolean;
}

/** Rename, re-locate, re-threshold or retire a station. Owner-only on the server. */
export async function updateStation(
  stationId: string,
  body: UpdateStationInput
): Promise<StationSummary> {
  const res = await apiClient(`/stations/${encodeURIComponent(stationId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await readError(res, 'That station could not be saved.');
  }
  const payload = (await res.json()) as { station: StationSummary };
  return payload.station;
}

/** A tank as it is set up. `slug` is the key on the report, not a nickname. */
export interface TankInput {
  name: string;
  slug?: string;
  product?: string | null;
  capacityLitres?: number | null;
  leakThresholdLitres?: number | null;
  isActive?: boolean;
}

/**
 * Add a tank to a station.
 *
 * `slug` is what makes a tank's readings start counting — it has to match the key the parser
 * writes (`tank:<slug>:book_stock`), which is why the form shows it and lets it be typed
 * rather than deriving one and hiding it. Omitted, the server derives it from the name.
 */
export async function createTank(stationId: string, body: TankInput): Promise<TankSummary> {
  const res = await apiClient(`/stations/${encodeURIComponent(stationId)}/tanks`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await readError(res, 'That tank could not be added.');
  }
  const payload = (await res.json()) as { tank: TankSummary };
  return payload.tank;
}

/**
 * Change a tank.
 *
 * A rename re-derives the key unless one is sent, which is why the settings form sends the
 * key it was shown whenever the form was open: silently re-keying a tank on a rename would
 * point its history at a spelling no report ever printed.
 */
export async function updateTank(
  stationId: string,
  tankId: string,
  body: Partial<TankInput>
): Promise<TankSummary> {
  const res = await apiClient(
    `/stations/${encodeURIComponent(stationId)}/tanks/${encodeURIComponent(tankId)}`,
    { method: 'PATCH', body: JSON.stringify(body) }
  );
  if (!res.ok) {
    throw await readError(res, 'That tank could not be saved.');
  }
  const payload = (await res.json()) as { tank: TankSummary };
  return payload.tank;
}

/** An attendant as they are set up — a name on the reports, not necessarily a login. */
export interface AttendantInput {
  name: string;
  slug?: string;
  userId?: string | null;
  isActive?: boolean;
}

/** Add a person named on the reports. Most attendants never sign in. */
export async function createAttendant(
  stationId: string,
  body: AttendantInput
): Promise<AttendantSummary> {
  const res = await apiClient(`/stations/${encodeURIComponent(stationId)}/attendants`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await readError(res, 'That attendant could not be added.');
  }
  const payload = (await res.json()) as { attendant: AttendantSummary };
  return payload.attendant;
}

/** Change an attendant — their printed name, their key, their login, or retired. */
export async function updateAttendant(
  stationId: string,
  attendantId: string,
  body: Partial<AttendantInput>
): Promise<AttendantSummary> {
  const res = await apiClient(
    `/stations/${encodeURIComponent(stationId)}/attendants/${encodeURIComponent(attendantId)}`,
    { method: 'PATCH', body: JSON.stringify(body) }
  );
  if (!res.ok) {
    throw await readError(res, 'That attendant could not be saved.');
  }
  const payload = (await res.json()) as { attendant: AttendantSummary };
  return payload.attendant;
}

/**
 * Join another spelling of a name to an attendant.
 *
 * Either the key the parser produces or the name as the paper printed it — the server derives
 * the one from the other, so a settings form and a stray-name prompt can both send what they
 * have in hand.
 *
 * The refusals here are all worth showing verbatim: the server names the person a key already
 * belongs to, and that is the only way the person doing this finds out why the join would
 * otherwise have silently done nothing.
 */
export async function linkAttendantAlias(
  stationId: string,
  attendantId: string,
  body: { slug?: string; name?: string }
): Promise<AttendantSummary> {
  const res = await apiClient(
    `/stations/${encodeURIComponent(stationId)}/attendants/${encodeURIComponent(attendantId)}/aliases`,
    { method: 'POST', body: JSON.stringify(body) }
  );
  if (!res.ok) {
    throw await readError(res, 'That name could not be joined.');
  }
  const payload = (await res.json()) as { attendant: AttendantSummary };
  return payload.attendant;
}

/** Let go of a spelling. The key is the address, because it is what every caller holds. */
export async function unlinkAttendantAlias(
  stationId: string,
  attendantId: string,
  slug: string
): Promise<AttendantSummary> {
  const res = await apiClient(
    `/stations/${encodeURIComponent(stationId)}/attendants/${encodeURIComponent(
      attendantId
    )}/aliases/${encodeURIComponent(slug)}`,
    { method: 'DELETE' }
  );
  if (!res.ok) {
    throw await readError(res, 'That name could not be unlinked.');
  }
  const payload = (await res.json()) as { attendant: AttendantSummary };
  return payload.attendant;
}
