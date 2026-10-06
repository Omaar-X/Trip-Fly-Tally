/**
 * ======================== THE MIGRATION COMMAND LINE ========================
 *
 *   npm run migration:parse     -- --period=2024-03
 *   npm run migration:dry-run   -- --period=2024-03
 *   npm run migration:post      -- --period=2024-03
 *   npm run migration:reconcile -- --batch=12
 *   npm run migration:rollback  -- --batch=12
 *   npm run migration:status
 *
 * `parse` touches no database at all. `dry-run` stages rows and reconciles
 * without posting a single voucher. Only `post` writes accounting entries, and
 * it refuses to run against a period the CEO has already verified.
 *
 * Point it at a database with DB_NAME. **Never production during Phase 4.**
 */
import { pool, query, Row } from '../config/db';
import { parsePeriod, defaultDataDir, PERIODS, PILOT_PERIODS } from '../modules/migration/parser';
import { runPeriod, assertPeriodOpen, loadControl } from '../modules/migration/runner';
import { migrationService } from '../modules/migration/migration.service';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
};
const has = (name: string) => args.includes(`--${name}`);

const COMPANY = Number(flag('company') ?? 1);
const USER = Number(flag('user') ?? 1);
const money = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function periodsFrom(): string[] {
  const one = flag('period');
  if (one) return [one];
  if (has('pilot')) return PILOT_PERIODS;
  if (has('all')) return PERIODS.map((p) => p.period);
  return [];
}

async function cmdParse(): Promise<void> {
  const periods = periodsFrom();
  if (!periods.length) throw new Error('Give --period=YYYY-MM, --pilot, or --all.');

  for (const period of periods) {
    const r = await parsePeriod(period, { dataDir: defaultDataDir() });
    const control = await loadControl(period, defaultDataDir());
    console.log(`\n=== ${period} · parser ${r.parserVersion} ===`);
    for (const f of r.files)
      console.log(`  ${f.file} · ${f.sheet}  (${f.rows} rows, sha256 ${f.checksum.slice(0, 16)}…)`);

    const s = r.stats;
    console.log(`  rows seen ${s.seen}`);
    console.log(`    financial        ${s.financial}`);
    console.log(`    review required  ${s.review}`);
    console.log(`    duplicates       ${s.duplicate}`);
    console.log(`    non-transaction  ${s.nonTransaction}`);
    const accounted = s.financial + s.review + s.duplicate + s.nonTransaction;
    console.log(`  accounted for    ${accounted}/${s.seen} ${accounted === s.seen ? 'OK' : '*** MISMATCH ***'}`);

    const by = (k: string) => r.rows.filter((x) => x.outcome === 'FINANCIAL' && x.kind === k);
    const total = (k: string, f: (x: typeof r.rows[number]) => number | null | undefined) =>
      by(k).reduce((t, x) => t + (f(x) ?? 0), 0);
    console.log(`  parsed sales     ${money(total('SALE', (x) => x.sellingAmount))}`);
    console.log(`  parsed receipts  ${money(total('RECEIPT', (x) => x.receivedAmount))}`);
    console.log(`  parsed payments  ${money(total('PAYMENT', (x) => x.costAmount))}`);
    if (control)
      console.log(`  control sheet    ${control.sheet}\n`
        + `    sales ${money(control.sales)} · purchase ${money(control.purchase)} · `
        + `expenses ${money(control.expenses)} · receivable ${money(control.receivable)}`);
  }
}

