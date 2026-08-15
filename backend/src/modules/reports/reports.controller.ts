import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { reportsService } from './reports.service';
import { isoDateSchema } from '../../utils/validation';
import { ApiError } from '../../utils/ApiError';
import { today } from '../../utils/date';
import { query, Row } from '../../config/db';
import { currentFinancialYear, toPolicy } from '../accounting/fiscalPeriod.service';

/**
 * Reports default to the CURRENT FINANCIAL YEAR, not the calendar year. For a
 * Bangladeshi company running July–June, a calendar-year default silently
 * showed a P&L covering half of one financial year and half of another.
 */
async function range(req: Request): Promise<{ from: string; to: string }> {
  const parsed = z.object({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  }).parse(req.query);

  const fy = currentFinancialYear(await fyStartMonth(req.user!.companyId));
  const from = parsed.from ?? fy.from;
  // Never report past today: a range ending in the future implies figures
  // nobody has posted yet.
  const to = parsed.to ?? minDate(fy.to, today());

  if (from > to)
    throw ApiError.badRequest(`Report range starts after it ends (${from} → ${to})`);
  return { from, to };
}

async function fyStartMonth(companyId: number): Promise<number> {
  const rows = await query<Row[]>(
    'SELECT id, fy_start_month, books_begin_from, books_locked_upto FROM companies WHERE id = ?',
    [companyId]);
  if (!rows.length) throw ApiError.badRequest('Company not found');
  return toPolicy(rows[0]).fyStartMonth;
}

const minDate = (a: string, b: string): string => (a < b ? a : b);

/** GET /api/reports/trial-balance?from=&to= */
export const trialBalance = asyncHandler(async (req: Request, res: Response) => {
  const { from, to } = await range(req);
  res.json({ success: true, data: await reportsService.trialBalance(req.user!.companyId, from, to) });
});

/**
 * GET /api/reports/profit-loss?from=&to=
 * Response: { income[], expenses[], totalIncome, totalExpense, netProfit }
 */
export const profitLoss = asyncHandler(async (req: Request, res: Response) => {
  const { from, to } = await range(req);
  res.json({ success: true, data: await reportsService.profitAndLoss(req.user!.companyId, from, to) });
});

/**
 * GET /api/reports/balance-sheet?asOn=YYYY-MM-DD
 * Response adds `openingDifference` — Tally's "Difference in Opening
 * Balances" — so an unbalanced set of openings is visible rather than hidden.
 */
export const balanceSheet = asyncHandler(async (req: Request, res: Response) => {
  const { asOn } = z.object({
    asOn: isoDateSchema.default(today()),
  }).parse(req.query);
  res.json({ success: true, data: await reportsService.balanceSheet(req.user!.companyId, asOn) });
});

/** GET /api/reports/cash-book?from=&to=  |  /api/reports/bank-book */
export const cashBook = asyncHandler(async (req: Request, res: Response) => {
  const { from, to } = await range(req);
  res.json({ success: true, data: await reportsService.cashBankBook(req.user!.companyId, 'cash', from, to) });
});
export const bankBook = asyncHandler(async (req: Request, res: Response) => {
  const { from, to } = await range(req);
  res.json({ success: true, data: await reportsService.cashBankBook(req.user!.companyId, 'bank', from, to) });
});

/** GET /api/reports/day-book?from=&to= */
export const dayBook = asyncHandler(async (req: Request, res: Response) => {
  const { from, to } = await range(req);
  res.json({ success: true, data: await reportsService.dayBook(req.user!.companyId, from, to) });
});

/** GET /api/reports/daily-sales?from=&to= */
export const dailySales = asyncHandler(async (req: Request, res: Response) => {
  const { from, to } = await range(req);
  res.json({ success: true, data: await reportsService.dailySales(req.user!.companyId, from, to) });
});

/** GET /api/reports/customer-outstanding */
export const customerOutstanding = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await reportsService.customerOutstanding(req.user!.companyId) });
});
