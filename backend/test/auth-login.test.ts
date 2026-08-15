import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/modules/auth/auth.service', () => ({
  authService: {
    login: vi.fn(),
    listUsers: vi.fn(),
    me: vi.fn(),
    register: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  },
}));

// Audit writes to the DB fire-and-forget and swallow their own errors, so no
// DB mock is needed for these controller-level tests.

import { app } from '../src/app';
import { authService } from '../src/modules/auth/auth.service';
import { ApiError } from '../src/utils/ApiError';

describe('POST /api/auth/login', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a token pair on valid credentials', async () => {
    vi.mocked(authService.login).mockResolvedValue({
      accessToken: 'access.tok', refreshToken: 'refresh.tok',
      user: { id: 1, name: 'CEO User', email: 'ceo.test@example.com', role: 'CEO', companyId: 1 },
    } as any);

    const res = await request(app).post('/api/auth/login').send({ email: 'ceo.test@example.com', password: 'TestOnlyPass123!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBe('access.tok');
    expect(res.body.data.user.role).toBe('CEO');
  });

  it('returns 401 for invalid credentials', async () => {
    vi.mocked(authService.login).mockRejectedValue(ApiError.unauthorized('Invalid email or password'));

    const res = await request(app).post('/api/auth/login').send({ email: 'ceo.test@example.com', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for a malformed request body', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email', password: '123' });
    expect(res.status).toBe(400);
    expect(authService.login).not.toHaveBeenCalled();
  });
});
