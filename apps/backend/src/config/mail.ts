/**
 * How FuelFlow sends email, and what it says when it cannot.
 *
 * The product had no outbound email at all before this. That is visible in two places: `0.1`
 * takes an initial password from the owner rather than sending an invite, and the login screen
 * used to apologise for a "Forgot password?" link with nothing behind it. Both come from here.
 *
 * Two transports, and the honest difference between them:
 *
 *  - **`smtp`** — `SMTP_URL` (or `SMTP_HOST`/`SMTP_PORT`/user/pass below) is set and mail is really
 *    delivered. This is the only transport that works in production.
 *  - **`log`** — the message, link included, is written to the server log. That is a *development*
 *    transport, and it is the default outside production because it is what makes the reset flow
 *    walkable on a laptop with no mail server. In production it is reported as no delivery at all
 *    (see {@link mailDelivery}), because an operator who forgot to set `SMTP_URL` should be told
 *    the feature is unavailable rather than shown a success message for an email nobody receives.
 *
 * Deliberately *not* thrown at boot when unset in production, unlike `JWT_SECRET`. A missing
 * signing secret means every token is forgeable and the process must not serve anything; a
 * missing mail transport means one endpoint cannot do its job, and refusing to boot the station's
 * whole application over it would take the reconciliation screens down with it.
 */

export type MailTransportKind = 'log' | 'smtp';

/** What a reset link can actually do, once the environment has been read. */
export type MailDelivery = 'smtp' | 'log' | 'none';

export interface MailSettings {
  transport: MailTransportKind;
  /** Empty unless `transport` is `smtp`. */
  smtpUrl: string;
  from: string;
  /** The origin the reset link points at. Never a container-internal address. */
  appUrl: string;
}

/**
 * Where the API lives as far as a *person's browser* is concerned.
 *
 * Defaults to the Vite dev server, which is right for everything but production. In production
 * an unset value is refused rather than defaulted: a reset email whose link points at
 * `localhost:5173` fails on the recipient's machine, and the person receiving it has no way to
 * tell that from the link having expired.
 */
const DEFAULT_APP_URL = 'http://localhost:5173';

export const DEFAULT_MAIL_FROM = 'FuelFlow <no-reply@fuelflow.local>';

/**
 * Read the mail settings.
 *
 * Reads `process.env`, and nothing here loads `.env` first — that is `src/env.ts`, which
 * `index.ts`, the worker and the seed all import before anything reaches this module. A caller
 * that skipped it would see "no mail configured" from a machine with a perfectly good `SMTP_URL`
 * sitting in its `.env`, and the only symptom would be a 503 on the one endpoint nobody tries
 * until they are already locked out.
 *
 * `MAIL_TRANSPORT` is validated rather than defaulted when it is set to something unrecognised:
 * `MAIL_TRANSPORT=smt` silently becoming the log transport is a production deployment that
 * believes it sends mail and does not.
 */
export function resolveMailSettings(): MailSettings {
  const smtpUrl = process.env.SMTP_URL?.trim() ?? '';
  // `|| undefined`, not `??` — compose passes unset variables through as empty strings, and an
  // empty string is not nullish, so `??` would keep it and leave `transport` as neither `log`
  // nor `smtp`. The result was a deployment that read as "configured" and delivered nothing.
  const configured = process.env.MAIL_TRANSPORT?.trim().toLowerCase() || undefined;
  const appUrl = (process.env.APP_URL?.trim() || DEFAULT_APP_URL).replace(/\/+$/, '');
  const from = process.env.MAIL_FROM?.trim() || DEFAULT_MAIL_FROM;

  if (configured && configured !== 'log' && configured !== 'smtp') {
    throw new Error(
      `MAIL_TRANSPORT must be "log" or "smtp" (got "${process.env.MAIL_TRANSPORT}"). Refusing to guess.`
    );
  }

  const transport: MailTransportKind =
    (configured as MailTransportKind | undefined) ?? (smtpUrl ? 'smtp' : 'log');

  if (transport === 'smtp' && !smtpUrl) {
    throw new Error('MAIL_TRANSPORT=smtp requires SMTP_URL to be set.');
  }

  if (process.env.NODE_ENV === 'production' && transport === 'smtp' && !process.env.APP_URL) {
    throw new Error(
      'APP_URL must be set to the public origin when NODE_ENV=production and mail is enabled. ' +
        'Refusing to email password-reset links pointing at a development address.'
    );
  }

  return { transport, smtpUrl, from, appUrl };
}

/**
 * What a reset link can actually do here.
 *
 * `log` becomes `none` in production, and that is the whole reason this function exists rather
 * than the transport being read directly. Outside production a link in the terminal is a working
 * reset for the person at the keyboard; inside it there is no terminal for the recipient, and
 * answering "check your email" would be a lie the person cannot act on.
 */
export function mailDelivery(settings: MailSettings = resolveMailSettings()): MailDelivery {
  if (settings.transport === 'smtp') {
    return 'smtp';
  }
  return process.env.NODE_ENV === 'production' ? 'none' : 'log';
}
