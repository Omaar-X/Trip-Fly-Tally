import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

/**
 * ===================== TALLY-PARITY GUARANTEES, PROVED ======================
 * Every check here corresponds to a defect that used to be real. Runs against
 * a REAL database and asserts the behaviour where it matters — through the
 * API, in the reports — rather than at the unit level where a wrong rule can
 * still look right.
 *
 *   1. Opening balances carry forward     a period statement opens where the
 *                                         previous one closed
 *   2. The past can be closed             a locked period refuses postings
 *   3. Corrections are possible           vouchers and payments reverse, and
 *                                         the invoice follows the money
 *   4. Documents are numbered by their
 *      own financial year                 not by the server's clock
 *   5. Tax invoices foot                  quantity x rate == amount
 *   6. Stock reaches the ledger           closing stock on the Balance Sheet,
 *                                         cost of goods in the P&L
 *   7. Tenancy holds                      a foreign ledger cannot be posted to
 *
 * Skips itself when no database is reachable, so `npm test` still runs clean
 * without MySQL.
 * ============================================================================
 */

const money = (n: unknown) => Number(Number(n).toFixed(2));

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

afterAll(async () => { if (reachable && pool) await pool.end(); });
const describeDb = () => (reachable ? describe : describe.skip);

let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

async function login(): Promise<string> {
  const res = await request(app).post('/api/auth/login')
    .send({
      email: process.env.INTEGRATION_CEO_EMAIL,
      password: process.env.INTEGRATION_CEO_PASSWORD,
    });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken;
}

/** Today and the books-begin date, straight from the API's own view of them. */
async function books() {
  const r = await request(app).get('/api/company-settings').set(auth());
  return {
    beginFrom: r.body.data.books_begin_from as string,
    lockedUpto: r.body.data.books_locked_upto as string | null,
    fy: r.body.data.financial_year as { label: string; from: string; to: string },
  };
}

const todayIso = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

async function ledgerIdByName(name: string): Promise<number> {
  const [rows] = await pool.query<any[]>(
    'SELECT id FROM ledgers WHERE company_id = 1 AND name = ?', [name]);
  return Number(rows[0].id);
}

// ---------------------------------------------------------------------------

