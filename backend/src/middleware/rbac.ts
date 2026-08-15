import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { RoleName, ROLE } from '../constants/roles';

export type { RoleName };

/**
 * Central role-based access control. CEO is the sole superuser and always
 * passes — never list 'CEO' in a call, it's redundant. Every other role
 * must be explicitly listed to reach a route.
 * Usage: router.post('/vouchers', authenticate, allow(ROLE.ACCOUNTANT), handler)
 */
export const allow = (...roles: RoleName[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.user?.role as RoleName | undefined;
    if (!role) return next(ApiError.unauthorized());
    if (role === ROLE.CEO || roles.includes(role)) return next();
    next(ApiError.forbidden(`Requires role: ${roles.join(' or ')}`));
  };
