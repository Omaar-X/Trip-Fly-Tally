import { pool, query, Row, withTransaction } from '../config/db';
import { env } from '../config/env';
import { makeContext, postRow } from '../modules/migration/poster';
import { loadBooksPolicyTx } from '../modules/accounting/fiscalPeriod.service';
import { parsePeriod, defaultDataDir, NormalizedRow } from '../modules/migration/parser';

/**
 * ======= D008 · POSTING TRANSACTIONS D004 PROVED WERE NOT DUPLICATES =======
 *
 * D004 established NOT A DUPLICATE. That is not the same as ACCOUNTING
 * TREATMENT KNOWN, and this script posts only where both now hold.
 *
 * Treatment is never chosen here. Each row is matched back to its parsed source
 * line and handed to the SAME `postRow` the migration uses, so the accounting
 * follows the established rules and the evidenced structure of the row:
 *
 *   · a negative sales-register line reverses the sale it belongs to
 *     (CREDIT_NOTE), and reverses its cost side too (DEBIT_NOTE) when the
 *     source shows the fare being credited back;
 *   · a party-ledger CREDIT labelled REFUND / REFUND ADJUST settles the
 *     customer without inventing a cash movement;
 *   · an ordinary debit line with a route and a passenger is a sale.
 *
 * Nothing posts on the strength of the word REFUND alone, and no generic
 * balancing journal is written anywhere.
 *
 * A row the poster cannot treat — no rule, no party, no payment method, or a
 * structure the source does not settle — is left exactly where it was:
 * UNPOSTED_CLEARED_HISTORICAL_TRANSACTION, open, with its evidence intact.
 *
 * Idempotent: a row that already carries a voucher is skipped, so a re-run
 * writes nothing.
 */

const ISSUE = 'UNPOSTED_CLEARED_HISTORICAL_TRANSACTION';

