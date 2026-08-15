import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { signAccessToken, verifyAccessToken } from '../src/utils/jwt';
import { env } from '../src/config/env';

describe('access token sign/verify', () => {
  const payload = { sub: 1, companyId: 1, role: 'CEO', name: 'Test CEO' };

  it('round-trips a signed token', () => {
    const token = signAccessToken(payload);
    const decoded = verifyAccessToken(token);
    expect(decoded.sub).toBe(1);
    expect(decoded.role).toBe('CEO');
  });

  it('signs with the configured issuer/audience (not a hardcoded product name)', () => {
    const token = signAccessToken(payload);
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded.iss).toBe(env.jwt.issuer);
    expect(decoded.aud).toBe(env.jwt.audience);
  });

  it('rejects a token signed with a different issuer', () => {
    const foreignToken = jwt.sign(payload, env.jwt.accessSecret, {
      issuer: 'someone-else-api',
      audience: env.jwt.audience,
    });
    expect(() => verifyAccessToken(foreignToken)).toThrow();
  });

  it('rejects a token signed with a different secret', () => {
    const foreignToken = jwt.sign(payload, 'a-completely-different-secret-value', {
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    });
    expect(() => verifyAccessToken(foreignToken)).toThrow();
  });

  it('rejects garbage input', () => {
    expect(() => verifyAccessToken('not-a-real-token')).toThrow();
  });
});
