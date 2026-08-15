import { Request, Response } from 'express';
import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { asyncHandler } from '../../utils/asyncHandler';
import { boundedString, isoDateSchema } from '../../utils/validation';
import { ApiError } from '../../utils/ApiError';
import { audit } from '../../middleware/audit';
import { companySettingsService } from './companySettings.service';

const updateSchema = z.object({
  name: boundedString(150),
  address: boundedString(255).optional(),
  phone: boundedString(30).optional(),
  email: z.string().email().max(120).optional(),
  website: z.string().url().max(255).optional(),
  vatRegNo: boundedString(60).optional(),
  taxNumber: boundedString(60).optional(),
  tradeLicense: boundedString(60).optional(),
  currency: boundedString(10).optional(),
  // Financial year setup. Both are locked down once vouchers exist — see
  // companySettingsService.update.
  fyStartMonth: z.number().int().min(1).max(12).optional(),
  booksBeginFrom: isoDateSchema.optional(),
});

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'company');
// SVG is intentionally excluded: uploaded SVG can contain active script when
// opened directly from the same origin. Raster formats are sufficient for
// company branding and avoid turning the upload endpoint into stored XSS.
const LOGO_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const FAVICON_MIME = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon']);

async function saveUpload(file: Express.Multer.File, prefix: string): Promise<string> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const ext = path.extname(file.originalname).toLowerCase() || '.png';
  const filename = `${prefix}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), file.buffer);
  return `/uploads/company/${filename}`;
}

/** GET /api/company-settings */
export const get = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await companySettingsService.get(req.user!.companyId) });
});

/** GET /api/company-settings/public — no auth; branding only, for the login screen. Single-tenant deployment → always company id 1. */
export const getPublic = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ success: true, data: await companySettingsService.getPublic(1) });
});

/** PUT /api/company-settings (ADMIN) */
export const update = asyncHandler(async (req: Request, res: Response) => {
  const body = updateSchema.parse(req.body);
  const data = await companySettingsService.update(req.user!.companyId, body);
  await audit(req, 'COMPANY_SETTINGS_UPDATE', 'companies', req.user!.companyId);
  res.json({ success: true, data });
});

/**
 * PUT /api/company-settings/period-lock (CEO) — close or reopen the past.
 *
 * Request: { "booksLockedUpto": "2026-06-30" }   freeze everything up to that date
 *          { "booksLockedUpto": null }           reopen the books
 *
 * Locking is what makes a filed year stay filed: corrections after it must be
 * posted in the open period as reversals, exactly as Tally requires.
 */
export const setPeriodLock = asyncHandler(async (req: Request, res: Response) => {
  const { booksLockedUpto } = z.object({
    booksLockedUpto: isoDateSchema.nullable(),
  }).parse(req.body);

  const data = await companySettingsService.setPeriodLock(req.user!.companyId, booksLockedUpto);
  await audit(req, 'COMPANY_PERIOD_LOCK', 'companies', req.user!.companyId, { booksLockedUpto });
  res.json({ success: true, data });
});

/** POST /api/company-settings/logo (ADMIN, multipart field "logo") */
export const uploadLogo = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) throw ApiError.badRequest('No file uploaded');
  if (!LOGO_MIME.has(file.mimetype)) throw ApiError.badRequest('Logo must be PNG, JPEG or WEBP');
  const url = await saveUpload(file, 'logo');
  const data = await companySettingsService.updateLogo(req.user!.companyId, url);
  await audit(req, 'COMPANY_SETTINGS_LOGO_UPDATE', 'companies', req.user!.companyId);
  res.json({ success: true, data });
});

/** POST /api/company-settings/favicon (ADMIN, multipart field "favicon") */
export const uploadFavicon = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) throw ApiError.badRequest('No file uploaded');
  if (!FAVICON_MIME.has(file.mimetype)) throw ApiError.badRequest('Favicon must be PNG or ICO');
  const url = await saveUpload(file, 'favicon');
  const data = await companySettingsService.updateFavicon(req.user!.companyId, url);
  await audit(req, 'COMPANY_SETTINGS_FAVICON_UPDATE', 'companies', req.user!.companyId);
  res.json({ success: true, data });
});
