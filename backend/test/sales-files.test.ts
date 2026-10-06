import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ExcelJS from 'exceljs';
import request from 'supertest';
import { app } from '../src/app';
import { ROLE } from '../src/constants/roles';
import { authHeader } from './helpers/token';
import {
  ParsedSheet, monthFromName, parseWorkbook,
} from '../src/modules/salesFiles/salesFiles.parser';
import { choosePrimaries } from '../src/modules/salesFiles/salesFiles.service';

/**
 * The fixtures below are the real sheet shapes, cut down to a few rows: the
 * two spellings of a party ledger ten months apart, the register with its
 * passenger in NAME and its payer in CLAINT NAME, the consolidator's statement
 * that looks like a ledger until you read the headings, and the price-
 * difference working note that looks like a register until you do the same.
 *
 * Getting any one of those four wrong is not a cosmetic failure: a supplier
 * statement read as sales inverts a month, and a working note read as sales
 * adds a third copy of tickets the register already carries.
 */

let dir: string;

const addSheet = (
  wb: ExcelJS.Workbook, name: string, rows: (string | number | null)[][],
) => {
  const ws = wb.addWorksheet(name);
  rows.forEach((cells, i) => ws.getRow(i + 1).values = [null, ...cells]);
};

async function writeWorkbook(fileName: string,
                             sheets: Record<string, (string | number | null)[][]>) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) addSheet(wb, name, rows);
  const path = join(dir, fileName);
  await wb.xlsx.writeFile(path);
  return path;
}

const REGISTER = [
  [],
  ['SL. NO', 'NAME', 'DATE', 'TICKET NUMBER', 'ROUTING', 'TOTAL FARE',
   'OFFICE PAYMENT', 'CLAINT NAME'],
  [1, 'MR NAFIZ CHOWDHURY', '2025-07-01', '9974883640236', 'DAC/CGP', 5549, 5692, 'ECO SOURCING'],
  [2, 'MS SAMIYA MEHREEN', '2025-07-04', '1764883651868', 'DAC/DXB/JFK', 223721, 223721, 'ECO SOURCING'],
  [3, null, '2025-07-03', 'ADM2607113', null, 11836, 11836, null],
];

const LEDGER_2025 = [
  [],
  [],
  [null, 'NAME', 'DATE', 'TICKET NUMBER', 'ROUTING',
   'OFFICE PAYMENT\nDR', 'PAYMENT\nCR', 'BALANCE'],
  [null, 'MRS JAMILA KHATUN', '2025-07-05', '9975495895398', 'DAC-CCU-DAC', 17772, null, 17772],
  [null, null, '2025-07-08', 'Amount Received', 'CASH', null, 10000, 7772],
  // The balance formula is dragged past the last transaction; these are blank
  // lines, not rows to import.
  [null, null, null, null, null, null, null, 7772],
];

const SUPPLIER = [
  [],
  ['Date', 'Ticket', 'Passenger', 'Sector', 'Debit', 'Credit', 'Balance'],
  ['2025-07-01', 'ADM25099547', null, null, 29400, 0, 2631549],
];

const DIFFERENCE_NOTE = [
  [],
  ['SL. NO', 'NAME', 'DATE', 'TICKET NUMBER', 'ROUTING',
   'HAJEE PAYMENT', 'OFFICE PAYMENT', 'Difference'],
  [1, 'ANISSUJJAMAN/QUAZI MD MR', '2025-07-07', '2352746525438', 'DAC/IST/BUD',
   134673, 133647, 1026],
];

const ACCOUNTS = [
  [],
  ['TRIP FLY BD'],
  ['PARTICULARS', 'AMOUNT', null, 'PARTICULARS', 'AMOUNT'],
  ['OWNERS CAPITALS', 8126010.98, null, 'SALES', 19113906],
];

const LEDGER_2024 = [
  [],
  ['MR RAZIB SIR (HAQUE GROUP)', 'MR RAZIB SIR (HAQUE GROUP)',
   'MR RAZIB SIR (HAQUE GROUP)', 'MR RAZIB SIR (HAQUE GROUP)',
   'MR RAZIB SIR (HAQUE GROUP)', 'MR RAZIB SIR (HAQUE GROUP)',
   'MR RAZIB SIR (HAQUE GROUP)'],
  ['Date', 'Ticket No.', 'Pax Name', 'Rute', 'Debit', 'Credit', 'Due Balance'],
  ['02.03.24', '157 6801435806', 'MS NUSRAT PARVIN SONY', 'MED-DOH-DAC', 20791, null, 20791],
  ['07.03.24', 'Amount Received', 'MR#021', 'CASH', null, 633000, 102528],
];

