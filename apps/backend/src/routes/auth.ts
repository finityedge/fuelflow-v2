import { FastifyInstance } from 'fastify';
import { login, refreshAccessToken, registerTenantAndOwner } from '../services/auth.service.js';
import {
  loginBodySchema,
  refreshBodySchema,
  registerBodySchema,
} from '../schemas/auth.schema.js';
import {
  getRefreshCookieOptions,
  revokeRefreshToken,
  verifyRefreshToken,
} from '../services/token.service.js';

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/register',
    {
      config: { public: true },
    },
    async (request, reply) => {
      const body = registerBodySchema.parse(request.body);
      const result = await registerTenantAndOwner(body);

      void reply.setCookie('refreshToken', result.refreshToken, getRefreshCookieOptions());
      return reply.status(201).send({
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      });
    }
  );

  app.post(
    '/login',
    {
      config: { public: true },
    },
    async (request, reply) => {
      const body = loginBodySchema.parse(request.body);
      const result = await login(body);

      if (!result) {
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      void reply.setCookie('refreshToken', result.refreshToken, getRefreshCookieOptions());
      return reply.send({
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      });
    }
  );

  app.post(
    '/refresh',
    {
      config: { public: true },
    },
    async (request, reply) => {
      const body = refreshBodySchema.parse(request.body);
      let payload;
      try {
        payload = await verifyRefreshToken(body.refreshToken);
      } catch {
        return reply.status(401).send({ error: 'Invalid refresh token' });
      }

      const result = await refreshAccessToken(payload.sub);
      if (!result) {
        return reply.status(401).send({ error: 'User not found' });
      }

      return reply.send({
        user: result.user,
        accessToken: result.accessToken,
      });
    }
  );

  app.post(
    '/logout',
    {
      config: { public: true },
    },
    async (request, reply) => {
      const body = refreshBodySchema.safeParse(request.body);
      if (body.success) {
        try {
          const payload = await verifyRefreshToken(body.data.refreshToken);
          await revokeRefreshToken(payload.sub);
        } catch {
          // ignore invalid token on logout
        }
      }

      void reply.clearCookie('refreshToken');
      return reply.send({ status: 'ok' });
    }
  );
}
