import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, AccessPayload } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AccessPayload }
  }
}

/** Verifies the Bearer access token and attaches req.user. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(ApiError.unauthorized('Missing access token'));
  try {
    req.user = verifyAccessToken(header.slice(7));
    next();
  } catch {
    next(ApiError.unauthorized('Invalid or expired access token'));
  }
}
