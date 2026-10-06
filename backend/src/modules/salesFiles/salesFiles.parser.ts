import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { basename } from 'path';
import * as ExcelJS from 'exceljs';

/**
 * ============== READING THE MONTHLY SALES WORKBOOKS ========================
 *
 * The office keeps one workbook per month, and a workbook is not one sheet —
 * `SALES DECEMBER-24.xlsx` has twenty. Three of those shapes carry ticket
 * rows and the rest are balance sheets, bank statements, expense books and
 * outstanding summaries. So the parser cannot be told which sheet to read; it
 * has to recognise the shapes, and say out loud what it decided about every
 * sheet it looked at.
 *
 * The three it recognises:
 *
 *   SALES_REGISTER      The month's own sales sheet.
 *                       SL. NO | NAME | DATE | TICKET NUMBER | ROUTING | …
 *                       | OFFICE PAYMENT | … | CLAINT NAME
 *                       `NAME` is the passenger; `CLAINT NAME` is who pays.
 *
 *   PARTY_LEDGER        One party's running statement. Two spellings of the
 *                       same thing, ten months apart:
 *                       Date | Ticket No. | Pax Name | Rute | Debit | Credit
 *                         | Due Balance                      (2024 workbooks)
 *                       NAME | DATE | TICKET NUMBER | ROUTING
 *                         | OFFICE PAYMENT DR | PAYMENT CR | BALANCE   (2025+)
 *
 *   SUPPLIER_STATEMENT  The consolidator's own statement of accounts
 *                       (`RAW SALES.`, `Sales Row Sheet`). It has a Date, a
 *                       Ticket and a Debit column like a party ledger does,
 *                       and it is read ONLY so it can be told apart and left
 *                       out: those figures are what the company owes Hajee
 *                       Air, not what its customers owe the company. Importing
 *                       it would post the same tickets a second time with the
 *                       sign the wrong way round.
 *
 * Nothing is guessed silently. A sheet that matches none of them comes back
 * UNRECOGNISED with a reason, and is archived rather than dropped.
 */

export type SheetShape =
  | 'SALES_REGISTER' | 'PARTY_LEDGER' | 'ACCOUNTS'
  | 'SUPPLIER_STATEMENT' | 'UNRECOGNISED';

export type SalesRowType = 'TICKET' | 'PAYMENT' | 'OPENING' | 'NON_TRANSACTION' | 'OTHER';

/** One party's balance on a month-end ACCOUNTS RECEIVABLE block. */
export interface ReceivableEntry {
  party: string;
  amount: number;
  sourceRow: number;
}

export interface ParsedRow {
  /** Excel's own row number, so a figure can be pointed at in the file. */
  sourceRow: number;
  rowType: SalesRowType;
  date: string | null;
  ticketNo: string | null;
  paxName: string | null;
  route: string | null;
  /** Who the row bills to. Never the passenger — see the module note. */
  partyName: string | null;
  debit: number;
  credit: number;
  runningBalance: number | null;
}

export interface ParsedSheet {
  sheetName: string;
  shape: SheetShape;
  skipReason: string | null;
  headerRow: number | null;
  customerName: string | null;
  monthLabel: string;
  /** First day of the month, `YYYY-MM-DD`. */
  monthYear: string;
  /** True when the sheet is a running statement, not one month's activity. */
  isCumulative: boolean;
  periodFrom: string | null;
  periodTo: string | null;
  totalTickets: number;
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
  rows: ParsedRow[];

  /**
   * The month-end receivable, when the sheet is a balance sheet.
   *
   * `statedTotal` is the workbook's own ACCOUNTS RECEIVABLE figure and
   * `receivables` are the party lines behind it. They are kept separate so a
   * disagreement between the two is visible rather than averaged away.
   */
  statedTotal: number | null;
  receivables: ReceivableEntry[];
  /** The SALES figure the balance sheet states for the month, if it is one. */
  statedSales: number | null;
  /** The month's bottom line as the balance sheet states it. */
  statedProfit: number | null;
  statedLoss: number | null;
}

export interface ParsedWorkbook {
  fileName: string;
  checksum: string;
  sheets: ParsedSheet[];
}

// ----------------------------- cell reading ---------------------------------

