import { PoolConnection } from 'mysql2/promise';
import { query, withTransaction, Row, WriteResult } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { round2 } from '../../utils/money';
import { today } from '../../utils/date';
import { nextDocNo } from '../../utils/numbering';
import { financialYearOf, loadBooksPolicyTx } from '../accounting/fiscalPeriod.service';
import { bookingAccountingService } from './bookingAccounting.service';
import { ListQuery, Paged, limitOffset, orderBy, paged } from '../../utils/paging';

/** Columns the booking list may be sorted by, mapped to safe SQL. */
const BOOKING_SORTS: Record<string, string> = {
  booking_no: 'b.booking_no',
  booking_type: 'b.booking_type',
  status: 'b.status',
  travel_date: 'b.travel_date',
  sale_price: 'b.sale_price',
  margin: '(b.sale_price - b.cost_price)',
  created_at: 'b.created_at',
  customer_name: 'c.name',
};

export interface CreateBookingInput {
  customerId: number;
  bookingType: 'FLIGHT' | 'HOTEL' | 'TOUR';
  travelDate?: string;
  returnDate?: string;
  details?: Record<string, unknown>;   // PNR, airline, hotel name, pax list…
  costPrice: number;                   // payable to supplier
  salePrice: number;                   // billed to customer
  supplierId?: number;
  agentId?: number;                    // selling employee → commission
}

export interface ConfirmBookingInput {
  vatPercent?: number;                 // e.g. 5 → adds BD VAT on top
  discount?: number;                   // flat discount off sale price
  dueDate?: string;
  invoiceDate?: string;                // revenue recognition date; defaults to today
}

/**
 * Booking lifecycle:
 *   PENDING ──confirm()──▶ CONFIRMED   (auto-invoice + SALES voucher + supplier liability)
 *   PENDING ──cancel()───▶ CANCELLED
 *   CONFIRMED ─cancel()──▶ CANCELLED   (invoice voided, reversing CREDIT_NOTE posted)
 */
