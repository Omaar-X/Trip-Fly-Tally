import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/modules/payments/payments.service', () => ({
  paymentsService: { list: vi.fn(), record: vi.fn() },
}));

import { app } from '../src/app';
import { paymentsService } from '../src/modules/payments/payments.service';
import { ROLE } from '../src/constants/roles';
import { authHeader } from './helpers/token';

const recorded = (over: Record<string, unknown> = {}) => ({
  id: 12, paymentNo: 'PMT-2026-00012', direction: 'IN',
  counterpartyType: 'CUSTOMER', counterpartyId: 1, isRefund: false,
  voucherNo: 'RV-2026-00010', invoice: null, ...over,
});

const post = (body: unknown, role: (typeof ROLE)[keyof typeof ROLE] = ROLE.ACCOUNTANT) =>
  request(app).post('/api/payments').set(authHeader(role)).send(body);

const base = { method: 'CASH', amount: 5000, paymentDate: '2026-08-02' };

describe('POST /api/payments — generic counterparty model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(paymentsService.record).mockResolvedValue(recorded() as any);
  });

  it.each([
    ['IN',  'CUSTOMER', 'customer receipt'],
    ['OUT', 'CUSTOMER', 'customer refund'],
    ['OUT', 'SUPPLIER', 'supplier payment'],
    ['IN',  'SUPPLIER', 'supplier credit'],
  ])('accepts %s + %s (%s)', async (direction, counterpartyType) => {
    const res = await post({ ...base, direction, counterpartyType, counterpartyId: 1 });

    expect(res.status).toBe(201);
    expect(paymentsService.record).toHaveBeenCalledWith(
      expect.any(Number), expect.any(Number),
      expect.objectContaining({ direction, counterpartyType, counterpartyId: 1 }));
  });

  it('still accepts the legacy customerId / supplierId shape', async () => {
    await post({ ...base, direction: 'IN', customerId: 3 });
    expect(paymentsService.record).toHaveBeenCalledWith(
      expect.any(Number), expect.any(Number), expect.objectContaining({ customerId: 3 }));

    await post({ ...base, direction: 'OUT', supplierId: 4 });
    expect(paymentsService.record).toHaveBeenLastCalledWith(
      expect.any(Number), expect.any(Number), expect.objectContaining({ supplierId: 4 }));
  });

  it('rejects a half-specified counterparty before reaching the service', async () => {
    const res = await post({ ...base, direction: 'IN', counterpartyType: 'CUSTOMER' });
    expect(res.status).toBe(400);
    expect(paymentsService.record).not.toHaveBeenCalled();
  });

  it('keeps Sales locked out of outgoing money, including refunds', async () => {
    const res = await post(
      { ...base, direction: 'OUT', counterpartyType: 'CUSTOMER', counterpartyId: 1 }, ROLE.SALES);

    expect(res.status).toBe(403);
    expect(paymentsService.record).not.toHaveBeenCalled();
  });

  it('lets Sales record an incoming collection', async () => {
    const res = await post(
      { ...base, direction: 'IN', counterpartyType: 'CUSTOMER', counterpartyId: 1 }, ROLE.SALES);
    expect(res.status).toBe(201);
  });

  it('audits a refund distinctly from an ordinary payment', async () => {
    vi.mocked(paymentsService.record).mockResolvedValue(
      recorded({ direction: 'OUT', isRefund: true, paymentNo: 'REF-2026-00013' }) as any);

    const res = await post({
      ...base, direction: 'OUT', counterpartyType: 'CUSTOMER', counterpartyId: 1,
      invoiceId: 6, reason: 'Trip cancelled',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.isRefund).toBe(true);
    expect(res.body.data.paymentNo).toMatch(/^REF-/);
  });

  it('rejects a non-positive amount', async () => {
    for (const amount of [0, -100]) {
      const res = await post({ ...base, amount, direction: 'IN', counterpartyType: 'CUSTOMER', counterpartyId: 1 });
      expect(res.status).toBe(400);
    }
    expect(paymentsService.record).not.toHaveBeenCalled();
  });
});
