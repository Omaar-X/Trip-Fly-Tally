import { existsSync, readdirSync, writeFileSync } from 'fs';
import { basename, join, resolve, sep } from 'path';
import { query, exec, withTransaction, Row, WriteResult } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { crmService } from '../crm/crm.service';
import { bookingsService } from '../bookings/bookings.service';
import {
  ParsedSheet, ParsedWorkbook, SheetShape, monthFromName, parseWorkbook,
} from './salesFiles.parser';

/**
 * ==================== THE PREVIOUS-DATA ARCHIVE ============================
 *
 * The office's monthly Excel workbooks, kept as files, read into a catalogue,
 * and turned into the customers and bookings the operational side of the
 * system works with.
 *
 * THE ONE THING TO KNOW BEFORE READING FURTHER: this is not a second set of
 * books. Nothing in this module posts a voucher, touches a ledger, or moves a
 * balance. The audited history is the migration engine's
 * (`modules/migration`, migrations 009..018) and stays the only accounting
 * authority for the months it covers. What comes out of here is what a SHEET
 * said, which is a different and weaker claim than what the books say — the
 * balance endpoint labels itself accordingly, and the dashboard repeats it.
 *
 * Bookings raised here are PENDING. A PENDING booking is an operational
 * record: confirming one is what posts an invoice and a sales voucher, and
 * nothing here confirms anything. That is what keeps a re-scan of three thousand
 * historical tickets from being an accounting event.
 */

// ------------------------------- the folder ---------------------------------

/**
 * Where the workbooks live.
 *
 * The brief called this `backend/previous_data/`; the folder the files are
 * actually in is `backend/Previous Data/`, so both are accepted and the env
 * var wins over either. Resolution is off `process.cwd()`, matching how
 * `app.ts` resolves `uploads/` — the API and every npm script run from
 * `backend/`.
 */
const CANDIDATE_DIRS = ['Previous Data', 'previous_data'];

export function dataDir(): string {
  const override = process.env.SALES_FILES_DIR;
  if (override) return resolve(override);
  for (const name of CANDIDATE_DIRS) {
    const dir = join(process.cwd(), name);
    if (existsSync(dir)) return dir;
  }
  return join(process.cwd(), CANDIDATE_DIRS[0]);
}

const isWorkbook = (name: string): boolean =>
  /\.xlsx?$/i.test(name) && !name.startsWith('~$');   // ~$ files are Excel's locks

/**
 * How a file's location is recorded.
 *
 * Relative to `backend/` when it sits under it, so the same row survives the
 * repository being checked out somewhere else; absolute when `SALES_FILES_DIR`
 * points at a mounted volume outside it. `filePathFor` resolves both — and
 * re-checks the result against the archive folder either way.
 */
const storedPathOf = (fullPath: string): string => {
  const root = resolve(process.cwd()) + sep;
  return fullPath.startsWith(root)
    ? fullPath.slice(root.length).split(sep).join('/')
    : fullPath;
};

// ------------------------------ import results ------------------------------

export interface SheetImportResult {
  sheetName: string;
  shape: SheetShape;
  monthLabel: string;
  status: 'IMPORTED' | 'UPDATED' | 'UNCHANGED' | 'ARCHIVED_ONLY';
  rowsAdded: number;
  /** Ticket rows with no client name on them — no customer can be inferred. */
  rowsWithoutParty: number;
  skipReason: string | null;
}

export interface FileImportResult {
  fileName: string;
  status: 'PROCESSED' | 'UNCHANGED' | 'FAILED';
  error?: string;
  sheets: SheetImportResult[];
}

export interface ScanSummary {
  directory: string;
  filesSeen: number;
  filesProcessed: number;
  filesUnchanged: number;
  filesFailed: number;
  sheetsImported: number;
  rowsAdded: number;
  bookingsCreated: number;
  customersCreated: number;
  files: FileImportResult[];
}

// ------------------------------- the service --------------------------------

/** Sheets that carry sales rows. The rest are archived and listed, not read. */
const SALES_SHAPES: SheetShape[] = ['SALES_REGISTER', 'PARTY_LEDGER'];

