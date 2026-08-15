import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/modules/hr/hr.service', () => ({
  hrService: {
    listEmployees: vi.fn(), createEmployee: vi.fn(), updateEmployee: vi.fn(),
    listRuns: vi.fn(), runDetail: vi.fn(), generateRun: vi.fn(),
    approveRun: vi.fn(), payRun: vi.fn(),
  },
}));

import { app } from '../src/app';
import { hrService } from '../src/modules/hr/hr.service';
import { ROLE } from '../src/constants/roles';
import { authHeader } from './helpers/token';
import { ApiError } from '../src/utils/ApiError';

describe('Payroll approval workflow (DRAFT -> APPROVED)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('CEO can approve a draft payroll run', async () => {
    vi.mocked(hrService.approveRun).mockResolvedValue({
      runId: 1, status: 'APPROVED', voucherNo: 'JV-2026-0001', total: 50000,
    } as any);

    const res = await request(app).post('/api/hr/payroll/1/approve').set(authHeader(ROLE.CEO)).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
    expect(hrService.approveRun).toHaveBeenCalledOnce();
  });

  it('ADMIN and HR are rejected before the service runs (only Admin can generate/pay, only CEO approves)', async () => {
    for (const role of [ROLE.ADMIN, ROLE.HR] as const) {
      const res = await request(app).post('/api/hr/payroll/1/approve').set(authHeader(role)).send({});
      expect(res.status).toBe(403);
    }
    expect(hrService.approveRun).not.toHaveBeenCalled();
  });

  it('re-approving an already-approved run surfaces the service conflict as 409', async () => {
    vi.mocked(hrService.approveRun).mockRejectedValue(ApiError.conflict('Run is already APPROVED'));

    const res = await request(app).post('/api/hr/payroll/1/approve').set(authHeader(ROLE.CEO)).send({});

    expect(res.status).toBe(409);
  });
});
