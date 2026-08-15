import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { adminDatabaseService } from './adminDatabase.service';
import { env } from '../../config/env';

const filenameDate = () => new Date().toISOString().replace(/[:.]/g, '-');

/** GET /api/admin/database/tables */
export const tables = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ success: true, data: await adminDatabaseService.tables() });
});

/** GET /api/admin/database/tables/:table?limit=&offset= */
export const tableData = asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset } = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  }).parse(req.query);
  res.json({
    success: true,
    data: await adminDatabaseService.tableData(req.params.table, req.user!.companyId, limit, offset)
  });
});

/** GET /api/admin/database/tables/:table/export.csv */
export const tableCsv = asyncHandler(async (req: Request, res: Response) => {
  const csv = await adminDatabaseService.tableCsv(req.params.table, req.user!.companyId);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.table}-${filenameDate()}.csv"`);
  res.send(csv);
});

/** GET /api/admin/database/export.json */
export const fullBackup = asyncHandler(async (req: Request, res: Response) => {
  const backup = await adminDatabaseService.fullBackup(req.user!.companyId);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${env.appSlug}-backup-${filenameDate()}.json"`);
  res.send(JSON.stringify(backup, null, 2));
});
