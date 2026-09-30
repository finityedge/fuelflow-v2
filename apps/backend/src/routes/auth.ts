import { FastifyInstance, FastifyRequest } from 'fastify';
import { login, refreshAccessToken, registerTenantAndOwner } from '../services/auth.service.js';
import {
  forgotPasswordBodySchema,
  loginBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
} from '../schemas/auth.schema.js';
import {
  getRefreshCookieOptions,
  revokeRefreshToken,
  verifyRefreshToken,
} from '../services/token.service.js';
import { requestPasswordReset, resetPassword } from '../services/passwordReset.service.js';
import { mailDelivery } from '../config/mail.js';

/** The one place the cookie's name is written. Read and written through these helpers. */
const REFRESH_COOKIE = 'refreshToken';

/**
 * How many auth attempts one IP gets per minute.
 *
 * These six routes are the only ones where guessing is the attack: a password, a refresh token,
 * or an email address that might or might not have an account. Everything else needs a token that
 * is already valid. Ten a minute is far above what a person mistyping a password needs and far
 * below what makes a dictionary attack worth running — and for `/forgot-password` specifically it
 * is also what stops the endpoint being used to sort a list of addresses into real and fake by
 * sheer volume. Raised under test, where a suite legitimately makes a dozen calls from one address
 * and throttling would show up as a flaky failure rather than a finding.
 */
const AUTH_RATE_LIMIT_MAX =
  process.env.NODE_ENV === 'test' ? 1000 : Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10);

const authRouteConfig = {
  public: true,
  rateLimit: { max: AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' },
};

/**
 * The refresh token, from the httpOnly cookie and nowhere else.
 *
 * It is deliberately not accepted in the request body. A token the client can hold is a
 * token the client will store, and the version of this that read it from the body ended up
 * persisted in `localStorage` — readable by any script on the page for as long as the
 * session lasted. The cookie is httpOnly, so script cannot read it at all, and it is the
 * only copy that exists outside the database.
 */
function readRefreshToken(request: FastifyRequest): string | undefined {
  return request.cookies[REFRESH_COOKIE];
}

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/register',
    { config: authRouteConfig },
    async (request, reply) => {
      const body = registerBodySchema.parse(request.body);
      const result = await registerTenantAndOwner(body);

      void reply.setCookie(REFRESH_COOKIE, result.refreshToken, getRefreshCookieOptions());
      return reply.status(201).send({
        user: result.user,
        accessToken: result.accessToken,
      });
    }
  );

  app.post(
    '/login',
    { config: authRouteConfig },
    async (request, reply) => {
      const body = loginBodySchema.parse(request.body);
      const result = await login(body);

      if (!result) {
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      void reply.setCookie(REFRESH_COOKIE, result.refreshToken, getRefreshCookieOptions());
      return reply.send({
        user: result.user,
        accessToken: result.accessToken,
      });
    }
  );

  app.post(
    '/refresh',
    { config: authRouteConfig },
    async (request, reply) => {
      const token = readRefreshToken(request);
      if (!token) {
        return reply.status(401).send({ error: 'No refresh token' });
      }

      let payload;
      try {
        payload = await verifyRefreshToken(token);
      } catch {
        // Also the path a revoked token takes: `revokeRefreshToken` clears the stored hash,
        // so a token that was logged out no longer matches any user and lands here.
        void reply.clearCookie(REFRESH_COOKIE, getRefreshCookieOptions());
        return reply.status(401).send({ error: 'Invalid refresh token' });
      }

      const result = await refreshAccessToken(payload.sub);
      if (!result) {
        void reply.clearCookie(REFRESH_COOKIE, getRefreshCookieOptions());
        return reply.status(401).send({ error: 'User not found' });
      }

      return reply.send({
        user: result.user,
        accessToken: result.accessToken,
      });
    }
  );

  app.post(
    '/logout',
    { config: authRouteConfig },
    async (request, reply) => {
      const token = readRefreshToken(request);

      if (token) {
        try {
          const payload = await verifyRefreshToken(token);
          await revokeRefreshToken(payload.sub);
        } catch {
          // An unreadable token is already not a session; clearing the cookie is the whole
          // job. Reporting an error here would tell a logging-out user nothing useful.
        }
      }

      void reply.clearCookie(REFRESH_COOKIE, getRefreshCookieOptions());
      return reply.send({ status: 'ok' });
    }
  );

  /**
   * Ask for a reset link.
   *
   * Answers 202 for every address, real or not — see `passwordReset.service.ts` for why the
   * response cannot vary. The one exception, the 503 below, is checked *before* the address is
   * looked at, so even it says nothing about who has an account.
   */
  app.post(
    '/forgot-password',
    { config: authRouteConfig },
    async (request, reply) => {
      const body = forgotPasswordBodySchema.parse(request.body);

      // A deployment with no working mail transport, answering "check your inbox" for an email
      // that will never be sent. Refusing outright is the honest answer, and it is safe to give
      // because the condition is a property of the server rather than of the address.
      if (mailDelivery() === 'none') {
        return reply.status(503).send({
          error: 'Email is not configured on this server, so password reset is unavailable.',
        });
      }

      await requestPasswordReset(body.email);

      return reply.status(202).send({ status: 'ok' });
    }
  );

  /**
   * Spend a reset link.
   *
   * No cookie is set and no token is returned. The new password is the whole point, and a caller
   * proving they hold the account by producing the emailed link is not the same thing as a caller
   * who has signed in — asking them to log in afterwards means a session cannot be created by
   * somebody who merely found the link in a forwarded email.
   */
  app.post(
    '/reset-password',
    { config: authRouteConfig },
    async (request, reply) => {
      const body = resetPasswordBodySchema.parse(request.body);
      await resetPassword(body.token, body.password);

      return reply.send({ status: 'ok' });
    }
  );
}
