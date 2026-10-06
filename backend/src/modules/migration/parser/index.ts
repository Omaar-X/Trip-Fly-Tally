import { join } from 'path';
import { PARSER_VERSION } from './primitives';
import { checksum, ensureExtracted, findWorkbookWithSheet, readSheet } from './workbook';
import { parseDayBook, parsePartyLedger, parseSalesRegister } from './sheets';
import { NormalizedRow, ParseResult, emptyStats } from './types';
import { PeriodSources, SourceSheet, findPeriod } from './sources';
import { assessDuplicate, naturalKey } from '../historicalRules';

export * from './types';
export * from './sources';
export { PARSER_VERSION } from './primitives';

/**
 * ========================= PARSING ONE MONTH ================================
 *
 * Reads the authoritative sheets for a period, normalises every row, marks the
 * duplicates, and returns the lot with an accountability count that must add
 * up: seen = financial + review + duplicate + nonTransaction.
 *
 * Nothing here writes to a database. The parser is deliberately pure so it can
 * be run, re-run and diffed without touching the books — `migration:parse` is
 * a read-only command.
 */

export interface ParseOptions {
  /** Where `Previous Data/` lives. */
  dataDir: string;
  /** Skip the day book — used when only the sales side is being re-checked. */
  salesOnly?: boolean;
}

async function loadSheet(root: string, src: SourceSheet) {
  const path = await findWorkbookWithSheet(root, src.file, src.sheet);
  if (!path) return { path: null, sheet: null, sum: '' };
  const sheet = await readSheet(path, src.sheet);
  return { path, sheet, sum: await checksum(path) };
}

export async function parsePeriod(period: string, opts: ParseOptions): Promise<ParseResult> {
  const sources: PeriodSources | undefined = findPeriod(period);
  if (!sources) throw new Error(`No source catalogue entry for period "${period}".`);

  const root = await ensureExtracted(opts.dataDir);
  const rows: NormalizedRow[] = [];
  const files: ParseResult['files'] = [];

  // ── sales side ────────────────────────────────────────────────────────────
  if (sources.sales) {
    const { path, sheet, sum } = await loadSheet(root, sources.sales);
    if (!path || !sheet) {
      rows.push({
        outcome: 'REVIEW_REQUIRED', rowKind: 'DATA',
        source: { file: sources.sales.file, archive: '', sheet: sources.sales.sheet, row: 0, period },
        raw: {}, reviewCategory: 'UNPARSEABLE_ROW',
        reason: `Authoritative sales source not found: ${sources.sales.file} · ${sources.sales.sheet}. `
          + 'Do not substitute another workbook — confirm the file first.',
      });
    } else {
      const ref = { file: sources.sales.file, archive: archiveOf(path, root), sheet: sources.sales.sheet, period };
      rows.push(...(sources.sales.shape === 'PARTY_LEDGER'
        ? parsePartyLedger(sheet.rows, ref, sources.sales.party ?? 'UNKNOWN PARTY')
        : parseSalesRegister(sheet.rows, ref)));
      files.push({ file: sources.sales.file, sheet: sources.sales.sheet, checksum: sum, rows: sheet.rows.length });
    }
  }

  // ── day book ──────────────────────────────────────────────────────────────
  if (sources.dayBook && !opts.salesOnly) {
    const { path, sheet, sum } = await loadSheet(root, sources.dayBook);
    if (path && sheet) {
      rows.push(...parseDayBook(sheet.rows, {
        file: sources.dayBook.file, archive: archiveOf(path, root), sheet: sources.dayBook.sheet, period,
      }));
      files.push({ file: sources.dayBook.file, sheet: sources.dayBook.sheet, checksum: sum, rows: sheet.rows.length });
    }
  }

  markDuplicates(rows);

  // An ambiguous party is not an ambiguous transaction. If date, kind and
  // amount are present, preserve the real movement against the controlled
  // ambiguous-party ledger while keeping the row in REVIEW_REQUIRED.
  for (const row of rows) {
    if (row.outcome === 'REVIEW_REQUIRED' && row.reviewCategory === 'AMBIGUOUS_PARTY_MATCH'
        && row.date
        && (row.sellingAmount != null || row.receivedAmount != null || row.costAmount != null)) {
      row.kind ??= row.sellingAmount != null ? 'SALE'
        : row.receivedAmount != null ? 'RECEIPT' : 'PAYMENT';
      row.outcome = 'FINANCIAL';
    }
  }

  const stats = emptyStats();
  for (const r of rows) {
    stats.seen++;
    if (r.outcome === 'FINANCIAL') stats.financial++;
    else if (r.outcome === 'REVIEW_REQUIRED') stats.review++;
    else if (r.outcome === 'DUPLICATE') stats.duplicate++;
    else stats.nonTransaction++;
  }

  return { period, parserVersion: PARSER_VERSION, parsedAt: new Date().toISOString(), files, rows, stats };
}

