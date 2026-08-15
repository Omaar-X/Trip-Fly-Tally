import { PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { today } from '../../utils/date';
import { accountingRepo } from './accounting.repository';
import { postVoucherTx, VoucherType } from './accounting.service';
import { BooksPolicy, loadBooksPolicyTx } from './fiscalPeriod.service';
import { assertVoucherIsFreeStanding } from './voucherOwnership.service';

/**
 * ========================== FINANCIAL REVERSAL ==============================
 * The one place that knows how to unwind a posting.
 *
 * A voucher is never edited and never deleted. Reversing it posts a NEW
 * voucher whose entries are the exact mirror of the original (every DR becomes
 * a CR of the same amount against the same ledger), so the pair nets to zero in
 * every report while both remain individually visible in the audit trail.
 *
 *     SV-2026-00014  status REVERSED, reversed_by_voucher_id ─┐
 *                                                             ▼
 *     CN-2026-00003  reversal_of_voucher_id ──────────────────┘
 *
 * Because the mirror preserves the original amounts exactly, a reversal can
 * never break the debit == credit invariant: it is re-validated anyway on the
 * way through postVoucherTx.
 * ============================================================================
 */

/**
 * Accounting convention for what a reversal is *called*. A sale is undone by a
 * credit note, a purchase by a debit note, and money that came in goes back out
 * as a payment. Anything without a conventional counterpart reverses in kind.
 */
const REVERSAL_TYPE: Record<VoucherType, VoucherType> = {
  SALES: 'CREDIT_NOTE',
  PURCHASE: 'DEBIT_NOTE',
  CREDIT_NOTE: 'DEBIT_NOTE',
  DEBIT_NOTE: 'CREDIT_NOTE',
  RECEIPT: 'PAYMENT',
  PAYMENT: 'RECEIPT',
  JOURNAL: 'JOURNAL',
  CONTRA: 'CONTRA',
};

const mirror = (type: 'DR' | 'CR'): 'DR' | 'CR' => (type === 'DR' ? 'CR' : 'DR');

export interface ReverseVoucherOptions {
  reason?: string;
  /**
   * Posting date for the reversal. Defaults to today in the business timezone.
   *
   * Reversals are deliberately NOT backdated to the original: that is what
   * lets a mistake in a closed period be corrected without reopening it — the
   * original stays where it was filed and the correction lands in the period
   * that is still open, which is the same discipline Tally enforces.
   */
  date?: string;
  /** Overrides the conventional reversal voucher type when a caller needs to. */
  type?: VoucherType;
  /** Reuse a policy the caller already loaded for this business action. */
  policy?: BooksPolicy;
}

export interface ReversalResult {
  originalVoucherId: number;
  originalVoucherNo: string;
  reversalVoucherId: number;
  reversalVoucherNo: string;
  reversalDate: string;
  total: number;
}

export const financialReversalService = {
  /**
   * Reverses one voucher inside the caller's transaction.
   *
   * Refuses to run twice: the original is locked FOR UPDATE and rejected if it
   * is already REVERSED, so concurrent cancellations cannot double-reverse.
   */
  async reverseVoucherTx(
    conn: PoolConnection, companyId: number, userId: number,
    voucherId: number, options: ReverseVoucherOptions = {}
  ): Promise<ReversalResult> {
    const original = await accountingRepo.lockVoucherWithEntries(conn, companyId, voucherId);
    if (!original) throw ApiError.notFound('Voucher not found');

    if (original.status === 'REVERSED')
      throw ApiError.conflict(`Voucher ${original.voucher_no} has already been reversed`);
    if (original.reversal_of_voucher_id)
      throw ApiError.conflict(
        `Voucher ${original.voucher_no} is itself a reversal and cannot be reversed again`);

    const entries = original.entries ?? [];
    if (!entries.length)
      throw ApiError.conflict(`Voucher ${original.voucher_no} has no entries to reverse`);

    const originalType = original.voucher_type as VoucherType;
    const reversalType = options.type ?? REVERSAL_TYPE[originalType] ?? 'JOURNAL';
    const reason = options.reason?.trim() || undefined;

    const reversal = await postVoucherTx(conn, companyId, userId, {
      type: reversalType,
      date: options.date ?? today(),
      reference: original.reference ?? undefined,
      narration: `Reversal of ${original.voucher_no}${reason ? ` — ${reason}` : ''}`,
      reversalOfVoucherId: voucherId,
      entries: entries.map(e => ({
        ledgerId: Number(e.ledger_id),
        type: mirror(e.entry_type),
        amount: Number(e.amount),
        note: e.line_note ?? undefined,
      })),
    }, { policy: options.policy });

    await accountingRepo.markVoucherReversed(conn, voucherId, {
      reversedByVoucherId: reversal.voucherId,
      reversedBy: userId,
      reason,
    });

    return {
      originalVoucherId: voucherId,
      originalVoucherNo: original.voucher_no,
      reversalVoucherId: reversal.voucherId,
      reversalVoucherNo: reversal.voucherNo,
      reversalDate: reversal.date,
      total: reversal.total,
    };
  },

  /**
   * Reverses a voucher only if it is still standing. Returns null when there is
   * nothing to do (no voucher, or already reversed), which lets cancellation
   * flows stay idempotent instead of failing on a partially-unwound booking.
   */
  async reverseIfActiveTx(
    conn: PoolConnection, companyId: number, userId: number,
    voucherId: number | null | undefined, options: ReverseVoucherOptions = {}
  ): Promise<ReversalResult | null> {
    if (!voucherId) return null;
    const voucher = await accountingRepo.lockVoucherWithEntries(conn, companyId, voucherId);
    if (!voucher || voucher.status === 'REVERSED') return null;
    return this.reverseVoucherTx(conn, companyId, userId, voucherId, options);
  },

  /**
   * The correction path for a voucher nobody else owns — a manual journal,
   * contra or opening entry posted wrong.
   *
   * Vouchers belonging to a document (invoice, payment, payroll run, stock
   * movement) are refused here and must be unwound through that document, so
   * the ledger and the document can never end up telling different stories.
   */
  reverseFreeStandingVoucher: (
    companyId: number, userId: number, voucherId: number,
    options: { reason?: string; date?: string } = {}
  ) =>
    withTransaction(async (conn) => {
      const policy = await loadBooksPolicyTx(conn, companyId);
      await assertVoucherIsFreeStanding(conn, companyId, voucherId);
      return financialReversalService.reverseVoucherTx(
        conn, companyId, userId, voucherId, { ...options, policy });
    }),
};
