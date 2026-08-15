import { RowDataPacket } from 'mysql2';
import { env } from '../../config/env';
import { query } from '../../config/db';
import { ApiError } from '../../utils/ApiError';

export interface TableInfo {
  name: string;
  rows: number;
  sizeBytes: number;
  updatedAt: string | null;
}

const IDENTIFIER = /^[A-Za-z0-9_]+$/;
const MAX_LIMIT = 500;

const quoteIdentifier = (value: string): string => {
  if (!IDENTIFIER.test(value)) throw ApiError.badRequest('Invalid table name');
  return `\`${value}\``;
};

/**
 * ============================ SECRET REDACTION ==============================
 * Row scoping decides WHICH rows may be seen; this decides which COLUMNS may.
 *
 * `SELECT *` used to hand back bcrypt password hashes and refresh-token hashes
 * verbatim — in the row browser, the CSV, and the full JSON backup. Backups get
 * downloaded, mailed and archived, so that is durable offline-cracking material
 * and a session-replay surface.
 *
 * Two layers, because a denylist alone rots the moment someone adds a column:
 *   1. exact names we know about today
 *   2. patterns, so a future `password_reset_token` or `totp_secret` is caught
 *      the day it is added rather than the day it leaks
 * Every query builds an explicit column list from what survives both.
 * ============================================================================
 */
const SECRET_COLUMNS = new Set([
  'password_hash', 'refresh_token_hash', 'token_hash',
  'otp_secret', 'mfa_secret', 'totp_secret',
  'reset_token', 'verification_token', 'api_key', 'private_key',
]);

const SECRET_PATTERNS = [
  /password/i, /passwd/i, /secret/i, /_token$/i, /^token/i,
  /token_hash/i, /api_key/i, /private_key/i, /credential/i,
];

export const isSecretColumn = (name: string): boolean =>
  SECRET_COLUMNS.has(name.toLowerCase()) || SECRET_PATTERNS.some(p => p.test(name));

/** Column names of `table`, minus anything that must never leave the server. */
async function safeColumnNames(table: string): Promise<string[]> {
  const rows = await query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS name
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [env.db.database, table]
  );
  const safe = rows.map(r => String(r.name)).filter(name => !isSecretColumn(name));
  if (!safe.length)
    throw ApiError.forbidden(`Every column of "${table}" is redacted — nothing can be shown.`);
  return safe;
}

/** `t`.`col`, `t`.`col2` … — an explicit projection, never `t.*`. */
const projection = (columns: string[]): string =>
  columns.map(c => `t.${quoteIdentifier(c)}`).join(', ');

const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

async function ensureTable(table: string): Promise<void> {
  const rows = await query<RowDataPacket[]>(
    `SELECT TABLE_NAME
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      LIMIT 1`,
    [env.db.database, table]
  );
  if (rows.length === 0) throw ApiError.notFound('Table not found');
}

/**
 * ============================ TENANT ISOLATION ================================
 * This browser is reachable by any company's ADMIN, so every table it can
 * return rows from must be scoped to the caller's own company_id — no
 * exceptions, and no guessing.
 *
 *   'root'    the tenant root itself — companies.id IS the company id.
 *   'tenant'  has a company_id column — filtered directly on it.
 *   'system'  genuinely shared, non-tenant reference data (safe to show whole).
 *   'joined'  no company_id column of its own, but every row is reachable via
 *             exactly one FK to a parent table that has company_id, and that
 *             FK is well-defined (single-hop, and for nullable FKs an INNER
 *             JOIN naturally excludes the ambiguous NULL-owner rows instead
 *             of guessing who owns them).
 *   'blocked' no company_id column AND no safe single-hop FK to a scoped
 *             parent. Any table not explicitly classified below also falls
 *             into this bucket — fail closed, not open.
 * ============================================================================
 */
const TENANT_ROOT_TABLE = 'companies';
const SYSTEM_TABLES = new Set(['roles']);
const DIRECT_TENANT_TABLES = new Set([
  'users', 'ledger_groups', 'ledgers', 'vouchers', 'customers', 'suppliers',
  'warehouses', 'items', 'stock_entries', 'bookings', 'invoices', 'payments',
  'employees', 'payroll_runs'
]);
// Every entry here was checked against schema.sql: the FK column is a
// single, unambiguous link to a parent table that itself has company_id.
// audit_logs.user_id is nullable — the INNER JOIN below correctly drops
// those rows (no determinable owner) rather than exposing or guessing.
const JOIN_SCOPED_TABLES: Record<string, { parentTable: string; fkColumn: string }> = {
  voucher_entries: { parentTable: 'vouchers', fkColumn: 'voucher_id' },
  invoice_items:   { parentTable: 'invoices', fkColumn: 'invoice_id' },
  payslips:        { parentTable: 'payroll_runs', fkColumn: 'payroll_run_id' },
  audit_logs:      { parentTable: 'users', fkColumn: 'user_id' },
  refresh_tokens:  { parentTable: 'users', fkColumn: 'user_id' },
};

type TableScope =
  | { kind: 'root' }
  | { kind: 'system' }
  | { kind: 'tenant'; column: string }
  | { kind: 'joined'; parentTable: string; fkColumn: string }
  | { kind: 'blocked' };

function classifyTable(table: string): TableScope {
  if (table === TENANT_ROOT_TABLE) return { kind: 'root' };
  if (SYSTEM_TABLES.has(table)) return { kind: 'system' };
  if (DIRECT_TENANT_TABLES.has(table)) return { kind: 'tenant', column: 'company_id' };
  const join = JOIN_SCOPED_TABLES[table];
  if (join) return { kind: 'joined', ...join };
  return { kind: 'blocked' }; // unknown/future tables — fail closed
}

