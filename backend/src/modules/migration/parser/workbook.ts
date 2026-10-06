import { createHash } from 'crypto';
import { createReadStream, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { createRequire } from 'module';
import * as ExcelJS from 'exceljs';
import { RawCell } from './primitives';

/**
 * ================= GETTING THE ROWS OUT OF THE ARCHIVES =====================
 *
 * The historical files arrive as one zip per month, each containing a folder of
 * the same name. This module unpacks them to a scratch directory once, opens a
 * workbook, and hands back a plain `RawCell[][]` per sheet.
 *
 * Two things it deliberately does NOT do:
 *
 *   · It does not look at formatting. Merged cells, bold, borders and fills are
 *     all ignored — a merged heading reads as one value in the top-left cell
 *     and empties elsewhere, which is exactly how the row classifier expects to
 *     see it.
 *
 *   · It does not skip anything. Every row of the sheet comes back, including
 *     blanks and titles, because deciding what a row *is* belongs to the
 *     classifier and has to be auditable. A reader that quietly dropped rows
 *     would make "no silent row loss" unprovable.
 */

/** Where the extracted archives live. Outside the repo, and disposable. */
export const workDir = (): string => {
  const dir = process.env.MIGRATION_WORK_DIR
    ?? join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'tripfly-migration');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * SHA-256 of a source file.
 *
 * Recorded per batch so a re-run can prove it read the same bytes. If a
 * workbook is edited between two runs, the checksum changes and the operator
 * finds out rather than silently importing a different month.
 */
export function checksum(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Unpack every archive in `Previous Data/` into the work directory, once.
 *
 * Extraction is skipped when the folder is already there — these are 6.9 MB of
 * zips and the parser runs many times during a migration.
 */
export async function ensureExtracted(dataDir: string): Promise<string> {
  const out = workDir();
  const require_ = createRequire(__filename);
  // `unzipper` already ships inside exceljs's dependency tree, so extraction
  // costs no new package. If it ever disappears, the operator can extract the
  // archives by hand and point MIGRATION_WORK_DIR at the result — the parser
  // never needs the zips again once the folders exist.
  let unzipper: { Open: { file(p: string): Promise<{ extract(o: { path: string; concurrency?: number }): Promise<void> }> } };
  try {
    unzipper = require_('unzipper');
  } catch {
    throw new Error(
      'No zip reader available. Extract Previous Data/*.zip into '
      + `${out} manually, then set MIGRATION_WORK_DIR=${out}.`);
  }

  for (const entry of readdirSync(dataDir)) {
    if (!entry.toLowerCase().endsWith('.zip')) continue;
    // Each archive contains a folder of its own name; its presence means the
    // archive has already been unpacked.
    const marker = join(out, entry.replace(/\.zip$/i, ''));
    if (existsSync(marker)) continue;
    const zip = await unzipper.Open.file(join(dataDir, entry));
    await zip.extract({ path: out, concurrency: 4 });
  }
  return out;
}

/** Every copy of a filename under the work directory. */
export function findWorkbooks(root: string, fileName: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { stack.push(full); continue; }
      // Excel's lock files are zero-byte stubs, never the workbook.
      if (entry.startsWith('~$')) continue;
      if (basename(entry) === fileName) found.push(full);
    }
  }
  return found;
}

/**
 * A workbook by filename.
 *
 * The same filename appears in several monthly folders — `Daily Books Received
 * & Payments.xlsx` exists in seven of them — and the copies are NOT the same
 * workbook. Returning whichever turned up first silently read the wrong one:
 * the Jan-25 copy carries the legacy "World Traveller" sheets and none of the
 * 2025 monthly ones, so three months of day books came back empty with no
 * error at all.
 *
 * When a sheet is named, the copy that actually contains it wins.
 */
export function findWorkbook(root: string, fileName: string): string | null {
  return findWorkbooks(root, fileName)[0] ?? null;
}

export async function findWorkbookWithSheet(
  root: string, fileName: string, sheet: string,
): Promise<string | null> {
  const candidates = findWorkbooks(root, fileName);
  for (const path of candidates) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    if (wb.worksheets.some((w) => w.name === sheet)) return path;
  }
  return null;
}

export interface SheetRows {
  sheet: string;
  /** 1-based row numbers, matching what a person sees in Excel. */
  rows: { rowNumber: number; cells: RawCell[] }[];
}

/**
 * Read a workbook into plain arrays.
 *
 * `rowNumber` is Excel's own numbering, kept so a source reference in the audit
 * trail ("row 138") points at the row a human can open and look at.
 */
export async function readWorkbook(path: string, only?: string[]): Promise<SheetRows[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);

  const out: SheetRows[] = [];
  wb.eachSheet((ws) => {
    if (only && !only.includes(ws.name)) return;
    const rows: SheetRows['rows'] = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: RawCell[] = [];
      // `values` is 1-based with a hole at [0]; normalise to a dense 0-based
      // array so column indexes mean what the header map says they mean.
      const values = row.values as unknown[];
      const width = Math.max(values.length - 1, ws.columnCount);
      for (let c = 1; c <= width; c++) cells.push(values[c] ?? null);
      rows.push({ rowNumber, cells });
    });
    out.push({ sheet: ws.name, rows });
  });
  return out;
}

/** One sheet, or null when the workbook does not have it. */
export async function readSheet(path: string, sheet: string): Promise<SheetRows | null> {
  const sheets = await readWorkbook(path, [sheet]);
  return sheets.find((s) => s.sheet === sheet) ?? null;
}
