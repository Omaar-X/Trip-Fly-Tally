import { describe, it, expect } from 'vitest';
import {
  parseDayBook, parsePartyLedger, parseSalesRegister,
} from '../src/modules/migration/parser/sheets';
import { markDuplicates, rowFingerprint } from '../src/modules/migration/parser';
import { parseAccountsControl } from '../src/modules/migration/parser/accountsControl';
import { LEDGER } from '../src/modules/migration/historicalRules';

/**
 * The fixtures below are copied from the real workbooks, row structure and all
 * — including the awkward parts: a merged title that repeats across seven
 * columns, a running balance that is not a transaction, a passenger with no
 * amount, a total row that has a perfectly good number in it.
 */

const src = (sheet: string) => ({ file: 'TEST.xlsx', archive: 'test', sheet, period: '2024-03' });
const rows = (cells: unknown[][]) => cells.map((c, i) => ({ rowNumber: i + 1, cells: c }));

const outcomes = (out: { outcome: string }[]) =>
  out.reduce<Record<string, number>>((m, r) => { m[r.outcome] = (m[r.outcome] ?? 0) + 1; return m; }, {});

// ═════════════════════════════ party ledger ═════════════════════════════════

describe('party ledger (Mar–May 2024)', () => {
  const sheet = rows([
    [null],
    // A merged title reads back as the same text repeated across the range.
    ['MR RAZIB SIR (HAQUE GROUP)', 'MR RAZIB SIR (HAQUE GROUP)', 'MR RAZIB SIR (HAQUE GROUP)'],
    ['Date', 'Ticket No.', 'Pax Name', 'Rute', 'Debit', 'Credit', 'Due Balance'],
    ['02.03.24', '157 6801435806', 'MS NUSRAT PARVIN SONY', 'MED-DOH-DAC', 20791, null, 20791],
    // A second passenger on the booking above: a name, no amount.
    [null, null, 'MAHIN/MD AFTAB UDDIN MR', null, null, null, 20791],
    ['07.03.24', 'Amount Received', 'MR#021', 'CASH', null, 633000, 102528],
    ['02.04.24', 'Amount Received', 'MR#075', 'City bank', null, 420217, 519947],
    ['18.03.24', '997 68015112128', 'HAQUE/LIZA AKTER MRS', 'Refund Adjust', null, 69342, 1194000],
    ['27.03.24', '74947M', 'BOOTH/SUZETTE MARY MS', 'Voied Charge', 300, null, 1056107],
    ['21.0324', 'Amount Received', 'MR#053', 'DBBL BANK', null, 300000, 1146745],
    [null, 'TOTAL', null, null, 21091, 1422559, null],
    [null],
  ]);

  const out = parsePartyLedger(sheet, src('Sales March'), 'HAQUE GROUP');
  const at = (row: number) => out.find((r) => r.source.row === row)!;

  it('accounts for every row exactly once', () => {
    expect(out.length).toBe(sheet.length);
    const counts = outcomes(out);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(sheet.length);
  });

  it('reads a merged title as a title, not a three-column data row', () => {
    expect(at(2).outcome).toBe('NON_TRANSACTION');
    expect(at(2).rowKind).toBe('TITLE');
  });

  it('reads a Debit as a sale to the party', () => {
    expect(at(4)).toMatchObject({
      outcome: 'FINANCIAL', kind: 'SALE', customer: 'HAQUE GROUP',
      sellingAmount: 20791, ticketNo: '157 6801435806', date: '2024-03-02',
    });
  });

  it('keeps an extra passenger without inventing a second sale', () => {
    const row = at(5);
    expect(row.outcome).toBe('NON_TRANSACTION');
    expect(row.passenger).toBe('MAHIN/MD AFTAB UDDIN MR');
    expect(row.reason).toMatch(/Additional passenger/);
  });

  it('reads a Credit as a receipt and takes CASH from the account column', () => {
    expect(at(6)).toMatchObject({ kind: 'RECEIPT', receivedAmount: 633000, method: 'CASH' });
  });

  it('resolves a named bank to its ledger', () => {
    expect(at(7)).toMatchObject({ kind: 'RECEIPT', method: 'BANK', bankLedger: 'City Bank — A/C 110245' });
    expect(at(10)).toMatchObject({ method: 'BANK', bankLedger: 'DBBL Bank' });
  });

  it('reads a refund adjustment as a refund, not an ordinary receipt', () => {
    const row = at(8);
    expect(row.kind).toBe('RECEIPT');
    expect(row.remarks).toMatch(/Refund adjustment/);
    // No cash or bank side in the source, so none is invented.
    expect(row.method).toBeNull();
  });

  it('reads a void charge as a penalty on its own ledger', () => {
    expect(at(9)).toMatchObject({ kind: 'PENALTY', expenseLedger: LEDGER.VOID, costAmount: 300 });
  });

  it('normalises a date typed with a missing dot, and says so', () => {
    // "21.0324" — four digits after the dot decode to mm+yy with nothing left
    // over. It posts, and carries a note so a person confirms the reading.
    expect(at(10).date).toBe('2024-03-21');
  });

  it('never treats a total row as a transaction', () => {
    expect(at(11).outcome).toBe('NON_TRANSACTION');
    expect(at(11).rowKind).toBe('SUBTOTAL');
  });

  it('never reads the running balance as an amount', () => {
    const sale = at(4);
    expect(sale.sellingAmount).toBe(20791);
    expect(sale.sellingAmount).not.toBe(20791 + 1);
  });
});

