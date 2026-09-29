import { Redis } from 'ioredis';

export function createRedisConnection() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  return new Redis(url, { maxRetriesPerRequest: null });
}
