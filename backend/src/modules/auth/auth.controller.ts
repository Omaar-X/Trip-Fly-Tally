import { Request, Response } from 'express';
import { z } from 'zod';
import { authService } from './auth.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../middleware/audit';
import { ROLES } from '../../constants/roles';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(6) });
const registerSchema = z.object({
  name: z.string().min(2), email: z.string().email(), password: z.string().min(6),
  role: z.enum(ROLES)
});
const approvalSchema = z.object({ status: z.enum(['APPROVED', 'REJECTED']) });
const forgotPasswordSchema = z.object({ email: z.string().email() });
const resetPasswordSchema = z.object({
  email: z.string().email(), otp: z.string().regex(/^\d{6}$/),
  password: z.string().min(8),
});

/**
 * POST /api/auth/login
 * Request : { "email": "configured-ceo-email", "password": "<secret>" }
 * Response: { success, data: { accessToken, refreshToken, user } }
 */
export const login = asyncHandler(async (req: Request, res: Response) => {
  const body = loginSchema.parse(req.body);
  const data = await authService.login(body.email, body.password);
  await audit(req, 'LOGIN', 'users', data.user.id, undefined, data.user.id);
  res.json({ success: true, data });
});

/** POST /api/auth/forgot-password — sends a one-time email OTP. */
export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { email } = forgotPasswordSchema.parse(req.body);
  await authService.requestPasswordReset(email);
  res.json({ success: true, message: 'If an account exists for this email, a reset code has been sent.' });
});

/** POST /api/auth/reset-password — verifies the OTP and changes the password. */
export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const body = resetPasswordSchema.parse(req.body);
  await authService.resetPassword(body);
  res.json({ success: true, message: 'Password reset successful. You can now sign in.' });
});

/**
 * POST /api/auth/register  (CEO only — user management is CEO's)
 * Request : { "name": "New User", "email": "x@y.com", "password": "secret1", "role": "SALES" }
 * Response: { success, data: { id, name, email, role } }
 */
export const register = asyncHandler(async (req: Request, res: Response) => {
  const body = registerSchema.parse(req.body);
  const data = await authService.register(body);
  res.status(201).json({ success: true, data });
});

export const setApproval = asyncHandler(async (req: Request, res: Response) => {
  const body = approvalSchema.parse(req.body);
  const data = await authService.setApproval(req.user!.companyId, Number(req.params.id), body.status);
  await audit(req, `USER_${body.status}`, 'users', Number(data.id), { email: data.email, role: data.role });
  res.json({ success: true, data });
});

/** POST /api/auth/refresh — { "refreshToken": "..." } → new token pair (rotation) */
export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(20) }).parse(req.body);
  res.json({ success: true, data: await authService.refresh(refreshToken) });
});

/** POST /api/auth/logout — revokes the refresh token */
export const logout = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  await authService.logout(refreshToken);
  res.json({ success: true, message: 'Logged out' });
});

/** GET /api/auth/users (CEO, ADMIN) — list company users */
export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await authService.listUsers(req.user!.companyId) });
});

/** GET /api/auth/me */
export const me = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await authService.me(req.user!.companyId, req.user!.sub) });
});
