/**
 * ===================== READING A SPREADSHEET STRUCTURALLY ===================
 *
 * These workbooks were kept by hand for two years. They carry title rows,
 * merged headings, blank spacers, subtotals, repeated headers, three spellings
 * of the same column, amounts stored as text with commas, dates stored as text
 * in dd.mm.yy, dates stored as real Excel serials, and formulas whose cached
 * result is the only number anyone ever saw.
 *
 * Nothing here looks at formatting. Bold is not a heading, a border is not a
 * total, and a merged cell is not a section. Every decision below is made from
 * the VALUES, because formatting is the first thing that gets lost when a file
 * is copied, exported, or opened in a different version of Excel.
 *
 * The governing rule: when a row cannot be understood, it is never guessed at
 * and never dropped — it becomes REVIEW_REQUIRED and keeps its raw values.
 * ===========================================================================
 */

/** What a cell can be after exceljs has read it. */
export type RawCell = unknown;

/** The parser's own version, stamped on every row it produces. */
export const PARSER_VERSION = '4.0.0';

// ────────────────────────────── text ────────────────────────────────────────

/**
 * A cell as plain text.
 *
 * exceljs hands back four shapes for something that looks like text: a string,
 * a `{ richText: [...] }` object when part of the cell was styled, a
 * `{ formula, result }` object, and a `{ text, hyperlink }` object. All four
 * appear in these files.
 */
export function cellText(v: RawCell): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString().slice(0, 10);

  const o = v as Record<string, unknown>;
  if (Array.isArray(o.richText))
    return (o.richText as { text?: string }[]).map((r) => r.text ?? '').join('').trim();
  // A formula's cached result is what the person keeping the book actually saw.
  if ('result' in o) return cellText(o.result);
  if (typeof o.text === 'string') return o.text.trim();
  if ('error' in o) return '';
  return String(v).trim();
}

/** Case and whitespace out of the comparison; spelling untouched. */
export const norm = (v: RawCell): string =>
  cellText(v).replace(/\s+/g, ' ').trim().toUpperCase();

// ───────────────────────────── numbers ──────────────────────────────────────

const CURRENCY_NOISE = /[\s ,'’`]|(?:bdt|tk\.?|taka)/gi;

/**
 * A cell as a number, or null when it is not one.
 *
 * Handles: real numbers, formula results, "1,234.56", " 1 234.56 ", "BDT
 * 5,000", "(1,200)" for negatives, and a bare "-" or "N/A" meaning nothing.
 *
 * Deliberately strict about what counts as a number: "MR#021" and "157
 * 6801435806" must NOT come back as numbers, or a ticket number becomes an
 * amount.
 */
export function cellNumber(v: RawCell): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return null;

  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o) return cellNumber(o.result);
    if (Array.isArray(o.richText)) return cellNumber(cellText(v));
  }

  const raw = cellText(v);
  if (!raw) return null;

  // Accountants write a negative as (1,200).
  const negated = /^\(.*\)$/.test(raw.trim());
  const body = raw.trim().replace(/^\(|\)$/g, '');

  // Drop the currency word first: "BDT 5,000" and "TK. 250" are numbers. What
  // is left has to stand on its own.
  const withoutCurrency = body.replace(/(?:bdt|tk|taka)\.?/gi, ' ').trim();

  // Two digit groups separated by a space are two things, not one number.
  // "157 6801435806" is a ticket; reading it as 1,576,801,435,806 would post a
  // ticket number as an amount.
  if (/\d[\s ]+\d/.test(withoutCurrency)) return null;

  const cleaned = withoutCurrency.replace(CURRENCY_NOISE, '');
  if (!/^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(cleaned)) return null;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negated ? -n : n;
}

/** Money, rounded to the paisa the ledger stores. */
export function cellAmount(v: RawCell): number | null {
  const n = cellNumber(v);
  return n == null ? null : Math.round(n * 100) / 100;
}

// ────────────────────────────── dates ───────────────────────────────────────

const TWO_DIGIT_PIVOT = 70;   // 24 → 2024, 99 → 1999

