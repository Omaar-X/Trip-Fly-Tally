import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * D009 · a negative historical cost is a purchase return, not a purchase.
 *
 * The old poster took `Math.abs(costAmount)` and debited Cost of Services, so a
 * refunded fare booked a SECOND purchase instead of undoing the first — BDT
 * 5,791,795.00 across 80 rows, overstating cost and the payable by twice that.
 *
 * These tests pin the corrected behaviour and, equally, pin that an ordinary
 * positive cost is untouched by the fix.
 */

// vi.mock factories are hoisted above every const, so the spy has to be
// created inside vi.hoisted to exist by the time the factory runs.
const { postVoucherTx } = vi.hoisted(() => ({
  postVoucherTx: vi.fn(async () => ({ voucherId: 101 })),
}));

vi.mock('../src/modules/accounting/accounting.service', () => ({ postVoucherTx }));
vi.mock('../src/modules/accounting/fiscalPeriod.service', () => ({
  loadBooksPolicyTx: vi.fn(async () => ({})),
}));
vi.mock('../src/modules/crm/crm.service', () => ({ nameKey: (v: string) => v.toUpperCase() }));

import { postRow, PostContext } from '../src/modules/migration/poster';
import { NormalizedRow } from '../src/modules/migration/parser';

/**
 * Ledger ids by name, and a customer/supplier that already exist — so the test
 * exercises the posting rules rather than party creation.
 */
const LEDGERS: Record<string, number> = {
  'Sales — Air Tickets': 10,
  'Cost of Services': 20,
  'Unknown / Unassigned Ticket Supplier': 30,
};

const conn = {
  query: vi.fn(async (sql: string, params: unknown[]) => {
    if (/FROM ledgers WHERE company_id/.test(sql)) {
      const id = LEDGERS[String(params[1])];
      return [id ? [{ id }] : [], []];
    }
    if (/FROM customers/.test(sql)) return [[{ id: 1, ledger_id: 40 }], []];
    if (/FROM suppliers/.test(sql)) return [[{ id: 2, ledger_id: 50 }], []];
    return [[], []];
  }),
} as never;

const ctx = (): PostContext => ({
  companyId: 1, userId: 1, batchId: 1, policy: {} as never,
  ledgers: new Map(), customers: new Map(), suppliers: new Map(), agents: new Map(),
  dryRun: false,
});

const saleRow = (over: Partial<NormalizedRow> = {}): NormalizedRow => ({
  outcome: 'FINANCIAL', kind: 'SALE', rowKind: 'DATA',
  source: { file: 'f.xlsx', archive: '', sheet: 'Sales FEB 25', row: 114, period: '2025-02' },
  raw: {}, date: '2025-02-27',
  customer: 'DESIGHNER FASHION', customerText: 'DESIGHNER FASHION',
  ticketNo: '1763022849870',
  sellingAmount: 100000, costAmount: 90000,
  ...over,
});

/** The entries of the nth postVoucherTx call, plus its voucher type. */
const call = (n: number) => {
  const [, , , input] = postVoucherTx.mock.calls[n] as unknown as [unknown, unknown, unknown, {
    type: string; entries: { ledgerId: number; type: string; amount: number }[];
  }];
  return input;
};
const side = (n: number, ledgerId: number) =>
  call(n).entries.find((e) => e.ledgerId === ledgerId);

beforeEach(() => { vi.clearAllMocks(); postVoucherTx.mockResolvedValue({ voucherId: 101 }); });

describe('D009 · a positive cost is still an ordinary purchase', () => {
  it('posts SALES then PURCHASE, debiting Cost of Services', async () => {
    await postRow(conn, ctx(), saleRow());

    expect(call(0).type).toBe('SALES');
    expect(call(1).type).toBe('PURCHASE');
    expect(side(1, LEDGERS['Cost of Services'])).toMatchObject({ type: 'DR', amount: 90000 });
    expect(side(1, LEDGERS['Unknown / Unassigned Ticket Supplier'])).toMatchObject({ type: 'CR', amount: 90000 });
  });
});

