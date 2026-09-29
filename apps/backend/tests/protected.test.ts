import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/prisma/client.js';
import { resetDatabase } from './helpers/db.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let tenantAId: string;

beforeAll(async () => {
  app = await buildApp();
  await resetDatabase();

  const registerRes = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      tenantName: 'Tenant A',
      ownerEmail: 'owner@tenant-a.local',
      ownerPassword: 'password123',
    },
  });

  const registerBody = JSON.parse(registerRes.payload);
  tenantAId = registerBody.user.tenantId;

  // Create a station and a shift report for tenant A
  const station = await prisma.station.create({
    data: {
      tenantId: tenantAId,
      name: 'Tenant A Station',
    },
  });

  await prisma.shiftReport.create({
    data: {
      tenantId: tenantAId,
      stationId: station.id,
      reportDate: new Date(),
    },
  });
});

describe('protected routes', () => {
  it('rejects requests without a token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected-test',
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with an invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected-test',
      headers: { authorization: 'Bearer invalid-token' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects cross-tenant access via tenant scoping', async () => {
    const otherRegisterRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        tenantName: 'Tenant B',
        ownerEmail: 'owner@tenant-b.local',
        ownerPassword: 'password123',
      },
    });

    const otherToken = JSON.parse(otherRegisterRes.payload).accessToken;

    // Try to read Tenant A's shift reports using Tenant B's token
    const res = await app.inject({
      method: 'GET',
      url: '/api/shift-reports',
      headers: { authorization: `Bearer ${otherToken}` },
    });

    // Expect 200 but empty list because tenant scope filters Tenant A data
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.reports).toEqual([]);
  });
});