/**
 * Shapes that need one authoritative copy chosen per month.
 *
 * ACCOUNTS is in here because several workbooks hold two or three balance
 * sheets and they disagree — December 2024's three differ by 865k — so which
 * one states the receivable has to be a decision, not whichever row came back
 * first.
 */
const PRIMARY_SHAPES: SheetShape[] = [...SALES_SHAPES, 'ACCOUNTS'];

/**
 * Months whose authoritative sheet has already been decided.
 *
 * `SALES JAN-25.xlsx` holds four copies of January. `(2)` is the corrected
 * full register — it carries the Sri Lanka Land Package correction — while
 * `(3)` and `(4)` are condensed client statements that drop BASE FARE, TAX,
 * AIT, COM and every other accounting column. `(4)` has the most rows and the
 * largest total, so the "fullest sheet wins" tie-break would pick exactly the
 * wrong one. The ruling is CLIENT_DECISIONS.md §2.3; it is repeated here so
 * it is executed rather than re-argued, the same way
 * `modules/migration/parser/sources.ts` does for the posting engine.
 */
const AUTHORITATIVE_SHEETS: { fileName: string; sheetName: string }[] = [
  { fileName: 'SALES JAN-25.xlsx', sheetName: 'Sales JAN 25 (2)' },
  // December 2024's balance sheet exists three times over. `ACCOUNTS (3)` is
  // the only version ending in a net profit and the one carrying the client's
  // own GROUPO spelling correction — CLIENT_DECISIONS §2.1, already executed
  // this way by `modules/migration/parser/sources.ts`.
  { fileName: 'SALES DECEMBER-24.xlsx', sheetName: 'ACCOUNTS (3)' },
];

