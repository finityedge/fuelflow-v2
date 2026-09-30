/**
 * Who may produce a findings sheet.
 *
 * This is the most sensitive read in the product and the only one that ends in a document: it
 * carries the money, the fuel and the names of the people working the forecourt, all on one
 * page, and it is designed to be printed and handed to somebody. Every other access rule here
 * protects a screen; this one protects a piece of paper that leaves the building.
 *
 * The service suite covers what the sheet says. This file covers only who is allowed to ask for
 * it — and, in one case, that a station they cannot see produces a refusal rather than a sheet
 * with a real station name on it and nothing under it.
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
let unattachedManagerToken: string;
let attendantToken: string;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** One parsed shift, so a permitted sheet has something in it to look at. */
async function seedReport(station: string, reportTenantId: string): Promise<void> {
  const report = await prisma.shiftReport.create({
    data: {
      tenantId: reportTenantId,
      stationId: station,
      status: 'PARSED',
      reportDate: new Date(),
      pdfFileName: 'seeded.pdf',
    },
    select: { id: true },
  });

  await prisma.extractedField.createMany({
    data: [
      {
        tenantId: reportTenantId,
        shiftReportId: report.id,
        fieldName: 'pump_totalizer_sales',
        label: 'Pump totalizer sales',
        group: 'CASH_PAYMENTS',
        parsedValue: '1000000',
        amount: 1_000_000,
        confidence: 'HIGH',
        needsReview: false,
      },
      {
        tenantId: reportTenantId,
        shiftReportId: report.id,
        fieldName: 'cash_collected',
        label: 'Cash collected',
        group: 'CASH_PAYMENTS',
        parsedValue: '900000',
        amount: 900_000,
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

  const tenant = await prisma.tenant.create({ data: { name: 'Findings Route Tenant' } });
  tenantId = tenant.id;

  const station = await prisma.station.create({ data: { tenantId, name: 'Main Station' } });
  stationId = station.id;
  const otherStation = await prisma.station.create({ data: { tenantId, name: 'Second Station' } });
  otherStationId = otherStation.id;

  const owner = await prisma.user.create({
    data: { tenantId, email: 'owner@findings.local', passwordHash, role: UserRole.OWNER },
  });
  const manager = await prisma.user.create({
    data: { tenantId, email: 'manager@findings.local', passwordHash, role: UserRole.MANAGER },
  });
  const unattachedManager = await prisma.user.create({
    data: { tenantId, email: 'unattached@findings.local', passwordHash, role: UserRole.MANAGER },
  });
  const attendant = await prisma.user.create({
    data: { tenantId, email: 'attendant@findings.local', passwordHash, role: UserRole.ATTENDANT },
  });

  await prisma.stationAssignment.create({ data: { userId: manager.id, stationId } });

  const foreignTenant = await prisma.tenant.create({ data: { name: 'Findings Foreign Tenant' } });
  const foreignStation = await prisma.station.create({
    data: { tenantId: foreignTenant.id, name: 'Foreign Station' },
  });
  foreignStationId = foreignStation.id;

  await seedReport(stationId, tenantId);
  await seedReport(otherStationId, tenantId);
  await seedReport(foreignStationId, foreignTenant.id);

  ownerToken = createAccessToken({ sub: owner.id, tenantId, role: owner.role, stationIds: [] });
  managerToken = createAccessToken({
    sub: manager.id,
    tenantId,
    role: manager.role,
    stationIds: [stationId],
  });
  unattachedManagerToken = createAccessToken({
    sub: unattachedManager.id,
    tenantId,
    role: unattachedManager.role,
    stationIds: [],
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

describe('GET /api/findings', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/findings?stationId=${stationId}`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('requires a station, because a sheet with no station on it is not a sheet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/findings',
      headers: auth(ownerToken),
    });

    expect(response.statusCode).toBe(400);
  });

  it('lets an owner produce one for a station in their tenant', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/findings?stationId=${stationId}`,
      headers: auth(ownerToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.station.name).toBe('Main Station');
    expect(body.money.unaccounted).toBe(100_000);
    expect(body.headlines.length).toBeGreaterThan(0);
  });

  it('lets a manager produce one for a station they are assigned to', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/findings?stationId=${stationId}`,
      headers: auth(managerToken),
    });

    expect(response.statusCode).toBe(200);
  });

  it('refuses a manager asking about a station they are not assigned to', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/findings?stationId=${otherStationId}`,
      headers: auth(managerToken),
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a manager assigned to nothing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/findings?stationId=${stationId}`,
      headers: auth(unattachedManagerToken),
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses an attendant, however well assigned they are', async () => {
    // The sheet names people and attributes money to them. An attendant being posted to the
    // station is not consent to be handed a document about their colleagues, and unlike the
    // other screens this one is designed to leave the premises.
    const response = await app.inject({
      method: 'GET',
      url: `/api/findings?stationId=${stationId}`,
      headers: auth(attendantToken),
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a station in another tenant, rather than answering with an empty sheet', async () => {
    // The failure this guards against is specific: a 200 with the foreign station's name at the
    // top and zeros underneath reads as "this station is perfectly clean", which is a stronger
    // and more damaging lie than an error. An owner passes `hasStationAccess` for every id —
    // it answers from the token — so the tenant-scoped existence check is the whole guard.
    const response = await app.inject({
      method: 'GET',
      url: `/api/findings?stationId=${foreignStationId}`,
      headers: auth(ownerToken),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().station).toBeUndefined();
  });

  it('refuses a station id that names nothing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/findings?stationId=does-not-exist',
      headers: auth(ownerToken),
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a period outside the bounded window', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/findings?stationId=${stationId}&periodDays=3650`,
      headers: auth(ownerToken),
    });

    expect(response.statusCode).toBe(400);
  });

  it('honours the period it is given', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/findings?stationId=${stationId}&periodDays=1`,
      headers: auth(ownerToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().periodDays).toBe(1);
  });
});
