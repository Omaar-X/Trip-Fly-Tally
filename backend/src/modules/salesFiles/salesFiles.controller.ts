import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../middleware/audit';
import { ApiError } from '../../utils/ApiError';
import { salesFilesService } from './salesFiles.service';
import { ReceivableStatus, receivablesService } from './receivables.service';

const asInt = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * GET /api/sales-files
 * Query: year, month (1–12), customer, includeOther
 * Response 200: { success: true, data: [ { id, file_name, sheet_name, month_label,
 *   customer_name, total_tickets, total_debit, total_credit, closing_balance, … } ] }
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const data = await salesFilesService.list(req.user!.companyId, {
    year: asInt(req.query.year),
    month: asInt(req.query.month),
    customer: typeof req.query.customer === 'string' && req.query.customer.trim()
      ? req.query.customer.trim() : undefined,
    includeOther: req.query.includeOther === 'true',
  });
  res.json({ success: true, data });
});

/** GET /api/sales-files/:id/rows — the ticket rows read out of one sheet. */
export const rows = asyncHandler(async (req: Request, res: Response) => {
  const id = asInt(req.params.id);
  if (!id) throw ApiError.badRequest('Invalid sales file id');
  res.json({ success: true, data: await salesFilesService.rows(req.user!.companyId, id) });
});

/**
 * POST /api/sales-files/scan
 *
 * Reads the archive folder end to end. Safe to call repeatedly: unchanged
 * workbooks are skipped and rows already imported are never re-imported, so a
 * second press creates no second booking.
 */
export const scan = asyncHandler(async (req: Request, res: Response) => {
  const summary = await salesFilesService.scanAndImportAll(
    req.user!.companyId, req.user!.sub);
  await audit(req, 'SALES_FILES_SCAN', 'sales_files', null, {
    directory: summary.directory,
    filesSeen: summary.filesSeen,
    filesProcessed: summary.filesProcessed,
    bookingsCreated: summary.bookingsCreated,
    customersCreated: summary.customersCreated,
  });
  res.json({ success: true, data: summary });
});

/** POST /api/sales-files/upload — multipart `file`, one .xlsx workbook. */
export const upload = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) throw ApiError.badRequest('No file uploaded (field name: "file")');

  const result = await salesFilesService.importUpload(
    req.user!.companyId, req.user!.sub, file.originalname, file.buffer);
  await audit(req, 'SALES_FILE_UPLOAD', 'sales_files', null, {
    fileName: result.fileName, sheets: result.sheets.length,
  });
  res.status(201).json({ success: true, data: result });
});

/** GET /api/sales-files/balance — opening + running balance, per the sheets. */
export const balance = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await salesFilesService.balance(req.user!.companyId) });
});

/** GET /api/sales-files/:id/download — the original workbook, unaltered. */
export const download = asyncHandler(async (req: Request, res: Response) => {
  const id = asInt(req.params.id);
  if (!id) throw ApiError.badRequest('Invalid sales file id');
  const { path, fileName } = await salesFilesService.filePathFor(req.user!.companyId, id);
  await audit(req, 'SALES_FILE_DOWNLOAD', 'sales_files', id, { fileName });
  res.download(path, fileName);
});

/**
 * GET /api/sales-files/receivables — billed, received and outstanding per
 * party, spelling variants folded together.
 * Query: status=PENDING|RECEIVED (filters the rows; the totals never move).
 */
export const receivables = asyncHandler(async (req: Request, res: Response) => {
  const wanted = String(req.query.status ?? '').toUpperCase();
  const status = wanted === 'PENDING' || wanted === 'RECEIVED'
    ? (wanted as ReceivableStatus) : undefined;
  res.json({
    success: true,
    data: await receivablesService.receivables(req.user!.companyId, { status }),
  });
});

/** GET /api/sales-files/receivables/name-groups — the spelling clusters. */
export const receivableNameGroups = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await receivablesService.nameGroups(req.user!.companyId) });
});

/** GET /api/sales-files/receivables/history — stated receivable, month by month. */
export const receivableHistory = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await receivablesService.history(req.user!.companyId) });
});
