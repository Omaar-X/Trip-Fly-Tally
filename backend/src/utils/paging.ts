import { z } from 'zod';
import { ApiError } from './ApiError';

/**
 * ============================ LIST PAGINATION ================================
 * Every list endpoint that can grow without bound returns a PAGE plus the true
 * total, so the client can say "showing 1–25 of 1,234" honestly.
 *
 * The lists used to end in a bare `LIMIT 300` with no page, no total and no
 * hint that anything had been cut. Past three hundred records the rest of the
 * business simply vanished — and because the table sorted the rows it had been
 * given, "largest invoice" returned the largest of the last three hundred and
 * looked exactly like an answer. Wrong output, confidently presented, is worse
 * than slow output.
 *
 * SORTING IS SERVER-SIDE for the same reason: sorting one page client-side
 * would rank only that page while appearing to rank everything. Columns are
 * whitelisted here rather than interpolated from the request, so the sort key
 * can never become an injection point.
 * ============================================================================
 */

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(40).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export interface Paged<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Turns a requested sort into a safe `ORDER BY` fragment.
 *
 * `allowed` maps the key the client sends to the SQL it may stand for. A key
 * that is not in the map is rejected outright — silently falling back to the
 * default would show the user a table sorted by something other than the
 * column header they just clicked.
 */
export function orderBy(
  q: ListQuery,
  allowed: Record<string, string>,
  fallback: string
): string {
  if (!q.sort) return fallback;

  const column = allowed[q.sort];
  if (!column)
    throw ApiError.badRequest(
      `Cannot sort by "${q.sort}". Sortable columns: ${Object.keys(allowed).join(', ')}`);

  const direction = q.order === 'asc' ? 'ASC' : 'DESC';
  // Tie-break on a unique column so paging cannot show the same row twice or
  // skip one when the sort column has duplicates.
  return `${column} ${direction}, ${fallback.split(',')[0].trim().split(' ')[0]} DESC`;
}

/** LIMIT/OFFSET pair for the requested page. */
export const limitOffset = (q: ListQuery): [number, number] =>
  [q.pageSize, (q.page - 1) * q.pageSize];

export const paged = <T>(data: T[], q: ListQuery, total: number): Paged<T> =>
  ({ data, page: q.page, pageSize: q.pageSize, total });
