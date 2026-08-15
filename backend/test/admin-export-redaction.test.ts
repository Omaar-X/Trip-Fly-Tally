import { describe, it, expect } from 'vitest';
import { isSecretColumn } from '../src/modules/adminDatabase/adminDatabase.service';

/**
 * The admin browser and backup export used to return every column verbatim,
 * which handed out bcrypt password hashes and refresh-token hashes in a file
 * people download and archive. These assertions pin the redaction rule itself;
 * the live end-to-end proof that no hash survives an export is in the
 * integration suite.
 */
describe('isSecretColumn', () => {
  it.each([
    'password_hash', 'PASSWORD_HASH', 'refresh_token_hash', 'token_hash',
    'otp_secret', 'mfa_secret', 'totp_secret',
    'reset_token', 'verification_token', 'api_key', 'private_key',
  ])('redacts %s', (column) => {
    expect(isSecretColumn(column)).toBe(true);
  });

  it.each([
    'password_reset_token', 'user_password', 'client_secret',
    'session_token', 'access_token', 'credential_id',
  ])('redacts %s by pattern, so a newly added column is covered on day one', (column) => {
    expect(isSecretColumn(column)).toBe(true);
  });

  it.each([
    'id', 'company_id', 'name', 'email', 'is_active', 'created_at',
    'amount', 'voucher_no', 'invoice_no', 'status', 'entry_type',
    'expires_at', 'revoked_at', 'user_id',
  ])('keeps ordinary column %s visible', (column) => {
    expect(isSecretColumn(column)).toBe(false);
  });
});
