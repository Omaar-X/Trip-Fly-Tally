import { PoolConnection } from 'mysql2/promise';
import { Row, WriteResult } from '../../config/db';
import { postVoucherTx } from '../accounting/accounting.service';
import { loadBooksPolicyTx, BooksPolicy } from '../accounting/fiscalPeriod.service';
import { nameKey } from '../crm/crm.service';
import { LEDGER, assessDrawings } from './historicalRules';
import {
  CEO_LOAN_LEDGER, CLEARING, REVIEW_REASON, classifyCeoLoanMovement, classifyPaymentNarration,
} from './expenseRules';
import { NormalizedRow } from './parser/types';

/**
 * ====================== TURNING A SOURCE ROW INTO BOOKS =====================
 *
 * The poster converts one normalized historical row into real vouchers through
 * `postVoucherTx` — the same function the application uses when someone types a
 * voucher by hand. It therefore inherits every rule the engine already
 * enforces: debits equal credits to the paisa, no self-contra, every ledger
 * belongs to this company, and the date sits inside an open period.
 *
 * What it will NOT do:
 *
 *   · It never writes a ledger balance directly. Every figure that ends up in
 *     the books got there as a transaction that can be opened and read.
 *   · It never invents a counter-entry to make something balance. A row whose
 *     other side is not in the source is REVIEW_REQUIRED, not a plug.
 *   · It never guesses cash vs bank. An unstated payment method is a review
 *     item, because a receipt posted to the wrong account reconciles against
 *     nothing.
 *   · It never routes a CEO-personal row to Drawings on the strength of the
 *     party name. `assessDrawings` decides from the row's own description.
 */

export interface PostContext {
  companyId: number;
  userId: number;
  batchId: number;
  policy: BooksPolicy;
  /** name → ledger id, filled lazily. */
  ledgers: Map<string, number>;
  /** customer/supplier name → { id, ledgerId }. */
  customers: Map<string, { id: number; ledgerId: number }>;
  suppliers: Map<string, { id: number; ledgerId: number }>;
  agents: Map<string, number>;
  /** Set when the run must not write — a dry run resolves nothing. */
  dryRun: boolean;
}

export interface PostOutcome {
  posted: boolean;
  entity?: string;
  id?: number;
  /** Set when the row cannot post; the caller turns it into a review item. */
  review?: { category: NormalizedRow['reviewCategory']; reason: string };
  /**
   * Which clearing account absorbed the row, and how much.
   *
   * Recorded on the source row so the unexplained balance can be broken down
   * by category and period — "I want to know WHY the unexplained amount
   * exists, not just its total."
   */
  clearing?: { category: string; amount: number };
}

const skip = (category: NormalizedRow['reviewCategory'], reason: string): PostOutcome =>
  ({ posted: false, review: { category, reason } });

// ─────────────────────────── ledger resolution ──────────────────────────────

/** A ledger by exact name. Cached: a month asks for the same dozen names. */
export async function ledgerId(conn: PoolConnection, ctx: PostContext, name: string): Promise<number | null> {
  const hit = ctx.ledgers.get(name);
  if (hit) return hit;
  const [rows] = await conn.query<Row[]>(
    'SELECT id FROM ledgers WHERE company_id = ? AND name = ? LIMIT 1', [ctx.companyId, name]);
  if (!rows[0]) return null;
  const id = Number(rows[0].id);
  ctx.ledgers.set(name, id);
  return id;
}

/**
 * The customer, creating it and its receivable sub-ledger if this is the first
 * time the migration has seen the name.
 *
 * Matching is on `name_key` — the same generated column the unique index uses —
 * so case and spacing never produce a second party. Spelling is NOT matched
 * fuzzily: the alias table upstream has already done the only merging anyone
 * approved.
 */
