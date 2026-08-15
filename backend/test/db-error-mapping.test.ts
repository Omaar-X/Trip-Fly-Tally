import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/modules/accounting/accounting.service', () => ({
  accountingService: {
    postVoucher: vi.fn(), createLedger: vi.fn(), listGroups: vi.fn(),
    listLedgers: vi.fn(), ledgerStatement: vi.fn(), listVouchers: vi.fn(), getVoucher: vi.fn(),
  },
  postVoucherTx: vi.fn(),
}));

import { app } from '../src/app';
import { accountingService } from '../src/modules/accounting/accounting.service';
import { ROLE } from '../src/constants/roles';
import { authHeader } from './helpers/token';

/** Shapes a mysql2 driver error the way the pool actually surfaces one. */
const dbError = (code: string, errno: number, sqlMessage: string) =>
  Object.assign(new Error(sqlMessage), { code, errno, sqlMessage, sqlState: '23000' });

const postVoucher = () =>
  request(app).post('/api/vouchers').set(authHeader(ROLE.ACCOUNTANT)).send({
    type: 'JOURNAL', date: '2026-08-01',
    entries: [{ ledgerId: 1, type: 'DR', amount: 10 }, { ledgerId: 4, type: 'CR', amount: 10 }],
  });

describe('database errors become proper API responses', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['ER_NO_REFERENCED_ROW_2', 1452, 400, 'a missing foreign key is the caller sending a bad id'],
    ['ER_DUP_ENTRY',           1062, 409, 'a uniqueness clash is a conflict'],
    ['ER_WARN_DATA_OUT_OF_RANGE', 1264, 400, 'an oversized amount is bad input'],
    ['ER_ROW_IS_REFERENCED_2', 1451, 409, 'deleting something still in use is a conflict'],
    ['ER_DATA_TOO_LONG',       1406, 400, 'an overlong value is bad input'],
    ['ER_BAD_NULL_ERROR',      1048, 400, 'a missing required column is bad input'],
    ['ER_LOCK_DEADLOCK',       1213, 409, 'a deadlock is retryable, not a crash'],
  ])('%s -> HTTP %i (%s)', async (code, errno, expected) => {
    vi.mocked(accountingService.postVoucher).mockRejectedValue(
      dbError(code, errno, `raw driver text mentioning voucher_entries and information_schema`));

    const res = await postVoucher();

    expect(res.status).toBe(expected);
    expect(res.body.success).toBe(false);
  });

  it('never leaks SQL, table names or driver internals to the client', async () => {
    vi.mocked(accountingService.postVoucher).mockRejectedValue(dbError(
      'ER_NO_REFERENCED_ROW_2', 1452,
      "Cannot add or update a child row: FOREIGN KEY (`ledger_id`) REFERENCES `ledgers` (`id`)"));

    const res = await postVoucher();
    const body = JSON.stringify(res.body);

    expect(res.status).toBe(400);
    expect(body).not.toMatch(/FOREIGN KEY|ledgers|voucher_entries|information_schema|SELECT|INSERT/i);
  });

  it('still returns 500 for a genuinely unexpected failure', async () => {
    vi.mocked(accountingService.postVoucher).mockRejectedValue(new Error('something truly unexpected'));

    const res = await postVoucher();

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('something truly unexpected');
  });
});