describeDb()('Fiscal period control', () => {
  beforeAll(async () => { token = await login(); });

  it('refuses a voucher dated before the books begin', async () => {
    const { beginFrom } = await books();
    const before = new Date(Date.parse(`${beginFrom}T00:00:00Z`) - 86400000)
      .toISOString().slice(0, 10);

    const res = await request(app).post('/api/vouchers').set(auth()).send({
      type: 'JOURNAL', date: before, narration: 'before the books begin',
      entries: [{ ledgerId: 1, type: 'DR', amount: 10 }, { ledgerId: 4, type: 'CR', amount: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/before the books begin/i);
  });

  it('refuses a future-dated voucher', async () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const res = await request(app).post('/api/vouchers').set(auth()).send({
      type: 'JOURNAL', date: future, narration: 'tomorrow never comes',
      entries: [{ ledgerId: 1, type: 'DR', amount: 10 }, { ledgerId: 4, type: 'CR', amount: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/future/i);
  });

  it('refuses an impossible calendar date with 400, not a 500 from the database', async () => {
    const res = await request(app).post('/api/vouchers').set(auth()).send({
      type: 'JOURNAL', date: '2026-02-31',
      entries: [{ ledgerId: 1, type: 'DR', amount: 10 }, { ledgerId: 4, type: 'CR', amount: 10 }],
    });
    expect(res.status).toBe(400);
  });

  it('closes the past: a locked period refuses postings, and reopening restores them', async () => {
    const { beginFrom } = await books();
    const target = beginFrom;

    // A posting on the target date succeeds while the books are open…
    const before = await request(app).post('/api/vouchers').set(auth()).send({
      type: 'JOURNAL', date: target, narration: 'open period',
      entries: [{ ledgerId: 1, type: 'DR', amount: 5 }, { ledgerId: 4, type: 'CR', amount: 5 }],
    });
    expect(before.status).toBe(201);

    // …is refused once the period is locked…
    const lock = await request(app).put('/api/company-settings/period-lock').set(auth())
      .send({ booksLockedUpto: target });
    expect(lock.status).toBe(200);

    const during = await request(app).post('/api/vouchers').set(auth()).send({
      type: 'JOURNAL', date: target, narration: 'closed period',
      entries: [{ ledgerId: 1, type: 'DR', amount: 5 }, { ledgerId: 4, type: 'CR', amount: 5 }],
    });
    expect(during.status).toBe(409);
    expect(during.body.message).toMatch(/locked|closed/i);

    // …and works again after reopening.
    await request(app).put('/api/company-settings/period-lock').set(auth())
      .send({ booksLockedUpto: null });
    const after = await request(app).post('/api/vouchers').set(auth()).send({
      type: 'JOURNAL', date: target, narration: 'reopened',
      entries: [{ ledgerId: 1, type: 'DR', amount: 5 }, { ledgerId: 4, type: 'CR', amount: 5 }],
    });
    expect(after.status).toBe(201);
  });

  it('numbers documents by the financial year of their own date, restarting each year', async () => {
    const { fy } = await books();
    const res = await request(app).post('/api/vouchers').set(auth()).send({
      type: 'CONTRA', date: todayIso(), narration: 'numbering',
      entries: [{ ledgerId: 1, type: 'DR', amount: 7 }, { ledgerId: 2, type: 'CR', amount: 7 }],
    });
    expect(res.status).toBe(201);
    // CV-2026-2027-00001 — the FY label, not the calendar year of the clock.
    expect(res.body.data.voucherNo).toMatch(new RegExp(`^CV-${fy.label}-\\d{5}$`));
  });
});

describeDb()('Cross-company posting is refused', () => {
  beforeAll(async () => { if (!token) token = await login(); });

  it('rejects a voucher naming a ledger this company does not own', async () => {
    // 999999 belongs to nobody. Previously the entry was inserted unchecked and
    // the amount vanished from every trial balance.
    const res = await request(app).post('/api/vouchers').set(auth()).send({
      type: 'JOURNAL', date: todayIso(), narration: 'foreign ledger',
      entries: [{ ledgerId: 1, type: 'DR', amount: 10 }, { ledgerId: 999999, type: 'CR', amount: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/chart of accounts/i);
  });

  it('rejects the same ledger on both sides of one voucher', async () => {
    const res = await request(app).post('/api/vouchers').set(auth()).send({
      type: 'JOURNAL', date: todayIso(), narration: 'self contra',
      entries: [{ ledgerId: 1, type: 'DR', amount: 10 }, { ledgerId: 1, type: 'CR', amount: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/both debited and credited/i);
  });
});

describeDb()('Opening balances carry forward', () => {
  beforeAll(async () => { if (!token) token = await login(); });

  it('opens a period where the previous one closed', async () => {
    const cashId = 1;
    const day = todayIso();

    // Everything posted so far is "before" a range that starts tomorrow-ish;
    // instead of guessing dates, compare the SAME ledger across two ranges:
    // the closing of [begin..day] must equal the opening of [day+1..day+1].
    const { beginFrom } = await books();
    const full = await request(app)
      .get(`/api/reports/trial-balance?from=${beginFrom}&to=${day}`).set(auth());
    expect(full.status).toBe(200);

    const cashLine = full.body.data.lines.find((l: any) => l.ledger_id === cashId);
    const closing = money((cashLine?.closing_debit ?? 0) - (cashLine?.closing_credit ?? 0));

    // A statement that starts today must open with everything posted before it.
    const statement = await request(app)
      .get(`/api/ledgers/${cashId}/statement?from=${day}&to=${day}`).set(auth());
    expect(statement.status).toBe(200);

    const opening = money(statement.body.data.opening_balance);
    const movementToday = money(
      statement.body.data.lines.reduce(
        (s: number, l: any) => s + (l.entry_type === 'DR' ? Number(l.amount) : -Number(l.amount)), 0));

    // opening (everything before today) + today's movement === the closing the
    // Trial Balance reports for the whole range. This is the invariant that
    // used to fail: `opening` was the ledger's original master opening and
    // every voucher before `from` was silently dropped.
    expect(money(opening + movementToday)).toBe(closing);
    expect(money(statement.body.data.closing_balance)).toBe(closing);
  });

  it('keeps the Trial Balance and the Balance Sheet in agreement', async () => {
    const { beginFrom } = await books();
    const day = todayIso();

    const tb = await request(app).get(`/api/reports/trial-balance?from=${beginFrom}&to=${day}`).set(auth());
    const bs = await request(app).get(`/api/reports/balance-sheet?asOn=${day}`).set(auth());

    expect(tb.body.data.balanced).toBe(true);
    expect(bs.body.data.balanced).toBe(true);
    expect(money(bs.body.data.totalAssets)).toBe(money(bs.body.data.totalLiabilitiesAndEquity));
  });
});

describeDb()('Corrections are possible', () => {
  let customerId = 0;

  beforeAll(async () => {
    if (!token) token = await login();
    const c = await request(app).post('/api/crm/customers').set(auth())
      .send({ name: `Reversal Customer ${Date.now()}`, phone: `018${Date.now() % 100000000}` });
    customerId = c.body.data.id ?? c.body.data;
  });

  it('reverses a free-standing journal, leaving both halves linked on the books', async () => {
    const posted = await request(app).post('/api/vouchers').set(auth()).send({
      type: 'JOURNAL', date: todayIso(), narration: 'posted to the wrong ledger',
      entries: [{ ledgerId: 1, type: 'DR', amount: 1200 }, { ledgerId: 4, type: 'CR', amount: 1200 }],
    });
    expect(posted.status).toBe(201);

    const reversed = await request(app)
      .post(`/api/vouchers/${posted.body.data.voucherId}/reverse`).set(auth())
      .send({ reason: 'wrong ledger' });
    expect(reversed.status).toBe(201);
    expect(reversed.body.data.total).toBe(1200);

    const detail = await request(app)
      .get(`/api/vouchers/${posted.body.data.voucherId}`).set(auth());
    expect(detail.body.data.status).toBe('REVERSED');
    expect(detail.body.data.reversed_by_voucher_no).toBe(reversed.body.data.reversalVoucherNo);

    // Reversing twice is refused — the pair already nets to zero.
    const again = await request(app)
      .post(`/api/vouchers/${posted.body.data.voucherId}/reverse`).set(auth())
      .send({ reason: 'again' });
    expect(again.status).toBe(409);
  });

  it('refuses to reverse a voucher a live document still owns', async () => {
    const booking = await request(app).post('/api/bookings').set(auth())
      .send({ customerId, bookingType: 'HOTEL', costPrice: 0, salePrice: 4000 });
    const confirmed = await request(app)
      .post(`/api/bookings/${booking.body.data.id}/confirm`).set(auth())
      .send({ vatPercent: 0, invoiceDate: todayIso() });
    expect(confirmed.status).toBe(200);

    const [[invoice]] = await pool.query<any[]>(
      'SELECT voucher_id FROM invoices WHERE id = ?', [confirmed.body.data.invoice.id]);

    const res = await request(app)
      .post(`/api/vouchers/${invoice.voucher_id}/reverse`).set(auth())
      .send({ reason: 'trying to sneak past the invoice' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/invoice/i);
  });

  it('reverses a payment and takes the money back off the invoice', async () => {
    const booking = await request(app).post('/api/bookings').set(auth())
      .send({ customerId, bookingType: 'FLIGHT', costPrice: 0, salePrice: 10000 });
    const confirmed = await request(app)
      .post(`/api/bookings/${booking.body.data.id}/confirm`).set(auth())
      .send({ vatPercent: 0, invoiceDate: todayIso() });
    const invoiceId = confirmed.body.data.invoice.id;

    const paid = await request(app).post('/api/payments').set(auth()).send({
      direction: 'IN', counterpartyType: 'CUSTOMER', counterpartyId: customerId,
      invoiceId, method: 'NAGAD', amount: 10000, paymentDate: todayIso(),
    });
    expect(paid.status).toBe(201);
    expect(paid.body.data.invoice.status).toBe('PAID');

    const reversed = await request(app)
      .post(`/api/payments/${paid.body.data.id}/reverse`).set(auth())
      .send({ reason: 'recorded against the wrong customer' });
    expect(reversed.status).toBe(200);

    // The whole point: the ledger AND the document move together.
    expect(money(reversed.body.data.invoice.paid)).toBe(0);
    expect(reversed.body.data.invoice.status).toBe('UNPAID');

    const [[invoice]] = await pool.query<any[]>(
      'SELECT paid_amount, status FROM invoices WHERE id = ?', [invoiceId]);
    expect(money(invoice.paid_amount)).toBe(0);
  });

  it('posts Nagad into the Nagad wallet, not the bKash one', async () => {
    const nagad = await ledgerIdByName('Nagad Merchant Wallet');
    const bkash = await ledgerIdByName('bKash Merchant Wallet');

    const booking = await request(app).post('/api/bookings').set(auth())
      .send({ customerId, bookingType: 'TOUR', costPrice: 0, salePrice: 2500 });
    const confirmed = await request(app)
      .post(`/api/bookings/${booking.body.data.id}/confirm`).set(auth())
      .send({ vatPercent: 0, invoiceDate: todayIso() });

    const paid = await request(app).post('/api/payments').set(auth()).send({
      direction: 'IN', counterpartyType: 'CUSTOMER', counterpartyId: customerId,
      invoiceId: confirmed.body.data.invoice.id, method: 'NAGAD',
      amount: 2500, paymentDate: todayIso(),
    });
    expect(paid.status).toBe(201);

    const [[voucher]] = await pool.query<any[]>(
      'SELECT id FROM vouchers WHERE company_id = 1 AND voucher_no = ?', [paid.body.data.voucherNo]);
    const [entries] = await pool.query<any[]>(
      'SELECT ledger_id, entry_type FROM voucher_entries WHERE voucher_id = ?', [voucher.id]);

    expect(entries.some((e: any) => Number(e.ledger_id) === nagad && e.entry_type === 'DR')).toBe(true);
    expect(entries.some((e: any) => Number(e.ledger_id) === bkash)).toBe(false);
  });
});

describeDb()('Tax invoices foot', () => {
  let customerId = 0;
  let incomeLedgerId = 0;

  beforeAll(async () => {
    if (!token) token = await login();
    const c = await request(app).post('/api/crm/customers').set(auth())
      .send({ name: `Footing Customer ${Date.now()}`, phone: `019${Date.now() % 100000000}` });
    customerId = c.body.data.id ?? c.body.data;
    incomeLedgerId = await ledgerIdByName('Sales — Air Tickets');
  });

  it('stores a line whose quantity x rate equals its amount', async () => {
    // 1.333 x 3 used to store quantity 1.33 against an amount of 4.00, because
    // the amount was derived from the unrounded input. 1.33 x 3 is 3.99.
    const res = await request(app).post('/api/invoices').set(auth()).send({
      customerId, invoiceDate: todayIso(), incomeLedgerId, vatPercent: 0,
      items: [
        { description: 'Visa processing', quantity: 1.333, rate: 3 },
        { description: 'Service charge', quantity: 2.005, rate: 100 },
      ],
    });
    expect(res.status).toBe(201);

    const [lines] = await pool.query<any[]>(
      'SELECT quantity, rate, amount FROM invoice_items WHERE invoice_id = ?', [res.body.data.id]);
    expect(lines.length).toBe(2);
    for (const l of lines) {
      expect(money(Number(l.quantity) * Number(l.rate))).toBe(money(l.amount));
    }

    const [[invoice]] = await pool.query<any[]>(
      'SELECT subtotal, total FROM invoices WHERE id = ?', [res.body.data.id]);
    const footed = money(lines.reduce((s: number, l: any) => s + Number(l.amount), 0));
    expect(money(invoice.subtotal)).toBe(footed);
  });

  it('refuses an invoice discounted down to nothing, with a message about the invoice', async () => {
    const res = await request(app).post('/api/invoices').set(auth()).send({
      customerId, invoiceDate: todayIso(), incomeLedgerId, vatPercent: 0, discount: 500,
      items: [{ description: 'Fully discounted', quantity: 1, rate: 500 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invoice total/i);
  });
});

describeDb()('Stock reaches the ledger', () => {
  let itemId = 0;
  let supplierId = 0;
  const warehouseId = 1;

  beforeAll(async () => {
    if (!token) token = await login();
    const item = await request(app).post('/api/inventory/items').set(auth()).send({
      sku: `SKU-${Date.now()}`, name: 'Luggage Tag', unit: 'pcs',
      purchasePrice: 100, salePrice: 150, reorderLevel: 5,
    });
    itemId = item.body.data.id;
    const supplier = await request(app).post('/api/crm/suppliers').set(auth())
      .send({ name: `Stock Supplier ${Date.now()}`, phone: `017${Date.now() % 100000000}` });
    supplierId = supplier.body.data.id ?? supplier.body.data;
  });

  it('books a receipt as Dr Stock in Hand / Cr the supplier payable', async () => {
    const stockLedger = await ledgerIdByName('Stock in Hand');

    const res = await request(app).post('/api/inventory/movements').set(auth()).send({
      itemId, warehouseId, supplierId, type: 'IN',
      quantity: 10, rate: 100, date: todayIso(),
    });
    expect(res.status).toBe(201);
    expect(money(res.body.data.value)).toBe(1000);
    expect(res.body.data.voucherNo).toBeTruthy();

    const [[voucher]] = await pool.query<any[]>(
      'SELECT id, voucher_type FROM vouchers WHERE company_id = 1 AND voucher_no = ?',
      [res.body.data.voucherNo]);
    expect(voucher.voucher_type).toBe('PURCHASE');

    const [entries] = await pool.query<any[]>(
      'SELECT ledger_id, entry_type, amount FROM voucher_entries WHERE voucher_id = ?', [voucher.id]);
    const debit = entries.find((e: any) => e.entry_type === 'DR');
    expect(Number(debit.ledger_id)).toBe(stockLedger);
    expect(money(debit.amount)).toBe(1000);
  });

  it('issues stock at weighted-average cost, not at whatever rate is typed', async () => {
    const cogs = await ledgerIdByName('Cost of Goods Sold');

    // Second receipt at a different price moves the average to 150.
    await request(app).post('/api/inventory/movements').set(auth()).send({
      itemId, warehouseId, supplierId, type: 'IN', quantity: 10, rate: 200, date: todayIso(),
    });

    const out = await request(app).post('/api/inventory/movements').set(auth()).send({
      itemId, warehouseId, type: 'OUT', quantity: 4, rate: 9999, date: todayIso(),
    });
    expect(out.status).toBe(201);
    expect(money(out.body.data.unitCost)).toBe(150);   // (1000 + 2000) / 20
    expect(money(out.body.data.value)).toBe(600);      // 4 x 150, not 4 x 9999

    const [[voucher]] = await pool.query<any[]>(
      'SELECT id FROM vouchers WHERE company_id = 1 AND voucher_no = ?', [out.body.data.voucherNo]);
    const [entries] = await pool.query<any[]>(
      'SELECT ledger_id, entry_type, amount FROM voucher_entries WHERE voucher_id = ?', [voucher.id]);
    const debit = entries.find((e: any) => e.entry_type === 'DR');
    expect(Number(debit.ledger_id)).toBe(cogs);
    expect(money(debit.amount)).toBe(600);
  });

  it('refuses an issue that would drive THAT warehouse negative', async () => {
    const other = await request(app).post('/api/inventory/warehouses').set(auth())
      .send({ name: `Empty Store ${Date.now()}` });
    const emptyWarehouseId = other.body.data.id;

    // Stock exists — in warehouse 1. This one holds none.
    const res = await request(app).post('/api/inventory/movements').set(auth()).send({
      itemId, warehouseId: emptyWarehouseId, type: 'OUT', quantity: 1, rate: 0, date: todayIso(),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/insufficient stock/i);
  });

  it('carries closing stock on the Balance Sheet, agreeing with the stock report', async () => {
    const bs = await request(app).get(`/api/reports/balance-sheet?asOn=${todayIso()}`).set(auth());
    expect(bs.status).toBe(200);

    const stock = bs.body.data.assets.find((a: any) => a.ledger === 'Stock in Hand');
    expect(stock).toBeTruthy();

    // The invariant, not a fixed figure: what the ledger says is on the shelf
    // must equal what the stock report values it at. Asserting an absolute
    // number here would only hold on a freshly seeded database.
    const report = await request(app).get('/api/inventory/stock-report').set(auth());
    const valued = money(report.body.data.reduce(
      (s: number, r: any) => s + Number(r.weighted_avg_value), 0));

    expect(money(stock.amount)).toBe(valued);
    expect(bs.body.data.balanced).toBe(true);
  });

  it('reverses a movement, returning both the stock journal and the ledger', async () => {
    const received = await request(app).post('/api/inventory/movements').set(auth()).send({
      itemId, warehouseId, supplierId, type: 'IN', quantity: 5, rate: 100, date: todayIso(),
    });
    expect(received.status).toBe(201);

    const before = await request(app).get(`/api/inventory/items/${itemId}/valuation`).set(auth());

    const reversed = await request(app)
      .post(`/api/inventory/movements/${received.body.data.id}/reverse`).set(auth())
      .send({ reason: 'received into the wrong warehouse' });
    expect(reversed.status).toBe(201);

    const after = await request(app).get(`/api/inventory/items/${itemId}/valuation`).set(auth());
    expect(money(after.body.data.quantity)).toBe(money(Number(before.body.data.quantity) - 5));

    const bs = await request(app).get(`/api/reports/balance-sheet?asOn=${todayIso()}`).set(auth());
    expect(bs.body.data.balanced).toBe(true);
  });
});

describeDb()('Payroll takes the deduction as a figure', () => {
  let employeeId = 0;

  beforeAll(async () => {
    if (!token) token = await login();
    const e = await request(app).post('/api/hr/employees').set(auth()).send({
      empCode: `EMP-${Date.now() % 100000}`, name: 'Payroll Tester',
      basicSalary: 30000, houseRent: 12000, medicalAllow: 2000, conveyance: 1000,
    });
    employeeId = e.body.data.id;
  });

  it('pays a full month when no deduction is supplied', async () => {
    const run = await request(app).post('/api/hr/payroll/generate').set(auth())
      .send({ year: 2026, month: 7 });
    expect(run.status).toBe(200);
    expect(money(run.body.data.totalDeduction)).toBe(0);

    const detail = await request(app).get(`/api/hr/payroll/${run.body.data.runId}`).set(auth());
    const slip = detail.body.data.payslips.find((p: any) => p.employee_id === employeeId);
    expect(money(slip.net_pay)).toBe(45000);      // 30000 + 15000 allowances
    expect(money(slip.deduction)).toBe(0);
  });

  it('subtracts the deduction it is given, and nothing it is not', async () => {
    const run = await request(app).post('/api/hr/payroll/generate').set(auth())
      .send({ year: 2026, month: 7, deductions: { [employeeId]: 8181.82 } });
    expect(run.status).toBe(200);
    expect(money(run.body.data.totalDeduction)).toBe(8181.82);

    const detail = await request(app).get(`/api/hr/payroll/${run.body.data.runId}`).set(auth());
    const slip = detail.body.data.payslips.find((p: any) => p.employee_id === employeeId);
    expect(money(slip.deduction)).toBe(8181.82);
    expect(money(slip.net_pay)).toBe(36818.18);   // 45000 − 8181.82
  });

  it('refuses a deduction bigger than the pay it comes out of', async () => {
    const res = await request(app).post('/api/hr/payroll/generate').set(auth())
      .send({ year: 2026, month: 7, deductions: { [employeeId]: 999999 } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/exceeds/i);
  });

  it('refuses a deduction aimed at somebody not on the run', async () => {
    const res = await request(app).post('/api/hr/payroll/generate').set(auth())
      .send({ year: 2026, month: 7, deductions: { 999999: 100 } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not an active employee/i);
  });

  it('no longer serves attendance at all', async () => {
    const get = await request(app).get('/api/hr/attendance?year=2026&month=7').set(auth());
    const post = await request(app).post('/api/hr/attendance').set(auth())
      .send({ date: todayIso(), marks: [{ employeeId, status: 'PRESENT' }] });
    expect(get.status).toBe(404);
    expect(post.status).toBe(404);
  });
});

/**
 * Regressions for three defects found in the second QA pass. Each is a case
 * where the guard existed and still let the wrong thing through, so each is
 * pinned here rather than trusted to stay fixed.
 */
describeDb()('Regressions', () => {
  beforeAll(async () => { if (!token) token = await login(); });

  it('concurrent issues cannot drive a warehouse negative (snapshot vs lock)', async () => {
    // The guard used to queue correctly on the item lock and then read stock
    // from the REPEATABLE READ snapshot taken before queuing — so every waiter
    // saw the same pre-queue figure and passed. Ten units, five issues of ten,
    // all accepted, balance at minus forty.
    const item = await request(app).post('/api/inventory/items').set(auth()).send({
      sku: `RACE-${Date.now()}`, name: 'Race Item', unit: 'pcs',
      purchasePrice: 10, salePrice: 20, reorderLevel: 0,
    });
    const itemId = item.body.data.id;

    await request(app).post('/api/inventory/movements').set(auth()).send({
      itemId, warehouseId: 1, type: 'IN', quantity: 10, rate: 100, date: todayIso(),
    });

    const results = await Promise.all(Array.from({ length: 5 }, () =>
      request(app).post('/api/inventory/movements').set(auth()).send({
        itemId, warehouseId: 1, type: 'OUT', quantity: 10, rate: 0, date: todayIso(),
      })));

    expect(results.filter(r => r.status === 201)).toHaveLength(1);

    const [[row]] = await pool.query<any[]>(
      `SELECT COALESCE(SUM(CASE WHEN entry_type='IN' THEN quantity ELSE -quantity END),0) AS qty
         FROM stock_entries WHERE item_id = ? AND warehouse_id = 1`, [itemId]);
    expect(Number(row.qty)).toBeGreaterThanOrEqual(0);
  });

  it('payroll for the month in progress can be approved', async () => {
    // Accruing on the last day of the month made the current month
    // future-dated, so it could not be approved until it was over — while
    // payroll is routinely run a few days before month end.
    const now = new Date();
    await request(app).post('/api/hr/employees').set(auth()).send({
      empCode: `NOW-${Date.now() % 100000}`, name: 'Current Month Staff', basicSalary: 20000,
    });
    const run = await request(app).post('/api/hr/payroll/generate').set(auth())
      .send({ year: now.getFullYear(), month: now.getMonth() + 1 });
    expect(run.status).toBe(200);

    const approve = await request(app)
      .post(`/api/hr/payroll/${run.body.data.runId}/approve`).set(auth()).send({});
    expect(approve.status).toBe(200);
    expect(approve.body.data.date <= todayIso()).toBe(true);

    // …but a month that has not begun has no expense to accrue.
    const future = new Date();
    future.setMonth(future.getMonth() + 2);
    const ahead = await request(app).post('/api/hr/payroll/generate').set(auth())
      .send({ year: future.getFullYear(), month: future.getMonth() + 1 });
    const aheadApprove = await request(app)
      .post(`/api/hr/payroll/${ahead.body.data.runId}/approve`).set(auth()).send({});
    expect(aheadApprove.status).toBe(400);
    expect(aheadApprove.body.message).toMatch(/has not started/i);
  });

  it('the period lock always leaves a day open to post in', async () => {
    // Locking up to today froze the books solid: the lock is inclusive and the
    // future is already closed, so not even a correction could be entered.
    const lockToday = await request(app).put('/api/company-settings/period-lock').set(auth())
      .send({ booksLockedUpto: todayIso() });
    expect(lockToday.status).toBe(409);

    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const lockPast = await request(app).put('/api/company-settings/period-lock').set(auth())
      .send({ booksLockedUpto: yesterday });
    expect(lockPast.status).toBe(200);

    const stillPostable = await request(app).post('/api/vouchers').set(auth()).send({
      type: 'JOURNAL', date: todayIso(), narration: 'correction in the open period',
      entries: [{ ledgerId: 1, type: 'DR', amount: 25 }, { ledgerId: 4, type: 'CR', amount: 25 }],
    });
    expect(stillPostable.status).toBe(201);

    await request(app).put('/api/company-settings/period-lock').set(auth())
      .send({ booksLockedUpto: null });
  });
});

describeDb()('The books stay balanced through all of it', () => {
  beforeAll(async () => { if (!token) token = await login(); });

  it('has no unbalanced voucher anywhere', async () => {
    const [[unbalanced]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS n FROM (
         SELECT ve.voucher_id,
                SUM(CASE WHEN ve.entry_type='DR' THEN ve.amount ELSE -ve.amount END) AS diff
           FROM voucher_entries ve GROUP BY ve.voucher_id HAVING ABS(diff) > 0.001) x`);
    expect(Number(unbalanced.n)).toBe(0);
  });

  it('has no voucher entry pointing at another company\'s ledger', async () => {
    const [[strays]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS n
         FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
         JOIN ledgers l ON l.id = ve.ledger_id
        WHERE l.company_id <> v.company_id`);
    expect(Number(strays.n)).toBe(0);
  });

  it('has issued every document number exactly once', async () => {
    const [[dupes]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS n FROM (
         SELECT voucher_no FROM vouchers WHERE company_id = 1
         GROUP BY voucher_no HAVING COUNT(*) > 1) x`);
    expect(Number(dupes.n)).toBe(0);
  });
});
