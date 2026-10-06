import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ExcelJS from 'exceljs';
import {
  UNNAMED_PARTY, parseWorkbook, readReceivableBlock,
} from '../src/modules/salesFiles/salesFiles.parser';

/**
 * ============ THE BUG THIS FILE EXISTS TO STOP COMING BACK =================
 *
 * The Accounts Receivable section first reported outstanding as
 * SUM(debit) − SUM(credit) over the imported sales rows. That read
 * BDT 224,334,437 against a real receivable of 28,655,101.60 — about eight
 * times over — because a monthly sales register records what was BILLED and
 * says nothing about what came back.
 *
 * The receivable can only come from the ACCOUNTS RECEIVABLE block on the
 * month's balance sheet. These tests fix the shape of that block, and in
 * particular the two things that make the extraction trustworthy: it is
 * bounded by the total cell's own SUM() range, and it reconciles to the stated
 * total.
 */

let dir: string;

/** A balance sheet laid out the way the real workbooks lay one out. */
async function writeAccounts(
  fileName: string,
  lines: [string, number | null][],
  opts: { headingRow?: number; formula?: string; result?: number } = {},
) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ACCOUNTS');
  const head = opts.headingRow ?? 17;

  ws.getCell(`F${head}`).value = 'ACCOUNTS RECEIVABLE';
  const first = head + 1;
  const last = first + lines.length - 1;
  lines.forEach(([party, amount], i) => {
    if (party) ws.getCell(`F${first + i}`).value = party;
    if (amount !== null) ws.getCell(`G${first + i}`).value = amount;
  });

  const summed = lines.reduce((s, [, a]) => s + (a ?? 0), 0);
  ws.getCell(`H${head}`).value = {
    formula: opts.formula ?? `SUM(G${first}:G${last})`,
    // Excel caches the formula's answer in the file; that cached value is what
    // the sheet "states", and it is not always the sum of the range.
    result: opts.result ?? summed,
  } as ExcelJS.CellValue;

  const path = join(dir, fileName);
  await wb.xlsx.writeFile(path);
  return path;
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'tripfly-receivable-')); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const openSheet = async (path: string) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb.getWorksheet('ACCOUNTS')!;
};

describe('the ACCOUNTS RECEIVABLE block', () => {
  it('reads the party lines and reconciles to the stated total', async () => {
    const ws = await openSheet(await writeAccounts('SALES-JUL-26.xlsx', [
      ['NAZMUL BHAI', 138000],
      ['SUN PHARMA', 17819708.6],
      ['EASY FASHION', 74600],
    ]));

    const block = readReceivableBlock(ws)!;
    expect(block.statedTotal).toBe(18032308.6);
    expect(block.discrepancy).toBeNull();
    expect(block.entries.map((e) => [e.party, e.amount])).toEqual([
      ['NAZMUL BHAI', 138000],
      ['SUN PHARMA', 17819708.6],
      ['EASY FASHION', 74600],
    ]);
  });

  it('finds the heading wherever the workbook put it', async () => {
    // Jun-24 puts it on row 11, May-26 on row 19.
    for (const headingRow of [11, 19]) {
      const ws = await openSheet(await writeAccounts(
        `H${headingRow}.xlsx`, [['SADI BHAI', 976031]], { headingRow }));
      expect(readReceivableBlock(ws)!.entries).toHaveLength(1);
    }
  });

  it('keeps an unlabelled line rather than silently dropping the money', async () => {
    // Jun-25 carries 108,758 and Aug-25 -44,214.11 with no party beside them.
    const ws = await openSheet(await writeAccounts('unnamed.xlsx', [
      ['ZAS CORPORATION', 635920],
      ['', 108758],
    ]));

    const block = readReceivableBlock(ws)!;
    expect(block.discrepancy).toBeNull();
    expect(block.entries.map((e) => e.party)).toEqual(['ZAS CORPORATION', UNNAMED_PARTY]);
    expect(block.entries.reduce((s, e) => s + e.amount, 0)).toBe(block.statedTotal);
  });

  it('ignores blank rows inside the summed range', async () => {
    const ws = await openSheet(await writeAccounts('gaps.xlsx', [
      ['NEAZ CHISTY', 6192],
      ['', null],
      ['MADAM LOAN', 3000],
    ]));
    expect(readReceivableBlock(ws)!.entries).toHaveLength(2);
  });

  it('reports a total the lines do not add up to, instead of hiding it', async () => {
    // `SALES-APR -25 :: ACCOUNTS (2)` states SUM(G18:G43)+164255.
    const ws = await openSheet(await writeAccounts('addend.xlsx',
      [['HASAN SIR', 517765]],
      { formula: 'SUM(G18:G18)+164255', result: 517765 + 164255 }));

    const block = readReceivableBlock(ws)!;
    // The stated total stays the workbook's own figure, the lines stay what
    // the range holds, and the gap between them is reported rather than one
    // being quietly adjusted to match the other.
    expect(block.statedTotal).toBe(682020);
    expect(block.entries).toHaveLength(1);
    expect(block.discrepancy).toBe(-164255);
  });

  it('is not found on a sheet that has no such block', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getCell('A1').value = 'NAME OF CLIENTS';
    ws.getCell('B1').value = 'OUTSTANDING';
    expect(readReceivableBlock(ws)).toBeNull();
  });
});

describe('a workbook carrying one', () => {
  it('is classified ACCOUNTS and carries the block through the parser', async () => {
    const path = await writeAccounts('SALES-JUL-26.xlsx', [
      ['SUN PHARMA', 17819708.6],
      ['WASHIM BHAI', 599837],
    ]);

    const [sheet] = (await parseWorkbook(path)).sheets;
    expect(sheet.shape).toBe('ACCOUNTS');
    expect(sheet.monthLabel).toBe('JUL-2026');
    expect(sheet.statedTotal).toBe(18419545.6);
    expect(sheet.receivables).toHaveLength(2);
    // A balance sheet states a position, it does not bill anything: none of
    // this may leak into the sales totals.
    expect(sheet.rows).toHaveLength(0);
    expect(sheet.totalDebit).toBe(0);
  });
});
