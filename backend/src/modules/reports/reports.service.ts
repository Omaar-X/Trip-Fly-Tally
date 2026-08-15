import { query, Row } from '../../config/db';
import { round2 } from '../../utils/money';
import { previousDay } from '../../utils/date';

/**
 * ============================== REPORTING ENGINE =============================
 * Every statement here derives from ONE aggregate over voucher_entries joined
 * to ledgers and ledger_groups, split into three buckets per ledger:
 *
 *   opening   master opening balance  +  ALL movement strictly before `from`
 *   period    movement between `from` and `to`
 *   closing   opening + period
 *
 * That middle term is the correction that matters. The engine used to treat
 * the ledger's master opening as the period opening and count only movement
 * inside the window, so a Trial Balance for 2026 silently dropped every 2025
 * voucher. Both totals still matched — each voucher is internally balanced —
 * so the report cheerfully reported `balanced: true` while being wrong. A
 * statement that is wrong and looks right is worse than one that fails.
 *
 * Sign convention: `net` is always (debits − credits). A positive net is a
 * debit balance. Assets and expenses live naturally on the debit side;
 * liabilities, equity and income on the credit side.
 * ============================================================================
 */

interface LedgerTotals extends Row {
  id: number; name: string; group_name: string; group_id: number;
  nature: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
  opening_dr: number; opening_cr: number;
  prior_dr: number; prior_cr: number;
  period_dr: number; period_cr: number;
}

interface LedgerView {
  id: number; name: string; group: string; nature: LedgerTotals['nature'];
  /** Debit-positive opening as at the start of the period. */
  opening: number;
  periodDr: number; periodCr: number;
  /** Debit-positive closing at the end of the period. */
  closing: number;
}

async function ledgerTotals(companyId: number, from: string, to: string): Promise<LedgerTotals[]> {
  return query<LedgerTotals[]>(
    `SELECT l.id, l.name, g.id AS group_id, g.name AS group_name, g.nature,
            CASE WHEN l.opening_type = 'DR' THEN l.opening_balance ELSE 0 END AS opening_dr,
            CASE WHEN l.opening_type = 'CR' THEN l.opening_balance ELSE 0 END AS opening_cr,
            COALESCE(SUM(CASE WHEN ve.entry_type='DR' AND v.voucher_date <  ? THEN ve.amount END),0) AS prior_dr,
            COALESCE(SUM(CASE WHEN ve.entry_type='CR' AND v.voucher_date <  ? THEN ve.amount END),0) AS prior_cr,
            COALESCE(SUM(CASE WHEN ve.entry_type='DR' AND v.voucher_date BETWEEN ? AND ? THEN ve.amount END),0) AS period_dr,
            COALESCE(SUM(CASE WHEN ve.entry_type='CR' AND v.voucher_date BETWEEN ? AND ? THEN ve.amount END),0) AS period_cr
       FROM ledgers l
       JOIN ledger_groups g ON g.id = l.group_id
       LEFT JOIN (
         voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
       ) ON ve.ledger_id = l.id AND v.company_id = l.company_id
      WHERE l.company_id = ?
      GROUP BY l.id, l.name, g.id, g.name, g.nature, opening_dr, opening_cr
      ORDER BY g.nature, l.name`,
    [from, from, from, to, from, to, companyId]);
}

/**
 * Folds the raw buckets into debit-positive opening/closing figures.
 *
 * Nominal (INCOME/EXPENSE) ledgers deliberately ignore the master opening
 * column: a P&L account measures movement over a period, so carrying an
 * opening on one would be counted by the Balance Sheet and by no P&L, leaving
 * the two statements disagreeing by exactly that amount. The API now refuses
 * to create such an opening; this is the second line of defence for databases
 * that already have one.
 */
function toViews(rows: LedgerTotals[]): LedgerView[] {
  return rows.map(r => {
    const nominal = r.nature === 'INCOME' || r.nature === 'EXPENSE';
    const masterOpening = nominal ? 0 : Number(r.opening_dr) - Number(r.opening_cr);
    const opening = round2(masterOpening + Number(r.prior_dr) - Number(r.prior_cr));
    const periodDr = round2(Number(r.period_dr));
    const periodCr = round2(Number(r.period_cr));
    return {
      id: r.id, name: r.name, group: r.group_name, nature: r.nature,
      opening, periodDr, periodCr,
      closing: round2(opening + periodDr - periodCr),
    };
  });
}

