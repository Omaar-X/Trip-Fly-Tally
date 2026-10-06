import { PoolConnection } from 'mysql2/promise';
import { query, exec, withTransaction, Row, WriteResult } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { nextRequestNo } from '../../utils/numbering';
import { migrationService, ReconMetric } from './migration.service';
import { makeContext, postRow } from './poster';
import {
  NormalizedRow, ParseResult, defaultDataDir, parsePeriod, rowFingerprint,
} from './parser';
import { findWorkbookWithSheet, readSheet, ensureExtracted } from './parser/workbook';
import { parseAccountsControl, ControlValues } from './parser/accountsControl';
import { findPeriod } from './parser/sources';
import {
  INCOMPLETE_PERIODS, MISSING_SALES_SOURCE_PERIODS, REVIEW_REASON, isMaterial,
} from './expenseRules';

/**
 * ====================== ONE MONTH, START TO FINISH ==========================
 *
 * parse → stage → post → reconcile, inside one batch, atomically.
 *
 * The order matters and is not negotiable: every row is STAGED before any row
 * is POSTED. Staging is what makes row accountability provable — the count of
 * source rows and what became of each is written down before the accounting
 * starts, so a failure halfway cannot leave a month where nobody can say what
 * was seen.
 *
 * A dry run does everything except post. It is the default first pass and the
 * only thing anyone should run against a database they care about.
 */

export interface RunOptions {
  companyId: number;
  userId: number;
  dryRun: boolean;
  dataDir?: string;
  snapshotRef?: string;
}

export interface RunSummary {
  period: string;
  batchId: number;
  batchNo: string;
  dryRun: boolean;
  parse: ParseResult['stats'];
  posted: number;
  postFailed: number;
  reviewItems: number;
  skippedAlreadyStaged: number;
  /** D006 · cumulative-sheet repeats staged with lineage but not posted. */
  cumulativeDuplicates: number;
  files: ParseResult['files'];
  control?: ControlValues | null;
  reconciliation?: { metric: ReconMetric; source: number | null; migrated: number; status: string }[];
}

/**
 * ============ CUMULATIVE DAY-BOOK SHEETS (D006) ============================
 *
 * The day-book workbooks are cumulative: `Daily Statement NOV'24` carries 179
 * October-dated rows, `Daily Statement OCT'24` carries 80 November-dated ones,
 * and `JUN-25` repeats 80 May-2025 rows. Because `natural_key` includes the
 * sheet name, the same transaction arriving from two sheets never collided —
 * and posted twice. That was BDT 39,167,396.76 of double-counted history
 * across 341 pairs, including the BDT 1,800,000 that made the CEO loan look
 * like 3,609,000 instead of 1,809,000.
 *
 * The rule that fixes it: **a transaction belongs to the accounting period of
 * its own transaction date**, not to the month named on the sheet tab it was
 * copied into.
 *
 * The suppression is deliberately narrow. It fires only when BOTH hold:
 *
 *   1. the row's own date falls OUTSIDE the period being posted — so it is a
 *      carry-over line in a cumulative sheet, not ordinary data; and
 *   2. an identical transaction genuinely exists in the source for the month
 *      its date belongs to.
 *
 * That second test is made against the other month's PARSED SOURCE, not
 * against the database, so the verdict does not depend on which period ran
 * first and a re-run cannot reach a different answer.
 *
 * What it is NOT: a global de-duplicator. Two genuinely different transactions
 * that happen to share a date, an amount and a party are never merged, because
 * suppression cannot fire on a row whose date is inside its own period. The
 * suppressed row is never deleted either — it is staged with full lineage and
 * the reason CUMULATIVE_SHEET_DUPLICATE_NOT_POSTED, so both sheets remain
 * visible as evidence.
 */
export const CUMULATIVE_DUPLICATE_REASON = 'CUMULATIVE_SHEET_DUPLICATE_NOT_POSTED';

const monthOf = (date?: string | null): string | null =>
  (date && date.length >= 7 ? date.slice(0, 7) : null);

