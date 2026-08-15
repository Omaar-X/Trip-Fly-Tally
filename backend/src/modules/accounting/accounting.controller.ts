import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { accountingService } from './accounting.service';
import { financialReversalService } from './reversal.service';
import { audit } from '../../middleware/audit';
import { isoDateSchema, pagingSchema, parseId } from '../../utils/validation';
import { ApiError } from '../../utils/ApiError';
import { today } from '../../utils/date';
import { query, Row } from '../../config/db';
import { currentFinancialYear, toPolicy } from './fiscalPeriod.service';

const entrySchema = z.object({
  ledgerId: z.number().int().positive(),
  type: z.enum(['DR', 'CR']),
  amount: z.number().positive(),
  note: z.string().max(255).optional()
});
const voucherSchema = z.object({
  type: z.enum(['JOURNAL','PAYMENT','RECEIPT','SALES','PURCHASE','CONTRA','DEBIT_NOTE','CREDIT_NOTE']),
  date: isoDateSchema,
  narration: z.string().max(500).optional(),
  reference: z.string().max(120).optional(),
  entries: z.array(entrySchema).min(2)
});
const ledgerSchema = z.object({
  groupId: z.number().int().positive(),
  name: z.string().min(2).max(120),
  openingBalance: z.number().min(0).default(0),
  openingType: z.enum(['DR', 'CR']).default('DR')
});

/** GET /api/ledger-groups */
export const listGroups = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await accountingService.listGroups(req.user!.companyId) });
});

/**
 * GET /api/ledgers — every ledger with totals and closing balance.
 * Response item: { id, name, group_name, nature, total_debit, total_credit, ... }
 */
export const listLedgers = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await accountingService.listLedgers(req.user!.companyId) });
});

/** POST /api/ledgers — { groupId, name, openingBalance, openingType } */
export const createLedger = asyncHandler(async (req: Request, res: Response) => {
  const body = ledgerSchema.parse(req.body);
  const id = await accountingService.createLedger(req.user!.companyId, body);
  await audit(req, 'LEDGER_CREATE', 'ledgers', id, { name: body.name });
  res.status(201).json({ success: true, data: { id, ...body } });
});

/**
 * GET /api/ledgers/:id/statement?from=&to= — ledger statement with running balance.
 *
 * Defaults to the CURRENT FINANCIAL YEAR. It used to default to
 * 1900-01-01 → 2999-12-31, i.e. everything ever posted: on a two-year book the
 * cash ledger alone returned 228 KB in one response, and that only grows. The
 * opening balance carries the position forward, so a bounded window loses
 * nothing — it just stops shipping the whole history to render one screen.
 */
export const ledgerStatement = asyncHandler(async (req: Request, res: Response) => {
  const rows = await query<Row[]>(
    'SELECT id, fy_start_month, books_begin_from, books_locked_upto FROM companies WHERE id = ?',
    [req.user!.companyId]);
  if (!rows.length) throw ApiError.badRequest('Company not found');
  const fy = currentFinancialYear(toPolicy(rows[0]).fyStartMonth);

  const filters = z.object({
    from: isoDateSchema.default(fy.from),
    to: isoDateSchema.default(today()),
  }).parse(req.query);

  if (filters.from > filters.to)
    throw ApiError.badRequest(`Statement range starts after it ends (${filters.from} → ${filters.to})`);

  const data = await accountingService.ledgerStatement(
    req.user!.companyId, parseId(req.params.id), filters.from, filters.to);
  res.json({ success: true, data });
});

/**
 * POST /api/vouchers — the double-entry posting endpoint.
 * Request:
 * { "type": "JOURNAL", "date": "2026-06-10", "narration": "Office rent for June",
 *   "entries": [ { "ledgerId": 10, "type": "DR", "amount": 30000 },
 *                { "ledgerId": 1,  "type": "CR", "amount": 30000 } ] }
 * Response: { success, data: { voucherId, voucherNo, total } }
 * 400 if SUM(DR) != SUM(CR).
 */
export const createVoucher = asyncHandler(async (req: Request, res: Response) => {
  const body = voucherSchema.parse(req.body);
  const data = await accountingService.postVoucher(req.user!.companyId, req.user!.sub, body);
  await audit(req, 'VOUCHER_CREATE', 'vouchers', data.voucherId,
    { voucherNo: data.voucherNo, type: body.type, total: data.total });
  res.status(201).json({ success: true, data });
});

/** GET /api/vouchers?type=&from=&to=&page=&pageSize= */
export const listVouchers = asyncHandler(async (req: Request, res: Response) => {
  const filters = z.object({
    type: z.enum(['JOURNAL','PAYMENT','RECEIPT','SALES','PURCHASE','CONTRA','DEBIT_NOTE','CREDIT_NOTE']).optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  }).merge(pagingSchema).parse(req.query);
  const { rows, total } = await accountingService.listVouchers(req.user!.companyId,
    { type: filters.type, from: filters.from, to: filters.to, limit: filters.pageSize, offset: (filters.page - 1) * filters.pageSize });
  res.json({ success: true, data: rows, page: filters.page, pageSize: filters.pageSize, total });
});

/** GET /api/vouchers/:id — header + Dr/Cr lines */
export const getVoucher = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true,
    data: await accountingService.getVoucher(req.user!.companyId, parseId(req.params.id)) });
});

/**
 * POST /api/vouchers/:id/reverse — the correction path.
 *
 * A voucher is never edited and never deleted. Reversing posts a NEW voucher
 * whose entries mirror the original, linked in both directions, so the pair
 * nets to zero in every report while both stay visible in the audit trail.
 * The reversal is dated today by default, which is what lets a mistake in a
 * closed period be corrected without reopening it.
 *
 * Request:  { "reason": "Posted to the wrong expense ledger" }
 * Response: { "success": true, "data": { "originalVoucherNo": "JV-2026-2027-00004",
 *             "reversalVoucherNo": "JV-2026-2027-00011", "reversalDate": "2026-08-10",
 *             "total": 30000 } }
 * 409 when the voucher belongs to a live invoice, payment, payroll run or
 *     stock movement — unwind that document instead.
 */
export const reverseVoucher = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    reason: z.string().trim().min(1).max(255),
    date: isoDateSchema.optional(),
  }).parse(req.body);

  const data = await financialReversalService.reverseFreeStandingVoucher(
    req.user!.companyId, req.user!.sub, parseId(req.params.id), body);

  await audit(req, 'VOUCHER_REVERSE', 'vouchers', data.originalVoucherId, {
    originalVoucherNo: data.originalVoucherNo,
    reversalVoucherNo: data.reversalVoucherNo,
    total: data.total, reason: body.reason,
  });
  res.status(201).json({ success: true, data });
});
