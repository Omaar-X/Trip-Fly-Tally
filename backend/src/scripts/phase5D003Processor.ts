import { pool, Row, withTransaction } from '../config/db';
import { env } from '../config/env';
import { postVoucherTx } from '../modules/accounting/accounting.service';

const VISA_GROUPS = new Set([
  'COMBODIA VISA', 'HONG KONG VISA FEE', 'INDONESIA VISA', 'MALAYSIA VISA',
  'VISA FEE', 'SUDIP VISA', 'JAPAN VISA',
]);
const SALARY_GROUPS = new Set(['HUJUR SALARY', 'HUJUR BONUS']);
const OFFICE_GROUPS = new Set(['ENTERTAINMENT', 'OFFICE EQUIPMENT(TISSUE & AIR FRESH)']);
const normalized = (value: unknown) => String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

async function main() {
  if (env.isProduction || !/staging/i.test(env.db.database))
    throw new Error(`Refusing D003 processing on non-staging database: ${env.db.database}`);
  const actorId = Number(process.env.PHASE5_ACTOR_USER_ID);
  if (!Number.isInteger(actorId) || actorId < 1) throw new Error('PHASE5_ACTOR_USER_ID is required.');

  const outcome = await withTransaction(async conn => {
    const [ledgers] = await conn.query<Row[]>(
      `SELECT id,name FROM ledgers WHERE company_id=1 AND name IN
       ('Unclassified Historical Expense','Cost of Services','Hujur Salary','Office Bazar')`);
    const ledger = (name: string) => {
      const found = ledgers.find(row => row.name === name);
      if (!found) throw new Error(`Required ledger is missing: ${name}`);
      return Number(found.id);
    };
    const fromLedgerId = ledger('Unclassified Historical Expense');
    const [rows] = await conn.query<Row[]>(
      `SELECT r.* FROM migration_source_rows r
        WHERE r.company_id=1 AND r.clearing_category='UNCLASSIFIED_HISTORICAL_EXPENSE'
        ORDER BY r.id FOR UPDATE`);
    let sourceRows = 0; let reviewItems = 0; let amount = 0;
    const byTreatment: Record<string, { rows: number; amount: number }> = {};
    for (const row of rows) {
      const group = normalized(row.original_party_name);
      let targetName: string | null = null;
      let ruleCode: string | null = null;
      let evidence: string | null = null;
      if (VISA_GROUPS.has(group)) {
        targetName = 'Cost of Services'; ruleCode = 'D003_EXACT_REQUISITION_VISA_COST';
        evidence = 'Exact narration and amount corroborated in a separate historical requisition, including visa type and quantity/rate where supplied.';
      } else if (SALARY_GROUPS.has(group)) {
        targetName = 'Hujur Salary'; ruleCode = 'D003_EXACT_REQUISITION_SALARY';
        evidence = group === 'HUJUR SALARY'
          ? 'Exact narration and amount corroborated by historical requisition and bank-statement evidence identifying office Hujur salary.'
          : 'Exact narration and amount corroborated by bank-statement evidence identifying Hujur bonus.';
      } else if (OFFICE_GROUPS.has(group)) {
        targetName = 'Office Bazar'; ruleCode = 'D003_EXACT_REQUISITION_OFFICE_COST';
        evidence = 'Exact narration and amount corroborated in a separate historical requisition identifying entertainment or office consumables.';
      }
      if (!targetName || !ruleCode || !evidence) continue;
      const [items] = await conn.query<Row[]>(
        `SELECT id FROM migration_review_items WHERE company_id=? AND source_row_id=?
          AND issue_type='UNCLASSIFIED_HISTORICAL_EXPENSE' AND status='OPEN' FOR UPDATE`,
        [row.company_id, row.id]);
      if (!items.length) continue;
      const reference = `${row.source_sheet}#${row.source_row}`;
      const [originals] = await conn.query<Row[]>(
        `SELECT v.id,ve.amount,ve.entry_type FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id=v.id
          WHERE v.company_id=? AND v.reference=? AND ve.ledger_id=? AND v.status='ACTIVE'
          ORDER BY v.id LIMIT 1`, [row.company_id, reference, fromLedgerId]);
      const original = originals[0];
      if (!original || original.entry_type !== 'DR')
        throw new Error(`No matching unclassified-expense voucher for source row ${row.id}.`);
      const targetLedgerId = ledger(targetName);
      const posted = await postVoucherTx(conn, Number(row.company_id), actorId, {
        type: 'JOURNAL', date: String(row.source_date), reference: `P5-D003-${row.id}`,
        narration: `Phase 5 D003 evidenced reclassification · ${reference}`,
        entries: [
          { ledgerId: targetLedgerId, type: 'DR', amount: Number(original.amount) },
          { ledgerId: fromLedgerId, type: 'CR', amount: Number(original.amount) },
        ],
      });
      await conn.query('UPDATE vouchers SET migration_batch_id=? WHERE id=?', [row.batch_id, posted.voucherId]);
      for (const item of items) {
        await conn.query(
          `INSERT INTO historical_review_reclassifications
           (company_id,review_item_id,source_row_id,original_voucher_id,reclassification_voucher_id,
            from_ledger_id,to_ledger_id,amount,evidence,rule_code,actor_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [row.company_id,item.id,row.id,original.id,posted.voucherId,fromLedgerId,targetLedgerId,
           original.amount,evidence,ruleCode,actorId]);
        await conn.query(
          `INSERT INTO historical_review_actions
           (company_id,review_item_id,action_code,prior_status,resulting_status,evidence,rule_code,actor_id)
           VALUES (?,?,'EXPENSE_RECLASSIFIED','OPEN','RESOLVED',?,?,?)`,
          [row.company_id,item.id,evidence,ruleCode,actorId]);
        await conn.query(
          `UPDATE migration_review_items SET status='RESOLVED',resolution=?,resolution_code='EXPENSE_RECLASSIFIED',
             resolved_by=?,resolved_at=NOW() WHERE id=?`, [evidence,actorId,item.id]);
      }
      sourceRows++; reviewItems += items.length; amount += Number(original.amount);
      const bucket = byTreatment[targetName] ?? { rows: 0, amount: 0 };
      bucket.rows++; bucket.amount += Number(original.amount); byTreatment[targetName] = bucket;
    }
    return { sourceRows, reviewItems, amount, byTreatment };
  });
  console.log(JSON.stringify({ database: env.db.database, ...outcome }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
