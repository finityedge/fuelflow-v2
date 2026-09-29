import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import type { onRouteHookHandler, RouteOptions } from 'fastify';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { shiftReportRoutes } from './routes/shiftReports.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { stationRoutes } from './routes/stations.js';
import { authenticate } from './middleware/auth.js';
import { withTenantScope } from './prisma/client.js';
import { setJwtInstance } from './services/token.service.js';
import { MAX_UPLOAD_BYTES } from './schemas/shiftReport.schema.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  const jwtSecret = process.env.JWT_SECRET ?? 'change-me-in-production';
  await app.register(jwt, { secret: jwtSecret });
  await app.register(cookie);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(helmet);
  await app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      // A handful of small text fields alongside the file (station id), nothing more.
      fields: 10,
    },
  });

  setJwtInstance(app.jwt);

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
  await app.register(stationRoutes, { prefix: '/api' });

  if (process.env.NODE_ENV !== 'production') {
    const { testRoutes } = await import('./routes/test-routes.js');
    await app.register(testRoutes, { prefix: '/api' });
  }

  return app;
}
