/**
 * The one place FuelFlow puts a message on the wire.
 *
 * Transport only — no templates, no product vocabulary. A caller composes a subject and a body
 * and hands them here; this module decides *whether* they can be delivered and *how*, and says so
 * honestly when the answer is no.
 *
 * Two senders live here and they are deliberately not symmetrical:
 *
 *  - **`smtp`** — a real `nodemailer` connection, created lazily on the first message and reused.
 *  - **`log`** — the message is written to the server log. It is a development sender: the whole
 *    point of it is that `pnpm dev` can walk a password reset without a mail server, which means
 *    the reset link is in the log, in the clear, for anyone who can read the terminal. That is
 *    exactly why {@link mailDelivery} reports it as no delivery at all under
 *    `NODE_ENV=production`.
 *
 * Nothing here throws for a *recipient's* problem — a bad address, a refused relay. The callers
 * that matter are public endpoints whose answers must not vary by whether an address exists, so
 * this module returns normally and the failure is logged. It throws only for the programmer's
 * problem: asking it to send when the configuration says delivery is impossible.
 */

import type { FastifyBaseLogger } from 'fastify';
import { mailDelivery, resolveMailSettings, type MailSettings } from '../config/mail.js';

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * The slice of a `nodemailer` transporter this module uses.
 *
 * Structural rather than the library's own `Transporter`, so the module's surface does not move
 * when `nodemailer`'s generics do — and so the dynamic import below has a shape to be checked
 * against without a static dependency on the package's types at load time.
 */
interface SmtpTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
  close(): void;
}

let logger: FastifyBaseLogger | null = null;
let smtpTransport: SmtpTransport | null = null;
let senderOverride: MailSender | null = null;

/**
 * A substitute for the configured transport.
 *
 * The delivery seam, and the only way to observe an outbound message without a mail server. The
 * suite installs one to read back the reset link it just asked for — the token exists nowhere but
 * in the message body, which is what makes it a credential — and a queue- or SMS-based transport
 * would plug in here rather than in `sendMail`.
 *
 * It deliberately does **not** bypass the `none` check below: a test that overrides delivery must
 * still be a configuration in which delivery is possible, or the override would be hiding the
 * exact bug — telling somebody an email went out when the server cannot send one.
 */
export type MailSender = (message: OutboundMail) => Promise<void>;

export function setMailSender(sender: MailSender | null): void {
  senderOverride = sender;
}

/**
 * Give the mailer somewhere to log. Called from `buildApp` with `app.log`, the same way
 * `setJwtInstance` is called with `app.jwt`.
 *
 * Not a module-level `console` call: a development reset link printed to stdout with no level and
 * no timestamp is indistinguishable from debug noise, and in production the failure of a real
 * send has to land in the request log where an operator is already looking.
 */
export function setMailLogger(instance: FastifyBaseLogger): void {
  logger = instance;
}

function log(level: 'info' | 'warn' | 'error', payload: Record<string, unknown>, message: string): void {
  if (logger) {
    logger[level](payload, message);
    return;
  }
  // Before `buildApp` has run — a script or a unit test. Losing the message entirely would be
  // worse than an unformatted line.
  console[level === 'error' ? 'error' : 'log'](message, payload);
}

/**
 * The SMTP connection, built on first use.
 *
 * Lazy and dynamic for one reason: a deployment running the `log` transport should never pay for
 * loading `nodemailer`, and a `log`-transport boot must not depend on the package being
 * installed. Once built it is reused — a transporter is a connection pool, and opening one per
 * password reset would make a burst of resets into a burst of TCP handshakes.
 */
async function getSmtpTransport(settings: MailSettings): Promise<SmtpTransport> {
  if (smtpTransport) {
    return smtpTransport;
  }

  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport(settings.smtpUrl, { from: settings.from });

  smtpTransport = {
    sendMail: (message) => transport.sendMail(message),
    // `close()` on a transporter built without `pool: true` is a no-op today, and calling it is
    // the documented way to release the connection either way, so the pool can be turned on
    // later without this becoming a leak.
    close: () => transport.close(),
  };

  return smtpTransport;
}

/** Release the SMTP connection, if one was ever opened. Called on shutdown and by tests. */
export function closeMailTransport(): void {
  smtpTransport?.close();
  smtpTransport = null;
}

/**
 * Send one message, or explain in the log why it did not go.
 *
 * Throws only when delivery is `none`. That is not a recipient's problem and cannot be caught and
 * shrugged off: it means the operator asked for email in a deployment that cannot send any, and
 * the caller is expected to have checked {@link mailDelivery} first and refused the request.
 */
export async function sendMail(message: OutboundMail): Promise<void> {
  const settings = resolveMailSettings();
  const delivery = mailDelivery(settings);

  if (delivery === 'none') {
    throw new Error(
      'Refusing to pretend an email was sent: MAIL_TRANSPORT is "log" and NODE_ENV is production, ' +
        'so nothing would be delivered. Configure SMTP_URL.'
    );
  }

  // Ahead of both transports but *behind* the check above, so an override can only ever replace
  // a delivery that would otherwise have happened.
  if (senderOverride) {
    await senderOverride(message);
    return;
  }

  if (delivery === 'log') {
    log(
      'info',
      { to: message.to, subject: message.subject, body: message.text },
      'Outbound email not delivered — log transport (development only)'
    );
    return;
  }

  try {
    await (await getSmtpTransport(settings)).sendMail({
      from: settings.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  } catch (error) {
    // Swallowed on purpose. This module is called from a public endpoint that must answer
    // identically whether or not the address exists; letting an SMTP failure become a 500 would
    // turn a broken mail server into an account-enumeration oracle. The failure is loud in the
    // log, which is where an operator can act on it, and the caller has already told the person
    // to check their inbox — the one moment in this flow where a lie is unavoidable, and one
    // that only exists because the alternative is a worse one.
    log('error', { err: error, to: message.to }, 'Outbound email could not be delivered');
  }
}
