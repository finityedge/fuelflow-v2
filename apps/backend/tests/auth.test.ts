import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { resetDatabase } from './helpers/db.js';

let app: Awaited<ReturnType<typeof buildApp>>;

/** The value of the httpOnly refresh cookie a login or registration just set. */
function refreshCookieOf(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((cookie) => cookie.name === 'refreshToken')?.value;
}

async function registerOwner(email: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      tenantName: 'Test Fuel Station',
      ownerEmail: email,
      ownerPassword: 'password123',
    },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await resetDatabase();
});

describe('auth routes', () => {
  it('POST /api/auth/register creates tenant and owner', async () => {
    const res = await registerOwner('owner@test.local');

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.accessToken).toBeDefined();
    expect(body.user.role).toBe('OWNER');
    expect(body.user.stationIds).toEqual([]);
  });

  it('never returns the refresh token in the body', async () => {
    const res = await registerOwner('no-token-in-body@test.local');

    // The whole point of the cookie is that the client never holds this. A body copy would
    // be read by the SPA and persisted, which is the bug this replaced.
    expect(JSON.parse(res.payload).refreshToken).toBeUndefined();
    expect(refreshCookieOf(res)).toBeDefined();
  });

  it('POST /api/auth/login returns an access token for valid credentials', async () => {
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
    expect(refreshCookieOf(res)).toBeDefined();
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

  it('POST /api/auth/refresh returns a new access token from the cookie', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'owner@test.local',
        password: 'password123',
      },
    });

    const refreshToken = refreshCookieOf(loginRes);
    expect(refreshToken).toBeDefined();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { refreshToken: refreshToken! },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.accessToken).toBeDefined();
    expect(body.user.role).toBe('OWNER');
  });

  it('POST /api/auth/refresh refuses a request with no cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh' });

    expect(res.statusCode).toBe(401);
  });

  it('POST /api/auth/refresh refuses a revoked token', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@test.local', password: 'password123' },
    });
    const refreshToken = refreshCookieOf(loginRes)!;

    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { refreshToken },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { refreshToken },
    });

    // The cookie is still on the client — only the server can delete it — so this is the
    // check that logging out actually ended the session rather than just clearing a store.
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/auth/logout is idempotent and clears the cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });

    expect(res.statusCode).toBe(200);
    const cleared = res.cookies.find((cookie) => cookie.name === 'refreshToken');
    expect(cleared?.value).toBe('');
  });
});