/**
 * A cell as text.
 *
 * ExcelJS hands back six different shapes for what a person sees as one
 * value: a primitive, a Date, `{ formula, result }`, `{ sharedFormula }` with
 * no result at all, `{ richText: [...] }`, and `{ text, hyperlink }`. All six
 * appear in these workbooks, so all six are handled here rather than at every
 * call site.
 */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    if (Array.isArray(v.richText))
      return (v.richText as { text?: unknown }[]).map((t) => String(t.text ?? '')).join('');
    if (v.result !== undefined) return cellText(v.result as ExcelJS.CellValue);
    if (v.text !== undefined) return cellText(v.text as ExcelJS.CellValue);
    return '';
  }
  return String(value);
}

/** A cell as a number, or null. Handles "1,234.50" and a formula's result. */
function cellNumber(value: ExcelJS.CellValue): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && !(value instanceof Date)) {
    const v = value as unknown as Record<string, unknown>;
    if (v.result !== undefined) return cellNumber(v.result as ExcelJS.CellValue);
  }
  const text = cellText(value).replace(/,/g, '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Excel's day 0 is 1899-12-30 — the 1900 leap-year bug is baked into it. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/**
 * A cell as `YYYY-MM-DD`.
 *
 * Four date dialects live in these files: a real Date, an Excel serial, the
 * office's own `DD.MM.YY`, and the occasional `DD/MM/YYYY`. Two-digit years
 * are read as 2000+, which is safe for a company founded in 2024.
 */
function cellDate(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    if (v.result !== undefined) return cellDate(v.result as ExcelJS.CellValue);
  }

  if (typeof value === 'number') {
    // Anything outside 1990..2100 is a fare, a ticket number or a serial that
    // is not a date at all, and guessing on it would invent transactions.
    if (value < 32874 || value > 73415) return null;
    return new Date(EXCEL_EPOCH + Math.round(value) * 86400000).toISOString().slice(0, 10);
  }

  const text = cellText(value).trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/.exec(text);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

// ------------------------------ month labels --------------------------------

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const MONTH_WORDS: Record<string, number> = {
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6, JULY: 7,
  AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
  JAN: 1, FEB: 2, MAR: 3, APR: 4, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9,
  OCT: 10, NOV: 11, DEC: 12,
};

export interface MonthRef { year: number; month: number }

export const monthLabel = (m: MonthRef): string => `${MONTHS[m.month - 1]}-${m.year}`;
export const monthFirstDay = (m: MonthRef): string =>
  `${m.year}-${String(m.month).padStart(2, '0')}-01`;

/**
 * The month a name is talking about.
 *
 * Covers every spelling actually in the folder — `sales  JUN-24`,
 * `SALES DECEMBER-24`, `SALES-APR -25`, `SALES-JUN-26(NEW)`, `Sales apr 2026`,
 * `Sales JAN 25 (2)`. A bare month with no year (`Sales March`) is left to
 * `bareMonthFromName`, which the caller pairs with the file's own year.
 */
export function monthFromName(name: string): MonthRef | null {
  const text = name.toUpperCase().replace(/\.XLSX?$/i, '');
  const re = /([A-Z]{3,9})[^A-Z0-9]{0,3}(\d{2,4})/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const month = MONTH_WORDS[match[1]];
    if (!month) continue;
    let year = Number(match[2]);
    if (year < 100) year += 2000;
    // A "(2)" copy suffix and a sequence number are not years.
    if (year < 2000 || year > 2100) continue;
    return { year, month };
  }
  return null;
}

/** A month name with no year at all, e.g. the `Sales March` sheet. */
export function bareMonthFromName(name: string): number | null {
  const words = name.toUpperCase().match(/[A-Z]{3,9}/g) ?? [];
  for (const word of words) if (MONTH_WORDS[word]) return MONTH_WORDS[word];
  return null;
}

// ------------------------------ header mapping ------------------------------

/** Header labels carry line breaks ("OFFICE PAYMENT\nDR") and stray dots. */
const norm = (s: string): string =>
  s.replace(/\s+/g, ' ').replace(/[.:]/g, '').trim().toUpperCase();

interface ColumnMap {
  date?: number; ticket?: number; pax?: number; route?: number;
  debit?: number; credit?: number; balance?: number;
  client?: number; totalFare?: number; airline?: number; serial?: number;
  // Vocabulary that belongs to somebody else's document, kept apart from the
  // company's own so `detect()` can tell whose sheet it is looking at.
  docNo?: number; narration?: number; passenger?: number; sector?: number;
  difference?: number; supplierAmount?: number;
}

