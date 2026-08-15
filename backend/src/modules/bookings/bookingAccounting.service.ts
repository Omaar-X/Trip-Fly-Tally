import { PoolConnection } from 'mysql2/promise';
import { Row, WriteResult } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { round2 } from '../../utils/money';
import { today } from '../../utils/date';
import { nextDocNo } from '../../utils/numbering';
import { findLedgerId, salesLedgerName, SYSTEM_LEDGERS } from '../../utils/systemLedgers';
import { postVoucherTx } from '../accounting/accounting.service';
import { BooksPolicy, assertPostable, financialYearOf } from '../accounting/fiscalPeriod.service';
import { financialReversalService, ReversalResult } from '../accounting/reversal.service';

/**
 * ======================= BOOKING ACCOUNTING SERVICE =========================
 * Owns every ledger consequence of a booking, in both directions.
 *
 * Confirming a booking posts TWO vouchers:
 *
 *   SALES     Dr Customer A/R        total
 *             Cr Sales — <type>      taxable
 *             Cr VAT Payable         vat        (when vatPercent > 0)
 *
 *   PURCHASE  Dr Cost of Services    cost                (when the booking
 *             Cr Supplier A/P        cost                 has a supplier cost)
 *
 * Cancelling must therefore reverse BOTH. Posting and unwinding live in this
 * one service precisely so a future change to what confirmation posts cannot
 * silently leave cancellation behind — which is exactly how the supplier
 * payable used to survive a cancelled booking, overstating both Cost of
 * Services and Sundry Creditors while the Trial Balance still balanced.
 * ============================================================================
 */

export interface BookingInvoiceTerms {
  vatPercent?: number;
  discount?: number;
  dueDate?: string;
  /**
   * The date revenue is recognised on — the invoice date and the date both
   * vouchers carry. Defaults to today, but it is the CALLER's choice, which is
   * what makes historical data entry and month-end cut-off possible at all.
   * Confirmation used to stamp the server's UTC date unconditionally, so a
   * June booking confirmed in August landed in August's P&L.
   */
  invoiceDate?: string;
}

export interface ConfirmationPosting {
  invoiceId: number;
  invoiceNo: string;
  invoiceDate: string;
  subtotal: number;
  discount: number;
  vatPercent: number;
  vatAmount: number;
  total: number;
  salesVoucherId: number;
  salesVoucherNo: string;
  purchaseVoucherId: number | null;
  purchaseVoucherNo: string | null;
}

export interface BookingReversal {
  salesReversal: ReversalResult | null;
  purchaseReversal: ReversalResult | null;
  invoiceVoided: boolean;
}

/** Computes invoice money from the booking's sale price and the confirm terms. */
export function priceBooking(salePrice: number, terms: BookingInvoiceTerms) {
  const subtotal = round2(Number(salePrice));
  const discount = round2(terms.discount ?? 0);
  if (discount < 0 || discount > subtotal) throw ApiError.badRequest('Invalid discount');
  const vatPercent = round2(terms.vatPercent ?? 0);
  const taxable = round2(subtotal - discount);
  const vatAmount = round2(taxable * vatPercent / 100);
  const total = round2(taxable + vatAmount);
  if (total <= 0) throw ApiError.badRequest('Invoice total must be positive');
  return { subtotal, discount, vatPercent, taxable, vatAmount, total };
}

