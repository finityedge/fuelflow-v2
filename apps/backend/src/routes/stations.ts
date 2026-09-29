import type { FastifyInstance } from 'fastify';
import { UserRole } from '@fuelflow/shared';
import { prisma } from '../prisma/client.js';
import { requireRequestUser } from '../middleware/auth.js';

/**
 * The stations this user may upload against.
 *
 * Scoped to the caller rather than to the tenant: a manager assigned to one station
 * should be offered that station, not a picker full of sites they cannot act on.
 */
export async function stationRoutes(app: FastifyInstance) {
  app.get('/stations', async (request, reply) => {
    const user = requireRequestUser(request);

    const stations = await prisma.station.findMany({
      where: user.role === UserRole.OWNER ? undefined : { id: { in: user.stationIds } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, location: true },
    });

    return reply.send({ stations });
  });
}