async function main(): Promise<void> {
  if (env.isProduction || !/staging/i.test(env.db.database))
    throw new Error(`Refusing D008 processing on non-staging database: ${env.db.database}`);
  const actorId = Number(process.env.PHASE5_ACTOR_USER_ID);
  if (!Number.isInteger(actorId) || actorId < 1) throw new Error('PHASE5_ACTOR_USER_ID is required.');
  const dryRun = process.argv.includes('--dry-run');

  const items = await query<Row[]>(
    `SELECT i.id AS review_id, r.*
       FROM migration_review_items i JOIN migration_source_rows r ON r.id = i.source_row_id
      WHERE i.company_id = 1 AND i.issue_type = ? AND i.status = 'OPEN'
      ORDER BY r.source_period, r.source_sheet, r.source_row`, [ISSUE]);

  // Parse each affected period once; the parsed line is the evidence.
  const parsed = new Map<string, NormalizedRow[]>();
  for (const p of [...new Set(items.map((i) => String(i.source_period)))])
    parsed.set(p, (await parsePeriod(p, { dataDir: defaultDataDir() })).rows);

  const posted: Record<string, unknown>[] = [];
  const held: Record<string, unknown>[] = [];
  let skipped = 0;

  await withTransaction(async (conn) => {
    const policy = await loadBooksPolicyTx(conn, 1);

    for (const item of items) {
      if (item.target_id != null) { skipped++; continue; }

      const rows = parsed.get(String(item.source_period)) ?? [];
      const match = rows.find((r) =>
        r.source.sheet === item.source_sheet && r.source.row === Number(item.source_row));

      if (!match) {
        held.push({ id: item.id, reason: 'The source line could not be matched on re-parse.' });
        continue;
      }

      // D004 proved this is a real transaction, so it is presented to the
      // poster as one. Nothing else about the row is altered.
      const candidate: NormalizedRow = { ...match, outcome: 'FINANCIAL' };

      // A row the poster would send to a clearing account because its party or
      // its treatment is unknown has not had its ACCOUNTING established, only
      // its non-duplicate status. Those stay open rather than being parked in
      // a clearing ledger on D008's authority.
      if (candidate.kind === 'PENALTY' && candidate.customer) {
        held.push({
          id: item.id, period: item.source_period,
          sheet: item.source_sheet, row: item.source_row, amount: item.source_amount,
          reason: `The source charges this ${candidate.route ?? 'penalty'} to ${candidate.customer} as a `
            + 'debit in the party ledger, but the penalty rule books it as a company cost against a '
            + 'supplier. Whether the customer was billed for the void or the company bore it is not '
            + 'settled by the row. Accounting treatment not established.',
        });
        continue;
      }
      if (!candidate.customer && !candidate.vendor && candidate.kind !== 'PAYMENT') {
        held.push({
          id: item.id, period: item.source_period,
          sheet: item.source_sheet, row: item.source_row, amount: item.source_amount,
          reason: 'The source names no party for this transaction, so the counterparty side cannot be '
            + 'established. Not a duplicate, but not yet postable.',
        });
        continue;
      }

      if (dryRun) {
        posted.push({ id: item.id, period: item.source_period, sheet: item.source_sheet,
          row: item.source_row, kind: candidate.kind, amount: item.source_amount,
          selling: candidate.sellingAmount, cost: candidate.costAmount,
          received: candidate.receivedAmount, customer: candidate.customer });
        continue;
      }

      const ctx = await makeContext(conn, 1, actorId, Number(item.batch_id), false);
      ctx.policy = policy;
      const outcome = await postRow(conn, ctx, candidate);

      if (!outcome.posted || !outcome.id) {
        held.push({
          id: item.id, period: item.source_period, sheet: item.source_sheet,
          row: item.source_row, amount: item.source_amount,
          reason: outcome.review?.reason ?? 'The poster had no rule for this row.',
        });
        continue;
      }

      await conn.query(
        `UPDATE migration_source_rows
            SET status = 'IMPORTED', target_entity = ?, target_id = ?
          WHERE id = ?`,
        [outcome.entity ?? 'vouchers', outcome.id, item.id]);

      const evidence =
        `D008 = A. D004 proved this is a genuine transaction, not a duplicate; the accounting treatment `
        + `is established by the source row itself (${candidate.kind}, `
        + `${candidate.sellingAmount ?? candidate.receivedAmount ?? candidate.costAmount}, `
        + `${item.source_sheet} row ${item.source_row}) and was posted through the standard historical `
        + `path as voucher ${outcome.id}. Original date, ticket, passenger, customer and source lineage `
        + 'unchanged.';

      await conn.query(
        `INSERT INTO historical_review_actions
           (company_id, review_item_id, action_code, prior_status, resulting_status,
            evidence, rule_code, actor_id)
         VALUES (?,?, 'CLEARED_NOT_DUPLICATE', 'OPEN', 'RESOLVED', ?, 'D008_POSTED_EVIDENCED_TRANSACTION', ?)`,
        [1, item.review_id, evidence, actorId]);

      await conn.query(
        `UPDATE migration_review_items
            SET status = 'RESOLVED', resolution = ?, resolution_code = 'POSTED_EVIDENCED_TRANSACTION',
                resolved_by = ?, resolved_at = NOW()
          WHERE id = ?`,
        [evidence, actorId, item.review_id]);

      posted.push({ id: item.id, period: item.source_period, sheet: item.source_sheet,
        row: item.source_row, kind: candidate.kind, voucher: outcome.id,
        amount: item.source_amount });
    }
  });

  // Rows left open keep their item and gain a note saying why, so the reason is
  // on the record rather than only in this output.
  if (!dryRun) {
    for (const h of held) {
      await query<Row[]>(
        'UPDATE migration_review_items SET notes = ? WHERE source_row_id = ? AND issue_type = ? AND status = \'OPEN\'',
        [String(h.reason).slice(0, 1000), h.id, ISSUE] as never);
    }
  }

  console.log(JSON.stringify({
    database: env.db.database, dryRun,
    candidates: items.length, skippedAlreadyPosted: skipped,
    posted: posted.length, held: held.length,
    postedRows: posted, heldRows: held,
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