export const bookingAccountingService = {
  /**
   * Posts the full set of confirmation entries and raises the invoice.
   * Caller supplies the transaction; nothing here commits.
   */
  async postConfirmationTx(
    conn: PoolConnection, companyId: number, userId: number,
    booking: Row, terms: BookingInvoiceTerms, policy: BooksPolicy
  ): Promise<ConfirmationPosting> {
    const bookingId = Number(booking.id);
    const bookingType = booking.booking_type as 'FLIGHT' | 'HOTEL' | 'TOUR';
    const { subtotal, discount, vatPercent, taxable, vatAmount, total } =
      priceBooking(Number(booking.sale_price), terms);

    // One date for the whole confirmation: the invoice, the sales voucher and
    // the supplier-cost voucher must land in the same period, or revenue and
    // its cost end up in different months.
    const invoiceDate = terms.invoiceDate ?? today();
    assertPostable(invoiceDate, policy, 'invoice');
    if (terms.dueDate && terms.dueDate < invoiceDate)
      throw ApiError.badRequest(`Due date ${terms.dueDate} is before the invoice date ${invoiceDate}`);

    const customerLedgerId = await customerLedger(conn, companyId, Number(booking.customer_id));
    const salesLedgerId = await findLedgerId(conn, companyId, salesLedgerName(bookingType));

    // ---- SALES voucher (revenue recognition) ----
    const entries = [
      { ledgerId: customerLedgerId, type: 'DR' as const, amount: total, note: `Booking ${booking.booking_no}` },
      { ledgerId: salesLedgerId, type: 'CR' as const, amount: taxable, note: `${bookingType} sale` },
    ];
    if (vatAmount > 0) {
      const vatLedgerId = await findLedgerId(conn, companyId, SYSTEM_LEDGERS.VAT_PAYABLE);
      entries.push({ ledgerId: vatLedgerId, type: 'CR' as const, amount: vatAmount, note: `VAT ${vatPercent}%` });
    }
    const sales = await postVoucherTx(conn, companyId, userId, {
      type: 'SALES', date: invoiceDate, reference: booking.booking_no as string,
      narration: `Sale of ${bookingType.toLowerCase()} booking ${booking.booking_no}`,
      entries,
    }, { policy });

    // ---- invoice ----
    const fy = financialYearOf(invoiceDate, policy.fyStartMonth);
    const invoiceNo = await nextDocNo(conn, companyId, 'INVOICE', fy);
    const [invRes] = await conn.query<WriteResult>(
      `INSERT INTO invoices (company_id, invoice_no, customer_id, booking_id, invoice_date, due_date,
                             subtotal, discount, vat_percent, vat_amount, total, voucher_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [companyId, invoiceNo, booking.customer_id, bookingId, invoiceDate, terms.dueDate ?? null,
       subtotal, discount, vatPercent, vatAmount, total, sales.voucherId]);
    const invoiceId = invRes.insertId;
    await conn.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, rate, amount) VALUES (?,?,?,?,?)`,
      [invoiceId, invoiceLine(booking), 1, subtotal, subtotal]);

    // ---- PURCHASE voucher (what we owe the airline / hotel) ----
    let purchaseVoucherId: number | null = null;
    let purchaseVoucherNo: string | null = null;
    const cost = round2(Number(booking.cost_price));
    if (cost > 0 && booking.supplier_id) {
      const supplierLedgerId = await supplierLedger(conn, companyId, Number(booking.supplier_id));
      const costLedgerId = await findLedgerId(conn, companyId, SYSTEM_LEDGERS.COST_OF_SERVICES);
      const purchase = await postVoucherTx(conn, companyId, userId, {
        type: 'PURCHASE', date: invoiceDate, reference: booking.booking_no as string,
        narration: `Supplier cost for booking ${booking.booking_no}`,
        entries: [
          { ledgerId: costLedgerId, type: 'DR', amount: cost, note: 'Cost of services' },
          { ledgerId: supplierLedgerId, type: 'CR', amount: cost, note: 'Payable to supplier' },
        ],
      }, { policy });
      purchaseVoucherId = purchase.voucherId;
      purchaseVoucherNo = purchase.voucherNo;
    }

    await conn.query(
      `UPDATE bookings SET status = 'CONFIRMED', invoice_id = ?, purchase_voucher_id = ? WHERE id = ?`,
      [invoiceId, purchaseVoucherId, bookingId]);

    return {
      invoiceId, invoiceNo, invoiceDate, subtotal, discount, vatPercent, vatAmount, total,
      salesVoucherId: sales.voucherId, salesVoucherNo: sales.voucherNo,
      purchaseVoucherId, purchaseVoucherNo,
    };
  },

  /**
   * Unwinds EVERY accounting entry confirmation created, then voids the
   * invoice. Reversals are posted, never deleted, so the original vouchers and
   * their mirrors both stay on the books.
   *
   * Idempotent per voucher: anything already reversed is skipped rather than
   * reversed twice, so a retry after a partial failure cannot double-post.
   */
  async reverseBookingAccountingTx(
    conn: PoolConnection, companyId: number, userId: number,
    booking: Row, policy: BooksPolicy, reason?: string, date?: string
  ): Promise<BookingReversal> {
    const invoice = booking.invoice_id
      ? await lockInvoice(conn, companyId, Number(booking.invoice_id))
      : undefined;

    // The sales voucher is the one the invoice was raised against.
    const salesVoucherId = invoice?.voucher_id ? Number(invoice.voucher_id) : null;
    const options = {
      reason: reason ?? `Cancellation of booking ${booking.booking_no}`,
      date, policy,
    };

    const salesReversal = await financialReversalService.reverseIfActiveTx(
      conn, companyId, userId, salesVoucherId, options);

    const purchaseReversal = await financialReversalService.reverseIfActiveTx(
      conn, companyId, userId,
      booking.purchase_voucher_id ? Number(booking.purchase_voucher_id) : null, options);

    let invoiceVoided = false;
    if (invoice && invoice.status !== 'VOID') {
      await conn.query(`UPDATE invoices SET status = 'VOID' WHERE id = ?`, [invoice.id]);
      invoiceVoided = true;
    }

    return { salesReversal, purchaseReversal, invoiceVoided };
  },
};

// ------------------------------- helpers ------------------------------------

function invoiceLine(b: Row): string {
  const d = typeof b.details === 'string' ? safeJson(b.details) : ((b.details as Record<string, any>) ?? {});
  const extra = [d.pnr && `PNR ${d.pnr}`, d.route, d.hotel, d.package, b.travel_date && `Travel ${b.travel_date}`]
    .filter(Boolean).join(', ');
  const label = { FLIGHT: 'Air Ticket', HOTEL: 'Hotel Booking', TOUR: 'Tour Package' }[b.booking_type as string]
    ?? 'Travel Service';
  return `${label} — ${b.booking_no}${extra ? ` (${extra})` : ''}`;
}

function safeJson(s: string): Record<string, any> {
  try { return JSON.parse(s); } catch { return {}; }
}

async function lockInvoice(conn: PoolConnection, companyId: number, invoiceId: number): Promise<Row | undefined> {
  const [rows] = await conn.query<Row[]>(
    'SELECT * FROM invoices WHERE id = ? AND company_id = ? FOR UPDATE', [invoiceId, companyId]);
  return rows[0];
}

async function customerLedger(conn: PoolConnection, companyId: number, customerId: number): Promise<number> {
  const [rows] = await conn.query<Row[]>(
    'SELECT ledger_id FROM customers WHERE company_id = ? AND id = ?', [companyId, customerId]);
  if (!rows.length) throw ApiError.badRequest('Customer does not exist');
  return rows[0].ledger_id as number;
}

async function supplierLedger(conn: PoolConnection, companyId: number, supplierId: number): Promise<number> {
  const [rows] = await conn.query<Row[]>(
    'SELECT ledger_id FROM suppliers WHERE company_id = ? AND id = ?', [companyId, supplierId]);
  if (!rows.length) throw ApiError.badRequest('Supplier does not exist');
  return rows[0].ledger_id as number;
}
