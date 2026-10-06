import { pool, Row, withTransaction } from '../config/db';
import { env } from '../config/env';
import { postVoucherTx } from '../modules/accounting/accounting.service';
import { loadBooksPolicyTx } from '../modules/accounting/fiscalPeriod.service';

/**
 * ================ D005 · UNIDENTIFIED RECEIPT METHOD =======================
 *
 * D005 = C. Three HAQUE GROUP receipts (BDT 982,314.00, April-May 2024) name
 * their payer, date and amount; the cell that would say CASH, DBBL BANK or
 * City bank is blank. The receipt is genuine, so it is posted. The account it
 * landed in is unknown, so it is NOT guessed.
 *
 *   Dr  Unidentified Receipt Method
 *   Cr  Customer - HAQUE GROUP
 *
 * The receivable therefore corrects, and cash/bank stays visibly unresolved
 * rather than invented. When authoritative bank or cash evidence appears, an
 * audited reclassification posts Dr real cash/bank, Cr this clearing ledger —
 * the original customer receipt is never touched.
 *
 * What is preserved, unchanged: the source date, the amount, the customer, the
 * workbook/sheet/row lineage, the original blank payment-method cell inside
 * `raw`, and the review item — which stays OPEN, because the method is still
 * unknown after this runs. Posting the receipt answers "did the money arrive?"
 * and not "into which account?", and only the second question was ever the
 * review item's subject.
 *
 * ── Period lineage ────────────────────────────────────────────────────────
 *
 * One row (Sales April row 44) carries a 2024-05-15 date inside the April
 * sheet. Nothing here changes its period: the voucher takes the row's own
 * transaction date, and `migration_batch_id` keeps the batch of the sheet it
 * came from. Both facts stay on the record and visibly disagree, which is the
 * honest state until a policy or the source settles which one governs.
 *
 * Idempotent: a row already carrying a voucher is skipped, so a re-run posts
 * nothing.
 */

const CLEARING_LEDGER = 'Unidentified Receipt Method';
const CLEARING_CATEGORY = 'UNIDENTIFIED_RECEIPT_METHOD';

