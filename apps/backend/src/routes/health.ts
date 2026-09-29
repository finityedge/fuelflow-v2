import { FastifyInstance } from 'fastify';
import { getHealthStatus } from '../services/health.service.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', { config: { public: true } }, async () => getHealthStatus());
}