/**
 * What makes two source lines the same transaction.
 *
 * Amount, date, party, kind and — for a day-book line that produces both a
 * receipt and a payment — which side of the row this is. Deliberately not the
 * sheet or the row number: those are exactly what differ between a cumulative
 * copy and its original.
 */
export const transactionIdentity = (row: NormalizedRow): string => [
  row.date ?? '',
  String(row.sellingAmount ?? row.receivedAmount ?? row.costAmount ?? ''),
  (row.customerText ?? row.vendorText ?? '').trim().toUpperCase().replace(/\s+/g, ' '),
  row.kind ?? '',
  (row.raw as { __side?: string }).__side ?? '',
].join('|');

/**
 * For every foreign month referenced by an out-of-period row in this batch,
 * the set of transaction identities that month's own source actually contains.
 *
 * Parsed once per foreign month and cached for the run. A month with no
 * catalogue entry contributes nothing, which means its rows are posted rather
 * than suppressed — silence is not evidence of a twin.
 */
async function foreignMonthIdentities(
  rows: NormalizedRow[], period: string, dataDir: string,
): Promise<Map<string, Set<string>>> {
  const wanted = new Set<string>();
  for (const row of rows) {
    const month = monthOf(row.date);
    if (row.outcome === 'FINANCIAL' && month && month !== period) wanted.add(month);
  }

  const out = new Map<string, Set<string>>();
  for (const month of wanted) {
    if (!findPeriod(month)) continue;
    const parsed = await parsePeriod(month, { dataDir });
    out.set(month, new Set(
      parsed.rows
        .filter((r) => r.outcome === 'FINANCIAL' && monthOf(r.date) === month)
        .map(transactionIdentity)));
  }
  return out;
}

/**
 * Is this row a cumulative-sheet repeat that must not post a second time?
 *
 * Exported because it is the whole of D006's judgement, and it is worth being
 * able to prove in a test that it says no to the cases it must never suppress.
 */
export function isCumulativeSheetRepeat(
  row: NormalizedRow, period: string, foreign: Map<string, Set<string>>,
): boolean {
  if (row.outcome !== 'FINANCIAL') return false;
  const month = monthOf(row.date);
  // A row inside its own period is ordinary data. Two genuinely different
  // transactions sharing a date, an amount and a party are both kept, because
  // this test can never reach them.
  if (month === null || month === period) return false;
  return foreign.get(month)?.has(transactionIdentity(row)) ?? false;
}

/** Reads the month-end control sheet, which is never a posting source. */
export async function loadControl(period: string, dataDir: string): Promise<ControlValues | null> {
  const sources = findPeriod(period);
  if (!sources?.accounts) return null;
  const root = await ensureExtracted(dataDir);
  const path = await findWorkbookWithSheet(root, sources.accounts.file, sources.accounts.sheet);
  if (!path) return null;
  const sheet = await readSheet(path, sources.accounts.sheet);
  if (!sheet) return null;
  return parseAccountsControl(sheet.rows, `${sources.accounts.file} · ${sources.accounts.sheet}`);
}

/**
 * Run one period.
 *
 * Everything happens in a single transaction. A failure anywhere unwinds the
 * whole month rather than leaving it half-imported — which is the difference
 * between a migration you can re-run and one you have to unpick by hand.
 */
