import { env } from '../config/env';

/**
 * ============================== BUSINESS CALENDAR ============================
 * Dates in this system are calendar dates, never instants. A voucher dated
 * 2026-06-30 belongs to June whoever reads it and wherever the server runs, so
 * every helper here works on `YYYY-MM-DD` strings and never on Date arithmetic
 * that could drift by a timezone.
 *
 * `today()` is the calendar date in the BUSINESS timezone (env.businessTimezone,
 * Asia/Dhaka by default) — not the server's UTC date. Judging "is this
 * future-dated?" against UTC would reject perfectly valid vouchers for the six
 * hours each night when Dhaka is already on the next day and UTC is not.
 * ============================================================================
 */

const ISO_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True only for a date that actually exists. `2026-02-31` and `2026-13-01`
 * match the ISO shape but are not real days — MySQL in STRICT mode rejects
 * them at INSERT time, which surfaces as a 500 instead of a clean 400 unless
 * they are caught here first.
 */
export function isRealDate(value: string): boolean {
  const m = ISO_SHAPE.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

/** Days in a month, leap years included. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Today's calendar date in the business timezone, as YYYY-MM-DD. */
export function today(): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.businessTimezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Last calendar day of a month, as YYYY-MM-DD. */
export function endOfMonth(year: number, month: number): string {
  return `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`;
}

/** First calendar day of a month, as YYYY-MM-DD. */
export function startOfMonth(year: number, month: number): string {
  return `${year}-${pad(month)}-01`;
}

/** The day before the given date. Used to express "opening as at". */
export function previousDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}`;
}

/** String comparison is date comparison for zero-padded ISO dates. */
export const isBefore = (a: string, b: string): boolean => a < b;
export const isAfter = (a: string, b: string): boolean => a > b;

const pad = (n: number): string => String(n).padStart(2, '0');
