import '../src/env.js';
import { UserRole } from '@fuelflow/shared';
import { prisma } from '../src/prisma/client.js';
import { hashPassword } from '../src/services/password.service.js';
import { slugify } from '../src/parsing/slug.js';

/**
 * What one shift may be out by before it is worth a second look, in shillings.
 *
 * Set on the demo station deliberately, because the default of zero means "flag everything" —
 * which is the right default for a station that has not chosen a tolerance and a useless one
 * for a demo, where every shift would then carry a single-shift alert and the screens would
 * show the one state they are not for. Five thousand is small enough that the sample reports'
 * TZS 50,000 shortfall still trips it.
 */
const DEMO_VARIANCE_THRESHOLD = 5_000;

async function main() {
  const password = await hashPassword('password');

  const tenant = await prisma.tenant.upsert({
    where: { id: 'demo-tenant' },
    update: {},
    create: {
      id: 'demo-tenant',
      name: 'Demo Fuel Station',
    },
  });

  const station = await prisma.station.upsert({
    where: { id: 'demo-station' },
    update: { varianceThreshold: DEMO_VARIANCE_THRESHOLD },
    create: {
      id: 'demo-station',
      tenantId: tenant.id,
      name: 'Main Station',
      location: 'Dar es Salaam',
      varianceThreshold: DEMO_VARIANCE_THRESHOLD,
    },
  });

  const owner = await prisma.user.upsert({
    where: { email: 'owner@fuelflow.local' },
    update: {},
    create: {
      tenantId: tenant.id,
      email: 'owner@fuelflow.local',
      passwordHash: password,
      role: UserRole.OWNER,
    },
  });

  const manager = await prisma.user.upsert({
    where: { email: 'manager@fuelflow.local' },
    update: {},
    create: {
      tenantId: tenant.id,
      email: 'manager@fuelflow.local',
      passwordHash: password,
      role: UserRole.MANAGER,
    },
  });

  await prisma.stationAssignment.upsert({
    where: {
      userId_stationId: {
        userId: manager.id,
        stationId: station.id,
      },
    },
    update: {},
    create: {
      userId: manager.id,
      stationId: station.id,
    },
  });

  /*
   * The station's tanks.
   *
   * Slugs are `TANK_1`-style because that is what naming a tank "Tank 1" produces, while the
   * parser keys the same tank as `tank:1` — the identifier it found after the word TANK. Both
   * normalise to `1`, which is how a report's tank figures find the tank they belong to.
   *
   * Three tanks, one of them without a capacity: a demo where every tank is fully configured
   * would never show what the wet-stock screen does with one that is not, and that is the state
   * a station is actually in on the day it starts using this.
   */
  const tanks = [
    { slug: 'TANK_1', name: 'Tank 1', product: 'Diesel', capacityLitres: 20_000, leakThresholdLitres: 100 },
    { slug: 'TANK_2', name: 'Tank 2', product: 'Petrol', capacityLitres: 15_000, leakThresholdLitres: 75 },
    { slug: 'TANK_3', name: 'Tank 3', product: 'Kerosene', capacityLitres: null, leakThresholdLitres: null },
  ];

  for (const tank of tanks) {
    await prisma.tank.upsert({
      where: { stationId_slug: { stationId: station.id, slug: tank.slug } },
      update: {},
      create: { tenantId: tenant.id, stationId: station.id, ...tank },
    });
  }

  /*
   * The people the sample reports name.
   *
   * These two, and not a pair of invented names, because the sample PDFs in
   * `scripts/make-samples.ts` print exactly these attendants. A demo where the reports name
   * people the station has never heard of would show the profiling screen in its unclaimed
   * state — which is a state worth being able to see, but not the one to hand somebody first.
   *
   * The slug comes from `slugify`, not from a hand-written literal, because that is the same
   * function the parser keys field names with. Spelling it out here would be a second copy of
   * the rule, and the day the two disagreed the reports would stop finding their attendant.
   */
  const attendants = ['John Mwaka', 'Grace Kimaro'];

  for (const name of attendants) {
    await prisma.attendant.upsert({
      where: { stationId_slug: { stationId: station.id, slug: slugify(name) } },
      update: {},
      create: { tenantId: tenant.id, stationId: station.id, name, slug: slugify(name) },
    });
  }

  /*
   * One of those names, with a login.
   *
   * Most attendants never sign in, which is why an `Attendant` is not a `User` — but the ones who
   * do are the ones `/` draws their own record for, and a demo with no attendant login cannot
   * show that screen at all. It has to be John Mwaka rather than a third person: the link is the
   * whole feature, and the sample reports already print his shortfall, so signing in as him lands
   * on figures rather than on the empty state.
   *
   * The assignment matters as much as the link. A login joined to an attendant record reaches
   * `/attendants/me` through the record alone, but the station's own staff list is what the
   * attendant picker on the settings screen offers — an unassigned one would be linked and
   * unchoosable, and nothing would say why.
   */
  const attendantUser = await prisma.user.upsert({
    where: { email: 'attendant@fuelflow.local' },
    update: {},
    create: {
      tenantId: tenant.id,
      email: 'attendant@fuelflow.local',
      passwordHash: password,
      role: UserRole.ATTENDANT,
    },
  });

  await prisma.stationAssignment.upsert({
    where: { userId_stationId: { userId: attendantUser.id, stationId: station.id } },
    update: {},
    create: { userId: attendantUser.id, stationId: station.id },
  });

  const linkedName = attendants[0]!;
  const linkedAttendant = await prisma.attendant.findUniqueOrThrow({
    where: { stationId_slug: { stationId: station.id, slug: slugify(linkedName) } },
    select: { id: true, userId: true },
  });

  // Only claimed, never re-pointed: re-seeding must not undo a link somebody changed by hand,
  // which is exactly what an unconditional write here would do.
  if (linkedAttendant.userId === null) {
    await prisma.attendant.update({
      where: { id: linkedAttendant.id },
      data: { userId: attendantUser.id },
    });
  }

  console.log('Seeded:', {
    tenant: tenant.name,
    station: station.name,
    owner: owner.email,
    manager: manager.email,
    attendant: attendantUser.email,
    tanks: tanks.map((tank) => tank.name),
    attendants,
    linkedAttendant: linkedName,
    varianceThreshold: DEMO_VARIANCE_THRESHOLD,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
