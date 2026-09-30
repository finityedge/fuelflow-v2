import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { UserRole } from '@fuelflow/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/prisma/client.js';
import { resetDatabase } from './helpers/db.js';
import { hashPassword } from '../src/services/password.service.js';
import { createAccessToken } from '../src/services/token.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

let tenantId: string;
let stationAId: string;
let stationBId: string;
let ownerId: string;
let otherTenantStationId: string;
let ownerToken: string;
let managerToken: string;
let attendantToken: string;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  app = await buildApp();
  await resetDatabase();

  const passwordHash = await hashPassword('password123');

  const tenant = await prisma.tenant.create({ data: { name: 'Provisioning Tenant' } });
  tenantId = tenant.id;

  const stationA = await prisma.station.create({
    data: { tenantId: tenant.id, name: 'Station A' },
  });
  stationAId = stationA.id;

  const stationB = await prisma.station.create({
    data: { tenantId: tenant.id, name: 'Station B' },
  });
  stationBId = stationB.id;

  const owner = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: 'owner@provisioning.local',
      passwordHash,
      role: UserRole.OWNER,
    },
  });
  ownerId = owner.id;

  const manager = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: 'manager@provisioning.local',
      passwordHash,
      role: UserRole.MANAGER,
    },
  });
  await prisma.stationAssignment.create({
    data: { userId: manager.id, stationId: stationA.id },
  });

  const attendant = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: 'attendant@provisioning.local',
      passwordHash,
      role: UserRole.ATTENDANT,
    },
  });
  await prisma.stationAssignment.create({
    data: { userId: attendant.id, stationId: stationB.id },
  });

  // A second tenant entirely. Its station must never be assignable by the first tenant's
  // owner, however the id is obtained.
  const otherTenant = await prisma.tenant.create({ data: { name: 'Other Tenant' } });
  const otherStation = await prisma.station.create({
    data: { tenantId: otherTenant.id, name: 'Someone Else Station' },
  });
  otherTenantStationId = otherStation.id;

  ownerToken = createAccessToken({
    sub: owner.id,
    tenantId,
    role: owner.role,
    stationIds: [],
  });
  managerToken = createAccessToken({
    sub: manager.id,
    tenantId,
    role: manager.role,
    stationIds: [stationAId],
  });
  attendantToken = createAccessToken({
    sub: attendant.id,
    tenantId,
    role: attendant.role,
    stationIds: [stationBId],
  });
});

