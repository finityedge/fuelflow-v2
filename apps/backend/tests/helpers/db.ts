/**
 * Reset the database between suites.
 *
 * Every suite here shares one PostgreSQL database, so each one starts from a clean slate.
 * Two things about that are easy to get wrong and expensive when you do:
 *
 *  1. Order is not optional. `ShiftReport` references `Station`, which references
 *     `Tenant`, and none of those relations cascade from the parent side, so deleting
 *     parents first fails on a foreign key. Children go first.
 *  2. The reset has to be complete. A suite that clears only the tables it personally
 *     writes to leaves whatever the previous suite created, and then fails inside its own
 *     `beforeAll` — a confusing place to debug a missing table from three files ago.
 *
 * These calls run outside any tenant scope, so the tenant extension passes them through
 * unfiltered. That is intended here and only here: this is the one place that wants to
 * touch every tenant's rows.
 */
import { prisma } from '../../src/prisma/client.js';

export async function resetDatabase(): Promise<void> {
  await prisma.extractedField.deleteMany();
  await prisma.shiftReport.deleteMany();
  // Named explicitly even though `Station` cascades to both. This helper's own rule is that
  // children go first, and here that was true only by way of a cascade nobody wrote down —
  // so a future model hung off Station would be silently covered or silently missed
  // depending on which relation attribute somebody happened to type.
  //
  // Aliases lead the attendants they belong to: an alias row points at an `Attendant`, so
  // deleting attendants first would fail on the foreign key. This is the "children go first"
  // rule doing exactly the job it was written for.
  await prisma.attendantAlias.deleteMany();
  await prisma.attendant.deleteMany();
  await prisma.tank.deleteMany();
  await prisma.stationAssignment.deleteMany();
  // Cascades from `User`, and named anyway for the reason above: a suite that registers a user,
  // requests a reset and forgets to clean up would otherwise leave a live token pointing at a
  // deleted row until this helper happened to run.
  await prisma.passwordResetToken.deleteMany();
  await prisma.station.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
}