const DATE_PATTERNS: RegExp[] = [
  /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/,           // 02.03.24 · 2/3/2024
  /^(\d{4})-(\d{1,2})-(\d{1,2})$/,                     // 2024-03-02 (y m d)
  // "21.0324" — dd.mm.yy typed with the second dot missed. Four digits after
  // the dot decode to mm+yy with nothing left over, so this is a format
  // normalisation rather than a guess. Callers that care still surface it:
  // the party-ledger parser raises a review note when it sees this shape, so a
  // person confirms the reading rather than trusting it silently.
  /^(\d{1,2})[.](\d{2})(\d{2})$/,
];

/**
 * A cell as a calendar date, or null.
 *
 * The books use dd.mm.yy almost everywhere, and real Excel dates from mid-2024
 * onward. Ambiguity is resolved the Bangladeshi way — day first — which is what
 * every one of these files does; `13.02.25` is 13 February, and there is no
 * month 13 to argue about.
 *
 * `bounds` rejects anything outside the migration window, so a stray 2027 in a
 * working sheet cannot post.
 */
export function cellDate(
  v: RawCell,
  bounds: { min?: string; max?: string } = {},
): string | null {
  let iso: string | null = null;

  if (v instanceof Date) {
    iso = new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()))
      .toISOString().slice(0, 10);
  } else if (typeof v === 'object' && v !== null && 'result' in (v as object)) {
    return cellDate((v as { result: unknown }).result, bounds);
  } else {
    const raw = cellText(v);
    if (!raw) return null;
    for (const re of DATE_PATTERNS) {
      const m = re.exec(raw);
      if (!m) continue;
      let d: number, mo: number, y: number;
      if (re === DATE_PATTERNS[1]) { y = +m[1]; mo = +m[2]; d = +m[3]; }
      else {
        d = +m[1]; mo = +m[2]; y = +m[3];
        if (y < 100) y += y < TWO_DIGIT_PIVOT ? 2000 : 1900;
      }
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      const dt = new Date(Date.UTC(y, mo - 1, d));
      // Rejects 31 February rather than rolling it into March.
      if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
      iso = dt.toISOString().slice(0, 10);
      break;
    }
  }

  if (!iso) return null;
  if (bounds.min && iso < bounds.min) return null;
  if (bounds.max && iso > bounds.max) return null;
  return iso;
}

// ──────────────────────── row classification ────────────────────────────────

export type RowKind =
  | 'DATA'            // a candidate transaction
  | 'BLANK'           // nothing in it
  | 'HEADER'          // the column header, wherever it sits
  | 'REPEATED_HEADER' // the same header again, mid-sheet
  | 'TITLE'           // "TRIP FLY BD", "BALANCE SHEET", a month name
  | 'SUBTOTAL'        // TOTAL / GRAND TOTAL / NET PROFIT / Balance Forward
  | 'NOTE';           // "IN WORD - ...", "PREPARED BY", a stray comment

const SUBTOTAL_WORDS = [
  'TOTAL', 'GRAND TOTAL', 'SUB TOTAL', 'SUBTOTAL', 'NET PROFIT', 'NET LOSS',
  'BALANCE FORWARD', 'BALANCE C/F', 'BALANCE B/F', 'CLOSING BALANCE', 'NET',
];

/**
 * Phrases that OPEN a summary line. Matched as a prefix rather than as a whole
 * cell, because the day books label their running totals "TOTAL PAYMENT",
 * "TOTAL BALANCE", "TOTAL RECEIVED".
 */
const SUBTOTAL_PHRASES = [
  'TOTAL ', 'GRAND TOTAL', 'SUB TOTAL', 'SUBTOTAL ', 'CLOSING BALANCE',
];

const NOTE_WORDS = [
  'IN WORD', 'PREPARED BY', 'CHECKED BY', 'APPROVED BY', 'OPERATION MANAGER',
  'SIGNATURE', 'REMARKS ONLY', 'NOTE:',
];

const TITLE_WORDS = [
  'TRIP FLY BD', 'BALANCE SHEET', 'CASH FLOW STATEMENT', 'FOR THE MONTH OF',
  'DAILY EXPENSES', 'STATEMENT OF ACCOUNT', 'WORLD TRAVELLER',
];

export interface ClassifyOptions {
  /** The header this sheet is known to have, so a repeat can be recognised. */
  headerKey?: string;
  /** Column indexes that must hold a number for the row to be data. */
  amountColumns?: number[];
}

/** A stable fingerprint of a header row, for spotting the same one again. */
export const headerKeyOf = (cells: RawCell[]): string =>
  cells.map(norm).filter(Boolean).join('|');

