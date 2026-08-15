import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { PoolConnection } from 'mysql2/promise';

vi.mock('../src/modules/bookings/bookings.service', () => ({
  bookingsService: {
    list: vi.fn(), get: vi.fn(), travelHistory: vi.fn(),
    create: vi.fn(), confirm: vi.fn(), cancel: vi.fn(),
  },
}));

vi.mock('../src/modules/accounting/reversal.service', () => ({
  financialReversalService: { reverseVoucherTx: vi.fn(), reverseIfActiveTx: vi.fn() },
}));

import { app } from '../src/app';
import { bookingsService } from '../src/modules/bookings/bookings.service';
import { bookingAccountingService } from '../src/modules/bookings/bookingAccounting.service';
import { financialReversalService } from '../src/modules/accounting/reversal.service';
import { ROLE } from '../src/constants/roles';
import { authHeader } from './helpers/token';
import { ApiError } from '../src/utils/ApiError';

describe('POST /api/bookings/:id/cancel — contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports both reversal vouchers, keeping creditNoteNo for existing clients', async () => {
    vi.mocked(bookingsService.cancel).mockResolvedValue({
      bookingId: 8, status: 'CANCELLED',
      creditNoteNo: 'CN-2026-00003',
      salesReversalVoucherNo: 'CN-2026-00003',
      purchaseReversalVoucherNo: 'DN-2026-00002',
      invoiceVoided: true,
    } as any);

    const res = await request(app).post('/api/bookings/8/cancel')
      .set(authHeader(ROLE.ACCOUNTANT)).send({ reason: 'Customer cancelled' });

    expect(res.status).toBe(200);
    expect(res.body.data.salesReversalVoucherNo).toBe('CN-2026-00003');
    expect(res.body.data.purchaseReversalVoucherNo).toBe('DN-2026-00002');
    expect(res.body.data.creditNoteNo).toBe('CN-2026-00003');
  });

  it('surfaces the settlement block as 409 with refund instructions', async () => {
    vi.mocked(bookingsService.cancel).mockRejectedValue(ApiError.conflict(
      'Invoice INV-2026-00006 is fully paid (42000.00 received). Refund it first: ' +
      'POST /api/payments { "direction": "OUT", "counterpartyType": "CUSTOMER", ... }'));

    const res = await request(app).post('/api/bookings/8/cancel')
      .set(authHeader(ROLE.ACCOUNTANT)).send({});

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Refund it first');
    expect(res.body.message).toContain('counterpartyType');
  });

  it('keeps HR out of booking cancellation', async () => {
    const res = await request(app).post('/api/bookings/8/cancel').set(authHeader(ROLE.HR)).send({});
    expect(res.status).toBe(403);
    expect(bookingsService.cancel).not.toHaveBeenCalled();
  });
});

describe('bookingAccountingService.reverseBookingAccountingTx', () => {
  const conn = { query: vi.fn().mockResolvedValue([[], []]) } as unknown as PoolConnection;

  beforeEach(() => {
    vi.clearAllMocks();
    (conn.query as any).mockResolvedValue([[], []]);
  });

  const booking = (over: Record<string, unknown> = {}) => ({
    id: 8, booking_no: 'BK-2026-00008', customer_id: 1, booking_type: 'FLIGHT',
    invoice_id: 6, purchase_voucher_id: 56, ...over,
  }) as any;

  it('reverses BOTH the sales and the supplier-cost voucher', async () => {
    (conn.query as any).mockResolvedValueOnce([[{ id: 6, voucher_id: 55, status: 'UNPAID' }], []]);
    vi.mocked(financialReversalService.reverseIfActiveTx)
      .mockResolvedValueOnce({ reversalVoucherNo: 'CN-2026-00003' } as any)
      .mockResolvedValueOnce({ reversalVoucherNo: 'DN-2026-00002' } as any);

    const result = await bookingAccountingService.reverseBookingAccountingTx(conn, 1, 7, booking(), 'cancelled');

    expect(financialReversalService.reverseIfActiveTx).toHaveBeenCalledTimes(2);
    // sales voucher comes from the invoice, purchase voucher from the booking
    expect(vi.mocked(financialReversalService.reverseIfActiveTx).mock.calls[0][3]).toBe(55);
    expect(vi.mocked(financialReversalService.reverseIfActiveTx).mock.calls[1][3]).toBe(56);
    expect(result.salesReversal).toMatchObject({ reversalVoucherNo: 'CN-2026-00003' });
    expect(result.purchaseReversal).toMatchObject({ reversalVoucherNo: 'DN-2026-00002' });
    expect(result.invoiceVoided).toBe(true);
  });

  it('still reverses the sales side when the booking had no supplier cost', async () => {
    (conn.query as any).mockResolvedValueOnce([[{ id: 6, voucher_id: 55, status: 'UNPAID' }], []]);
    vi.mocked(financialReversalService.reverseIfActiveTx)
      .mockResolvedValueOnce({ reversalVoucherNo: 'CN-2026-00004' } as any)
      .mockResolvedValueOnce(null);

    const result = await bookingAccountingService.reverseBookingAccountingTx(
      conn, 1, 7, booking({ purchase_voucher_id: null }));

    expect(result.salesReversal).not.toBeNull();
    expect(result.purchaseReversal).toBeNull();
  });

  it('does not re-void an invoice that is already void', async () => {
    (conn.query as any).mockResolvedValueOnce([[{ id: 6, voucher_id: 55, status: 'VOID' }], []]);
    vi.mocked(financialReversalService.reverseIfActiveTx).mockResolvedValue(null);

    const result = await bookingAccountingService.reverseBookingAccountingTx(conn, 1, 7, booking());

    expect(result.invoiceVoided).toBe(false);
  });
});
