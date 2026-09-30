/**
 * Route-level tests for wet-stock leakage.
 *
 * The leakage totals are the litres a station is losing, which is the same class of
 * information as the money totals the dashboard guards, so the access rules get tested at the
 * HTTP boundary rather than assumed from the service. The service tests cover the arithmetic;
 * this file covers who is allowed to ask.
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UserRole } from '@fuelflow/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/prisma/client.js';
import { resetDatabase } from './helpers/db.js';
import { hashPassword } from '../src/services/password.service.js';
import { createAccessToken } from '../src/services/token.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

let tenantId: string;
let stationId: string;
let otherStationId: string;
let foreignStationId: string;
let ownerToken: string;
let managerToken: string;
let attendantToken: string;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/**
 * A parsed report carrying one tank's two figures.
 *
 * Written straight to the tables rather than pushed through the PDF pipeline: this file is
 * about routing and access, and a real PDF here would only add a way for the test to fail for
 * reasons that have nothing to do with what it is checking.
 *
 * The field is keyed `tank:1:...` because that is the parser's spelling — the identifier after
 * the word TANK — and the tank row below is named "Tank 1". That mismatch is deliberate: it is
 * the state a real station is in, and the endpoint has to cope with it.
 */
async function seedReportWithTank(station: string, book: number, dip: number): Promise<void> {
  const report = await prisma.shiftReport.create({
    data: {
      tenantId,
      stationId: station,
      status: 'PARSED',
      reportDate: new Date(),
      pdfFileName: 'seeded.pdf',
    },
  });

  await prisma.extractedField.createMany({
    data: [
      {
        tenantId,
        shiftReportId: report.id,
        fieldName: 'tank:1:book_stock',
        label: 'Tank 1 - book stock',
        group: 'TANK_READINGS',
        parsedValue: String(book),
        amount: book,
        confidence: 'HIGH',
        needsReview: false,
      },
      {
        tenantId,
        shiftReportId: report.id,
        fieldName: 'tank:1:closing_dip',
        label: 'Tank 1 - closing dip',
        group: 'TANK_READINGS',
        parsedValue: String(dip),
        amount: dip,
        confidence: 'HIGH',
        needsReview: false,
      },
    ],
  });
}

