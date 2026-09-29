import { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { UserRole } from '@fuelflow/shared';
import { getRequestUser } from './auth.js';

export function requireRole(allowedRoles: UserRole[]): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = getRequestUser(request);
    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    if (!allowedRoles.includes(user.role)) {
      return reply.status(403).send({ error: 'Forbidden: insufficient role' });
    }
  };
}

/**
 * The station-access check on its own, for routes that cannot use it as a preHandler.
 *
 * A multipart upload is the case that matters: the station ID is one part among several
 * in a stream, so it is not readable from `request.body` when preHandlers run. Such a
 * route buffers its parts first and calls this once the station is known.
 */
export function hasStationAccess(user: { role: UserRole; stationIds: string[] }, stationId: string): boolean {
  if (user.role === UserRole.OWNER) {
    return true;
  }
  return user.stationIds.includes(stationId);
}

export function requireStationAccess(stationIdParam: string = 'stationId'): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = getRequestUser(request);
    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    if (user.role === UserRole.OWNER) {
      return;
    }

    const rawStationId = (request.params as Record<string, string>)?.[stationIdParam];
    const stationId = rawStationId ?? (request.body as { stationId?: string } | undefined)?.stationId;

    if (!stationId) {
      return reply.status(400).send({ error: 'Station ID is required' });
    }

    if (!user.stationIds.includes(stationId)) {
      return reply.status(403).send({ error: 'Forbidden: station access denied' });
    }
  };
}