export async function runPeriod(period: string, opts: RunOptions): Promise<RunSummary> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const parsed = await parsePeriod(period, { dataDir });
  const control = await loadControl(period, dataDir);

  // The batch row is created outside the main transaction so that a failure
  // still leaves a batch to attach the error to.
  const batch = await withTransaction(async (conn) => {
    const batchNo = await nextRequestNo(conn, opts.companyId, 'MIG');
    const [res] = await conn.query<WriteResult>(
      `INSERT INTO migration_batches
         (company_id, batch_no, source_period, description, status, snapshot_ref,
          snapshot_taken_at, started_at, created_by)
       VALUES (?,?,?,?,?,?,?,NOW(),?)`,
      [opts.companyId, batchNo, period,
       `${opts.dryRun ? 'Dry run' : 'Migration'} — ${parsed.files.map((f) => f.sheet).join(', ')}`,
       opts.dryRun ? 'DRY_RUN' : 'RUNNING',
       opts.snapshotRef ?? null, opts.snapshotRef ? new Date() : null, opts.userId]);
    return { id: res.insertId, batchNo };
  });

  const summary: RunSummary = {
    period, batchId: batch.id, batchNo: batch.batchNo, dryRun: opts.dryRun,
    parse: parsed.stats, posted: 0, postFailed: 0, reviewItems: 0,
    skippedAlreadyStaged: 0, cumulativeDuplicates: 0, files: parsed.files, control,
  };

  // Parsed before the transaction opens: it reads other months' workbooks and
  // has nothing to do with this batch's writes.
  const foreignIdentities = await foreignMonthIdentities(parsed.rows, period, dataDir);

  try {
    await withTransaction(async (conn) => {
      // A real post clears out the rehearsal.
      //
      // Dry-run rows are kept after the dry run so the operator can inspect
      // exactly what would have happened — that is most of the point of a dry
      // run. But `natural_key` is unique per company, so those rehearsal rows
      // would collide with the real ones. They are dropped here, at the moment
      // the real post for this period begins, which is the last point at which
      // anyone could still want to read them.
      if (!opts.dryRun) {
        await conn.query(
          `DELETE r FROM migration_source_rows r
             JOIN migration_batches b ON b.id = r.batch_id
            WHERE r.company_id = ? AND r.source_period = ?
              AND b.status IN ('DRY_RUN','ROLLED_BACK','FAILED')`,
          [opts.companyId, period]);
      }

      const ctx = await makeContext(conn, opts.companyId, opts.userId, batch.id, opts.dryRun);

      for (const row of parsed.rows) {
        const key = rowFingerprint(row);

        // Idempotency: this exact source line has already been handled by an
        // earlier batch, so it is skipped rather than posted a second time.
        //
        // A DRY_RUN batch is a rehearsal and does not count — otherwise the
        // dry run everyone is told to do first would consume the fingerprints
        // and the real post would silently import nothing. Same for a batch
        // that has been rolled back: its rows are gone from the books, so the
        // source lines are unimported again.
        const [seen] = await conn.query<Row[]>(
          `SELECT r.id FROM migration_source_rows r
             JOIN migration_batches b ON b.id = r.batch_id
            WHERE r.company_id = ? AND r.natural_key = ?
              AND b.status NOT IN ('DRY_RUN','ROLLED_BACK','FAILED')
            LIMIT 1`,
          [opts.companyId, key]);
        if (seen.length) { summary.skippedAlreadyStaged++; continue; }

        // D006 · a transaction belongs to the period of its own date. A
        // carry-over line whose twin genuinely exists in that month's own
        // source is staged with full lineage and NOT posted a second time.
        const rowMonth = monthOf(row.date);
        if (isCumulativeSheetRepeat(row, period, foreignIdentities)) {
          await conn.query(
            `INSERT INTO migration_source_rows
               (company_id, batch_id, source_file, source_sheet, source_row, source_period,
                source_ref, pnr, source_date, source_amount, source_classification,
                service_category, original_party_name, party_type, normalized_party_name,
                target_entity, target_id, status, clearing_category, clearing_amount,
                natural_key, note, raw)
             VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, NULL,NULL,'SKIPPED_CUMULATIVE_DUPLICATE',
                     NULL,NULL,?,?,?)`,
            [opts.companyId, batch.id, row.source.file, row.source.sheet, row.source.row, period,
             row.ticketNo ?? null, row.pnr ?? null, row.date ?? null,
             row.sellingAmount ?? row.receivedAmount ?? row.costAmount ?? null,
             row.expenseCategorySource ?? null, row.serviceCategory ?? 'REVIEW_REQUIRED',
             row.customerText ?? row.vendorText ?? null, partyTypeOf(row),
             row.customer ?? row.vendor ?? null, key,
             `${CUMULATIVE_DUPLICATE_REASON}: dated ${row.date}, which belongs to ${rowMonth}, and an `
             + `identical transaction exists in that month's own source. This sheet is cumulative, so the `
             + 'line is a repeat rather than a second transaction. Lineage kept; no voucher created.',
             JSON.stringify({ ...row.raw, __parser: parsed.parserVersion, __archive: row.source.archive })]);
          summary.cumulativeDuplicates++;
          continue;
        }

        let target: { entity: string; id: number } | null = null;
        let clearing: { category: string; amount: number } | undefined;
        let reviewCategory = row.reviewCategory ?? null;
        let reviewReason = row.reason ?? null;
        let status: string = statusOf(row);

        if (row.outcome === 'FINANCIAL' && !opts.dryRun) {
          const result = await postRow(conn, ctx, row);
          if (result.posted && result.id) {
            target = { entity: result.entity!, id: result.id };
            summary.posted++;
            // A row can post AND still need a look — a payment that landed in
            // suspense is in the books and unclassified at the same time.
            if (result.review) {
              reviewCategory = result.review.category ?? 'OTHER';
              reviewReason = result.review.reason;
            }
            if (result.clearing) clearing = result.clearing;
          } else {
            summary.postFailed++;
            status = 'REVIEW_REQUIRED';
            reviewCategory = result.review?.category ?? 'MISSING_ACCOUNTING_TREATMENT';
            reviewReason = result.review?.reason ?? 'The poster had no rule for this row.';
          }
        }

        const [ins] = await conn.query<WriteResult>(
          `INSERT INTO migration_source_rows
             (company_id, batch_id, source_file, source_sheet, source_row, source_period,
              source_ref, pnr, source_date, source_amount, source_classification,
              service_category, original_party_name, party_type, normalized_party_name,
              target_entity, target_id, status, clearing_category, clearing_amount,
              natural_key, note, raw)
           VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?,?,?)`,
          [opts.companyId, batch.id, row.source.file, row.source.sheet, row.source.row, period,
           row.ticketNo ?? null, row.pnr ?? null, row.date ?? null,
           row.sellingAmount ?? row.receivedAmount ?? row.costAmount ?? null,
           row.expenseCategorySource ?? null,
           row.serviceCategory ?? 'REVIEW_REQUIRED',
           row.customerText ?? row.vendorText ?? null,
           partyTypeOf(row), row.customer ?? row.vendor ?? null,
           target?.entity ?? null, target?.id ?? null, status,
           clearing?.category ?? null, clearing?.amount ?? null, key,
           (reviewReason ?? row.reason ?? null)?.slice(0, 500) ?? null,
           JSON.stringify({ ...row.raw, __parser: parsed.parserVersion, __archive: row.source.archive })]);

        if (status === 'REVIEW_REQUIRED' || (reviewReason && row.outcome === 'FINANCIAL' && reviewCategory)) {
          // Decision 5: the queue is triaged, not merely counted. An item is
          // material when it moves cash, a party balance, sales, cost, profit,
          // capital, fixed assets or a loan — or when an unclassified amount is
          // big enough to matter.
          const issueType = clearing?.category ?? reviewCategory ?? 'OTHER';
          const impact = clearing?.amount
            ?? row.sellingAmount ?? row.receivedAmount ?? row.costAmount ?? null;

          await conn.query(
            `INSERT INTO migration_review_items
               (company_id, batch_id, source_row_id, module, issue_type, is_material,
                impact_amount, source_ref, issue, proposed)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [opts.companyId, batch.id, ins.insertId, moduleOf(row),
             issueType, isMaterial(issueType, impact) ? 1 : 0, impact,
             `${row.source.file} · ${row.source.sheet} · row ${row.source.row}`,
             (reviewReason ?? 'Could not be interpreted from the source.').slice(0, 1000),
             row.customerText ?? row.vendorText ?? null]);
          summary.reviewItems++;
        }

        // A sale can have two independent unresolved dimensions: the party is
        // ambiguous and the supplier is missing. PostOutcome carries one
        // primary clearing category, so preserve the party question as a
        // second review item when the supplier question took that slot.
        if (row.kind === 'SALE' && !row.customer
            && clearing?.category !== REVIEW_REASON.AMBIGUOUS_PARTY) {
          const impact = row.sellingAmount ?? null;
          await conn.query(
            `INSERT INTO migration_review_items
               (company_id,batch_id,source_row_id,module,issue_type,is_material,
                impact_amount,source_ref,issue,proposed)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [opts.companyId, batch.id, ins.insertId, 'SALES', REVIEW_REASON.AMBIGUOUS_PARTY,
             isMaterial(REVIEW_REASON.AMBIGUOUS_PARTY, impact) ? 1 : 0, impact,
             `${row.source.file} · ${row.source.sheet} · row ${row.source.row}`,
             (row.reason ?? `Historical sale has no reliably identified party.`).slice(0, 1000),
             row.customerText ?? null]);
          summary.reviewItems++;
        }
      }
    });

    await recordCompleteness(opts.companyId, batch.id, period);

    await exec(
      `UPDATE migration_batches SET status = ?, completed_at = NOW(), imported_counts = ? WHERE id = ?`,
      [opts.dryRun ? 'DRY_RUN' : 'COMPLETED', JSON.stringify({
        seen: parsed.stats.seen, financial: parsed.stats.financial,
        review: parsed.stats.review, duplicate: parsed.stats.duplicate,
        nonTransaction: parsed.stats.nonTransaction,
        posted: summary.posted, postFailed: summary.postFailed,
        skippedAlreadyStaged: summary.skippedAlreadyStaged,
        cumulativeDuplicates: summary.cumulativeDuplicates,
      }), batch.id]);
  } catch (err) {
    await exec(
      `UPDATE migration_batches SET status = 'FAILED', completed_at = NOW(), error_details = ? WHERE id = ?`,
      [(err as Error).message.slice(0, 2000), batch.id]);
    throw err;
  }

  summary.reconciliation = await reconcilePeriod(opts.companyId, batch.id, period, control);
  return summary;
}

