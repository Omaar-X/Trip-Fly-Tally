import { RawCell, cellAmount, cellText, norm } from './primitives';

/**
 * ================== READING THE MONTH-END CONTROL SHEET =====================
 *
 * The ACCOUNTS / BALANCE SHEET sheets are the client's own month-end summary,
 * prepared by hand. They are the control values the migration is reconciled
 * against — and they are never a posting source. Nothing in this file produces
 * a transaction.
 *
 * The layout is two balance-sheet halves side by side:
 *
 *     PARTICULARS | AMOUNT | AMOUNT |   | PARTICULARS | AMOUNT | AMOUNT
 *     OWNERS CAPITALS |    | 3,460,650.99 |  | SALES |     | 8,339,187.56
 *
 * A label can carry its figure in either amount column — a detail line uses the
 * first, a section total the second — so both are read and the rightmost
 * non-empty one wins, which is how the sheet reads to a person.
 */

export interface ControlValues {
  sheet: string;
  /** Every label → amount pair found, for the record. */
  lines: { label: string; amount: number }[];
  /** The figures reconciliation compares against. Null when the sheet omits one. */
  sales: number | null;
  purchase: number | null;
  expenses: number | null;
  receivable: number | null;
  payable: number | null;
  bank: number | null;
  cash: number | null;
  capital: number | null;
  fixedAssets: number | null;
  netProfit: number | null;
  netLoss: number | null;
  grandTotal: number | null;
}

/** Labels that name a section total rather than a detail line. */
const WANTED: Record<keyof Omit<ControlValues, 'sheet' | 'lines'>, string[]> = {
  sales: ['SALES'],
  purchase: ['PURCHASE'],
  expenses: ['EXPENSES', 'EXPENCES'],
  receivable: ['ACCOUNTS RECEIVABLE'],
  payable: ['ACCOUNTS PAYBLE', 'ACCOUNTS PAYABLE'],
  bank: ['AT BANK'],
  cash: ['CASH IN HAND'],
  capital: ['OWNERS CAPITALS', 'OWNERS CAPITAL', 'OWNER CAPITAL'],
  fixedAssets: ['FIXED ASSET', 'FIXED ASSETS'],
  netProfit: ['NET PROFIT'],
  netLoss: ['NET LOSS'],
  grandTotal: [],
};

/**
 * Pull the control figures out of one ACCOUNTS sheet.
 *
 * Deliberately forgiving about position and strict about names: the sheets
 * differ in how many rows they use and which half a section sits in, but the
 * wording of the section labels has been stable for fifteen months.
 */
export function parseAccountsControl(
  sheetRows: { rowNumber: number; cells: RawCell[] }[],
  sheetName: string,
): ControlValues {
  const out: ControlValues = {
    sheet: sheetName, lines: [],
    sales: null, purchase: null, expenses: null, receivable: null, payable: null,
    bank: null, cash: null, capital: null, fixedAssets: null,
    netProfit: null, netLoss: null, grandTotal: null,
  };

  for (const { cells } of sheetRows) {
    // Walk the row looking for "some text, then a number to its right". Both
    // halves of the sheet are covered by the same sweep.
    for (let i = 0; i < cells.length; i++) {
      const label = cellText(cells[i]);
      if (!label || cellAmount(cells[i]) != null) continue;

      // The figure sits in one of the next two cells; the rightmost wins,
      // because that is the section-total column.
      let amount: number | null = null;
      for (let j = i + 1; j <= i + 2 && j < cells.length; j++) {
        const v = cellAmount(cells[j]);
        if (v != null) amount = v;
      }
      if (amount == null) continue;

      out.lines.push({ label, amount });

      const key = norm(label);
      for (const [field, names] of Object.entries(WANTED) as [keyof typeof WANTED, string[]][]) {
        // First occurrence wins: the section total appears before the detail
        // lines that repeat similar wording underneath it.
        if (names.includes(key) && out[field] == null) out[field] = amount;
      }
      i++; // the amount cell has been consumed
    }
  }

  // The grand total is the largest figure on the sheet and appears on both
  // sides; taking the max avoids depending on which row it landed in.
  const totals = out.lines.map((l) => l.amount);
  out.grandTotal = totals.length ? Math.max(...totals) : null;

  return out;
}