/** Split a debit-positive figure into the Dr / Cr columns a register prints. */
const columns = (net: number) => ({
  debit: net > 0 ? round2(net) : 0,
  credit: net < 0 ? round2(-net) : 0,
});

const sum = (xs: number[]) => round2(xs.reduce((s, x) => s + x, 0));

/**
 * Money differences are compared at one paisa, never with ===. Each line is
 * rounded before it is summed, so two mathematically equal totals can land a
 * hundredth apart purely from rounding order.
 */
const equalMoney = (a: number, b: number) => Math.abs(a - b) < 0.005;

export const reportsService = {
  /**
   * Trial Balance in Tally's shape: opening, period movement and closing per
   * ledger, with grand totals that must agree on both the movement and the
   * closing columns.
   */
  async trialBalance(companyId: number, from: string, to: string) {
    const views = toViews(await ledgerTotals(companyId, from, to));

    const lines = views
      .filter(v => v.opening !== 0 || v.periodDr !== 0 || v.periodCr !== 0 || v.closing !== 0)
      .map(v => ({
        ledger_id: v.id, ledger: v.name, group: v.group, nature: v.nature,
        opening_debit: columns(v.opening).debit,
        opening_credit: columns(v.opening).credit,
        debit: v.periodDr,
        credit: v.periodCr,
        closing_debit: columns(v.closing).debit,
        closing_credit: columns(v.closing).credit,
      }));

    const totalDebit = sum(lines.map(l => l.debit));
    const totalCredit = sum(lines.map(l => l.credit));
    const closingDebit = sum(lines.map(l => l.closing_debit));
    const closingCredit = sum(lines.map(l => l.closing_credit));

    // A closing mismatch can only come from unbalanced OPENING balances —
    // every voucher balances by construction — so name that cause explicitly
    // instead of leaving the operator to guess. Positive means the openings
    // carry excess debits and this much is owed to the credit side.
    const openingDifference = round2(
      sum(lines.map(l => l.opening_debit)) - sum(lines.map(l => l.opening_credit)));

    return {
      from, to, lines,
      totalDebit, totalCredit,
      closingDebit, closingCredit,
      openingDifference,
      balanced: equalMoney(totalDebit, totalCredit) && equalMoney(closingDebit, closingCredit),
    };
  },

  /**
   * Profit & Loss: INCOME (Cr−Dr) against EXPENSE (Dr−Cr) over the period.
   *
   * `precomputed` lets a caller that has ALREADY run ledgerTotals for the same
   * window hand the result in. The Balance Sheet does exactly that: it needs a
   * lifetime P&L for retained earnings, and without this it ran the same
   * full aggregate a second time — which is why it was the slowest report in
   * the system while returning the least data.
   */
  async profitAndLoss(companyId: number, from: string, to: string, precomputed?: LedgerView[]) {
    const views = precomputed ?? toViews(await ledgerTotals(companyId, from, to));

    const income = views.filter(v => v.nature === 'INCOME')
      .map(v => ({ ledger: v.name, group: v.group, amount: round2(v.periodCr - v.periodDr) }))
      .filter(r => r.amount !== 0);
    const expenses = views.filter(v => v.nature === 'EXPENSE')
      .map(v => ({ ledger: v.name, group: v.group, amount: round2(v.periodDr - v.periodCr) }))
      .filter(r => r.amount !== 0);

    const totalIncome = sum(income.map(r => r.amount));
    const totalExpense = sum(expenses.map(r => r.amount));
    return { from, to, income, expenses, totalIncome, totalExpense,
             netProfit: round2(totalIncome - totalExpense) };
  },

  /**
   * Balance Sheet as on a date.
   *
   *   Assets = Liabilities + Equity + retained earnings (+ opening difference)
   *
   * Retained earnings are lifetime income less lifetime expense up to `asOn`,
   * which is why the P&L behind it is run from the very start of the books
   * rather than from the start of a period.
   *
   * `openingDifference` is Tally's "Difference in Opening Balances": if the
   * opening balances someone typed in do not themselves balance, the gap has
   * to appear somewhere or the statement is a lie. It is shown as its own line
   * instead of being quietly absorbed.
   */
  async balanceSheet(companyId: number, asOn: string) {
    const BOOKS_START = '1000-01-01';
    const views = toViews(await ledgerTotals(companyId, BOOKS_START, asOn));

    const pick = (nature: LedgerTotals['nature'], flip: boolean) =>
      views.filter(v => v.nature === nature)
        .map(v => ({ ledger: v.name, group: v.group, amount: round2(flip ? -v.closing : v.closing) }))
        .filter(r => r.amount !== 0);

    const assets = pick('ASSET', false);
    const liabilities = pick('LIABILITY', true);
    const equity = pick('EQUITY', true);

    // Same window, same aggregate — reuse it rather than paying for it twice.
    const pl = await this.profitAndLoss(companyId, BOOKS_START, asOn, views);

    // Opening balances that do not balance among themselves. Every voucher
    // does balance, so any residue is entirely attributable to the openings.
    // Debit-positive, and therefore the figure the CREDIT side is short by —
    // which is why it is added to liabilities + equity below.
    const openingDifference = round2(sum(views.map(v => v.opening)));

    const totalAssets = sum(assets.map(r => r.amount));
    const totalLiabilities = sum(liabilities.map(r => r.amount));
    const totalEquity = round2(sum(equity.map(r => r.amount)) + pl.netProfit);
    const totalLiabilitiesAndEquity = round2(totalLiabilities + totalEquity + openingDifference);

    return {
      asOn, assets, liabilities, equity,
      retainedEarnings: pl.netProfit,
      openingDifference,
      totalAssets, totalLiabilities, totalEquity,
      totalLiabilitiesAndEquity,
      balanced: equalMoney(totalAssets, totalLiabilitiesAndEquity),
    };
  },

  /**
   * Cash Book / Bank Book with an opening balance, closing balance and a
   * running balance per line — a register, not just a list of hits.
   *
   * Which ledgers count is decided by GROUP LINEAGE, not by a hardcoded group
   * name. The old version matched the literal strings 'Cash-in-Hand' and
   * 'Bank Accounts', so a second bank group — or a renamed one — simply never
   * appeared in the Bank Book, with nothing to indicate anything was missing.
   */
  async cashBankBook(companyId: number, book: 'cash' | 'bank', from: string, to: string) {
    const ledgerIds = await moneyLedgerIds(companyId, book);
    if (!ledgerIds.length)
      return { book, from, to, opening: 0, closing: 0, ledgers: [], lines: [] };

    const [openingRow] = await query<Row[]>(
      `SELECT COALESCE(SUM(CASE WHEN l.opening_type='DR' THEN l.opening_balance ELSE -l.opening_balance END), 0) AS opening
         FROM ledgers l WHERE l.company_id = ? AND l.id IN (?)`, [companyId, ledgerIds]);

    const [priorRow] = await query<Row[]>(
      `SELECT COALESCE(SUM(CASE WHEN ve.entry_type='DR' THEN ve.amount ELSE -ve.amount END), 0) AS movement
         FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
        WHERE v.company_id = ? AND ve.ledger_id IN (?) AND v.voucher_date < ?`,
      [companyId, ledgerIds, from]);

    const rows = await query<Row[]>(
      `SELECT v.id AS voucher_id, v.voucher_date, v.voucher_no, v.voucher_type, v.narration,
              l.id AS ledger_id, l.name AS ledger, ve.entry_type, ve.amount
         FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
         JOIN ledgers l ON l.id = ve.ledger_id
        WHERE v.company_id = ? AND ve.ledger_id IN (?) AND v.voucher_date BETWEEN ? AND ?
        ORDER BY v.voucher_date, v.id, ve.id`,
      [companyId, ledgerIds, from, to]);

    const opening = round2(Number(openingRow.opening) + Number(priorRow.movement));
    let balance = opening;
    const lines = rows.map(r => {
      balance += r.entry_type === 'DR' ? Number(r.amount) : -Number(r.amount);
      return {
        ...r,
        inflow: r.entry_type === 'DR' ? round2(Number(r.amount)) : 0,
        outflow: r.entry_type === 'CR' ? round2(Number(r.amount)) : 0,
        running_balance: round2(balance),
      };
    });

    const ledgers = await query<Row[]>(
      `SELECT id, name FROM ledgers WHERE company_id = ? AND id IN (?) ORDER BY name`,
      [companyId, ledgerIds]);

    return { book, from, to, openingAsOn: previousDay(from), opening, closing: round2(balance), ledgers, lines };
  },

  /** Day Book: every voucher of a day/range in posting order. */
  dayBook(companyId: number, from: string, to: string) {
    return query<Row[]>(
      `SELECT v.id, v.voucher_date, v.voucher_no, v.voucher_type, v.narration,
              v.total_amount, v.status, v.reversal_of_voucher_id, u.name AS created_by
         FROM vouchers v JOIN users u ON u.id = v.created_by
        WHERE v.company_id = ? AND v.voucher_date BETWEEN ? AND ?
        ORDER BY v.voucher_date, v.id`, [companyId, from, to]);
  },

  /** Daily sales: live invoice totals grouped by date (for reports/charts). */
  dailySales(companyId: number, from: string, to: string) {
    return query<Row[]>(
      `SELECT invoice_date AS date, COUNT(*) AS invoices,
              SUM(total) AS total, SUM(paid_amount) AS collected
         FROM invoices
        WHERE company_id = ? AND status <> 'VOID' AND invoice_date BETWEEN ? AND ?
        GROUP BY invoice_date ORDER BY invoice_date`, [companyId, from, to]);
  },

  /**
   * Customer outstanding straight from the receivable sub-ledger, so it agrees
   * with the Balance Sheet by construction rather than by coincidence.
   */
  customerOutstanding(companyId: number) {
    return query<Row[]>(
      `SELECT c.id, c.name, c.phone, c.credit_limit,
              ROUND(CASE WHEN l.opening_type='DR' THEN l.opening_balance ELSE -l.opening_balance END
              + COALESCE(SUM(CASE WHEN ve.entry_type='DR' THEN ve.amount ELSE -ve.amount END),0), 2) AS outstanding
         FROM customers c
         JOIN ledgers l ON l.id = c.ledger_id
         LEFT JOIN (
           voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
         ) ON ve.ledger_id = l.id AND v.company_id = c.company_id
        WHERE c.company_id = ?
        GROUP BY c.id, c.name, c.phone, c.credit_limit, l.opening_balance, l.opening_type
        HAVING outstanding <> 0
        ORDER BY outstanding DESC`, [companyId]);
  }
};