/**
 * Data completeness, kept separate from accounting integrity and from
 * reconciliation (Decisions 3 and 4).
 *
 * A balanced trial balance proves double-entry integrity and says nothing about
 * whether the history is complete. Collapsing the two into one status is how a
 * migration comes to look finished when it is not — so a period whose sources
 * are known not to represent the whole company is stamped INCOMPLETE, with the
 * reason, permanently, and a review item is raised that nobody can lose.
 */
export async function recordCompleteness(
  companyId: number, batchId: number, period: string,
): Promise<void> {
  const incomplete = INCOMPLETE_PERIODS[period];
  const missingSales = MISSING_SALES_SOURCE_PERIODS[period];
  const note = incomplete ?? missingSales ?? null;

  await exec(
    `UPDATE migration_batches
        SET data_completeness = ?, completeness_note = ?, accounting_integrity = ?
      WHERE id = ?`,
    [note ? 'INCOMPLETE' : 'REVIEW_REQUIRED', note, await integrityOf(companyId, batchId), batchId]);

  if (!note) return;

  // One period-level review item per limitation, raised once. It is material by
  // definition: it changes what every figure for the month means.
  const issueType = incomplete ? REVIEW_REASON.INCOMPLETE_SOURCE : REVIEW_REASON.MISSING_SALES_SOURCE;
  const [seen] = await query<Row[]>(
    `SELECT id FROM migration_review_items
      WHERE company_id = ? AND batch_id = ? AND issue_type = ? LIMIT 1`,
    [companyId, batchId, issueType]);
  if (seen) return;

  await exec(
    `INSERT INTO migration_review_items
       (company_id, batch_id, module, issue_type, is_material, source_ref, issue, proposed)
     VALUES (?,?,?,?,1,?,?,?)`,
    [companyId, batchId, 'RECONCILIATION', issueType, `Period ${period}`,
     `${incomplete ? 'Historical Data Incomplete' : 'Historical Sales Data Incomplete'} — ${note} `
     + 'The difference against the company control sheet is preserved as a warning, not closed with a '
     + 'balancing journal.',
     'CEO acceptance with a mandatory reason, or the missing source if it is found.']);
}

