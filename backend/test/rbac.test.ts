import { describe, it, expect, vi } from 'vitest';
import { Request, Response } from 'express';
import { allow } from '../src/middleware/rbac';
import { ROLE } from '../src/constants/roles';
import { ApiError } from '../src/utils/ApiError';

function mockReq(role?: string): Request {
  return { user: role ? { role } : undefined } as unknown as Request;
}

describe('allow() RBAC middleware', () => {
  it('rejects requests with no authenticated user', () => {
    const next = vi.fn();
    allow(ROLE.ADMIN)(mockReq(undefined), {} as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(ApiError));
    expect((next.mock.calls[0][0] as ApiError).statusCode).toBe(401);
  });

  it('CEO always bypasses, even with an empty allow-list', () => {
    const next = vi.fn();
    allow()(mockReq(ROLE.CEO), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('allows a role that is explicitly listed', () => {
    const next = vi.fn();
    allow(ROLE.ACCOUNTANT, ROLE.ADMIN)(mockReq(ROLE.ACCOUNTANT), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('forbids a role that is not listed', () => {
    const next = vi.fn();
    allow(ROLE.ACCOUNTANT)(mockReq(ROLE.SALES), {} as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(ApiError));
    expect((next.mock.calls[0][0] as ApiError).statusCode).toBe(403);
  });

  it('forbids every role when the allow-list is empty and the role is not CEO', () => {
    const next = vi.fn();
    allow()(mockReq(ROLE.ADMIN), {} as Response, next);
    expect((next.mock.calls[0][0] as ApiError).statusCode).toBe(403);
  });
});
