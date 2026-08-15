import { PoolConnection } from 'mysql2/promise';
import { Row } from '../config/db';
import { ApiError } from './ApiError';

/**
 * The posting modules (bookings, payments, payroll) need well-known system
 * ledgers — "Cash in Hand", "VAT Payable", "Salary Expense"… We resolve them
 * BY NAME (not by hard-coded id) so the system keeps working even if the
 * chart of accounts is re-seeded with different ids.
 */
export const SYSTEM_LEDGERS = {
  CASH: 'Cash in Hand',
  BANK: 'City Bank — A/C 110245',
  BKASH: 'bKash Merchant Wallet',
  NAGAD: 'Nagad Merchant Wallet',
  CARD: 'Card Settlement Account',
  SALES_FLIGHT: 'Sales — Air Tickets',
  SALES_HOTEL: 'Sales — Hotel Bookings',
  SALES_TOUR: 'Sales — Tour Packages',
  VAT_PAYABLE: 'VAT Payable',
  COST_OF_SERVICES: 'Cost of Services',
  SALARY_EXPENSE: 'Salary Expense',
  SALARIES_PAYABLE: 'Salaries Payable',
  STOCK_IN_HAND: 'Stock in Hand',
  COGS: 'Cost of Goods Sold',
  STOCK_ADJUSTMENT: 'Stock Adjustment',
} as const;

export async function findLedgerId(conn: PoolConnection, companyId: number, name: string): Promise<number> {
  const [rows] = await conn.query<Row[]>(
    'SELECT id FROM ledgers WHERE company_id = ? AND name = ? LIMIT 1', [companyId, name]
  );
  if (!rows.length) {
    throw ApiError.badRequest(
      `Required system ledger "${name}" not found. Did you run database/seed.sql?`
    );
  }
  return rows[0].id as number;
}

/**
 * Maps a payment method to the money ledger that receives / releases cash.
 *
 * Every channel gets its OWN ledger. Nagad used to post into the bKash wallet
 * and card settlements straight into the bank account, which meant neither
 * ledger could ever be tied back to its real statement: the bKash balance
 * included money bKash was not holding, and the bank balance included card
 * takings the bank had not paid out yet. A money ledger that cannot be
 * reconciled is not a money ledger.
 */
export function moneyLedgerName(method: 'CASH' | 'BANK' | 'BKASH' | 'NAGAD' | 'CARD'): string {
  switch (method) {
    case 'CASH': return SYSTEM_LEDGERS.CASH;
    case 'BKASH': return SYSTEM_LEDGERS.BKASH;
    case 'NAGAD': return SYSTEM_LEDGERS.NAGAD;
    case 'CARD': return SYSTEM_LEDGERS.CARD;   // cleared to bank on settlement, via a contra
    default: return SYSTEM_LEDGERS.BANK;
  }
}

/** Maps a booking type to its income ledger. */
export function salesLedgerName(type: 'FLIGHT' | 'HOTEL' | 'TOUR'): string {
  switch (type) {
    case 'FLIGHT': return SYSTEM_LEDGERS.SALES_FLIGHT;
    case 'HOTEL': return SYSTEM_LEDGERS.SALES_HOTEL;
    case 'TOUR': return SYSTEM_LEDGERS.SALES_TOUR;
  }
}
