/**
 * ==================== WHICH FILE IS AUTHORITATIVE, PER MONTH ================
 *
 * Every entry below is a decision already taken and documented in the Phase 1,
 * 2 and 3 reports. This file exists so those decisions are executable rather
 * than re-litigated by whoever runs the migration.
 *
 * The three that matter most, because a plausible-looking alternative sits
 * right next to each of them in the same workbook:
 *
 *   Dec-2024   ACCOUNTS (3)              — the only version ending in a profit
 *   Oct-2024   OUTSTANDING Oct-24 (16)   — the version with SADMAN SAKIB merged
 *   Jan-2025   Sales JAN 25 (2)          — the full register carrying the
 *                                          Sri Lanka correction, NOT the 10-column
 *                                          client statements (3) and (4)
 *
 * Do not substitute an alternative here. If a file turns out to be corrupt, add
 * a REVIEW_REQUIRED item and raise it — silently switching source authority is
 * how a reconciliation stops meaning anything.
 */

export type SheetShape = 'PARTY_LEDGER' | 'SALES_REGISTER' | 'DAY_BOOK' | 'ACCOUNTS' | 'BANK_STATEMENT';

export interface SourceSheet {
  shape: SheetShape;
  file: string;
  sheet: string;
  /** The party a single-account ledger belongs to. */
  party?: string;
  note?: string;
}

export interface PeriodSources {
  period: string;
  label: string;
  sales?: SourceSheet;
  dayBook?: SourceSheet;
  /** The month-end control sheet these figures are reconciled against. */
  accounts?: SourceSheet;
  bank?: SourceSheet;
}

const RAZIB = 'MR RAZIB SIR.xlsx';

