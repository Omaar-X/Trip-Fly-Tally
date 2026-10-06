import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/modules/approvals/approvals.service', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/approvals/approvals.service')>(
    '../src/modules/approvals/approvals.service');
  return {
    ...actual,
    loadActor: vi.fn(async (_c: number, u: { id: number; role: string }) => ({
      id: u.id, role: u.role, canReviewAsAdmin: grants.review, canApproveBdr: grants.bdr,
    })),
    approvalsService: {
      createChangeRequest: vi.fn(), listChangeRequests: vi.fn(), getChangeRequest: vi.fn(),
      comments: vi.fn(), versions: vi.fn(), recommend: vi.fn(), decide: vi.fn(),
      resubmit: vi.fn(), cancel: vi.fn(), addComment: vi.fn(), restore: vi.fn(),
      createBdr: vi.fn(), listBdr: vi.fn(), approveBdr: vi.fn(), rejectBdr: vi.fn(),
      cancelBdr: vi.fn(), revokeBdr: vi.fn(),
      grantAdminAuthority: vi.fn(), revokeAdminAuthority: vi.fn(), listAdminGrants: vi.fn(),
    },
  };
});

vi.mock('../src/modules/migration/migration.service', () => ({
  migrationService: {
    createBatch: vi.fn(), listBatches: vi.fn(), getBatch: vi.fn(), reconciliation: vi.fn(),
    rollbackBatch: vi.fn(), reconcile: vi.fn(), finalizeMonth: vi.fn(),
    listReviewItems: vi.fn(), resolveReviewItem: vi.fn(), sourceRows: vi.fn(),
    recordOutstandingAdjustment: vi.fn(),
  },
}));

import { app } from '../src/app';
import { approvalsService } from '../src/modules/approvals/approvals.service';
import { migrationService } from '../src/modules/migration/migration.service';
import { ROLE } from '../src/constants/roles';
import { authHeader } from './helpers/token';

/** Mutated per test to stand in for the CEO's grants. */
const grants = { review: false, bdr: false };

const svc = vi.mocked(approvalsService);
const mig = vi.mocked(migrationService);

beforeEach(() => {
  vi.clearAllMocks();
  grants.review = false;
  grants.bdr = false;
  svc.createChangeRequest.mockResolvedValue({ id: 1, requestNo: 'EDT-2026-00001' } as never);
  svc.decide.mockResolvedValue({ status: 'APPROVED' } as never);
  svc.createBdr.mockResolvedValue({ id: 2, requestNo: 'BDR-2026-00001' } as never);
  svc.approveBdr.mockResolvedValue({ status: 'APPROVED' } as never);
  svc.listChangeRequests.mockResolvedValue([] as never);
  svc.listBdr.mockResolvedValue([] as never);
  mig.listBatches.mockResolvedValue([] as never);
  mig.createBatch.mockResolvedValue({ id: 1, batchNo: 'MIG-2026-00001' } as never);
  mig.finalizeMonth.mockResolvedValue({ verified: true, unresolved: 0 } as never);
  mig.rollbackBatch.mockResolvedValue({ removed: 3 } as never);
});

const post = (path: string, role: string, body: unknown = {}) =>
  request(app).post(path).set(authHeader(role as never)).send(body);

// ───────────────────────────── change requests ──────────────────────────────

describe('POST /api/approvals/change-requests', () => {
  const body = {
    kind: 'EDIT', entity: 'vouchers', entityId: 5,
    reason: 'Wrong ledger picked on entry.', proposedValues: { narration: 'fixed' },
  };

  it.each([ROLE.ACCOUNTANT, ROLE.SALES, ROLE.ADMIN])('lets %s raise one', async (role) => {
    const res = await post('/api/approvals/change-requests', role, body);
    expect(res.status).toBe(201);
    expect(res.body.data.requestNo).toBe('EDT-2026-00001');
  });

  it('refuses HR', async () => {
    expect((await post('/api/approvals/change-requests', ROLE.HR, body)).status).toBe(403);
  });

  it('needs a reason', async () => {
    const res = await post('/api/approvals/change-requests', ROLE.ACCOUNTANT, { ...body, reason: '' });
    expect(res.status).toBe(400);
  });

  it('refuses an entity that is not a transaction table', async () => {
    const res = await post('/api/approvals/change-requests', ROLE.ACCOUNTANT, { ...body, entity: 'users' });
    expect(res.status).toBe(400);
  });

  it('needs a session', async () => {
    expect((await request(app).post('/api/approvals/change-requests').send(body)).status).toBe(401);
  });
});

