import 'dotenv/config';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { UserRole } from '@fuelflow/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/prisma/client.js';
import { resetDatabase } from './helpers/db.js';
import { hashPassword } from '../src/services/password.service.js';
import { setMailSender, type OutboundMail } from '../src/services/mail.service.js';

/**
 * The password-reset flow, end to end.
 *
 * The link is read out of the message the server hands the mailer rather than out of the
 * database, because the token is nowhere else — only its SHA-256 is stored. That is not a
 * convenience for the test; it is the property being proven. A green run here means the credential
 * exists in exactly one place, and that place is an email.
 */

let app: Awaited<ReturnType<typeof buildApp>>;

/** The address every test that needs an account to exist works against. */
const KNOWN_EMAIL = 'known@reset.local';
const KNOWN_PASSWORD = 'password123';

const outbound: OutboundMail[] = [];

/** The 64-hex token out of the reset link in the most recent message. */
function lastToken(): string {
  const last = outbound.at(-1);
  if (!last) {
    throw new Error('No message was sent.');
  }
  const match = /[?&]token=([0-9a-f]{64})/.exec(last.text);
  if (!match) {
    throw new Error(`No reset token in message body:\n${last.text}`);
  }
  return match[1]!;
}

async function forgotPassword(email: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/forgot-password',
    payload: { email },
  });
}

async function resetPassword(token: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/reset-password',
    payload: { token, password },
  });
}

/** The row behind a token, found by hashing it — the same lookup the service does. */
async function tokenRow(token: string) {
  return prisma.passwordResetToken.findUnique({
    where: { tokenHash: createHash('sha256').update(token).digest('hex') },
  });
}

async function login(email: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
}

beforeAll(async () => {
  app = await buildApp();
  await resetDatabase();

  const tenant = await prisma.tenant.create({ data: { name: 'Reset Tenant' } });
  await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: KNOWN_EMAIL,
      passwordHash: await hashPassword(KNOWN_PASSWORD),
      role: UserRole.OWNER,
    },
  });

  // The message the server thought it sent, captured instead of delivered. It is also the only
  // place the token exists in the clear, which is what makes it a credential.
  setMailSender(async (message) => {
    outbound.push(message);
  });
});

afterEach(() => {
  outbound.length = 0;
});

