import { z } from 'zod';
import { isRealDate } from './date';

/**
 * A real calendar date in YYYY-MM-DD. The shape check alone is not enough:
 * `2026-13-45` and `2026-02-31` both match the pattern, pass validation, and
 * then blow up inside MySQL's strict mode as an unhandled 500. `isRealDate`
 * closes that gap so the caller gets a 400 that names the problem.
 */
export const isoDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isRealDate, 'Not a real calendar date');
export const idSchema = z.coerce.number().int().positive();
export const optionalIdSchema = z.coerce.number().int().positive().optional();

export const parseId = (value: unknown): number => idSchema.parse(value);

export const pagingSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const boundedString = (max: number) =>
  z.string().trim().min(1).max(max);