/**
 * Every ledger that IS money of the requested kind, found by walking the group
 * tree rather than by matching a group's name.
 *
 * Cash is any ASSET group whose lineage names cash; bank is any ASSET group
 * whose lineage names a bank, wallet or card settlement account. Matching on
 * lineage means a user-created "HSBC Accounts" group nested under Bank
 * Accounts is picked up automatically.
 */
async function moneyLedgerIds(companyId: number, book: 'cash' | 'bank'): Promise<number[]> {
  const groups = await query<Row[]>(
    `SELECT id, parent_id, name FROM ledger_groups WHERE company_id = ? AND nature = 'ASSET'`,
    [companyId]);

  const byId = new Map<number, Row>(groups.map(g => [Number(g.id), g]));
  const lineage = (id: number): string[] => {
    const names: string[] = [];
    let cursor: Row | undefined = byId.get(id);
    let hops = 0;
    while (cursor && hops++ < 20) {                    // hops guard: cyclic parents cannot hang the report
      names.push(String(cursor.name).toLowerCase());
      cursor = cursor.parent_id ? byId.get(Number(cursor.parent_id)) : undefined;
    }
    return names;
  };

  const CASH = /\bcash\b|petty/;
  const BANK = /bank|wallet|bkash|nagad|rocket|card|mobile money/;
  const pattern = book === 'cash' ? CASH : BANK;

  const matching = groups
    .map(g => Number(g.id))
    .filter(id => lineage(id).some(name => pattern.test(name)));

  if (!matching.length) return [];
  const ledgers = await query<Row[]>(
    `SELECT id FROM ledgers WHERE company_id = ? AND group_id IN (?)`, [companyId, matching]);
  return ledgers.map(l => Number(l.id));
}
