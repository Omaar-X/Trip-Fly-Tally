import { withTransaction, query, Row, WriteResult } from '../../config/db';
import { reportsService } from '../reports/reports.service';
import { ApiError } from '../../utils/ApiError';

/**
 * How a name is compared, not how it is stored.
 *
 * Case and stray whitespace are typing accidents, so they are taken out of the
 * comparison; the DB does the same thing in the `name_key` generated column,
 * and the two must agree or a duplicate slips past the application check and
 * dies on the unique key instead.
 *
 * Spelling is left alone on purpose. "GROUPO SORCING" and "GROUPO SORCHING"
 * are one party, "ECO SORCHING" and "GROUPO SORCHING" are two, and no distance
 * function separates those — that call is recorded in CLIENT_DECISIONS.md.
 */
export const nameKey = (name: string): string =>
  name.trim().replace(/\s+/g, ' ').toUpperCase();

/**
 * The picker's page size. Fifty rows is more than anyone reads; past that the
 * answer is another letter typed, not a longer list.
 */
const SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 50;

const clampLimit = (limit?: number): number =>
  Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(limit ?? SEARCH_LIMIT)));

/** LIKE wildcards inside a search term would otherwise be operators. */
const escapeLike = (term: string): string => term.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Creating a customer/supplier also creates its dedicated sub-ledger under
 * Sundry Debtors / Sundry Creditors — so dues always come from the books.
 */
const findGroupId = async (companyId: number, name: string): Promise<number> => {
  const rows = await query<Row[]>(
    'SELECT id FROM ledger_groups WHERE company_id = ? AND name = ?', [companyId, name]);
  if (!rows[0]) throw new Error(`Required ledger group missing: ${name} (run seed.sql)`);
  return Number(rows[0].id);
};

