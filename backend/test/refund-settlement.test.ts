import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import { refundService, settlementStatus } from '../src/modules/payments/refund.service';

const makeConn = () => ({ query: vi.fn().mockResolvedValue([[], []]) }) as unknown as PoolConnection;

const invoice = (over: Record<string, unknown> = {}) => ({
  id: 6, invoice_no: 'INV-2026-00006', customer_id: 1,
  total: 10000, paid_amount: 0, status: 'UNPAID', ...over,
}) as any;

describe('settlementStatus', () => {
  it('derives status from what has actually been received', () => {
    expect(settlementStatus(0, 10000)).toBe('UNPAID');
    expect(settlementStatus(4000, 10000)).toBe('PARTIAL');
    expect(settlementStatus(10000, 10000)).toBe('PAID');
    // Guards against a rounding overshoot ever reading as PARTIAL.
    expect(settlementStatus(10000.004, 10000)).toBe('PAID');
  });
});

describe('refundService.applyReceiptTx', () => {
  let conn: PoolConnection;
  beforeEach(() => { conn = makeConn(); });

  it('rolls an invoice UNPAID -> PARTIAL -> PAID', async () => {
    const first = await refundService.applyReceiptTx(conn, invoice(), 4000);
    expect(first).toMatchObject({ paid: 4000, due: 6000, status: 'PARTIAL' });

    const second = await refundService.applyReceiptTx(conn, invoice({ paid_amount: 4000, status: 'PARTIAL' }), 6000);
    expect(second).toMatchObject({ paid: 10000, due: 0, status: 'PAID' });
  });

  it('rejects a receipt larger than the outstanding due', async () => {
    await expect(refundService.applyReceiptTx(conn, invoice({ paid_amount: 4000 }), 6000.01))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects any receipt against a void invoice', async () => {
    await expect(refundService.applyReceiptTx(conn, invoice({ status: 'VOID' }), 100))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('refundService.applyRefundTx', () => {
  let conn: PoolConnection;
  beforeEach(() => { conn = makeConn(); });

  it('rolls an invoice PAID -> PARTIAL -> UNPAID', async () => {
    const partial = await refundService.applyRefundTx(conn, invoice({ paid_amount: 10000, status: 'PAID' }), 6000);
    expect(partial).toMatchObject({ paid: 4000, due: 6000, status: 'PARTIAL' });

    const unpaid = await refundService.applyRefundTx(conn, invoice({ paid_amount: 4000, status: 'PARTIAL' }), 4000);
    expect(unpaid).toMatchObject({ paid: 0, due: 10000, status: 'UNPAID' });
  });

  it('refuses to refund more than was ever received', async () => {
    await expect(refundService.applyRefundTx(conn, invoice({ paid_amount: 4000, status: 'PARTIAL' }), 4000.01))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses to refund an invoice nobody has paid', async () => {
    await expect(refundService.applyRefundTx(conn, invoice(), 100))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('keeps a void invoice void while still correcting what was collected', async () => {
    const result = await refundService.applyRefundTx(
      conn, invoice({ paid_amount: 10000, status: 'VOID' }), 10000);
    expect(result.status).toBe('VOID');
    expect(result.paid).toBe(0);
  });
});

describe('refundService.lockInvoiceForSettlementTx', () => {
  it('refuses to settle an invoice belonging to another customer', async () => {
    const conn = { query: vi.fn().mockResolvedValue([[invoice({ customer_id: 2 })], []]) } as unknown as PoolConnection;
    await expect(refundService.lockInvoiceForSettlementTx(conn, 1, 6, 1))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('404s when the invoice is not in this company', async () => {
    const conn = { query: vi.fn().mockResolvedValue([[], []]) } as unknown as PoolConnection;
    await expect(refundService.lockInvoiceForSettlementTx(conn, 1, 6, 1))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
