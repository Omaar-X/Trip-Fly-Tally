import { describe, it, expect, vi } from 'vitest';
import { Request, Response } from 'express';
import { authenticate } from '../src/middleware/auth';
import { ApiError } from '../src/utils/ApiError';
import { tokenFor } from './helpers/token';
import { ROLE } from '../src/constants/roles';

function mockReq(header?: string): Request {
  return { headers: { authorization: header } } as unknown as Request;
}

describe('authenticate() middleware', () => {
  it('rejects a request with no Authorization header', () => {
    const next = vi.fn();
    authenticate(mockReq(undefined), {} as Response, next);
    expect((next.mock.calls[0][0] as ApiError).statusCode).toBe(401);
  });

  it('rejects a header that is not a Bearer token', () => {
    const next = vi.fn();
    authenticate(mockReq('Basic abc123'), {} as Response, next);
    expect((next.mock.calls[0][0] as ApiError).statusCode).toBe(401);
  });

  it('rejects an invalid/tampered token', () => {
    const next = vi.fn();
    authenticate(mockReq('Bearer not-a-real-token'), {} as Response, next);
    expect((next.mock.calls[0][0] as ApiError).statusCode).toBe(401);
  });

  it('attaches req.user and calls next() for a valid token', () => {
    const next = vi.fn();
    const req = mockReq(`Bearer ${tokenFor(ROLE.ADMIN)}`);
    authenticate(req, {} as Response, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.user?.role).toBe(ROLE.ADMIN);
  });
});
