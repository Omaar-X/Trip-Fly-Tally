import { PoolConnection } from 'mysql2/promise';
import { query, Row, WriteResult } from '../../config/db';

export interface VoucherEntryInput {
  ledgerId: number;
  type: 'DR' | 'CR';
  amount: number;
  note?: string;
}

/** A persisted voucher_entries row, as needed to mirror a voucher. */
export interface VoucherEntryRow {
  ledger_id: number;
  entry_type: 'DR' | 'CR';
  amount: number;
  line_note: string | null;
}

/** The voucher header fields the reversal engine reads. */
export interface VoucherRow {
  id: number;
  company_id: number;
  voucher_no: string;
  voucher_type: string;
  voucher_date: string;
  narration: string | null;
  reference: string | null;
  total_amount: number;
  status: 'ACTIVE' | 'REVERSED';
  reversal_of_voucher_id: number | null;
  reversed_by_voucher_id: number | null;
  created_by: number;
}

export interface LockedVoucher extends VoucherRow {
  entries: VoucherEntryRow[];
}

export const accountingRepo = {
  // ---------------- ledger groups ----------------
  listGroups: (companyId: number) =>
    query<Row[]>(
      `SELECT g.id, g.name, g.nature, g.parent_id, p.name AS parent_name
         FROM ledger_groups g LEFT JOIN ledger_groups p ON p.id = g.parent_id
        WHERE g.company_id = ? ORDER BY g.nature, g.name`, [companyId]),

  // ---------------- ledgers ----------------
  /**
   * Chart of accounts with lifetime turnover and the closing balance already
   * signed for the ledger's nature, so every consumer reads one number instead
   * of re-deriving the sign rule. Entries are joined THROUGH vouchers so a row
   * can only ever count movement that belongs to this company.
   */
  listLedgers: (companyId: number) =>
    query<Row[]>(
      `SELECT l.id, l.name, l.opening_balance, l.opening_type, l.is_system,
              g.name AS group_name, g.nature,
              COALESCE(SUM(CASE WHEN ve.entry_type = 'DR' THEN ve.amount ELSE 0 END), 0) AS total_debit,
              COALESCE(SUM(CASE WHEN ve.entry_type = 'CR' THEN ve.amount ELSE 0 END), 0) AS total_credit,
              ROUND(
                (CASE WHEN g.nature IN ('ASSET','EXPENSE')
                      THEN CASE WHEN l.opening_type = 'DR' THEN l.opening_balance ELSE -l.opening_balance END
                      ELSE CASE WHEN l.opening_type = 'CR' THEN l.opening_balance ELSE -l.opening_balance END
                 END)
                + (CASE WHEN g.nature IN ('ASSET','EXPENSE') THEN 1 ELSE -1 END)
                  * COALESCE(SUM(CASE WHEN ve.entry_type = 'DR' THEN ve.amount ELSE -ve.amount END), 0)
              , 2) AS closing_balance
         FROM ledgers l
         JOIN ledger_groups g ON g.id = l.group_id
         LEFT JOIN (
           voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
         ) ON ve.ledger_id = l.id AND v.company_id = l.company_id
        WHERE l.company_id = ?
        GROUP BY l.id, l.name, l.opening_balance, l.opening_type, l.is_system, g.name, g.nature
        ORDER BY g.nature, l.name`, [companyId]),

  getLedger: async (companyId: number, id: number) => {
    const rows = await query<Row[]>(
      `SELECT l.*, g.name AS group_name, g.nature FROM ledgers l
         JOIN ledger_groups g ON g.id = l.group_id
        WHERE l.company_id = ? AND l.id = ?`, [companyId, id]);
    return rows[0];
  },

  /**
   * Movement on a ledger strictly BEFORE a date. This is what turns a master
   * opening balance into a period opening balance: a June statement must open
   * where May closed, not where the ledger was first created.
   */
  movementBefore: async (companyId: number, ledgerId: number, from: string) => {
    const rows = await query<Row[]>(
      `SELECT COALESCE(SUM(CASE WHEN ve.entry_type = 'DR' THEN ve.amount END), 0) AS dr,
              COALESCE(SUM(CASE WHEN ve.entry_type = 'CR' THEN ve.amount END), 0) AS cr
         FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
        WHERE v.company_id = ? AND ve.ledger_id = ? AND v.voucher_date < ?`,
      [companyId, ledgerId, from]);
    return { dr: Number(rows[0]?.dr ?? 0), cr: Number(rows[0]?.cr ?? 0) };
  },

  /** Statement of a single ledger with every voucher line that touched it. */
  ledgerStatement: (companyId: number, ledgerId: number, from: string, to: string) =>
    query<Row[]>(
      `SELECT v.voucher_date, v.voucher_no, v.voucher_type, v.narration,
              ve.entry_type, ve.amount
         FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
        WHERE v.company_id = ? AND ve.ledger_id = ? AND v.voucher_date BETWEEN ? AND ?
        ORDER BY v.voucher_date, v.id`, [companyId, ledgerId, from, to]),

  createLedger: async (conn: PoolConnection, companyId: number,
    input: { groupId: number; name: string; openingBalance: number; openingType: 'DR' | 'CR' }) => {
    const [result] = await conn.query<WriteResult>(
      `INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type)
       VALUES (?,?,?,?,?)`,
      [companyId, input.groupId, input.name, input.openingBalance, input.openingType]);
    return result.insertId;
  },

  // ---------------- vouchers ----------------
  insertVoucher: async (conn: PoolConnection, v: {
    companyId: number; voucherNo: string; type: string; date: string;
    narration?: string; reference?: string; total: number; createdBy: number;
    reversalOfVoucherId?: number | null;
  }) => {
    const [result] = await conn.query<WriteResult>(
      `INSERT INTO vouchers (company_id, voucher_no, voucher_type, voucher_date, narration, reference,
                             total_amount, created_by, reversal_of_voucher_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [v.companyId, v.voucherNo, v.type, v.date, v.narration ?? null, v.reference ?? null,
       v.total, v.createdBy, v.reversalOfVoucherId ?? null]);
    return result.insertId;
  },

  /**
   * Locks a voucher and returns it with its entries. FOR UPDATE is what makes
   * two concurrent reversals of the same voucher serialise — the second one
   * observes status = 'REVERSED' and is refused.
   */
  lockVoucherWithEntries: async (
    conn: PoolConnection, companyId: number, voucherId: number
  ): Promise<LockedVoucher | undefined> => {
    const [heads] = await conn.query<Row[]>(
      'SELECT * FROM vouchers WHERE company_id = ? AND id = ? FOR UPDATE', [companyId, voucherId]);
    if (!heads[0]) return undefined;
    const [entries] = await conn.query<Row[]>(
      'SELECT ledger_id, entry_type, amount, line_note FROM voucher_entries WHERE voucher_id = ? ORDER BY id',
      [voucherId]);
    return { ...(heads[0] as unknown as VoucherRow), entries: entries as unknown as VoucherEntryRow[] };
  },

  /** Marks the original as superseded and records who reversed it, when and why. */
  markVoucherReversed: async (conn: PoolConnection, voucherId: number, v: {
    reversedByVoucherId: number; reversedBy: number; reason?: string | null;
  }) => {
    await conn.query(
      `UPDATE vouchers
          SET status = 'REVERSED', reversed_by_voucher_id = ?, reversed_by = ?,
              reversed_at = NOW(), reversal_reason = ?
        WHERE id = ?`,
      [v.reversedByVoucherId, v.reversedBy, v.reason ?? null, voucherId]);
  },

  insertEntries: async (conn: PoolConnection, voucherId: number, entries: VoucherEntryInput[]) => {
    const values = entries.map(e => [voucherId, e.ledgerId, e.type, e.amount, e.note ?? null]);
    await conn.query(
      'INSERT INTO voucher_entries (voucher_id, ledger_id, entry_type, amount, line_note) VALUES ?', [values]);
  },

  /** A page of vouchers plus the true total, so the UI can say "of 1,234". */
  listVouchers: async (companyId: number, filters: {
    type?: string; from?: string; to?: string; limit: number; offset: number;
  }): Promise<{ rows: Row[]; total: number }> => {
    const where: string[] = ['v.company_id = ?'];
    const params: unknown[] = [companyId];
    if (filters.type) { where.push('v.voucher_type = ?'); params.push(filters.type); }
    if (filters.from) { where.push('v.voucher_date >= ?'); params.push(filters.from); }
    if (filters.to)   { where.push('v.voucher_date <= ?'); params.push(filters.to); }

    const from = `FROM vouchers v JOIN users u ON u.id = v.created_by
        WHERE ${where.join(' AND ')}`;

    const [{ total }] = await query<Row[]>(`SELECT COUNT(*) AS total ${from}`, params);
    const rows = await query<Row[]>(
      `SELECT v.id, v.voucher_no, v.voucher_type, v.voucher_date, v.narration, v.reference,
              v.total_amount, v.status, v.reversal_of_voucher_id, v.reversed_by_voucher_id,
              u.name AS created_by_name, v.created_at
         ${from}
        ORDER BY v.voucher_date DESC, v.id DESC
        LIMIT ? OFFSET ?`, [...params, filters.limit, filters.offset]);

    return { rows, total: Number(total) };
  },

  getVoucher: async (companyId: number, id: number) => {
    const heads = await query<Row[]>(
      `SELECT v.*, u.name AS created_by_name, ru.name AS reversed_by_name,
              orig.voucher_no AS reversal_of_voucher_no,
              rev.voucher_no  AS reversed_by_voucher_no
         FROM vouchers v
         JOIN users u ON u.id = v.created_by
         LEFT JOIN users ru      ON ru.id   = v.reversed_by
         LEFT JOIN vouchers orig ON orig.id = v.reversal_of_voucher_id
         LEFT JOIN vouchers rev  ON rev.id  = v.reversed_by_voucher_id
        WHERE v.company_id = ? AND v.id = ?`, [companyId, id]);
    if (!heads[0]) return undefined;
    const entries = await query<Row[]>(
      `SELECT ve.id, ve.ledger_id, l.name AS ledger_name, ve.entry_type, ve.amount, ve.line_note
         FROM voucher_entries ve JOIN ledgers l ON l.id = ve.ledger_id
        WHERE ve.voucher_id = ? ORDER BY ve.entry_type, ve.id`, [id]);
    return { ...heads[0], entries };
  }
};
