import { normalizeToken, KNOWN_SUPPLIERS } from './historicalRules';

/**
 * ============ WHAT A DAY-BOOK NARRATION SAYS THE MONEY WAS FOR =============
 *
 * Decision 2: classify from the source narration where it *clearly establishes*
 * the expense type, preserve the original wording alongside, and send anything
 * unclear to a named holding account rather than a plausible one.
 *
 * Every pattern below was written against the narrations that actually appear
 * in these day books, not guessed:
 *
 *   BANK CHARGE · BANK CHARGE & COMISSION · MOHIM BHAI FUEL · SABBIR BAZAR ·
 *   SABBIR CONVIENCE · CONVIENCE FOR SABBIR · CAR REPAIR · OFFICE RENT ·
 *   GARAGE RENT-APR-2025 · BONUS & SALARY · LOAN PAID TO CHAIRMAN MADAM
 *
 * Two rules keep this from drifting into keyword guessing:
 *
 *   1. **A single match wins; two matches park the row.** "OFFICE RENT AND
 *      CAR REPAIR" names two things and is not classified by either.
 *   2. **Nothing maps to a catch-all.** There is deliberately no rule sending
 *      leftovers to Office Expense or Miscellaneous. Unclear means unclear, and
 *      it goes to `Unclassified Historical Expense` with a review item.
 */

export const CLEARING = {
  UNKNOWN_SUPPLIER: 'Unknown / Unassigned Ticket Supplier',
  UNCLASSIFIED_EXPENSE: 'Unclassified Historical Expense',
  UNKNOWN_RECEIPT: 'Unidentified Historical Receipt / Customer Clearing',
  AMBIGUOUS_PARTY: 'Unidentified / Ambiguous Historical Party',
  SUSPENSE: 'Historical Suspense',
} as const;

export const CEO_LOAN_LEDGER = 'Loan to CEO - Rajib Sir';

/** Review reasons the decisions name explicitly. */
export const REVIEW_REASON = {
  UNKNOWN_SUPPLIER: 'UNKNOWN_HISTORICAL_TICKET_SUPPLIER',
  UNCLASSIFIED_EXPENSE: 'UNCLASSIFIED_HISTORICAL_EXPENSE',
  INCOMPLETE_SOURCE: 'INCOMPLETE_HISTORICAL_SOURCE_DATA',
  MISSING_SALES_SOURCE: 'MISSING_HISTORICAL_SALES_SOURCE',
  UNKNOWN_RECEIPT_PARTY: 'UNKNOWN_HISTORICAL_RECEIPT_PARTY',
  AMBIGUOUS_PARTY: 'AMBIGUOUS_HISTORICAL_PARTY',
  CEO_LOAN: 'HISTORICAL_CEO_LOAN',
} as const;

/**
 * Narration → expense ledger. The ledger names are exactly those migration 012
 * created; a pattern naming a ledger that does not exist would silently fall
 * through to Unclassified, which is the safe direction.
 */
const EXPENSE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bbank\s+charge|\bbank\s+comm?iss?ion|\bbank\s+charge\s*&\s*com/i, 'Bank Charge and Commission'],
  [/\bfuel\b|\boctane\b|\bpetrol\b/i, 'Vehicle Fuel'],
  [/\bbazar\b|\bbazaar\b/i, 'Office Bazar'],
  [/\bconvien[cs]e\b|\bconveyance\b|\bconvence\b/i, 'Conveyance'],
  [/\bcar\s+(repair|servicing|maint)/i, 'Car Repair Bill'],
  [/\b(office|garage|shop)\s+rent\b|\brent\b(?!\s*a\s*car)/i, 'Office Rent'],
  [/\bsalary\b|\bbonus\b|\bwages?\b/i, 'Salary Expense'],
  [/\bprinting\b|\bstation[ae]ry\b/i, 'Printing and Stationery'],
  [/\blicen[cs]e\s+renew/i, 'License Renewal'],
  [/\brepair\s*&?\s*maint|\bmaintain[cs]e\b/i, 'Repair and Maintenance'],
  [/\bcomputer\b|\bacc?ess?or/i, 'Computer Accessories'],
  [/\btax\s+(pay|paid)\b|\bvat\b/i, 'Tax Paid'],
  [/\bbusiness\s+card\b/i, 'Business Card'],
  [/\bpromoss?ional\b|\bpromotional\b|\badvertis/i, 'Promotional Expenses'],
  [/\bamanat\b/i, 'Amanat Purpose'],
  [/\bhujur\b/i, 'Hujur Salary'],
  [/\bmilad\b/i, 'Others / Milad'],
];

/**
 * Lenders the sources name. A "LOAN PAID TO CHAIRMAN MADAM" is a movement on a
 * loan account, not an expense, and booking it as one would overstate costs.
 */
const LOAN_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bloan\b.*\b(rajib|razib)\s+sir\b|\b(rajib|razib)\s+sir\b.*\bloan\b/i, CEO_LOAN_LEDGER],
  [/\bloan\b.*\b(madam|madame|chairman)\b|\b(madam|madame|chairman)\b.*\bloan\b/i, 'Loan - Madame (Tahmina Bashar)'],
  [/\bloan\b.*\babhijit\b|\babhijit\b.*\bloan\b/i, 'Loan - Abhijit Dey'],
  [/\bloan\b.*\b(eco[- ]?fuad|fuad)\b/i, 'Loan - Eco Fuad'],
];

export type CeoLoanMovement = 'ADVANCE' | 'REPAYMENT' | null;

