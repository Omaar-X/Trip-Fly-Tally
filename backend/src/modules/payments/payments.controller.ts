import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../middleware/audit';
import { ApiError } from '../../utils/ApiError';
import { paymentsService } from './payments.service';
import { isoDateSchema, parseId } from '../../utils/validation';
import { listQuerySchema } from '../../utils/paging';
import { ROLE } from '../../constants/roles';

const recordSchema = z.object({
  direction: z.enum(['IN', 'OUT']),
  // Canonical counterparty; customerId/supplierId remain accepted as aliases.
  counterpartyType: z.enum(['CUSTOMER', 'SUPPLIER']).optional(),
  counterpartyId: z.number().int().positive().optional(),
  customerId: z.number().int().positive().optional(),
  supplierId: z.number().int().positive().optional(),
  invoiceId: z.number().int().positive().optional(),
  refundOfPaymentId: z.number().int().positive().optional(),
  method: z.enum(['CASH', 'BANK', 'BKASH', 'NAGAD', 'CARD']),
  amount: z.number().positive(),
  paymentDate: isoDateSchema,
  notes: z.string().max(255).optional(),
  reason: z.string().max(255).optional()
}).refine(v => !(v.counterpartyType && !v.counterpartyId) && !(v.counterpartyId && !v.counterpartyType),
  { message: 'counterpartyType and counterpartyId must be sent together', path: ['counterpartyId'] });

/**
 * GET /api/payments?direction=IN&from=2026-06-01&to=2026-06-30
 * Response 200:
 * { "success": true, "data": [ { "payment_no": "PMT-2026-00011", "direction": "IN",
 *     "method": "BKASH", "amount": 20000, "customer_name": "Tanvir Ahmed",
 *     "invoice_no": "INV-2026-00006", "voucher_no": "RV-2026-00009" } ] }
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const filters = z.object({
    direction: z.enum(['IN', 'OUT']).optional(),
    counterpartyType: z.enum(['CUSTOMER', 'SUPPLIER']).optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    q: z.string().trim().max(120).optional(),
  }).parse(req.query);
  const page = listQuerySchema.parse(req.query);
  res.json({ success: true, ...await paymentsService.list(req.user!.companyId, filters, page) });
});

/**
 * POST /api/payments — every movement of money, in either direction.
 *
 * The counterparty is given as counterpartyType + counterpartyId. The legacy
 * customerId / supplierId fields are still accepted and mean the same thing.
 *
 *   IN  + CUSTOMER   customer pays us         (receipt)
 *   OUT + CUSTOMER   we refund a customer     (refund)
 *   OUT + SUPPLIER   we pay a supplier        (supplier payment)
 *   IN  + SUPPLIER   supplier credits us back (supplier refund)
 *
 * Request (customer receipt settling an invoice):
 * { "direction": "IN", "counterpartyType": "CUSTOMER", "counterpartyId": 1,
 *   "invoiceId": 6, "method": "BKASH", "amount": 20000, "paymentDate": "2026-06-10" }
 * Response 201:
 * { "success": true, "data": { "id": 12, "paymentNo": "PMT-2026-00012",
 *     "isRefund": false, "voucherNo": "RV-2026-00010",
 *     "invoice": { "invoiceNo": "INV-2026-00006", "paid": 20000, "due": 39325, "status": "PARTIAL" } } }
 *
 * Request (customer refund — releases the invoice so the booking can cancel):
 * { "direction": "OUT", "counterpartyType": "CUSTOMER", "counterpartyId": 1,
 *   "invoiceId": 6, "method": "BKASH", "amount": 20000, "paymentDate": "2026-06-12",
 *   "reason": "Trip cancelled by customer" }
 *
 * Request (supplier payment):
 * { "direction": "OUT", "counterpartyType": "SUPPLIER", "counterpartyId": 1,
 *   "method": "BANK", "amount": 50000, "paymentDate": "2026-06-10" }
 */
export const record = asyncHandler(async (req: Request, res: Response) => {
  const input = recordSchema.parse(req.body);
  // Sales' "Collection" scope covers receiving money from customers — paying
  // suppliers and issuing refunds both move money out and stay with Accounts.
  if (req.user!.role === ROLE.SALES && input.direction !== 'IN')
    throw ApiError.forbidden('Sales can only record incoming payments (collections)');
  const data = await paymentsService.record(req.user!.companyId, req.user!.sub, input);
  await audit(req, data.isRefund ? 'PAYMENT_REFUND' : 'PAYMENT_RECORD', 'payments', data.id, {
    paymentNo: data.paymentNo, direction: input.direction,
    counterpartyType: data.counterpartyType, counterpartyId: data.counterpartyId,
    amount: input.amount, invoiceNo: data.invoice?.invoiceNo, reason: input.reason
  });
  res.status(201).json({ success: true, data });
});

/**
 * POST /api/payments/:id/reverse — undo a payment recorded in error.
 *
 * Posts a mirrored voucher (the original is never edited or deleted) AND puts
 * the invoice's collected figure back where it stood, in one transaction. The
 * reversal lands in the open period, so a payment inside a locked year can be
 * corrected without reopening it.
 *
 * Request:  { "reason": "Recorded against the wrong customer" }
 * Response: { "success": true, "data": { "paymentNo": "PMT-2026-2027-00012",
 *             "reversalVoucherNo": "PV-2026-2027-00031", "reversalDate": "2026-08-10",
 *             "invoice": { "invoiceNo": "INV-…", "paid": 0, "due": 59325, "status": "UNPAID" } } }
 */
export const reverse = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    reason: z.string().trim().min(1).max(255),
    date: isoDateSchema.optional(),
  }).parse(req.body);

  const data = await paymentsService.reverse(
    req.user!.companyId, req.user!.sub, parseId(req.params.id), body);

  await audit(req, 'PAYMENT_REVERSE', 'payments', data.id, {
    paymentNo: data.paymentNo, reversalVoucherNo: data.reversalVoucherNo,
    amount: data.amount, reason: body.reason,
  });
  res.json({ success: true, data });
});
