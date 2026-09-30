import type { FastifyInstance } from 'fastify';
import { UserRole } from '@fuelflow/shared';
import { findingsQuerySchema } from '../schemas/findings.schema.js';
import { getFindingsSheet } from '../services/findings.service.js';
import { stationExistsInTenant } from '../services/station.service.js';
import { hasStationAccess, requireRole } from '../middleware/rbac.js';
import { requireRequestUser } from '../middleware/auth.js';

/**
 * Who may produce a sheet at all.
 *
 * The second deliberate role gate in the product, and a stronger one than the attendants
 * screen's. `hasStationAccess` would happily let an attendant produce one for the station they
 * are posted to — which is the correct answer for a total that belongs to a tank, and the wrong
 * one here. This sheet names people, attributes money to them, and is built to be printed and
 * handed over. An attendant being assigned to the station is not consent to be given a document
 * about the people working beside them.
 */
const canProduceSheet = requireRole([UserRole.OWNER, UserRole.MANAGER]);

/**
 * The free-audit findings sheet.
 *
 * A manager may produce one for a station they are assigned to; an owner for any station in
 * their tenant. The gate is the same pair the dashboard, leakage and attendant routes use, and
 * it has to be here rather than in the service for the same reason: the sheet carries the money,
 * the fuel and the named people all at once, so it is the most sensitive read in the product
 * and the one where a wrong answer would be printed and handed to somebody.
 *
 * `hasStationAccess` alone cannot do it — it answers from the token, so for an owner it says yes
 * to every id including one belonging to another tenant. The tenant-scoped existence check is
 * what turns that into a 403 rather than a sheet with a plausible-looking station name and
 * nothing in it.
 */
export async function findingsRoutes(app: FastifyInstance) {
  app.get('/findings', { preHandler: canProduceSheet }, async (request, reply) => {
    const user = requireRequestUser(request);
    const query = findingsQuerySchema.parse(request.query);

    const permitted =
      hasStationAccess(user, query.stationId) && (await stationExistsInTenant(query.stationId));

    if (!permitted) {
      return reply.status(403).send({ error: 'Forbidden: station access denied' });
    }

    const sheet = await getFindingsSheet({
      stationId: query.stationId,
      periodDays: query.periodDays,
    });

    return reply.send(sheet);
  });
}
