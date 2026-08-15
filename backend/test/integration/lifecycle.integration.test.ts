import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

/**
 * ====================== END-TO-END LIFECYCLE PROOF ==========================
 * Runs against a REAL database and proves the two accounting-workflow defects
 * are fixed where it actually matters — in the reports.
 *
 *   Booking -> Confirm -> Invoice -> Payment -> Refund -> Cancel
 *
 * and asserts the books return to exactly where they started:
 *   P&L restored · Balance Sheet restored · Trial Balance balanced
 *   Supplier Payable 0 · Customer Receivable 0 · no orphans
 *
 * Requires a migrated database (database/migrations/002_...sql). The whole
 * suite skips itself when no database is reachable, so `npm test` still runs
 * clean on a machine or CI job without MySQL.
 * ============================================================================
 */

const money = (n: unknown) => Number(Number(n).toFixed(2));

// Reachability is settled at module load: `describe.skip` has to be chosen
// while tests are being collected, which happens before any hook runs.
const { app, pool, reachable } = await (async () => {
  try {
    const [{ app }, { pool }] = await Promise.all([
      import('../../src/app'), import('../../src/config/db'),
    ]);
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    return { app, pool, reachable: true };
  } catch (err) {
    console.warn('[integration] no database reachable — skipping:', (err as Error).message);
    return { app: null as any, pool: null as any, reachable: false };
  }
})();

afterAll(async () => {
  if (reachable && pool) await pool.end();
});

const describeDb = () => (reachable ? describe : describe.skip);

// --------------------------------------------------------------------------

let token = '';
let customerId = 0;
let supplierId = 0;

async function login(): Promise<string> {
  const res = await request(app).post('/api/auth/login')
    .send({
      email: process.env.INTEGRATION_CEO_EMAIL,
      password: process.env.INTEGRATION_CEO_PASSWORD,
    });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken;
}

const auth = () => ({ Authorization: `Bearer ${token}` });

const reports = {
  async profitLoss() {
    const r = await request(app).get('/api/reports/profit-loss?from=1900-01-01&to=2099-12-31').set(auth());
    return r.body.data;
  },
  async balanceSheet() {
    const r = await request(app).get('/api/reports/balance-sheet?asOn=2099-12-31').set(auth());
    return r.body.data;
  },
  async trialBalance() {
    const r = await request(app).get('/api/reports/trial-balance?from=1900-01-01&to=2099-12-31').set(auth());
    return r.body.data;
  },
};

/** Every figure the lifecycle must leave exactly as it found it. */
async function snapshot() {
  const [pl, bs, tb] = await Promise.all([
    reports.profitLoss(), reports.balanceSheet(), reports.trialBalance(),
  ]);
  return {
    income: money(pl.totalIncome), expense: money(pl.totalExpense), netProfit: money(pl.netProfit),
    assets: money(bs.totalAssets), liabilities: money(bs.totalLiabilities), equity: money(bs.totalEquity),
    trialBalanced: tb.balanced, sheetBalanced: bs.balanced,
  };
}

/**
 * Net balance of one party's sub-ledger, resolved through the party's own
 * ledger_id. Matching on ledger *name* would be ambiguous — earlier runs leave
 * similarly-named customers behind, each with their own open bookings.
 */
async function partyLedgerBalance(table: 'customers' | 'suppliers', id: number): Promise<number> {
  const [[row]] = await pool.query<any[]>(
    `SELECT COALESCE(SUM(CASE WHEN ve.entry_type = 'DR' THEN ve.amount ELSE -ve.amount END), 0) AS balance
       FROM ${table} p
       JOIN ledgers l ON l.id = p.ledger_id
       LEFT JOIN voucher_entries ve ON ve.ledger_id = l.id
      WHERE p.id = ?`, [id]);
  return money(row.balance);
}

// --------------------------------------------------------------------------

