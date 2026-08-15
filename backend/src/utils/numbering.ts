import { PoolConnection } from 'mysql2/promise';
import { Row, WriteResult } from '../config/db';
import { FinancialYear } from '../modules/accounting/fiscalPeriod.service';

/**
 * ========================== DOCUMENT NUMBERING ==============================
 * Numbers are drawn from `voucher_sequences`, one counter per
 * (company, document kind, financial year), by an atomic
 *
 *     UPDATE … SET last_no = last_no + 1
 *
 * followed by a read of the row this transaction just moved. Two properties
 * fall out of that, and both were missing before:
 *
 *   • CONCURRENCY-SAFE. The previous implementation derived the next number
 *     from SELECT COUNT(*) … FOR UPDATE. That serialised every insert on a
 *     table-wide gap lock, and under READ COMMITTED it handed the same number
 *     to two transactions at once — the unique key then turned an ordinary
 *     save into a 500.
 *
 *   • YEAR-CORRECT. The year in the number now comes from the FINANCIAL YEAR
 *     OF THE DOCUMENT'S OWN DATE. It used to come from `new Date()`, so a
 *     voucher backdated to 2025-12-30 and entered in January was stamped
 *     SV-2026-…, filing it under the wrong year in every printed register.
 *
 * Sequences restart at 1 each financial year, exactly as Tally does.
 * ============================================================================
 */

const VOUCHER_PREFIX: Record<string, string> = {
  JOURNAL: 'JV', PAYMENT: 'PV', RECEIPT: 'RV', SALES: 'SV', PURCHASE: 'PUR',
  CONTRA: 'CV', DEBIT_NOTE: 'DN', CREDIT_NOTE: 'CN',
};

export type DocumentFamily = 'INVOICE' | 'BOOKING' | 'PAYMENT_DOC' | 'STOCK';

const DOC_PREFIX: Record<DocumentFamily, string> = {
  INVOICE: 'INV', BOOKING: 'BK', PAYMENT_DOC: 'PMT', STOCK: 'STK',
};

/**
 * Reserves the next number for a document kind within a financial year.
 * Must be called inside a transaction: the counter is only truly consumed when
 * that transaction commits, so a rolled-back save leaves no gap.
 */
async function nextInSequence(
  conn: PoolConnection, companyId: number, docKind: string, fy: FinancialYear
): Promise<number> {
  // Two statements, deliberately.
  //
  // The tempting one-liner is INSERT … VALUES (…, LAST_INSERT_ID(1)) ON
  // DUPLICATE KEY UPDATE last_no = LAST_INSERT_ID(last_no + 1). It is wrong
  // here: voucher_sequences has an AUTO_INCREMENT primary key, and when the
  // INSERT branch fires, MySQL overwrites the value we handed LAST_INSERT_ID()
  // with the newly generated row id. The first document of each kind then
  // takes its number from the counter table's row id — the fourth counter
  // created hands out number 4 while storing last_no = 1 — and the sequence
  // walks straight back over that number a few documents later, failing on the
  // unique key.
  //
  // So: create the counter if it is missing (a no-op update keeps the row lock
  // on the already-exists path), then bump and read it back. An UPDATE never
  // assigns an AUTO_INCREMENT, so LAST_INSERT_ID(expr) survives intact.
  await conn.query(
    `INSERT INTO voucher_sequences (company_id, doc_kind, fy_label, last_no)
     VALUES (?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE last_no = last_no`,
    [companyId, docKind, fy.label]);

  const [res] = await conn.query<WriteResult>(
    `UPDATE voucher_sequences SET last_no = LAST_INSERT_ID(last_no + 1)
      WHERE company_id = ? AND doc_kind = ? AND fy_label = ?`,
    [companyId, docKind, fy.label]);

  const reserved = Number(res.insertId);
  if (reserved > 0) return reserved;

  // Defensive: if a driver or proxy ever drops last_insert_id from the OK
  // packet, re-read the row this transaction already holds the lock on.
  const [rows] = await conn.query<Row[]>(
    `SELECT last_no FROM voucher_sequences
      WHERE company_id = ? AND doc_kind = ? AND fy_label = ?`,
    [companyId, docKind, fy.label]);
  return Number(rows[0]?.last_no ?? 1);
}

/** Sequential voucher number for a type, e.g. SV-2026-2027-00014. */
export async function nextVoucherNo(
  conn: PoolConnection, companyId: number, type: string, fy: FinancialYear
): Promise<string> {
  const n = await nextInSequence(conn, companyId, type, fy);
  return format(VOUCHER_PREFIX[type] ?? 'V', fy, n);
}

/** Sequential number for a business document (invoice, booking, payment). */
export async function nextDocNo(
  conn: PoolConnection, companyId: number, family: DocumentFamily,
  fy: FinancialYear, prefixOverride?: string
): Promise<string> {
  const n = await nextInSequence(conn, companyId, family, fy);
  return format(prefixOverride ?? DOC_PREFIX[family], fy, n);
}

/**
 * Refunds share the payment sequence — they are payments — but carry a REF
 * prefix so a refund is recognisable at a glance in a list of documents.
 */
export const paymentDocPrefix = (isRefund: boolean): string => (isRefund ? 'REF' : 'PMT');

const format = (prefix: string, fy: FinancialYear, n: number): string =>
  `${prefix}-${fy.label}-${String(n).padStart(5, '0')}`;
