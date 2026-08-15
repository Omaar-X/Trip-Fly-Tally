import { PoolConnection } from 'mysql2/promise';
import { withTransaction, Row } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { sumCents, fromCents, round2 } from '../../utils/money';
import { nextVoucherNo } from '../../utils/numbering';
import { accountingRepo, VoucherEntryInput } from './accounting.repository';
import {
  BooksPolicy, assertPostable, financialYearOf, loadBooksPolicyTx,
} from './fiscalPeriod.service';

export type VoucherType =
  | 'JOURNAL' | 'PAYMENT' | 'RECEIPT' | 'SALES' | 'PURCHASE'
  | 'CONTRA' | 'DEBIT_NOTE' | 'CREDIT_NOTE';

export interface PostVoucherInput {
  type: VoucherType;
  date: string;                 // YYYY-MM-DD
  narration?: string;
  reference?: string;
  entries: VoucherEntryInput[];
  /** Set by financialReversalService when this voucher mirrors an earlier one. */
  reversalOfVoucherId?: number | null;
}

export interface PostVoucherOptions {
  /**
   * Pass the policy when a caller already loaded it (a booking confirmation
   * posts two vouchers, payroll posts one per step) so a single business
   * action reads the company's period rules once and cannot see them change
   * halfway through.
   */
  policy?: BooksPolicy;
}

/**
 * ============================ DOUBLE-ENTRY ENGINE ============================
 * Single choke-point for writing to the books. Every business module
 * (payments, bookings, invoices, payroll, inventory) posts through
 * postVoucherTx, so five invariants are enforced in exactly one place, in
 * integer cents, inside the caller's SQL transaction:
 *
 *   1. At least one debit and one credit.
 *   2. Every line strictly positive.
 *   3. SUM(debits) === SUM(credits), to the paisa.
 *   4. Every ledger belongs to the posting company.
 *   5. The date is inside an open, already-begun, non-future period.
 *
 * Rules 4 and 5 used to be missing. Without (4) a voucher could name another
 * company's ledger, and because reports join entries to ledgers through the
 * company, that amount then vanished from BOTH companies' trial balances —
 * an unbalanced ledger with no visible cause. Without (5) any date at all was
 * postable, so a closed year never stayed closed.
 * ============================================================================
 */
export async function postVoucherTx(
  conn: PoolConnection, companyId: number, userId: number,
  input: PostVoucherInput, options: PostVoucherOptions = {}
): Promise<{ voucherId: number; voucherNo: string; total: number; date: string }> {
  const { entries } = input;

  if (!entries || entries.length < 2)
    throw ApiError.badRequest('A voucher needs at least one debit and one credit line');
  if (entries.some(e => !(Number(e.amount) > 0)))
    throw ApiError.badRequest('Every voucher line amount must be greater than zero');

  const policy = options.policy ?? await loadBooksPolicyTx(conn, companyId);
  assertPostable(input.date, policy);

  await assertLedgersBelongToCompany(conn, companyId, entries);
  assertNoSelfContra(entries);

  const debitCents = sumCents(entries.filter(e => e.type === 'DR').map(e => e.amount));
  const creditCents = sumCents(entries.filter(e => e.type === 'CR').map(e => e.amount));

  if (debitCents === 0 || creditCents === 0)
    throw ApiError.badRequest('Voucher must contain both debit and credit entries');

  // ★ THE RULE: debit_total must equal credit_total — strictly enforced.
  if (debitCents !== creditCents)
    throw ApiError.badRequest(
      `Voucher does not balance: Dr ${fromCents(debitCents).toFixed(2)} != Cr ${fromCents(creditCents).toFixed(2)}`,
      { debit: fromCents(debitCents), credit: fromCents(creditCents) }
    );

  const fy = financialYearOf(input.date, policy.fyStartMonth);
  const voucherNo = await nextVoucherNo(conn, companyId, input.type, fy);
  const total = fromCents(debitCents);
  const voucherId = await accountingRepo.insertVoucher(conn, {
    companyId, voucherNo, type: input.type, date: input.date,
    narration: input.narration, reference: input.reference, total, createdBy: userId,
    reversalOfVoucherId: input.reversalOfVoucherId
  });
  await accountingRepo.insertEntries(conn, voucherId, entries);
  return { voucherId, voucherNo, total, date: input.date };
}

/**
 * Every ledger named on a voucher must exist and belong to the posting
 * company. One query for the whole voucher, so the cost is a single round trip
 * regardless of how many lines it carries.
 */
