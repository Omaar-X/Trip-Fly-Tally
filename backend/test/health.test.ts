import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { env } from '../src/config/env';

describe('GET /api/health', () => {
  it('reports ok status with a generic, configurable service id', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: `${env.appSlug}-api` });
    // Regression guard: the old hardcoded "tripfly-erp-api" identifier must be gone.
    expect(res.body.service).not.toContain('tripfly');
  });
});