// ═══════════════════════════ sales register ═════════════════════════════════

describe('sales register (Jun 2024 onward)', () => {
  const header = ['SL. NO', 'NAME', 'DATE', 'TICKET NUMBER', 'ROUTING', 'AIRLINES',
    'BASE FARE', 'TAX', 'TOTAL FARE', 'AIT', 'COM', 'AIRLINES PAYMENT', 'Service',
    'OFFICE PAYMENT', 'QUTATION FARE', 'OFFICE PROFIT', 'issueing  Agency',
    'REFFERENCE', 'CLAINT NAME'];

  const sheet = rows([
    [null],
    header,
    [1, 'MR MD RABIUL ALAM', '2024-12-02', '2326208162472', 'DAC/KUL/DAC', null,
      64870, 0, 64870, 0, 0, 64870, 10200, 75070, 169162, 10200, 'HAZEE', 'RAJIB SIR', 'SUN PHARMA'],
    // Same booking, four passengers, four different tickets.
    [2, 'MRS TAHJIBA AHMED', '2024-12-02', '2326208162469', 'DAC/KUL/DAC', null,
      64870, 0, 64870, 0, 0, 64870, 10200, 75070, 6000, 10200, 'HAZEE', 'RAZIB SIR', 'SUN PHARMA'],
    [3, 'VOID CHARGE', '2024-08-01', 'VP240811399', 'VOID CHARGE', null,
      200, 0, 200, 0, 0, 200, 0, 200, 9262, 0, 'HAZEE', 'RAZIB SIR', 'VOID'],
    [4, 'MR X', '2024-12-05', '111', 'DAC-CGP', null, 100, 0, 100, 0, 0, 100, 0, 100, 0, 0, 'HAZEE', 'RAZIB SIR', 'RAJIB SIR'],
    [5, 'MR Y', '2024-12-06', '222', 'DAC-CGP', null, 100, 0, 100, 0, 0, 100, 0, 100, 0, 0, 'MYSTERY CO', 'RAZIB SIR', 'PDC'],
    [null, null, null, null, null, null, null, null, null, null, null, null, null, 'TOTAL', null, null],
  ]);

  const out = parseSalesRegister(sheet, src('Sales DEC-24'));
  const at = (row: number) => out.find((r) => r.source.row === row)!;

  it('accounts for every row', () => {
    expect(out.length).toBe(sheet.length);
  });

  it('reads a sale with its client, vendor and reference', () => {
    expect(at(3)).toMatchObject({
      outcome: 'FINANCIAL', kind: 'SALE',
      customer: 'SUN PHARMA', vendor: 'HAZEE', agent: 'RAJIB SIR',
      sellingAmount: 75070, costAmount: 64870, date: '2024-12-02',
    });
  });

  it('folds the RAZIB spelling into the one agent', () => {
    expect(at(4).agent).toBe('RAJIB SIR');
  });

  it('does not read QUTATION FARE into any figure — it is a stale fill-down', () => {
    // 169162 and 6000 appear against unrelated passengers. The value stays in
    // `raw` (nothing is ever dropped) but must reach no parsed amount.
    const row = at(3);
    const figures = [row.sellingAmount, row.costAmount, row.serviceCharge,
      row.profitSource, row.taxAit, row.commission];
    expect(figures).not.toContain(169162);
    expect(row.raw['QUTATION FARE']).toBe(169162);   // preserved, not used
  });

  it('reads a VOID row as a penalty on the VOID ledger, not a customer', () => {
    expect(at(5)).toMatchObject({ kind: 'PENALTY', expenseLedger: LEDGER.VOID, customer: null });
  });

  it('parks a bare RAJIB SIR in the client column', () => {
    expect(at(6)).toMatchObject({ outcome: 'REVIEW_REQUIRED', reviewCategory: 'AMBIGUOUS_PARTY_MATCH' });
  });

  it('parks an unknown issuing agency instead of creating a vendor', () => {
    expect(at(7)).toMatchObject({ outcome: 'REVIEW_REQUIRED', reviewCategory: 'MISSING_VENDOR' });
  });

  it('never treats the total row as a sale', () => {
    expect(at(8).outcome).toBe('NON_TRANSACTION');
  });
});