async function assertLedgersBelongToCompany(
  conn: PoolConnection, companyId: number, entries: VoucherEntryInput[]
): Promise<void> {
  const ids = [...new Set(entries.map(e => Number(e.ledgerId)))];
  const [rows] = await conn.query<Row[]>(
    `SELECT id FROM ledgers WHERE company_id = ? AND id IN (?)`, [companyId, ids]);
  if (rows.length === ids.length) return;

  const found = new Set(rows.map(r => Number(r.id)));
  const missing = ids.filter(id => !found.has(id));
  throw ApiError.badRequest(
    `Ledger ${missing.join(', ')} does not exist in this company's chart of accounts`);
}

/**
 * The same ledger on both sides of one voucher is never a real transaction —
 * it inflates that ledger's turnover on both sides while changing nothing.
 * Whoever meant it should post the net amount instead.
 */
function assertNoSelfContra(entries: VoucherEntryInput[]): void {
  const debited = new Set(entries.filter(e => e.type === 'DR').map(e => Number(e.ledgerId)));
  const clash = entries.find(e => e.type === 'CR' && debited.has(Number(e.ledgerId)));
  if (clash)
    throw ApiError.badRequest(
      `Ledger ${clash.ledgerId} is both debited and credited on the same voucher — post the net amount instead`);
}

export const accountingService = {
  postVoucher: (companyId: number, userId: number, input: PostVoucherInput) =>
    withTransaction(conn => postVoucherTx(conn, companyId, userId, input)),

  /**
   * A new ledger. Opening balances are the position on the day before the
   * books begin, so they belong only on real (Balance Sheet) accounts:
   * INCOME and EXPENSE ledgers measure movement over a period and are read
   * from vouchers alone, which is why an opening on one of them would land on
   * no side of the Balance Sheet and silently unbalance it.
   */
  createLedger: (companyId: number,
    input: { groupId: number; name: string; openingBalance: number; openingType: 'DR' | 'CR' }) =>
    withTransaction(async (conn) => {
      const [groups] = await conn.query<Row[]>(
        `SELECT id, name, nature FROM ledger_groups WHERE company_id = ? AND id = ?`,
        [companyId, input.groupId]);
      if (!groups.length)
        throw ApiError.badRequest('Ledger group does not exist in this company');

      const nature = groups[0].nature as string;
      const opening = round2(input.openingBalance);
      if (opening !== 0 && (nature === 'INCOME' || nature === 'EXPENSE'))
        throw ApiError.badRequest(
          `"${groups[0].name}" is a ${nature.toLowerCase()} group — ledgers under it cannot carry an ` +
          `opening balance. Post an opening journal instead if the position must be brought forward.`);

      return accountingRepo.createLedger(conn, companyId, { ...input, openingBalance: opening });
    }),

  listGroups: accountingRepo.listGroups,
  listLedgers: accountingRepo.listLedgers,

  /**
   * Statement of one ledger. Opening is the master opening plus every movement
   * strictly BEFORE `from` — so a statement for June opens where May closed,
   * rather than at the ledger's original opening as it used to.
   */
  async ledgerStatement(companyId: number, ledgerId: number, from: string, to: string) {
    const ledger = await accountingRepo.getLedger(companyId, ledgerId);
    if (!ledger) throw ApiError.notFound('Ledger not found');

    const debitNature = ledger.nature === 'ASSET' || ledger.nature === 'EXPENSE';
    const signOf = (side: 'DR' | 'CR'): number => ((side === 'DR') === debitNature ? 1 : -1);

    const masterOpening =
      Number(ledger.opening_balance) * signOf(ledger.opening_type as 'DR' | 'CR');
    const priorMovement = await accountingRepo.movementBefore(companyId, ledgerId, from);
    const opening = round2(
      masterOpening + Number(priorMovement.dr) * signOf('DR') + Number(priorMovement.cr) * signOf('CR'));

    let balance = opening;
    const lines = await accountingRepo.ledgerStatement(companyId, ledgerId, from, to);
    const rows = lines.map(l => {
      balance += Number(l.amount) * signOf(l.entry_type as 'DR' | 'CR');
      return { ...l, running_balance: round2(balance) };
    });

    return {
      ledger: { id: ledger.id, name: ledger.name, nature: ledger.nature, group: ledger.group_name },
      from, to,
      opening_balance: opening,
      closing_balance: round2(balance),
      lines: rows,
    };
  },

  listVouchers: accountingRepo.listVouchers,

  async getVoucher(companyId: number, id: number) {
    const v = await accountingRepo.getVoucher(companyId, id);
    if (!v) throw ApiError.notFound('Voucher not found');
    return v;
  },
};