const MATCHERS: { key: keyof ColumnMap; labels: string[] }[] = [
  { key: 'serial',    labels: ['SL NO', 'SL NUMBER', 'S NO', 'SL'] },
  { key: 'date',      labels: ['DATE'] },
  { key: 'ticket',    labels: ['TICKET NO', 'TICKET NUMBER', 'TICKET'] },
  { key: 'pax',       labels: ['PAX NAME', 'NAME'] },
  { key: 'route',     labels: ['ROUTE', 'RUTE', 'ROUTING'] },
  { key: 'debit',     labels: ['DEBIT', 'OFFICE PAYMENT DR', 'OFFICE PAYMENT'] },
  { key: 'credit',    labels: ['CREDIT', 'PAYMENT CR', 'PAYMENT'] },
  { key: 'balance',   labels: ['DUE BALANCE', 'BALANCE'] },
  { key: 'client',    labels: ['CLAINT NAME', 'CLIENT NAME', 'CLAINT', 'CLIENT'] },
  { key: 'totalFare', labels: ['TOTAL FARE'] },
  { key: 'airline',   labels: ['AIRLINES', 'AIRLINE'] },
  // The consolidator writes Passenger/Sector/Doc no/Narration; the office
  // writes Pax Name/Route/Rute/Routing. Neither vocabulary appears in the
  // other's sheets, which is what makes the two safe to tell apart.
  { key: 'docNo',     labels: ['DOC NO', 'DOC NUMBER', 'INVOICE NO'] },
  { key: 'narration', labels: ['NARRATION'] },
  { key: 'passenger', labels: ['PASSENGER'] },
  { key: 'sector',    labels: ['SECTOR'] },
  // A working note comparing what Hajee charged against what the office
  // billed. Two prices and their difference on one line is not a sale.
  { key: 'difference',     labels: ['DIFFERENCE', 'DEFFERENCE'] },
  { key: 'supplierAmount', labels: ['HAJEE PAYMENT', 'AIRLINES PAYMENT DR'] },
];

/**
 * Map a candidate header row to columns.
 *
 * First match wins per column, because the registers repeat headings — two
 * `COM` columns, two `DIS %` — and the leftmost is the one the data sits
 * under. Multi-word labels are listed before the bare word inside a matcher so
 * `OFFICE PAYMENT DR` is never taken for a plain `PAYMENT`.
 */
function mapColumns(cells: string[]): ColumnMap {
  const map: ColumnMap = {};
  cells.forEach((raw, index) => {
    const label = norm(raw);
    if (!label) return;
    for (const { key, labels } of MATCHERS) {
      if (map[key] !== undefined) continue;
      if (labels.some((l) => label === l || label.startsWith(`${l} `))) {
        map[key] = index + 1;                        // ExcelJS columns are 1-based
        return;
      }
    }
  });
  return map;
}

/** How many rows down a header can hide. `TUTUL BHAI` puts one at row 6. */
const HEADER_SEARCH_DEPTH = 12;
const MAX_COLUMNS = 40;

function rowCells(ws: ExcelJS.Worksheet, rowNumber: number): string[] {
  const row = ws.getRow(rowNumber);
  const width = Math.min(Math.max(ws.columnCount, 1), MAX_COLUMNS);
  const out: string[] = [];
  for (let c = 1; c <= width; c++) out.push(cellText(row.getCell(c).value));
  return out;
}

interface Detection {
  shape: SheetShape;
  headerRow: number | null;
  columns: ColumnMap;
  reason: string | null;
}