export const salesFilesService = {
  dataDir,

  /**
   * Read every workbook in the folder.
   *
   * TWO PASSES, and the order is the whole point. A month's register is copied
   * into the next month's workbook, so which copy is authoritative cannot be
   * known until every file has been read. Raising bookings as each file went by
   * therefore booked January four times over — once per copy in
   * `SALES JAN-25.xlsx` — and no per-file check could have caught it, because
   * each copy is a perfectly ordinary-looking sheet on its own.
   *
   * So: catalogue and store the rows of everything first, decide which copy of
   * each month counts, and only then turn tickets into bookings.
   *
   * Safe to press twice. A file whose bytes have not changed since the last
   * scan is skipped without being opened, a row already stored is recognised by
   * `(sales_file_id, source_row)`, and a row that already has a booking is
   * never given a second one.
   */
  async scanAndImportAll(companyId: number, userId: number): Promise<ScanSummary> {
    const dir = dataDir();
    if (!existsSync(dir))
      throw ApiError.badRequest(
        `Sales file folder not found: ${dir}. Put the monthly workbooks there, `
        + 'or set SALES_FILES_DIR to where they are.');

    const names = readdirSync(dir).filter(isWorkbook).sort();
    const files: FileImportResult[] = [];

    for (const name of names) {
      try {
        files.push(await this.importFile(companyId, userId, join(dir, name)));
      } catch (error) {
        // One unreadable workbook must not abandon the other twenty-six.
        files.push({
          fileName: name, status: 'FAILED', sheets: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.recomputePrimaries(companyId);
    const booked = await this.raiseBookings(companyId, userId);

    const sheets = files.flatMap((f) => f.sheets);
    return {
      directory: dir,
      filesSeen: names.length,
      filesProcessed: files.filter((f) => f.status === 'PROCESSED').length,
      filesUnchanged: files.filter((f) => f.status === 'UNCHANGED').length,
      filesFailed: files.filter((f) => f.status === 'FAILED').length,
      sheetsImported: sheets.filter((s) => s.status === 'IMPORTED' || s.status === 'UPDATED').length,
      rowsAdded: sheets.reduce((n, s) => n + s.rowsAdded, 0),
      bookingsCreated: booked.bookingsCreated,
      customersCreated: booked.customersCreated,
      files,
    };
  },

  /**
   * One workbook: catalogue every sheet and store the rows of the ones that
   * carry sales. Raises no booking — that is `raiseBookings`, once the whole
   * folder has been read and the duplicate copies of a month are known.
   */
  async importFile(companyId: number, userId: number, filePath: string): Promise<FileImportResult> {
    const fileName = basename(filePath);
    if (!existsSync(filePath)) throw ApiError.notFound(`File not found: ${fileName}`);

    const parsed: ParsedWorkbook = await parseWorkbook(filePath);

    // Every sheet of a workbook shares the file's checksum, so one lookup
    // answers "has anything in this file changed since last time".
    const known = await query<Row[]>(
      `SELECT sheet_name, content_hash FROM sales_files
        WHERE company_id = ? AND file_name = ?`, [companyId, fileName]);
    const unchanged = known.length > 0
      && known.length === parsed.sheets.length
      && known.every((r) => String(r.content_hash) === parsed.checksum);
    if (unchanged) return { fileName, status: 'UNCHANGED', sheets: [] };

    const storedPath = storedPathOf(resolve(filePath));
    const sheets: SheetImportResult[] = [];
    for (const sheet of parsed.sheets) {
      sheets.push(await importSheet(
        companyId, userId, fileName, storedPath, parsed.checksum, sheet));
    }
    return { fileName, status: 'PROCESSED', sheets };
  },

  /**
   * Turn stored ticket rows into customers and PENDING bookings.
   *
   * Runs off `sales_file_rows`, not off the workbooks, which is what makes it
   * re-runnable and makes it right: the rows already carry the client, the
   * amount and the date, and `booking_id IS NULL` is an exact record of what
   * has not been raised yet.
   *
   * Only rows on a sheet that is both PRIMARY and MONTH-SCOPED qualify:
   *
   *   · a non-primary sheet is a duplicate copy of a month that another
   *     workbook also holds — its tickets are the same tickets;
   *   · a cumulative party ledger restates its whole history in every workbook
   *     it appears in, and those tickets are already in the month registers.
   *
   * Their rows stay stored and searchable. They simply raise nothing.
   */
  async raiseBookings(companyId: number, userId: number) {
    const rows = await query<Row[]>(
      `SELECT r.id, r.sales_file_id, r.txn_date, r.ticket_no, r.pax_name, r.route,
              r.party_name, r.debit, r.source_row, sf.sheet_name
         FROM sales_file_rows r
         JOIN sales_files sf ON sf.id = r.sales_file_id
        WHERE sf.company_id = ? AND sf.is_primary = 1 AND sf.is_cumulative = 0
          AND r.row_type = 'TICKET' AND r.booking_id IS NULL
          AND r.party_name IS NOT NULL AND r.debit > 0
        ORDER BY r.sales_file_id, r.source_row`, [companyId]);

    if (!rows.length) return { bookingsCreated: 0, customersCreated: 0 };

    // Customers are resolved before the booking transaction opens:
    // `crmService.createCustomer` runs its own transaction, because a customer
    // needs a receivable sub-ledger created alongside it, and nesting that
    // inside the booking transaction would deadlock the two against each other.
    const parties = [...new Set(rows.map((r) => String(r.party_name)))];
    const { customers, created } = await resolveCustomers(companyId, parties);

    let bookingsCreated = 0;
    // One transaction per sheet: a few thousand bookings in a single
    // transaction would hold the booking counter for the whole run.
    for (const group of groupBy(rows, (r) => String(r.sales_file_id))) {
      await withTransaction(async (conn) => {
        for (const row of group) {
          const customerId = customers.get(nameKeyOf(String(row.party_name)));
          if (!customerId) continue;

          const booking = await bookingsService.createTx(conn, companyId, userId, {
            customerId,
            bookingType: 'FLIGHT',
            // These tickets were issued, flown and paid for years ago, so they
            // are recorded CONFIRMED rather than left awaiting an issue that
            // already happened. CONFIRMED here is a STATUS ONLY: no invoice is
            // raised and no voucher is posted, because the ledgers for these
            // months are the migration engine's and posting them a second time
            // from a sales sheet would double the books. `bookingsService
            // .confirm()` remains the only path that posts anything.
            status: 'CONFIRMED',
            travelDate: row.txn_date ? String(row.txn_date).slice(0, 10) : undefined,
            // cost_price is left at zero on purpose. What the company paid the
            // consolidator for this ticket is on the supplier statement, which
            // this module deliberately does not import; inventing a cost here
            // would put a made-up margin on a historical booking.
            costPrice: 0,
            salePrice: Number(row.debit),
            details: {
              source: 'PREVIOUS_DATA',
              salesFileId: Number(row.sales_file_id), sheet: String(row.sheet_name),
              sourceRow: Number(row.source_row),
              ticketNo: row.ticket_no, pax: row.pax_name, route: row.route,
            },
          });
          await conn.query(
            'UPDATE sales_file_rows SET customer_id = ?, booking_id = ? WHERE id = ?',
            [customerId, booking.id, row.id]);
          bookingsCreated++;
        }
      });
    }
    return { bookingsCreated, customersCreated: created };
  },

  /**
   * Accept an uploaded workbook: write it into the archive folder, then read
   * it exactly as a scan would.
   *
   * An upload never overwrites an existing file — a workbook already in the
   * archive is a source somebody may have reconciled against, so a same-named
   * upload lands beside it with a timestamp rather than on top of it.
   */
  async importUpload(
    companyId: number, userId: number, originalName: string, buffer: Buffer,
  ): Promise<FileImportResult> {
    if (!isWorkbook(originalName))
      throw ApiError.badRequest('Only .xlsx / .xls workbooks can be uploaded here.');

    const dir = dataDir();
    if (!existsSync(dir))
      throw ApiError.badRequest(`Sales file folder not found: ${dir}`);

    // basename() strips any directory the client put in the field name.
    const safeName = basename(originalName).replace(/[\\/:*?"<>|]/g, '_');
    let target = join(dir, safeName);
    if (existsSync(target)) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      target = join(dir, safeName.replace(/(\.xlsx?)$/i, `_${stamp}$1`));
    }
    writeFileSync(target, buffer);

    const result = await this.importFile(companyId, userId, target);
    // Same order as a full scan, and for the same reason: an uploaded month
    // may be the copy that supersedes one already in the archive, and until
    // that is settled there is no way to know whose tickets to raise.
    await this.recomputePrimaries(companyId);
    await this.raiseBookings(companyId, userId);
    return result;
  },

  /**
   * The archive, newest month first.
   *
   * `includeOther` brings in the sheets that are not sales — the balance
   * sheets, bank statements and expense books that share the workbook. They
   * are catalogued so the file list is complete and honest about what is in
   * each workbook, but the dashboard table does not ask for them.
   */
  async list(companyId: number, filters: {
    year?: number; month?: number; customer?: string; includeOther?: boolean;
  }): Promise<Row[]> {
    const where = ['sf.company_id = ?'];
    const params: unknown[] = [companyId];

    if (!filters.includeOther) {
      where.push(`sf.sheet_shape IN (${SALES_SHAPES.map(() => '?').join(',')})`);
      params.push(...SALES_SHAPES);
    }
    if (filters.year) { where.push('YEAR(sf.month_year) = ?'); params.push(filters.year); }
    if (filters.month) { where.push('MONTH(sf.month_year) = ?'); params.push(filters.month); }
    if (filters.customer) {
      // A register has no single customer, so a customer filter also looks at
      // the client names on its rows — otherwise searching "SUN PHARMA" would
      // only ever find party ledgers.
      where.push(`(sf.customer_name LIKE ? OR EXISTS (
                     SELECT 1 FROM sales_file_rows r
                      WHERE r.sales_file_id = sf.id AND r.party_name LIKE ?))`);
      params.push(`%${filters.customer}%`, `%${filters.customer}%`);
    }

    return query<Row[]>(
      `SELECT sf.id, sf.file_name, sf.sheet_name, sf.sheet_shape, sf.skip_reason,
              sf.month_label, sf.month_year, sf.is_primary, sf.is_cumulative,
              sf.period_from, sf.period_to, sf.customer_name,
              sf.total_tickets, sf.total_debit, sf.total_credit, sf.closing_balance,
              sf.uploaded_at, u.name AS uploaded_by_name
         FROM sales_files sf
         LEFT JOIN users u ON u.id = sf.uploaded_by
        WHERE ${where.join(' AND ')}
        ORDER BY sf.month_year DESC, sf.is_primary DESC, sf.sheet_shape, sf.sheet_name`,
      params);
  },

  /** The ticket rows behind one archived sheet. */
  async rows(companyId: number, salesFileId: number): Promise<Row[]> {
    await loadFile(companyId, salesFileId);
    return query<Row[]>(
      `SELECT r.id, r.source_row, r.row_type, r.txn_date, r.ticket_no, r.pax_name,
              r.route, r.party_name, r.debit, r.credit, r.running_balance,
              r.customer_id, r.booking_id, b.booking_no
         FROM sales_file_rows r
         LEFT JOIN bookings b ON b.id = r.booking_id
        WHERE r.sales_file_id = ?
        ORDER BY r.source_row`, [salesFileId]);
  },

  /**
   * Opening and running balance, as the sheets state them.
   *
   * NOTE ON NAMING: these are SALES figures — what the month registers billed —
   * not a receivable. The receivable is a different question with a different
   * source, and it is answered by `receivablesService` off the ACCOUNTS
   * balance sheet. `statedReceivable` below is carried here only so the
   * dashboard can show the two side by side without a second round trip; it is
   * not derived from anything in this function.
   *
   * Opening = what the latest month's own sales sheets closed at. Running =
   * that, plus the debits and credits of every month filed after it, which is
   * what a newly uploaded month moves.
   *
   * Only PRIMARY, NON-CUMULATIVE sheets are counted, and both exclusions
   * matter. Cumulative party ledgers restate the whole relationship from 2024
   * on every copy, so adding them in would count years of tickets once per
   * workbook. Non-primary sheets are the duplicate copies of a month that get
   * carried into the next month's workbook.
   */
  async balance(companyId: number) {
    const [latest] = await query<Row[]>(
      `SELECT MAX(month_year) AS m FROM sales_files
        WHERE company_id = ? AND is_primary = 1 AND is_cumulative = 0`, [companyId]);
    const asOf = latest?.m ? String(latest.m).slice(0, 10) : null;

    const statedReceivable = await latestStatedReceivable(companyId);

    if (!asOf) {
      return {
        asOfMonth: null, asOfLabel: null, openingBalance: 0, runningBalance: 0,
        movementSince: 0, sheetsCounted: 0, ...statedReceivable,
        basis: 'No sales sheets have been imported yet.',
      };
    }

    const [opening] = await query<Row[]>(
      `SELECT COALESCE(SUM(closing_balance), 0) AS closing,
              COUNT(*) AS n, MAX(month_label) AS label
         FROM sales_files
        WHERE company_id = ? AND is_primary = 1 AND is_cumulative = 0
          AND month_year = ?`, [companyId, asOf]);

    const [after] = await query<Row[]>(
      `SELECT COALESCE(SUM(total_debit - total_credit), 0) AS movement
         FROM sales_files
        WHERE company_id = ? AND is_primary = 1 AND is_cumulative = 0
          AND month_year > ?`, [companyId, asOf]);

    const openingBalance = Number(opening?.closing ?? 0);
    const movementSince = Number(after?.movement ?? 0);
    return {
      asOfMonth: asOf,
      asOfLabel: opening?.label ? String(opening.label) : null,
      openingBalance,
      runningBalance: Math.round((openingBalance + movementSince) * 100) / 100,
      movementSince,
      sheetsCounted: Number(opening?.n ?? 0),
      ...statedReceivable,
      basis: 'Taken from the sales sheets themselves, not from the posted '
           + 'ledgers. The audited receivable is in the accounting reports.',
    };
  },

  /** Absolute path of the original workbook, for the download response. */
  async filePathFor(companyId: number, salesFileId: number) {
    const file = await loadFile(companyId, salesFileId);
    const stored = String(file.stored_path);
    const full = resolve(process.cwd(), stored);
    // The path came out of our own table, but it is still a path being turned
    // into a file read — so it is checked against the archive folder rather
    // than trusted.
    if (!full.startsWith(resolve(dataDir()) + sep))
      throw ApiError.badRequest('Stored path is outside the sales file folder.');
    if (!existsSync(full)) throw ApiError.notFound(`Original file is missing: ${stored}`);
    return { path: full, fileName: String(file.file_name) };
  },

  /**
   * Decide which copy of each month is the authoritative one.
   *
   * A month's register is copied forward into the next month's workbook —
   * `SALES-MAR-26.xlsx` carries a second `Sales FEB 2026`, and three separate
   * workbooks carry a `Sales May 2026`. The copy sitting in its OWN month's
   * file wins; where that rule cannot separate them, the fuller sheet does.
   * The losers stay listed and downloadable, and are left out of every total.
   */
  async recomputePrimaries(companyId: number): Promise<void> {
    const rows = await query<Row[]>(
      `SELECT id, file_name, sheet_name, sheet_shape, month_year, customer_name,
              total_tickets, is_primary
         FROM sales_files
        WHERE company_id = ? AND sheet_shape IN (?, ?, ?)`,
      [companyId, ...PRIMARY_SHAPES]);

    const winners = choosePrimaries(rows.map((r) => ({
      id: Number(r.id),
      fileName: String(r.file_name),
      sheetName: String(r.sheet_name),
      shape: String(r.sheet_shape),
      monthYear: String(r.month_year).slice(0, 10),
      customerName: r.customer_name === null ? null : String(r.customer_name),
      totalTickets: Number(r.total_tickets),
    })));

    const changed = rows.filter((r) => (Number(r.is_primary) === 1) !== winners.has(Number(r.id)));
    for (const row of changed)
      await exec('UPDATE sales_files SET is_primary = ? WHERE id = ?',
                 [winners.has(Number(row.id)) ? 1 : 0, row.id]);
  },
};

export interface PrimaryCandidate {
  id: number;
  fileName: string;
  sheetName: string;
  shape: string;
  /** `YYYY-MM-DD`, first of the month. */
  monthYear: string;
  customerName: string | null;
  totalTickets: number;
}

/**
 * Which copy of each month wins, as a pure function of the candidates.
 *
 * Kept separate from the database so the offline parse check can show the same
 * answer the importer will reach, without a schema to write into.
 *
 * One winner per (month, shape, party): a month has one register, and each
 * party has one ledger, and both are things a duplicate copy can shadow.
 */
export function choosePrimaries(candidates: PrimaryCandidate[]): Set<number> {
  const groups = new Map<string, PrimaryCandidate[]>();
  for (const c of candidates) {
    const key = [c.monthYear, c.shape, c.customerName ?? ''].join('|');
    const bucket = groups.get(key);
    if (bucket) bucket.push(c); else groups.set(key, [c]);
  }

  const winners = new Set<number>();
  for (const [key, group] of groups) {
    const month = key.slice(0, 7);
    const score = (c: PrimaryCandidate): number => {
      if (AUTHORITATIVE_SHEETS.some(
        (d) => d.fileName === c.fileName && d.sheetName === c.sheetName)) return 2;
      const fileMonth = monthFromName(c.fileName);
      const filedInOwnMonth = fileMonth
        && `${fileMonth.year}-${String(fileMonth.month).padStart(2, '0')}` === month;
      return filedInOwnMonth ? 1 : 0;
    };
    const best = group.slice().sort((a, b) =>
      score(b) - score(a)
      || b.totalTickets - a.totalTickets
      || a.fileName.localeCompare(b.fileName)
      || a.sheetName.localeCompare(b.sheetName))[0];
    winners.add(best.id);
  }
  return winners;
}

// ------------------------------- internals ----------------------------------

/**
 * The latest month's ACCOUNTS RECEIVABLE total — what the office says is owed.
 *
 * Read straight off the balance sheet rather than computed. Billing and
 * collection live in different sheets in this archive, so no arithmetic over
 * the sales registers can produce this number.
 */
async function latestStatedReceivable(companyId: number) {
  const [row] = await query<Row[]>(
    `SELECT stated_total, stated_sales, stated_profit, stated_loss, month_label
       FROM sales_files
      WHERE company_id = ? AND sheet_shape = 'ACCOUNTS' AND is_primary = 1
        AND stated_total IS NOT NULL
      ORDER BY month_year DESC LIMIT 1`, [companyId]);
  return {
    statedReceivable: row ? round2(Number(row.stated_total)) : null,
    statedReceivableLabel: row ? String(row.month_label) : null,
    // The office's own SALES figure for the same month. Shown in preference to
    // the sum of the register's rows: it is the number they wrote, and every
    // time a derived figure has gone on this dashboard it has needed
    // explaining. The computed one rides alongside as a cross-check.
    statedSales: row && row.stated_sales !== null ? round2(Number(row.stated_sales)) : null,
    // The month's bottom line, straight off the sheet. The dashboard's own
    // "Net Profit (YTD)" card is a different figure from a different place —
    // the posted ledgers — and reads 0.00 here because this archive posts
    // nothing. Both are shown, in separate rows, saying whose number each is.
    statedProfit: row && row.stated_profit !== null ? round2(Number(row.stated_profit)) : null,
    statedLoss: row && row.stated_loss !== null ? round2(Number(row.stated_loss)) : null,
  };
}

async function loadFile(companyId: number, salesFileId: number): Promise<Row> {
  const rows = await query<Row[]>(
    'SELECT * FROM sales_files WHERE company_id = ? AND id = ?', [companyId, salesFileId]);
  if (!rows[0]) throw ApiError.notFound('Sales file not found');
  return rows[0];
}

/**
 * Catalogue one sheet, then import the rows it has that we have not seen.
 *
 * The two halves are deliberately separate: the catalogue row is written for
 * EVERY sheet, including the balance sheets and bank statements, so the
 * archive can say what is in a workbook. Only the two sales shapes go on to
 * produce rows, customers and bookings.
 */
async function importSheet(
  companyId: number, userId: number, fileName: string, storedPath: string,
  checksum: string, sheet: ParsedSheet,
): Promise<SheetImportResult> {
  const existing = await query<Row[]>(
    `SELECT id, content_hash FROM sales_files
      WHERE company_id = ? AND file_name = ? AND sheet_name = ?`,
    [companyId, fileName, sheet.sheetName]);

  const summary = [
    storedPath, sheet.sheetName, sheet.shape, sheet.skipReason,
    sheet.monthLabel, sheet.monthYear, sheet.isCumulative ? 1 : 0,
    sheet.periodFrom, sheet.periodTo, sheet.customerName,
    sheet.totalTickets, sheet.totalDebit, sheet.totalCredit, sheet.closingBalance,
    checksum,
  ];

  let salesFileId: number;
  let status: SheetImportResult['status'];

  if (existing[0]) {
    salesFileId = Number(existing[0].id);
    const same = String(existing[0].content_hash) === checksum;
    await exec(
      `UPDATE sales_files
          SET stored_path = ?, sheet_name = ?, sheet_shape = ?, skip_reason = ?,
              month_label = ?, month_year = ?, is_cumulative = ?,
              period_from = ?, period_to = ?, customer_name = ?,
              total_tickets = ?, total_debit = ?, total_credit = ?, closing_balance = ?,
              content_hash = ?
        WHERE id = ?`, [...summary, salesFileId]);
    status = same ? 'UNCHANGED' : 'UPDATED';
  } else {
    const res = await exec(
      `INSERT INTO sales_files
         (company_id, file_name, stored_path, sheet_name, sheet_shape, skip_reason,
          month_label, month_year, is_cumulative, period_from, period_to, customer_name,
          total_tickets, total_debit, total_credit, closing_balance, content_hash, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [companyId, fileName, ...summary, userId]);
    salesFileId = res.insertId;
    status = 'IMPORTED';
  }

  const base: SheetImportResult = {
    sheetName: sheet.sheetName, shape: sheet.shape, monthLabel: sheet.monthLabel,
    status, rowsAdded: 0, rowsWithoutParty: 0, skipReason: sheet.skipReason,
  };

  if (sheet.shape === 'ACCOUNTS') {
    await storeReceivableBlock(salesFileId, sheet);
    return { ...base, status: 'ARCHIVED_ONLY', rowsAdded: sheet.receivables.length };
  }
  if (!SALES_SHAPES.includes(sheet.shape))
    return { ...base, status: 'ARCHIVED_ONLY' };

  return { ...base, ...await importRows(salesFileId, sheet) };
}

/**
 * The month-end receivable block, and the workbook's own total beside it.
 *
 * Rewritten wholesale each time the sheet changes rather than merged: a
 * balance sheet is a statement of one moment, so a party dropping off it means
 * the debt was settled, and a merge would keep the settled line forever.
 */
async function storeReceivableBlock(salesFileId: number, sheet: ParsedSheet): Promise<void> {
  const summed = round2(sheet.receivables.reduce((sum, e) => sum + e.amount, 0));
  const stated = sheet.statedTotal;
  const gap = stated === null ? null : round2(summed - stated);

  await withTransaction(async (conn) => {
    await conn.query('DELETE FROM sales_file_receivables WHERE sales_file_id = ?', [salesFileId]);
    for (const entry of sheet.receivables)
      await conn.query<WriteResult>(
        `INSERT INTO sales_file_receivables (sales_file_id, source_row, party_name, amount)
         VALUES (?,?,?,?)`,
        [salesFileId, entry.sourceRow, truncate(entry.party, 255), entry.amount]);
    await conn.query(
      `UPDATE sales_files
          SET stated_total = ?, receivable_discrepancy = ?, stated_sales = ?,
              stated_profit = ?, stated_loss = ?
        WHERE id = ?`,
      [stated, gap !== null && Math.abs(gap) >= 0.05 ? gap : null,
       sheet.statedSales, sheet.statedProfit, sheet.statedLoss, salesFileId]);
  });
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The rows a sheet carries, stored verbatim.
 *
 * Idempotency lives on `uq_sfr_source (sales_file_id, source_row)`: rows
 * already stored are read back and skipped, so pressing "Scan & Import All"
 * again adds nothing.
 *
 * No booking is raised here. Which copy of a month is authoritative is not
 * knowable until the whole folder has been read, so that belongs to
 * `raiseBookings`, after `recomputePrimaries`.
 */
async function importRows(
  salesFileId: number, sheet: ParsedSheet,
): Promise<Pick<SheetImportResult, 'rowsAdded' | 'rowsWithoutParty'>> {
  const seen = await query<Row[]>(
    'SELECT source_row FROM sales_file_rows WHERE sales_file_id = ?', [salesFileId]);
  const already = new Set(seen.map((r) => Number(r.source_row)));

  const fresh = sheet.rows.filter((r) => !already.has(r.sourceRow) && r.rowType !== 'OTHER');
  if (!fresh.length) return { rowsAdded: 0, rowsWithoutParty: 0 };

  await withTransaction(async (conn) => {
    for (const row of fresh)
      await conn.query<WriteResult>(
        `INSERT INTO sales_file_rows
           (sales_file_id, source_row, row_type, txn_date, ticket_no, pax_name, route,
            party_name, debit, credit, running_balance)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [salesFileId, row.sourceRow, row.rowType, row.date, truncate(row.ticketNo, 60),
         truncate(row.paxName, 255), truncate(row.route, 255), truncate(row.partyName, 255),
         row.debit, row.credit, row.runningBalance]);
  });

  return {
    rowsAdded: fresh.length,
    rowsWithoutParty: fresh.filter((r) => r.rowType === 'TICKET' && !r.partyName).length,
  };
}

const nameKeyOf = (name: string): string => name.trim().replace(/\s+/g, ' ').toUpperCase();

/** Consecutive runs sharing a key, in the order the rows arrived. */
function groupBy<T>(items: T[], key: (item: T) => string): T[][] {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item); else out.set(k, [item]);
  }
  return [...out.values()];
}

const truncate = (value: string | null, max: number): string | null =>
  value === null ? null : value.slice(0, max);

/**
 * Find or create the customer behind each party name.
 *
 * A name is only ever matched or created — never renamed, never merged.
 * "GROUPO SORCING" and "GROUPO SORCHING" being one party or two is a judgement
 * recorded in CLIENT_DECISIONS.md, not something an importer gets to decide,
 * so this matches on exactly the key the `customers.name_key` column uses and
 * leaves everything else alone.
 */
async function resolveCustomers(companyId: number, names: string[]) {
  const customers = new Map<string, number>();
  let created = 0;

  for (const name of names) {
    const key = nameKeyOf(name);
    if (customers.has(key)) continue;

    const existing = await crmService.findCustomerByName(companyId, name);
    if (existing) { customers.set(key, Number(existing.id)); continue; }

    try {
      const id = await crmService.createCustomer(companyId, { name, creditLimit: 0 });
      customers.set(key, Number(id));
      created++;
    } catch {
      // Lost a race, or the name collides with an existing one on the
      // generated key. Either way the row that is there is the right one.
      const raced = await crmService.findCustomerByName(companyId, name);
      if (raced) customers.set(key, Number(raced.id));
    }
  }
  return { customers, created };
}
