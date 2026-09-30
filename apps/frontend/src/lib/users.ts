import type { ManagedUser } from '@fuelflow/shared';
import { apiClient, readError } from './api.js';

/**
 * The roles a login can be created as.
 *
 * A string union rather than `UserRole`, and the missing member is the reason: `OWNER` is not
 * accepted here. This route takes a password the caller chooses, so allowing OWNER would make
 * minting a second full owner a single request — the server refuses it (`provisionableRoleSchema`)
 * and a UI able to select it would be a button that only ever produces a 400. Spelled as the two
 * that work rather than as "all of them, minus one", so the type cannot drift behind the schema.
 */
export type ProvisionableRole = 'MANAGER' | 'ATTENDANT';

/**
 * The logins, not the people.
 *
 * This file is about `User` rows — the accounts that sign in — and is deliberately separate from
 * `stations.ts`, which is about the names printed on reports. The two are joined in one place and
 * nowhere else (`Attendant.userId`), and keeping the calls apart is what stops a screen from
 * treating "has an account" as the same question as "worked the shift".
 *
 * Everything here is OWNER-only on the server: provisioning is staffing the organisation, which
 * is a different job from running a station. The screens gate on `canManageUsers` so a manager is
 * never offered a button that comes back 403.
 */

/**
 * The roster.
 *
 * `includeInactive` is what the staff card needs and what nothing else does: an owner has to be
 * able to see the person they retired in order to bring them back, and every other caller is
 * asking who can sign in now. Sending it does not widen what comes back — the server scopes to
 * the caller's tenant, and narrows a manager to their own stations.
 */
export async function listUsers(options?: { includeInactive?: boolean }): Promise<ManagedUser[]> {
  const query = options?.includeInactive ? '?includeInactive=true' : '';
  const res = await apiClient(`/users${query}`);
  if (!res.ok) {
    throw await readError(res, 'The list of logins could not be loaded.');
  }
  const body = (await res.json()) as { users: ManagedUser[] };
  return body.users;
}

export interface CreateUserInput {
  email: string;
  password: string;
  role: ProvisionableRole;
  stationIds?: string[];
}

/**
 * Add a login.
 *
 * `role` cannot be OWNER — the server refuses it, and refusing it is the point: this route takes
 * a password the caller chooses, so allowing OWNER would make minting a second full owner a
 * single request.
 *
 * There is no email delivery yet (item `0.7`), so the caller types an initial password and hands
 * it over out of band. That is why nothing here says "invite".
 */
export async function createUser(body: CreateUserInput): Promise<ManagedUser> {
  const res = await apiClient('/users', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    throw await readError(res, 'That login could not be created.');
  }
  const payload = (await res.json()) as { user: ManagedUser };
  return payload.user;
}

export interface UpdateUserInput {
  role?: ProvisionableRole;
  isActive?: boolean;
  /** Replaces the whole list. Callers must send every station the person should keep. */
  stationIds?: string[];
}

/**
 * Change a login's role, its stations, or whether it works at all.
 *
 * `stationIds` **replaces** the list rather than adding to it, which is the one sharp edge here:
 * sending `[thisStation]` to assign somebody to this station would silently take them off every
 * other one. Callers are expected to have the roster (which carries the full list) before they
 * send one, and the staff card does.
 */
export async function updateUser(userId: string, body: UpdateUserInput): Promise<ManagedUser> {
  const res = await apiClient(`/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await readError(res, 'That login could not be changed.');
  }
  const payload = (await res.json()) as { user: ManagedUser };
  return payload.user;
}