function detect(ws: ExcelJS.Worksheet): Detection {
  const depth = Math.min(ws.rowCount, HEADER_SEARCH_DEPTH);
  for (let r = 1; r <= depth; r++) {
    const columns = mapColumns(rowCells(ws, r));
    const hasAmount = columns.debit !== undefined || columns.totalFare !== undefined;
    if (columns.date === undefined || columns.ticket === undefined || !hasAmount) continue;

    // The consolidator's statement, in either of the two layouts it arrives
    // in. Its Doc no / Narration / Passenger / Sector wording does not appear
    // on anything the company itself wrote.
    if (columns.docNo !== undefined || columns.narration !== undefined
        || columns.passenger !== undefined || columns.sector !== undefined)
      return {
        shape: 'SUPPLIER_STATEMENT', headerRow: r, columns,
        reason: 'Consolidator statement of accounts — money payable to the '
              + 'supplier, not receivable from customers. Archived, not imported.',
      };

    // `refund wrong entry`: the same tickets listed twice, at the supplier's
    // price and the office's, to chase the gap between them. Importing it
    // would add a third copy of tickets the register already carries.
    if (columns.difference !== undefined || columns.supplierAmount !== undefined)
      return {
        shape: 'UNRECOGNISED', headerRow: r, columns,
        reason: 'Price-difference working note (supplier price vs office '
              + 'price), not a sales record. Archived, not imported.',
      };

    // A register is the sheet that priced the ticket: it carries the fare
    // build-up and the client the passenger was sold to.
    const isRegister = columns.serial !== undefined
      && (columns.client !== undefined || columns.totalFare !== undefined);

    return {
      shape: isRegister ? 'SALES_REGISTER' : 'PARTY_LEDGER',
      headerRow: r, columns, reason: null,
    };
  }
  return {
    shape: 'UNRECOGNISED', headerRow: null, columns: {},
    reason: 'No Date + Ticket + amount header found in the first '
          + `${HEADER_SEARCH_DEPTH} rows.`,
  };
}

// ------------------------------ party names ---------------------------------

/** Titles that sit above a ledger header and are not the party's name. */
const NOT_A_PARTY = /^(AS ON\b|TRAVEL PARTNER$|STATEMENT\b|PROFIT SUMMARY$)/i;

/**
 * Whose ledger this is.
 *
 * The 2024 workbooks put the party in a merged banner right above the header
 * ("MR RAZIB SIR (HAQUE GROUP)"). The 2025+ ones put a status line there
 * instead ("AS ON 15-SEPTEMBER-2025") and leave the name to the tab, which is
 * why the tab is the fallback rather than the other way round.
 */
function partyOf(ws: ExcelJS.Worksheet, headerRow: number): string {
  for (let r = headerRow - 1; r >= Math.max(1, headerRow - 3); r--) {
    const values = rowCells(ws, r).map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!values.length) continue;
    const title = values[0];
    if (title.length < 3 || title.length > 120) continue;
    if (NOT_A_PARTY.test(title)) continue;
    if (!/[A-Za-z]{3}/.test(title)) continue;
    return title;
  }
  return ws.name.replace(/\s*\(\d+\)\s*$/, '').trim();
}

// ------------------------------- row reading --------------------------------

/**
 * A row that adds other rows up, not a transaction.
 *
 * The registers carry a `SUBTOTAL(9,R3:R279)` line at the foot, and on most
 * sheets it equals the detail above it exactly — so counting it doubled every
 * month's sales. Twenty-nine such rows carry BDT 221.8m across the archive.
 *
 * Matched on the formula rather than on a label, because these rows have no
 * label at all: just a bare number in the amount column with an empty name,
 * ticket and client beside it. (The same defect bit the migration engine's day
 * books, where the total rows DID have labels — DEFERRED_ITEMS §J6.)
 */