export async function resolveCustomer(
  conn: PoolConnection, ctx: PostContext, name: string,
): Promise<{ id: number; ledgerId: number }> {
  const key = nameKey(name);
  const hit = ctx.customers.get(key);
  if (hit) return hit;

  const [rows] = await conn.query<Row[]>(
    'SELECT id, ledger_id FROM customers WHERE company_id = ? AND name_key = ? LIMIT 1',
    [ctx.companyId, key]);
  if (rows[0]) {
    const found = { id: Number(rows[0].id), ledgerId: Number(rows[0].ledger_id) };
    ctx.customers.set(key, found);
    return found;
  }

  const [grp] = await conn.query<Row[]>(
    "SELECT id FROM ledger_groups WHERE company_id = ? AND name = 'Sundry Debtors'", [ctx.companyId]);

  // The sub-ledger may already exist without its customer row — a partial
  // cleanup, or a party created by hand. Reuse it rather than colliding on the
  // ledger's unique name.
  const ledgerName = `Customer — ${name}`;
  const existingLedger = await ledgerId(conn, ctx, ledgerName);
  const ledgerRef = existingLedger ?? Number((await conn.query<WriteResult>(
    'INSERT INTO ledgers (company_id, group_id, name) VALUES (?,?,?)',
    [ctx.companyId, Number(grp[0].id), ledgerName]))[0].insertId);

  const [cus] = await conn.query<WriteResult>(
    'INSERT INTO customers (company_id, ledger_id, name, credit_limit) VALUES (?,?,?,0)',
    [ctx.companyId, ledgerRef, name]);

  const made = { id: cus.insertId, ledgerId: ledgerRef };
  ctx.customers.set(key, made);
  return made;
}

export async function resolveSupplier(
  conn: PoolConnection, ctx: PostContext, name: string,
): Promise<{ id: number; ledgerId: number }> {
  const key = nameKey(name);
  const hit = ctx.suppliers.get(key);
  if (hit) return hit;

  const [rows] = await conn.query<Row[]>(
    'SELECT id, ledger_id FROM suppliers WHERE company_id = ? AND name_key = ? LIMIT 1',
    [ctx.companyId, key]);
  if (rows[0]) {
    const found = { id: Number(rows[0].id), ledgerId: Number(rows[0].ledger_id) };
    ctx.suppliers.set(key, found);
    return found;
  }

  const [grp] = await conn.query<Row[]>(
    "SELECT id FROM ledger_groups WHERE company_id = ? AND name = 'Sundry Creditors'", [ctx.companyId]);

  const ledgerName = `Supplier — ${name}`;
  const existingLedger = await ledgerId(conn, ctx, ledgerName);
  const ledgerRef = existingLedger ?? Number((await conn.query<WriteResult>(
    'INSERT INTO ledgers (company_id, group_id, name) VALUES (?,?,?)',
    [ctx.companyId, Number(grp[0].id), ledgerName]))[0].insertId);

  const [sup] = await conn.query<WriteResult>(
    'INSERT INTO suppliers (company_id, ledger_id, name) VALUES (?,?,?)',
    [ctx.companyId, ledgerRef, name]);

  const made = { id: sup.insertId, ledgerId: ledgerRef };
  ctx.suppliers.set(key, made);
  return made;
}

/**
 * The agent/reference master.
 *
 * An agent is a reporting dimension, not a party with a balance — creating one
 * never creates a ledger, and a reference on its own never creates commission.
 */
export async function resolveAgent(
  conn: PoolConnection, ctx: PostContext, name: string,
): Promise<number> {
  const key = nameKey(name);
  const hit = ctx.agents.get(key);
  if (hit) return hit;

  const [rows] = await conn.query<Row[]>(
    'SELECT id FROM agents WHERE company_id = ? AND name_key = ? LIMIT 1', [ctx.companyId, key]);
  if (rows[0]) {
    ctx.agents.set(key, Number(rows[0].id));
    return Number(rows[0].id);
  }
  const [ins] = await conn.query<WriteResult>(
    'INSERT INTO agents (company_id, name, note) VALUES (?,?,?)',
    [ctx.companyId, name, 'Created by the historical migration from a source reference column.']);
  ctx.agents.set(key, ins.insertId);
  return ins.insertId;
}

