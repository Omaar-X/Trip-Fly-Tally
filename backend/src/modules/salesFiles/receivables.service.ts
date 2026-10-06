import { query, Row } from '../../config/db';
import { round2 } from '../../utils/money';
import { NameWeight, canonicalMap, clusterNames, normaliseName } from './nameMatching';

/**
 * ===================== WHO OWES WHAT, PER THE SHEETS =======================
 *
 * ── WHERE THE OUTSTANDING FIGURE COMES FROM, AND WHY ───────────────────────
 *
 * From the ACCOUNTS RECEIVABLE block on the latest month's balance sheet —
 * the office's own list of who still owes, and its own stated total.
 *
 * NOT from `SUM(debit) − SUM(credit)` over the imported sales rows. That was
 * the first implementation and it was wrong by roughly eight times: it
 * reported BDT 224,334,437 outstanding when the July-2026 balance sheet says
 * 28,655,101.60. The reason is that a monthly sales register records what was
 * BILLED and nothing about what came back — only the partner ledgers and the
 * three Mar–May 2024 sheets have a credit column at all — so subtracting the
 * handful of receipts that happen to be written down leaves very nearly the
 * whole of turnover standing as "debt".
 *
 * The lesson is worth keeping: in this archive, billing and collection live in
 * different sheets, and a receivable can only come from the sheet that states
 * one.
 *
 * ── WHAT EACH COLUMN MEANS ─────────────────────────────────────────────────
 *
 *   Outstanding  the balance sheet's own figure for that party, as at the
 *                latest month. This is the number that adds up to the total.
 *   Billed       what the month registers billed that party between MAR-2024
 *                and JUL-2026 — context, from a different source and a fixed
 *                window.
 *   Collected    billed − outstanding, and only when that is meaningful. A
 *                party whose outstanding exceeds everything billed inside the
 *                window is carrying a balance from before it, so the
 *                subtraction would invent a negative receipt; those report
 *                null and the UI shows a dash.
 */

/** The billing window the brief asks for: the whole imported history. */
const PERIOD_FROM = '2024-03-01';
const PERIOD_TO = '2026-07-01';

export type ReceivableStatus = 'PENDING' | 'RECEIVED';

export interface ReceivableRow {
  customerName: string;
  /** Other spellings folded into this one, if any. */
  variants: string[];
  /** The balance sheet's own figure. Drives the status and the total. */
  outstanding: number;
  /** Billed in the window, from the registers. Null when never billed there. */
  totalBilled: number | null;
  /** billed − outstanding, or null when the party carries an earlier balance. */
  totalReceived: number | null;
  tickets: number;
  status: ReceivableStatus;
  /** True when the party is on the balance sheet but never billed in-window. */
  carriedIn: boolean;
}

export interface ReceivablesResult {
  /** The workbook's own stated ACCOUNTS RECEIVABLE total. The headline. */
  totalOutstanding: number;
  /** Sum of the party lines. Equal to the above unless the sheet disagrees. */
  sumOfLines: number;
  /** Non-null only when the source sheet's own arithmetic does not add up. */
  discrepancy: number | null;
  asOfMonth: string | null;
  asOfLabel: string | null;
  sourceFile: string | null;
  sourceSheet: string | null;
  totalBilled: number;
  customers: number;
  pending: number;
  received: number;
  periodFrom: string;
  periodTo: string;
  rows: ReceivableRow[];
}

/** The balance sheet whose receivable block is current. */
const LATEST_BLOCK_SQL = `
  SELECT sf.id, sf.month_year, sf.month_label, sf.file_name, sf.sheet_name,
         sf.stated_total, sf.receivable_discrepancy
    FROM sales_files sf
   WHERE sf.company_id = ? AND sf.sheet_shape = 'ACCOUNTS' AND sf.is_primary = 1
     AND EXISTS (SELECT 1 FROM sales_file_receivables r WHERE r.sales_file_id = sf.id)
   ORDER BY sf.month_year DESC
   LIMIT 1`;

