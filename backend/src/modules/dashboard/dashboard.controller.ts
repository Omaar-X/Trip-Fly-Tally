import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { dashboardService } from './dashboard.service';

/**
 * GET /api/dashboard/summary
 * Response 200:
 * { "success": true, "data": { "asOf": "2026-06-10", "revenueYtd": 1240000,
 *     "expensesYtd": 730000, "netProfitYtd": 510000, "receivables": 96500,
 *     "cashAndBank": 1184500,
 *     "bookingsThisMonth": { "PENDING": 4, "CONFIRMED": 11, "CANCELLED": 1 } } }
 */
export const summary = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await dashboardService.summary(req.user!.companyId) });
});

/** GET /api/dashboard/monthly — revenue/expense/profit per month for charts */
export const monthly = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await dashboardService.monthlySeries(req.user!.companyId) });
});

/** GET /api/dashboard/revenue-by-type — FLIGHT/HOTEL/TOUR split */
export const revenueByType = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await dashboardService.revenueByType(req.user!.companyId) });
});

/** GET /api/dashboard/activity — latest audit-trail events */
export const activity = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await dashboardService.recentActivity(req.user!.companyId) });
});