export const PERIODS: PeriodSources[] = [
  {
    period: '2024-03', label: 'March 2024',
    // Mar–May 2024 exists only as the Haque Group party ledger; there is no
    // sales register for these months.
    sales: { shape: 'PARTY_LEDGER', file: RAZIB, sheet: 'Sales March', party: 'HAQUE GROUP' },
    accounts: { shape: 'ACCOUNTS', file: 'BALANCE SHEET.xlsx', sheet: 'ACCOUNTS-MAR' },
    bank: { shape: 'BANK_STATEMENT', file: 'BRAC STMT. MAR-MAY-2024.xlsx', sheet: 'Sheet1' },
  },
  {
    period: '2024-04', label: 'April 2024',
    sales: { shape: 'PARTY_LEDGER', file: RAZIB, sheet: 'Sales April', party: 'HAQUE GROUP' },
    accounts: { shape: 'ACCOUNTS', file: 'BALANCE SHEET.xlsx', sheet: 'ACCOUNTS-APR' },
    bank: { shape: 'BANK_STATEMENT', file: 'BRAC STMT. MAR-MAY-2024.xlsx', sheet: 'Sheet1' },
  },
  {
    period: '2024-05', label: 'May 2024',
    sales: { shape: 'PARTY_LEDGER', file: RAZIB, sheet: 'Sales May', party: 'HAQUE GROUP' },
    accounts: { shape: 'ACCOUNTS', file: 'BALANCE SHEET.xlsx', sheet: 'ACCOUNTS-MAY' },
    bank: { shape: 'BANK_STATEMENT', file: 'BRAC STMT. MAR-MAY-2024.xlsx', sheet: 'Sheet1' },
  },
  {
    period: '2024-06', label: 'June 2024',
    sales: { shape: 'SALES_REGISTER', file: 'sales posting formate JUN-24 TO......xlsx', sheet: 'Sales Jun-24' },
    accounts: { shape: 'ACCOUNTS', file: 'sales posting formate JUN-24 TO......xlsx', sheet: 'ACCOUNTS' },
  },
  {
    period: '2024-07', label: 'July 2024',
    sales: { shape: 'SALES_REGISTER', file: 'sales JUL-24.xlsx', sheet: 'Sales Jul-24' },
    accounts: { shape: 'ACCOUNTS', file: 'sales JUL-24.xlsx', sheet: 'ACCOUNTS' },
  },
  {
    period: '2024-08', label: 'August 2024',
    sales: { shape: 'SALES_REGISTER', file: 'Sales AUGUST-24.xlsx', sheet: 'Sales AUG-24' },
    accounts: { shape: 'ACCOUNTS', file: 'Sales AUGUST-24.xlsx', sheet: 'ACCOUNTS' },
  },
  {
    period: '2024-09', label: 'September 2024',
    sales: { shape: 'SALES_REGISTER', file: 'SALES SEPTEMBER-24.xlsx', sheet: 'Sales SEP-24' },
    dayBook: {
      shape: 'DAY_BOOK', file: 'SALES SEPTEMBER-24.xlsx', sheet: "Daily Statement SEP'24",
      note: 'Covers 25–30 September only; the first three weeks have no day book.',
    },
    accounts: { shape: 'ACCOUNTS', file: 'SALES SEPTEMBER-24.xlsx', sheet: 'ACCOUNTS' },
  },
  {
    period: '2024-10', label: 'October 2024',
    sales: { shape: 'SALES_REGISTER', file: 'SALES OCTOBER-24.xlsx', sheet: 'Sales OCT-24' },
    dayBook: { shape: 'DAY_BOOK', file: 'SALES OCTOBER-24.xlsx', sheet: "Daily Statement OCT'24" },
    accounts: { shape: 'ACCOUNTS', file: 'SALES OCTOBER-24.xlsx', sheet: 'ACCOUNTS' },
  },
  {
    period: '2024-11', label: 'November 2024',
    sales: { shape: 'SALES_REGISTER', file: 'SALES NOVEMBER-24.xlsx', sheet: 'Sales NOV-24' },
    dayBook: { shape: 'DAY_BOOK', file: 'SALES NOVEMBER-24.xlsx', sheet: "Daily Statement NOV'24" },
    accounts: { shape: 'ACCOUNTS', file: 'SALES NOVEMBER-24.xlsx', sheet: 'ACCOUNTS' },
  },
  {
    period: '2024-12', label: 'December 2024',
    sales: { shape: 'SALES_REGISTER', file: 'SALES DECEMBER-24.xlsx', sheet: 'Sales DEC-24' },
    // ACCOUNTS (3): the only Dec version ending in a NET PROFIT, and the one
    // carrying the client's own GROUPO spelling correction.
    accounts: {
      shape: 'ACCOUNTS', file: 'SALES DECEMBER-24.xlsx', sheet: 'ACCOUNTS (3)',
      note: 'Authoritative per CLIENT_DECISIONS §2.1. Do not substitute ACCOUNTS or ACCOUNTS (2).',
    },
  },
  {
    period: '2025-01', label: 'January 2025',
    // Sales JAN 25 (2) carries the Sri Lanka Land Package correction
    // (916,827 → 716,827). (3) and (4) are 10-column client statements and
    // drop every accounting column.
    sales: {
      shape: 'SALES_REGISTER', file: 'SALES JAN-25.xlsx', sheet: 'Sales JAN 25 (2)',
      note: 'Authoritative per CLIENT_DECISIONS §2.3. Do not substitute the condensed (3)/(4).',
    },
    accounts: { shape: 'ACCOUNTS', file: 'SALES JAN-25.xlsx', sheet: 'ACCOUNTS' },
  },
  {
    period: '2025-02', label: 'February 2025',
    sales: { shape: 'SALES_REGISTER', file: 'SALES FEB-25.xlsx', sheet: 'Sales FEB 25' },
    accounts: { shape: 'ACCOUNTS', file: 'SALES FEB-25.xlsx', sheet: 'ACCOUNTS' },
  },
  {
    period: '2025-03', label: 'March 2025',
    sales: { shape: 'SALES_REGISTER', file: 'SALES MAR-25.xlsx', sheet: 'Sales MAR 25' },
    accounts: { shape: 'ACCOUNTS', file: 'SALES MAR-25.xlsx', sheet: 'ACCOUNTS' },
  },
  {
    period: '2025-04', label: 'April 2025',
    sales: { shape: 'SALES_REGISTER', file: 'SALES-APR.xlsx', sheet: 'Sales APR 25' },
    dayBook: { shape: 'DAY_BOOK', file: 'Daily Books Received & Payments.xlsx', sheet: 'APR-25' },
    accounts: { shape: 'ACCOUNTS', file: 'SALES-APR.xlsx', sheet: 'ACCOUNTS' },
  },
  {
    period: '2025-05', label: 'May 2025',
    sales: { shape: 'SALES_REGISTER', file: 'SALES-MAY.xlsx', sheet: 'Sales MAY 25' },
    dayBook: { shape: 'DAY_BOOK', file: 'Daily Books Received & Payments.xlsx', sheet: 'MAY-25' },
    accounts: { shape: 'ACCOUNTS', file: 'SALES-MAY.xlsx', sheet: 'ACCOUNTS' },
  },
  {
    period: '2025-06', label: 'June 2025',
    sales: { shape: 'SALES_REGISTER', file: 'SALES-JUN.xlsx', sheet: 'Sales JUN 25' },
    dayBook: { shape: 'DAY_BOOK', file: 'Daily Books Received & Payments.xlsx', sheet: 'JUN-25' },
    accounts: { shape: 'ACCOUNTS', file: 'SALES-JUN.xlsx', sheet: 'ACCOUNTS' },
  },
];

/** The pilot, run and verified before any other month is touched. */
export const PILOT_PERIODS = ['2024-03', '2024-04', '2024-05'];

/** The order the remaining months are migrated in, after the pilot passes. */
export const SEQUENCE = PERIODS.map((p) => p.period);

export const findPeriod = (period: string): PeriodSources | undefined =>
  PERIODS.find((p) => p.period === period);
