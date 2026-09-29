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
  await prisma.stationAssignment.deleteMany();
  await prisma.station.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
}