/** The cash or bank ledger a stated method maps to. */
async function moneyLedger(
  conn: PoolConnection, ctx: PostContext, row: NormalizedRow,
): Promise<number | null> {
  if (row.bankLedger) return ledgerId(conn, ctx, row.bankLedger);
  if (row.method === 'CASH') return ledgerId(conn, ctx, 'Cash in Hand');
  // BRAC is the only bank with statements across the whole period, and the
  // ACCOUNTS sheets show it carrying the balance; SBAC and UCB appear only as
  // month-end figures, never against a transaction.
  if (row.method === 'BANK') return ledgerId(conn, ctx, 'BRAC Bank');
  return null;
}

// ──────────────────────────── posting one row ───────────────────────────────

const reference = (row: NormalizedRow): string =>
  `${row.source.sheet}#${row.source.row}`.slice(0, 120);

const narrate = (row: NormalizedRow, fallback: string): string =>
  (row.narration ?? fallback).slice(0, 500);

/**
 * Post one financial row.
 *
 * Returns `posted: false` with a review reason rather than throwing when the
 * row is simply not postable — the batch continues, and the row lands in the
 * review queue with its raw values intact.
 */
export async function postRow(
  conn: PoolConnection, ctx: PostContext, row: NormalizedRow,
): Promise<PostOutcome> {
  if (row.outcome !== 'FINANCIAL') return { posted: false };
  if (!row.date) return skip('UNPARSEABLE_ROW', 'No date, so there is no period to post into.');

  switch (row.kind) {
    case 'SALE': return postSale(conn, ctx, row);
    case 'RECEIPT': return postReceipt(conn, ctx, row);
    case 'PAYMENT': return postPayment(conn, ctx, row);
    case 'PENALTY': return postPenalty(conn, ctx, row);
    default:
      return skip('MISSING_ACCOUNTING_TREATMENT',
        `No posting rule for a "${row.kind}" row.`);
  }
}

/**
 * A sale, and its cost side when the source shows one.
 *
 * Both sides carry the same source reference, so the sale and the purchase
 * behind it stay linked to one another and to the ticket they came from.
 */