let julSheets: ParsedSheet[];
let marSheets: ParsedSheet[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tripfly-salesfiles-'));

  const jul = await writeWorkbook('SALES-JUL-25.xlsx', {
    'Sales JUL 25': REGISTER,
    'WASHIM BHAI': LEDGER_2025,
    'RAW SALES.': SUPPLIER,
    'refund wrong entry': DIFFERENCE_NOTE,
    ACCOUNTS,
  });
  const mar = await writeWorkbook('Sales Mar-2024-May-2024.xlsx', {
    'Sales March': LEDGER_2024,
  });

  julSheets = (await parseWorkbook(jul)).sheets;
  marSheets = (await parseWorkbook(mar)).sheets;
});

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const sheet = (sheets: ParsedSheet[], name: string) =>
  sheets.find((s) => s.sheetName === name)!;

// ═══════════════════════════ shape detection ════════════════════════════════

describe('sheet shapes', () => {
  it('says something about every sheet in the workbook', () => {
    expect(julSheets.map((s) => s.sheetName)).toEqual([
      'Sales JUL 25', 'WASHIM BHAI', 'RAW SALES.', 'refund wrong entry', 'ACCOUNTS',
    ]);
    for (const s of julSheets)
      expect(s.shape === 'UNRECOGNISED' ? s.skipReason : 'ok').toBeTruthy();
  });

  it('reads the month register as a register', () => {
    expect(sheet(julSheets, 'Sales JUL 25').shape).toBe('SALES_REGISTER');
  });

  it('reads a party statement as a ledger, and names the party from the tab', () => {
    const s = sheet(julSheets, 'WASHIM BHAI');
    expect(s.shape).toBe('PARTY_LEDGER');
    expect(s.customerName).toBe('WASHIM BHAI');
  });

  it('names the party from the merged banner when the 2024 sheets carry one', () => {
    const s = sheet(marSheets, 'Sales March');
    expect(s.shape).toBe('PARTY_LEDGER');
    expect(s.customerName).toBe('MR RAZIB SIR (HAQUE GROUP)');
  });

  it("refuses the consolidator's statement, with a reason", () => {
    const s = sheet(julSheets, 'RAW SALES.');
    expect(s.shape).toBe('SUPPLIER_STATEMENT');
    expect(s.skipReason).toMatch(/payable to the supplier/i);
    expect(s.rows).toHaveLength(0);
  });

  it('refuses the price-difference working note, with a reason', () => {
    const s = sheet(julSheets, 'refund wrong entry');
    expect(s.shape).toBe('UNRECOGNISED');
    expect(s.skipReason).toMatch(/price/i);
    expect(s.rows).toHaveLength(0);
  });

  it('leaves the balance sheet alone', () => {
    expect(sheet(julSheets, 'ACCOUNTS').shape).toBe('UNRECOGNISED');
  });
});

// ═════════════════════════════ row reading ══════════════════════════════════

describe('rows', () => {
  it('bills a register row to the client, never to the passenger', () => {
    const rows = sheet(julSheets, 'Sales JUL 25').rows;
    expect(rows[0]).toMatchObject({
      rowType: 'TICKET', partyName: 'ECO SOURCING',
      paxName: 'MR NAFIZ CHOWDHURY', debit: 5692, date: '2025-07-01',
    });
  });

  it('leaves a register row with no client unattached rather than guessing', () => {
    const adm = sheet(julSheets, 'Sales JUL 25').rows.find((r) => r.ticketNo === 'ADM2607113');
    expect(adm?.partyName).toBeNull();
  });

  it('tells a payment from a ticket', () => {
    const rows = sheet(julSheets, 'WASHIM BHAI').rows;
    expect(rows.map((r) => r.rowType)).toEqual(['TICKET', 'PAYMENT']);
    expect(rows[1]).toMatchObject({ credit: 10000, debit: 0 });
  });

  it('drops the dragged-down balance formula instead of importing blank rows', () => {
    // The fixture has three rows under the header; the third carries only a
    // balance, and a balance on its own is not a transaction.
    expect(sheet(julSheets, 'WASHIM BHAI').rows).toHaveLength(2);
  });

  it('reads the DD.MM.YY dates the 2024 sheets are written in', () => {
    expect(sheet(marSheets, 'Sales March').rows[0].date).toBe('2024-03-02');
  });

  it('takes the closing balance from the last row that states one', () => {
    expect(sheet(julSheets, 'WASHIM BHAI').closingBalance).toBe(7772);
  });

  it("falls back to the month's own movement when there is no balance column", () => {
    const s = sheet(julSheets, 'Sales JUL 25');
    expect(s.totalCredit).toBe(0);
    expect(s.closingBalance).toBe(s.totalDebit);
  });
});

// ══════════════════════════════ months ══════════════════════════════════════

