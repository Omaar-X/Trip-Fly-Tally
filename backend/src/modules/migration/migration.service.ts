import { PoolConnection } from 'mysql2/promise';
import { query, exec, withTransaction, Row, WriteResult } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { nextRequestNo } from '../../utils/numbering';
import {
  Classification, HistoricalRow, naturalKey, ServiceCategory,
} from './historicalRules';

/**
 * ========================= THE MIGRATION ENGINE ============================
 *
 * Phase 3 builds this; Phase 4 runs it against the full history.
 *
 * Three guarantees, in the order they matter:
 *
 *   ATOMIC       A batch either lands completely or not at all. Every write
 *                happens inside one transaction, and a failure rolls the whole
 *                batch back rather than leaving a half-imported month that
 *                nobody can reconcile and nobody dares delete.
 *
 *   IDEMPOTENT   Every source row carries a natural key, unique per company.
 *                Running the same month twice imports it once. This is enforced
 *                by a UNIQUE constraint, not by a check the engine performs —
 *                a check can be forgotten, a constraint cannot.
 *
 *   TRACEABLE    Nothing is written without recording the file, sheet and row
 *                it came from, what the source called the party, and what it
 *                was normalised to. "Where did this voucher come from" always
 *                has an answer.
 *
 * What it deliberately does NOT do: force a total. A difference between the
 * source and the migrated books is recorded as a difference. Making them agree
 * by inventing an adjustment is available only through a separate, audited
 * path that demands a reason and an approver.
 * ===========================================================================
 */

export type BatchStatus =
  | 'DRY_RUN' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'ROLLED_BACK'
  | 'VERIFIED' | 'ACCEPTED_WITH_LIMITATION';

export type ReconMetric =
  | 'SALES' | 'PURCHASE' | 'RECEIPT' | 'PAYMENT' | 'CUSTOMER_OUTSTANDING'
  | 'VENDOR_PAYABLE' | 'EXPENSES' | 'PROFIT_LOSS' | 'CAPITAL' | 'FIXED_ASSETS'
  | 'TRANSACTION_COUNT' | 'REVIEW_REQUIRED_COUNT';

/** One parsed source line, ready to be staged. */
export interface StagedRow extends HistoricalRow {
  sourcePeriod: string;
  sourceClassification?: string | null;
  serviceCategory: ServiceCategory;
  classification: Classification;
  raw?: unknown;
}

export interface RunOptions {
  /** Parse, stage and reconcile without writing a single transaction. */
  dryRun: boolean;
}

const asNumber = (v: unknown): number => Number(v ?? 0);

