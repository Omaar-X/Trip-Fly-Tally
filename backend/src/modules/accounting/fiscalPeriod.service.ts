import { PoolConnection } from 'mysql2/promise';
import { Row } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { today, isRealDate, daysInMonth } from '../../utils/date';

/**
 * =========================== FISCAL PERIOD CONTROL ==========================
 * Books have a beginning, a year, and a past that can be closed. Without those
 * three ideas a double-entry system is only a list of journal lines: last
 * year's audited profit can still change, document numbers cannot restart, and
 * a typo dated 1990 posts happily.
 *
 * Three rules, enforced in ONE place (assertPostable) that every posting path
 * runs through — manual vouchers, booking confirmation, payments, payroll and
 * stock movements alike:
 *
 *   1. NOT BEFORE THE BOOKS BEGIN   date >= books_begin_from
 *      Opening balances express the position on the day before this date, so a
 *      voucher older than it would be counted twice.
 *
 *   2. NOT INTO A CLOSED PERIOD     date > books_locked_upto
 *      Once a year is filed, the CEO locks it. Corrections after that must be
 *      posted in the open period as a reversal — which is what Tally forces
 *      too, and what makes a printed Balance Sheet stay true.
 *
 *   3. NOT IN THE FUTURE           date <= today (business timezone)
 *      Revenue and cash cannot be recognised before they happen.
 *
 * The financial year itself is derived from the company's fy_start_month
 * (Bangladesh runs July–June, so 7). It drives document numbering and the
 * default report ranges.
 * ============================================================================
 */

export interface FinancialYear {
  /** '2026-2027' — the label document numbers are drawn against. */
  label: string;
  from: string;
  to: string;
}

export interface BooksPolicy {
  companyId: number;
  fyStartMonth: number;
  booksBeginFrom: string | null;
  booksLockedUpto: string | null;
}

/** The financial year a given date falls in, for a given FY start month. */
export function financialYearOf(date: string, fyStartMonth: number): FinancialYear {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startYear = month >= fyStartMonth ? year : year - 1;

  // A January start means the FY is a plain calendar year and ends in December
  // of the SAME year; any other start month ends in the previous month of the
  // following year.
  const endYear = fyStartMonth === 1 ? startYear : startYear + 1;
  const endMonth = fyStartMonth === 1 ? 12 : fyStartMonth - 1;

  return {
    label: `${startYear}-${endYear}`,
    from: `${startYear}-${pad(fyStartMonth)}-01`,
    to: `${endYear}-${pad(endMonth)}-${pad(daysInMonth(endYear, endMonth))}`,
  };
}

/** The financial year in progress right now. */
export const currentFinancialYear = (fyStartMonth: number): FinancialYear =>
  financialYearOf(today(), fyStartMonth);

/**
 * Reads the posting policy inside the caller's transaction so a concurrent
 * lock change cannot be read stale mid-post.
 */
export async function loadBooksPolicyTx(
  conn: PoolConnection, companyId: number
): Promise<BooksPolicy> {
  const [rows] = await conn.query<Row[]>(
    'SELECT id, fy_start_month, books_begin_from, books_locked_upto FROM companies WHERE id = ?',
    [companyId]);
  if (!rows.length) throw ApiError.badRequest('Company not found');
  return toPolicy(rows[0]);
}

export function toPolicy(row: Row): BooksPolicy {
  return {
    companyId: Number(row.id),
    fyStartMonth: normaliseStartMonth(row.fy_start_month),
    booksBeginFrom: (row.books_begin_from as string | null) ?? null,
    booksLockedUpto: (row.books_locked_upto as string | null) ?? null,
  };
}

/**
 * The single gate every posting date passes through. Throws with a message
 * that says which rule was broken and what the operator can do about it.
 */
export function assertPostable(date: string, policy: BooksPolicy, what = 'voucher'): void {
  if (!isRealDate(date))
    throw ApiError.badRequest(`${cap(what)} date "${date}" is not a real calendar date`);

  if (policy.booksBeginFrom && date < policy.booksBeginFrom)
    throw ApiError.badRequest(
      `${cap(what)} date ${date} is before the books begin (${policy.booksBeginFrom}). ` +
      `Anything earlier belongs in the opening balances, not in a voucher.`);

  if (policy.booksLockedUpto && date <= policy.booksLockedUpto)
    throw ApiError.conflict(
      `Period is closed: the books are locked up to ${policy.booksLockedUpto}, ` +
      `so nothing can be posted on ${date}. Post the correction in the open period instead.`);

  const boundary = today();
  if (date > boundary)
    throw ApiError.badRequest(
      `${cap(what)} date ${date} is in the future (today is ${boundary}).`);
}

/**
 * Validates a lock date before it is saved. Moving the lock backwards is
 * allowed — reopening a period is a deliberate act — but it may never be set
 * beyond today, which would freeze the period people are still working in.
 */
export function assertLockDateUsable(lockDate: string | null, policy: BooksPolicy): void {
  if (lockDate === null) return;
  if (!isRealDate(lockDate))
    throw ApiError.badRequest(`Lock date "${lockDate}" is not a real calendar date`);

  // The lock is inclusive and the future is already closed, so locking up to
  // today would leave no postable day at all: the books would be frozen solid
  // until midnight, and not even a correction could be entered. A lock closes
  // a period that has ENDED.
  const boundary = today();
  if (lockDate >= boundary)
    throw ApiError.conflict(
      `Books can only be locked up to a date that has passed — ${lockDate} would leave no open day ` +
      `to post in (today is ${boundary}). Lock up to the last day of the period you are closing.`);

  if (policy.booksBeginFrom && lockDate < policy.booksBeginFrom)
    throw ApiError.badRequest(
      `Lock date ${lockDate} is before the books begin (${policy.booksBeginFrom})`);
}

const pad = (n: number): string => String(n).padStart(2, '0');
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function normaliseStartMonth(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 7;   // Bangladesh default
}
