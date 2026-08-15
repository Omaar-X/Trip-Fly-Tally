import { query, withTransaction, Row, WriteResult } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { round2, round3 } from '../../utils/money';
import { nextDocNo } from '../../utils/numbering';
import { postVoucherTx } from '../accounting/accounting.service';
import { financialYearOf, loadBooksPolicyTx } from '../accounting/fiscalPeriod.service';
import { ListQuery, Paged, limitOffset, orderBy, paged } from '../../utils/paging';

/** Columns the invoice list may be sorted by, mapped to safe SQL. */
const INVOICE_SORTS: Record<string, string> = {
  invoice_no: 'i.invoice_no',
  invoice_date: 'i.invoice_date',
  due_date: 'i.due_date',
  total: 'i.total',
  paid_amount: 'i.paid_amount',
  due: '(i.total - i.paid_amount)',
  status: 'i.status',
  customer_name: 'c.name',
};

export interface ManualInvoiceInput {
  customerId: number;
  invoiceDate: string;
  dueDate?: string;
  incomeLedgerId: number;          // which Sales ledger the revenue credits
  discount?: number;
  vatPercent?: number;
  items: { description: string; quantity: number; rate: number }[];
}

export const invoicesService = {
  async list(
    companyId: number,
    filters: { status?: string; customerId?: number; q?: string },
    page: ListQuery
  ): Promise<Paged<Row>> {
    const where: string[] = ['i.company_id = ?'];
    const params: unknown[] = [companyId];
    if (filters.status) { where.push('i.status = ?'); params.push(filters.status); }
    if (filters.customerId) { where.push('i.customer_id = ?'); params.push(filters.customerId); }
    if (filters.q) { where.push('(i.invoice_no LIKE ? OR c.name LIKE ?)'); params.push(`%${filters.q}%`, `%${filters.q}%`); }

    const from = `FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN bookings b ON b.id = i.booking_id
        WHERE ${where.join(' AND ')}`;

    const [{ total }] = await query<Row[]>(`SELECT COUNT(*) AS total ${from}`, params);
    const [limit, offset] = limitOffset(page);

    const rows = await query<Row[]>(
      `SELECT i.id, i.invoice_no, i.invoice_date, i.due_date, i.subtotal, i.discount,
              i.vat_percent, i.vat_amount, i.total, i.paid_amount,
              (i.total - i.paid_amount) AS due, i.status,
              c.id AS customer_id, c.name AS customer_name, b.booking_no
         ${from}
        ORDER BY ${orderBy(page, INVOICE_SORTS, 'i.id DESC')}
        LIMIT ? OFFSET ?`, [...params, limit, offset]);

    return paged(rows, page, Number(total));
  },

  async get(companyId: number, id: number) {
    const rows = await query<Row[]>(
      `SELECT i.*, (i.total - i.paid_amount) AS due,
              c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
              c.address AS customer_address, b.booking_no, v.voucher_no
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN bookings b ON b.id = i.booking_id
         LEFT JOIN vouchers v ON v.id = i.voucher_id
        WHERE i.company_id = ? AND i.id = ?`, [companyId, id]);
    if (!rows.length) throw ApiError.notFound('Invoice not found');
    const items = await query<Row[]>(
      `SELECT description, quantity, rate, amount FROM invoice_items WHERE invoice_id = ? ORDER BY id`, [id]);
    const payments = await query<Row[]>(
      `SELECT payment_no, method, amount, payment_date FROM payments
        WHERE invoice_id = ? ORDER BY payment_date, id`, [id]);
    return { ...rows[0], items, payments };
  },

  /**
   * Manual invoice (not booking-driven) — e.g. visa processing fees, service
   * charges. Posts the same SALES voucher pattern as a confirmed booking.
   */
  async createManual(companyId: number, userId: number, input: ManualInvoiceInput) {
    if (!input.items.length) throw ApiError.badRequest('Invoice needs at least one line item');

    // Each line is rounded to what will actually be STORED, and the amount is
    // then computed from those stored figures. Deriving the amount from the
    // raw input instead — as this did — printed invoices whose lines did not
    // foot: quantity 1.333 stored as 1.33 against a rate of 3 showed an amount
    // of 4.00 where 1.33 x 3 is 3.99. A tax invoice that does not add up is a
    // defective document, not a rounding nicety.
    //
    // Quantity keeps 3 decimals to match invoice_items.quantity DECIMAL(12,3);
    // rate and amount keep 2, like every other money column.
    const lines = input.items.map(it => {
      const quantity = round3(it.quantity);
      const rate = round2(it.rate);
      return { description: it.description, quantity, rate, amount: round2(quantity * rate) };
    });
    if (lines.some(l => !(l.quantity > 0))) throw ApiError.badRequest('Every line quantity must be positive');
    if (lines.some(l => l.amount <= 0)) throw ApiError.badRequest('Every line amount must be positive');

    const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const discount = round2(input.discount ?? 0);
    if (discount < 0 || discount > subtotal) throw ApiError.badRequest('Invalid discount');
    const vatPercent = round2(input.vatPercent ?? 0);
    const taxable = round2(subtotal - discount);
    const vatAmount = round2(taxable * vatPercent / 100);
    const total = round2(taxable + vatAmount);
    // Mirrors priceBooking's guard. Without it a 100% discount produced a
    // zero-value invoice that failed deep inside the voucher engine with
    // "line amount must be greater than zero" — a message about a voucher the
    // caller never mentioned.
    if (total <= 0)
      throw ApiError.badRequest('Invoice total must be greater than zero after discount');
    if (input.dueDate && input.dueDate < input.invoiceDate)
      throw ApiError.badRequest(
        `Due date ${input.dueDate} is before the invoice date ${input.invoiceDate}`);

    return withTransaction(async (conn) => {
      const policy = await loadBooksPolicyTx(conn, companyId);
      const [custRows] = await conn.query<Row[]>(
        `SELECT id, name, ledger_id FROM customers WHERE company_id = ? AND id = ?`,
        [companyId, input.customerId]);
      if (!custRows.length) throw ApiError.badRequest('Customer does not exist');
      const customer = custRows[0];

      const [ledRows] = await conn.query<Row[]>(
        `SELECT l.id FROM ledgers l JOIN ledger_groups g ON g.id = l.group_id
          WHERE l.company_id = ? AND l.id = ? AND g.nature = 'INCOME'`,
        [companyId, input.incomeLedgerId]);
      if (!ledRows.length) throw ApiError.badRequest('incomeLedgerId must be an INCOME ledger');

      const entries = [
        { ledgerId: customer.ledger_id as number, type: 'DR' as const, amount: total, note: `Invoice to ${customer.name}` },
        { ledgerId: input.incomeLedgerId, type: 'CR' as const, amount: taxable, note: 'Service revenue' }
      ];
      if (vatAmount > 0) {
        const [vatRows] = await conn.query<Row[]>(
          `SELECT id FROM ledgers WHERE company_id = ? AND name = 'VAT Payable'`, [companyId]);
        if (!vatRows.length) throw ApiError.badRequest('VAT Payable ledger missing — run seed.sql');
        entries.push({ ledgerId: vatRows[0].id as number, type: 'CR' as const, amount: vatAmount, note: `VAT ${vatPercent}%` });
      }
      const voucher = await postVoucherTx(conn, companyId, userId, {
        type: 'SALES', date: input.invoiceDate,
        narration: `Manual invoice for ${customer.name}`, entries
      }, { policy });

      const invoiceNo = await nextDocNo(
        conn, companyId, 'INVOICE', financialYearOf(input.invoiceDate, policy.fyStartMonth));
      const [invRes] = await conn.query<WriteResult>(
        `INSERT INTO invoices (company_id, invoice_no, customer_id, invoice_date, due_date,
                               subtotal, discount, vat_percent, vat_amount, total, voucher_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [companyId, invoiceNo, input.customerId, input.invoiceDate, input.dueDate ?? null,
         subtotal, discount, vatPercent, vatAmount, total, voucher.voucherId]);
      const invoiceId = invRes.insertId;
      const values = lines.map(l => [invoiceId, l.description, l.quantity, l.rate, l.amount]);
      await conn.query(
        `INSERT INTO invoice_items (invoice_id, description, quantity, rate, amount) VALUES ?`, [values]);

      return { id: invoiceId, invoiceNo, subtotal, discount, vatPercent, vatAmount, total,
               voucherNo: voucher.voucherNo };
    });
  }
};