describe('months', () => {
  it('reads every spelling the folder actually uses', () => {
    expect(monthFromName('sales  JUN-24.xlsx')).toEqual({ year: 2024, month: 6 });
    expect(monthFromName('SALES DECEMBER-24.xlsx')).toEqual({ year: 2024, month: 12 });
    expect(monthFromName('SALES-APR -25.xlsx')).toEqual({ year: 2025, month: 4 });
    expect(monthFromName('SALES-JUN-26(NEW).xlsx')).toEqual({ year: 2026, month: 6 });
    expect(monthFromName('Sales apr 2026')).toEqual({ year: 2026, month: 4 });
    expect(monthFromName('Sales JAN 25 (2)')).toEqual({ year: 2025, month: 1 });
  });

  it('does not mistake a copy suffix for a year', () => {
    expect(monthFromName('WASHIM BHAI (2)')).toBeNull();
  });

  it('files a sheet under the month it names, not the workbook it sits in', () => {
    // `Sales Mar-2024-May-2024.xlsx` spans three months. The workbook name
    // resolves to March 2024 and the sheet names March, so both agree here;
    // the sheet is what decides, which is how the April and May tabs of the
    // same file end up under their own months rather than under March.
    expect(sheet(marSheets, 'Sales March').monthLabel).toBe('MAR-2024');
    expect(sheet(julSheets, 'Sales JUL 25').monthLabel).toBe('JUL-2025');
  });

  it('marks a sheet that names no month of its own as a running total', () => {
    expect(sheet(julSheets, 'WASHIM BHAI').isCumulative).toBe(true);
    expect(sheet(julSheets, 'Sales JUL 25').isCumulative).toBe(false);
    expect(sheet(marSheets, 'Sales March').isCumulative).toBe(false);
  });
});

// ═══════════════════════ which copy of a month counts ═══════════════════════

describe('choosePrimaries', () => {
  const candidate = (id: number, fileName: string, sheetName: string,
                     monthYear: string, totalTickets: number) =>
    ({ id, fileName, sheetName, shape: 'SALES_REGISTER',
       monthYear, customerName: null, totalTickets });

  it('prefers the copy sitting in its own month\'s workbook', () => {
    const winners = choosePrimaries([
      candidate(1, 'SALES-FEB-26.xlsx', 'Sales FEB 2026', '2026-02-01', 189),
      // The fuller sheet — and still the wrong one, because it is a carried
      // copy in March's workbook.
      candidate(2, 'SALES-MAR-26.xlsx', 'Sales FEB 2026', '2026-02-01', 231),
    ]);
    expect([...winners]).toEqual([1]);
  });

  it('honours the recorded January-2025 ruling over the fuller sheet', () => {
    const winners = choosePrimaries([
      candidate(1, 'SALES JAN-25.xlsx', 'Sales JAN 25', '2025-01-01', 106),
      candidate(2, 'SALES JAN-25.xlsx', 'Sales JAN 25 (2)', '2025-01-01', 106),
      candidate(3, 'SALES JAN-25.xlsx', 'Sales JAN 25 (3)', '2025-01-01', 106),
      candidate(4, 'SALES JAN-25.xlsx', 'Sales JAN 25 (4)', '2025-01-01', 108),
    ]);
    expect([...winners]).toEqual([2]);
  });

  it('gives each party its own primary within a month', () => {
    const winners = choosePrimaries([
      { ...candidate(1, 'SALES-JUL-26.xlsx', 'WASHIM BHAI', '2026-07-01', 212),
        shape: 'PARTY_LEDGER', customerName: 'WASHIM BHAI' },
      { ...candidate(2, 'SALES-JUL-26.xlsx', 'TUTUL BHAI (2)', '2026-07-01', 75),
        shape: 'PARTY_LEDGER', customerName: 'TUTUL BHAI' },
      candidate(3, 'SALES-JUL-26.xlsx', 'Sales Jul 2026', '2026-07-01', 246),
    ]);
    expect([...winners].sort()).toEqual([1, 2, 3]);
  });
});

// ════════════════════════════════ access ═══════════════════════════════════

describe('RBAC boundary', () => {
  it('rejects unauthenticated requests', async () => {
    expect((await request(app).get('/api/sales-files')).status).toBe(401);
  });

  it('keeps SALES and HR out of the archive entirely', async () => {
    for (const role of [ROLE.SALES, ROLE.HR] as const) {
      expect((await request(app).get('/api/sales-files').set(authHeader(role))).status).toBe(403);
      expect((await request(app).get('/api/sales-files/balance').set(authHeader(role))).status).toBe(403);
      expect((await request(app).get('/api/sales-files/1/download').set(authHeader(role))).status).toBe(403);
    }
  });

  it('leaves the bulk import to Admin — an Accountant may read, not scan', async () => {
    const res = await request(app).post('/api/sales-files/scan').set(authHeader(ROLE.ACCOUNTANT)).send({});
    expect(res.status).toBe(403);
  });
});