async function postSale(conn: PoolConnection, ctx: PostContext, row: NormalizedRow): Promise<PostOutcome> {
  const amount = row.sellingAmount;
  if (amount == null || amount === 0)
    return skip('MISSING_ACCOUNTING_TREATMENT', 'Sale row carries no selling amount.');
  let customer: { ledgerId: number };
  let partyReview: PostOutcome['review'] | undefined;
  let partyClearing: PostOutcome['clearing'] = undefined;
  if (!row.customer) {
    const ambiguous = await ledgerId(conn, ctx, CLEARING.AMBIGUOUS_PARTY);
    if (!ambiguous) return skip('OTHER', `The "${CLEARING.AMBIGUOUS_PARTY}" ledger is missing.`);
    customer = { ledgerId: ambiguous };
    partyClearing = { category: REVIEW_REASON.AMBIGUOUS_PARTY, amount: Math.abs(amount) };
    partyReview = {
      category: row.reviewCategory === 'AMBIGUOUS_PARTY_MATCH' ? 'AMBIGUOUS_PARTY_MATCH' : 'UNKNOWN_PARTY',
      reason: row.reason ?? `Sale of ${amount} has an unidentified historical party; original text preserved.`,
    };
  } else {
    customer = await resolveCustomer(conn, ctx, row.customer);
  }
  const salesLedger = await ledgerId(conn, ctx, 'Sales — Air Tickets');
  if (!salesLedger) return skip('OTHER', 'The "Sales — Air Tickets" ledger is missing.');

  const negative = amount < 0;
  const abs = Math.abs(amount);

  // A negative selling amount is a credit note in the source's own terms — the
  // sides swap rather than a negative line being written, because the engine
  // requires every line to be positive.
  const { voucherId } = await postVoucherTx(conn, ctx.companyId, ctx.userId, {
    type: negative ? 'CREDIT_NOTE' : 'SALES',
    date: row.date!,
    narration: narrate(row, 'Historical sale'),
    reference: reference(row),
    entries: negative
      ? [{ ledgerId: salesLedger, type: 'DR', amount: abs },
         { ledgerId: customer.ledgerId, type: 'CR', amount: abs }]
      : [{ ledgerId: customer.ledgerId, type: 'DR', amount: abs },
         { ledgerId: salesLedger, type: 'CR', amount: abs }],
  }, { policy: ctx.policy });

  await stampVoucher(conn, ctx, voucherId);

  // The cost side.
  //
  // The `issueing Agency` column is filled in through August 2024 and then
  // largely stops: December carries a vendor on 17 rows out of 127, and by
  // June 2025 it is 9 out of 56. The COST is still there on every row — the
  // company knew what it paid, it just stopped recording who to.
  //
  // Dropping those costs would understate purchases by millions and overstate
  // profit by the same amount. Inventing a creditor is equally wrong. So the
  // cost posts against Historical Suspense and the row is flagged
  // MISSING_VENDOR: the expense is real and in the books, and the question of
  // whom it is owed to stays open and visible.
  let review: PostOutcome['review'] | undefined = partyReview;
  let clearing: PostOutcome['clearing'] = partyClearing;

  if (row.costAmount != null && row.costAmount !== 0) {
    const costLedger = await ledgerId(conn, ctx, 'Cost of Services');
    // Decision 1: ONE controlled clearing payable, never an invented vendor.
    // Trip Fly issues through HAZEE, NDC, GDS, Sabre and others, so a blank
    // Issuing Agency does NOT mean HAZEE.
    const creditLedger = row.vendor
      ? (await resolveSupplier(conn, ctx, row.vendor)).ledgerId
      : await ledgerId(conn, ctx, CLEARING.UNKNOWN_SUPPLIER);

    if (costLedger && creditLedger) {
      const cost = Math.abs(row.costAmount);
      // A NEGATIVE cost is the source reversing a purchase — the airline or
      // consolidator crediting back the fare behind a refunded or voided
      // ticket. Taking its absolute value and debiting Cost of Services books
      // a second purchase instead of undoing the first, which overstates cost
      // and the payable by the same amount twice over.
      //
      // The sales side already reverses on a negative selling amount; this is
      // the same rule applied to the side that pays for it.
      const reversal = row.costAmount < 0;
      const { voucherId: purchaseId } = await postVoucherTx(conn, ctx.companyId, ctx.userId, {
        type: reversal ? 'DEBIT_NOTE' : 'PURCHASE',
        date: row.date!,
        narration: narrate(row, reversal ? 'Historical purchase return' : 'Historical purchase'),
        reference: reference(row),
        entries: reversal
          ? [{ ledgerId: creditLedger, type: 'DR', amount: cost },
             { ledgerId: costLedger, type: 'CR', amount: cost }]
          : [{ ledgerId: costLedger, type: 'DR', amount: cost },
             { ledgerId: creditLedger, type: 'CR', amount: cost }],
      }, { policy: ctx.policy });
      await stampVoucher(conn, ctx, purchaseId);

      if (!row.vendor) {
        clearing = { category: REVIEW_REASON.UNKNOWN_SUPPLIER, amount: cost };
        review = {
          category: 'MISSING_VENDOR',
          reason: `Cost of ${cost} on ticket ${row.ticketNo ?? '(none)'} — the source names no issuing `
            + `agency (original value: "${row.vendorText ?? 'blank'}"). Credited to `
            + `"${CLEARING.UNKNOWN_SUPPLIER}". Trip Fly issues through several channels, so this is NOT `
            + 'assumed to be HAZEE.',
        };
      }
    }
  }

  if (row.agent) await resolveAgent(conn, ctx, row.agent);
  return { posted: true, entity: 'vouchers', id: voucherId, review, clearing };
}