const AGGREGATE_FORMULA = /\b(?:SUBTOTAL|AGGREGATE)\s*\(|\bSUM\s*\(\s*[A-Z]+\d+\s*:/i;

const isAggregate = (value: ExcelJS.CellValue): boolean => {
  if (!value || typeof value !== 'object') return false;
  const formula = (value as unknown as { formula?: string }).formula;
  return typeof formula === 'string' && AGGREGATE_FORMULA.test(formula);
};

const TOTAL_TEXT = /^(grand\s*)?total\b|^sub\s*total\b/i;

const PAYMENT_TEXT = /amount\s*received|deposit|payment\s*received|received\s*from/i;
const OPENING_TEXT = /previous\s*due|opening|balance\s*b\/?f|brought\s*forward/i;

const clean = (s: string): string | null => s.replace(/\s+/g, ' ').trim() || null;

function readRows(
  ws: ExcelJS.Worksheet, headerRow: number, columns: ColumnMap,
  shape: SheetShape, party: string | null,
): ParsedRow[] {
  const get = (row: ExcelJS.Row, col?: number): ExcelJS.CellValue =>
    col === undefined ? null : row.getCell(col).value;

  const rows: ParsedRow[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);

    const date = cellDate(get(row, columns.date));
    const ticketNo = clean(cellText(get(row, columns.ticket)));
    const paxName = clean(cellText(get(row, columns.pax)));
    const route = clean(cellText(get(row, columns.route)));

    const debitCell = get(row, columns.debit);
    const creditCell = get(row, columns.credit);
    const debitRaw = cellNumber(debitCell)
      ?? (shape === 'SALES_REGISTER' ? cellNumber(get(row, columns.totalFare)) : null);
    const debit = debitRaw ?? 0;
    const credit = cellNumber(creditCell) ?? 0;
    const balance = cellNumber(get(row, columns.balance));

    // A row with nothing in any of the five meaningful columns is spacing.
    // The running-balance column is deliberately NOT one of them: these sheets
    // drag the balance formula fifty rows past the last transaction, and those
    // rows are blank lines, not transactions.
    if (!date && !ticketNo && !paxName && debit === 0 && credit === 0) continue;

    const client = shape === 'SALES_REGISTER'
      ? clean(cellText(get(row, columns.client)))
      : party;

    const label = `${ticketNo ?? ''} ${paxName ?? ''} ${route ?? ''}`;

    // An amount with nothing identifying it: no date, no ticket, no passenger
    // and no client. In every instance in this archive that is the sheet
    // adding itself up, or a working cell — never a sale.
    const bareAmount = !date && !ticketNo && !paxName && !client;

    let rowType: SalesRowType;
    // Checked before everything else: these rows carry perfectly ordinary
    // looking amounts, and once one is read as a ticket the month doubles.
    if (isAggregate(debitCell) || isAggregate(creditCell)
        || TOTAL_TEXT.test(label.trim()) || bareAmount)
      rowType = 'NON_TRANSACTION';
    else if (OPENING_TEXT.test(label)) rowType = 'OPENING';
    else if (credit > 0 || PAYMENT_TEXT.test(label)) rowType = 'PAYMENT';
    else if (debit > 0 && ticketNo) rowType = 'TICKET';
    else rowType = 'OTHER';

    rows.push({
      sourceRow: r, rowType, date, ticketNo, paxName, route,
      partyName: client,
      debit: Math.round(debit * 100) / 100,
      credit: Math.round(credit * 100) / 100,
      runningBalance: balance,
    });
  }
  return rows;
}


// ------------------------- month-end receivable -----------------------------

/**
 * ============= THE FIGURE THE OFFICE ITSELF CALLS THE RECEIVABLE ===========
 *
 * Every workbook carries a one-page balance sheet on an `ACCOUNTS` tab, and on
 * it a block headed ACCOUNTS RECEIVABLE: one line per party who still owes
 * money, and a stated total.
 *
 * This is the only place in the archive that states what is actually
 * outstanding. The monthly sales registers record what was BILLED and nothing
 * about what came back, so billed-minus-receipts over those registers is not a
 * receivable — it is turnover with a few payments knocked off, and it comes out
 * roughly eight times too big.
 *
 * The block is bounded by the total cell's own `SUM(G18:G55)` formula rather
 * than by scanning for blank rows, because the header row moves between
 * workbooks (row 11 in Jun-24, row 19 in May-26) and the list runs past
 * embedded blanks. Reading the range the workbook itself sums is what makes
 * the extraction reconcile: 33 of the 34 blocks in the archive add up to their
 * stated total to the paisa, and the one that does not says so out loud
 * (`SALES-APR -25 :: ACCOUNTS (2)`, whose formula ends `+164255`).
 */

/** What an amount with no party name beside it is called. */
export const UNNAMED_PARTY = '(unnamed line)';

const RECEIVABLE_HEADING = /^ACCOUNTS\s*RECEIVABLE$/i;
const HEADING_SEARCH_ROWS = 40;
const HEADING_SEARCH_COLS = 12;

/** "G" → 7, "AA" → 27. */
const columnNumber = (letters: string): number =>
  letters.toUpperCase().split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

export interface ReceivableBlock {
  statedTotal: number;
  entries: ReceivableEntry[];
  /** Set when the party lines do not add up to the stated total. */
  discrepancy: number | null;
}

/**
 * The SALES figure the balance sheet states for the month.
 *
 * Worth having next to the computed one, because the two disagree and the
 * office's is the one they will recognise. July-2026: they write 19,113,906
 * where adding the register's own rows gives 19,352,631. Part of that gap is
 * explainable — ADM and void penalties come to exactly 61,080, which is the
 * `VOID & ADM` line in their expenses, so those are not sales to them — and
 * part of it is not.
 *
 * Note the cell is a typed number on every workbook in the archive, never a
 * formula. It is what somebody decided the month's sales were, and that is
 * both its authority and its limitation.
 */
export function readStatedSales(ws: ExcelJS.Worksheet): number | null {
  return labelledAmount(ws, ['SALES'], HEADING_SEARCH_ROWS);
}

/**
 * The month's bottom line, as the balance sheet states it.
 *
 * Every ACCOUNTS sheet in the archive carries one: eighteen months state a
 * NET PROFIT and fifteen a NET LOSS. July-2026 states BOTH — 2,270,737.22 on
 * the capital side and a typed `=-2315414` on the other — so the two are
 * returned separately rather than resolved here. A balance sheet that
 * disagrees with itself is worth showing, not averaging.
 */
export function readStatedProfit(ws: ExcelJS.Worksheet):
  { netProfit: number | null; netLoss: number | null } {
  return {
    netProfit: labelledAmount(ws, ['NET PROFIT'], PROFIT_SEARCH_ROWS),
    netLoss: labelledAmount(ws, ['NET LOSS'], PROFIT_SEARCH_ROWS),
  };
}

/** NET PROFIT sits at the foot of the sheet, well below the other headings. */
const PROFIT_SEARCH_ROWS = 80;

/** The first non-zero number within three columns of an exact label. */
function labelledAmount(
  ws: ExcelJS.Worksheet, labels: string[], depth: number,
): number | null {
  const wanted = labels.map((l) => l.toUpperCase());
  for (let r = 1; r <= Math.min(ws.rowCount, depth); r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= HEADING_SEARCH_COLS; c++) {
      if (!wanted.includes(cellText(row.getCell(c).value).trim().toUpperCase())) continue;
      for (let k = c + 1; k <= c + 3; k++) {
        const amount = cellNumber(row.getCell(k).value);
        if (amount !== null && amount !== 0) return Math.round(amount * 100) / 100;
      }
    }
  }
  return null;
}