async function cmdRun(dryRun: boolean): Promise<void> {
  const periods = periodsFrom();
  if (!periods.length) throw new Error('Give --period=YYYY-MM, --pilot, or --all.');

  for (const period of periods) {
    await assertPeriodOpen(COMPANY, period);
    const s = await runPeriod(period, {
      companyId: COMPANY, userId: USER, dryRun,
      snapshotRef: flag('snapshot'),
    });

    console.log(`\n=== ${period} · ${s.batchNo} · ${dryRun ? 'DRY RUN' : 'POSTED'} ===`);
    console.log(`  rows seen ${s.parse.seen} → financial ${s.parse.financial} · `
      + `review ${s.parse.review} · duplicate ${s.parse.duplicate} · non-transaction ${s.parse.nonTransaction}`);
    console.log(`  posted ${s.posted} · post failed ${s.postFailed} · `
      + `review items ${s.reviewItems} · already staged ${s.skippedAlreadyStaged}`);

    if (s.reconciliation?.length) {
      console.log('  reconciliation:');
      console.log(`    ${'metric'.padEnd(22)}${'source'.padStart(16)}${'migrated'.padStart(16)}${'difference'.padStart(16)}  status`);
      for (const r of s.reconciliation) {
        const diff = r.source == null ? null : r.migrated - r.source;
        console.log(`    ${r.metric.padEnd(22)}${money(r.source).padStart(16)}`
          + `${money(r.migrated).padStart(16)}${money(diff).padStart(16)}  ${r.status}`);
      }
    }
  }
}

async function cmdReconcile(): Promise<void> {
  const batchId = Number(flag('batch'));
  if (!batchId) throw new Error('Give --batch=<id>.');
  const batch = await migrationService.getBatch(COMPANY, batchId);
  const control = await loadControl(String(batch.source_period), defaultDataDir());
  const { reconcilePeriod } = await import('../modules/migration/runner');
  const rows = await reconcilePeriod(COMPANY, batchId, String(batch.source_period), control);
  console.log(`\n=== ${batch.batch_no} · ${batch.source_period} ===`);
  for (const r of rows)
    console.log(`  ${r.metric.padEnd(22)}${money(r.source).padStart(16)}${money(r.migrated).padStart(16)}  ${r.status}`);
}

async function cmdRollback(): Promise<void> {
  const batchId = Number(flag('batch'));
  if (!batchId) throw new Error('Give --batch=<id>.');
  const out = await migrationService.rollbackBatch(COMPANY, batchId, USER);
  console.log(`Batch ${batchId} rolled back — ${out.removed} transaction(s) removed.`);
}

async function cmdStatus(): Promise<void> {
  const batches = await migrationService.listBatches(COMPANY);
  console.log(`${'batch'.padEnd(16)}${'period'.padEnd(10)}${'status'.padEnd(14)}`
    + `${'recon'.padEnd(12)}${'CEO'.padEnd(14)}counts`);
  for (const b of batches) {
    console.log(`${String(b.batch_no).padEnd(16)}${String(b.source_period).padEnd(10)}`
      + `${String(b.status).padEnd(14)}${String(b.reconciliation_status).padEnd(12)}`
      + `${String(b.ceo_approval_status).padEnd(14)}${b.imported_counts ? JSON.stringify(b.imported_counts) : ''}`);
  }

  const open = await query<Row[]>(
    "SELECT COUNT(*) AS n FROM migration_review_items WHERE company_id = ? AND status = 'OPEN'", [COMPANY]);
  console.log(`\nOpen REVIEW_REQUIRED items: ${open[0]?.n ?? 0}`);
}

async function main(): Promise<void> {
  const command = args.find((a) => !a.startsWith('--'));
  switch (command) {
    case 'parse': await cmdParse(); break;
    case 'dry-run': await cmdRun(true); break;
    case 'post': await cmdRun(false); break;
    case 'reconcile': await cmdReconcile(); break;
    case 'rollback': await cmdRollback(); break;
    case 'status': await cmdStatus(); break;
    default:
      console.log('Usage: migrate <parse|dry-run|post|reconcile|rollback|status> [--period=YYYY-MM|--pilot|--all]');
      process.exitCode = 1;
  }
}

main()
  .then(async () => { await pool.end(); })
  .catch(async (err) => {
    console.error('\nFAILED:', err.message);
    await pool.end().catch(() => { /* already closing */ });
    process.exit(1);
  });