/** Money in. Refuses to guess the account it landed in. */
async function postReceipt(conn: PoolConnection, ctx: PostContext, row: NormalizedRow): Promise<PostOutcome> {
  const amount = row.receivedAmount;
  if (amount == null || amount === 0)
    return skip('MISSING_ACCOUNTING_TREATMENT', 'Receipt row carries no amount.');

  // The money demonstrably moved, so refusing to post it would lose a real
  // bank or cash movement and make the account unreconcilable. Where the payer
  // cannot be identified the credit goes to Historical Suspense and the row is
  // flagged — the movement is preserved, the counterparty stays an open
  // question, and a non-zero suspense balance makes the month visibly
  // unfinished.
  let counterLedger: number | null = null;
  let review: PostOutcome['review'] | undefined;
  let clearing: PostOutcome['clearing'];

  const loanMovement = classifyCeoLoanMovement(row.narration ?? row.customerText ?? row.remarks);
  if (loanMovement === 'REPAYMENT') {
    counterLedger = await ledgerId(conn, ctx, CEO_LOAN_LEDGER);
    clearing = { category: REVIEW_REASON.CEO_LOAN, amount: Math.abs(amount) };
  } else if (!row.customer && row.reviewCategory === 'AMBIGUOUS_PARTY_MATCH') {
    counterLedger = await ledgerId(conn, ctx, CLEARING.AMBIGUOUS_PARTY);
    clearing = { category: REVIEW_REASON.AMBIGUOUS_PARTY, amount: Math.abs(amount) };
    review = {
      category: 'AMBIGUOUS_PARTY_MATCH',
      reason: row.reason ?? `Receipt of ${amount} has an ambiguous historical party; original text preserved.`,
    };
  } else if (row.customer) {
    counterLedger = (await resolveCustomer(conn, ctx, row.customer)).ledgerId;
  } else if (row.vendor) {
    // Money coming back from a vendor — a refund or a credit.
    counterLedger = (await resolveSupplier(conn, ctx, row.vendor)).ledgerId;
  } else {
    counterLedger = await ledgerId(conn, ctx, CLEARING.UNKNOWN_RECEIPT);
    clearing = { category: REVIEW_REASON.UNKNOWN_RECEIPT_PARTY, amount: Math.abs(amount) };
    review = {
      category: 'UNKNOWN_PARTY',
      reason: `Receipt of ${amount} from "${row.customerText ?? 'unnamed'}" — the source names no `
        + `party this system knows. Credited to "${CLEARING.UNKNOWN_RECEIPT}" pending audited reclassification.`,
    };
  }
  if (!counterLedger) return skip('OTHER', 'No ledger available for the counterparty.');
  const customer = { ledgerId: counterLedger };

  // A refund adjustment settles the account without money moving: the source
  // shows no cash or bank side, so posting one would invent a movement.
  //
  // The label can sit in any of three cells. The party ledgers put it in the
  // TICKET column — a line reading "REFUND" or "REFUND ADJUST" where every
  // other row carries a ticket number is the source stating what the line is,
  // in the field it uses to say so. Reading only the route cell missed ten
  // such credits entirely.
  if (/refund/i.test(row.remarks ?? '') || /refund/i.test(row.route ?? '')
      || /^\s*(refund|void)\b/i.test(row.ticketNo ?? '')) {
    const salesLedger = await ledgerId(conn, ctx, 'Sales — Air Tickets');
    if (!salesLedger) return skip('OTHER', 'The "Sales — Air Tickets" ledger is missing.');
    const { voucherId } = await postVoucherTx(conn, ctx.companyId, ctx.userId, {
      type: 'CREDIT_NOTE', date: row.date!,
      narration: narrate(row, 'Historical refund adjustment'),
      reference: reference(row),
      entries: [
        { ledgerId: salesLedger, type: 'DR', amount: Math.abs(amount) },
        { ledgerId: customer.ledgerId, type: 'CR', amount: Math.abs(amount) },
      ],
    }, { policy: ctx.policy });
    await stampVoucher(conn, ctx, voucherId);
    return { posted: true, entity: 'vouchers', id: voucherId, review, clearing };
  }

  const money = await moneyLedger(conn, ctx, row);
  if (!money)
    return skip('UNCLEAR_PAYMENT_METHOD',
      `Receipt of ${amount} from ${row.customer ?? row.customerText ?? 'an unnamed party'}: the source `
      + 'does not say whether it was cash or bank. Cross-check the day book and the bank statement first.');

  const { voucherId } = await postVoucherTx(conn, ctx.companyId, ctx.userId, {
    type: 'RECEIPT', date: row.date!,
    narration: narrate(row, 'Historical receipt'),
    reference: reference(row),
    entries: [
      { ledgerId: money, type: 'DR', amount: Math.abs(amount) },
      { ledgerId: customer.ledgerId, type: 'CR', amount: Math.abs(amount) },
    ],
  }, { policy: ctx.policy });
  await stampVoucher(conn, ctx, voucherId);
  return { posted: true, entity: 'vouchers', id: voucherId, review, clearing };
}

