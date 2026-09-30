import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { UserRole } from '@fuelflow/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/prisma/client.js';
import { resetDatabase } from './helpers/db.js';
import { hashPassword } from '../src/services/password.service.js';
import { createAccessToken } from '../src/services/token.service.js';
import { tankIdentity } from '../src/parsing/slug.js';

let app: Awaited<ReturnType<typeof buildApp>>;

let tenantId: string;
let stationId: string;
let otherStationId: string;
let foreignStationId: string;
let ownerToken: string;
let managerToken: string;
let attendantUserId: string;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  app = await buildApp();
  await resetDatabase();

  const passwordHash = await hashPassword('password123');

  const tenant = await prisma.tenant.create({ data: { name: 'Station Tenant' } });
  tenantId = tenant.id;

  const station = await prisma.station.create({
    data: { tenantId: tenant.id, name: 'Main Station', location: 'Arusha' },
  });
  stationId = station.id;

  const otherStation = await prisma.station.create({
    data: { tenantId: tenant.id, name: 'Second Station' },
  });
  otherStationId = otherStation.id;

  const owner = await prisma.user.create({
    data: { tenantId: tenant.id, email: 'owner@station.local', passwordHash, role: UserRole.OWNER },
  });

  const manager = await prisma.user.create({
    data: { tenantId: tenant.id, email: 'manager@station.local', passwordHash, role: UserRole.MANAGER },
  });
  await prisma.stationAssignment.create({
    data: { userId: manager.id, stationId: station.id },
  });

  const attendantUser = await prisma.user.create({
    data: { tenantId: tenant.id, email: 'attendant@station.local', passwordHash, role: UserRole.ATTENDANT },
  });
  attendantUserId = attendantUser.id;

  // A different tenant, to prove nothing here crosses that line.
  const foreignTenant = await prisma.tenant.create({ data: { name: 'Foreign Tenant' } });
  const foreignStation = await prisma.station.create({
    data: { tenantId: foreignTenant.id, name: 'Foreign Station' },
  });
  foreignStationId = foreignStation.id;

  ownerToken = createAccessToken({ sub: owner.id, tenantId, role: owner.role, stationIds: [] });
  managerToken = createAccessToken({
    sub: manager.id,
    tenantId,
    role: manager.role,
    stationIds: [station.id],
  });
});

