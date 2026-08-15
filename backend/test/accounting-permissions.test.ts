import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/modules/accounting/accounting.service', () => ({
  accountingService: {
    postVoucher: vi.fn(),
    createLedger: vi.fn(),
    listGroups: vi.fn(),
    listLedgers: vi.fn(),
    ledgerStatement: vi.fn(),
    listVouchers: vi.fn(),
    getVoucher: vi.fn(),
  },
}));

import { app } from '../src/app';
import { accountingService } from '../src/modules/accounting/accounting.service';
import { ROLE } from '../src/constants/roles';
import { authHeader } from './helpers/token';

const validVoucher = {
  type: 'JOURNAL',
  date: '2026-07-30',
  entries: [
    { ledgerId: 1, type: 'DR', amount: 100 },
    { ledgerId: 2, type: 'CR', amount: 100 },
  ],
};

describe('Accounting permissions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ACCOUNTANT can post a balanced voucher', async () => {
    vi.mocked(accountingService.postVoucher).mockResolvedValue({ voucherId: 1, voucherNo: 'JV-2026-0001' } as any);

    const res = await request(app).post('/api/vouchers').set(authHeader(ROLE.ACCOUNTANT)).send(validVoucher);

    expect(res.status).toBe(201);
    expect(accountingService.postVoucher).toHaveBeenCalledOnce();
  });

  it('ADMIN and SALES are rejected before the service runs (Accountant-exclusive)', async () => {
    for (const role of [ROLE.ADMIN, ROLE.SALES] as const) {
      const res = await request(app).post('/api/vouchers').set(authHeader(role)).send(validVoucher);
      expect(res.status).toBe(403);
    }
    expect(accountingService.postVoucher).not.toHaveBeenCalled();
  });

  it('ledger reads have no role gate — SALES can read the ledger list for invoice dropdowns', async () => {
    vi.mocked(accountingService.listLedgers).mockResolvedValue([{ id: 1, name: 'Cash in Hand' }] as any);

    const res = await request(app).get('/api/ledgers').set(authHeader(ROLE.SALES));

    expect(res.status).toBe(200);
  });

  it('ledger-group reads are allowed for CEO, ADMIN, ACCOUNTANT', async () => {
    vi.mocked(accountingService.listGroups).mockResolvedValue([{ id: 1, name: 'Assets' }] as any);

    for (const role of [ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT] as const) {
      const res = await request(app).get('/api/ledger-groups').set(authHeader(role));
      expect(res.status).toBe(200);
    }
  });

  it('ledger-group reads are denied for SALES and HR', async () => {
    for (const role of [ROLE.SALES, ROLE.HR] as const) {
      const res = await request(app).get('/api/ledger-groups').set(authHeader(role));
      expect(res.status).toBe(403);
    }
    expect(accountingService.listGroups).not.toHaveBeenCalled();
  });
});