/** DR = CR for this batch — accounting integrity, and nothing more. */
async function integrityOf(companyId: number, batchId: number): Promise<string> {
  const rows = await query<Row[]>(
    `SELECT ROUND(SUM(IF(ve.entry_type='DR', ve.amount, 0)),2) dr,
            ROUND(SUM(IF(ve.entry_type='CR', ve.amount, 0)),2) cr
       FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
      WHERE v.company_id = ? AND v.migration_batch_id = ?`, [companyId, batchId]);
  const dr = Number(rows[0]?.dr ?? 0);
  const cr = Number(rows[0]?.cr ?? 0);
  if (dr === 0 && cr === 0) return 'NOT_CHECKED';
  return Math.abs(dr - cr) < 0.005 ? 'BALANCED' : 'UNBALANCED';
}

const statusOf = (row: NormalizedRow): string =>
  row.outcome === 'FINANCIAL' ? 'IMPORTED'
    : row.outcome === 'DUPLICATE' ? 'SKIPPED_DUPLICATE'
      : row.outcome === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED'
        : 'PENDING';

const partyTypeOf = (row: NormalizedRow): string =>
  row.customer ? 'CUSTOMER' : row.vendor ? 'SUPPLIER' : row.agent ? 'AGENT'
    : row.outcome === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'NONE';

