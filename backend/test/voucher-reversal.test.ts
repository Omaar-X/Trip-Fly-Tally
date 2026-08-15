import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';

vi.mock('../src/modules/accounting/accounting.repository', () => ({
  accountingRepo: {
    lockVoucherWithEntries: vi.fn(),
    markVoucherReversed: vi.fn(),
    insertVoucher: vi.fn(),
    insertEntries: vi.fn(),
  },
}));

vi.mock('../src/modules/accounting/accounting.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/accounting/accounting.service')>();
  return { ...actual, postVoucherTx: vi.fn() };
});

import { financialReversalService } from '../src/modules/accounting/reversal.service';
import { accountingRepo } from '../src/modules/accounting/accounting.repository';
import { postVoucherTx } from '../src/modules/accounting/accounting.service';
import { ApiError } from '../src/utils/ApiError';

const conn = {} as PoolConnection;

const salesVoucher = (overrides: Record<string, unknown> = {}) => ({
  id: 55, company_id: 1, voucher_no: 'SV-2026-00014', voucher_type: 'SALES',
  voucher_date: '2026-06-10', narration: 'Sale', reference: 'BK-2026-00008',
  total_amount: 59325, status: 'ACTIVE' as const,
  reversal_of_voucher_id: null, reversed_by_voucher_id: null, created_by: 1,
  entries: [
    { ledger_id: 12, entry_type: 'DR' as const, amount: 59325, line_note: 'Booking' },
    { ledger_id: 5, entry_type: 'CR' as const, amount: 56500, line_note: 'FLIGHT sale' },
    { ledger_id: 8, entry_type: 'CR' as const, amount: 2825, line_note: 'VAT 5%' },
  ],
  ...overrides,
});

describe('financialReversalService.reverseVoucherTx', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(postVoucherTx).mockResolvedValue({ voucherId: 61, voucherNo: 'CN-2026-00003', total: 59325 });
  });

  it('mirrors every entry so the pair nets to zero', async () => {
    vi.mocked(accountingRepo.lockVoucherWithEntries).mockResolvedValue(salesVoucher() as any);

    await financialReversalService.reverseVoucherTx(conn, 1, 7, 55, { reason: 'Customer cancelled' });

    const posted = vi.mocked(postVoucherTx).mock.calls[0][3];
    expect(posted.entries).toEqual([
      { ledgerId: 12, type: 'CR', amount: 59325, note: 'Booking' },
      { ledgerId: 5, type: 'DR', amount: 56500, note: 'FLIGHT sale' },
      { ledgerId: 8, type: 'DR', amount: 2825, note: 'VAT 5%' },
    ]);
    // The mirror must carry identical totals, or the reversal would not clear.
    const dr = posted.entries.filter(e => e.type === 'DR').reduce((s, e) => s + e.amount, 0);
    const cr = posted.entries.filter(e => e.type === 'CR').reduce((s, e) => s + e.amount, 0);
    expect(dr).toBe(cr);
  });

  it('posts a SALES reversal as a credit note and a PURCHASE reversal as a debit note', async () => {
    vi.mocked(accountingRepo.lockVoucherWithEntries).mockResolvedValue(salesVoucher() as any);
    await financialReversalService.reverseVoucherTx(conn, 1, 7, 55);
    expect(vi.mocked(postVoucherTx).mock.calls[0][3].type).toBe('CREDIT_NOTE');

    vi.mocked(accountingRepo.lockVoucherWithEntries).mockResolvedValue(
      salesVoucher({ id: 56, voucher_type: 'PURCHASE', voucher_no: 'PUR-2026-00003' }) as any);
    await financialReversalService.reverseVoucherTx(conn, 1, 7, 56);
    expect(vi.mocked(postVoucherTx).mock.calls[1][3].type).toBe('DEBIT_NOTE');
  });

  it('links the reversal to the original in both directions', async () => {
    vi.mocked(accountingRepo.lockVoucherWithEntries).mockResolvedValue(salesVoucher() as any);

    const result = await financialReversalService.reverseVoucherTx(conn, 1, 7, 55, { reason: 'No-show' });

    expect(vi.mocked(postVoucherTx).mock.calls[0][3].reversalOfVoucherId).toBe(55);
    expect(accountingRepo.markVoucherReversed).toHaveBeenCalledWith(conn, 55, {
      reversedByVoucherId: 61, reversedBy: 7, reason: 'No-show',
    });
    expect(result).toMatchObject({
      originalVoucherId: 55, originalVoucherNo: 'SV-2026-00014',
      reversalVoucherId: 61, reversalVoucherNo: 'CN-2026-00003',
    });
  });

  it('refuses to reverse the same voucher twice', async () => {
    vi.mocked(accountingRepo.lockVoucherWithEntries).mockResolvedValue(
      salesVoucher({ status: 'REVERSED', reversed_by_voucher_id: 61 }) as any);

    await expect(financialReversalService.reverseVoucherTx(conn, 1, 7, 55))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(postVoucherTx).not.toHaveBeenCalled();
  });

  it('refuses to reverse a voucher that is itself a reversal', async () => {
    vi.mocked(accountingRepo.lockVoucherWithEntries).mockResolvedValue(
      salesVoucher({ id: 61, reversal_of_voucher_id: 55 }) as any);

    await expect(financialReversalService.reverseVoucherTx(conn, 1, 7, 61))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('404s on a voucher that does not belong to the company', async () => {
    vi.mocked(accountingRepo.lockVoucherWithEntries).mockResolvedValue(undefined);
    await expect(financialReversalService.reverseVoucherTx(conn, 1, 7, 999))
      .rejects.toBeInstanceOf(ApiError);
  });

  describe('reverseIfActiveTx', () => {
    it('is a no-op when there is no voucher to reverse', async () => {
      const result = await financialReversalService.reverseIfActiveTx(conn, 1, 7, null);
      expect(result).toBeNull();
      expect(postVoucherTx).not.toHaveBeenCalled();
    });

    it('skips an already-reversed voucher instead of throwing', async () => {
      vi.mocked(accountingRepo.lockVoucherWithEntries).mockResolvedValue(
        salesVoucher({ status: 'REVERSED' }) as any);

      const result = await financialReversalService.reverseIfActiveTx(conn, 1, 7, 55);

      expect(result).toBeNull();
      expect(postVoucherTx).not.toHaveBeenCalled();
    });
  });
});