describe('deciding a change request is the CEO’s alone', () => {
  it('lets the CEO approve', async () => {
    const res = await post('/api/approvals/change-requests/1/decide', ROLE.CEO, { action: 'APPROVE' });
    expect(res.status).toBe(200);
    expect(svc.decide).toHaveBeenCalledWith(expect.any(Number), expect.anything(), 1, 'APPROVE',
      expect.objectContaining({ action: 'APPROVE' }));
  });

  it.each([ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES])('refuses %s at the route', async (role) => {
    expect((await post('/api/approvals/change-requests/1/decide', role, { action: 'APPROVE' })).status)
      .toBe(403);
  });

  it('rejects an action outside approve/reject/needs-correction', async () => {
    const res = await post('/api/approvals/change-requests/1/decide', ROLE.CEO, { action: 'DELETE_IT' });
    expect(res.status).toBe(400);
  });
});

describe('admin recommendation', () => {
  it('is open to Admin at the route — the grant is checked in the service', async () => {
    svc.recommend.mockResolvedValue({ status: 'ADMIN_REVIEWED' } as never);
    const res = await post('/api/approvals/change-requests/1/recommend', ROLE.ADMIN,
      { recommendation: 'APPROVE' });
    expect(res.status).toBe(200);
  });

  it('is closed to Accountant and Sales', async () => {
    for (const role of [ROLE.ACCOUNTANT, ROLE.SALES])
      expect((await post('/api/approvals/change-requests/1/recommend', role,
        { recommendation: 'APPROVE' })).status).toBe(403);
  });
});

describe('restore is CEO only', () => {
  it('lets the CEO restore', async () => {
    svc.restore.mockResolvedValue({ restored: true } as never);
    const res = await post('/api/approvals/restore', ROLE.CEO, { entity: 'payments', entityId: 4 });
    expect(res.status).toBe(200);
  });

  it('refuses everyone else', async () => {
    for (const role of [ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES])
      expect((await post('/api/approvals/restore', role, { entity: 'payments', entityId: 4 })).status)
        .toBe(403);
  });
});

// ────────────────────────────────── BDR ─────────────────────────────────────

describe('POST /api/approvals/bdr', () => {
  const body = { module: 'PAYMENT', from: '2026-08-01', to: '2026-08-10', reason: 'Catching up receipts.' };

  it('lets an Accountant raise one', async () => {
    const res = await post('/api/approvals/bdr', ROLE.ACCOUNTANT, body);
    expect(res.status).toBe(201);
    expect(res.body.data.requestNo).toBe('BDR-2026-00001');
  });

  it('refuses HR', async () => {
    expect((await post('/api/approvals/bdr', ROLE.HR, body)).status).toBe(403);
  });

  it('rejects a module outside the list', async () => {
    expect((await post('/api/approvals/bdr', ROLE.ACCOUNTANT, { ...body, module: 'EVERYTHING' })).status)
      .toBe(400);
  });

  it('rejects a malformed date', async () => {
    expect((await post('/api/approvals/bdr', ROLE.ACCOUNTANT, { ...body, from: '01-08-2026' })).status)
      .toBe(400);
  });
});

describe('BDR approval reaches Admin as well as the CEO', () => {
  it('lets the CEO approve', async () => {
    expect((await post('/api/approvals/bdr/2/approve', ROLE.CEO, {})).status).toBe(200);
  });

  it('lets an Admin reach the handler — authority is checked in the service', async () => {
    // Unlike edit/delete, an authorised Admin's BDR approval is final, so the
    // route cannot be CEO-only.
    expect((await post('/api/approvals/bdr/2/approve', ROLE.ADMIN, {})).status).toBe(200);
  });

  it('keeps Accountant and Sales out', async () => {
    for (const role of [ROLE.ACCOUNTANT, ROLE.SALES])
      expect((await post('/api/approvals/bdr/2/approve', role, {})).status).toBe(403);
  });

  it('passes a narrowed range through to the service', async () => {
    await post('/api/approvals/bdr/2/approve', ROLE.CEO, { from: '2026-08-05', to: '2026-08-08' });
    expect(svc.approveBdr).toHaveBeenCalledWith(expect.any(Number), expect.anything(), 2,
      expect.objectContaining({ from: '2026-08-05', to: '2026-08-08' }));
  });

  it('requires a reason to revoke', async () => {
    expect((await post('/api/approvals/bdr/2/revoke', ROLE.CEO, {})).status).toBe(400);
  });

  it('requires a reason to cancel', async () => {
    expect((await post('/api/approvals/bdr/2/cancel', ROLE.ACCOUNTANT, {})).status).toBe(400);
  });
});

