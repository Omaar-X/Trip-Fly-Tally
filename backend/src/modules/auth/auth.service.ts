import bcrypt from 'bcryptjs';
import { query, exec, Row } from '../../config/db';
import { env } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { signAccessToken, generateRefreshToken, hashRefreshToken } from '../../utils/jwt';
import { randomInt, createHash } from 'node:crypto';
import { sendPasswordResetOtp } from '../../utils/mailer';

interface UserRow extends Row {
  id: number; company_id: number; name: string; email: string;
  password_hash: string; is_active: number; approval_status: string; role: string;
}

// const findByEmail = async (email: string): Promise<UserRow | undefined> => {
//   const rows = await query<UserRow[]>(
//     `SELECT u.id, u.company_id, u.name, u.email, u.password_hash, u.is_active, r.name AS role
//        FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ?`, [email]);
//   return rows[0];
// };

const findByEmail = async (email: string): Promise<UserRow | undefined> => {
  const rows = await query<UserRow[]>(
    `SELECT u.id, u.company_id, u.name, u.email, u.password_hash, u.is_active, u.approval_status, r.name AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.email = ?`,
    [email]
  );

  return rows[0];
};

const issueTokens = async (user: UserRow) => {
  const accessToken = signAccessToken({
    sub: user.id, companyId: user.company_id, role: user.role, name: user.name, email: user.email
  });
  const { token: refreshToken, hash, expiresAt } = generateRefreshToken();
  await exec('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?,?,?)',
    [user.id, hash, expiresAt]);
  return {
    accessToken, refreshToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, companyId: user.company_id }
  };
};

const otpHash = (otp: string) => createHash('sha256').update(otp).digest('hex');

export const authService = {
  async login(email: string, password: string) {
    const user = await findByEmail(email);
    if (!user) throw ApiError.unauthorized('Invalid email or password');
    if (user.approval_status === 'PENDING') throw ApiError.unauthorized('Registration is waiting for CEO approval');
    if (user.approval_status === 'REJECTED') throw ApiError.unauthorized('Registration was rejected by the CEO');
    if (!user.is_active) throw ApiError.unauthorized('Invalid email or password');
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw ApiError.unauthorized('Invalid email or password');
    return issueTokens(user);
  },

  async requestPasswordReset(email: string) {
    const user = await findByEmail(email);
    // Do not reveal whether an email is registered.
    if (!user || !user.is_active || user.approval_status !== 'APPROVED') return;
    const otp = String(randomInt(100000, 1000000));
    await exec('UPDATE password_reset_otps SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [user.id]);
    await exec(
      'INSERT INTO password_reset_otps (user_id, otp_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))',
      [user.id, otpHash(otp)]
    );
    try {
      await sendPasswordResetOtp(user.email, otp);
    } catch (error) {
      await exec('UPDATE password_reset_otps SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [user.id]);
      throw error;
    }
  },

  async resetPassword(input: { email: string; otp: string; password: string }) {
    const user = await findByEmail(input.email);
    if (!user || !user.is_active || user.approval_status !== 'APPROVED') {
      throw ApiError.badRequest('Invalid or expired reset code');
    }
    const rows = await query<Row[]>(
      `SELECT id, otp_hash, attempts FROM password_reset_otps
        WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW()
        ORDER BY id DESC LIMIT 1`, [user.id]);
    const reset = rows[0];
    if (!reset || Number(reset.attempts) >= 5) throw ApiError.badRequest('Invalid or expired reset code');
    if (otpHash(input.otp) !== reset.otp_hash) {
      await exec('UPDATE password_reset_otps SET attempts = attempts + 1 WHERE id = ?', [reset.id]);
      throw ApiError.badRequest('Invalid or expired reset code');
    }
    const hash = await bcrypt.hash(input.password, env.bcryptRounds);
    await exec('UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?', [hash, user.id]);
    await exec('UPDATE password_reset_otps SET used_at = NOW() WHERE id = ?', [reset.id]);
    await exec('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [user.id]);
  },

  async register(input: { name: string; email: string; password: string; role: string }) {
    if (input.role === 'CEO') throw ApiError.badRequest('CEO registration is not available');
    const existing = await findByEmail(input.email);
    if (existing) throw ApiError.conflict('Email already registered');
    const roleRows = await query<Row[]>('SELECT id FROM roles WHERE name = ?', [input.role]);
    if (!roleRows[0]) throw ApiError.badRequest(`Unknown role: ${input.role}`);
    const hash = await bcrypt.hash(input.password, env.bcryptRounds);
    const result = await exec(
      'INSERT INTO users (company_id, role_id, name, email, password_hash, approval_status, is_active) VALUES (1,?,?,?,?,?,1)',
      [roleRows[0].id, input.name, input.email, hash, 'PENDING']);
    return { id: result.insertId, name: input.name, email: input.email, role: input.role, approvalStatus: 'PENDING' };
  },

  async setApproval(companyId: number, userId: number, status: 'APPROVED' | 'REJECTED') {
    const rows = await query<Row[]>(`SELECT u.id, u.name, u.email, r.name AS role
      FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.id = ?`, [companyId, userId]);
    if (!rows[0]) throw ApiError.notFound('User not found');
    if (rows[0].role === 'CEO') throw ApiError.badRequest('CEO account cannot be changed here');
    await exec('UPDATE users SET approval_status = ?, is_active = ? WHERE company_id = ? AND id = ?',
      [status, status === 'APPROVED' ? 1 : 0, companyId, userId]);
    return { ...(rows[0] as any), approvalStatus: status, is_active: status === 'APPROVED' ? 1 : 0 } as any;
  },

  /** Refresh-token rotation: old token is revoked, a new pair is issued. */
  async refresh(refreshToken: string) {
    const hash = hashRefreshToken(refreshToken);
    const rows = await query<Row[]>(
      `SELECT rt.id, rt.user_id FROM refresh_tokens rt
        WHERE rt.token_hash = ? AND rt.revoked_at IS NULL AND rt.expires_at > NOW()`, [hash]);
    const stored = rows[0];
    if (!stored) throw ApiError.unauthorized('Refresh token invalid or expired');
    await exec('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [stored.id]);
    const userRows = await query<UserRow[]>(
      `SELECT u.id, u.company_id, u.name, u.email, u.password_hash, u.is_active, u.approval_status, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, [stored.user_id]);
    if (!userRows[0] || !userRows[0].is_active || userRows[0].approval_status !== 'APPROVED') throw ApiError.unauthorized('User is not approved');
    return issueTokens(userRows[0]);
  },

  async logout(refreshToken: string) {
    await exec('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ?',
      [hashRefreshToken(refreshToken)]);
  },

  async listUsers(companyId: number) {
    return query<Row[]>(
      `SELECT u.id, u.name, u.email, u.is_active, u.approval_status, r.name AS role, u.created_at
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.company_id = ? ORDER BY u.id`, [companyId]);
  },

  async me(companyId: number, userId: number) {
    const rows = await query<UserRow[]>(
      `SELECT u.id, u.company_id, u.name, u.email, u.password_hash, u.is_active, u.approval_status, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.company_id = ? AND u.id = ?`,
      [companyId, userId]
    );
    const user = rows[0];
    if (!user || !user.is_active) throw ApiError.unauthorized('User disabled');
    return { id: user.id, name: user.name, email: user.email, role: user.role, companyId: user.company_id };
  }
};