beforeAll(async () => {
  app = await buildApp();
  await resetDatabase();

  const passwordHash = await hashPassword('password123');

  const tenant = await prisma.tenant.create({ data: { name: 'Leakage Route Tenant' } });
  tenantId = tenant.id;

  const station = await prisma.station.create({ data: { tenantId, name: 'Main Station' } });
  stationId = station.id;
  const otherStation = await prisma.station.create({ data: { tenantId, name: 'Second Station' } });
  otherStationId = otherStation.id;

  const owner = await prisma.user.create({
    data: { tenantId, email: 'owner@leakage.local', passwordHash, role: UserRole.OWNER },
  });
  const manager = await prisma.user.create({
    data: { tenantId, email: 'manager@leakage.local', passwordHash, role: UserRole.MANAGER },
  });
  await prisma.stationAssignment.create({ data: { userId: manager.id, stationId } });

  const attendant = await prisma.user.create({
    data: { tenantId, email: 'attendant@leakage.local', passwordHash, role: UserRole.ATTENDANT },
  });

  const foreignTenant = await prisma.tenant.create({ data: { name: 'Leakage Foreign Tenant' } });
  const foreignStation = await prisma.station.create({
    data: { tenantId: foreignTenant.id, name: 'Foreign Station' },
  });
  foreignStationId = foreignStation.id;

  // One tank on each of the three stations, all named "Tank 1" and keyed TANK_1, with reports
  // that name them the parser's way. Nothing here may cross a tenant or an assignment line.
  await prisma.tank.createMany({
    data: [
      { tenantId, stationId, name: 'Tank 1', slug: 'TANK_1', capacityLitres: 20_000 },
      { tenantId, stationId: otherStationId, name: 'Tank 1', slug: 'TANK_1', capacityLitres: 20_000 },
      {
        tenantId: foreignTenant.id,
        stationId: foreignStationId,
        name: 'Tank 1',
        slug: 'TANK_1',
        capacityLitres: 20_000,
      },
    ],
  });

  await seedReportWithTank(stationId, 20_000, 19_000);
  await seedReportWithTank(otherStationId, 20_000, 19_800);
  await seedReportWithTank(foreignStationId, 20_000, 10_000);

  ownerToken = createAccessToken({ sub: owner.id, tenantId, role: owner.role, stationIds: [] });
  managerToken = createAccessToken({
    sub: manager.id,
    tenantId,
    role: manager.role,
    stationIds: [stationId],
  });
  attendantToken = createAccessToken({
    sub: attendant.id,
    tenantId,
    role: attendant.role,
    stationIds: [stationId],
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await resetDatabase();
  await prisma.$disconnect();
});

describe('GET /api/tanks/leakage', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tanks/leakage' });

    expect(response.statusCode).toBe(401);
  });

  it('gives an owner every station in their tenant, and nothing from anyone else’s', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/tanks/leakage',
      headers: auth(ownerToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tanks).toHaveLength(2);
    expect(body.tanks.every((tank: { stationId: string }) => tank.stationId !== foreignStationId)).toBe(true);
    // Both stations have a TANK_1 holding a 1,000 L and a 200 L shortfall. Two rows, not one
    // merged one — the whole reason tanks are keyed by station as well as by slug. Sorted
    // numerically: `.sort()` on numbers is lexicographic, and "1000" < "200".
    expect(
      body.tanks.map((tank: { varianceLitres: number }) => tank.varianceLitres).sort((a: number, b: number) => a - b)
    ).toEqual([200, 1_000]);
  });

  it('gives a manager only the stations they are assigned to', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/tanks/leakage',
      headers: auth(managerToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tanks).toHaveLength(1);
    expect(body.tanks[0].stationId).toBe(stationId);
    expect(body.tanks[0].varianceLitres).toBe(1_000);
  });

  it('refuses a manager a station they are not assigned to', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/tanks/leakage?stationId=${otherStationId}`,
      headers: auth(managerToken),
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a station in another tenant even to its own owner', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/tanks/leakage?stationId=${foreignStationId}`,
      headers: auth(ownerToken),
    });

    expect(response.statusCode).toBe(403);
  });

  it('lets an attendant read the queue but not act on it', async () => {
    // Leakage figures are what the attendant on the forecourt is asked about, so reading them
    // is not the sensitive part — the corrections are, and those are guarded elsewhere. This
    // asserts the current rule rather than endorsing a change to it.
    const response = await app.inject({
      method: 'GET',
      url: '/api/tanks/leakage',
      headers: auth(attendantToken),
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects a period outside the window the query allows', async () => {
    const tooLong = await app.inject({
      method: 'GET',
      url: '/api/tanks/leakage?periodDays=365',
      headers: auth(ownerToken),
    });
    const zero = await app.inject({
      method: 'GET',
      url: '/api/tanks/leakage?periodDays=0',
      headers: auth(ownerToken),
    });

    expect(tooLong.statusCode).toBe(400);
    expect(zero.statusCode).toBe(400);
  });

  it('resolves a tank the reports name by the parser’s key', async () => {
    // The report says `tank:1:...` and the settings screen wrote `TANK_1`. If the endpoint
    // matched on the slug alone this would come back as an unmapped tank and the station
    // would look like it had a leak on a tank nobody had configured.
    const response = await app.inject({
      method: 'GET',
      url: `/api/tanks/leakage?stationId=${stationId}`,
      headers: auth(ownerToken),
    });

    const body = response.json();
    expect(body.unmapped).toEqual([]);
    expect(body.tanks[0].name).toBe('Tank 1');
    expect(body.tanks[0].tankId).toBeTruthy();
  });
});