/**
 * Builds the FROM+WHERE fragment (and its params) that scopes a query to
 * companyId, whatever this table's scope kind is. The base table is always
 * aliased `t` so callers can use `t.*` / `COUNT(*)` uniformly.
 */
function scopedQuery(table: string, companyId: number, safeTable: string): { from: string; where: string; params: unknown[] } {
  const scope = classifyTable(table);
  if (scope.kind === 'blocked') {
    throw ApiError.forbidden(
      `Table "${table}" has no company scoping and no safe single-hop join to determine ownership — ` +
      `it cannot be browsed or exported here.`
    );
  }
  if (scope.kind === 'system') return { from: `${safeTable} t`, where: '', params: [] };
  if (scope.kind === 'root') return { from: `${safeTable} t`, where: ' WHERE t.id = ?', params: [companyId] };
  if (scope.kind === 'tenant') return { from: `${safeTable} t`, where: ` WHERE t.${scope.column} = ?`, params: [companyId] };
  // joined
  const parent = quoteIdentifier(scope.parentTable);
  return {
    from: `${safeTable} t JOIN ${parent} p ON p.id = t.${scope.fkColumn}`,
    where: ' WHERE p.company_id = ?',
    params: [companyId]
  };
}

export const adminDatabaseService = {
  async tables(): Promise<TableInfo[]> {
    const rows = await query<RowDataPacket[]>(
      `SELECT
         TABLE_NAME AS name,
         COALESCE(TABLE_ROWS, 0) AS \`rows\`,
         COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS sizeBytes,
         UPDATE_TIME AS updatedAt
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [env.db.database]
    );
    return rows as TableInfo[];
  },

  async tableData(table: string, companyId: number, limit = 100, offset = 0) {
    await ensureTable(table);
    const safeTable = quoteIdentifier(table);
    const { from, where, params: whereParams } = scopedQuery(table, companyId, safeTable);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), MAX_LIMIT);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    const allColumns = await query<RowDataPacket[]>(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS type
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [env.db.database, table]
    );
    // Redacted columns are dropped from the metadata too — the browser should
    // not advertise a column it will never return values for.
    const visible = allColumns.filter(c => !isSecretColumn(String(c.name)));
    const redacted = allColumns.filter(c => isSecretColumn(String(c.name))).map(c => String(c.name));
    if (!visible.length)
      throw ApiError.forbidden(`Every column of "${table}" is redacted — nothing can be shown.`);

    const [countRows, rows] = await Promise.all([
      query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM ${from}${where}`, whereParams),
      query<RowDataPacket[]>(
        `SELECT ${projection(visible.map(c => String(c.name)))} FROM ${from}${where} LIMIT ? OFFSET ?`,
        [...whereParams, safeLimit, safeOffset])
    ]);

    return {
      table,
      columns: visible,
      redactedColumns: redacted,
      rows,
      total: Number(countRows[0]?.total ?? 0),
      limit: safeLimit,
      offset: safeOffset
    };
  },

  async tableCsv(table: string, companyId: number): Promise<string> {
    await ensureTable(table);
    const safeTable = quoteIdentifier(table);
    const { from, where, params: whereParams } = scopedQuery(table, companyId, safeTable);
    const columns = await safeColumnNames(table);
    const rows = await query<RowDataPacket[]>(
      `SELECT ${projection(columns)} FROM ${from}${where}`, whereParams);

    return [
      columns.map(csvCell).join(','),
      ...rows.map((row) => columns.map((col) => csvCell(row[col])).join(','))
    ].join('\n');
  },

  /**
   * Company-scoped export across every table. Tables that still have no safe
   * way to determine ownership (see `classifyTable`'s 'blocked' case) are
   * omitted, not silently dumped in full — their names are listed under
   * `skipped` so the gap stays visible rather than hidden.
   *
   * Secret columns are stripped from every table on the way out; what was
   * removed is reported under `redacted` so the export is self-describing
   * rather than quietly lossy.
   */
  async fullBackup(companyId: number) {
    const tables = await this.tables();
    const data: Record<string, RowDataPacket[]> = {};
    const skipped: { table: string; reason: string }[] = [];
    const redacted: Record<string, string[]> = {};

    for (const table of tables) {
      const scope = classifyTable(table.name);
      if (scope.kind === 'blocked') {
        skipped.push({ table: table.name, reason: 'no company_id column and no safe single-hop join to a scoped parent' });
        continue;
      }
      const safeTable = quoteIdentifier(table.name);
      const { from, where, params } = scopedQuery(table.name, companyId, safeTable);

      const allColumns = await query<RowDataPacket[]>(
        `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [env.db.database, table.name]);
      const names = allColumns.map(c => String(c.name));
      const visible = names.filter(n => !isSecretColumn(n));
      const hidden = names.filter(isSecretColumn);
      if (hidden.length) redacted[table.name] = hidden;
      if (!visible.length) {
        skipped.push({ table: table.name, reason: 'every column is redacted' });
        continue;
      }

      data[table.name] = await query<RowDataPacket[]>(
        `SELECT ${projection(visible)} FROM ${from}${where}`, params);
    }

    return {
      exportedAt: new Date().toISOString(),
      database: env.db.database,
      companyId,
      tables: Object.keys(data),
      skipped,
      redacted,
      data
    };
  }
};
