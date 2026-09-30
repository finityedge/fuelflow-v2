import type { FastifyInstance } from 'fastify';
import { UserRole } from '@fuelflow/shared';
import { tankLeakageQuerySchema } from '../schemas/tankLeakage.schema.js';
import { getTankLeakage } from '../services/tankLeakage.service.js';
import { stationExistsInTenant } from '../services/station.service.js';
import { hasStationAccess } from '../middleware/rbac.js';
import { requireRequestUser } from '../middleware/auth.js';

/**
 * Wet-stock leakage.
 *
 * Its own route rather than a station sub-resource, because the question it answers — which
 * tank is losing fuel — is asked across every station at once as often as about one. An owner
 * with three sites wants the worst tank in the group, and a per-station path would force the
 * client to make three calls and sort them.
 *
 * A manager sees only their assigned stations, enforced here rather than trusted to the query
 * string: these totals are the litres a station is losing, which is the same class of
 * information as the money totals the dashboard guards the same way.
 */
export async function tankLeakageRoutes(app: FastifyInstance) {
  app.get('/tanks/leakage', async (request, reply) => {
    const user = requireRequestUser(request);
    const query = tankLeakageQuerySchema.parse(request.query);

    if (query.stationId) {
      /*
       * Two questions, and the second is the one `hasStationAccess` cannot answer: it works
       * from the token alone, so it returns true for every station id when the caller is an
       * owner — it knows an owner may see every station but not whose station an id names.
       * Without the existence check, a station in another tenant passed the guard and came
       * back as an empty 200, which reads as "this station has no leaks" rather than "this
       * station is not yours". The lookup is tenant-scoped, so a foreign station is absent.
       */
      const permitted =
        hasStationAccess(user, query.stationId) && (await stationExistsInTenant(query.stationId));

      if (!permitted) {
        return reply.status(403).send({ error: 'Forbidden: station access denied' });
      }
    }

    const leakage = await getTankLeakage({
      periodDays: query.periodDays,
      stationId: query.stationId,
      restrictToStationIds: user.role === UserRole.OWNER ? undefined : user.stationIds,
    });

    return reply.send(leakage);
  });
}
