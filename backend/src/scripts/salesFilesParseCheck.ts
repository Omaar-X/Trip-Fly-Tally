import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  PrimaryCandidate, choosePrimaries, dataDir,
} from '../modules/salesFiles/salesFiles.service';
import { ParsedSheet, parseWorkbook } from '../modules/salesFiles/salesFiles.parser';

/**
 * ================== WHAT THE PARSER MAKES OF THE ARCHIVE ====================
 *
 * Reads every workbook in the sales-file folder and prints what it decided
 * about every sheet — WITHOUT a database, and without writing anything.
 *
 *     npm run sales-files:check              every sheet
 *     npm run sales-files:check -- --sales   only the sheets carrying sales
 *
 * This is the check to run before importing into a live database, and the one
 * to re-run after touching the parser. Three things to look at:
 *
 *   · SHAPE — a register that has quietly become UNRECOGNISED is a month that
 *     would silently go missing from the dashboard.
 *   · PRI — exactly one primary per month. Two means a duplicate copy is being
 *     counted twice; none means a month has no authoritative sheet at all.
 *   · The opening/running balance at the bottom is what the dashboard KPI
 *     cards will show once the same files are imported.
 */

const pad = (s: string, n: number): string =>
  (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);
const num = (n: number, w: number): string =>
  n.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(w);

interface Entry { file: string; sheet: ParsedSheet }

async function main() {
  const salesOnly = process.argv.includes('--sales');
  const dir = dataDir();
  if (!existsSync(dir)) {
    console.error(`Sales file folder not found: ${dir}`);
    process.exit(1);
  }

  const files = readdirSync(dir)
    .filter((f) => /\.xlsx?$/i.test(f) && !f.startsWith('~$')).sort();
  console.log(`Folder: ${dir}`);
  console.log(`Workbooks: ${files.length}\n`);

  const entries: Entry[] = [];
  for (const file of files) {
    const wb = await parseWorkbook(join(dir, file));
    for (const sheet of wb.sheets) entries.push({ file, sheet });
  }

  const isSales = (s: ParsedSheet) =>
    s.shape === 'SALES_REGISTER' || s.shape === 'PARTY_LEDGER';

  // The same choice the importer makes, on the same rule.
  const candidates: PrimaryCandidate[] = entries
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => isSales(e.sheet))
    .map(({ e, index }) => ({
      id: index,
      fileName: e.file,
      sheetName: e.sheet.sheetName,
      shape: e.sheet.shape,
      monthYear: e.sheet.monthYear,
      customerName: e.sheet.customerName,
      totalTickets: e.sheet.totalTickets,
    }));
  const primaries = choosePrimaries(candidates);

  console.log(pad('FILE', 26), pad('SHEET', 22), pad('SHAPE', 19),
              pad('MONTH', 9), 'CUM PRI', 'TKTS'.padStart(6),
              'DEBIT'.padStart(13), 'CREDIT'.padStart(13),
              'CLOSING'.padStart(14), ' PARTY / REASON');

  const totals = { sheets: 0, sales: 0, tickets: 0, debit: 0, credit: 0 };
  entries.forEach(({ file, sheet }, index) => {
    totals.sheets++;
    if (isSales(sheet)) {
      totals.sales++;
      totals.tickets += sheet.totalTickets;
      totals.debit += sheet.totalDebit;
      totals.credit += sheet.totalCredit;
    }
    if (salesOnly && !isSales(sheet)) return;

    console.log(
      pad(file, 26), pad(sheet.sheetName, 22), pad(sheet.shape, 19),
      pad(sheet.monthLabel, 9), sheet.isCumulative ? 'yes' : ' no ',
      primaries.has(index) ? ' * ' : '   ',
      num(sheet.totalTickets, 6), num(sheet.totalDebit, 13),
      num(sheet.totalCredit, 13), num(sheet.closingBalance, 14),
      ` ${sheet.customerName ?? sheet.skipReason ?? ''}`.slice(0, 70));
  });

  // What `GET /api/sales-files/balance` will answer, computed off the same
  // primary / non-cumulative rule the service uses.
  const counted = entries.filter((e, index) =>
    primaries.has(index) && !e.sheet.isCumulative);
  const months = [...new Set(counted.map((e) => e.sheet.monthYear))].sort();
  const latest = months[months.length - 1];
  const opening = counted.filter((e) => e.sheet.monthYear === latest)
    .reduce((s, e) => s + e.sheet.closingBalance, 0);

  console.log('\n--- totals -------------------------------------------------');
  console.log(`sheets seen           ${totals.sheets}`);
  console.log(`sheets with sales     ${totals.sales}`);
  console.log(`counted (primary,     ${counted.length}`);
  console.log(`         month-scoped)`);
  console.log(`ticket rows (all)     ${totals.tickets.toLocaleString('en-US')}`);
  console.log(`ticket rows (counted) ${counted.reduce((s, e) => s + e.sheet.totalTickets, 0)
    .toLocaleString('en-US')}`);
  console.log(`months covered        ${months.length} `
    + `(${months[0]?.slice(0, 7)} … ${latest?.slice(0, 7)})`);

  const gaps = missingMonths(months);
  console.log(`gaps                  ${gaps.length ? gaps.join(', ') : 'none'}`);
  console.log(`opening balance       ${opening.toLocaleString('en-US')} `
    + `(latest month: ${latest?.slice(0, 7)})`);
}

/** Months with no counted sheet between the first and the last one present. */
function missingMonths(months: string[]): string[] {
  if (months.length < 2) return [];
  const out: string[] = [];
  const [firstYear, firstMonth] = months[0].split('-').map(Number);
  const [lastYear, lastMonth] = months[months.length - 1].split('-').map(Number);
  const present = new Set(months.map((m) => m.slice(0, 7)));
  for (let y = firstYear, m = firstMonth;
       y < lastYear || (y === lastYear && m <= lastMonth);
       m === 12 ? (m = 1, y++) : m++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (!present.has(key)) out.push(key);
  }
  return out;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