const archiveOf = (path: string, root: string): string =>
  path.slice(root.length).replace(/^[\\/]+/, '').split(/[\\/]/)[0] ?? '';

/**
 * Mark rows that are provably the same transaction seen twice.
 *
 * Uses the Phase 3 evidence rules, which explicitly refuse the naive
 * same-date-plus-same-amount test — a family of four on one booking would
 * otherwise lose three real sales. Only a matching ticket number with a
 * matching date and amount is a duplicate; a repeated ticket with a different
 * amount goes to review as a possible reissue.
 */
export function markDuplicates(rows: NormalizedRow[]): void {
  const financial = rows.filter((r) => r.outcome === 'FINANCIAL' && r.ticketNo);
  for (let i = 0; i < financial.length; i++) {
    for (let j = i + 1; j < financial.length; j++) {
      const a = financial[i];
      const b = financial[j];
      if (b.outcome !== 'FINANCIAL') continue;

      // A sale and a receipt on the same ticket are never the same
      // transaction, and neither are a sale and the void charge against it.
      if (a.kind !== b.kind) continue;

      // The same ticket legitimately carries several distinct line items — the
      // fare, a date-change fee, a refund adjustment, a void charge — and the
      // source labels each in its route/description. Different labels mean
      // different transactions, so they are not even duplicate candidates.
      const labelA = (a.route ?? a.narration ?? '').trim().toUpperCase();
      const labelB = (b.route ?? b.narration ?? '').trim().toUpperCase();
      if (labelA !== labelB) continue;
      const verdict = assessDuplicate(
        { sourceFile: a.source.file, sourceSheet: a.source.sheet, sourceRow: a.source.row,
          ticketNo: a.ticketNo, date: a.date, amount: a.sellingAmount ?? a.receivedAmount, party: a.customer },
        { sourceFile: b.source.file, sourceSheet: b.source.sheet, sourceRow: b.source.row,
          ticketNo: b.ticketNo, date: b.date, amount: b.sellingAmount ?? b.receivedAmount, party: b.customer },
      );
      if (verdict.duplicate) {
        b.outcome = 'DUPLICATE';
        b.reason = `Same transaction as ${a.source.sheet} row ${a.source.row}. ${verdict.evidence}`;
      } else if ('review' in verdict && verdict.review) {
        b.outcome = 'REVIEW_REQUIRED';
        b.reviewCategory = 'POSSIBLE_DUPLICATE';
        b.reason = `Possible duplicate of ${a.source.sheet} row ${a.source.row}. ${verdict.evidence}`;
      }
    }
  }
}

/**
 * The idempotency key for a normalized row.
 *
 * Built from the source location plus the identifying fields, so two genuinely
 * different rows that happen to share a ticket, date and amount still get
 * different keys — the duplicate question is answered by evidence above, not by
 * a key collision here.
 *
 * The day-book side is included because one spreadsheet row legitimately
 * produces both a receipt and a payment.
 */
export function rowFingerprint(r: NormalizedRow): string {
  const side = (r.raw as { __side?: string }).__side ?? '';
  return naturalKey({
    sourceFile: r.source.file,
    sourceSheet: `${r.source.sheet}${side ? `#${side}` : ''}`,
    sourceRow: r.source.row,
    ticketNo: r.ticketNo,
    date: r.date,
    amount: r.sellingAmount ?? r.receivedAmount ?? r.costAmount,
  });
}

/** Convenience for the CLI: parse several periods in order. */
export async function parsePeriods(periods: string[], opts: ParseOptions): Promise<ParseResult[]> {
  const out: ParseResult[] = [];
  for (const p of periods) out.push(await parsePeriod(p, opts));
  return out;
}

export const defaultDataDir = (): string =>
  process.env.MIGRATION_DATA_DIR ?? join(__dirname, '../../../../../Previous Data');
