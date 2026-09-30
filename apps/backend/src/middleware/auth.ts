import { FastifyReply, FastifyRequest } from 'fastify';
import { UserRole } from '@fuelflow/shared';
import { prisma } from '../prisma/client.js';
import { verifyAccessToken } from '../services/token.service.js';

/** The authenticated caller, as the `authenticate` hook attaches it to the request. */
export interface RequestUser {
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  stationIds: string[];
}

/**
 * Read the authenticated user off a request.
 *
 * Deliberately an explicit accessor rather than an interface augmentation of
 * `FastifyRequest`: `@fastify/jwt` already declares `user` on that interface (as
 * `string | object | Buffer`), and its declaration takes precedence over a local one, so
 * an augmentation silently types `request.user` as something unusable. One cast here is
 * clearer than a declaration that does not take effect.
 */
export function getRequestUser(request: FastifyRequest): RequestUser | undefined {
  return (request as FastifyRequest & { user?: RequestUser }).user;
}

/**
 * The same, for routes behind the `authenticate` hook, where the user is guaranteed.
 *
 * The thrown error carries a status code rather than a message shape so Fastify's own
 * error handling answers 401 — a route that somehow runs without the hook fails closed.
 */
export function requireRequestUser(request: FastifyRequest): RequestUser {
  const user = getRequestUser(request);
  if (!user) {
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  }
  return user;
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const routeConfig = request.routeOptions.config as { public?: boolean } | undefined;
  if (routeConfig?.public) {
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.slice(7);
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired access token' });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { stationAssignments: { select: { stationId: true } } },
  });

  if (!user) {
    return reply.status(401).send({ error: 'User not found' });
  }

  // A deactivated user's access token stays cryptographically valid until it expires, so the
  // flag has to be re-read on every request rather than trusted from the token. This lookup
  // was already here for the role and station list; refusing here is what makes deactivation
  // take effect immediately instead of in fifteen minutes.
  if (!user.isActive) {
    return reply.status(401).send({ error: 'This account has been deactivated' });
  }

  (request as FastifyRequest & { user: RequestUser }).user = {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role as UserRole,
    stationIds: user.stationAssignments.map((a) => a.stationId),
  };
}