describe('password reset', () => {
  it('rejects a malformed address before doing anything', async () => {
    const res = await forgotPassword('not-an-email');

    expect(res.statusCode).toBe(400);
    expect(outbound).toHaveLength(0);
  });

  it('answers identically for an address that exists and one that does not', async () => {
    const known = await forgotPassword(KNOWN_EMAIL);
    const unknown = await forgotPassword('nobody@reset.local');

    // Status, body and — because the sender is a no-op here — observable side effects. If these
    // ever diverge, the endpoint becomes a way to ask "does this person use FuelFlow?".
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(JSON.parse(known.payload)).toEqual(JSON.parse(unknown.payload));
  });

  it('sends a link that stores only a hash of the token', async () => {
    const res = await forgotPassword(KNOWN_EMAIL);

    expect(res.statusCode).toBe(202);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.to).toBe(KNOWN_EMAIL);

    const token = lastToken();
    const row = await tokenRow(token);

    expect(row).not.toBeNull();
    expect(row!.usedAt).toBeNull();
    expect(row!.tokenHash).not.toBe(token);
    // Nothing anywhere holds the plaintext. A dump of this table is not a set of working links.
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('sends nothing for a deactivated account, and says nothing different', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Deactivated' } });
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'gone@reset.local',
        passwordHash: await hashPassword('password123'),
        role: UserRole.MANAGER,
        isActive: false,
      },
    });

    const res = await forgotPassword('gone@reset.local');

    // A reset link would only be a way to discover that the account exists: they cannot sign in
    // even with a brand-new password.
    expect(res.statusCode).toBe(202);
    expect(outbound).toHaveLength(0);
  });

  it('sets a new password and lets the person log in with it', async () => {
    await forgotPassword(KNOWN_EMAIL);
    const token = lastToken();

    const res = await resetPassword(token, 'brand-new-password');

    expect(res.statusCode).toBe(200);
    expect((await login(KNOWN_EMAIL, 'brand-new-password')).statusCode).toBe(200);
    expect((await login(KNOWN_EMAIL, KNOWN_PASSWORD)).statusCode).toBe(401);
  });

  it('returns no session of its own', async () => {
    await forgotPassword(KNOWN_EMAIL);
    const token = lastToken();

    const res = await resetPassword(token, 'another-new-password');

    // A caller who found the link in a forwarded email should not end up signed in.
    expect(JSON.parse(res.payload).accessToken).toBeUndefined();
    expect(res.cookies.find((cookie) => cookie.name === 'refreshToken')).toBeUndefined();
  });

  it('ends any session that was already open', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Session Killing' } });
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'session@reset.local',
        passwordHash: await hashPassword('password123'),
        role: UserRole.MANAGER,
      },
    });

    const loginRes = await login('session@reset.local', 'password123');
    expect(loginRes.statusCode).toBe(200);
    const refreshCookie = loginRes.cookies.find((cookie) => cookie.name === 'refreshToken')!;

    const refreshWith = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { refreshToken: refreshCookie.value },
      });

    expect((await refreshWith()).statusCode).toBe(200);

    await forgotPassword('session@reset.local');
    await resetPassword(lastToken(), 'replaced-password');

    // The whole reason somebody resets a password they believe was stolen. A captured cookie
    // must stop buying new access tokens the moment the password changes.
    expect((await refreshWith()).statusCode).toBe(401);
    // And the account itself still works, so the 401 above is about the session rather than
    // about the user having been left in a broken state.
    expect((await login('session@reset.local', 'replaced-password')).statusCode).toBe(200);
  });

  it('refuses a token that was already spent', async () => {
    await forgotPassword(KNOWN_EMAIL);
    const token = lastToken();

    expect((await resetPassword(token, 'first-new-password')).statusCode).toBe(200);

    const second = await resetPassword(token, 'second-new-password');

    expect(second.statusCode).toBe(400);
    expect(JSON.parse(second.payload).error).toMatch(/expired or was already used/i);
    // And the second attempt changed nothing.
    expect((await login(KNOWN_EMAIL, 'first-new-password')).statusCode).toBe(200);
  });

  it('refuses a token that was never issued', async () => {
    const res = await resetPassword('f'.repeat(64), 'whatever-password');

    expect(res.statusCode).toBe(400);
    // Distinct from the spent-link answer on purpose: "not valid" sends somebody back to the
    // request form, while "already used" sends them to their inbox. Conflating them produces a
    // loop of requesting and clicking that never ends.
    expect(JSON.parse(res.payload).error).toMatch(/not valid/i);
  });

  it('refuses an expired token', async () => {
    await forgotPassword(KNOWN_EMAIL);
    const token = lastToken();

    await prisma.passwordResetToken.update({
      where: { tokenHash: (await tokenRow(token))!.tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await resetPassword(token, 'too-late-password');

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/expired or was already used/i);
  });

  it('supersedes an outstanding link when a new one is asked for', async () => {
    await forgotPassword(KNOWN_EMAIL);
    const first = lastToken();
    await forgotPassword(KNOWN_EMAIL);
    const second = lastToken();

    expect(second).not.toBe(first);
    // Otherwise a month of half-finished resets is a month of live credentials, and the one that
    // gets clicked is not the one the person remembers asking for.
    expect((await resetPassword(first, 'from-the-old-link')).statusCode).toBe(400);
    expect((await resetPassword(second, 'from-the-new-link')).statusCode).toBe(200);
  });

  it('rejects a password shorter than the registration minimum', async () => {
    await forgotPassword(KNOWN_EMAIL);
    const token = lastToken();

    const res = await resetPassword(token, 'short');

    expect(res.statusCode).toBe(400);
    // Unspent: the caller's mistake must not burn the link they will need to try again.
    expect((await tokenRow(token))!.usedAt).toBeNull();
  });

  it('answers 503 rather than claiming to have sent mail it cannot send', async () => {
    const previous = process.env.NODE_ENV;
    // Production with the log transport is the deployment that has no way to deliver and no
    // operator warning baked in. `buildApp` was already called, so this only affects the
    // delivery check inside the route.
    process.env.NODE_ENV = 'production';

    try {
      const res = await forgotPassword(KNOWN_EMAIL);

      expect(res.statusCode).toBe(503);
      expect(outbound).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
