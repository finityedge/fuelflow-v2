import {
  UserRole,
  type AttendantSummary,
  type StationAccessUser,
  type StationDetail,
  type StationSummary,
  type TankSummary,
} from '@fuelflow/shared';
import { prisma } from '../prisma/client.js';
import { slugify } from '../parsing/slug.js';
import type { LinkAttendantAliasBody } from '../schemas/attendantProfile.schema.js';
import type {
  CreateAttendantBody,
  CreateStationBody,
  CreateTankBody,
  UpdateAttendantBody,
  UpdateStationBody,
  UpdateTankBody,
} from '../schemas/station.schema.js';

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

const stationSelect = {
  id: true,
  name: true,
  location: true,
  isActive: true,
  varianceThreshold: true,
  _count: { select: { tanks: true, attendants: true } },
} as const;

interface StationRow {
  id: string;
  name: string;
  location: string | null;
  isActive: boolean;
  varianceThreshold: number;
  _count: { tanks: number; attendants: number };
}

function toStationSummary(row: StationRow): StationSummary {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    isActive: row.isActive,
    varianceThreshold: row.varianceThreshold,
    tankCount: row._count.tanks,
    attendantCount: row._count.attendants,
  };
}

/**
 * The stations this user may act on.
 *
 * Filtered by assignment rather than by tenant for anyone who is not an owner: a manager
 * assigned to one site should be offered that site, not a picker full of stations they cannot
 * upload against.
 */
export async function listStations(
  user: { role: UserRole; stationIds: string[] },
  options: { includeInactive: boolean }
): Promise<StationSummary[]> {
  const rows = await prisma.station.findMany({
    where: {
      ...(user.role === UserRole.OWNER ? {} : { id: { in: user.stationIds } }),
      ...(options.includeInactive ? {} : { isActive: true }),
    },
    orderBy: { name: 'asc' },
    select: stationSelect,
  });

  return rows.map(toStationSummary);
}

export async function getStationDetail(stationId: string): Promise<StationDetail> {
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: stationSelect,
  });

  if (!station) {
    throw httpError(404, 'Station not found.');
  }

  const [tanks, attendants, assignments] = await Promise.all([
    prisma.tank.findMany({
      where: { stationId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, slug: true, product: true, capacityLitres: true, leakThresholdLitres: true, isActive: true },
    }),
    prisma.attendant.findMany({
      where: { stationId },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        userId: true,
        isActive: true,
        // The spellings that have been joined to this person. Carried here rather than fetched
        // separately because the screen that shows an attendant's key is the same screen that
        // adds to it, and a second round trip to find out what is already linked would be a
        // question the first response could have answered.
        aliases: { select: { slug: true }, orderBy: { slug: 'asc' } },
      },
    }),
    prisma.stationAssignment.findMany({
      where: { stationId },
      orderBy: { createdAt: 'asc' },
      select: { user: { select: { id: true, email: true, role: true, isActive: true } } },
    }),
  ]);

  return {
    station: toStationSummary(station),
    tanks,
    attendants: attendants.map((attendant) => ({
      ...attendant,
      aliases: attendant.aliases.map((alias) => alias.slug),
    })),
    users: assignments.map((assignment) => ({
      id: assignment.user.id,
      email: assignment.user.email,
      role: assignment.user.role as UserRole,
      isActive: assignment.user.isActive,
    })) satisfies StationAccessUser[],
  };
}

export async function createStation(
  tenantId: string,
  body: CreateStationBody
): Promise<StationSummary> {
  const created = await prisma.station.create({
    data: {
      tenantId,
      name: body.name,
      location: body.location ?? null,
      ...(body.varianceThreshold !== undefined ? { varianceThreshold: body.varianceThreshold } : {}),
    },
    select: stationSelect,
  });

  return toStationSummary(created);
}

export async function updateStation(
  stationId: string,
  body: UpdateStationBody
): Promise<StationSummary> {
  const updated = await prisma.station.update({
    where: { id: stationId },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.location !== undefined ? { location: body.location } : {}),
      ...(body.varianceThreshold !== undefined
        ? { varianceThreshold: body.varianceThreshold }
        : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    },
    select: stationSelect,
  });

  return toStationSummary(updated);
}

