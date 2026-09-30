import type { FastifyInstance } from 'fastify';
import { UserRole } from '@fuelflow/shared';
import { dashboardQuerySchema } from '../schemas/dashboard.schema.js';
import { getDashboardSummary } from '../services/dashboard.service.js';
import { stationExistsInTenant } from '../services/station.service.js';
import { hasStationAccess } from '../middleware/rbac.js';
import { requireRequestUser } from '../middleware/auth.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', async (request, reply) => {
    const user = requireRequestUser(request);
    const query = dashboardQuerySchema.parse(request.query);

    if (query.stationId) {
      // `hasStationAccess` alone answers from the token, and says yes to every station id for
      // an owner — it cannot know whose station an id names. The tenant-scoped existence check
      // is what stops a foreign station id returning an empty 200 that reads as a clean month.
      const permitted =
        hasStationAccess(user, query.stationId) && (await stationExistsInTenant(query.stationId));

      if (!permitted) {
        return reply.status(403).send({ error: 'Forbidden: station access denied' });
      }
    }

    const summary = await getDashboardSummary({
      periodDays: query.periodDays,
      stationId: query.stationId,
      // An owner sees every station in the tenant; everyone else sees only the stations
      // they are assigned to. Enforced here rather than trusted to the query string, for
      // the same reason the report list does it: the totals are money.
      restrictToStationIds: user.role === UserRole.OWNER ? undefined : user.stationIds,
    });

    return reply.send(summary);
  });
}
