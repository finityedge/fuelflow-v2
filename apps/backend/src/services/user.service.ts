import { Prisma } from '@prisma/client';
import { UserRole, type ManagedUser } from '@fuelflow/shared';
import { prisma } from '../prisma/client.js';
import { hashPassword } from './password.service.js';
import type { CreateUserBody, UpdateUserBody } from '../schemas/user.schema.js';

/** A thrown error carrying the status code the client should see. */
function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

interface UserRow {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: Date;
  /** Readonly because `userSelect` is `as const`, which is what keeps Prisma's payload
   *  inference intact — dropping the `as const` to satisfy this interface would widen the
   *  select to `boolean` and lose the field types entirely. */
  stationAssignments: readonly { stationId: string }[];
}

const userSelect = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  stationAssignments: { select: { stationId: true } },
} as const;

function toManagedUser(row: UserRow): ManagedUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role as UserRole,
    isActive: row.isActive,
    stationIds: row.stationAssignments.map((assignment) => assignment.stationId),
    createdAt: row.createdAt,
  };
}

/**
 * Resolve the requested station ids against the caller's tenant, or refuse.
 *
 * The lookup goes through the tenant-scoped client, so a station belonging to another tenant
 * is simply *not found* rather than found-and-rejected — the difference matters, because it
 * means a wrong-tenant id cannot be distinguished from a nonexistent one by probing this
 * endpoint. It also means `StationAssignment`, which is outside the tenant-scoped model list,
 * never receives an id that was not first checked against a scoped query.
 */
async function resolveStationIds(stationIds: string[]): Promise<string[]> {
  const unique = [...new Set(stationIds)];
  if (unique.length === 0) {
    return [];
  }

  const found = await prisma.station.findMany({
    where: { id: { in: unique } },
    select: { id: true },
  });

  if (found.length !== unique.length) {
    throw httpError(400, 'One or more of those stations could not be found.');
  }

  return unique;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

export interface ListUsersOptions {
  includeInactive: boolean;
  /**
   * When set, only users assigned to at least one of these stations are returned. This is
   * how a manager is shown the roster of the stations they actually run, rather than every
   * employee of the company.
   */
  withinStationIds?: string[];
}

export async function listUsers(options: ListUsersOptions): Promise<ManagedUser[]> {
  const rows = await prisma.user.findMany({
    where: {
      ...(options.includeInactive ? {} : { isActive: true }),
      ...(options.withinStationIds
        ? { stationAssignments: { some: { stationId: { in: options.withinStationIds } } } }
        : {}),
    },
    orderBy: [{ role: 'asc' }, { email: 'asc' }],
    select: userSelect,
  });

  return rows.map(toManagedUser);
}

export async function createUser(
  tenantId: string,
  body: CreateUserBody
): Promise<ManagedUser> {
  const stationIds = await resolveStationIds(body.stationIds);
  const passwordHash = await hashPassword(body.password);

  try {
    const data: Prisma.UserUncheckedCreateInput = {
      // Taken from the authenticated caller, never from the request body. The tenant-scoped
      // client would inject the same value, but writing it out makes the one thing that
      // decides who can see this user explicit at the point the row is created — and leaves
      // no way for a future edit to be the version that reads it from the payload.
      tenantId,
      email: body.email,
      passwordHash,
      role: body.role,
      stationAssignments: { create: stationIds.map((stationId) => ({ stationId })) },
    };

    const user = await prisma.user.create({ data, select: userSelect });

    return toManagedUser(user);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // `email` is unique across the whole table, not per tenant, so this is also the path a
      // collision with another organisation's user takes. The message stays the same either
      // way: telling the two apart would turn this route into a way to ask whether a given
      // address is a FuelFlow customer.
      throw httpError(409, 'That email address is already in use.');
    }
    throw error;
  }
}

/** How many owners are still active, optionally excluding one being changed. */
async function activeOwnerCount(excludingUserId: string): Promise<number> {
  return prisma.user.count({
    where: { role: UserRole.OWNER, isActive: true, id: { not: excludingUserId } },
  });
}

export async function updateUser(
  targetUserId: string,
  body: UpdateUserBody,
  actor: { id: string }
): Promise<ManagedUser> {
  // Changing your own role or deactivating yourself is refused outright rather than
  // carefully reasoned about. Either one can leave a tenant with nobody able to administer
  // it, and there is no self-service reason to want them: this route is for managing other
  // people. A password change for yourself is a different feature and does not live here.
  if (targetUserId === actor.id) {
    throw httpError(400, 'You cannot change your own account through this endpoint.');
  }

  // Tenant scoping makes another tenant's user read as missing, so this is also the check
  // that the id is one this caller is allowed to touch at all.
  const existing = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, role: true, isActive: true },
  });

  if (!existing) {
    throw httpError(404, 'User not found.');
  }

  if (body.isActive === false && existing.isActive && existing.role === UserRole.OWNER) {
    // Belt and braces: the self-guard above already makes this unreachable today, since the
    // last owner standing can only be the caller. It is here because that guard is one line
    // somebody could relax, and the failure it would let through is a tenant nobody can
    // administer, with no way back in through the product.
    const remainingOwners = await activeOwnerCount(targetUserId);
    if (remainingOwners === 0) {
      throw httpError(400, 'This is the only active owner. Add another owner before deactivating this one.');
    }
  }

  const stationIds =
    body.stationIds === undefined ? undefined : await resolveStationIds(body.stationIds);

  const data: Prisma.UserUpdateInput = {
    ...(body.role !== undefined ? { role: body.role } : {}),
    ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    ...(stationIds !== undefined
      ? {
          stationAssignments: {
            deleteMany: {},
            create: stationIds.map((stationId) => ({ stationId })),
          },
        }
      : {}),
  };

  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: targetUserId }, data, select: userSelect });

    // Deactivating has to end the session, not just the ability to log in again. The refresh
    // token is a seven-day credential and the access token is good for another fifteen
    // minutes; without this, "deactivated" would mean "still working until they close the
    // tab", which is not what anyone understands the word to mean.
    if (body.isActive === false) {
      await tx.user.update({ where: { id: targetUserId }, data: { refreshToken: null } });
    }

    return user;
  });

  return toManagedUser(updated);
}