export const crmService = {
  listCustomers: (companyId: number) =>
    query<Row[]>(
      `SELECT c.*, ROUND(
              CASE WHEN l.opening_type='DR' THEN l.opening_balance ELSE -l.opening_balance END
              + COALESCE(SUM(CASE WHEN ve.entry_type='DR' THEN ve.amount ELSE -ve.amount END),0), 2) AS outstanding
         FROM customers c
         JOIN ledgers l ON l.id = c.ledger_id
         LEFT JOIN voucher_entries ve ON ve.ledger_id = l.id
        WHERE c.company_id = ?
        GROUP BY c.id, l.opening_balance, l.opening_type ORDER BY c.name`, [companyId]),

  /**
   * What the pickers call on every keystroke.
   *
   * Deliberately not `listCustomers`: that one aggregates every voucher entry
   * in the book to compute an outstanding balance, which is the right answer
   * for the CRM table and a very wrong one for a dropdown that fires while
   * someone types. This reads the customer row and nothing else.
   *
   * Prefix hits rank above infix hits, so typing "sun" puts SUN PHARMA above
   * ECO SUNRISE even though both match.
   */
  searchCustomers(companyId: number, term: string, limit?: number) {
    const q = term.trim();
    const n = clampLimit(limit);
    if (!q) {
      return query<Row[]>(
        `SELECT id, name, phone, email FROM customers
          WHERE company_id = ? AND is_active = 1 ORDER BY name LIMIT ?`, [companyId, n]);
    }
    const like = escapeLike(q);
    return query<Row[]>(
      `SELECT id, name, phone, email FROM customers
        WHERE company_id = ? AND is_active = 1
          AND (name LIKE ? ESCAPE '\\\\' OR phone LIKE ? ESCAPE '\\\\')
        ORDER BY CASE WHEN name LIKE ? ESCAPE '\\\\' THEN 0 ELSE 1 END, name
        LIMIT ?`,
      [companyId, `%${like}%`, `${like}%`, `${like}%`, n]);
  },

  /** The one customer whose name matches ignoring case and spacing, if any. */
  async findCustomerByName(companyId: number, name: string) {
    const rows = await query<Row[]>(
      'SELECT id, name, phone, email FROM customers WHERE company_id = ? AND name_key = ? LIMIT 1',
      [companyId, nameKey(name)]);
    return rows[0] ?? null;
  },

  async createCustomer(companyId: number, input: {
    name: string; email?: string; phone?: string; address?: string;
    passportNo?: string; creditLimit: number;
  }) {
    // Checked here so the caller gets the existing row back rather than a bare
    // constraint violation. The unique key is still the thing that guarantees
    // it — two requests racing this check both reach the INSERT, and one loses.
    const existing = await this.findCustomerByName(companyId, input.name);
    if (existing)
      throw ApiError.conflict(
        `Customer "${existing.name}" already exists (#${existing.id}).`);

    return withTransaction(async conn => {
      const groupId = await findGroupId(companyId, 'Sundry Debtors');
      const [ledger] = await conn.query<WriteResult>(
        `INSERT INTO ledgers (company_id, group_id, name) VALUES (?,?,?)`,
        [companyId, groupId, `Customer — ${input.name}`]);
      const [customer] = await conn.query<WriteResult>(
        `INSERT INTO customers (company_id, ledger_id, name, email, phone, address, passport_no, credit_limit)
         VALUES (?,?,?,?,?,?,?,?)`,
        [companyId, ledger.insertId, input.name, input.email ?? null, input.phone ?? null,
         input.address ?? null, input.passportNo ?? null, input.creditLimit]);
      return customer.insertId;
    });
  },

  listSuppliers: (companyId: number) =>
    query<Row[]>(
      `SELECT s.*, ROUND(
              CASE WHEN l.opening_type='CR' THEN l.opening_balance ELSE -l.opening_balance END
              + COALESCE(SUM(CASE WHEN ve.entry_type='CR' THEN ve.amount ELSE -ve.amount END),0), 2) AS payable
         FROM suppliers s
         JOIN ledgers l ON l.id = s.ledger_id
         LEFT JOIN voucher_entries ve ON ve.ledger_id = l.id
        WHERE s.company_id = ?
        GROUP BY s.id, l.opening_balance, l.opening_type ORDER BY s.name`, [companyId]),

  /** Payable-side mirror of `searchCustomers`. */
  searchSuppliers(companyId: number, term: string, limit?: number) {
    const q = term.trim();
    const n = clampLimit(limit);
    if (!q) {
      return query<Row[]>(
        `SELECT id, name, phone, email FROM suppliers
          WHERE company_id = ? AND is_active = 1 ORDER BY name LIMIT ?`, [companyId, n]);
    }
    const like = escapeLike(q);
    return query<Row[]>(
      `SELECT id, name, phone, email FROM suppliers
        WHERE company_id = ? AND is_active = 1
          AND (name LIKE ? ESCAPE '\\\\' OR phone LIKE ? ESCAPE '\\\\')
        ORDER BY CASE WHEN name LIKE ? ESCAPE '\\\\' THEN 0 ELSE 1 END, name
        LIMIT ?`,
      [companyId, `%${like}%`, `${like}%`, `${like}%`, n]);
  },

  async findSupplierByName(companyId: number, name: string) {
    const rows = await query<Row[]>(
      'SELECT id, name, phone, email FROM suppliers WHERE company_id = ? AND name_key = ? LIMIT 1',
      [companyId, nameKey(name)]);
    return rows[0] ?? null;
  },

  async createSupplier(companyId: number, input: {
    name: string; email?: string; phone?: string; address?: string;
  }) {
    const existing = await this.findSupplierByName(companyId, input.name);
    if (existing)
      throw ApiError.conflict(
        `Supplier "${existing.name}" already exists (#${existing.id}).`);

    return withTransaction(async conn => {
      const groupId = await findGroupId(companyId, 'Sundry Creditors');
      const [ledger] = await conn.query<WriteResult>(
        `INSERT INTO ledgers (company_id, group_id, name) VALUES (?,?,?)`,
        [companyId, groupId, `Supplier — ${input.name}`]);
      const [supplier] = await conn.query<WriteResult>(
        `INSERT INTO suppliers (company_id, ledger_id, name, email, phone, address) VALUES (?,?,?,?,?,?)`,
        [companyId, ledger.insertId, input.name, input.email ?? null, input.phone ?? null, input.address ?? null]);
      return supplier.insertId;
    });
  },

  /** Customer 360°: profile + payment history + travel history. */
  async customerProfile(companyId: number, customerId: number) {
    const customers = await query<Row[]>(
      'SELECT * FROM customers WHERE company_id = ? AND id = ?', [companyId, customerId]);
    const payments = await query<Row[]>(
      `SELECT payment_no, amount, method, payment_date, notes FROM payments
        WHERE company_id = ? AND customer_id = ? ORDER BY payment_date DESC LIMIT 50`,
      [companyId, customerId]);
    const bookings = await query<Row[]>(
      `SELECT booking_no, booking_type, status, travel_date, sale_price, details
         FROM bookings WHERE company_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 50`,
      [companyId, customerId]);
    const invoices = await query<Row[]>(
      `SELECT invoice_no, invoice_date, total, paid_amount, status
         FROM invoices WHERE company_id = ? AND customer_id = ? ORDER BY invoice_date DESC LIMIT 50`,
      [companyId, customerId]);
    return { customer: customers[0], payments, bookings, invoices };
  },

  outstanding: (companyId: number) => reportsService.customerOutstanding(companyId)
};
