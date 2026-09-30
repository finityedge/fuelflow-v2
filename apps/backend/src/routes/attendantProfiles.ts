import type { FastifyInstance } from 'fastify';
import { UserRole } from '@fuelflow/shared';
import { attendantProfilesQuerySchema, myAttendantProfileQuerySchema } from '../schemas/attendantProfile.schema.js';
import { getAttendantProfiles, getMyAttendantProfile } from '../services/attendantProfile.service.js';
import { stationExistsInTenant } from '../services/station.service.js';
import { hasStationAccess, requireRole } from '../middleware/rbac.js';
import { requireRequestUser } from '../middleware/auth.js';

/**
 * Who may read the profiles.
 *
 * Unlike the leakage totals — which are a property of a tank and which the attendant on the
 * forecourt is expected to be asked about — everything on this screen is a statement about a
 * named person, and the list is every colleague's. An attendant reading it would learn what the
 * business suspects of the people they work beside, and a manager is the role the question is
 * actually asked by. The gate is here rather than only in the nav for the usual reason: the nav
 * is a convenience, and the API is the product.
 */
const canReadProfiles = requireRole([UserRole.OWNER, UserRole.MANAGER]);

/**
 * Attendant micro-loss profiling.
 *
 * Its own top-level route rather than something under `/stations/:id`, for the same reason the
 * leakage screen is: an owner with several sites wants the worst person across the group, and
 * the question is asked about the tenant at least as often as about one station.
 *
 * A manager is restricted to their assigned stations here rather than in the query string.
 * These are totals of money attributed to *named individuals* — the most sensitive read in the
 * product — and a wrong answer is not a blank screen, it is an accusation about a person built
 * out of somebody else's shifts.
 */
export async function attendantProfileRoutes(app: FastifyInstance) {
  app.get('/attendants/profiles', { preHandler: canReadProfiles }, async (request, reply) => {
    const user = requireRequestUser(request);
    const query = attendantProfilesQuerySchema.parse(request.query);

    if (query.stationId) {
      /*
       * `hasStationAccess` reads the token alone, so for an owner it answers true for every
       * station id — it knows an owner may see every station but not whose station an id
       * names. Without the existence check a station in another tenant would pass the guard
       * and come back as an empty 200, which reads as "nobody is short there" rather than
       * "that station is not yours". The second lookup is tenant-scoped, so a foreign station
       * is simply absent.
       */
      const permitted =
        hasStationAccess(user, query.stationId) && (await stationExistsInTenant(query.stationId));

      if (!permitted) {
        return reply.status(403).send({ error: 'Forbidden: station access denied' });
      }
    }

    const profiles = await getAttendantProfiles({
      periodDays: query.periodDays,
      stationId: query.stationId,
      restrictToStationIds: user.role === UserRole.OWNER ? undefined : user.stationIds,
    });

    return reply.send(profiles);
  });

  /**
   * One person's own record, for the screen they open rather than the one a manager opens.
   *
   * Open to every signed-in role, and the only read on this file that is. The gate above exists
   * because the profiling *list* is every colleague's; this is the one row of it that is the
   * caller's own. Which row that is comes from `Attendant.userId` — from the record, not from
   * anything the caller sends — so there is no id to guess and no way to ask after somebody
   * else. An owner or a manager asking gets their own answer, which is that they have no
   * attendant record, and that is the honest reply rather than a refusal.
   *
   * A login with no record answers 200 with `linked: false`, not 403. It is not a permission
   * failure: for an attendant it is an account nobody has joined to a name yet, which the screen
   * can say and a manager can fix in station settings. Answering 403 would send them to look for
   * an access problem they do not have.
   */
  app.get('/attendants/me', async (request, reply) => {
    const user = requireRequestUser(request);
    const query = myAttendantProfileQuerySchema.parse(request.query);

    return reply.send(await getMyAttendantProfile(user.id, { periodDays: query.periodDays }));
  });
}
