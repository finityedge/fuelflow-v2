import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { resetDatabase } from './helpers/db.js';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
  await resetDatabase();
});

describe('auth routes', () => {
  it('POST /api/auth/register creates tenant and owner', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        tenantName: 'Test Fuel Station',
        ownerEmail: 'owner@test.local',
        ownerPassword: 'password123',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    expect(body.user.role).toBe('OWNER');
    expect(body.user.stationIds).toEqual([]);
  });

  it('POST /api/auth/login returns tokens for valid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'owner@test.local',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });

  it('POST /api/auth/login rejects invalid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'owner@test.local',
        password: 'wrongpassword',
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('POST /api/auth/refresh returns new access token', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'owner@test.local',
        password: 'password123',
      },
    });

    const { refreshToken } = JSON.parse(loginRes.payload);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.accessToken).toBeDefined();
    expect(body.user.role).toBe('OWNER');
  });
});
