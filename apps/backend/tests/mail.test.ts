import 'dotenv/config';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_MAIL_FROM,
  mailDelivery,
  resolveMailSettings,
} from '../src/config/mail.js';

/**
 * The rule that decides whether a reset link can reach anybody.
 *
 * Worth its own suite because it is the one piece of the password-reset flow that cannot be
 * exercised through a request: it depends on `NODE_ENV`, which is fixed for a whole test run.
 */

const KEYS = ['NODE_ENV', 'MAIL_TRANSPORT', 'SMTP_URL', 'MAIL_FROM', 'APP_URL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('mail settings', () => {
  it('defaults to the log transport when nothing is configured', () => {
    const settings = resolveMailSettings();

    expect(settings.transport).toBe('log');
    expect(settings.from).toBe(DEFAULT_MAIL_FROM);
    expect(settings.appUrl).toBe('http://localhost:5173');
  });

  it('infers smtp from SMTP_URL alone', () => {
    process.env.SMTP_URL = 'smtps://user:pass@smtp.example.com:465';

    expect(resolveMailSettings().transport).toBe('smtp');
    expect(mailDelivery()).toBe('smtp');
  });

  it('treats an empty MAIL_TRANSPORT as unset', () => {
    // What Compose hands over for a variable nobody filled in. An empty string is not nullish, so
    // this used to leave `transport` as neither `log` nor `smtp` — a deployment that read as
    // configured and delivered nothing.
    process.env.MAIL_TRANSPORT = '';

    expect(resolveMailSettings().transport).toBe('log');
  });

  it('refuses an unrecognised transport rather than falling back', () => {
    process.env.MAIL_TRANSPORT = 'smt';

    // A typo silently becoming the log transport is a production deployment that believes it
    // sends mail and does not.
    expect(() => resolveMailSettings()).toThrow(/MAIL_TRANSPORT must be/);
  });

  it('refuses smtp with no SMTP_URL', () => {
    process.env.MAIL_TRANSPORT = 'smtp';

    expect(() => resolveMailSettings()).toThrow(/requires SMTP_URL/);
  });

  it('reports the log transport as no delivery in production', () => {
    process.env.MAIL_TRANSPORT = 'log';
    process.env.NODE_ENV = 'production';

    // The whole point: a reset link written to a log is not an email anyone receives, and telling
    // somebody to check their inbox for it is a lie they cannot act on.
    expect(mailDelivery()).toBe('none');
  });

  it('reports the log transport as delivery outside production', () => {
    process.env.MAIL_TRANSPORT = 'log';
    process.env.NODE_ENV = 'development';

    expect(mailDelivery()).toBe('log');
  });

  it('refuses to build links against a development address in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.MAIL_TRANSPORT = 'smtp';
    process.env.SMTP_URL = 'smtps://user:pass@smtp.example.com:465';

    // A link pointing at localhost fails on the recipient's machine, and they have no way to tell
    // that from the link having expired.
    expect(() => resolveMailSettings()).toThrow(/APP_URL must be set/);
  });

  it('strips a trailing slash so links do not double it', () => {
    process.env.APP_URL = 'https://fuelflow.example.com/';

    expect(resolveMailSettings().appUrl).toBe('https://fuelflow.example.com');
  });
});