describe('D009 · a negative cost is a purchase return', () => {
  it('never becomes a PURCHASE through Math.abs', async () => {
    await postRow(conn, ctx(), saleRow({ sellingAmount: -745248, costAmount: -745248 }));
    const types = postVoucherTx.mock.calls.map((_, i) => call(i).type);
    expect(types).not.toContain('PURCHASE');
  });

  it('posts DEBIT_NOTE: Dr supplier clearing, Cr Cost of Services', async () => {
    await postRow(conn, ctx(), saleRow({ sellingAmount: -745248, costAmount: -745248 }));

    expect(call(1).type).toBe('DEBIT_NOTE');
    expect(side(1, LEDGERS['Cost of Services'])).toMatchObject({ type: 'CR', amount: 745248 });
    expect(side(1, LEDGERS['Unknown / Unassigned Ticket Supplier'])).toMatchObject({ type: 'DR', amount: 745248 });
  });

  it('credits the named supplier rather than the clearing account when the source names one', async () => {
    await postRow(conn, ctx(), saleRow({ sellingAmount: -50000, costAmount: -50000, vendor: 'HAZEE' }));
    expect(call(1).type).toBe('DEBIT_NOTE');
    expect(side(1, 50)).toMatchObject({ type: 'DR', amount: 50000 });
    expect(side(1, LEDGERS['Cost of Services'])).toMatchObject({ type: 'CR', amount: 50000 });
  });

  it('pairs the reversed sale with the reversed cost on the same source reference', async () => {
    await postRow(conn, ctx(), saleRow({ sellingAmount: -745248, costAmount: -745248 }));

    // Sales side reverses: Dr Sales, Cr customer.
    expect(call(0).type).toBe('CREDIT_NOTE');
    expect(side(0, LEDGERS['Sales — Air Tickets'])).toMatchObject({ type: 'DR', amount: 745248 });
    expect(side(0, 40)).toMatchObject({ type: 'CR', amount: 745248 });

    // Both vouchers carry the same source reference, so the pair stays linked.
    expect((call(0) as unknown as { reference: string }).reference)
      .toBe((call(1) as unknown as { reference: string }).reference);
  });

  it('handles a negative cost against a positive sale independently', async () => {
    // The two sides are decided separately: this row sold at a positive fare
    // and had its cost credited back, and each side follows its own sign.
    await postRow(conn, ctx(), saleRow({ sellingAmount: 4562, costAmount: -1097 }));
    expect(call(0).type).toBe('SALES');
    expect(call(1).type).toBe('DEBIT_NOTE');
    expect(side(1, LEDGERS['Cost of Services'])).toMatchObject({ type: 'CR', amount: 1097 });
  });
});

describe('D009 · the refund label is read from the ticket cell too', () => {
  it('treats a party-ledger REFUND ADJUST credit as a refund, not a cash receipt', async () => {
    const refund: NormalizedRow = {
      outcome: 'FINANCIAL', kind: 'RECEIPT', rowKind: 'DATA',
      source: { file: 'f.xlsx', archive: '', sheet: 'Sales April', row: 83, period: '2024-04' },
      raw: {}, date: '2024-04-30',
      customer: 'HAQUE GROUP', customerText: 'HAQUE GROUP',
      ticketNo: 'REFUND ADJUST', receivedAmount: 20809,
      // No route, no remarks, no payment method — the label is only in the
      // ticket cell, which is where the party ledgers put it.
      route: '', remarks: null, method: null,
    };
    await postRow(conn, ctx(), refund);

    expect(call(0).type).toBe('CREDIT_NOTE');
    expect(side(0, LEDGERS['Sales — Air Tickets'])).toMatchObject({ type: 'DR', amount: 20809 });
    expect(side(0, 40)).toMatchObject({ type: 'CR', amount: 20809 });
    // No cash or bank movement was invented.
    expect(postVoucherTx).toHaveBeenCalledTimes(1);
  });
});
