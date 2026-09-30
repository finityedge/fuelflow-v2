import type { FastifyInstance } from 'fastify';
import { UserRole } from '@fuelflow/shared';
import {
  createUserBodySchema,
  listUsersQuerySchema,
  updateUserBodySchema,
} from '../schemas/user.schema.js';
import { createUser, listUsers, updateUser } from '../services/user.service.js';
import { requireRole } from '../middleware/rbac.js';
import { requireRequestUser } from '../middleware/auth.js';

/**
 * Who may add people to the tenant.
 *
 * Owners only. A manager runs a station; staffing the organisation is a different job, and
 * the one that decides who has access at all.
 */
const canProvision = requireRole([UserRole.OWNER]);

/**
 * Who may see the roster.
 *
 * Managers are included because running a shift means knowing who is on it, but they only
 * see people assigned to their own stations (see the handler) — the full staff list of the
 * company is not a manager's to browse.
 */
const canViewRoster = requireRole([UserRole.OWNER, UserRole.MANAGER]);

export async function userRoutes(app: FastifyInstance) {
  app.get('/users', { preHandler: canViewRoster }, async (request, reply) => {
    const user = requireRequestUser(request);
    const query = listUsersQuerySchema.parse(request.query);

    const users = await listUsers({
      includeInactive: query.includeInactive ?? false,
      withinStationIds: user.role === UserRole.OWNER ? undefined : user.stationIds,
    });

    return reply.send({ users });
  });

  app.post('/users', { preHandler: canProvision }, async (request, reply) => {
    const actor = requireRequestUser(request);
    const body = createUserBodySchema.parse(request.body);
    const user = await createUser(actor.tenantId, body);

    return reply.status(201).send({ user });
  });

  app.patch('/users/:id', { preHandler: canProvision }, async (request, reply) => {
    const actor = requireRequestUser(request);
    const { id } = request.params as { id: string };
    const body = updateUserBodySchema.parse(request.body);

    const user = await updateUser(id, body, actor);

    return reply.send({ user });
  });
}