describe('POST /api/users', () => {
  it('creates an attendant assigned to a station', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(ownerToken),
      payload: {
        email: 'new.attendant@provisioning.local',
        password: 'password123',
        role: 'ATTENDANT',
        stationIds: [stationAId],
      },
    });

    expect(res.statusCode).toBe(201);
    const { user } = JSON.parse(res.payload);
    expect(user.email).toBe('new.attendant@provisioning.local');
    expect(user.role).toBe('ATTENDANT');
    expect(user.isActive).toBe(true);
    expect(user.stationIds).toEqual([stationAId]);
  });

  it('refuses a station belonging to another tenant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(ownerToken),
      payload: {
        email: 'cross.tenant@provisioning.local',
        password: 'password123',
        role: 'ATTENDANT',
        stationIds: [otherTenantStationId],
      },
    });

    // Not "forbidden" but "not found": the scoped lookup cannot see that station at all, so
    // the id is indistinguishable from one that does not exist. The user is not created.
    expect(res.statusCode).toBe(400);
    const created = await prisma.user.findUnique({
      where: { email: 'cross.tenant@provisioning.local' },
    });
    expect(created).toBeNull();
  });

  it('returns 409 for an email already in use', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(ownerToken),
      payload: {
        email: 'owner@provisioning.local',
        password: 'password123',
        role: 'MANAGER',
      },
    });

    expect(res.statusCode).toBe(409);
  });

  it('refuses to create an OWNER', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(ownerToken),
      payload: {
        email: 'second.owner@provisioning.local',
        password: 'password123',
        role: 'OWNER',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('refuses a password shorter than eight characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(ownerToken),
      payload: {
        email: 'weak@provisioning.local',
        password: 'short',
        role: 'ATTENDANT',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('is refused for a MANAGER', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(managerToken),
      payload: {
        email: 'by.manager@provisioning.local',
        password: 'password123',
        role: 'ATTENDANT',
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it('is refused for an ATTENDANT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(attendantToken),
      payload: {
        email: 'by.attendant@provisioning.local',
        password: 'password123',
        role: 'ATTENDANT',
      },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/users', () => {
  it('lets an owner see every user in the tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: auth(ownerToken),
    });

    expect(res.statusCode).toBe(200);
    const emails = JSON.parse(res.payload).users.map((u: { email: string }) => u.email);
    expect(emails).toContain('manager@provisioning.local');
    expect(emails).toContain('attendant@provisioning.local');
    // Nobody from the other tenant, ever.
    expect(JSON.stringify(emails)).not.toContain('someone else');
  });

  it('shows a manager only the people on their own stations', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: auth(managerToken),
    });

    expect(res.statusCode).toBe(200);
    const emails = JSON.parse(res.payload).users.map((u: { email: string }) => u.email);

    // The new attendant was put on Station A, which this manager runs.
    expect(emails).toContain('new.attendant@provisioning.local');
    // The attendant on Station B is not this manager's business.
    expect(emails).not.toContain('attendant@provisioning.local');
    // Neither is the owner.
    expect(emails).not.toContain('owner@provisioning.local');
  });

  it('is refused for an ATTENDANT', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: auth(attendantToken),
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /api/users/:id', () => {
  it('replaces the station assignment list', async () => {
    const created = await prisma.user.create({
      data: {
        tenantId,
        email: 'reassign@provisioning.local',
        passwordHash: await hashPassword('password123'),
        role: UserRole.ATTENDANT,
        stationAssignments: { create: [{ stationId: stationAId }] },
      },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${created.id}`,
      headers: auth(ownerToken),
      payload: { stationIds: [stationBId] },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).user.stationIds).toEqual([stationBId]);
  });

  it('refuses an empty update', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${ownerId}`,
      headers: auth(ownerToken),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('refuses to let an owner change their own account', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${ownerId}`,
      headers: auth(ownerToken),
      payload: { isActive: false },
    });

    expect(res.statusCode).toBe(400);
    const stillActive = await prisma.user.findUnique({ where: { id: ownerId } });
    expect(stillActive?.isActive).toBe(true);
  });

  it('returns 404 for a user id that does not exist', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/00000000-0000-0000-0000-000000000000',
      headers: auth(ownerToken),
      payload: { isActive: false },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('deactivation', () => {
  it('ends the session, not just future logins', async () => {
    const email = 'leaver@provisioning.local';
    const password = 'password123';

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: auth(ownerToken),
      payload: { email, password, role: 'ATTENDANT', stationIds: [stationAId] },
    });
    const created = JSON.parse(createRes.payload).user;

    // A live session, obtained the way a real one is.
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(loginRes.statusCode).toBe(200);
    const refreshToken = loginRes.cookies.find((c) => c.name === 'refreshToken')?.value;
    const accessToken = JSON.parse(loginRes.payload).accessToken;
    expect(refreshToken).toBeDefined();

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/users/${created.id}`,
      headers: auth(ownerToken),
      payload: { isActive: false },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(JSON.parse(patchRes.payload).user.isActive).toBe(false);

    // The access token they already hold stops working, even though it has not expired.
    const stillWorks = await app.inject({
      method: 'GET',
      url: '/api/shift-reports',
      headers: auth(accessToken),
    });
    expect(stillWorks.statusCode).toBe(401);

    // The refresh cookie they already hold cannot buy a new one.
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { refreshToken: refreshToken! },
    });
    expect(refreshRes.statusCode).toBe(401);

    // And they cannot log back in.
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(relogin.statusCode).toBe(401);
  });

  it('hides deactivated users from the default listing but not from an explicit one', async () => {
    const email = 'hidden@provisioning.local';
    const created = await prisma.user.create({
      data: {
        tenantId,
        email,
        passwordHash: await hashPassword('password123'),
        role: UserRole.ATTENDANT,
        isActive: false,
      },
    });
    expect(created.isActive).toBe(false);

    const defaultList = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: auth(ownerToken),
    });
    expect(JSON.stringify(JSON.parse(defaultList.payload))).not.toContain(email);

    const fullList = await app.inject({
      method: 'GET',
      url: '/api/users?includeInactive=true',
      headers: auth(ownerToken),
    });
    expect(JSON.stringify(JSON.parse(fullList.payload))).toContain(email);
  });
});
