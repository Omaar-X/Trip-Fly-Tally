import { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { CorsOptions } from 'cors';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

export const corsOptions: CorsOptions = {
  credentials: true,
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (env.corsOrigins.includes(origin)) return callback(null, true);
    return callback(ApiError.forbidden(`CORS origin not allowed: ${origin}`));
  },
};

const keyGenerator = (req: Request): string =>
  `${ipKeyGenerator(req.ip ?? 'unknown')}:${req.user?.companyId ?? 'public'}`;

export const apiRateLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator,
  message: { success: false, message: 'Too many requests, please try again later' },
});

export const authRateLimiter = rateLimit({
  windowMs: env.rateLimit.authWindowMs,
  max: env.rateLimit.authMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many authentication attempts, please try again later' },
});