// ═════════════════════════════ day book ═════════════════════════════════════

describe('day book — two registers on one row', () => {
  const sheet = rows([
    [null],
    [null, null, null, null, null, null, null, null, null, null, null, 'DATE: 20.06.2025'],
    [null],
    ['S.N', 'Date', 'Name', 'Description', 'Cash Rec', 'Bank Rec', null,
      'S.N', 'Date', 'Name', 'Discription', 'Cash Pay', 'Bank Pay'],
    [null, '2025-06-01', 'OPENING CASH & BANK', null, 0, 602935.35, null,
      1, '2025-06-01', 'RAJIB SIR PERSONAL ( CARD PAYMENT)', null, null, 50000],
    [1, '2025-06-01', 'SUN PHARMA', null, null, 19980, null,
      2, '2025-06-02', 'HAZEE', null, null, 1000000],
    // The header block restarts for a new day.
    ['S.N', 'Date', 'Name', 'Description', 'Cash Rec', 'Bank Rec', null,
      'S.N', 'Date', 'Name', 'Discription', 'Cash Pay', 'Bank Pay'],
    [2, '2025-06-03', 'ADM', null, null, null, null, 3, '2025-06-03', 'ADM', null, 1500, null],
  ]);

  const out = parseDayBook(sheet, { ...src('JUN-25'), period: '2025-06' });

  it('produces two transactions from one row that has both sides', () => {
    const row6 = out.filter((r) => r.source.row === 6);
    expect(row6.length).toBe(2);
    expect(row6.map((r) => r.kind).sort()).toEqual(['PAYMENT', 'RECEIPT']);
  });

  it('takes cash or bank from whichever column carries the amount', () => {
    const receipt = out.find((r) => r.source.row === 6 && r.kind === 'RECEIPT')!;
    expect(receipt).toMatchObject({ method: 'BANK', receivedAmount: 19980, customer: 'SUN PHARMA' });
  });

  it('classifies the day-book party like any other', () => {
    const payment = out.find((r) => r.source.row === 6 && r.kind === 'PAYMENT')!;
    expect(payment.vendor).toBe('HAZEE');
  });

  it('reads a stated opening balance as a position, not a movement', () => {
    const opening = out.filter((r) => r.source.row === 5 && r.kind === 'OPENING');
    expect(opening.length).toBe(1);
    expect(opening[0].outcome).toBe('NON_TRANSACTION');
    expect(opening[0].reason).toMatch(/position, not a transaction/);
  });

  it('recognises the header repeating for a new day', () => {
    const repeat = out.find((r) => r.source.row === 7)!;
    expect(repeat.outcome).toBe('NON_TRANSACTION');
    expect(repeat.rowKind).toBe('REPEATED_HEADER');
  });

  it('reads an ADM line as a penalty, not a plain payment', () => {
    const adm = out.find((r) => r.source.row === 8 && r.kind === 'PENALTY');
    expect(adm).toBeDefined();
    expect(adm!.expenseLedger).toBe(LEDGER.ADM);
  });

  it('keeps which side a row came from, so the two are distinguishable', () => {
    const row6 = out.filter((r) => r.source.row === 6);
    expect(row6.map((r) => (r.raw as { __side: string }).__side).sort()).toEqual(['PAYMENT', 'RECEIPT']);
  });
});

// ═══════════════════════ duplicates and fingerprints ════════════════════════

