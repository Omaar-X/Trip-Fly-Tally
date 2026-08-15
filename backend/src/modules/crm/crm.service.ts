import { withTransaction, query, Row, WriteResult } from '../../config/db';
import { reportsService } from '../reports/reports.service';

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

  async createCustomer(companyId: number, input: {
    name: string; email?: string; phone?: string; address?: string;
    passportNo?: string; creditLimit: number;
  }) {
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

  async createSupplier(companyId: number, input: {
    name: string; email?: string; phone?: string; address?: string;
  }) {
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