/**
 * What each party was billed in the window.
 *
 * One authoritative copy of each month, and month-scoped sheets only: a
 * cumulative partner ledger restates its whole history in every workbook it
 * appears in, so counting it here would multiply the billing by the number of
 * workbooks it survived into.
 *
 * NON_TRANSACTION rows are excluded, and the exclusion is load-bearing rather
 * than tidy: a party ledger stamps its own party onto every row it holds,
 * total row included, so `Sales April`'s 3,303,062 total was landing on
 * MR RAZIB SIR (HAQUE GROUP) as if he had been billed the month twice.
 */
const BILLED_SQL = `
  SELECT r.party_name,
         SUM(r.debit) AS billed,
         SUM(r.row_type = 'TICKET') AS tickets
    FROM sales_file_rows r
    JOIN sales_files sf ON sf.id = r.sales_file_id
   WHERE sf.company_id = ?
     AND sf.is_primary = 1 AND sf.is_cumulative = 0
     AND sf.month_year BETWEEN ? AND ?
     AND r.row_type <> 'NON_TRANSACTION'
     AND r.party_name IS NOT NULL AND TRIM(r.party_name) <> ''
   GROUP BY r.party_name`;

const empty = (): ReceivablesResult => ({
  totalOutstanding: 0, sumOfLines: 0, discrepancy: null,
  asOfMonth: null, asOfLabel: null, sourceFile: null, sourceSheet: null,
  totalBilled: 0, customers: 0, pending: 0, received: 0,
  periodFrom: PERIOD_FROM, periodTo: PERIOD_TO, rows: [],
});