// ──────────────────────── admin approval authority ──────────────────────────

describe('granting admin approval authority is CEO only', () => {
  it('lets the CEO grant it', async () => {
    svc.grantAdminAuthority.mockResolvedValue({ id: 1 } as never);
    const res = await post('/api/approvals/admin-grants', ROLE.CEO,
      { userId: 2, scope: 'BDR_APPROVE' });
    expect(res.status).toBe(201);
  });

  it('refuses an Admin granting it to themselves', async () => {
    expect((await post('/api/approvals/admin-grants', ROLE.ADMIN,
      { userId: 2, scope: 'BDR_APPROVE' })).status).toBe(403);
  });

  it('rejects an unknown scope', async () => {
    expect((await post('/api/approvals/admin-grants', ROLE.CEO,
      { userId: 2, scope: 'EVERYTHING' })).status).toBe(400);
  });
});

// ─────────────────────────── migration routes ───────────────────────────────

describe('migration engine routes', () => {
  it('lets an Admin open a batch', async () => {
    const res = await post('/api/migration/batches', ROLE.ADMIN, { period: '2024-12' });
    expect(res.status).toBe(201);
  });

  it('rejects a period that is not YYYY-MM', async () => {
    expect((await post('/api/migration/batches', ROLE.ADMIN, { period: 'Dec 2024' })).status).toBe(400);
  });

  it('keeps Sales out of the engine entirely', async () => {
    expect((await request(app).get('/api/migration/batches').set(authHeader(ROLE.SALES))).status)
      .toBe(403);
  });

  it('reserves rollback for the CEO', async () => {
    expect((await post('/api/migration/batches/1/rollback', ROLE.CEO, {})).status).toBe(200);
    expect((await post('/api/migration/batches/1/rollback', ROLE.ADMIN, {})).status).toBe(403);
  });

  it('reserves closing a month for the CEO', async () => {
    expect((await post('/api/migration/batches/1/finalize', ROLE.CEO, { reason: 'ok' })).status).toBe(200);
    expect((await post('/api/migration/batches/1/finalize', ROLE.ADMIN, { reason: 'ok' })).status).toBe(403);
  });

  it('reserves outstanding adjustments for the CEO', async () => {
    const body = {
      batchId: 1, partyType: 'CUSTOMER', partyId: 2, controlAmount: 10, calculatedAmount: 9,
      controlSource: 'OUTSTANDING Oct-24 (16)',
      investigation: 'Searched receipts and duplicates across Oct and Nov.',
      reason: 'Unexplained.',
    };
    mig.recordOutstandingAdjustment.mockResolvedValue({ id: 1 } as never);
    expect((await post('/api/migration/adjustments', ROLE.CEO, body)).status).toBe(201);
    expect((await post('/api/migration/adjustments', ROLE.ADMIN, body)).status).toBe(403);
  });

  it('will not record an adjustment without a written investigation', async () => {
    const res = await post('/api/migration/adjustments', ROLE.CEO, {
      batchId: 1, partyType: 'CUSTOMER', partyId: 2, controlAmount: 10, calculatedAmount: 9,
      controlSource: 'x'.repeat(5), investigation: 'short', reason: 'Unexplained.',
    });
    expect(res.status).toBe(400);
  });

  it('lets an Accountant work the review queue', async () => {
    mig.listReviewItems.mockResolvedValue([] as never);
    expect((await request(app).get('/api/migration/review-items').set(authHeader(ROLE.ACCOUNTANT))).status)
      .toBe(200);
  });

  it('will not close a review item without a resolution', async () => {
    expect((await post('/api/migration/review-items/1/resolve', ROLE.ACCOUNTANT,
      { status: 'RESOLVED' })).status).toBe(400);
  });
});
