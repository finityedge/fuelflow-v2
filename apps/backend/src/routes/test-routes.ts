import { FastifyInstance } from 'fastify';
import { UserRole } from '@fuelflow/shared';
import { requireRole, requireStationAccess } from '../middleware/rbac.js';

/**
 * Scaffolding endpoints used to exercise the auth and RBAC middleware.
 *
 * `GET /shift-reports` used to live here as a placeholder returning every report
 * unscoped. It is now served by the real route in `shiftReports.ts`, which is
 * tenant-scoped and checks station access — so the placeholder is gone and the
 * cross-tenant test in `protected.test.ts` exercises the real thing.
 */
export async function testRoutes(app: FastifyInstance) {
  app.get('/protected-test', async (request) => {
    return { user: request.user };
  });

  app.post(
    '/upload',
    { preHandler: [requireRole([UserRole.OWNER, UserRole.MANAGER]), requireStationAccess()] },
    async () => {
      return { status: 'uploaded' };
    }
  );

  app.post(
    '/correct',
    { preHandler: [requireRole([UserRole.OWNER, UserRole.MANAGER])] },
    async () => {
      return { status: 'corrected' };
    }
  );

  app.get('/admin-only', { preHandler: requireRole([UserRole.OWNER]) }, async () => {
    return { status: 'ok' };
  });
}
