import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/prisma/client.js';
import { resetDatabase } from './helpers/db.js';
import { UserRole } from '@fuelflow/shared';
import { hashPassword } from '../src/services/password.service.js';
import { createAccessToken } from '../src/services/token.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let tenantId: string;
let stationId: string;
let ownerToken: string;
let managerToken: string;
let attendantToken: string;
let otherManagerToken: string;

beforeAll(async () => {
  app = await buildApp();
  await resetDatabase();

  const password = await hashPassword('password123');

  const tenant = await prisma.tenant.create({ data: { name: 'RBAC Tenant' } });
  tenantId = tenant.id;

  const station = await prisma.station.create({
    data: { tenantId: tenant.id, name: 'Main Station' },
  });
  stationId = station.id;

  const owner = await prisma.user.create({
    data: { tenantId: tenant.id, email: 'owner@rbac.local', passwordHash: password, role: UserRole.OWNER },
  });

  const manager = await prisma.user.create({
    data: { tenantId: tenant.id, email: 'manager@rbac.local', passwordHash: password, role: UserRole.MANAGER },
  });

  await prisma.stationAssignment.create({
    data: { userId: manager.id, stationId: station.id },
  });

  const attendant = await prisma.user.create({
    data: { tenantId: tenant.id, email: 'attendant@rbac.local', passwordHash: password, role: UserRole.ATTENDANT },
  });

  await prisma.stationAssignment.create({
    data: { userId: attendant.id, stationId: station.id },
  });

  const otherStation = await prisma.station.create({
    data: { tenantId: tenant.id, name: 'Other Station' },
  });

  const otherManager = await prisma.user.create({
    data: { tenantId: tenant.id, email: 'othermanager@rbac.local', passwordHash: password, role: UserRole.MANAGER },
  });

  await prisma.stationAssignment.create({
    data: { userId: otherManager.id, stationId: otherStation.id },
  });

  ownerToken = createAccessToken({ sub: owner.id, tenantId, role: owner.role, stationIds: [] });
  managerToken = createAccessToken({ sub: manager.id, tenantId, role: manager.role, stationIds: [stationId] });
  attendantToken = createAccessToken({ sub: attendant.id, tenantId, role: attendant.role, stationIds: [stationId] });
  otherManagerToken = createAccessToken({
    sub: otherManager.id,
    tenantId,
    role: otherManager.role,
    stationIds: [otherStation.id],
  });
});

describe('RBAC middleware', () => {
  it('OWNER can access admin-only route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin-only',
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it('MANAGER cannot access admin-only route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin-only',
      headers: { authorization: `Bearer ${managerToken}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('ATTENDANT cannot hit upload endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { authorization: `Bearer ${attendantToken}` },
      payload: { stationId },
    });

    expect(res.statusCode).toBe(403);
  });

  it('ATTENDANT cannot hit correction endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/correct',
      headers: { authorization: `Bearer ${attendantToken}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('MANAGER can hit upload for assigned station', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { stationId },
    });

    expect(res.statusCode).toBe(200);
  });

  it('MANAGER cannot hit upload for unassigned station', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { authorization: `Bearer ${otherManagerToken}` },
      payload: { stationId },
    });

    expect(res.statusCode).toBe(403);
  });
});
