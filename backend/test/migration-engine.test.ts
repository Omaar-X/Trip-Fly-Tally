import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The engine's guarantees are about what it does to a database, so the database
 * is mocked at the module boundary and the real service logic runs on top:
 * every statement it issues is observable, and `withTransaction` behaves like
 * the real one — the callback either commits or the error propagates.
 */
const conn = { query: vi.fn() };

vi.mock('../src/config/db', () => ({
  query: vi.fn(),
  exec: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(conn)),
  pool: { end: vi.fn() },
}));

vi.mock('../src/utils/numbering', () => ({
  nextRequestNo: vi.fn(async () => 'MIG-2026-00001'),
}));

import { migrationService, StagedRow } from '../src/modules/migration/migration.service';
import { query, exec, withTransaction } from '../src/config/db';

const mockQuery = vi.mocked(query);
const mockExec = vi.mocked(exec);

const BATCH = {
  id: 5, company_id: 1, source_period: '2024-12', status: 'COMPLETED',
  data_completeness: 'REVIEW_REQUIRED', reconciliation_status: 'MISMATCHED', completeness_note: null,
};

const row = (over: Partial<StagedRow> = {}): StagedRow => ({
  sourceFile: 'SALES DECEMBER-24.xlsx', sourceSheet: 'Sales DEC-24', sourceRow: 3,
  sourcePeriod: '2024-12', ticketNo: '2326208162472', date: '2024-12-02', amount: 64870,
  party: 'SUN PHARMA', serviceCategory: 'AIR_TICKET',
  classification: { type: 'CUSTOMER', name: 'SUN PHARMA' },
  ...over,
});

/** `query` is used for the batch lookup and for counts; default to a live batch. */
const givenBatch = (over: Record<string, unknown> = {}) =>
  mockQuery.mockResolvedValue([{ ...BATCH, ...over }] as never);

beforeEach(() => {
  vi.clearAllMocks();
  conn.query.mockResolvedValue([[], {}] as never);
  mockExec.mockResolvedValue({ affectedRows: 1, insertId: 1 } as never);
  givenBatch();
});

// ───────────────────────────── idempotency ──────────────────────────────────

describe('migration idempotency', () => {
  it('skips a source row whose natural key is already staged', async () => {
    // First lookup: the batch. Then the natural-key probe finds a hit.
    conn.query.mockResolvedValueOnce([[{ id: 99 }], {}] as never);

    const counts = await migrationService.runBatch(1, 5, [row()], { dryRun: false });

    expect(counts.duplicate).toBe(1);
    expect(counts.staged).toBe(0);
    expect(counts.imported).toBe(0);
  });

  it('stages a row it has not seen before', async () => {
    conn.query.mockResolvedValueOnce([[], {}] as never)          // no existing key
             .mockResolvedValueOnce([{ insertId: 1 }, {}] as never);

    const counts = await migrationService.runBatch(1, 5, [row()], { dryRun: true });
    expect(counts.staged).toBe(1);
  });

  it('writes the natural key so the unique index can enforce it', async () => {
    conn.query.mockResolvedValueOnce([[], {}] as never)
             .mockResolvedValueOnce([{ insertId: 1 }, {}] as never);
    await migrationService.runBatch(1, 5, [row()], { dryRun: true });

    const insert = conn.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO migration_source_rows'));
    expect(String(insert![0])).toMatch(/natural_key/);
  });
});

// ─────────────────────────── posting and dry run ────────────────────────────

describe('dry run writes no transactions', () => {
  it('never calls the poster', async () => {
    conn.query.mockResolvedValue([[], {}] as never);
    const post = vi.fn();
    await migrationService.runBatch(1, 5, [row()], { dryRun: true }, post as never);
    expect(post).not.toHaveBeenCalled();
  });

  it('leaves the batch in DRY_RUN', async () => {
    conn.query.mockResolvedValue([[], {}] as never);
    await migrationService.runBatch(1, 5, [row()], { dryRun: true });
    const finalUpdate = mockExec.mock.calls.at(-1)!;
    expect(finalUpdate[1]).toContain('DRY_RUN');
  });

  it('posts and records the target on a real run', async () => {
    conn.query.mockResolvedValue([[], {}] as never);
    const post = vi.fn(async () => ({ entity: 'vouchers', id: 42 }));

    const counts = await migrationService.runBatch(1, 5, [row()], { dryRun: false }, post as never);

    expect(post).toHaveBeenCalledOnce();
    expect(counts.imported).toBe(1);
    const insert = conn.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO migration_source_rows'))!;
    expect(insert[1]).toContain('vouchers');
    expect(insert[1]).toContain(42);
  });
});

