/**
 * Setting a password for somebody who cannot sign in with theirs.
 *
 * The flow is two public endpoints and nothing else: one takes an email address, one takes a
 * token and a new password. Everything hard about it is about the *silence* — who is told what,
 * and which failures are allowed to be distinguishable from each other. The rules, and why:
 *
 *  - **The request endpoint never says whether the address is real.** It answers the same thing
 *    for an address nobody has ever registered and for one that is about to receive an email.
 *    Any difference at all turns it into a way to ask "does this person use FuelFlow?", and the
 *    list of people who can be asked that question is everyone with a company address.
 *
 *  - **A deactivated account is treated exactly like an unknown one.** Its holder cannot sign in
 *    even with a brand-new password, so a link would only be a way to discover that the account
 *    exists. The `isActive` check is here rather than in the caller so it cannot be forgotten.
 *
 *  - **Spending a token is a write, not a delete.** Rows are marked, not removed, because the two
 *    answers a person can get back are different instructions: "this link was already used or has
 *    expired" sends them to their inbox for a newer email, while "this link is not valid" sends
 *    them back to the request form. Telling somebody with a stale link the second thing produces
 *    a loop of requesting and clicking that never ends.
 *
 *  - **A new request supersedes every existing link.** Otherwise a month of half-finished resets
 *    is a month of live credentials, and the one that gets clicked is not the one the person
 *    remembers asking for.
 */

import crypto from 'node:crypto';
import { prisma } from '../prisma/client.js';
import { resolveMailSettings } from '../config/mail.js';
import { hashPassword } from './password.service.js';
import { sendMail } from './mail.service.js';

/**
 * How long a link stays good, in minutes.
 *
 * An hour is long enough to survive a mail server's retry queue — a token that dies while the
 * email is still in transit is indistinguishable, from the reader's side, from a broken product —
 * and short enough that one left in a shared inbox is unlikely to still work tomorrow.
 */
const RESET_TTL_MINUTES = 60;

/**
 * The path the emailed link points at, joined to `APP_URL`.
 *
 * Exported so the frontend route and this string cannot drift apart silently: the failure mode is
 * an email whose link lands on a 404, which nobody notices until somebody locked out reports it.
 */
export const RESET_PAGE_PATH = '/reset-password';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Same status and shape as a malformed request, because that is what it is. */
function resetRejected(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function buildResetUrl(token: string, appUrl?: string): string {
  const base = (appUrl ?? resolveMailSettings().appUrl).replace(/\/+$/, '');
  return `${base}${RESET_PAGE_PATH}?token=${encodeURIComponent(token)}`;
}

function resetEmail(url: string): { subject: string; text: string } {
  return {
    subject: 'Reset your FuelFlow password',
    text: [
      'Somebody asked to reset the FuelFlow password for this email address.',
      '',
      'Open this link to choose a new one:',
      url,
      '',
      `The link works once, and stops working after ${RESET_TTL_MINUTES} minutes.`,
      '',
      "If this wasn't you, you can ignore this message — nothing has changed, and nobody can",
      'get in without opening the link above.',
    ].join('\n'),
  };
}

/**
 * Send a reset link, if there is anybody to send it to.
 *
 * Returns nothing at all — not "sent", not "no such user". The caller has no way to learn whether
 * an address exists, which is the point.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, isActive: true },
  });

  if (!user || !user.isActive) {
    return;
  }

  const token = crypto.randomBytes(32).toString('hex');

  await prisma.$transaction(async (tx) => {
    // Supersede first, then issue. Doing it the other way round leaves a window in which both
    // the old and the new link are live.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        // Only the hash is stored. The token itself exists in exactly two places: this stack
        // frame and the email. A dump of the table is not a set of working reset links.
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
      },
    });
  });

  const { subject, text } = resetEmail(buildResetUrl(token));

  // Deliberately not wrapped in a try/catch that swallows the *configuration* error. `sendMail`
  // throws only when delivery is impossible and the operator was never told — which the route
  // checks for before it gets here. A recipient-side failure is logged and absorbed inside
  // `sendMail`, so this endpoint's answer cannot depend on whether the address exists.
  await sendMail({ to: user.email, subject, text });
}

export interface ResetPasswordResult {
  email: string;
}

/**
 * Spend a reset link and set a new password.
 *
 * Throws a 400 for every way a token can be unusable. The messages differ on purpose — see the
 * file comment — and none of them leaks anything to somebody who did not already hold the token.
 */
export async function resetPassword(token: string, password: string): Promise<ResetPasswordResult> {
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      usedAt: true,
      expiresAt: true,
      user: { select: { email: true, isActive: true } },
    },
  });

  // A token that was never issued. Distinct from the used/expired answer below, and safe to
  // distinguish: this branch is only reachable by somebody who does not hold a real token, and
  // there is nothing about a real token that this tells them.
  if (!row) {
    throw resetRejected('That password reset link is not valid.');
  }

  if (row.usedAt || row.expiresAt.getTime() <= Date.now()) {
    throw resetRejected(
      'That password reset link has expired or was already used. Request a new one.'
    );
  }

  // Only reachable by a link issued before the account was deactivated. Answered plainly rather
  // than as a generic failure, because "invalid link" would send the person round the request
  // loop forever with nothing to show for it.
  if (!row.user.isActive) {
    throw resetRejected(
      'That account has been deactivated. Ask an owner at your station to restore it.'
    );
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: row.userId },
      data: {
        passwordHash,
        // Every session ends here, and that is the reason someone resets a password they think
        // was stolen. Clearing the stored refresh hash means the access token already in an
        // attacker's hands dies with the 15 minutes it had left, and the cookie cannot buy a
        // new one. It is also load-bearing for a stolen-laptop case: the old owner is the one
        // holding the new password, and the machine in the taxi stops working.
        refreshToken: null,
      },
    });

    // This row and any sibling still outstanding. Marking rather than deleting, for the reason
    // in the file comment — a second click has to be able to say what happened.
    await tx.passwordResetToken.updateMany({
      where: { userId: row.userId, usedAt: null },
      data: { usedAt: now },
    });
  });

  return { email: row.user.email };
}