async function main(): Promise<void> {
  if (env.isProduction || !/staging/i.test(env.db.database))
    throw new Error(`Refusing D005 processing on non-staging database: ${env.db.database}`);

  const actorId = Number(process.env.PHASE5_ACTOR_USER_ID);
  if (!Number.isInteger(actorId) || actorId < 1) throw new Error('PHASE5_ACTOR_USER_ID is required.');
  const dryRun = process.argv.includes('--dry-run');

  const outcome = await withTransaction(async (conn) => {
    const [clearing] = await conn.query<Row[]>(
      'SELECT id FROM ledgers WHERE company_id = 1 AND name = ? LIMIT 1', [CLEARING_LEDGER]);
    if (!clearing.length)
      throw new Error(`Required ledger is missing: ${CLEARING_LEDGER}. Apply migration 016 first.`);
    const clearingLedgerId = Number(clearing[0].id);

    const [candidates] = await conn.query<Row[]>(
      `SELECT i.id AS review_id, r.*
         FROM migration_review_items i
         JOIN migration_source_rows r ON r.id = i.source_row_id
        WHERE i.company_id = 1 AND i.issue_type = 'UNCLEAR_PAYMENT_METHOD' AND i.status = 'OPEN'
        ORDER BY r.source_date, r.source_row
        FOR UPDATE`);

    const policy = await loadBooksPolicyTx(conn, 1);
    const posted: Array<Record<string, unknown>> = [];
    let skipped = 0;
    let amountTotal = 0;

    for (const row of candidates) {
      // Already posted by an earlier run — nothing to do, and certainly not a
      // second voucher for the same receipt.
      if (row.target_id != null || row.status === 'IMPORTED') { skipped++; continue; }

      const amount = Number(row.source_amount ?? 0);
      if (!(amount > 0))
        throw new Error(`Source row ${row.id} carries no positive receipt amount; refusing to post.`);

      // The customer must resolve to exactly one existing master. This script
      // never creates a party: if the name is not already there, the row is
      // not a D005 row and something upstream has changed.
      const [customers] = await conn.query<Row[]>(
        `SELECT c.id, c.ledger_id, c.name FROM customers c
          WHERE c.company_id = ? AND c.name_key = UPPER(TRIM(?)) LIMIT 2`,
        [row.company_id, row.normalized_party_name ?? row.original_party_name]);
      if (customers.length !== 1)
        throw new Error(
          `Source row ${row.id}: "${row.original_party_name}" matched ${customers.length} customer masters; `
          + 'refusing to guess which receivable to credit.');
      const customer = customers[0];

      const reference = `${row.source_sheet}#${row.source_row}`;

      if (dryRun) {
        posted.push({ sourceRow: row.id, date: row.source_date, amount,
          customer: customer.name, reference, period: row.source_period });
        amountTotal += amount;
        continue;
      }

      const voucher = await postVoucherTx(conn, Number(row.company_id), actorId, {
        type: 'RECEIPT',
        // The row's OWN transaction date, not the sheet's month.
        date: String(row.source_date),
        reference,
        narration:
          `Phase 5 D005 evidenced receipt with unidentified method - ${reference}. `
          + 'Payer, date and amount are evidenced; the source states no cash or bank account.',
        entries: [
          { ledgerId: clearingLedgerId, type: 'DR', amount },
          { ledgerId: Number(customer.ledger_id), type: 'CR', amount },
        ],
      }, { policy });

      await conn.query(
        'UPDATE vouchers SET migration_batch_id = ?, is_backdated = 1 WHERE id = ?',
        [row.batch_id, voucher.voucherId]);

      await conn.query(
        `UPDATE migration_source_rows
            SET status = 'IMPORTED', target_entity = 'vouchers', target_id = ?,
                party_type = 'CUSTOMER', party_id = ?,
                clearing_category = ?, clearing_amount = ?
          WHERE id = ?`,
        [voucher.voucherId, customer.id, CLEARING_CATEGORY, amount, row.id]);

      // The review item STAYS OPEN. The method is still unknown; only the
      // receipt has been recorded. Closing it here would retire a question
      // nobody has answered.
      const evidence =
        `D005 = C. Receipt of ${amount.toFixed(2)} from ${customer.name} on ${String(row.source_date)} posted `
        + `Dr "${CLEARING_LEDGER}" / Cr "${customer.name}" (voucher ${voucher.voucherId}). Payer, date and `
        + 'amount are evidenced in the source; the payment-method cell is blank and no cash or bank account '
        + 'was guessed. The receipt method remains an open historical limitation, reclassifiable on '
        + 'authoritative bank or cash evidence without altering this receipt.';

      const [logged] = await conn.query<Row[]>(
        `SELECT id FROM historical_review_actions
          WHERE company_id = ? AND review_item_id = ? AND rule_code = 'D005_POSTED_TO_RECEIPT_CLEARING' LIMIT 1`,
        [row.company_id, row.review_id]);
      if (!logged.length) {
        await conn.query(
          `INSERT INTO historical_review_actions
             (company_id, review_item_id, action_code, prior_status, resulting_status,
              evidence, rule_code, actor_id)
           VALUES (?,?, 'NEEDS_MORE_EVIDENCE', 'OPEN', 'OPEN', ?, 'D005_POSTED_TO_RECEIPT_CLEARING', ?)`,
          [row.company_id, row.review_id, evidence, actorId]);
      }

      await conn.query(
        `UPDATE migration_review_items
            SET notes = ?, is_material = 1
          WHERE company_id = ? AND id = ?`,
        [evidence.slice(0, 1000), row.company_id, row.review_id]);

      posted.push({ sourceRow: row.id, voucherId: voucher.voucherId, date: String(row.source_date),
        amount, customer: customer.name, reference, period: row.source_period });
      amountTotal += amount;
    }

    return { posted: posted.length, skipped, amountTotal: Math.round(amountTotal * 100) / 100, rows: posted };
  });

  console.log(JSON.stringify({ database: env.db.database, dryRun, ...outcome }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
