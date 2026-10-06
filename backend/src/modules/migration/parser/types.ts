import { PARSER_VERSION, RawCell, RowKind } from './primitives';
import { ServiceCategory } from '../historicalRules';

/**
 * ==================== WHAT COMES OUT OF THE PARSER =========================
 *
 * One shape for every source, because the poster should not have to know
 * whether a row came from a party ledger, a sales register or a day book.
 *
 * Two properties are load-bearing:
 *
 *   · `raw` is never dropped. Whatever the parser made of a row, the original
 *     cells travel with it into `migration_source_rows.raw`, so a disagreement
 *     about what a row meant can always be settled by looking at what it said.
 *
 *   · `outcome` is exhaustive. Every row of every sheet ends up as exactly one
 *     of the five, which is what makes the row-accountability arithmetic
 *     (§7) provable rather than asserted.
 */

export type RowOutcome =
  | 'FINANCIAL'          // a transaction to post
  | 'NON_TRANSACTION'    // header, title, blank, subtotal, note — with a reason
  | 'REVIEW_REQUIRED'    // meaningful, but not safely interpretable
  | 'DUPLICATE';         // proven the same transaction as another row

export type TxnKind =
  | 'SALE'               // customer is charged
  | 'PURCHASE'           // vendor cost against a sale
  | 'RECEIPT'            // money in
  | 'PAYMENT'            // money out
  | 'PENALTY'            // ADM / VOID — company loss
  | 'EXPENSE'
  | 'SALARY'
  | 'CONTRA'             // cash ↔ bank
  | 'OPENING';           // a stated opening balance, not a movement

export interface SourceRef {
  file: string;
  archive: string;
  sheet: string;
  row: number;
  period: string;        // YYYY-MM
}

export interface NormalizedRow {
  outcome: RowOutcome;
  kind?: TxnKind;
  rowKind: RowKind;
  source: SourceRef;

  /** The original cells, verbatim. Never dropped, never rewritten. */
  raw: Record<string, unknown>;

  date?: string | null;

  /** What the source called the party, and what it normalises to. */
  customerText?: string | null;
  customer?: string | null;
  vendorText?: string | null;
  vendor?: string | null;
  agentText?: string | null;
  agent?: string | null;

  pnr?: string | null;
  ticketNo?: string | null;
  passenger?: string | null;
  route?: string | null;
  airline?: string | null;
  serviceCategory?: ServiceCategory;

  /** Money. Every field is what the SOURCE said, not a derived figure. */
  sellingAmount?: number | null;
  costAmount?: number | null;
  receivedAmount?: number | null;
  dueAmount?: number | null;
  serviceCharge?: number | null;
  /** The source's own profit figure, kept as a control value. */
  profitSource?: number | null;
  taxAit?: number | null;
  commission?: number | null;

  currency?: string | null;
  exchangeRate?: number | null;

  /** CASH / BANK when the source is explicit; null when it is not. */
  method?: 'CASH' | 'BANK' | null;
  bankLedger?: string | null;

  /** The source's own expense wording, preserved alongside any mapping. */
  expenseCategorySource?: string | null;
  expenseLedger?: string | null;

  narration?: string | null;
  remarks?: string | null;

  /** Set on NON_TRANSACTION and REVIEW_REQUIRED — never left blank. */
  reason?: string;
  reviewCategory?: ReviewCategory;
}

/** The categories §40 asks the review queue to support. */
export type ReviewCategory =
  | 'UNKNOWN_PARTY' | 'AMBIGUOUS_PARTY_MATCH' | 'MISSING_VENDOR'
  | 'UNCLEAR_PAYMENT_METHOD' | 'BANK_DAILYBOOK_CONFLICT' | 'PROFIT_MISMATCH'
  | 'OUTSTANDING_MISMATCH' | 'UNKNOWN_EXPENSE_CATEGORY' | 'UNKNOWN_SERVICE_TYPE'
  | 'POSSIBLE_DUPLICATE' | 'MISSING_ACCOUNTING_TREATMENT' | 'FIXED_ASSET_DIFFERENCE'
  | 'CAPITAL_DIFFERENCE' | 'TAX_AIT_UNCLEAR' | 'FOREIGN_CURRENCY_UNCLEAR'
  | 'UNPARSEABLE_ROW' | 'OTHER';

export interface ParseResult {
  period: string;
  parserVersion: string;
  parsedAt: string;
  files: { file: string; sheet: string; checksum: string; rows: number }[];
  rows: NormalizedRow[];
  /** Row accountability — must add up to the rows seen. */
  stats: {
    seen: number;
    financial: number;
    review: number;
    duplicate: number;
    nonTransaction: number;
  };
}

export const emptyStats = (): ParseResult['stats'] =>
  ({ seen: 0, financial: 0, review: 0, duplicate: 0, nonTransaction: 0 });

export const parserStamp = () => ({
  parserVersion: PARSER_VERSION,
  parsedAt: new Date().toISOString(),
});

/** Builds the `raw` map from a header row and a data row, losing nothing. */
export function rawOf(header: RawCell[], cells: RawCell[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new Map<string, number>();
  cells.forEach((c, i) => {
    if (c == null || c === '') return;
    let key = String(header[i] ?? `col${i + 1}`).trim() || `col${i + 1}`;
    // Two columns can share a heading — the sales registers have two blank
    // headers and two "AMOUNT" columns. Suffixing keeps both values.
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) key = `${key} (${n})`;
    out[key] = c instanceof Date ? c.toISOString().slice(0, 10)
      : typeof c === 'object' ? JSON.parse(JSON.stringify(c))
      : c;
  });
  return out;
}