// ──────────────────────── REVIEW_REQUIRED handling ──────────────────────────

describe('ambiguous rows are parked, never discarded', () => {
  const ambiguous = row({
    party: 'RAJIB SIR',
    classification: { type: 'REVIEW_REQUIRED', name: null, reason: 'Ambiguous in the client column.' },
  });

  it('does not post it', async () => {
    conn.query.mockResolvedValue([[], {}] as never);
    const post = vi.fn(async () => ({ entity: 'vouchers', id: 1 }));
    const counts = await migrationService.runBatch(1, 5, [ambiguous], { dryRun: false }, post as never);

    expect(post).not.toHaveBeenCalled();
    expect(counts.review).toBe(1);
    expect(counts.imported).toBe(0);
  });

  it('still stages the row, so the money is not lost', async () => {
    conn.query.mockResolvedValue([[], {}] as never);
    const counts = await migrationService.runBatch(1, 5, [ambiguous], { dryRun: false });
    expect(counts.staged).toBe(1);
  });

  it('opens a review item carrying the reason and the source location', async () => {
    conn.query.mockResolvedValue([[], {}] as never);
    await migrationService.runBatch(1, 5, [ambiguous], { dryRun: false });

    const review = conn.query.mock.calls.find(([sql]) => String(sql).includes('migration_review_items'))!;
    expect(review[1]).toContain('Ambiguous in the client column.');
    expect(String(review[1]![5])).toMatch(/SALES DECEMBER-24\.xlsx · Sales DEC-24 · row 3/);
  });

  it('does not stop the rest of the batch', async () => {
    conn.query.mockResolvedValue([[], {}] as never);
    const counts = await migrationService.runBatch(
      1, 5, [ambiguous, row({ sourceRow: 4 })], { dryRun: true });
    expect(counts.staged).toBe(2);
    expect(counts.review).toBe(1);
  });
});

// ───────────────────────────── batch rollback ───────────────────────────────

describe('a failed batch takes nothing with it', () => {
  it('marks the batch FAILED and rethrows when a write fails', async () => {
    conn.query.mockResolvedValueOnce([[], {}] as never)
             .mockRejectedValueOnce(new Error('duplicate entry for key uq_msr_natural'));

    await expect(migrationService.runBatch(1, 5, [row()], { dryRun: false }))
      .rejects.toThrow(/duplicate entry/);

    const failure = mockExec.mock.calls.find(([sql]) => String(sql).includes("'FAILED'"));
    expect(failure).toBeDefined();
  });

  it('relies on the transaction to unwind — it never deletes by hand', async () => {
    conn.query.mockResolvedValueOnce([[], {}] as never)
             .mockRejectedValueOnce(new Error('boom'));
    await expect(migrationService.runBatch(1, 5, [row()], { dryRun: false })).rejects.toThrow();
    expect(vi.mocked(withTransaction)).toHaveBeenCalled();
    expect(conn.query.mock.calls.some(([sql]) => /^\s*DELETE/i.test(String(sql)))).toBe(false);
  });
});