const moduleOf = (row: NormalizedRow): string =>
  row.kind === 'RECEIPT' || row.kind === 'PAYMENT' ? 'PAYMENT'
    : row.kind === 'PENALTY' ? 'EXPENSE'
      : row.kind === 'SALE' ? 'SALES' : 'PARTY';

// ───────────────────────────── reconciliation ───────────────────────────────

/**
 * Source vs migrated, for the metrics the brief lists.
 *
 * The migrated side is computed from what actually posted — a sum over
 * voucher_entries for this batch — never from the parser's own arithmetic. If
 * the poster silently dropped something, this is where it shows.
 */
export async function reconcilePeriod(
  companyId: number, batchId: number, period: string, control: ControlValues | null,
) {
  const totals = await migratedTotals(companyId, batchId);
  const counts = await rowCounts(companyId, batchId);

  const controls: Partial<Record<ReconMetric, { sourceValue: number | null; migratedValue: number; note?: string }>> = {
    SALES: { sourceValue: control?.sales ?? null, migratedValue: totals.sales, note: control?.sheet },
    PURCHASE: { sourceValue: control?.purchase ?? null, migratedValue: totals.purchase, note: control?.sheet },
    RECEIPT: { sourceValue: null, migratedValue: totals.receipts, note: 'No control figure on the ACCOUNTS sheet.' },
    PAYMENT: { sourceValue: null, migratedValue: totals.payments, note: 'No control figure on the ACCOUNTS sheet.' },
    EXPENSES: { sourceValue: control?.expenses ?? null, migratedValue: totals.expenses, note: control?.sheet },
    CUSTOMER_OUTSTANDING: { sourceValue: control?.receivable ?? null, migratedValue: totals.receivable, note: control?.sheet },
    VENDOR_PAYABLE: { sourceValue: control?.payable ?? null, migratedValue: totals.payable, note: control?.sheet },
    PROFIT_LOSS: {
      sourceValue: control?.netProfit ?? (control?.netLoss != null ? -control.netLoss : null),
      migratedValue: totals.sales - totals.purchase - totals.expenses, note: control?.sheet,
    },
    CAPITAL: { sourceValue: control?.capital ?? null, migratedValue: totals.capital, note: control?.sheet },
    FIXED_ASSETS: { sourceValue: control?.fixedAssets ?? null, migratedValue: totals.fixedAssets, note: control?.sheet },
    TRANSACTION_COUNT: { sourceValue: null, migratedValue: counts.imported },
    REVIEW_REQUIRED_COUNT: { sourceValue: null, migratedValue: counts.review },
  };

  await migrationService.reconcile(companyId, batchId, controls);
  const rows = await migrationService.reconciliation(companyId, batchId);
  return rows.map((r) => ({
    metric: r.metric as ReconMetric,
    source: r.source_value == null ? null : Number(r.source_value),
    migrated: Number(r.migrated_value),
    status: String(r.status),
  }));
}

