import type { FastifyInstance } from 'fastify';
import { UserRole } from '@fuelflow/shared';
import {
  createAttendantBodySchema,
  createStationBodySchema,
  createTankBodySchema,
  listStationsQuerySchema,
  updateAttendantBodySchema,
  updateStationBodySchema,
  updateTankBodySchema,
} from '../schemas/station.schema.js';
import {
  createAttendant,
  createStation,
  createTank,
  getStationDetail,
  linkAttendantAlias,
  listStations,
  unlinkAttendantAlias,
  updateAttendant,
  updateStation,
  updateTank,
} from '../services/station.service.js';
import { linkAttendantAliasBodySchema } from '../schemas/attendantProfile.schema.js';
import { requireRole, requireStationAccess } from '../middleware/rbac.js';
import { requireRequestUser } from '../middleware/auth.js';

/** Creating and retiring a station is the owner's call — it changes what the tenant is. */
const canAdministerStation = requireRole([UserRole.OWNER]);

/**
 * Filling in a station's tanks and attendants is station management, which a manager does for
 * the sites they run. `requireStationAccess('id')` narrows it further: a manager can only
 * touch a station they are assigned to, and an owner passes that check for any of their own.
 */
const canManageStationContents = [
  requireRole([UserRole.OWNER, UserRole.MANAGER]),
  requireStationAccess('id'),
];

export async function stationRoutes(app: FastifyInstance) {
  /**
   * The stations this user may act on.
   *
   * Scoped to the caller rather than to the tenant: a manager assigned to one station
   * should be offered that station, not a picker full of sites they cannot act on.
   */
  app.get('/stations', async (request, reply) => {
    const user = requireRequestUser(request);
    const query = listStationsQuerySchema.parse(request.query);

    const stations = await listStations(user, { includeInactive: query.includeInactive ?? false });

    return reply.send({ stations });
  });

  app.post('/stations', { preHandler: canAdministerStation }, async (request, reply) => {
    const user = requireRequestUser(request);
    const body = createStationBodySchema.parse(request.body);

    const station = await createStation(user.tenantId, body);

    return reply.status(201).send({ station });
  });

  /**
   * Everything the settings screen needs for one station: the station itself, its tanks, the
   * people named on its reports, and the logins that can reach it.
   */
  app.get('/stations/:id', { preHandler: requireStationAccess('id') }, async (request, reply) => {
    const { id } = request.params as { id: string };

    return reply.send(await getStationDetail(id));
  });

  app.patch('/stations/:id', { preHandler: canAdministerStation }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateStationBodySchema.parse(request.body);

    const station = await updateStation(id, body);

    return reply.send({ station });
  });

  app.post(
    '/stations/:id/tanks',
    { preHandler: canManageStationContents },
    async (request, reply) => {
      const user = requireRequestUser(request);
      const { id } = request.params as { id: string };
      const body = createTankBodySchema.parse(request.body);

      const tank = await createTank(user.tenantId, id, body);

      return reply.status(201).send({ tank });
    }
  );

  app.patch(
    '/stations/:id/tanks/:tankId',
    { preHandler: canManageStationContents },
    async (request, reply) => {
      const { id, tankId } = request.params as { id: string; tankId: string };
      const body = updateTankBodySchema.parse(request.body);

      const tank = await updateTank(id, tankId, body);

      return reply.send({ tank });
    }
  );

  app.post(
    '/stations/:id/attendants',
    { preHandler: canManageStationContents },
    async (request, reply) => {
      const user = requireRequestUser(request);
      const { id } = request.params as { id: string };
      const body = createAttendantBodySchema.parse(request.body);

      const attendant = await createAttendant(user.tenantId, id, body);

      return reply.status(201).send({ attendant });
    }
  );

  app.patch(
    '/stations/:id/attendants/:attendantId',
    { preHandler: canManageStationContents },
    async (request, reply) => {
      const { id, attendantId } = request.params as { id: string; attendantId: string };
      const body = updateAttendantBodySchema.parse(request.body);

      const attendant = await updateAttendant(id, attendantId, body);

      return reply.send({ attendant });
    }
  );

  /**
   * Join another spelling of a name to an attendant.
   *
   * Under the same guard as the rest of a station's contents: an alias changes whose shift
   * history a run of shortfalls is attributed to, which is a station-management decision and
   * not one a report uploader makes in passing.
   */
  app.post(
    '/stations/:id/attendants/:attendantId/aliases',
    { preHandler: canManageStationContents },
    async (request, reply) => {
      const user = requireRequestUser(request);
      const { id, attendantId } = request.params as { id: string; attendantId: string };
      const body = linkAttendantAliasBodySchema.parse(request.body);

      const attendant = await linkAttendantAlias(user.tenantId, id, attendantId, body);

      return reply.status(201).send({ attendant });
    }
  );

  /**
   * Let go of a spelling.
   *
   * The key itself is the address rather than a row id, because that is what both callers
   * hold: the unmapped list on the profiling screen shows the parser's key, and a settings
   * form types the name the key is derived from. Neither ever sees the alias row's id.
   */
  app.delete(
    '/stations/:id/attendants/:attendantId/aliases/:slug',
    { preHandler: canManageStationContents },
    async (request, reply) => {
      const { id, attendantId, slug } = request.params as {
        id: string;
        attendantId: string;
        slug: string;
      };

      const attendant = await unlinkAttendantAlias(id, attendantId, decodeURIComponent(slug));

      return reply.send({ attendant });
    }
  );
}
