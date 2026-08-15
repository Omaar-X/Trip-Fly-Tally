import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { ROLE } from '../src/constants/roles';
import { authHeader } from './helpers/token';

/**
 * These assert the 401/403 *boundary* only. The `allow()` middleware runs
 * before any controller/service/DB code, so a rejection here never touches
 * the database — no mocking needed. The 200 "allowed" side of each of these
 * routes is covered per-module in the other test files (with the service
 * layer mocked).
 */
describe('RBAC boundary on real routes', () => {
  it('rejects unauthenticated requests to a protected route', async () => {
    const res = await request(app).get('/api/admin/database/tables');
    expect(res.status).toBe(401);
  });

  it('CEO-only admin database tools reject ADMIN', async () => {
    const res = await request(app).get('/api/admin/database/tables').set(authHeader(ROLE.ADMIN));
    expect(res.status).toBe(403);
  });

  it('CEO-only admin database tools reject ACCOUNTANT and SALES too', async () => {
    for (const role of [ROLE.ACCOUNTANT, ROLE.SALES, ROLE.HR] as const) {
      const res = await request(app).get('/api/admin/database/tables').set(authHeader(role));
      expect(res.status).toBe(403);
    }
  });

  it('voucher creation rejects SALES and ADMIN (Accountant-exclusive)', async () => {
    for (const role of [ROLE.SALES, ROLE.ADMIN] as const) {
      const res = await request(app).post('/api/vouchers').set(authHeader(role)).send({});
      expect(res.status).toBe(403);
    }
  });

  it('payroll approval rejects ADMIN and HR (CEO-only final approval)', async () => {
    for (const role of [ROLE.ADMIN, ROLE.HR] as const) {
      const res = await request(app).post('/api/hr/payroll/1/approve').set(authHeader(role)).send({});
      expect(res.status).toBe(403);
    }
  });

  it('company settings update rejects everyone but CEO', async () => {
    for (const role of [ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES, ROLE.HR] as const) {
      const res = await request(app).put('/api/company-settings').set(authHeader(role)).send({ name: 'X' });
      expect(res.status).toBe(403);
    }
  });

  it('HR employee routes reject SALES and ACCOUNTANT', async () => {
    for (const role of [ROLE.SALES, ROLE.ACCOUNTANT] as const) {
      const res = await request(app).get('/api/hr/employees').set(authHeader(role));
      expect(res.status).toBe(403);
    }
  });
});
