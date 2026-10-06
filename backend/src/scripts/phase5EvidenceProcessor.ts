import { pool, Row, withTransaction } from '../config/db';
import { env } from '../config/env';
import { postVoucherTx } from '../modules/accounting/accounting.service';

type Source = Row & { raw: string | Record<string, unknown> | null };

const norm = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const agency = (raw: Source['raw']) => {
  const value = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
  const entry = Object.entries(value as Record<string, unknown>)
    .find(([key]) => norm(key).replace(/[^A-Z]/g, '') === 'ISSUEINGAGENCY');
  return norm(entry?.[1]);
};

async function main() {
  if (env.isProduction || !/staging/i.test(env.db.database))
    throw new Error(`Refusing evidence processing on non-staging database: ${env.db.database}`);
  const actorId = Number(process.env.PHASE5_ACTOR_USER_ID);
  if (!Number.isInteger(actorId) || actorId < 1) throw new Error('PHASE5_ACTOR_USER_ID is required.');

  const [sources] = await pool.query<Source[]>(
    `SELECT * FROM migration_source_rows WHERE company_id=1 AND status <> 'SKIPPED_DUPLICATE'`);
  const explicit = new Map<string, Set<string>>();
  for (const row of sources) {
    const a = agency(row.raw);
    if (!a) continue;
    for (const key of [row.source_ref, row.pnr].map(norm).filter(Boolean)) {
      const set = explicit.get(key) ?? new Set<string>(); set.add(a); explicit.set(key, set);
    }
  }
  const candidates = sources.filter(row => row.clearing_category === 'UNKNOWN_HISTORICAL_TICKET_SUPPLIER')
    .filter(row => {
      const evidence = new Set<string>();
      for (const key of [row.source_ref, row.pnr].map(norm).filter(Boolean))
        for (const a of explicit.get(key) ?? []) evidence.add(a);
      return evidence.size === 1 && evidence.has('HAZEE');
    });

  const outcome = await withTransaction(async conn => {
    const [ledgers] = await conn.query<Row[]>(
      `SELECT id,name FROM ledgers WHERE company_id=1 AND
       (name='Unknown / Unassigned Ticket Supplier' OR name LIKE 'Supplier%HAZEE')`);
    const from = ledgers.find(x => x.name === 'Unknown / Unassigned Ticket Supplier');
    const to = ledgers.find(x => String(x.name).endsWith('HAZEE'));
    if (!from || !to) throw new Error('Required clearing/supplier ledger is missing.');
    let resolved = 0; let amount = 0;
    for (const row of candidates) {
      const [items] = await conn.query<Row[]>(
        `SELECT id FROM migration_review_items WHERE company_id=? AND source_row_id=?
          AND issue_type='UNKNOWN_HISTORICAL_TICKET_SUPPLIER' AND status='OPEN' FOR UPDATE`,
        [row.company_id, row.id]);
      if (!items.length) continue; // makes the processor idempotent
      const reference = `${row.source_sheet}#${row.source_row}`;
      // The cost side of a sale sits on ONE of two vouchers, and which one
      // depends on the sign of the source cost:
      //
      //   PURCHASE     Cr Unknown Supplier   — an ordinary purchase
      //   DEBIT_NOTE   Dr Unknown Supplier   — a purchase return on a refunded
      //                                        or voided ticket (D009)
      //
      // Both are reclassifiable, and the journal that moves the balance to the
      // evidenced supplier simply runs the other way for a return. Matching
      // only PURCHASE/CR made every refunded ticket unreclassifiable.
      const [originals] = await conn.query<Row[]>(
        `SELECT v.id, v.voucher_type, ve.amount, ve.entry_type
           FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id
          WHERE v.company_id = ? AND v.reference = ?
            AND v.voucher_type IN ('PURCHASE','DEBIT_NOTE') AND ve.ledger_id = ?
          ORDER BY v.id LIMIT 1`, [row.company_id, reference, from.id]);
      const original = originals[0];
      if (!original || (original.entry_type !== 'CR' && original.entry_type !== 'DR'))
        throw new Error(`No matching unknown-supplier cost voucher for source row ${row.id}.`);
      // A return already debited the clearing account, so moving it to the real
      // supplier credits the clearing account and debits the supplier.
      const isReturn = original.entry_type === 'DR';
      const evidence = `Deterministic exact ticket/PNR match: another source row for ${row.source_ref || row.pnr} explicitly names issuing agency HAZEE; no conflicting agency exists.`;
      const posted = await postVoucherTx(conn, Number(row.company_id), actorId, {
        type: 'JOURNAL', date: String(row.source_date), reference: `P5-US-${row.id}`,
        narration: `Phase 5 evidenced supplier reclassification · ${reference}`,
        entries: isReturn
          ? [{ ledgerId: Number(to.id), type: 'DR', amount: Number(original.amount) },
             { ledgerId: Number(from.id), type: 'CR', amount: Number(original.amount) }]
          : [{ ledgerId: Number(from.id), type: 'DR', amount: Number(original.amount) },
             { ledgerId: Number(to.id), type: 'CR', amount: Number(original.amount) }],
      });
      await conn.query('UPDATE vouchers SET migration_batch_id=? WHERE id=?', [row.batch_id, posted.voucherId]);
      for (const item of items) {
        await conn.query(
          `INSERT INTO historical_review_reclassifications
           (company_id,review_item_id,source_row_id,original_voucher_id,reclassification_voucher_id,
            from_ledger_id,to_ledger_id,amount,evidence,rule_code,actor_id)
           VALUES (?,?,?,?,?,?,?,?,?,'EXACT_TICKET_SINGLE_EXPLICIT_AGENCY',?)`,
          [row.company_id,item.id,row.id,original.id,posted.voucherId,from.id,to.id,original.amount,evidence,actorId]);
        await conn.query(
          `INSERT INTO historical_review_actions
           (company_id,review_item_id,action_code,prior_status,resulting_status,evidence,rule_code,actor_id)
           VALUES (?,?,'PARTY_RECLASSIFIED','OPEN','RESOLVED',?,'EXACT_TICKET_SINGLE_EXPLICIT_AGENCY',?)`,
          [row.company_id,item.id,evidence,actorId]);
        await conn.query(
          `UPDATE migration_review_items SET status='RESOLVED',resolution=?,resolution_code='PARTY_RECLASSIFIED',
             resolved_by=?,resolved_at=NOW() WHERE id=?`, [evidence,actorId,item.id]);
      }
      resolved += items.length; amount += Number(original.amount);
    }
    return { candidateSourceRows: candidates.length, resolvedReviewItems: resolved, amount };
  });
  console.log(JSON.stringify({ database: env.db.database, ...outcome }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