export const bookingsService = {
  async list(
    companyId: number,
    filters: { status?: string; type?: string; customerId?: number; q?: string },
    page: ListQuery
  ): Promise<Paged<Row>> {
    const where: string[] = ['b.company_id = ?'];
    const params: unknown[] = [companyId];
    if (filters.status) { where.push('b.status = ?'); params.push(filters.status); }
    if (filters.type) { where.push('b.booking_type = ?'); params.push(filters.type); }
    if (filters.customerId) { where.push('b.customer_id = ?'); params.push(filters.customerId); }
    if (filters.q) { where.push('(b.booking_no LIKE ? OR c.name LIKE ?)'); params.push(`%${filters.q}%`, `%${filters.q}%`); }

    const from = `FROM bookings b
         JOIN customers c ON c.id = b.customer_id
         LEFT JOIN suppliers s ON s.id = b.supplier_id
         LEFT JOIN employees e ON e.id = b.agent_id
         LEFT JOIN invoices  i ON i.id = b.invoice_id
        WHERE ${where.join(' AND ')}`;

    const [{ total }] = await query<Row[]>(`SELECT COUNT(*) AS total ${from}`, params);
    const [limit, offset] = limitOffset(page);

    const rows = await query<Row[]>(
      `SELECT b.id, b.booking_no, b.booking_type, b.status, b.travel_date, b.return_date,
              b.cost_price, b.sale_price, (b.sale_price - b.cost_price) AS margin,
              b.details, b.invoice_id, b.created_at,
              c.id AS customer_id, c.name AS customer_name,
              s.name AS supplier_name, e.name AS agent_name, i.invoice_no
         ${from}
        ORDER BY ${orderBy(page, BOOKING_SORTS, 'b.id DESC')}
        LIMIT ? OFFSET ?`, [...params, limit, offset]);

    return paged(rows, page, Number(total));
  },

  async get(companyId: number, id: number) {
    const rows = await query<Row[]>(
      `SELECT b.*, c.name AS customer_name, c.phone AS customer_phone,
              s.name AS supplier_name, e.name AS agent_name, i.invoice_no
         FROM bookings b
         JOIN customers c ON c.id = b.customer_id
         LEFT JOIN suppliers s ON s.id = b.supplier_id
         LEFT JOIN employees e ON e.id = b.agent_id
         LEFT JOIN invoices  i ON i.id = b.invoice_id
        WHERE b.company_id = ? AND b.id = ?`, [companyId, id]);
    if (!rows.length) throw ApiError.notFound('Booking not found');
    return rows[0];
  },

  /** Customer travel history — every trip ever booked, newest first. */
  async travelHistory(companyId: number, customerId: number) {
    return query<Row[]>(
      `SELECT b.id, b.booking_no, b.booking_type, b.status, b.travel_date, b.return_date,
              b.sale_price, b.details, i.invoice_no
         FROM bookings b LEFT JOIN invoices i ON i.id = b.invoice_id
        WHERE b.company_id = ? AND b.customer_id = ?
        ORDER BY COALESCE(b.travel_date, DATE(b.created_at)) DESC`, [companyId, customerId]);
  },

  async create(companyId: number, userId: number, input: CreateBookingInput) {
    if (input.salePrice < 0 || input.costPrice < 0)
      throw ApiError.badRequest('Prices cannot be negative');
    return withTransaction(async (conn) => {
      const policy = await loadBooksPolicyTx(conn, companyId);
      await assertCustomer(conn, companyId, input.customerId);
      // A booking is not a posting, so it is numbered against the financial
      // year it is RAISED in — the accounting date only appears on confirm.
      const bookingNo = await nextDocNo(
        conn, companyId, 'BOOKING', financialYearOf(today(), policy.fyStartMonth));
      const [res] = await conn.query<WriteResult>(
        `INSERT INTO bookings (company_id, booking_no, customer_id, booking_type, travel_date,
                               return_date, details, cost_price, sale_price, supplier_id, agent_id, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [companyId, bookingNo, input.customerId, input.bookingType, input.travelDate ?? null,
         input.returnDate ?? null, JSON.stringify(input.details ?? {}), round2(input.costPrice),
         round2(input.salePrice), input.supplierId ?? null, input.agentId ?? null, userId]);
      return { id: res.insertId, bookingNo, status: 'PENDING' };
    });
  },

  /**
   * CONFIRM = the money moment. In ONE transaction the invoice is raised and
   * every ledger consequence is posted — see bookingAccountingService, which
   * owns both the posting and its reversal so the two cannot drift apart.
   */
  async confirm(companyId: number, userId: number, bookingId: number, input: ConfirmBookingInput) {
    return withTransaction(async (conn) => {
      const policy = await loadBooksPolicyTx(conn, companyId);
      const booking = await lockBooking(conn, companyId, bookingId);
      if (booking.status !== 'PENDING')
        throw ApiError.conflict(`Only PENDING bookings can be confirmed (current: ${booking.status})`);

      const posting = await bookingAccountingService.postConfirmationTx(
        conn, companyId, userId, booking, input, policy);

      return {
        bookingId, status: 'CONFIRMED',
        invoice: {
          id: posting.invoiceId, invoiceNo: posting.invoiceNo, invoiceDate: posting.invoiceDate,
          subtotal: posting.subtotal,
          discount: posting.discount, vatPercent: posting.vatPercent,
          vatAmount: posting.vatAmount, total: posting.total
        },
        salesVoucherNo: posting.salesVoucherNo,
        purchaseVoucherNo: posting.purchaseVoucherNo
      };
    });
  },

  /**
   * CANCEL. A PENDING booking just flips status. A CONFIRMED booking must also
   * unwind the books — BOTH the sales voucher and the supplier-cost voucher are
   * reversed, and the invoice is voided.
   *
   * Settlement rule: money already collected must go back to the customer
   * first. Refund it with POST /api/payments { direction: 'OUT',
   * counterpartyType: 'CUSTOMER', invoiceId }, which restores the invoice to
   * an unpaid state; the booking can then be cancelled.
   */
  async cancel(companyId: number, userId: number, bookingId: number,
               options: { reason?: string; date?: string } = {}) {
    return withTransaction(async (conn) => {
      const policy = await loadBooksPolicyTx(conn, companyId);
      const booking = await lockBooking(conn, companyId, bookingId);
      if (booking.status === 'CANCELLED') throw ApiError.conflict('Booking is already cancelled');

      let reversal = null;
      if (booking.status === 'CONFIRMED' && booking.invoice_id) {
        await assertNothingLeftToRefund(conn, companyId, Number(booking.invoice_id));
        reversal = await bookingAccountingService.reverseBookingAccountingTx(
          conn, companyId, userId, booking, policy, options.reason, options.date);
      }

      await conn.query(`UPDATE bookings SET status = 'CANCELLED' WHERE id = ?`, [bookingId]);

      return {
        bookingId, status: 'CANCELLED',
        // Retained under its original name: the sales reversal has always been
        // posted as a credit note, and existing clients read this field.
        creditNoteNo: reversal?.salesReversal?.reversalVoucherNo ?? null,
        salesReversalVoucherNo: reversal?.salesReversal?.reversalVoucherNo ?? null,
        purchaseReversalVoucherNo: reversal?.purchaseReversal?.reversalVoucherNo ?? null,
        reversalDate: reversal?.salesReversal?.reversalDate ?? null,
        invoiceVoided: reversal?.invoiceVoided ?? false
      };
    });
  }
};

// ------------------------------- helpers ------------------------------------

async function lockBooking(conn: PoolConnection, companyId: number, id: number): Promise<Row> {
  const [rows] = await conn.query<Row[]>(
    `SELECT * FROM bookings WHERE company_id = ? AND id = ? FOR UPDATE`, [companyId, id]);
  if (!rows.length) throw ApiError.notFound('Booking not found');
  return rows[0];
}

async function assertCustomer(conn: PoolConnection, companyId: number, customerId: number): Promise<void> {
  const [rows] = await conn.query<Row[]>(
    `SELECT id FROM customers WHERE company_id = ? AND id = ?`, [companyId, customerId]);
  if (!rows.length) throw ApiError.badRequest('Customer does not exist');
}

/**
 * Money collected against the invoice must be returned before the sale can be
 * unwound — otherwise the reversal would wipe out a receivable the customer has
 * actually paid, leaving cash on the books with nothing to attribute it to.
 */
async function assertNothingLeftToRefund(
  conn: PoolConnection, companyId: number, invoiceId: number
): Promise<void> {
  const [rows] = await conn.query<Row[]>(
    `SELECT invoice_no, total, paid_amount, status FROM invoices
      WHERE id = ? AND company_id = ? FOR UPDATE`, [invoiceId, companyId]);
  const inv = rows[0];
  if (!inv || inv.status === 'VOID') return;

  const paid = round2(Number(inv.paid_amount));
  if (paid <= 0) return;

  const settled = paid >= round2(Number(inv.total)) ? 'fully paid' : 'partially paid';
  throw ApiError.conflict(
    `Invoice ${inv.invoice_no} is ${settled} (${paid.toFixed(2)} received). ` +
    `Refund it first: POST /api/payments { "direction": "OUT", "counterpartyType": "CUSTOMER", ` +
    `"invoiceId": ${invoiceId}, "amount": ${paid.toFixed(2)} } — then cancel the booking.`);
}