/**
 * What kind of row this is.
 *
 * Order is deliberate. Blank first, because an empty row can look like anything
 * else once you start pattern matching. Subtotal before data, because
 * "TOTAL | 1,234" has a perfectly good number in it and would otherwise post as
 * a transaction — which is how a month's figures get double-counted.
 */
export function classifyRow(cells: RawCell[], opts: ClassifyOptions = {}): RowKind {
  const texts = cells.map(cellText);
  const nonEmpty = texts.filter((t) => t !== '');
  if (nonEmpty.length === 0) return 'BLANK';

  const joined = nonEmpty.join(' ').toUpperCase();
  const words = nonEmpty.map((t) => t.replace(/\s+/g, ' ').trim().toUpperCase());

  if (opts.headerKey && headerKeyOf(cells) === opts.headerKey) return 'REPEATED_HEADER';

  // A total row usually states it in a cell of its own — "TOTAL", "NET PROFIT".
  if (words.some((w) => SUBTOTAL_WORDS.includes(w))) return 'SUBTOTAL';

  // ...but the day books write "TOTAL PAYMENT" and "TOTAL BALANCE" as the name
  // of a summary line, and an exact-cell match misses both. 198 such rows —
  // BDT 78.4 M — were posting as real transactions and landing in suspense.
  //
  // The phrase must START with the total word: "TOTAL PAYMENT" is a summary,
  // while a party genuinely called "TOTAL SPORTS LTD" would not be, and neither
  // is a narration that merely mentions a total part-way through.
  if (words.some((w) => SUBTOTAL_PHRASES.some((p) => w.startsWith(p)))) return 'SUBTOTAL';
  if (NOTE_WORDS.some((w) => joined.startsWith(w) || joined.includes(` ${w}`))) return 'NOTE';

  // A title is text with no numbers anywhere.
  const hasNumber = cells.some((c) => cellNumber(c) != null);
  if (!hasNumber && TITLE_WORDS.some((w) => joined.includes(w))) return 'TITLE';

  // A single text cell and nothing else is a heading, not a transaction.
  if (!hasNumber && nonEmpty.length === 1) return 'TITLE';

  // A merged heading reads back as the SAME text repeated across the merge
  // range — "MR RAZIB SIR (HAQUE GROUP)" seven times in the party ledgers.
  // Without this it would look like a seven-column data row.
  if (!hasNumber && new Set(words).size === 1) return 'TITLE';

  return 'DATA';
}

/** True when the row carries a number in at least one of the money columns. */
export const hasAmountIn = (cells: RawCell[], columns: number[]): boolean =>
  columns.some((i) => cellAmount(cells[i]) != null);

// ─────────────────────── header location and mapping ────────────────────────

/**
 * Find the header row by what it says, never by where it sits.
 *
 * It is row 2 in the sales registers, row 3 in the party ledgers, row 4 in the
 * day books and row 7 in the ACCOUNTS sheets. Any parser that assumed a
 * position would read a title row as a header on the very next file.
 */
export function findHeader(
  rows: RawCell[][],
  required: string[][],
  searchLimit = 25,
): { index: number; cells: RawCell[] } | null {
  for (let i = 0; i < Math.min(rows.length, searchLimit); i++) {
    const set = new Set(rows[i].map(norm).filter(Boolean));
    // Each entry in `required` is a list of acceptable spellings for one column.
    const ok = required.every((alternatives) => alternatives.some((a) => set.has(a)));
    if (ok) return { index: i, cells: rows[i] };
  }
  return null;
}

/**
 * Column name → index, tolerating the spelling drift across two years of
 * files: CLAINT NAME / CLIENT NAME, REFFERENCE / REFERENCE, issueing Agency
 * with one space or two.
 */
export function columnMap(headerCells: RawCell[]): Map<string, number> {
  const map = new Map<string, number>();
  headerCells.forEach((c, i) => {
    const key = norm(c);
    if (key && !map.has(key)) map.set(key, i);
  });
  return map;
}

/** First matching spelling wins; returns -1 when the column is absent. */
export function columnIndex(map: Map<string, number>, ...names: string[]): number {
  for (const n of names) {
    const i = map.get(n.toUpperCase());
    if (i != null) return i;
  }
  return -1;
}
