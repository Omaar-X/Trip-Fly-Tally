import { PoolConnection } from 'mysql2/promise';
import { Row } from '../../config/db';
import { ApiError } from '../../utils/ApiError';

/**
 * ========================= WHO OWNS THIS VOUCHER? ===========================
 * Most vouchers are not free-standing. A sales voucher is the accounting half
 * of an invoice; a receipt is the accounting half of a payment that also moved
 * an invoice's collected figure; the payroll accrual is half of a run whose
 * status says APPROVED.
 *
 * Reversing such a voucher directly through the generic endpoint would put the
 * ledger right and leave the document lying: the invoice would still show a
 * receivable that the books no longer carry, the payroll run would still say
 * APPROVED with nothing accrued. So the generic reversal refuses, and names
 * the operation that unwinds BOTH halves together.
 *
 * Once the owning document is itself unwound (invoice VOID, booking CANCELLED)
 * the voucher is no longer claimed and ordinary reversal rules apply again.
 * ============================================================================
 */

interface Claim {
  /** SQL returning at least one row when the voucher is still claimed. */
  sql: string;
  message: (row: Row) => string;
}

const CLAIMS: Claim[] = [
  {
    sql: `SELECT i.invoice_no, i.id FROM invoices i
           WHERE i.company_id = ? AND i.voucher_id = ? AND i.status <> 'VOID' LIMIT 1`,
    message: (r) =>
      `This voucher is the sales posting behind invoice ${r.invoice_no}. ` +
      `Cancel the booking (POST /api/bookings/:id/cancel) so the invoice is voided with it, ` +
      `instead of reversing the voucher on its own.`,
  },
  {
    sql: `SELECT b.booking_no, b.id FROM bookings b
           WHERE b.company_id = ? AND b.purchase_voucher_id = ? AND b.status <> 'CANCELLED' LIMIT 1`,
    message: (r) =>
      `This voucher is the supplier cost behind booking ${r.booking_no}. ` +
      `Cancel the booking so both its vouchers are reversed together.`,
  },
  {
    sql: `SELECT p.payment_no, p.id FROM payments p
           WHERE p.company_id = ? AND p.voucher_id = ? LIMIT 1`,
    message: (r) =>
      `This voucher belongs to payment ${r.payment_no}. ` +
      `Use POST /api/payments/${r.id}/reverse so the invoice's collected amount is corrected too.`,
  },
  {
    sql: `SELECT pr.id, pr.period_year, pr.period_month FROM payroll_runs pr
           WHERE pr.company_id = ? AND pr.voucher_id = ? AND pr.status <> 'DRAFT' LIMIT 1`,
    message: (r) =>
      `This voucher is the salary accrual for ${r.period_year}-${String(r.period_month).padStart(2, '0')}. ` +
      `Use POST /api/hr/payroll/${r.id}/unapprove so the run returns to DRAFT with it.`,
  },
  {
    sql: `SELECT se.id, i.name AS item_name FROM stock_entries se
            JOIN items i ON i.id = se.item_id
           WHERE se.company_id = ? AND se.voucher_id = ? LIMIT 1`,
    message: (r) =>
      `This voucher is the ledger side of a stock movement for "${r.item_name}". ` +
      `Use POST /api/inventory/movements/${r.id}/reverse so the stock journal is corrected too.`,
  },
];

/**
 * Throws when a voucher is still claimed by a live document. Runs inside the
 * caller's transaction so the document state it reads is the state the
 * reversal will act on.
 */
export async function assertVoucherIsFreeStanding(
  conn: PoolConnection, companyId: number, voucherId: number
): Promise<void> {
  for (const claim of CLAIMS) {
    const [rows] = await conn.query<Row[]>(claim.sql, [companyId, voucherId]);
    if (rows.length) throw ApiError.conflict(claim.message(rows[0]));
  }
}
