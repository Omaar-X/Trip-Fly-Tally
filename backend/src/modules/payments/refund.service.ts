import { PoolConnection } from 'mysql2/promise';
import { Row } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { round2 } from '../../utils/money';

/**
 * ========================= INVOICE SETTLEMENT / REFUND ======================
 * Owns how money moving in or out changes what an invoice still owes.
 *
 *   receipt  paid_amount goes up    UNPAID -> PARTIAL -> PAID
 *   refund   paid_amount goes down  PAID -> PARTIAL -> UNPAID
 *
 * The invoice is always locked FOR UPDATE by the caller before either runs, so
 * concurrent receipts cannot overpay and concurrent refunds cannot over-refund.
 * Status is always recomputed from the resulting paid_amount rather than being
 * nudged one step, so the two directions can never disagree about it.
 * ============================================================================
 */

export type InvoiceStatus = 'UNPAID' | 'PARTIAL' | 'PAID' | 'VOID';

export interface SettlementResult {
  invoiceId: number;
  invoiceNo: string;
  paid: number;
  due: number;
  status: InvoiceStatus;
}

/** Derives invoice status from what has actually been received. */
export function settlementStatus(paid: number, total: number): Exclude<InvoiceStatus, 'VOID'> {
  if (paid <= 0) return 'UNPAID';
  return paid >= total ? 'PAID' : 'PARTIAL';
}

export const refundService = {
  /** Locks an invoice for settlement and checks it belongs to this counterparty. */
  async lockInvoiceForSettlementTx(
    conn: PoolConnection, companyId: number, invoiceId: number, customerId: number
  ): Promise<Row> {
    const [rows] = await conn.query<Row[]>(
      'SELECT * FROM invoices WHERE id = ? AND company_id = ? FOR UPDATE', [invoiceId, companyId]);
    if (!rows.length) throw ApiError.notFound('Invoice not found');
    const invoice = rows[0];
    if (Number(invoice.customer_id) !== Number(customerId))
      throw ApiError.badRequest('Invoice belongs to a different customer');
    return invoice;
  },

  /**
   * Applies an incoming receipt. Rejects anything above what is still due, so
   * an invoice can never show more collected than it billed.
   */
  async applyReceiptTx(
    conn: PoolConnection, invoice: Row, amount: number
  ): Promise<SettlementResult> {
    if (invoice.status === 'VOID') throw ApiError.conflict('Invoice is void');

    const total = round2(Number(invoice.total));
    const paidNow = round2(Number(invoice.paid_amount));
    const due = round2(total - paidNow);
    if (amount > due)
      throw ApiError.badRequest(`Payment ${amount.toFixed(2)} exceeds invoice due ${due.toFixed(2)}`);

    const paid = round2(paidNow + amount);
    const status = settlementStatus(paid, total);
    await conn.query('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?',
      [paid, status, invoice.id]);

    return {
      invoiceId: Number(invoice.id), invoiceNo: invoice.invoice_no as string,
      paid, due: round2(total - paid), status,
    };
  },

  /**
   * Reverses settlement when money goes back to the customer. Refunding more
   * than was ever collected is refused — that would be a payout, not a refund.
   *
   * A VOID invoice keeps its status: the sale is already unwound, so the refund
   * only corrects how much of it was recorded as collected.
   */
  async applyRefundTx(
    conn: PoolConnection, invoice: Row, amount: number
  ): Promise<SettlementResult> {
    const total = round2(Number(invoice.total));
    const paidNow = round2(Number(invoice.paid_amount));
    if (paidNow <= 0)
      throw ApiError.badRequest(`Invoice ${invoice.invoice_no} has no payments to refund`);
    if (amount > paidNow)
      throw ApiError.badRequest(
        `Refund ${amount.toFixed(2)} exceeds the ${paidNow.toFixed(2)} received against invoice ${invoice.invoice_no}`);

    const paid = round2(paidNow - amount);
    const status: InvoiceStatus =
      invoice.status === 'VOID' ? 'VOID' : settlementStatus(paid, total);
    await conn.query('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?',
      [paid, status, invoice.id]);

    return {
      invoiceId: Number(invoice.id), invoiceNo: invoice.invoice_no as string,
      paid, due: round2(total - paid), status,
    };
  },

  /**
   * Undoes a settlement because the PAYMENT ITSELF is being reversed — the
   * money never really moved, so the invoice must go back to exactly where it
   * stood before.
   *
   * This is deliberately not applyReceiptTx/applyRefundTx run backwards: those
   * two guard a real movement of money (you cannot collect more than is due,
   * you cannot refund more than was collected). Undoing a mistaken entry has
   * to be allowed even when re-applying it in the opposite direction would
   * breach those guards — for example reversing a receipt that was recorded
   * against an invoice which has since been voided.
   *
   * A VOID invoice keeps its VOID status: the sale is already unwound and only
   * the collected figure is being corrected.
   */
  async reverseSettlementTx(
    conn: PoolConnection, invoice: Row, direction: 'IN' | 'OUT', amount: number
  ): Promise<SettlementResult> {
    const total = round2(Number(invoice.total));
    const paidNow = round2(Number(invoice.paid_amount));

    // Reversing a receipt takes collection back out; reversing a refund puts
    // it back in. Clamped at zero so a double-reversal can never drive the
    // collected figure negative.
    const paid = round2(Math.max(0, direction === 'IN' ? paidNow - amount : paidNow + amount));
    const status: InvoiceStatus =
      invoice.status === 'VOID' ? 'VOID' : settlementStatus(paid, total);

    await conn.query('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?',
      [paid, status, invoice.id]);

    return {
      invoiceId: Number(invoice.id), invoiceNo: invoice.invoice_no as string,
      paid, due: round2(total - paid), status,
    };
  },
};