describe('station CRUD', () => {
  it('lets an owner create a station, with the threshold defaulting to zero', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stations',
      headers: auth(ownerToken),
      payload: { name: 'New Station', location: 'Mwanza' },
    });

    expect(res.statusCode).toBe(201);
    const { station } = JSON.parse(res.payload);
    expect(station.name).toBe('New Station');
    expect(station.isActive).toBe(true);
    // Zero, not a guessed tolerance: an unconfigured station is told about every shortfall
    // rather than having a business judgement invented for it.
    expect(station.varianceThreshold).toBe(0);
    expect(station.tankCount).toBe(0);
  });

  it('refuses station creation for a manager', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stations',
      headers: auth(managerToken),
      payload: { name: 'Manager Station' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('renames, sets a variance threshold and deactivates', async () => {
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/stations/${stationId}`,
      headers: auth(ownerToken),
      payload: { name: 'Main Station (Arusha)', varianceThreshold: 25000 },
    });

    expect(renamed.statusCode).toBe(200);
    expect(JSON.parse(renamed.payload).station.varianceThreshold).toBe(25000);

    const deactivated = await app.inject({
      method: 'PATCH',
      url: `/api/stations/${otherStationId}`,
      headers: auth(ownerToken),
      payload: { isActive: false },
    });
    expect(deactivated.statusCode).toBe(200);
    expect(JSON.parse(deactivated.payload).station.isActive).toBe(false);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/stations',
      headers: auth(ownerToken),
    });
    const ids = JSON.parse(listed.payload).stations.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(otherStationId);

    const withInactive = await app.inject({
      method: 'GET',
      url: '/api/stations?includeInactive=true',
      headers: auth(ownerToken),
    });
    const allIds = JSON.parse(withInactive.payload).stations.map((s: { id: string }) => s.id);
    expect(allIds).toContain(otherStationId);
  });

  it('never lists another tenant station', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stations?includeInactive=true',
      headers: auth(ownerToken),
    });

    const ids = JSON.parse(res.payload).stations.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(foreignStationId);
  });

  it('returns 404 for another tenant station detail', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/stations/${foreignStationId}`,
      headers: auth(ownerToken),
    });

    expect(res.statusCode).toBe(404);
  });

  it('refuses an empty update', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/stations/${stationId}`,
      headers: auth(ownerToken),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('tanks', () => {
  it('derives the parser key from the printed label', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/tanks`,
      headers: auth(ownerToken),
      payload: { name: 'Tank 1', product: 'Petrol', capacityLitres: 20000 },
    });

    expect(res.statusCode).toBe(201);
    const { tank } = JSON.parse(res.payload);
    // "Tank 1" keys as TANK_1. The parser keys the same tank as `tank:1` — the bare identifier
    // it found after the word TANK — so these are two different strings for one tank, and this
    // slug is a settings-side key rather than the literal field name. The second assertion is
    // the one that matters: it pins the slug to the parser's key through `tankIdentity()`, the
    // bridge between them. Without it this test would pass while every reading failed to match.
    expect(tank.slug).toBe('TANK_1');
    expect(tankIdentity(tank.slug)).toBe('1');
    expect(tank.product).toBe('Petrol');
  });

  it('refuses a duplicate key on the same station', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/tanks`,
      headers: auth(ownerToken),
      payload: { name: 'Tank-1' },
    });

    expect(res.statusCode).toBe(409);
  });

  it('lets a manager add a tank to their own station', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/tanks`,
      headers: auth(managerToken),
      payload: { name: 'Tank 2', product: 'Diesel' },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).tank.slug).toBe('TANK_2');
  });

  it('refuses a manager on a station they are not assigned to', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/stations/${otherStationId}/tanks`,
      headers: auth(managerToken),
      payload: { name: 'Tank 9' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('refuses to add a tank to another tenant station', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/stations/${foreignStationId}/tanks`,
      headers: auth(ownerToken),
      payload: { name: 'Tank 1' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('deactivates a tank without deleting it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/tanks`,
      headers: auth(ownerToken),
      payload: { name: 'Tank 3' },
    });
    const tankId = JSON.parse(created.payload).tank.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/stations/${stationId}/tanks/${tankId}`,
      headers: auth(ownerToken),
      payload: { isActive: false },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).tank.isActive).toBe(false);
  });
});

describe('attendants', () => {
  it('keys a printed name the way the parser will', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants`,
      headers: auth(ownerToken),
      payload: { name: 'J. Mwangi' },
    });

    expect(res.statusCode).toBe(201);
    const { attendant } = JSON.parse(res.payload);
    expect(attendant.slug).toBe('J_MWANGI');
    expect(attendant.userId).toBeNull();
  });

  it('links an attendant login', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants`,
      headers: auth(ownerToken),
      payload: { name: 'John Mwangi', userId: attendantUserId },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).attendant.userId).toBe(attendantUserId);
  });

  it('refuses to link a non-attendant login', async () => {
    const manager = await prisma.user.findUnique({ where: { email: 'manager@station.local' } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants`,
      headers: auth(ownerToken),
      payload: { name: 'A Manager', userId: manager!.id },
    });

    expect(res.statusCode).toBe(400);
  });

  it('refuses to link one login to two attendant records', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants`,
      headers: auth(ownerToken),
      payload: { name: 'Someone Else', userId: attendantUserId },
    });

    expect(res.statusCode).toBe(409);
  });
});

describe('station detail', () => {
  it('returns tanks, attendants and the logins with access', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/stations/${stationId}`,
      headers: auth(ownerToken),
    });

    expect(res.statusCode).toBe(200);
    const detail = JSON.parse(res.payload);

    expect(detail.station.id).toBe(stationId);
    expect(detail.station.tankCount).toBe(detail.tanks.length);
    expect(detail.attendants.length).toBeGreaterThan(0);

    // The manager is assigned to this station, so they appear as access — and as an access
    // row only, never among the attendants whose names are printed on reports.
    const emails = detail.users.map((u: { email: string }) => u.email);
    expect(emails).toContain('manager@station.local');
    expect(detail.attendants.map((a: { slug: string }) => a.slug)).not.toContain('MANAGER_STATION_LOCAL');
  });

  it('is refused to an attendant with no assignment to it', async () => {
    const attendant = await prisma.user.findUnique({ where: { email: 'attendant@station.local' } });
    const token = createAccessToken({
      sub: attendant!.id,
      tenantId,
      role: attendant!.role,
      stationIds: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/stations/${stationId}`,
      headers: auth(token),
    });

    expect(res.statusCode).toBe(403);
  });
});
