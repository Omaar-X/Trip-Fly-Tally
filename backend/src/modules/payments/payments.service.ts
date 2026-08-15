import { PoolConnection } from 'mysql2/promise';
import { query, withTransaction, Row, WriteResult } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { round2 } from '../../utils/money';
import { nextDocNo, paymentDocPrefix } from '../../utils/numbering';
import { findLedgerId, moneyLedgerName } from '../../utils/systemLedgers';
import { postVoucherTx } from '../accounting/accounting.service';
import { financialYearOf, loadBooksPolicyTx } from '../accounting/fiscalPeriod.service';
import { financialReversalService } from '../accounting/reversal.service';
import { refundService, SettlementResult } from './refund.service';
import { ListQuery, Paged, limitOffset, orderBy, paged } from '../../utils/paging';

/** Columns the payment list may be sorted by, mapped to safe SQL. */
const PAYMENT_SORTS: Record<string, string> = {
  payment_no: 'p.payment_no',
  direction: 'p.direction',
  method: 'p.method',
  amount: 'p.amount',
  payment_date: 'p.payment_date',
  party: 'COALESCE(c.name, s.name)',
};

export type PaymentDirection = 'IN' | 'OUT';
export type CounterpartyType = 'CUSTOMER' | 'SUPPLIER';
export type PaymentMethod = 'CASH' | 'BANK' | 'BKASH' | 'NAGAD' | 'CARD';

export interface RecordPaymentInput {
  direction: PaymentDirection;
  /** Canonical counterparty. Legacy customerId/supplierId are accepted instead. */
  counterpartyType?: CounterpartyType;
  counterpartyId?: number;
  customerId?: number;     // legacy alias for counterpartyType CUSTOMER
  supplierId?: number;     // legacy alias for counterpartyType SUPPLIER
  invoiceId?: number;      // settle (IN) or unsettle (OUT) a specific invoice
  refundOfPaymentId?: number;
  method: PaymentMethod;
  amount: number;
  paymentDate: string;     // YYYY-MM-DD
  notes?: string;
  reason?: string;         // why a refund was issued
}

/**
 * ============================ MONEY MOVEMENT ENGINE =========================
 * One posting rule covers every movement of money:
 *
 *   IN   Dr Cash/Bank/Wallet     Cr Counterparty ledger
 *   OUT  Dr Counterparty ledger  Cr Cash/Bank/Wallet
 *
 * Combined with the counterparty type that spans all four real cases:
 *
 *   IN  + CUSTOMER   customer pays us        RECEIPT   Dr Cash    Cr Customer A/R
 *   OUT + CUSTOMER   we refund a customer    PAYMENT   Dr Cust A/R Cr Cash
 *   OUT + SUPPLIER   we pay a supplier       PAYMENT   Dr Suppl A/P Cr Cash
 *   IN  + SUPPLIER   supplier credits us     RECEIPT   Dr Cash    Cr Supplier A/P
 *
 * Direction used to be hard-wired — OUT demanded a supplier — which made a
 * customer refund impossible and deadlocked booking cancellation, since
 * cancelling asked for a refund the software could not perform.
 *
 * When an invoiceId is supplied, settlement rolls forward on the way in and
 * back on the way out, inside the same transaction as the voucher.
 * ============================================================================
 */
