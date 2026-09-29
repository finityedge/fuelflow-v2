import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';

describe('health routes', () => {
  it('GET /health returns ok', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ status: 'ok' });
  });
});