/**
 * Money out.
 *
 * The counter-side comes from the row's own description: a stated withdrawal
 * goes to CEO Drawings, a named vendor to that vendor's payable, and anything
 * else to Historical Suspense with a review item — never to a plausible-looking
 * expense ledger chosen by the poster.
 */
async function postPayment(conn: PoolConnection, ctx: PostContext, row: NormalizedRow): Promise<PostOutcome> {
  const amount = row.costAmount;
  if (amount == null || amount === 0)
    return skip('MISSING_ACCOUNTING_TREATMENT', 'Payment row carries no amount.');

  const money = await moneyLedger(conn, ctx, row);
  if (!money)
    return skip('UNCLEAR_PAYMENT_METHOD',
      `Payment of ${amount}: the source does not say whether it left cash or bank.`);

  // Decision 2: the narration is read for what it establishes — a vendor being
  // settled, a loan movement, or a named expense. A single clear match wins;
  // two matches, or none, leave the row unclassified rather than guessed.
  const fromNarration = classifyPaymentNarration(row.narration ?? row.customerText);

  // Drawings is decided by what the row says, never by whose name is on it.
  const drawings = assessDrawings(row.customerText, row.narration, null);
  // A CEO-personal row the source says nothing about must not be guessed at
  // either way — it is neither a drawing nor an ordinary expense until someone
  // reads the source.
  const drawingsUnclear = !drawings.drawings && drawings.review;
  const drawingsReason = drawingsUnclear ? drawings.reason : null;
  let counter: number | null = null;
  let review: PostOutcome['review'] | undefined;

  let clearing: PostOutcome['clearing'];

  if (drawings.drawings) {
    counter = await ledgerId(conn, ctx, LEDGER.CEO_DRAWINGS);
  } else if (row.expenseLedger) {
    counter = await ledgerId(conn, ctx, row.expenseLedger);
  } else if (row.vendor) {
    counter = (await resolveSupplier(conn, ctx, row.vendor)).ledgerId;
  } else if (fromNarration.kind === 'VENDOR') {
    counter = (await resolveSupplier(conn, ctx, fromNarration.vendor)).ledgerId;
  } else if (fromNarration.kind === 'EXPENSE' || fromNarration.kind === 'LOAN') {
    counter = await ledgerId(conn, ctx, fromNarration.ledger);
  }

  if (!counter) {
    // A named holding account, deliberately NOT "Office Expense" or
    // "Miscellaneous": dumping unclear items into a plausible-looking ledger
    // would clear the review flag and destroy the question. The original
    // narration stays on the voucher and on the source row.
    counter = await ledgerId(conn, ctx, CLEARING.UNCLASSIFIED_EXPENSE);
    clearing = { category: REVIEW_REASON.UNCLASSIFIED_EXPENSE, amount: Math.abs(amount) };
    review = {
      category: drawingsUnclear ? 'MISSING_ACCOUNTING_TREATMENT' : 'UNKNOWN_EXPENSE_CATEGORY',
      reason: drawingsReason
        ?? `Payment of ${amount} — the narration "${row.narration ?? row.customerText ?? '(blank)'}" `
           + `does not clearly establish an expense type. Posted to "${CLEARING.UNCLASSIFIED_EXPENSE}"; `
           + 'the original wording is preserved and searchable.',
    };
  }
  if (!counter) return skip('OTHER', `The "${CLEARING.UNCLASSIFIED_EXPENSE}" ledger is missing.`);

  const { voucherId } = await postVoucherTx(conn, ctx.companyId, ctx.userId, {
    type: 'PAYMENT', date: row.date!,
    narration: narrate(row, 'Historical payment'),
    reference: reference(row),
    entries: [
      { ledgerId: counter, type: 'DR', amount: Math.abs(amount) },
      { ledgerId: money, type: 'CR', amount: Math.abs(amount) },
    ],
  }, { policy: ctx.policy });
  await stampVoucher(conn, ctx, voucherId);
  return { posted: true, entity: 'vouchers', id: voucherId, review, clearing };
}