export const receivablesService = {
  /**
   * The receivable, by party, with spelling variants folded together.
   *
   * `status` filters the returned rows; the totals in the header always
   * describe the whole book, because an outstanding figure that moved when
   * somebody clicked a tab would be reporting the filter, not the debt.
   */
  async receivables(
    companyId: number, filters: { status?: ReceivableStatus } = {},
  ): Promise<ReceivablesResult> {
    const [block] = await query<Row[]>(LATEST_BLOCK_SQL, [companyId]);
    if (!block) return empty();

    const [outstandingRows, billedRows] = await Promise.all([
      query<Row[]>(
        `SELECT party_name, SUM(amount) AS outstanding
           FROM sales_file_receivables WHERE sales_file_id = ?
          GROUP BY party_name`, [block.id]),
      query<Row[]>(BILLED_SQL, [companyId, PERIOD_FROM, PERIOD_TO]),
    ]);

    // Cluster across BOTH sources, so the balance sheet's "ECO SOURCING" and
    // the register's "ECO SORCHING" land on one row rather than two.
    const weights = new Map<string, NameWeight>();
    const weigh = (name: string, rows: number, amount: number) => {
      const key = normaliseName(name);
      const seen = weights.get(key);
      if (seen) { seen.rows += rows; seen.amount += amount; }
      else weights.set(key, { name: name.trim(), rows, amount });
    };
    for (const r of billedRows) weigh(String(r.party_name), Number(r.tickets), Number(r.billed));
    for (const r of outstandingRows) weigh(String(r.party_name), 1, Number(r.outstanding));

    const canonical = canonicalMap([...weights.values()]);
    const nameOf = (raw: string) => canonical.get(normaliseName(raw)) ?? raw.trim();

    interface Acc {
      customerName: string; variants: Set<string>;
      outstanding: number; billed: number; tickets: number;
      onBalanceSheet: boolean; billedInWindow: boolean;
    }
    const merged = new Map<string, Acc>();
    const bucket = (raw: string): Acc => {
      const name = nameOf(raw);
      let acc = merged.get(name);
      if (!acc) {
        acc = { customerName: name, variants: new Set(), outstanding: 0, billed: 0,
                tickets: 0, onBalanceSheet: false, billedInWindow: false };
        merged.set(name, acc);
      }
      if (raw.trim() !== name) acc.variants.add(raw.trim());
      return acc;
    };

    for (const r of billedRows) {
      const acc = bucket(String(r.party_name));
      acc.billed += Number(r.billed);
      acc.tickets += Number(r.tickets);
      acc.billedInWindow = true;
    }
    for (const r of outstandingRows) {
      const acc = bucket(String(r.party_name));
      acc.outstanding += Number(r.outstanding);
      acc.onBalanceSheet = true;
    }

    const all: ReceivableRow[] = [...merged.values()].map((acc) => {
      const outstanding = round2(acc.outstanding);
      const totalBilled = acc.billedInWindow ? round2(acc.billed) : null;
      // Only subtract when the answer can mean something: a party carrying a
      // balance from before MAR-2024 would otherwise show a negative receipt.
      const collectable = totalBilled !== null && totalBilled >= outstanding;
      return {
        customerName: acc.customerName,
        variants: [...acc.variants].sort(),
        outstanding,
        totalBilled,
        totalReceived: collectable ? round2(totalBilled - outstanding) : null,
        tickets: acc.tickets,
        status: (outstanding > 0 ? 'PENDING' : 'RECEIVED') as ReceivableStatus,
        carriedIn: acc.onBalanceSheet && !acc.billedInWindow,
      };
    }).sort((a, b) => b.outstanding - a.outstanding
                   || a.customerName.localeCompare(b.customerName));

    const sumOfLines = round2(all.reduce((sum, r) => sum + r.outstanding, 0));
    const stated = block.stated_total === null ? sumOfLines : Number(block.stated_total);

    return {
      totalOutstanding: round2(stated),
      sumOfLines,
      discrepancy: block.receivable_discrepancy === null
        ? null : round2(Number(block.receivable_discrepancy)),
      asOfMonth: String(block.month_year).slice(0, 10),
      asOfLabel: String(block.month_label),
      sourceFile: String(block.file_name),
      sourceSheet: String(block.sheet_name),
      totalBilled: round2(all.reduce((sum, r) => sum + (r.totalBilled ?? 0), 0)),
      customers: all.length,
      pending: all.filter((r) => r.status === 'PENDING').length,
      received: all.filter((r) => r.status === 'RECEIVED').length,
      periodFrom: PERIOD_FROM,
      periodTo: PERIOD_TO,
      rows: filters.status ? all.filter((r) => r.status === filters.status) : all,
    };
  },

  /** Every month's stated receivable, oldest first — the trend behind the KPI. */
  async history(companyId: number) {
    const rows = await query<Row[]>(
      `SELECT month_label, month_year, file_name, sheet_name,
              stated_total, receivable_discrepancy,
              (SELECT COUNT(*) FROM sales_file_receivables r WHERE r.sales_file_id = sf.id) AS parties
         FROM sales_files sf
        WHERE company_id = ? AND sheet_shape = 'ACCOUNTS' AND is_primary = 1
          AND stated_total IS NOT NULL
        ORDER BY month_year`, [companyId]);
    return rows.map((r) => ({
      monthLabel: String(r.month_label),
      monthYear: String(r.month_year).slice(0, 10),
      sourceFile: String(r.file_name),
      sourceSheet: String(r.sheet_name),
      outstanding: round2(Number(r.stated_total)),
      parties: Number(r.parties),
      discrepancy: r.receivable_discrepancy === null ? null : round2(Number(r.receivable_discrepancy)),
    }));
  },

  /**
   * The spelling groups themselves, for a human to check.
   *
   * Nothing merges the customer master automatically (see `nameMatching.ts`),
   * so this is the list somebody signs off before that is ever considered.
   */
  async nameGroups(companyId: number) {
    const [billed, onSheets] = await Promise.all([
      query<Row[]>(BILLED_SQL, [companyId, PERIOD_FROM, PERIOD_TO]),
      query<Row[]>(
        `SELECT r.party_name, COUNT(*) AS tickets, SUM(r.amount) AS billed
           FROM sales_file_receivables r
           JOIN sales_files sf ON sf.id = r.sales_file_id
          WHERE sf.company_id = ? AND sf.is_primary = 1
          GROUP BY r.party_name`, [companyId]),
    ]);

    const weights = new Map<string, NameWeight>();
    for (const r of [...billed, ...onSheets]) {
      const name = String(r.party_name).trim();
      const key = normaliseName(name);
      const seen = weights.get(key);
      if (seen) { seen.rows += Number(r.tickets); seen.amount += Number(r.billed); }
      else weights.set(key, { name, rows: Number(r.tickets), amount: Number(r.billed) });
    }

    return clusterNames([...weights.values()])
      .filter((c) => c.variants.length > 1)
      .sort((a, b) => b.variants.length - a.variants.length
                   || a.canonical.localeCompare(b.canonical));
  },
};