export async function createTank(
  tenantId: string,
  stationId: string,
  body: CreateTankBody
): Promise<TankSummary> {
  const slug = body.slug ?? slugify(body.name);
  if (!slug) {
    throw httpError(400, 'That name produces an empty key. Give the tank a name containing a letter or digit.');
  }

  await assertStationExists(stationId);

  try {
    return (await prisma.tank.create({
      data: {
        tenantId,
        stationId,
        name: body.name,
        slug,
        product: body.product ?? null,
        capacityLitres: body.capacityLitres ?? null,
        leakThresholdLitres: body.leakThresholdLitres ?? null,
      },
      select: { id: true, name: true, slug: true, product: true, capacityLitres: true, leakThresholdLitres: true, isActive: true },
    }));
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Two tanks on one station must not share a key: the parser's `tank:<slug>:...` field
      // names would collide and every later reading would be attributed to whichever row was
      // written first, with nothing in the data to say so.
      throw httpError(409, `This station already has a tank keyed ${slug}.`);
    }
    throw error;
  }
}

export async function updateTank(
  stationId: string,
  tankId: string,
  body: UpdateTankBody
): Promise<TankSummary> {
  const existing = await prisma.tank.findFirst({ where: { id: tankId, stationId } });
  if (!existing) {
    throw httpError(404, 'Tank not found on this station.');
  }

  // A rename re-derives the key unless one was given. Keeping the old key on a rename would
  // be worse than either option: the tank would be called something new and still only ever
  // match the reports printed under its old label.
  const slug = body.slug ?? (body.name !== undefined ? slugify(body.name) : undefined);

  try {
    return (await prisma.tank.update({
      where: { id: tankId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ...(body.product !== undefined ? { product: body.product } : {}),
        ...(body.capacityLitres !== undefined ? { capacityLitres: body.capacityLitres } : {}),
        ...(body.leakThresholdLitres !== undefined
          ? { leakThresholdLitres: body.leakThresholdLitres }
          : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
      select: { id: true, name: true, slug: true, product: true, capacityLitres: true, leakThresholdLitres: true, isActive: true },
    }));
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw httpError(409, `This station already has a tank keyed ${slug}.`);
    }
    throw error;
  }
}

export async function createAttendant(
  tenantId: string,
  stationId: string,
  body: CreateAttendantBody
): Promise<AttendantSummary> {
  const slug = body.slug ?? slugify(body.name);
  if (!slug) {
    throw httpError(400, 'That name produces an empty key. Give the attendant a name containing a letter or digit.');
  }

  await assertStationExists(stationId);
  await assertUserAssignable(body.userId);

  try {
    const created = await prisma.attendant.create({
      data: {
        tenantId,
        stationId,
        name: body.name,
        slug,
        userId: body.userId ?? null,
      },
      select: { id: true, name: true, slug: true, userId: true, isActive: true },
    });

    // A record that has just been created cannot have spellings joined to it yet.
    return { ...created, aliases: [] };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw httpError(409, `This station already has an attendant keyed ${slug}, or that login is already linked to an attendant.`);
    }
    throw error;
  }
}