/**
 * ADM or VOID — an airline penalty the company bears.
 *
 * Dr the penalty ledger, Cr the vendor who charged it. Where the source names
 * no vendor the credit goes to suspense with a review item, because the
 * alternative is inventing a creditor.
 */
async function postPenalty(conn: PoolConnection, ctx: PostContext, row: NormalizedRow): Promise<PostOutcome> {
  const amount = row.costAmount ?? row.sellingAmount;
  if (amount == null || amount === 0)
    return skip('MISSING_ACCOUNTING_TREATMENT', 'Penalty row carries no amount.');

  const penalty = await ledgerId(conn, ctx, row.expenseLedger ?? LEDGER.ADM);
  if (!penalty) return skip('OTHER', `The "${row.expenseLedger ?? LEDGER.ADM}" ledger is missing.`);

  let counter: number | null = null;
  let review: PostOutcome['review'] | undefined;
  let clearing: PostOutcome['clearing'];
  if (row.vendor) counter = (await resolveSupplier(conn, ctx, row.vendor)).ledgerId;
  if (!counter) {
    counter = await ledgerId(conn, ctx, CLEARING.UNKNOWN_SUPPLIER);
    clearing = { category: REVIEW_REASON.UNKNOWN_SUPPLIER, amount: Math.abs(amount) };
    review = {
      category: 'MISSING_VENDOR',
      reason: `${row.expenseCategorySource ?? 'Penalty'} of ${amount} with no vendor named in the source. `
        + `Credited to "${CLEARING.UNKNOWN_SUPPLIER}" pending confirmation of who charged it.`,
    };
  }
  if (!counter) return skip('OTHER', `The "${CLEARING.UNKNOWN_SUPPLIER}" ledger is missing.`);

  const { voucherId } = await postVoucherTx(conn, ctx.companyId, ctx.userId, {
    type: 'JOURNAL', date: row.date!,
    narration: narrate(row, `Historical ${row.expenseCategorySource ?? 'airline penalty'}`),
    reference: reference(row),
    entries: [
      { ledgerId: penalty, type: 'DR', amount: Math.abs(amount) },
      { ledgerId: counter, type: 'CR', amount: Math.abs(amount) },
    ],
  }, { policy: ctx.policy });
  await stampVoucher(conn, ctx, voucherId);
  return { posted: true, entity: 'vouchers', id: voucherId, review, clearing };
}

/**
 * Mark the voucher as migrated.
 *
 * `migration_batch_id` is what makes a rollback able to find its own work, and
 * `is_backdated` is what tells a reader this row was imported rather than
 * typed. Both are set on the voucher itself so neither depends on a join.
 */
async function stampVoucher(conn: PoolConnection, ctx: PostContext, voucherId: number): Promise<void> {
  await conn.query(
    'UPDATE vouchers SET migration_batch_id = ?, is_backdated = 1 WHERE id = ?',
    [ctx.batchId, voucherId]);
}

/** Builds the context once per batch, including the books policy. */
export async function makeContext(
  conn: PoolConnection, companyId: number, userId: number, batchId: number, dryRun: boolean,
): Promise<PostContext> {
  return {
    companyId, userId, batchId, dryRun,
    policy: await loadBooksPolicyTx(conn, companyId),
    ledgers: new Map(), customers: new Map(), suppliers: new Map(), agents: new Map(),
  };
}
