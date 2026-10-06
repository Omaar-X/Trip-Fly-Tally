import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * D007 · CEO acceptance of a genuinely incomplete historical period.
 *
 * The distinction these tests exist to protect: accepting a limitation is not a
 * weaker verification. A period the CEO accepts stays INCOMPLETE and stays
 * MISMATCHED, and nothing in the record may read as though the figures agree.
 */

const conn = { query: vi.fn() };

vi.mock('../src/config/db', () => ({
  query: vi.fn(),
  exec: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(conn)),
  pool: { end: vi.fn() },
}));

vi.mock('../src/utils/numbering', () => ({ nextRequestNo: vi.fn(async () => 'MIG-1') }));

import { migrationService } from '../src/modules/migration/migration.service';
import { query } from '../src/config/db';

const mockQuery = vi.mocked(query);

const INCOMPLETE = {
  id: 9, company_id: 1, source_period: '2024-10', status: 'COMPLETED',
  data_completeness: 'INCOMPLETE', reconciliation_status: 'MISMATCHED',
  completeness_note: 'The day book records receipts for the whole company.',
};

/** batch lookup → open-item counts → reconciliation rows. */
const givenBatch = (batch: Record<string, unknown> = INCOMPLETE) => {
  mockQuery
    .mockResolvedValueOnce([batch] as never)
    .mockResolvedValueOnce([{ n: 2820, material: 1403, material_amount: 74849705.47 }] as never)
    .mockResolvedValueOnce([
      { metric: 'CUSTOMER_OUTSTANDING', source_value: 4866857, migrated_value: -2658517.06, difference: -7525374.06 },
      { metric: 'VENDOR_PAYABLE', source_value: 3635456, migrated_value: 1444135.16, difference: -2191320.84 },
    ] as never);
};

const statements = () => conn.query.mock.calls.map((c) => String(c[0]));

// mockReset, not clearAllMocks: the latter keeps queued mockResolvedValueOnce
// values, so one test that throws early leaves its unused rows for the next.
beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  conn.query.mockReset();
  conn.query.mockResolvedValue([[], []] as never);
});

describe('D007 · accepting an incomplete period', () => {
  it('demands a reason AND a comment', async () => {
    givenBatch();
    await expect(migrationService.finalizeMonth(1, 9, 7, '', '')).rejects.toThrow(/written reason/i);

    mockQuery.mockReset();
    givenBatch();
    await expect(migrationService.finalizeMonth(1, 9, 7, 'Source never existed.', ''))
      .rejects.toThrow(/written comment/i);
  });

  it('records ACCEPTED_HISTORICAL_DATA_LIMITATION, never VERIFIED_MIGRATED', async () => {
    givenBatch();
    const out = await migrationService.finalizeMonth(
      1, 9, 7, 'Sales register for this month was never produced.',
      'Accepted as a known historical limitation; the difference stays visible.');

    expect(out.outcome).toBe('ACCEPTED_HISTORICAL_DATA_LIMITATION');
    expect(out.dataCompleteness).toBe('INCOMPLETE');

    const update = statements().find((s) => s.includes('UPDATE migration_batches'))!;
    // The batch status must say what happened, not claim verification.
    expect(conn.query.mock.calls[0][1]).toContain('ACCEPTED_WITH_LIMITATION');
    // Neither completeness nor reconciliation may be touched by an approval.
    expect(update).not.toMatch(/data_completeness\s*=/);
    expect(update).not.toMatch(/reconciliation_status\s*=/);
  });

  it('snapshots the figures being accepted into the approval history', async () => {
    givenBatch();
    await migrationService.finalizeMonth(1, 9, 7, 'reason given', 'comment given');

    const insert = conn.query.mock.calls.find(
      (c) => String(c[0]).includes('migration_period_approvals'))!;
    const params = insert[1] as unknown[];
    // Source AR, migrated AR and the difference are stored as they stood, so a
    // later re-post cannot rewrite what the CEO signed off.
    expect(params).toContain(4866857);
    expect(params).toContain(-2658517.06);
    expect(params).toContain(-7525374.06);
    expect(params).toContain('INCOMPLETE');
    expect(params).toContain('MISMATCHED');
  });

  it('approves exactly one batch — there is no bulk path', async () => {
    givenBatch();
    await migrationService.finalizeMonth(1, 9, 7, 'reason given', 'comment given');
    const update = conn.query.mock.calls.find((c) => String(c[0]).includes('UPDATE migration_batches'))!;
    expect(String(update[0])).toMatch(/WHERE id = \?/);
    expect(String(update[0])).not.toMatch(/source_period IN|WHERE 1|IN \(/);
    expect((update[1] as unknown[]).at(-1)).toBe(9);
  });

  it('a period that DOES reconcile is verified instead', async () => {
    givenBatch({ ...INCOMPLETE, data_completeness: 'REVIEW_REQUIRED' });
    const out = await migrationService.finalizeMonth(1, 9, 7, 'reason given', '');
    expect(out.outcome).toBe('VERIFIED_MIGRATED');
    expect(conn.query.mock.calls[0][1]).toContain('VERIFIED');
  });
});

describe('D007 · reopening keeps the earlier acceptance', () => {
  it('refuses without a reason', async () => {
    await expect(migrationService.reopenPeriod(1, 9, 7, '  ')).rejects.toThrow(/written reason/i);
  });

  it('appends a REOPENED row rather than overwriting the acceptance', async () => {
    mockQuery.mockResolvedValueOnce([{ ...INCOMPLETE, status: 'ACCEPTED_WITH_LIMITATION' }] as never);
    await migrationService.reopenPeriod(1, 9, 7, 'The missing October sales register was recovered.');

    const insert = conn.query.mock.calls.find(
      (c) => String(c[0]).includes('migration_period_approvals'))!;
    expect(String(insert[0])).toMatch(/INSERT INTO/);
    expect(String(insert[0])).toContain('REOPENED');
    // Nothing updates or deletes the prior history row.
    for (const s of statements()) {
      expect(s).not.toMatch(/UPDATE migration_period_approvals|DELETE FROM migration_period_approvals/);
    }
  });

  it('refuses to reopen a period nobody has approved', async () => {
    mockQuery.mockResolvedValueOnce([INCOMPLETE] as never);
    await expect(migrationService.reopenPeriod(1, 9, 7, 'because'))
      .rejects.toThrow(/Only an approved period/i);
  });
});

describe('D007 · an accepted period is closed to quiet rewriting', () => {
  it('cannot be rolled back without an explicit reopen', async () => {
    mockQuery.mockResolvedValueOnce([{ ...INCOMPLETE, status: 'ACCEPTED_WITH_LIMITATION' }] as never);
    await expect(migrationService.rollbackBatch(1, 9, 7)).rejects.toThrow(/Reopen it first/i);
  });
});