/** Only explicit loan wording qualifies; a bare Rajib reference never does. */
export function classifyCeoLoanMovement(text: string | null | undefined): CeoLoanMovement {
  const value = (text ?? '').trim();
  if (!/\bloan\b/i.test(value) || !/\b(rajib|razib)\s+sir\b/i.test(value)) return null;
  if (/\b(repay|repaid|repayment|return(?:ed)?|received\s+from)\b/i.test(value)) return 'REPAYMENT';
  if (/\b(paid\s+to|give|given|advance(?:d)?)\b/i.test(value)) return 'ADVANCE';
  return null;
}

export type ExpenseVerdict =
  | { kind: 'EXPENSE'; ledger: string; matched: string }
  | { kind: 'LOAN'; ledger: string; matched: string }
  | { kind: 'VENDOR'; vendor: string }
  | { kind: 'UNCLASSIFIED' };

/**
 * What a payment narration establishes.
 *
 * Order matters. A vendor name is checked first because "HAJEE AIR PAYMENT" is
 * a supplier settlement, not an expense; loans next, because "LOAN PAID TO
 * CHAIRMAN MADAM" would otherwise never reach a loan account.
 */
export function classifyPaymentNarration(narration: string | null | undefined): ExpenseVerdict {
  const text = (narration ?? '').trim();
  if (!text) return { kind: 'UNCLASSIFIED' };

  // A known consolidator named anywhere in the line is that vendor being paid.
  const upper = normalizeToken(text);
  for (const [alias, canonical] of Object.entries(KNOWN_SUPPLIERS)) {
    // Guard against a one-word alias matching inside an unrelated word.
    const re = new RegExp(`(^|[^A-Z])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Z]|$)`);
    if (re.test(upper)) return { kind: 'VENDOR', vendor: canonical };
  }

  const loans = LOAN_PATTERNS.filter(([re]) => re.test(text));
  if (loans.length === 1) return { kind: 'LOAN', ledger: loans[0][1], matched: text };

  const hits = EXPENSE_PATTERNS.filter(([re]) => re.test(text));
  // Two different expense types in one line is exactly where a keyword guess
  // does the most damage, so it is parked instead.
  if (hits.length === 1) return { kind: 'EXPENSE', ledger: hits[0][1], matched: text };

  return { kind: 'UNCLASSIFIED' };
}

// ───────────────────────────── materiality ──────────────────────────────────

/**
 * Which review items are worth a person's time first (Decision 5).
 *
 * Material = it moves one of the figures the client listed: cash, bank,
 * customer or vendor balance, receivable, payable, sales, cost, profit,
 * capital, fixed assets, loans, a material expense classification, a duplicate
 * posting, or a wrong party mapping.
 *
 * Non-material items are still kept, still visible, and still resolvable — they
 * simply do not block finalisation.
 */
const MATERIAL_ISSUE_TYPES = new Set<string>([
  REVIEW_REASON.UNKNOWN_SUPPLIER,
  REVIEW_REASON.UNKNOWN_RECEIPT_PARTY,
  REVIEW_REASON.AMBIGUOUS_PARTY,
  REVIEW_REASON.MISSING_SALES_SOURCE,
  REVIEW_REASON.INCOMPLETE_SOURCE,
  'MISSING_VENDOR',
  'UNKNOWN_PARTY',
  'AMBIGUOUS_PARTY_MATCH',
  'POSSIBLE_DUPLICATE',
  'UNCLEAR_PAYMENT_METHOD',
  'BANK_DAILYBOOK_CONFLICT',
  'OUTSTANDING_MISMATCH',
  'PROFIT_MISMATCH',
  'CAPITAL_DIFFERENCE',
  'FIXED_ASSET_DIFFERENCE',
  'MISSING_ACCOUNTING_TREATMENT',
]);

/**
 * An unclassified expense is material only above a threshold: a 50-taka
 * conveyance line nobody can categorise does not need to hold up a year of
 * history, and a 3,650,000 loan payment does.
 */
export const MATERIALITY_THRESHOLD = 10_000;

export function isMaterial(issueType: string, amount: number | null | undefined): boolean {
  if (MATERIAL_ISSUE_TYPES.has(issueType)) return true;
  if (issueType === REVIEW_REASON.UNCLASSIFIED_EXPENSE || issueType === 'UNKNOWN_EXPENSE_CATEGORY')
    return Math.abs(amount ?? 0) >= MATERIALITY_THRESHOLD;
  // An unreadable row carrying real money is material; one carrying none is not.
  if (issueType === 'UNPARSEABLE_ROW') return Math.abs(amount ?? 0) >= MATERIALITY_THRESHOLD;
  return false;
}

/**
 * Periods whose sources are known not to represent the whole company
 * (Decision 3), and periods whose day book outruns the surviving sales
 * register (Decision 4).
 */
export const INCOMPLETE_PERIODS: Readonly<Record<string, string>> = {
  '2024-03': 'Only the Haque Group party ledger survives; the ACCOUNTS control is company-wide.',
  '2024-04': 'Only the Haque Group party ledger survives; the ACCOUNTS control is company-wide.',
  '2024-05': 'Only the Haque Group party ledger survives; the ACCOUNTS control is company-wide.',
};

export const MISSING_SALES_SOURCE_PERIODS: Readonly<Record<string, string>> = {
  '2024-10': 'The day book records receipts for the whole company; the sales register covers only part of it.',
  '2024-11': 'The day book records receipts for the whole company; the sales register covers only part of it.',
  '2025-04': 'The day book records receipts for the whole company; the sales register covers only part of it.',
  '2025-05': 'The day book records receipts for the whole company; the sales register covers only part of it.',
  '2025-06': 'The day book records receipts for the whole company; the sales register covers only part of it.',
};
