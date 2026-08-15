import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../utils/ApiError';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ success: false, message: 'Route not found' });
}

/**
 * ======================= DATABASE ERROR TRANSLATION =========================
 * A constraint doing its job is a *client* problem, not a server fault. These
 * used to fall through to a bare 500 — posting a voucher against a ledger id
 * that does not exist, or an amount too large for DECIMAL(14,2), both looked
 * like the API had crashed.
 *
 * Messages here are deliberately generic. The raw driver text carries table,
 * column and constraint names, which is schema disclosure; the real error is
 * still logged server-side for whoever has to debug it.
 * ============================================================================
 */
interface DbError { code?: string; errno?: number; sqlMessage?: string; }

const DB_ERRORS: Record<string, { status: number; message: string }> = {
  // referenced row missing — e.g. ledgerId / customerId that does not exist
  ER_NO_REFERENCED_ROW:   { status: 400, message: 'A referenced record does not exist' },
  ER_NO_REFERENCED_ROW_2: { status: 400, message: 'A referenced record does not exist' },
  // still referenced by children — e.g. deleting something in use
  ER_ROW_IS_REFERENCED:   { status: 409, message: 'This record is still referenced by other records' },
  ER_ROW_IS_REFERENCED_2: { status: 409, message: 'This record is still referenced by other records' },
  // uniqueness
  ER_DUP_ENTRY:           { status: 409, message: 'A record with these details already exists' },
  // value shape / range
  ER_WARN_DATA_OUT_OF_RANGE:  { status: 400, message: 'A numeric value is out of the allowed range' },
  ER_DATA_TOO_LONG:           { status: 400, message: 'A value is too long for its field' },
  ER_TRUNCATED_WRONG_VALUE:   { status: 400, message: 'A value has the wrong format' },
  ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: { status: 400, message: 'A value has the wrong format' },
  ER_BAD_NULL_ERROR:          { status: 400, message: 'A required field was missing' },
  ER_CHECK_CONSTRAINT_VIOLATED: { status: 400, message: 'A value violates a database constraint' },
  ER_INVALID_JSON_TEXT:       { status: 400, message: 'A value is not valid JSON' },
  // concurrency — safe and meaningful for the client to retry
  ER_LOCK_DEADLOCK:       { status: 409, message: 'The request conflicted with another update — please retry' },
  ER_LOCK_WAIT_TIMEOUT:   { status: 409, message: 'The request timed out waiting on another update — please retry' },
};

function asDbError(err: unknown): DbError | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as DbError;
  return typeof e.code === 'string' && typeof e.errno === 'number' ? e : undefined;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false, message: 'Validation failed',
      errors: err.errors.map(e => ({ path: e.path.join('.'), message: e.message }))
    });
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ success: false, message: err.message, details: err.details });
    return;
  }

  const dbError = asDbError(err);
  const mapped = dbError?.code ? DB_ERRORS[dbError.code] : undefined;
  if (mapped) {
    console.error(`Database constraint (${dbError!.code}):`, dbError!.sqlMessage);
    res.status(mapped.status).json({ success: false, message: mapped.message });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
}