export function readReceivableBlock(ws: ExcelJS.Worksheet): ReceivableBlock | null {
  const depth = Math.min(ws.rowCount, HEADING_SEARCH_ROWS);
  for (let r = 1; r <= depth; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= HEADING_SEARCH_COLS; c++) {
      if (!RECEIVABLE_HEADING.test(cellText(row.getCell(c).value).trim())) continue;

      // The total sits a column or two to the right of the heading.
      let totalCell: ExcelJS.Cell | null = null;
      for (let k = c + 1; k <= c + 4; k++) {
        const cell = row.getCell(k);
        if (cellNumber(cell.value) !== null) { totalCell = cell; break; }
      }
      if (!totalCell) continue;

      const statedTotal = cellNumber(totalCell.value) as number;
      const value = totalCell.value as unknown as { formula?: string };
      const range = /SUM\(\s*([A-Z]+)(\d+)\s*:\s*[A-Z]+(\d+)\s*\)/i
        .exec(String(value?.formula ?? ''));
      if (!range) return { statedTotal, entries: [], discrepancy: null };

      const amountCol = columnNumber(range[1]);
      const entries: ReceivableEntry[] = [];
      for (let rr = Number(range[2]); rr <= Number(range[3]); rr++) {
        const amount = cellNumber(ws.getRow(rr).getCell(amountCol).value);
        if (amount === null || amount === 0) continue;
        // A few blocks carry an unlabelled line at the bottom — Jun-25 has
        // 108,758 and Aug-25 has -44,214.11 with no party beside them. That is
        // real money inside the office's own total, so it is kept and named
        // for what it is. Dropping it would silently break the reconciliation
        // that makes this figure trustworthy in the first place.
        const label = cellText(ws.getRow(rr).getCell(amountCol - 1).value)
          .replace(/\s+/g, ' ').trim();
        entries.push({
          party: label || UNNAMED_PARTY,
          amount: Math.round(amount * 100) / 100,
          sourceRow: rr,
        });
      }

      const summed = entries.reduce((sum, e) => sum + e.amount, 0);
      const gap = Math.round((summed - statedTotal) * 100) / 100;
      return {
        statedTotal: Math.round(statedTotal * 100) / 100,
        entries,
        discrepancy: Math.abs(gap) < 0.05 ? null : gap,
      };
    }
  }
  return null;
}