describeDb()('Booking lifecycle restores the books exactly', () => {
  beforeAll(async () => {
    token = await login();
    const stamp = Date.now();
    const c = await request(app).post('/api/crm/customers').set(auth())
      .send({ name: `IT Customer ${stamp}`, email: `it${stamp}@test.local`, phone: '01700000000', creditLimit: 0 });
    customerId = c.body.data.id;
    const s = await request(app).post('/api/crm/suppliers').set(auth())
      .send({ name: `IT Supplier ${stamp}`, email: `its${stamp}@test.local`, phone: '01800000000' });
    supplierId = s.body.data.id;
  });

  it('unwinds an unpaid booking with no residue in any report', async () => {
    const before = await snapshot();

    const booking = await request(app).post('/api/bookings').set(auth()).send({
      customerId, supplierId, bookingType: 'FLIGHT', costPrice: 50000, salePrice: 56500,
    });
    const bookingId = booking.body.data.id;

    const confirmed = await request(app).post(`/api/bookings/${bookingId}/confirm`)
      .set(auth()).send({ vatPercent: 5 });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.salesVoucherNo).toBeTruthy();
    expect(confirmed.body.data.purchaseVoucherNo).toBeTruthy();

    // Confirmation really did move the books.
    const during = await snapshot();
    expect(during.income - before.income).toBe(56500);
    expect(during.expense - before.expense).toBe(50000);

    const cancelled = await request(app).post(`/api/bookings/${bookingId}/cancel`)
      .set(auth()).send({ reason: 'integration test' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.salesReversalVoucherNo).toBeTruthy();
    expect(cancelled.body.data.purchaseReversalVoucherNo).toBeTruthy();
    expect(cancelled.body.data.invoiceVoided).toBe(true);

    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it('completes Booking -> Confirm -> Pay -> Refund -> Cancel with the books restored', async () => {
    const before = await snapshot();

    const booking = await request(app).post('/api/bookings').set(auth()).send({
      customerId, supplierId, bookingType: 'TOUR', costPrice: 30000, salePrice: 40000,
    });
    const bookingId = booking.body.data.id;

    const confirmed = await request(app).post(`/api/bookings/${bookingId}/confirm`)
      .set(auth()).send({ vatPercent: 5 });
    const invoiceId = confirmed.body.data.invoice.id;
    const total = confirmed.body.data.invoice.total;

    // --- customer pays in full ---
    const paid = await request(app).post('/api/payments').set(auth()).send({
      direction: 'IN', counterpartyType: 'CUSTOMER', counterpartyId: customerId,
      invoiceId, method: 'BKASH', amount: total, paymentDate: '2026-08-02',
    });
    expect(paid.status).toBe(201);
    expect(paid.body.data.invoice.status).toBe('PAID');

    // --- cancelling is refused while the money is still held ---
    const blocked = await request(app).post(`/api/bookings/${bookingId}/cancel`).set(auth()).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/refund/i);

    // --- refund releases the invoice (this was previously impossible) ---
    const refunded = await request(app).post('/api/payments').set(auth()).send({
      direction: 'OUT', counterpartyType: 'CUSTOMER', counterpartyId: customerId,
      invoiceId, refundOfPaymentId: paid.body.data.id, method: 'BKASH',
      amount: total, paymentDate: '2026-08-03', reason: 'Customer cancelled the tour',
    });
    expect(refunded.status).toBe(201);
    expect(refunded.body.data.isRefund).toBe(true);
    expect(refunded.body.data.invoice.status).toBe('UNPAID');

    // --- and now the booking cancels ---
    const cancelled = await request(app).post(`/api/bookings/${bookingId}/cancel`)
      .set(auth()).send({ reason: 'Customer cancelled the tour' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.salesReversalVoucherNo).toBeTruthy();
    expect(cancelled.body.data.purchaseReversalVoucherNo).toBeTruthy();

    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.trialBalanced).toBe(true);
    expect(after.sheetBalanced).toBe(true);
  });

  it('leaves no supplier payable and no customer receivable behind', async () => {
    // Both lifecycle bookings above were fully unwound, so this run's customer
    // and supplier must each net to exactly zero.
    expect(await partyLedgerBalance('customers', customerId)).toBe(0);
    expect(await partyLedgerBalance('suppliers', supplierId)).toBe(0);
  });

  it('keeps every voucher on file, linked in both directions', async () => {
    const [rows] = await pool.query<any[]>(
      `SELECT v.id, v.voucher_no, v.voucher_type, v.status,
              v.reversal_of_voucher_id, v.reversed_by_voucher_id, v.reversed_by, v.reversed_at
         FROM vouchers v
        WHERE v.company_id = 1 AND (v.status = 'REVERSED' OR v.reversal_of_voucher_id IS NOT NULL)
        ORDER BY v.id DESC LIMIT 20`);

    expect(rows.length).toBeGreaterThan(0);

    for (const v of rows) {
      if (v.status === 'REVERSED') {
        // A reversed voucher records who unwound it, when, and with what.
        expect(v.reversed_by_voucher_id).toBeTruthy();
        expect(v.reversed_by).toBeTruthy();
        expect(v.reversed_at).toBeTruthy();
      }
      if (v.reversal_of_voucher_id) {
        // A reversal points back at a voucher that is itself marked reversed.
        const [[original]] = await pool.query<any[]>(
          'SELECT status, reversed_by_voucher_id FROM vouchers WHERE id = ?', [v.reversal_of_voucher_id]);
        expect(original.status).toBe('REVERSED');
        expect(Number(original.reversed_by_voucher_id)).toBe(Number(v.id));
      }
    }
  });

  it('has no orphan invoices, payments or vouchers', async () => {
    const [[orphanInvoices]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS n FROM invoices i
        LEFT JOIN customers c ON c.id = i.customer_id WHERE c.id IS NULL`);
    const [[orphanPayments]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS n FROM payments p
        WHERE p.counterparty_type IS NULL OR p.counterparty_id IS NULL`);
    const [[unbalanced]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS n FROM (
         SELECT ve.voucher_id,
                SUM(CASE WHEN ve.entry_type='DR' THEN ve.amount ELSE -ve.amount END) AS diff
           FROM voucher_entries ve GROUP BY ve.voucher_id HAVING ABS(diff) > 0.001) x`);

    expect(Number(orphanInvoices.n)).toBe(0);
    expect(Number(orphanPayments.n)).toBe(0);
    // The invariant that matters most: no voucher anywhere fails debit == credit.
    expect(Number(unbalanced.n)).toBe(0);
  });
});

describeDb()('Concurrency safety is preserved', () => {
  beforeAll(async () => { if (!token) token = await login(); });

  it('accepts exactly one of several simultaneous confirmations', async () => {
    const booking = await request(app).post('/api/bookings').set(auth())
      .send({ customerId, bookingType: 'HOTEL', costPrice: 0, salePrice: 5000 });
    const id = booking.body.data.id;

    const results = await Promise.all(Array.from({ length: 4 }, () =>
      request(app).post(`/api/bookings/${id}/confirm`).set(auth()).send({ vatPercent: 0 })));

    expect(results.filter(r => r.status === 200)).toHaveLength(1);

    const [[invoices]] = await pool.query<any[]>(
      'SELECT COUNT(*) AS n FROM invoices WHERE booking_id = ?', [id]);
    expect(Number(invoices.n)).toBe(1);
  });

  it('accepts exactly one of several simultaneous full payments', async () => {
    const booking = await request(app).post('/api/bookings').set(auth())
      .send({ customerId, bookingType: 'FLIGHT', costPrice: 0, salePrice: 8000 });
    const confirmed = await request(app).post(`/api/bookings/${booking.body.data.id}/confirm`)
      .set(auth()).send({ vatPercent: 0 });
    const invoiceId = confirmed.body.data.invoice.id;

    const results = await Promise.all(Array.from({ length: 5 }, () =>
      request(app).post('/api/payments').set(auth()).send({
        direction: 'IN', counterpartyType: 'CUSTOMER', counterpartyId: customerId,
        invoiceId, method: 'CASH', amount: 8000, paymentDate: '2026-08-02',
      })));

    expect(results.filter(r => r.status === 201)).toHaveLength(1);

    const [[invoice]] = await pool.query<any[]>(
      'SELECT total, paid_amount FROM invoices WHERE id = ?', [invoiceId]);
    expect(money(invoice.paid_amount)).toBeLessThanOrEqual(money(invoice.total));
  });

  it('accepts exactly one of several simultaneous refunds', async () => {
    const booking = await request(app).post('/api/bookings').set(auth())
      .send({ customerId, bookingType: 'TOUR', costPrice: 0, salePrice: 9000 });
    const confirmed = await request(app).post(`/api/bookings/${booking.body.data.id}/confirm`)
      .set(auth()).send({ vatPercent: 0 });
    const invoiceId = confirmed.body.data.invoice.id;

    await request(app).post('/api/payments').set(auth()).send({
      direction: 'IN', counterpartyType: 'CUSTOMER', counterpartyId: customerId,
      invoiceId, method: 'CASH', amount: 9000, paymentDate: '2026-08-02',
    });

    const results = await Promise.all(Array.from({ length: 5 }, () =>
      request(app).post('/api/payments').set(auth()).send({
        direction: 'OUT', counterpartyType: 'CUSTOMER', counterpartyId: customerId,
        invoiceId, method: 'CASH', amount: 9000, paymentDate: '2026-08-03', reason: 'race',
      })));

    // Over-refunding would hand the customer their money back several times.
    expect(results.filter(r => r.status === 201)).toHaveLength(1);

    const [[invoice]] = await pool.query<any[]>(
      'SELECT paid_amount FROM invoices WHERE id = ?', [invoiceId]);
    expect(money(invoice.paid_amount)).toBe(0);
  });

  it('accepts exactly one of several simultaneous cancellations, reversing each voucher once', async () => {
    const booking = await request(app).post('/api/bookings').set(auth())
      .send({ customerId, supplierId, bookingType: 'FLIGHT', costPrice: 4000, salePrice: 6000 });
    const id = booking.body.data.id;
    await request(app).post(`/api/bookings/${id}/confirm`).set(auth()).send({ vatPercent: 0 });

    const results = await Promise.all(Array.from({ length: 4 }, () =>
      request(app).post(`/api/bookings/${id}/cancel`).set(auth()).send({ reason: 'race' })));

    expect(results.filter(r => r.status === 200)).toHaveLength(1);

    const [[reversals]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS n FROM vouchers
        WHERE reversal_of_voucher_id IN (
          SELECT id FROM vouchers WHERE company_id = 1 AND reference = ?)`,
      [booking.body.data.bookingNo]);
    // One sales reversal + one purchase reversal, never doubled.
    expect(Number(reversals.n)).toBe(2);
  });

  it('issues unique document numbers under parallel posting', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      request(app).post('/api/vouchers').set(auth()).send({
        type: 'JOURNAL', date: '2026-08-02', narration: `parallel ${i}`,
        entries: [{ ledgerId: 1, type: 'DR', amount: 10 }, { ledgerId: 4, type: 'CR', amount: 10 }],
      })));

    const numbers = results.filter(r => r.status === 201).map(r => r.body.data.voucherNo);
    expect(numbers).toHaveLength(10);
    expect(new Set(numbers).size).toBe(10);
  });
});
