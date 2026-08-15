import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env';

export interface AccessPayload {
  sub: number;          // user id
  companyId: number;
  role: string;         // CEO | ADMIN | ACCOUNTANT | SALES | HR
  name: string;
  email?: string;
}

export const signAccessToken = (payload: AccessPayload): string =>
  jwt.sign(payload, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessTtl,
    issuer: env.jwt.issuer,
    audience: env.jwt.audience,
  } as jwt.SignOptions);

export const verifyAccessToken = (token: string): AccessPayload =>
  jwt.verify(token, env.jwt.accessSecret, {
    issuer: env.jwt.issuer,
    audience: env.jwt.audience,
  }) as unknown as AccessPayload;

/** Refresh tokens are opaque random strings; only their sha256 hash is stored. */
export const generateRefreshToken = (): { token: string; hash: string; expiresAt: Date } => {
  const token = crypto.randomBytes(48).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + env.jwt.refreshTtlDays * 24 * 60 * 60 * 1000);
  return { token, hash, expiresAt };
};

export const hashRefreshToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');