export async function updateAttendant(
  stationId: string,
  attendantId: string,
  body: UpdateAttendantBody
): Promise<AttendantSummary> {
  const existing = await prisma.attendant.findFirst({ where: { id: attendantId, stationId } });
  if (!existing) {
    throw httpError(404, 'Attendant not found on this station.');
  }

  if (body.userId) {
    await assertUserAssignable(body.userId, attendantId);
  }

  const slug = body.slug ?? (body.name !== undefined ? slugify(body.name) : undefined);

  try {
    const updated = await prisma.attendant.update({
      where: { id: attendantId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ...(body.userId !== undefined ? { userId: body.userId } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
      select: {
        id: true,
        name: true,
        slug: true,
        userId: true,
        isActive: true,
        aliases: { select: { slug: true }, orderBy: { slug: 'asc' } },
      },
    });

    return { ...updated, aliases: updated.aliases.map((alias) => alias.slug) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw httpError(409, `This station already has an attendant keyed ${slug}, or that login is already linked to an attendant.`);
    }
    throw error;
  }
}

/**
 * Join another spelling of a name to an attendant.
 *
 * This is the whole of the alias feature's write side, and it is deliberately a row somebody
 * creates rather than a similarity rule. "J. Mwangi is John Mwangi" is a fact about a
 * workplace; a fuzzy match that guessed wrong would move one person's shortfall onto a
 * colleague's record, which is an accusation made by software with nobody in the loop.
 *
 * Three things are checked, and each one is a way the link would silently do nothing:
 *
 *  - the key must not be this attendant's own slug, because that is what the key already
 *    resolves to and the row would be inert;
 *  - it must not be another attendant's slug at this station, because the profile service
 *    resolves an exact slug match before any alias — so the link would be created, appear on
 *    screen, and never take effect;
 *  - it must not already be claimed by a different attendant, which the unique index catches
 *    but which is better answered with which name already holds it.
 */
export async function linkAttendantAlias(
  tenantId: string,
  stationId: string,
  attendantId: string,
  body: LinkAttendantAliasBody
): Promise<AttendantSummary> {
  const attendant = await prisma.attendant.findFirst({
    where: { id: attendantId, stationId },
    select: { id: true, slug: true },
  });
  if (!attendant) {
    throw httpError(404, 'Attendant not found on this station.');
  }

  const slug = body.slug ?? slugify(body.name ?? '');
  if (!slug) {
    throw httpError(400, 'That name produces an empty key. Give the name a letter or digit to work with.');
  }

  if (slug === attendant.slug) {
    throw httpError(409, 'That is already this attendant’s own key on the report.');
  }

  const owner = await prisma.attendant.findFirst({
    where: { stationId, slug, id: { not: attendantId } },
    select: { name: true },
  });
  if (owner) {
    throw httpError(409, `That key already belongs to ${owner.name} on this station.`);
  }

  try {
    await prisma.attendantAlias.create({
      data: { tenantId, stationId, attendantId, slug },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await prisma.attendantAlias.findFirst({
        where: { stationId, slug },
        select: { attendant: { select: { name: true } } },
      });
      throw httpError(
        409,
        existing
          ? `That key is already joined to ${existing.attendant.name}.`
          : 'That key is already joined to an attendant on this station.'
      );
    }
    throw error;
  }

  return readAttendantSummary(attendantId);
}

/**
 * Let go of a spelling.
 *
 * Removing the link does not touch a single report: the shifts filed under that key simply
 * stop counting towards this person and go back to being an unclaimed name. That is the
 * intended behaviour — the alternative, deleting or rewriting the extracted fields, would be
 * this endpoint editing the station's records to suit a settings screen.
 */
export async function unlinkAttendantAlias(
  stationId: string,
  attendantId: string,
  slug: string
): Promise<AttendantSummary> {
  const attendant = await prisma.attendant.findFirst({
    where: { id: attendantId, stationId },
    select: { id: true },
  });
  if (!attendant) {
    throw httpError(404, 'Attendant not found on this station.');
  }

  const removed = await prisma.attendantAlias.deleteMany({ where: { stationId, attendantId, slug } });
  if (removed.count === 0) {
    throw httpError(404, 'That key is not joined to this attendant.');
  }

  return readAttendantSummary(attendantId);
}

/** Re-read one attendant with their links, for the response to a write. */
async function readAttendantSummary(attendantId: string): Promise<AttendantSummary> {
  const attendant = await prisma.attendant.findUniqueOrThrow({
    where: { id: attendantId },
    select: {
      id: true,
      name: true,
      slug: true,
      userId: true,
      isActive: true,
      aliases: { select: { slug: true }, orderBy: { slug: 'asc' } },
    },
  });

  return { ...attendant, aliases: attendant.aliases.map((alias) => alias.slug) };
}

async function assertStationExists(stationId: string): Promise<void> {
  // Tenant-scoped, so another tenant's station reads as missing rather than being found and
  // rejected. Tanks and attendants hang off a station, so this is also what keeps them inside
  // the right tenant.
  const station = await prisma.station.findUnique({ where: { id: stationId }, select: { id: true } });
  if (!station) {
    throw httpError(404, 'Station not found.');
  }
}

/**
 * Whether a station exists for the caller's tenant, without throwing.
 *
 * The companion to `hasStationAccess`, which answers from the token alone and therefore says
 * `true` for every station id when the caller is an owner — it knows an owner may see every
 * station, but has no way to know *whose* station a given id names. A route that takes a
 * station id from the query string and checks only that ends up answering 200 from the
 * tenant-scoped query with nothing in it, which reads as "this station has no leak" rather
 * than "this station is not yours".
 *
 * Tenant-scoped by the Prisma extension, so a station in another tenant is simply absent.
 */
export async function stationExistsInTenant(stationId: string): Promise<boolean> {
  const station = await prisma.station.findUnique({ where: { id: stationId }, select: { id: true } });
  return station !== null;
}

/**
 * Check the login being linked exists in this tenant, is an attendant, and is not already
 * someone else's record.
 *
 * Without the role check a manager's login could be attached to an attendant record, and the
 * two ideas — who can sign in, and whose name is on the report — would start to look
 * interchangeable exactly where they must not be.
 */
async function assertUserAssignable(userId: string | null | undefined, allowAttendantId?: string): Promise<void> {
  if (!userId) {
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, isActive: true },
  });

  if (!user) {
    throw httpError(400, 'That user could not be found.');
  }

  if (user.role !== UserRole.ATTENDANT) {
    throw httpError(400, 'Only an attendant login can be linked to an attendant record.');
  }

  const clash = await prisma.attendant.findFirst({
    where: { userId, ...(allowAttendantId ? { id: { not: allowAttendantId } } : {}) },
    select: { id: true },
  });

  if (clash) {
    throw httpError(409, 'That login is already linked to another attendant.');
  }
}