export const paymentsService = {
  async list(companyId: number, filters: {
    direction?: string; counterpartyType?: string; from?: string; to?: string; q?: string;
  }, page: ListQuery): Promise<Paged<Row>> {
    const where: string[] = ['p.company_id = ?'];
    const params: unknown[] = [companyId];
    if (filters.direction) { where.push('p.direction = ?'); params.push(filters.direction); }
    if (filters.counterpartyType) { where.push('p.counterparty_type = ?'); params.push(filters.counterpartyType); }
    if (filters.from) { where.push('p.payment_date >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('p.payment_date <= ?'); params.push(filters.to); }
    if (filters.q) {
      where.push('(p.payment_no LIKE ? OR c.name LIKE ? OR s.name LIKE ?)');
      params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
    }

    const from = `FROM payments p
         LEFT JOIN customers c ON c.id = p.customer_id
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         LEFT JOIN invoices  i ON i.id = p.invoice_id
         LEFT JOIN vouchers  v ON v.id = p.voucher_id
        WHERE ${where.join(' AND ')}`;

    const [{ total }] = await query<Row[]>(`SELECT COUNT(*) AS total ${from}`, params);
    const [limit, offset] = limitOffset(page);

    const rows = await query<Row[]>(
      `SELECT p.id, p.payment_no, p.direction, p.counterparty_type, p.counterparty_id,
              p.method, p.amount, p.payment_date, p.notes, p.reason, p.refund_of_payment_id,
              c.name AS customer_name, s.name AS supplier_name,
              COALESCE(c.name, s.name) AS counterparty_name,
              i.invoice_no, v.voucher_no,
              -- A payment whose voucher has been mirrored is spent: the UI
              -- shows it as reversed rather than offering to reverse it twice.
              v.status AS voucher_status
         ${from}
        ORDER BY ${orderBy(page, PAYMENT_SORTS, 'p.payment_date DESC, p.id DESC')}
        LIMIT ? OFFSET ?`, [...params, limit, offset]);

    return paged(rows, page, Number(total));
  },

  async record(companyId: number, userId: number, input: RecordPaymentInput) {
    const amount = round2(input.amount);
    if (!(amount > 0)) throw ApiError.badRequest('Amount must be greater than zero');

    const counterparty = resolveCounterparty(input);
    const isRefund = input.direction === 'OUT' && counterparty.type === 'CUSTOMER';

    if (input.invoiceId && counterparty.type !== 'CUSTOMER')
      throw ApiError.badRequest('Only customer payments can be settled against an invoice');

    return withTransaction(async (conn) => {
      const policy = await loadBooksPolicyTx(conn, companyId);
      const moneyLedgerId = await findLedgerId(conn, companyId, moneyLedgerName(input.method));
      const party = await partyRow(conn, counterparty.type, companyId, counterparty.id);
      const partyLedgerId = Number(party.ledger_id);

      // ---- settlement, locked so concurrent movements can't over/under-shoot ----
      let settlement: SettlementResult | null = null;
      if (input.invoiceId) {
        const invoice = await refundService.lockInvoiceForSettlementTx(
          conn, companyId, input.invoiceId, counterparty.id);
        settlement = input.direction === 'IN'
          ? await refundService.applyReceiptTx(conn, invoice, amount)
          : await refundService.applyRefundTx(conn, invoice, amount);
      }

      if (input.refundOfPaymentId)
        await assertRefundableSource(conn, companyId, input.refundOfPaymentId, counterparty);

      // Money arriving FROM a supplier only makes sense against an advance we
      // already paid them; see assertSupplierHasAdvance.
      if (input.direction === 'IN' && counterparty.type === 'SUPPLIER')
        await assertSupplierHasAdvance(conn, companyId, party, partyLedgerId, amount);

      // ---- balanced voucher ----
      const partyNote = describe(input.direction, counterparty.type, party.name as string);
      const voucher = await postVoucherTx(conn, companyId, userId, {
        type: input.direction === 'IN' ? 'RECEIPT' : 'PAYMENT',
        date: input.paymentDate,
        reference: settlement?.invoiceNo,
        narration: `${partyNote} via ${input.method}` +
          `${input.reason ? ` — ${input.reason}` : ''}${input.notes ? ` — ${input.notes}` : ''}`,
        entries: input.direction === 'IN'
          ? [{ ledgerId: moneyLedgerId, type: 'DR', amount, note: input.method },
             { ledgerId: partyLedgerId, type: 'CR', amount, note: partyNote }]
          : [{ ledgerId: partyLedgerId, type: 'DR', amount, note: partyNote },
             { ledgerId: moneyLedgerId, type: 'CR', amount, note: input.method }]
      }, { policy });

      const fy = financialYearOf(input.paymentDate, policy.fyStartMonth);
      const paymentNo = await nextDocNo(conn, companyId, 'PAYMENT_DOC', fy, paymentDocPrefix(isRefund));
      const customerId = counterparty.type === 'CUSTOMER' ? counterparty.id : null;
      const supplierId = counterparty.type === 'SUPPLIER' ? counterparty.id : null;

      const [res] = await conn.query<WriteResult>(
        `INSERT INTO payments (company_id, payment_no, direction, counterparty_type, counterparty_id,
                               customer_id, supplier_id, invoice_id, refund_of_payment_id, method,
                               amount, payment_date, voucher_id, notes, reason, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [companyId, paymentNo, input.direction, counterparty.type, counterparty.id,
         customerId, supplierId, input.invoiceId ?? null, input.refundOfPaymentId ?? null,
         input.method, amount, input.paymentDate, voucher.voucherId,
         input.notes ?? null, input.reason ?? null, userId]);

      return {
        id: res.insertId,
        paymentNo,
        direction: input.direction,
        counterpartyType: counterparty.type,
        counterpartyId: counterparty.id,
        isRefund,
        voucherNo: voucher.voucherNo,
        // `invoice` keeps its original shape so existing clients keep reading it.
        invoice: settlement
          ? { invoiceNo: settlement.invoiceNo, paid: settlement.paid,
              due: settlement.due, status: settlement.status }
          : null
      };
    });
  },

  /**
   * Undo a payment that should never have been recorded — wrong amount, wrong
   * party, wrong method, wrong invoice.
   *
   * Both halves move together inside one transaction: the voucher is mirrored
   * (never edited, never deleted) AND the invoice's collected figure is put
   * back where it was. Correcting only the ledger — the sole option before
   * this existed — left `invoices.paid_amount` permanently disagreeing with
   * the customer's sub-ledger, with no report that would have shown it.
   *
   * The reversal posts in the OPEN period, so a payment recorded into a year
   * that has since been locked can still be corrected without reopening it.
   */
  async reverse(
    companyId: number, userId: number, paymentId: number,
    options: { reason?: string; date?: string } = {}
  ) {
    return withTransaction(async (conn) => {
      const policy = await loadBooksPolicyTx(conn, companyId);

      const [rows] = await conn.query<Row[]>(
        `SELECT * FROM payments WHERE id = ? AND company_id = ? FOR UPDATE`,
        [paymentId, companyId]);
      if (!rows.length) throw ApiError.notFound('Payment not found');
      const payment = rows[0];

      if (!payment.voucher_id)
        throw ApiError.conflict(`Payment ${payment.payment_no} has no voucher to reverse`);

      const reversal = await financialReversalService.reverseVoucherTx(
        conn, companyId, userId, Number(payment.voucher_id),
        { reason: options.reason ?? `Reversal of payment ${payment.payment_no}`,
          date: options.date, policy });

      // Put the invoice back exactly where it stood before this payment.
      let settlement: SettlementResult | null = null;
      if (payment.invoice_id) {
        const [invoices] = await conn.query<Row[]>(
          'SELECT * FROM invoices WHERE id = ? AND company_id = ? FOR UPDATE',
          [payment.invoice_id, companyId]);
        if (invoices.length) {
          settlement = await refundService.reverseSettlementTx(
            conn, invoices[0], payment.direction as PaymentDirection, round2(Number(payment.amount)));
        }
      }

      return {
        id: paymentId,
        paymentNo: payment.payment_no as string,
        reversalVoucherNo: reversal.reversalVoucherNo,
        reversalDate: reversal.reversalDate,
        amount: round2(Number(payment.amount)),
        invoice: settlement
          ? { invoiceNo: settlement.invoiceNo, paid: settlement.paid,
              due: settlement.due, status: settlement.status }
          : null,
      };
    });
  }
};

// ------------------------------- helpers ------------------------------------

interface Counterparty { type: CounterpartyType; id: number; }

/**
 * Accepts either the canonical counterparty pair or the legacy
 * customerId/supplierId fields, and insists on exactly one party.
 */
function resolveCounterparty(input: RecordPaymentInput): Counterparty {
  if (input.counterpartyType && input.counterpartyId)
    return { type: input.counterpartyType, id: input.counterpartyId };

  if (input.customerId && input.supplierId)
    throw ApiError.badRequest('Provide either a customer or a supplier, not both');
  if (input.customerId) return { type: 'CUSTOMER', id: input.customerId };
  if (input.supplierId) return { type: 'SUPPLIER', id: input.supplierId };

  throw ApiError.badRequest(
    'A counterparty is required — send counterpartyType ("CUSTOMER" or "SUPPLIER") with counterpartyId');
}

function describe(direction: PaymentDirection, type: CounterpartyType, name: string): string {
  if (direction === 'IN')
    return type === 'CUSTOMER' ? `Received from ${name}` : `Refund received from ${name}`;
  return type === 'CUSTOMER' ? `Refunded to ${name}` : `Paid to ${name}`;
}

async function partyRow(
  conn: PoolConnection, type: CounterpartyType, companyId: number, id: number
): Promise<Row> {
  const table = type === 'CUSTOMER' ? 'customers' : 'suppliers';
  const [rows] = await conn.query<Row[]>(
    `SELECT id, name, ledger_id FROM ${table} WHERE company_id = ? AND id = ?`, [companyId, id]);
  if (!rows.length)
    throw ApiError.badRequest(`${type === 'CUSTOMER' ? 'Customer' : 'Supplier'} does not exist`);
  return rows[0];
}

/**
 * Money coming IN from a supplier credits their payable account. That is only
 * meaningful when we are already OUT OF POCKET with them — an advance or an
 * overpayment sitting as a debit balance on their ledger — and the credit
 * clears it.
 *
 * With no such advance, the entry manufactures a payable to a supplier we owe
 * nothing: "Sundry Creditors" grows on the Balance Sheet against a supplier
 * who would be baffled to hear it. Customer refunds have been guarded against
 * their mirror image of this since the refund work; the supplier side was
 * left open.
 */
async function assertSupplierHasAdvance(
  conn: PoolConnection, companyId: number, party: Row, ledgerId: number, amount: number
): Promise<void> {
  // Lock the ledger row first, so two concurrent receipts against the same
  // supplier queue up rather than racing.
  const [ledgerRows] = await conn.query<Row[]>(
    'SELECT id, opening_balance, opening_type FROM ledgers WHERE company_id = ? AND id = ? FOR UPDATE',
    [companyId, ledgerId]);
  if (!ledgerRows.length) throw ApiError.badRequest('Supplier ledger not found');
  const ledger = ledgerRows[0];

  // FOR UPDATE, and not for the lock: under REPEATABLE READ a plain SELECT
  // would return the snapshot taken before this transaction queued on the
  // ledger row above, so two concurrent receipts would both measure the same
  // advance and both pass. A locking read sees the latest committed rows.
  const [rows] = await conn.query<Row[]>(
    `SELECT COALESCE(SUM(CASE WHEN ve.entry_type = 'DR' THEN ve.amount ELSE -ve.amount END), 0) AS movement
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id
      WHERE v.company_id = ? AND ve.ledger_id = ?
        FOR UPDATE`,
    [companyId, ledgerId]);

  const opening = Number(ledger.opening_balance) * (ledger.opening_type === 'DR' ? 1 : -1);
  const advance = round2(opening + Number(rows[0]?.movement ?? 0));
  if (amount > advance)
    throw ApiError.badRequest(
      `${party.name} is not holding ${amount.toFixed(2)} of ours — the advance on their account is ` +
      `${Math.max(advance, 0).toFixed(2)}. Receiving more than that would create a payable to a ` +
      `supplier we do not owe. Record it as other income or a customer receipt instead.`);
}

/** A refund must point back at a real, opposite-direction payment from the same party. */
async function assertRefundableSource(
  conn: PoolConnection, companyId: number, paymentId: number, counterparty: Counterparty
): Promise<void> {
  const [rows] = await conn.query<Row[]>(
    'SELECT id, direction, counterparty_type, counterparty_id FROM payments WHERE id = ? AND company_id = ?',
    [paymentId, companyId]);
  if (!rows.length) throw ApiError.badRequest('refundOfPaymentId does not reference a known payment');
  const source = rows[0];
  if (source.counterparty_type !== counterparty.type || Number(source.counterparty_id) !== counterparty.id)
    throw ApiError.badRequest('A refund must be issued to the same counterparty as the original payment');
}
