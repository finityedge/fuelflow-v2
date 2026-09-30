import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { FastifyError, onRouteHookHandler, RouteOptions } from 'fastify';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { shiftReportRoutes } from './routes/shiftReports.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { tankLeakageRoutes } from './routes/tankLeakage.js';
import { attendantProfileRoutes } from './routes/attendantProfiles.js';
import { findingsRoutes } from './routes/findings.js';
import { stationRoutes } from './routes/stations.js';
import { userRoutes } from './routes/users.js';
import { authenticate } from './middleware/auth.js';
import { withTenantScope } from './prisma/client.js';
import { setJwtInstance } from './services/token.service.js';
import { setMailLogger } from './services/mail.service.js';
import { resolveMailSettings, mailDelivery } from './config/mail.js';
import { MAX_UPLOAD_BYTES } from './schemas/shiftReport.schema.js';

/** The placeholder that must never sign a real token. Also the one in `.env.example`. */
const DEV_JWT_SECRET = 'change-me-in-production';

/**
 * The access-token signing secret, refusing to fall back in production.
 *
 * A defaulted secret is not a weak secret, it is a published one: every deployment that
 * took the fallback signs tokens anyone can forge. So production fails at boot rather
 * than starting up in a state where every tenant is readable by anyone who read this
 * repository. Outside production the fallback is kept, because requiring a secret to run
 * a test suite buys nothing.
 */
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && (!secret || secret === DEV_JWT_SECRET)) {
    throw new Error(
      'JWT_SECRET must be set to a non-default value when NODE_ENV=production. Refusing to start.'
    );
  }

  return secret ?? DEV_JWT_SECRET;
}

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  const jwtSecret = resolveJwtSecret();
  await app.register(jwt, { secret: jwtSecret });
  await app.register(cookie);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(helmet);
  // Registered globally but off by default: only the routes that opt in via
  // `config.rateLimit` are limited. A blanket limit would throttle bulk PDF uploads and
  // polling for a parse that is still running, which are legitimate traffic.
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      // A handful of small text fields alongside the file (station id), nothing more.
      fields: 10,
    },
  });

  setJwtInstance(app.jwt);

  /**
   * Mail is configured, not required.
   *
   * Unlike `JWT_SECRET`, a missing transport must not stop the process: it takes out one endpoint,
   * and refusing to boot the station's whole application over it would take the reconciliation
   * screens down with it. So the settings are read once here — which is where a malformed
   * `MAIL_TRANSPORT` surfaces, at boot rather than on the first password reset — the logger is
   * handed over, and a deployment that cannot actually send says so once, loudly, in the log.
   */
  const mailSettings = resolveMailSettings();
  setMailLogger(app.log);

  if (mailDelivery(mailSettings) === 'none') {
    app.log.warn(
      'MAIL_TRANSPORT is "log" and NODE_ENV is production: password reset will answer 503, ' +
        'because a reset link written to a log is not an email anyone receives. Set SMTP_URL.'
    );
  }

  /**
   * One place that decides what a failure looks like on the wire.
   *
   * Without this, Fastify's default handler answers 500 with the raw `error.message` for
   * anything thrown — including a `ZodError`, which is the caller's mistake and not the
   * server's. Every request with a mistyped query parameter would read as a backend fault,
   * which buries the real failures in noise and tells the client nothing it can fix.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'Invalid request.',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      // Logged in full, answered in outline: a 500 response body is read by a browser, and
      // stack traces and Prisma messages belong in the log rather than in the client.
      request.log.error({ err: error }, 'Unhandled error');
      return reply.status(statusCode).send({ error: 'Something went wrong.' });
    }

    // 4xx errors are thrown deliberately, with a message written to be read.
    return reply.status(statusCode).send({ error: error.message });
  });

  app.addHook('onRequest', authenticate);

  // Wrap route handlers to run inside tenant scope automatically
  app.addHook('onRoute', ((routeOptions: RouteOptions) => {
    const originalHandler = routeOptions.handler;
    routeOptions.handler = async function (request, reply) {
      const user = (request as typeof request & { user?: { tenantId?: string } }).user;
      const tenantId = user?.tenantId;
      if (!tenantId) {
        return await originalHandler.call(this, request, reply);
      }
      return withTenantScope(tenantId, () => originalHandler.call(this, request, reply));
    };
  }) as onRouteHookHandler);

  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(shiftReportRoutes, { prefix: '/api' });
  await app.register(dashboardRoutes, { prefix: '/api' });
  await app.register(tankLeakageRoutes, { prefix: '/api' });
  await app.register(attendantProfileRoutes, { prefix: '/api' });
  await app.register(findingsRoutes, { prefix: '/api' });
  await app.register(stationRoutes, { prefix: '/api' });
  await app.register(userRoutes, { prefix: '/api' });

  if (process.env.NODE_ENV !== 'production') {
    const { testRoutes } = await import('./routes/test-routes.js');
    await app.register(testRoutes, { prefix: '/api' });
  }

  return app;
}