/** What actually landed in the books for this batch, by ledger nature. */
async function migratedTotals(companyId: number, batchId: number) {
  const sum = async (sql: string, params: unknown[]): Promise<number> => {
    const rows = await query<Row[]>(sql, params);
    return Math.round(Number(rows[0]?.n ?? 0) * 100) / 100;
  };

  const byGroup = (groups: string[], side: 'DR' | 'CR') => `
    SELECT COALESCE(SUM(ve.amount),0) AS n
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
      JOIN ledgers l  ON l.id = ve.ledger_id
      JOIN ledger_groups g ON g.id = l.group_id
     WHERE v.company_id = ? AND v.migration_batch_id = ?
       AND ve.entry_type = '${side}'
       AND g.name IN (${groups.map(() => '?').join(',')})`;

  const byLedger = (names: string[], side: 'DR' | 'CR') => `
    SELECT COALESCE(SUM(ve.amount),0) AS n
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
      JOIN ledgers l  ON l.id = ve.ledger_id
     WHERE v.company_id = ? AND v.migration_batch_id = ?
       AND ve.entry_type = '${side}'
       AND l.name IN (${names.map(() => '?').join(',')})`;

  const p = [companyId, batchId];
  return {
    sales: await sum(byGroup(['Travel Sales'], 'CR'), [...p, 'Travel Sales'])
         - await sum(byGroup(['Travel Sales'], 'DR'), [...p, 'Travel Sales']),
    purchase: await sum(byLedger(['Cost of Services'], 'DR'), [...p, 'Cost of Services']),
    receipts: await sum(byGroup(['Cash-in-Hand', 'Bank Accounts'], 'DR'), [...p, 'Cash-in-Hand', 'Bank Accounts']),
    payments: await sum(byGroup(['Cash-in-Hand', 'Bank Accounts'], 'CR'), [...p, 'Cash-in-Hand', 'Bank Accounts']),
    // Deliberately NOT the whole 'Direct Expenses' group: 'Cost of Services'
    // lives there and is the PURCHASE figure. Counting it here too reported
    // every month's expenses as equal to its purchases.
    expenses: await sum(byGroup(['Indirect Expenses', 'Airline Penalty & Loss', 'Bank and Financial Charges'], 'DR'),
      [...p, 'Indirect Expenses', 'Airline Penalty & Loss', 'Bank and Financial Charges']),
    receivable: await sum(byGroup(['Sundry Debtors'], 'DR'), [...p, 'Sundry Debtors'])
              - await sum(byGroup(['Sundry Debtors'], 'CR'), [...p, 'Sundry Debtors']),
    payable: await sum(byGroup(['Sundry Creditors'], 'CR'), [...p, 'Sundry Creditors'])
           - await sum(byGroup(['Sundry Creditors'], 'DR'), [...p, 'Sundry Creditors']),
    capital: await sum(byGroup(['Capital Account', 'Owner / CEO Drawings'], 'CR'), [...p, 'Capital Account', 'Owner / CEO Drawings'])
           - await sum(byGroup(['Capital Account', 'Owner / CEO Drawings'], 'DR'), [...p, 'Capital Account', 'Owner / CEO Drawings']),
    fixedAssets: await sum(byGroup(['Fixed Assets'], 'DR'), [...p, 'Fixed Assets']),
  };
}

async function rowCounts(companyId: number, batchId: number) {
  const rows = await query<Row[]>(
    `SELECT status, COUNT(*) AS n FROM migration_source_rows
      WHERE company_id = ? AND batch_id = ? GROUP BY status`, [companyId, batchId]);
  const by = Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n)]));
  return {
    imported: by.IMPORTED ?? 0,
    review: by.REVIEW_REQUIRED ?? 0,
    duplicate: by.SKIPPED_DUPLICATE ?? 0,
    pending: by.PENDING ?? 0,
  };
}

/** Guard used by the CLI: a verified month is never re-imported. */
export async function assertPeriodOpen(companyId: number, period: string): Promise<void> {
  if (await migrationService.isPeriodLocked(companyId, period))
    throw ApiError.conflict(
      `${period} is already VERIFIED. Re-importing it would rewrite approved history.`);
}
