import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ExcelJS from 'exceljs';
import { ParsedSheet, parseWorkbook } from '../src/modules/salesFiles/salesFiles.parser';

/**
 * ============ THE BUG THIS FILE EXISTS TO STOP COMING BACK =================
 *
 * The monthly registers add themselves up at the foot, and the importer read
 * that line as a sale. On most sheets the total equals the detail above it
 * exactly, so every month came out roughly DOUBLE — 246,538,349.81 billed
 * across the archive against a true 148,596,313.71, and July-2026 reporting
 * 21,713,503 of sales where the office's own balance sheet says 19,113,906.
 *
 * The rows arrive in three disguises and all three are covered below. The
 * third is the one that took the longest to find, because it looks like
 * nothing at all: a bare number in the amount column with every other cell
 * empty. `Sales JAN 25 (2)` row 143 carries 11,501,735.79 that way — exactly
 * half the sheet.
 */

let dir: string;

const HEADER = ['SL. NO', 'NAME', 'DATE', 'TICKET NUMBER', 'ROUTING',
                'TOTAL FARE', 'OFFICE PAYMENT', 'CLAINT NAME'];

/** Column G is OFFICE PAYMENT — the 7th header, plus the leading spacer. */
const PAY_COL = 'H';

async function writeRegister(name: string, extra: (ws: ExcelJS.Worksheet) => void) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sales JUL 25');
  ws.getRow(2).values = [null, ...HEADER];
  ws.getRow(3).values = [null, 1, 'MR A', '2025-07-01', '9971111111111', 'DAC/CGP', 5000, 5000, 'ECO SOURCING'];
  ws.getRow(4).values = [null, 2, 'MR B', '2025-07-02', '9972222222222', 'DAC/DXB', 3000, 3000, 'ECO SOURCING'];
  extra(ws);
  const path = join(dir, name);
  await wb.xlsx.writeFile(path);
  return path;
}

const sheetOf = async (path: string): Promise<ParsedSheet> =>
  (await parseWorkbook(path)).sheets[0];

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'tripfly-totals-')); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('a register that adds itself up', () => {
  it('ignores a SUBTOTAL() row', async () => {
    // Jul-2026 row 281: SUBTOTAL(9,R3:R279).
    const sheet = await sheetOf(await writeRegister('subtotal.xlsx', (ws) => {
      ws.getCell(`${PAY_COL}9`).value =
        { formula: `SUBTOTAL(9,${PAY_COL}3:${PAY_COL}4)`, result: 8000 } as ExcelJS.CellValue;
    }));

    expect(sheet.totalDebit).toBe(8000);
    expect(sheet.totalTickets).toBe(2);
    expect(sheet.rows.find((r) => r.sourceRow === 9)?.rowType).toBe('NON_TRANSACTION');
  });

  it('ignores a SUM() over a range', async () => {
    const sheet = await sheetOf(await writeRegister('sum.xlsx', (ws) => {
      ws.getCell(`${PAY_COL}9`).value =
        { formula: `SUM(${PAY_COL}3:${PAY_COL}4)`, result: 8000 } as ExcelJS.CellValue;
    }));
    expect(sheet.totalDebit).toBe(8000);
  });

  it('keeps an ordinary formula that is not an aggregate', async () => {
    // The registers price nearly every ticket with a formula: =I3+J3-O3+Q3.
    const sheet = await sheetOf(await writeRegister('priced.xlsx', (ws) => {
      ws.getRow(9).values = [null, 3, 'MR C', '2025-07-03', '9973333333333', 'DAC/BKK', 1000, null, 'ECO SOURCING'];
      ws.getCell(`${PAY_COL}9`).value =
        { formula: 'G9+100', result: 1100 } as ExcelJS.CellValue;
    }));
    expect(sheet.totalDebit).toBe(9100);
    expect(sheet.totalTickets).toBe(3);
  });

  it('ignores a row labelled TOTAL', async () => {
    const sheet = await sheetOf(await writeRegister('labelled.xlsx', (ws) => {
      ws.getRow(9).values = [null, null, 'TOTAL', null, null, null, null, 8000];
    }));
    expect(sheet.totalDebit).toBe(8000);
  });

  it('ignores a bare amount with nothing identifying it', async () => {
    // `Sales JAN 25 (2)` row 143 — no formula, no label, half the sheet.
    const sheet = await sheetOf(await writeRegister('bare.xlsx', (ws) => {
      ws.getCell(`${PAY_COL}9`).value = 8000;
    }));

    expect(sheet.totalDebit).toBe(8000);
    expect(sheet.rows.find((r) => r.sourceRow === 9)?.rowType).toBe('NON_TRANSACTION');
  });

  it('ignores a bare NEGATIVE amount too', async () => {
    // `Sales Jun-24` row 216 carries -23,332,795 against two total rows. Left
    // in, it did not double the month — it wiped it out, to 173,023 of 23.5m.
    const sheet = await sheetOf(await writeRegister('negative.xlsx', (ws) => {
      ws.getCell(`${PAY_COL}9`).value = -8000;
    }));
    expect(sheet.totalDebit).toBe(8000);
  });

  it('still counts a service charge that has a client but no ticket', async () => {
    // `SUN PHARMA INDIA REGISTRATION`, `CHINA VISA 96 PAX` — real money, no
    // ticket number. The bare-amount rule must not reach these.
    const sheet = await sheetOf(await writeRegister('service.xlsx', (ws) => {
      ws.getRow(9).values = [null, null, 'CHINA VISA 96 PAX', null, null, null, 1344000, 'SUN PHR. CHINA'];
    }));

    expect(sheet.totalDebit).toBe(1352000);
    expect(sheet.rows.find((r) => r.sourceRow === 9)?.rowType).not.toBe('NON_TRANSACTION');
  });

  it('keeps the row rather than dropping it, so the sheet stays provable', async () => {
    const sheet = await sheetOf(await writeRegister('kept.xlsx', (ws) => {
      ws.getCell(`${PAY_COL}9`).value = 8000;
    }));
    // Two tickets and the total row: three rows read, one excluded from money.
    expect(sheet.rows).toHaveLength(3);
  });
});