describe('rolling a completed batch back', () => {
  it('removes every target it created, newest first', async () => {
    conn.query.mockResolvedValueOnce([[
      { id: 3, target_entity: 'payments', target_id: 30 },
      { id: 2, target_entity: 'vouchers', target_id: 20 },
    ], {}] as never).mockResolvedValue([[], {}] as never);

    const out = await migrationService.rollbackBatch(1, 5, 7);

    expect(out.removed).toBe(2);
    const deletes = conn.query.mock.calls.map(([sql]) => String(sql)).filter((s) => s.startsWith('DELETE'));
    // Payments first (the newer row), and a voucher's entries before the voucher.
    expect(deletes[0]).toMatch(/DELETE FROM payments/);
    expect(deletes[1]).toMatch(/DELETE FROM voucher_entries/);
    expect(deletes[2]).toMatch(/DELETE FROM vouchers/);
  });

  it('clears the staging and review rows too', async () => {
    conn.query.mockResolvedValueOnce([[], {}] as never).mockResolvedValue([[], {}] as never);
    await migrationService.rollbackBatch(1, 5, 7);
    const deletes = conn.query.mock.calls.map(([sql]) => String(sql));
    expect(deletes.some((s) => s.includes('DELETE FROM migration_review_items'))).toBe(true);
    expect(deletes.some((s) => s.includes('DELETE FROM migration_source_rows'))).toBe(true);
  });

  it('refuses to touch an unknown target table', async () => {
    conn.query.mockResolvedValueOnce([[{ id: 1, target_entity: 'users', target_id: 1 }], {}] as never);
    await expect(migrationService.rollbackBatch(1, 5, 7)).rejects.toThrow(/unknown target table/i);
  });

  it('refuses to roll back a month the CEO already verified', async () => {
    givenBatch({ status: 'VERIFIED' });
    await expect(migrationService.rollbackBatch(1, 5, 7)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('records a failed rollback rather than leaving it silent', async () => {
    conn.query.mockResolvedValueOnce([[{ id: 1, target_entity: 'vouchers', target_id: 1 }], {}] as never)
             .mockRejectedValueOnce(new Error('fk constraint'));
    await expect(migrationService.rollbackBatch(1, 5, 7)).rejects.toThrow();
    expect(mockExec.mock.calls.some(([sql]) => String(sql).includes("rollback_status = 'FAILED'"))).toBe(true);
  });
});

describe('a verified month is closed to re-import', () => {
  it('refuses to run again', async () => {
    givenBatch({ status: 'VERIFIED' });
    await expect(migrationService.runBatch(1, 5, [row()], { dryRun: false }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses a batch that is already running', async () => {
    givenBatch({ status: 'RUNNING' });
    await expect(migrationService.runBatch(1, 5, [row()], { dryRun: false }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

// ──────────────────────────── reconciliation ────────────────────────────────

describe('reconciliation compares, it never corrects', () => {
  it('marks a metric MATCHED when the figures agree', async () => {
    await migrationService.reconcile(1, 5, { SALES: { sourceValue: 100, migratedValue: 100 } });
    const insert = mockExec.mock.calls.find(([sql]) => String(sql).includes('migration_reconciliations'))!;
    expect(insert[1]).toContain('MATCHED');
  });

  it('marks a difference MISMATCHED and leaves both numbers standing', async () => {
    const out = await migrationService.reconcile(1, 5, {
      SALES: { sourceValue: 100, migratedValue: 90 },
    });
    expect(out.mismatched).toBe(1);
    const insert = mockExec.mock.calls.find(([sql]) => String(sql).includes('migration_reconciliations'))!;
    expect(insert[1]).toContain('MISMATCHED');
    expect(insert[1]).toContain(100);
    expect(insert[1]).toContain(90);
  });

  it('says NO_SOURCE rather than passing when there is no control figure', async () => {
    await migrationService.reconcile(1, 5, { CAPITAL: { sourceValue: null, migratedValue: 5000 } });
    const insert = mockExec.mock.calls.find(([sql]) => String(sql).includes('migration_reconciliations'))!;
    expect(insert[1]).toContain('NO_SOURCE');
  });

  it('tolerates rounding to the paisa but not beyond', async () => {
    const near = await migrationService.reconcile(1, 5, { SALES: { sourceValue: 100.001, migratedValue: 100 } });
    expect(near.mismatched).toBe(0);
    vi.clearAllMocks(); givenBatch(); mockExec.mockResolvedValue({ affectedRows: 1 } as never);
    const off = await migrationService.reconcile(1, 5, { SALES: { sourceValue: 100.02, migratedValue: 100 } });
    expect(off.mismatched).toBe(1);
  });

  it('stamps the batch with the overall outcome', async () => {
    await migrationService.reconcile(1, 5, { SALES: { sourceValue: 1, migratedValue: 2 } });
    const stamp = mockExec.mock.calls.find(([sql]) => String(sql).includes('reconciliation_status'))!;
    expect(stamp[1]).toContain('MISMATCHED');
  });
});

// ─────────────────────── month finalisation (CEO) ───────────────────────────

describe('closing a month', () => {
  it('refuses a batch that has not completed', async () => {
    givenBatch({ status: 'DRY_RUN' });
    await expect(migrationService.finalizeMonth(1, 5, 1, 'looks fine'))
      .rejects.toThrow(/only a completed batch/i);
  });

  it('verifies a clean month without needing a reason', async () => {
    mockQuery.mockResolvedValueOnce([BATCH] as never).mockResolvedValueOnce([{ n: 0 }] as never);
    const out = await migrationService.finalizeMonth(1, 5, 1, '');
    // 'approved', not 'verified': D007 made the outcome the thing that says
    // what happened, because an accepted limitation is not a verification.
    expect(out).toEqual({
      approved: true, unresolved: 0, outcome: 'VERIFIED_MIGRATED',
      dataCompleteness: BATCH.data_completeness,
    });
  });

  it('demands a written reason when review items are still open', async () => {
    mockQuery.mockResolvedValueOnce([BATCH] as never).mockResolvedValueOnce([{ n: 14 }] as never);
    await expect(migrationService.finalizeMonth(1, 5, 1, '   '))
      .rejects.toThrow(/14 REVIEW_REQUIRED item\(s\) are still open/);
  });

  it('lets the CEO approve over open items, and records how many', async () => {
    mockQuery.mockResolvedValueOnce([BATCH] as never).mockResolvedValueOnce([{ n: 14 }] as never);
    const out = await migrationService.finalizeMonth(1, 5, 1, 'Accepted; the remainder are immaterial.');
    expect(out).toEqual({
      approved: true, unresolved: 14, outcome: 'VERIFIED_MIGRATED',
      dataCompleteness: BATCH.data_completeness,
    });
    const update = conn.query.mock.calls.find(([sql]) => String(sql).includes('unresolved_at_approval'))!;
    expect(update[1]).toContain(14);
    expect(update[1]).toContain('Accepted; the remainder are immaterial.');
  });
});

// ────────────────────────── the review queue ────────────────────────────────

describe('review queue', () => {
  it('will not close an item without a resolution note', async () => {
    await expect(migrationService.resolveReviewItem(1, 9, 2, { status: 'RESOLVED', resolution: ' ' }))
      .rejects.toThrow(/resolution note is required/i);
  });

  it('closes only an item that is still open', async () => {
    mockExec.mockResolvedValueOnce({ affectedRows: 0 } as never);
    await expect(migrationService.resolveReviewItem(1, 9, 2, {
      status: 'RESOLVED', resolution: 'Confirmed with the client.',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('records who resolved it and when', async () => {
    await migrationService.resolveReviewItem(1, 9, 2, {
      status: 'ACCEPTED_AS_IS', resolution: 'Immaterial; accepted.',
    });
    const [sql, params] = mockExec.mock.calls[0];
    expect(String(sql)).toMatch(/resolved_by = \?, resolved_at = NOW\(\)/);
    expect(params).toContain(2);
  });
});

// ───────────────── outstanding adjustment: audited last resort ──────────────

describe('historical outstanding adjustment', () => {
  const base = {
    batchId: 5, partyType: 'CUSTOMER' as const, partyId: 3,
    controlAmount: 100000, calculatedAmount: 97000,
    controlSource: 'OUTSTANDING Oct-24 (16)',
    investigation: 'Searched for missing receipts and duplicate sales across Oct and Nov.',
    reason: 'Unexplained after investigation.',
  };

  it('refuses without a record of what was investigated', async () => {
    await expect(migrationService.recordOutstandingAdjustment(1, 1, { ...base, investigation: '' }))
      .rejects.toThrow(/what was searched/i);
  });

  it('refuses without a reason', async () => {
    await expect(migrationService.recordOutstandingAdjustment(1, 1, { ...base, reason: '  ' }))
      .rejects.toThrow(/reason is required/i);
  });

  it('records the control figure, the calculated figure and the approver', async () => {
    await migrationService.recordOutstandingAdjustment(1, 77, base);
    const [, params] = mockExec.mock.calls[0];
    expect(params).toContain(100000);
    expect(params).toContain(97000);
    expect(params).toContain(77);
    expect(params).toContain('OUTSTANDING Oct-24 (16)');
  });
});