export const migrationService = {

  // ───────────────────────────── batches ────────────────────────────────────

  /**
   * Open a batch.
   *
   * The snapshot reference is recorded here, before anything is written,
   * because a backup taken after the first failure is not a backup. Taking the
   * snapshot itself is the operator's job — this records which one belongs to
   * which batch, so a restore is never a guess about timing.
   */
  async createBatch(companyId: number, userId: number, input: {
    period: string; description?: string; snapshotRef?: string;
  }) {
    return withTransaction(async (conn) => {
      const batchNo = await nextRequestNo(conn, companyId, 'MIG');
      const [res] = await conn.query<WriteResult>(
        `INSERT INTO migration_batches
           (company_id, batch_no, source_period, description, status,
            snapshot_ref, snapshot_taken_at, created_by)
         VALUES (?,?,?,?, 'DRY_RUN', ?, ?, ?)`,
        [companyId, batchNo, input.period, input.description ?? null,
         input.snapshotRef ?? null, input.snapshotRef ? new Date() : null, userId]);
      return { id: res.insertId, batchNo, period: input.period, status: 'DRY_RUN' as BatchStatus };
    });
  },

  async getBatch(companyId: number, batchId: number) {
    const rows = await query<Row[]>(
      'SELECT * FROM migration_batches WHERE company_id = ? AND id = ?', [companyId, batchId]);
    if (!rows[0]) throw ApiError.notFound(`Migration batch ${batchId} not found.`);
    return rows[0];
  },

  listBatches: (companyId: number) =>
    query<Row[]>(
      `SELECT * FROM migration_batches WHERE company_id = ?
        ORDER BY source_period DESC, id DESC`, [companyId]),

  /**
   * Stage and (unless this is a dry run) post a batch of parsed rows.
   *
   * The whole batch shares one transaction. A row the engine cannot classify
   * does not abort it — that row is staged as REVIEW_REQUIRED and the run
   * continues, because parking one ambiguous line is not a reason to discard a
   * month's work. A genuine error — a write that fails, a constraint that
   * refuses — does abort it, and the transaction unwinds everything.
   */
  async runBatch(
    companyId: number, batchId: number, rows: StagedRow[], opts: RunOptions,
    post?: (conn: PoolConnection, row: StagedRow) => Promise<{ entity: string; id: number }>,
  ) {
    const batch = await this.getBatch(companyId, batchId);
    if (['VERIFIED', 'ACCEPTED_WITH_LIMITATION'].includes(String(batch.status)))
      throw ApiError.conflict('This month is approved and closed. Re-importing it would rewrite approved history.');
    if (batch.status === 'RUNNING')
      throw ApiError.conflict('This batch is already running.');

    const counts = { staged: 0, imported: 0, review: 0, duplicate: 0, failed: 0 };

    try {
      await exec('UPDATE migration_batches SET status = ?, started_at = NOW() WHERE id = ?',
        [opts.dryRun ? 'DRY_RUN' : 'RUNNING', batchId]);

      await withTransaction(async (conn) => {
        for (const row of rows) {
          const key = naturalKey(row);

          // Idempotency: a key already staged for this company means this exact
          // source line was handled by an earlier run.
          const [seen] = await conn.query<Row[]>(
            'SELECT id FROM migration_source_rows WHERE company_id = ? AND natural_key = ? LIMIT 1',
            [companyId, key]);
          if (seen.length) { counts.duplicate++; continue; }

          const review = row.classification.type === 'REVIEW_REQUIRED';
          let target: { entity: string; id: number } | null = null;

          if (!review && !opts.dryRun && post) {
            target = await post(conn, row);
          }

          const status = review ? 'REVIEW_REQUIRED' : (opts.dryRun ? 'PENDING' : 'IMPORTED');

          const [ins] = await conn.query<WriteResult>(
            `INSERT INTO migration_source_rows
               (company_id, batch_id, source_file, source_sheet, source_row, source_period,
                source_ref, pnr, source_date, source_amount, source_classification,
                service_category, original_party_name, party_type, normalized_party_name,
                target_entity, target_id, status, natural_key, note, raw)
             VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?)`,
            [companyId, batchId, row.sourceFile, row.sourceSheet, row.sourceRow, row.sourcePeriod,
             row.ticketNo ?? null, row.pnr ?? null, row.date ?? null, row.amount ?? null,
             row.sourceClassification ?? null, row.serviceCategory,
             row.party ?? null, row.classification.type, row.classification.name,
             target?.entity ?? null, target?.id ?? null, status, key,
             row.classification.reason ?? null,
             row.raw ? JSON.stringify(row.raw) : null]);

          counts.staged++;
          if (review) {
            counts.review++;
            await conn.query(
              `INSERT INTO migration_review_items
                 (company_id, batch_id, source_row_id, module, issue_type, source_ref, issue, proposed)
               VALUES (?,?,?,?,?,?,?,?)`,
              [companyId, batchId, ins.insertId, 'PARTY', 'AMBIGUOUS_PARTY',
               `${row.sourceFile} · ${row.sourceSheet} · row ${row.sourceRow}`,
               row.classification.reason ?? 'Party could not be classified from the source.',
               row.party ?? null]);
          } else if (target) {
            counts.imported++;
          }
        }
      });

      await exec(
        `UPDATE migration_batches
            SET status = ?, completed_at = NOW(), imported_counts = ?
          WHERE id = ?`,
        [opts.dryRun ? 'DRY_RUN' : 'COMPLETED', JSON.stringify(counts), batchId]);

      return counts;
    } catch (err) {
      // The transaction has already unwound the writes. This records why, so a
      // failed batch is a readable event rather than a silent gap.
      await exec(
        `UPDATE migration_batches
            SET status = 'FAILED', completed_at = NOW(), error_details = ?, imported_counts = ?
          WHERE id = ?`,
        [(err as Error).message.slice(0, 2000), JSON.stringify(counts), batchId]);
      throw err;
    }
  },

  /**
   * Undo a batch completely.
   *
   * Walks the staged rows newest-first and removes what each one created, then
   * the staging rows themselves. Reverse order matters: an invoice deleted
   * before the payment that settles it would trip a foreign key.
   *
   * A VERIFIED month cannot be rolled back here — the CEO approved it, and
   * unwinding approved history is a decision, not a cleanup.
   */
  async rollbackBatch(companyId: number, batchId: number, userId: number) {
    const batch = await this.getBatch(companyId, batchId);
    if (['VERIFIED', 'ACCEPTED_WITH_LIMITATION'].includes(String(batch.status)))
      throw ApiError.conflict(
        'An approved month cannot be rolled back. Reopen it first — that records the reason and keeps '
        + 'the original acceptance in the period approval history.');

    await exec("UPDATE migration_batches SET rollback_status = 'REQUESTED' WHERE id = ?", [batchId]);

    try {
      const removed = await withTransaction(async (conn) => {
        const [targets] = await conn.query<Row[]>(
          `SELECT id, target_entity, target_id FROM migration_source_rows
            WHERE batch_id = ? AND target_id IS NOT NULL
            ORDER BY id DESC`, [batchId]);

        let n = 0;
        for (const t of targets) {
          const entity = String(t.target_entity);
          // Whitelisted rather than interpolated: the table name reaches SQL as
          // an identifier, so it must never come from data.
          if (!['vouchers', 'payments', 'invoices', 'bookings', 'stock_entries'].includes(entity))
            throw new Error(`Refusing to roll back unknown target table "${entity}".`);
          if (entity === 'vouchers')
            await conn.query('DELETE FROM voucher_entries WHERE voucher_id = ?', [t.target_id]);
          await conn.query(`DELETE FROM ${entity} WHERE id = ?`, [t.target_id]);
          n++;
        }
        // A source row records ONE target, but a sale posts TWO vouchers — the
        // sale and the purchase behind it — and only the sale's id comes back.
        // Walking target_id alone therefore left every migrated PURCHASE
        // voucher behind: 435 of them, BDT 17,917,467.16, still on the books
        // after their batch was rolled back and their sale was deleted.
        //
        // The batch stamp is the complete record of what a batch created, so
        // that is what gets cleaned up. This runs after the loop above so the
        // per-entity ordering there still governs invoices and payments.
        const [orphans] = await conn.query<Row[]>(
          'SELECT id FROM vouchers WHERE company_id = ? AND migration_batch_id = ?',
          [companyId, batchId]);
        for (const v of orphans) {
          await conn.query('DELETE FROM voucher_entries WHERE voucher_id = ?', [v.id]);
          await conn.query('DELETE FROM vouchers WHERE id = ?', [v.id]);
          n++;
        }

        await conn.query('DELETE FROM migration_review_items WHERE batch_id = ?', [batchId]);
        await conn.query('DELETE FROM migration_source_rows WHERE batch_id = ?', [batchId]);
        return n;
      });

      await exec(
        `UPDATE migration_batches
            SET status = 'ROLLED_BACK', rollback_status = 'DONE',
                rolled_back_at = NOW(), rolled_back_by = ?
          WHERE id = ?`, [userId, batchId]);
      return { removed };
    } catch (err) {
      await exec(
        "UPDATE migration_batches SET rollback_status = 'FAILED', error_details = ? WHERE id = ?",
        [(err as Error).message.slice(0, 2000), batchId]);
      throw err;
    }
  },

  // ────────────────────────── reconciliation ────────────────────────────────

  /**
   * Source vs migrated, metric by metric.
   *
   * The source value comes from the client's own month-end sheet and is passed
   * in — the engine does not go looking for a number that will make it agree.
   * Where no control figure exists the row is NO_SOURCE, which is honest, not
   * a pass.
   */
  async reconcile(companyId: number, batchId: number, controls: Partial<Record<ReconMetric, {
    sourceValue: number | null; migratedValue: number; note?: string;
  }>>) {
    const batch = await this.getBatch(companyId, batchId);
    let mismatched = 0;

    for (const [metric, v] of Object.entries(controls) as [ReconMetric, {
      sourceValue: number | null; migratedValue: number; note?: string;
    }][]) {
      const status = v.sourceValue == null
        ? 'NO_SOURCE'
        : (Math.abs(v.sourceValue - v.migratedValue) < 0.005 ? 'MATCHED' : 'MISMATCHED');
      if (status === 'MISMATCHED') mismatched++;

      await exec(
        `INSERT INTO migration_reconciliations
           (company_id, batch_id, source_period, metric, source_value, migrated_value, source_note, status)
         VALUES (?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           source_value = VALUES(source_value), migrated_value = VALUES(migrated_value),
           source_note = VALUES(source_note), status = VALUES(status)`,
        [companyId, batchId, batch.source_period, metric,
         v.sourceValue, v.migratedValue, v.note ?? null, status]);
    }

    await exec('UPDATE migration_batches SET reconciliation_status = ? WHERE id = ?',
      [mismatched ? 'MISMATCHED' : 'MATCHED', batchId]);

    return { mismatched };
  },

  reconciliation: (companyId: number, batchId: number) =>
    query<Row[]>(
      'SELECT * FROM migration_reconciliations WHERE company_id = ? AND batch_id = ? ORDER BY metric',
      [companyId, batchId]),

  // ───────────────────────── month finalisation ─────────────────────────────

  /**
   * The CEO closes a month.
   *
   * Approval is allowed with review items still open — the client asked for
   * that explicitly — but then the reason is mandatory and the count of what
   * was left open is stored on the batch, so "approved with 14 unresolved" is
   * a fact on the record rather than something a later reader has to
   * reconstruct.
   */
  /**
   * The CEO closes ONE period.
   *
   * Two outcomes, never conflated:
   *
   *   VERIFIED_MIGRATED                    the period reconciles and is signed off
   *   ACCEPTED_HISTORICAL_DATA_LIMITATION  the period does NOT reconcile, and the
   *                                        CEO has read why and accepts it
   *
   * The second is not a weaker version of the first. `data_completeness` stays
   * INCOMPLETE and `reconciliation_status` stays MISMATCHED afterwards, and the
   * batch status reads ACCEPTED_WITH_LIMITATION rather than VERIFIED — because
   * "I accept this limitation" must never be readable as "the figures agree".
   *
   * Everything the CEO was looking at is snapshotted into
   * `migration_period_approvals` at the moment of acceptance: source and
   * migrated receivable and payable, the differences, the completeness note and
   * the open review counts. A later re-post rewrites `migration_reconciliations`,
   * and the question "what did the CEO actually sign off?" must survive that.
   *
   * One call, one batch. There is no bulk path, and approving a period cannot
   * touch any other.
   */
  async finalizeMonth(companyId: number, batchId: number, ceoId: number, reason: string, comment = '') {
    const batch = await this.getBatch(companyId, batchId);
    if (batch.status !== 'COMPLETED')
      throw ApiError.badRequest(`Only a completed batch can be approved; this one is ${batch.status}.`);

    const [open] = await query<Row[]>(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(is_material = 1),0) AS material,
              ROUND(COALESCE(SUM(IF(is_material = 1, ABS(COALESCE(impact_amount,0)), 0)),0),2) AS material_amount
         FROM migration_review_items WHERE batch_id = ? AND status = 'OPEN'`,
      [batchId]);
    const unresolved = asNumber(open?.n);

    const incomplete = batch.data_completeness === 'INCOMPLETE';
    if ((unresolved > 0 || incomplete) && !reason?.trim())
      throw ApiError.badRequest(
        `${unresolved} REVIEW_REQUIRED item(s) are still open or the period is incomplete. `
        + 'Approval needs a written reason.');
    if (incomplete && !comment?.trim())
      throw ApiError.badRequest('Accepting an incomplete historical period requires a written comment.');

    const outcome = incomplete ? 'ACCEPTED_HISTORICAL_DATA_LIMITATION' : 'VERIFIED_MIGRATED';

    // The reconciliation as it stands right now — the figures being accepted.
    const recon = await query<Row[]>(
      `SELECT metric, source_value, migrated_value, difference
         FROM migration_reconciliations WHERE batch_id = ?`, [batchId]);
    const pick = (metric: string) => recon.find((r) => r.metric === metric);
    const ar = pick('CUSTOMER_OUTSTANDING');
    const ap = pick('VENDOR_PAYABLE');

    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE migration_batches
            SET status = ?, ceo_approval_status = 'APPROVED', approval_outcome = ?,
                approved_by = ?, approved_at = NOW(), approval_reason = ?, approval_comment = ?,
                unresolved_at_approval = ?
          WHERE id = ?`,
        [incomplete ? 'ACCEPTED_WITH_LIMITATION' : 'VERIFIED', outcome, ceoId,
         reason?.trim() || null, comment?.trim() || null, unresolved, batchId]);

      // Append-only. A reopening later adds a row; it never rewrites this one.
      await conn.query(
        `INSERT INTO migration_period_approvals
           (company_id, batch_id, source_period, action, reason, comment,
            data_completeness, reconciliation_status, completeness_note,
            source_receivable, migrated_receivable, receivable_difference,
            source_payable, migrated_payable, payable_difference,
            open_review_items, material_review_items, material_review_amount, actor_id)
         VALUES (?,?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?, ?,?,?,?)`,
        [companyId, batchId, batch.source_period, outcome, reason?.trim() || '', comment?.trim() || null,
         batch.data_completeness, batch.reconciliation_status, batch.completeness_note ?? null,
         ar?.source_value ?? null, ar?.migrated_value ?? null, ar?.difference ?? null,
         ap?.source_value ?? null, ap?.migrated_value ?? null, ap?.difference ?? null,
         unresolved, asNumber(open?.material), asNumber(open?.material_amount), ceoId]);
    });

    return { approved: true, outcome, unresolved, dataCompleteness: batch.data_completeness };
  },

  /**
   * Reopen an approved period because authoritative source data turned up.
   *
   * The previous acceptance is NOT overwritten — it stays in
   * `migration_period_approvals` with the figures it was given, and this adds a
   * REOPENED row beside it. The batch returns to COMPLETED so the normal
   * audited rollback-and-re-post path can run, after which the CEO approves it
   * again and the history shows both decisions in order.
   */
  async reopenPeriod(companyId: number, batchId: number, actorId: number, reason: string) {
    if (!reason?.trim())
      throw ApiError.badRequest('Reopening an approved historical period requires a written reason.');
    const batch = await this.getBatch(companyId, batchId);
    if (!['VERIFIED', 'ACCEPTED_WITH_LIMITATION'].includes(String(batch.status)))
      throw ApiError.badRequest(`Only an approved period can be reopened; this one is ${batch.status}.`);

    await withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO migration_period_approvals
           (company_id, batch_id, source_period, action, reason, comment,
            data_completeness, reconciliation_status, completeness_note,
            open_review_items, material_review_items, material_review_amount, actor_id)
         VALUES (?,?,?,'REOPENED',?,NULL, ?,?,?, 0,0,0.00, ?)`,
        [companyId, batchId, batch.source_period, reason.trim(),
         batch.data_completeness, batch.reconciliation_status, batch.completeness_note ?? null, actorId]);

      await conn.query(
        `UPDATE migration_batches
            SET status = 'COMPLETED', ceo_approval_status = 'NOT_REQUESTED',
                approval_outcome = 'PENDING',
                reopened_at = NOW(), reopened_by = ?, reopen_reason = ?
          WHERE id = ?`,
        [actorId, reason.trim(), batchId]);
    });

    return { reopened: true, period: batch.source_period };
  },

  /** Every approval and reopening a period has ever had, oldest first. */
  periodApprovalHistory: (companyId: number, period: string) =>
    query<Row[]>(
      `SELECT a.*, u.name AS actor_name
         FROM migration_period_approvals a JOIN users u ON u.id = a.actor_id
        WHERE a.company_id = ? AND a.source_period = ?
        ORDER BY a.id`, [companyId, period]),

  /** Verified months are read-only by default; this is what the guards ask. */
  async isPeriodLocked(companyId: number, period: string): Promise<boolean> {
    const rows = await query<Row[]>(
      `SELECT id FROM migration_batches
        WHERE company_id = ? AND source_period = ?
          AND status IN ('VERIFIED','ACCEPTED_WITH_LIMITATION') LIMIT 1`,
      [companyId, period]);
    return rows.length > 0;
  },

  // ─────────────────────────── review queue ─────────────────────────────────

  listReviewItems: (companyId: number, filter: { status?: string; module?: string; batchId?: number }) => {
    const where: string[] = ['company_id = ?'];
    const params: unknown[] = [companyId];
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter.module) { where.push('module = ?'); params.push(filter.module); }
    if (filter.batchId) { where.push('batch_id = ?'); params.push(filter.batchId); }
    return query<Row[]>(
      `SELECT * FROM migration_review_items WHERE ${where.join(' AND ')}
        ORDER BY status = 'OPEN' DESC, id DESC LIMIT 500`, params);
  },

  async resolveReviewItem(companyId: number, itemId: number, userId: number, input: {
    status: 'RESOLVED' | 'ACCEPTED_AS_IS' | 'WONT_FIX'; resolution: string;
    resolutionCode?: 'CONFIRMED_DUPLICATE' | 'CLEARED_NOT_DUPLICATE' | 'PARTY_RECLASSIFIED'; notes?: string;
  }) {
    if (!input.resolution?.trim())
      throw ApiError.badRequest('A resolution note is required — a review item cannot be closed silently.');

    const res = await exec(
      `UPDATE migration_review_items
          SET status = ?, resolution = ?, resolution_code = ?, notes = ?, resolved_by = ?, resolved_at = NOW()
        WHERE company_id = ? AND id = ? AND status = 'OPEN'`,
      [input.status, input.resolution.trim(), input.resolutionCode ?? null,
       input.notes ?? null, userId, companyId, itemId]);

    if (!res.affectedRows)
      throw ApiError.notFound('Review item not found, or it is already resolved.');
    return { resolved: true };
  },

  async addReviewItem(companyId: number, input: {
    batchId?: number | null; sourceRowId?: number | null; module: string;
    issueType: string; sourceRef?: string | null; issue: string; proposed?: string | null;
  }) {
    const res = await exec(
      `INSERT INTO migration_review_items
         (company_id, batch_id, source_row_id, module, issue_type, source_ref, issue, proposed)
       VALUES (?,?,?,?,?,?,?,?)`,
      [companyId, input.batchId ?? null, input.sourceRowId ?? null, input.module,
       input.issueType, input.sourceRef ?? null, input.issue, input.proposed ?? null]);
    return { id: res.insertId };
  },

  // ─────────────────── traceability and PNR grouping ────────────────────────

  sourceRows: (companyId: number, filter: { batchId?: number; pnr?: string; targetId?: number }) => {
    const where: string[] = ['company_id = ?'];
    const params: unknown[] = [companyId];
    if (filter.batchId) { where.push('batch_id = ?'); params.push(filter.batchId); }
    if (filter.pnr) { where.push('pnr = ?'); params.push(filter.pnr); }
    if (filter.targetId) { where.push('target_id = ?'); params.push(filter.targetId); }
    return query<Row[]>(
      `SELECT * FROM migration_source_rows WHERE ${where.join(' AND ')} ORDER BY source_row LIMIT 500`,
      params);
  },

  /**
   * Decision 1's report: every cost parked on the unknown-supplier clearing
   * account, with the evidence needed to identify the real supplier later.
   *
   * The ORIGINAL issuing-agency value comes back alongside the row, because
   * knowing the cell was blank rather than unreadable is part of the trail.
   */
  unknownSupplierRows: (companyId: number) =>
    query<Row[]>(
      `SELECT r.source_period, r.source_date, r.pnr, r.source_ref AS ticket,
              r.normalized_party_name AS customer, r.clearing_amount AS cost,
              -- The issuing-agency cell as it stood in the sheet. Read from the
              -- raw row rather than original_party_name, which holds the party
              -- ON the row (the client) and would misreport a blank agency as a
              -- supplier called after the customer.
              JSON_UNQUOTE(JSON_EXTRACT(r.raw, '$."issueing  Agency"')) AS original_issuing_agency,
              r.original_party_name AS party_on_row,
              r.source_file, r.source_sheet, r.source_row,
              i.status AS review_status, i.is_material
         FROM migration_source_rows r
    LEFT JOIN migration_review_items i ON i.source_row_id = r.id
        WHERE r.company_id = ? AND r.clearing_category = 'UNKNOWN_HISTORICAL_TICKET_SUPPLIER'
        ORDER BY r.source_period, r.source_date, r.source_row`, [companyId]),

  unknownSupplierTotal: async (companyId: number) => {
    const rows = await query<Row[]>(
      `SELECT COUNT(*) n, ROUND(SUM(COALESCE(clearing_amount,0)),2) total
         FROM migration_source_rows
        WHERE company_id = ? AND clearing_category = 'UNKNOWN_HISTORICAL_TICKET_SUPPLIER'`,
      [companyId]);
    return { rows: Number(rows[0]?.n ?? 0), total: Number(rows[0]?.total ?? 0) };
  },

  /** Decision 2's report: every payment whose narration did not classify. */
  unclassifiedExpenseRows: (companyId: number) =>
    query<Row[]>(
      `SELECT r.source_period, r.source_date, r.clearing_amount AS amount,
              r.original_party_name AS original_narration,
              r.source_file, r.source_sheet, r.source_row,
              i.status AS review_status, i.is_material, i.issue AS detail
         FROM migration_source_rows r
    LEFT JOIN migration_review_items i ON i.source_row_id = r.id
        WHERE r.company_id = ? AND r.clearing_category = 'UNCLASSIFIED_HISTORICAL_EXPENSE'
        ORDER BY ABS(r.clearing_amount) DESC`, [companyId]),

  /** Decision 5: the queue, triaged to what materially moves the books. */
  materialReviewItems: (companyId: number, filter: {
    onlyMaterial?: boolean; status?: string; issueType?: string; period?: string;
    search?: string; limit?: number; offset?: number;
  } = {}) => {
    const where = ['i.company_id = ?'];
    const params: unknown[] = [companyId];
    if (filter.onlyMaterial !== false) where.push('i.is_material = 1');
    if (filter.status) { where.push('i.status = ?'); params.push(filter.status); }
    if (filter.issueType) { where.push('i.issue_type = ?'); params.push(filter.issueType); }
    if (filter.period) { where.push('r.source_period = ?'); params.push(filter.period); }
    if (filter.search) {
      where.push('(i.source_ref LIKE ? OR i.issue LIKE ? OR r.pnr LIKE ? OR r.original_party_name LIKE ?)');
      const q = `%${filter.search}%`; params.push(q, q, q, q);
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    return query<Row[]>(
      `SELECT i.*, r.source_period, r.source_date, r.source_file, r.source_sheet, r.source_row,
              r.source_ref AS ticket, r.pnr, r.source_amount, r.original_party_name,
              r.normalized_party_name, r.clearing_category, r.clearing_amount,
              (SELECT COUNT(*) FROM historical_review_actions a WHERE a.review_item_id=i.id) action_count
         FROM migration_review_items i
    LEFT JOIN migration_source_rows r ON r.id = i.source_row_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.status='OPEN' DESC, ABS(COALESCE(i.impact_amount,0)) DESC, i.id
        LIMIT ${limit} OFFSET ${offset}`, params);
  },

  materialReviewSummary: (companyId: number) => query<Row[]>(
    `SELECT i.issue_type, i.status, COUNT(*) AS rows_n,
            ROUND(SUM(ABS(COALESCE(i.impact_amount,0))),2) AS amount
       FROM migration_review_items i
      WHERE i.company_id=? AND i.is_material=1
      GROUP BY i.issue_type, i.status ORDER BY amount DESC`, [companyId]),

  reviewItemDetail: async (companyId: number, itemId: number) => {
    const rows = await query<Row[]>(
      `SELECT i.*, r.source_period, r.source_date, r.source_file, r.source_sheet, r.source_row,
              r.source_ref AS ticket, r.pnr, r.source_amount, r.original_party_name,
              r.normalized_party_name, r.clearing_category, r.clearing_amount, r.raw
         FROM migration_review_items i LEFT JOIN migration_source_rows r ON r.id=i.source_row_id
        WHERE i.company_id=? AND i.id=?`, [companyId, itemId]);
    if (!rows[0]) throw ApiError.notFound('Review item not found.');
    const actions = await query<Row[]>(
      `SELECT a.*, u.name AS actor_name FROM historical_review_actions a
       JOIN users u ON u.id=a.actor_id WHERE a.company_id=? AND a.review_item_id=? ORDER BY a.id`,
      [companyId, itemId]);
    return { item: rows[0], actions };
  },

  async recordReviewDecision(companyId: number, itemId: number, userId: number, input: {
    actionCode: 'CLEARED_NOT_DUPLICATE' | 'CONFIRMED_DUPLICATE' | 'NEEDS_MORE_EVIDENCE';
    evidence: string; ruleCode?: string;
  }) {
    if (input.evidence.trim().length < 10)
      throw ApiError.badRequest('Evidence must explain the decision in at least 10 characters.');
    return withTransaction(async (conn) => {
      const [items] = await conn.query<Row[]>(
        'SELECT status, issue_type FROM migration_review_items WHERE company_id=? AND id=? FOR UPDATE',
        [companyId, itemId]);
      const item = items[0];
      if (!item || item.status !== 'OPEN') throw ApiError.notFound('Open review item not found.');
      if (input.actionCode !== 'NEEDS_MORE_EVIDENCE' && item.issue_type !== 'POSSIBLE_DUPLICATE')
        throw ApiError.badRequest('Duplicate decisions can only be applied to possible-duplicate items.');
      const resulting = input.actionCode === 'NEEDS_MORE_EVIDENCE' ? 'OPEN' : 'RESOLVED';
      if (resulting === 'RESOLVED') {
        await conn.query(
          `UPDATE migration_review_items SET status='RESOLVED', resolution=?, resolution_code=?,
                  resolved_by=?, resolved_at=NOW() WHERE company_id=? AND id=?`,
          [input.evidence.trim(), input.actionCode, userId, companyId, itemId]);
      }
      await conn.query(
        `INSERT INTO historical_review_actions
          (company_id,review_item_id,action_code,prior_status,resulting_status,evidence,rule_code,actor_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [companyId,itemId,input.actionCode,item.status,resulting,input.evidence.trim(),input.ruleCode ?? null,userId]);
      return { action: input.actionCode, status: resulting };
    });
  },

  /**
   * CEO acceptance of an unresolved historical limitation.
   *
   * A THIRD state, not a resolution: the item stays, its evidence stays, and it
   * reads as "accepted as an unresolved historical limitation" rather than
   * "problem resolved". New evidence can still reopen it later.
   */
  async ceoAcceptReviewItem(companyId: number, itemId: number, ceoId: number, reason: string) {
    if (!reason?.trim())
      throw ApiError.badRequest('CEO acceptance of an unresolved item requires a written reason.');
    const res = await exec(
      `UPDATE migration_review_items
          SET status = 'CEO_ACCEPTED', ceo_accepted_by = ?, ceo_accepted_at = NOW(),
              ceo_accept_reason = ?
        WHERE company_id = ? AND id = ? AND status = 'OPEN'`,
      [ceoId, reason.trim(), companyId, itemId]);
    if (!res.affectedRows) throw ApiError.notFound('Review item not found, or it is not open.');
    return { accepted: true };
  },

  /** Why the unexplained balance exists — by category and by period. */
  clearingBreakdown: (companyId: number) =>
    query<Row[]>(
      `SELECT clearing_category AS category, source_period AS period,
              COUNT(*) AS rows_n, ROUND(SUM(COALESCE(clearing_amount,0)),2) AS amount
         FROM migration_source_rows
        WHERE company_id = ? AND clearing_category IS NOT NULL
        GROUP BY clearing_category, source_period
        ORDER BY clearing_category, source_period`, [companyId]),

  /** One row per real historical period; idempotency-only no-op batches are excluded. */
  periodReadiness: (companyId: number) =>
    query<Row[]>(
      `SELECT b.id, b.source_period, b.accounting_integrity, b.reconciliation_status,
              b.data_completeness, b.completeness_note, b.ceo_approval_status,
              b.approval_outcome, b.approved_by, b.approved_at, b.approval_reason,
              b.approval_comment,
              SUM(i.status='OPEN') AS review_count,
              SUM(i.status='OPEN' AND i.is_material=1) AS material_review_count
         FROM migration_batches b
    LEFT JOIN migration_review_items i ON i.batch_id=b.id
        WHERE b.company_id=? AND b.status NOT IN ('DRY_RUN','ROLLED_BACK','FAILED')
          AND NOT (JSON_EXTRACT(b.imported_counts,'$.posted')=0
                   AND JSON_EXTRACT(b.imported_counts,'$.skippedAlreadyStaged')>0)
        GROUP BY b.id ORDER BY b.source_period`, [companyId]),

  duplicateReport: (companyId: number) =>
    query<Row[]>(
      `SELECT CASE
                WHEN i.issue_type='POSSIBLE_DUPLICATE' AND i.status='OPEN' THEN 'POSSIBLE_DUPLICATE'
                WHEN i.resolution_code='CONFIRMED_DUPLICATE' THEN 'CONFIRMED_DUPLICATE'
                WHEN i.resolution_code='CLEARED_NOT_DUPLICATE' THEN 'CLEARED_NOT_DUPLICATE'
              END AS duplicate_status,
              COUNT(*) AS rows_n, ROUND(SUM(COALESCE(i.impact_amount,0)),2) AS amount
         FROM migration_review_items i
        WHERE i.company_id=? AND (i.issue_type='POSSIBLE_DUPLICATE'
           OR i.resolution_code IN ('CONFIRMED_DUPLICATE','CLEARED_NOT_DUPLICATE'))
        GROUP BY duplicate_status
        UNION ALL
       SELECT 'CONFIRMED_DUPLICATE', COUNT(*), ROUND(SUM(COALESCE(r.source_amount,0)),2)
         FROM migration_source_rows r
        WHERE r.company_id=? AND r.status='SKIPPED_DUPLICATE'`, [companyId, companyId]),

  /**
   * The audited last resort for an unexplained outstanding difference.
   *
   * Everything the client demanded is a NOT NULL column, so there is no way to
   * write one of these without saying what was searched, what the authoritative
   * file said, what the books computed, and who accepted the gap.
   */
  async recordOutstandingAdjustment(companyId: number, approverId: number, input: {
    batchId: number; partyType: 'CUSTOMER' | 'SUPPLIER'; partyId: number;
    controlAmount: number; calculatedAmount: number; controlSource: string;
    investigation: string; reason: string; voucherId?: number | null;
  }) {
    if (!input.investigation?.trim())
      throw ApiError.badRequest('Record what was searched before accepting a difference.');
    if (!input.reason?.trim())
      throw ApiError.badRequest('A reason is required for an outstanding adjustment.');

    const res = await exec(
      `INSERT INTO historical_outstanding_adjustments
         (company_id, batch_id, party_type, party_id, control_amount, calculated_amount,
          control_source, investigation, reason, voucher_id, approved_by, approved_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [companyId, input.batchId, input.partyType, input.partyId,
       input.controlAmount, input.calculatedAmount, input.controlSource,
       input.investigation.trim(), input.reason.trim(), input.voucherId ?? null, approverId]);
    return { id: res.insertId };
  },
};