// -------------------------------- workbook ----------------------------------

/** SHA-256 of the file, so a re-scan can prove it read the same bytes. */
export function fileChecksum(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Read one workbook: every sheet, classified, with the ticket rows of the ones
 * that carry them.
 *
 * The month is taken from the SHEET name when the sheet names one
 * (`Sales MAR 2026`), and only otherwise from the file. That ordering is what
 * keeps `SALES-MAR-26.xlsx`, which also carries a copy of `Sales FEB 2026`,
 * from filing February's register under March.
 */
export async function parseWorkbook(path: string): Promise<ParsedWorkbook> {
  const fileName = basename(path);
  const checksum = await fileChecksum(path);
  const fileMonth = monthFromName(fileName);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);

  const sheets: ParsedSheet[] = [];
  wb.eachSheet((ws) => {
    // A balance sheet is recognised by the receivable block on it, not by its
    // tab name — several workbooks carry ACCOUNTS, ACCOUNTS (2) and (3).
    const block = readReceivableBlock(ws);
    const { shape, headerRow, columns, reason } = block
      ? { shape: 'ACCOUNTS' as SheetShape, headerRow: null, columns: {},
          reason: null as string | null }
      : detect(ws);

    const sheetMonth = monthFromName(ws.name);
    const bare = sheetMonth ? null : bareMonthFromName(ws.name);
    const month: MonthRef | null = sheetMonth
      ?? (bare !== null && fileMonth ? { year: fileMonth.year, month: bare } : null)
      ?? fileMonth;

    const namesItsOwnMonth = sheetMonth !== null || bare !== null;

    const party = shape === 'PARTY_LEDGER' && headerRow !== null
      ? partyOf(ws, headerRow) : null;
    const rows = headerRow !== null
      && (shape === 'SALES_REGISTER' || shape === 'PARTY_LEDGER')
      ? readRows(ws, headerRow, columns, shape, party)
      : [];

    const tickets = rows.filter((r) => r.rowType === 'TICKET');
    const dates = rows.map((r) => r.date).filter((d): d is string => !!d).sort();
    // Everything below adds up the sheet's own transactions, so the rows that
    // are themselves additions of those transactions are left out.
    const movements = rows.filter((r) => r.rowType !== 'NON_TRANSACTION');

    // What the sheet itself says it ends at. A ledger states it in the balance
    // column; a register has no balance column, so the month's own movement is
    // the honest answer and is what gets carried forward.
    const withBalance = movements.filter((r) => r.runningBalance !== null);
    const totalDebit = round2(movements.reduce((s, r) => s + r.debit, 0));
    const totalCredit = round2(movements.reduce((s, r) => s + r.credit, 0));
    const closing = withBalance.length
      ? round2(withBalance[withBalance.length - 1].runningBalance as number)
      : round2(totalDebit - totalCredit);

    sheets.push({
      sheetName: ws.name,
      shape,
      skipReason: reason,
      headerRow,
      customerName: party,
      monthLabel: month ? monthLabel(month) : 'UNDATED',
      monthYear: month ? monthFirstDay(month) : '1970-01-01',
      // A sheet that does not name its own month is a running statement filed
      // under whichever workbook happened to hold it.
      isCumulative: !namesItsOwnMonth,
      periodFrom: dates[0] ?? null,
      periodTo: dates[dates.length - 1] ?? null,
      totalTickets: tickets.length,
      totalDebit,
      totalCredit,
      closingBalance: closing,
      rows,
      statedTotal: block ? block.statedTotal : null,
      receivables: block ? block.entries : [],
      statedSales: block ? readStatedSales(ws) : null,
      statedProfit: block ? readStatedProfit(ws).netProfit : null,
      statedLoss: block ? readStatedProfit(ws).netLoss : null,
    });
  });

  return { fileName, checksum, sheets };
}