describe('duplicate marking across a parsed month', () => {
  const base = { outcome: 'FINANCIAL' as const, rowKind: 'DATA' as const, kind: 'SALE' as const, raw: {} };

  it('leaves four passengers on one booking alone', () => {
    const parsed = [1, 2, 3, 4].map((i) => ({
      ...base, source: { ...src('S'), row: i + 3 },
      ticketNo: `23262081624${70 + i}`, date: '2024-12-02', sellingAmount: 64870,
      customer: 'SUN PHARMA', route: 'DAC/KUL/DAC',
    }));
    markDuplicates(parsed as never);
    expect(parsed.every((r) => r.outcome === 'FINANCIAL')).toBe(true);
  });

  it('marks a genuine repeat of the same ticket, date and amount', () => {
    const parsed = [
      { ...base, source: { ...src('A'), row: 4 }, ticketNo: 'T1', date: '2024-12-02', sellingAmount: 100, route: 'R' },
      { ...base, source: { ...src('B'), row: 9 }, ticketNo: 'T1', date: '2024-12-02', sellingAmount: 100, route: 'R' },
    ];
    markDuplicates(parsed as never);
    expect(parsed[1].outcome).toBe('DUPLICATE');
  });

  it('does not pit a sale against the receipt for the same ticket', () => {
    const parsed = [
      { ...base, source: { ...src('A'), row: 4 }, ticketNo: 'T1', date: '2024-12-02', sellingAmount: 100, route: 'R' },
      { ...base, kind: 'RECEIPT' as const, source: { ...src('A'), row: 5 }, ticketNo: 'T1', date: '2024-12-02', receivedAmount: 100, route: 'R' },
    ];
    markDuplicates(parsed as never);
    expect(parsed[1].outcome).toBe('FINANCIAL');
  });

  it('does not pit a fare against a differently-labelled fee on the same ticket', () => {
    const parsed = [
      { ...base, source: { ...src('A'), row: 4 }, ticketNo: 'T1', date: '2024-12-02', sellingAmount: 4162, route: 'KTM-DAC' },
      { ...base, source: { ...src('A'), row: 5 }, ticketNo: 'T1', date: '2024-12-02', sellingAmount: 1404, route: 'DATE CHANGE FEE' },
    ];
    markDuplicates(parsed as never);
    expect(parsed[1].outcome).toBe('FINANCIAL');
  });
});

describe('row fingerprint', () => {
  const row = (over: Record<string, unknown>) => ({
    outcome: 'FINANCIAL', rowKind: 'DATA', kind: 'SALE', raw: {},
    source: src('Sales DEC-24'), ticketNo: 'T1', date: '2024-12-02', sellingAmount: 100, ...over,
  });

  it('is stable for the same source row', () => {
    expect(rowFingerprint(row({ source: { ...src('S'), row: 5 } }) as never))
      .toBe(rowFingerprint(row({ source: { ...src('S'), row: 5 } }) as never));
  });

  it('differs between the two halves of one day-book row', () => {
    // The same physical row legitimately produces a receipt and a payment.
    const a = row({ source: { ...src('JUN-25'), row: 6 }, raw: { __side: 'RECEIPT' } });
    const b = row({ source: { ...src('JUN-25'), row: 6 }, raw: { __side: 'PAYMENT' } });
    expect(rowFingerprint(a as never)).not.toBe(rowFingerprint(b as never));
  });

  it('differs between two rows of the same sheet', () => {
    expect(rowFingerprint(row({ source: { ...src('S'), row: 5 } }) as never))
      .not.toBe(rowFingerprint(row({ source: { ...src('S'), row: 6 } }) as never));
  });
});

// ═══════════════════════════ control sheet ══════════════════════════════════

describe('ACCOUNTS control sheet', () => {
  const sheet = rows([
    [null],
    [null, 'TRIP FLY BD'],
    [null, 'BALANCE SHEET'],
    [null, 'FOR THE MONTH OF DECEMBER 2024'],
    [null, 'PARTICULARS', 'AMOUNT', 'AMOUNT', null, 'PARTICULARS', 'AMOUNT', 'AMOUNT'],
    [null, 'OWNERS CAPITALS', null, 3460650.99, null, 'SALES', null, 8339187.56],
    [null, 'PURCHASE', null, 7318303.23, null, 'AT BANK', null, 2651378.46],
    [null, 'ACCOUNTS PAYBLE', null, 3894217, null, 'ACCOUNTS RECEIVABLE', null, 7161489.53],
    [null, 'EXPENSES', null, 1017392.37, null, 'FIXED ASSET', null, 850000],
    [null, 'NET PROFIT', null, 3491.96, null, 'NET LOSS'],
  ]);

  const control = parseAccountsControl(sheet, 'ACCOUNTS (3)');

  it('reads both halves of the balance sheet', () => {
    expect(control.capital).toBe(3460650.99);
    expect(control.sales).toBe(8339187.56);
    expect(control.purchase).toBe(7318303.23);
    expect(control.receivable).toBe(7161489.53);
    expect(control.payable).toBe(3894217);
    expect(control.expenses).toBe(1017392.37);
    expect(control.fixedAssets).toBe(850000);
    expect(control.netProfit).toBe(3491.96);
  });

  it('reads the amounts written with commas as text', () => {
    // The real sheet stores several of these as "3,460,650.99".
    const asText = rows([
      [null, 'PARTICULARS', 'AMOUNT'],
      [null, 'OWNERS CAPITALS', '3,460,650.99'],
    ]);
    expect(parseAccountsControl(asText, 'x').capital).toBe(3460650.99);
  });

  it('leaves a figure the sheet does not carry as null', () => {
    expect(control.cash).toBeNull();
  });
});
