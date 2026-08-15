import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../middleware/audit';
import { bookingsService } from './bookings.service';
import { isoDateSchema, parseId } from '../../utils/validation';
import { listQuerySchema } from '../../utils/paging';

const createSchema = z.object({
  customerId: z.number().int().positive(),
  bookingType: z.enum(['FLIGHT', 'HOTEL', 'TOUR']),
  travelDate: isoDateSchema.optional(),
  returnDate: isoDateSchema.optional(),
  details: z.record(z.any()).optional(),
  costPrice: z.number().nonnegative(),
  salePrice: z.number().nonnegative(),
  supplierId: z.number().int().positive().optional(),
  agentId: z.number().int().positive().optional()
});

const confirmSchema = z.object({
  vatPercent: z.number().min(0).max(100).optional(),
  discount: z.number().min(0).optional(),
  dueDate: isoDateSchema.optional(),
  // The date revenue is recognised on. Optional (today when omitted) so the
  // common case stays a one-click confirm, but supplying it is what makes
  // month-end cut-off and historical data entry possible.
  invoiceDate: isoDateSchema.optional(),
});

/**
 * GET /api/bookings?status=PENDING&type=FLIGHT&q=tanvir
 * Response 200:
 * { "success": true, "data": [ { "id": 7, "booking_no": "BK-2026-00007",
 *     "booking_type": "FLIGHT", "status": "CONFIRMED",
 *     "customer_name": "Tanvir Ahmed", "sale_price": 56500, "margin": 6500,
 *     "invoice_no": "INV-2026-00005" } ] }
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const filters = z.object({
    status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED']).optional(),
    type: z.enum(['FLIGHT', 'HOTEL', 'TOUR']).optional(),
    customerId: z.coerce.number().int().positive().optional(),
    q: z.string().trim().max(120).optional(),
  }).parse(req.query);
  const page = listQuerySchema.parse(req.query);
  res.json({ success: true, ...await bookingsService.list(req.user!.companyId, filters, page) });
});

/** GET /api/bookings/:id */
export const get = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await bookingsService.get(req.user!.companyId, parseId(req.params.id)) });
});

/** GET /api/bookings/history/:customerId — customer travel history */
export const history = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true,
    data: await bookingsService.travelHistory(req.user!.companyId, parseId(req.params.customerId)) });
});

/**
 * POST /api/bookings
 * Request:
 * { "customerId": 1, "bookingType": "FLIGHT", "travelDate": "2026-07-15",
 *   "details": { "pnr": "AB12CD", "route": "DAC-DXB-DAC", "airline": "Biman", "pax": 2 },
 *   "costPrice": 50000, "salePrice": 56500, "supplierId": 1, "agentId": 1 }
 * Response 201:
 * { "success": true, "data": { "id": 8, "bookingNo": "BK-2026-00008", "status": "PENDING" } }
 */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const input = createSchema.parse(req.body);
  const data = await bookingsService.create(req.user!.companyId, req.user!.sub, input);
  await audit(req, 'BOOKING_CREATE', 'bookings', data.id, { bookingNo: data.bookingNo, type: input.bookingType });
  res.status(201).json({ success: true, data });
});

/**
 * POST /api/bookings/:id/confirm — generates the invoice + posts SALES voucher
 * Request: { "vatPercent": 5, "discount": 500, "dueDate": "2026-07-01" }
 * Response 200:
 * { "success": true, "data": { "bookingId": 8, "status": "CONFIRMED",
 *   "invoice": { "invoiceNo": "INV-2026-00006", "subtotal": 56500, "discount": 500,
 *                "vatPercent": 5, "vatAmount": 2800, "total": 58800 },
 *   "salesVoucherNo": "SV-2026-00014", "purchaseVoucherNo": "PUR-2026-00003" } }
 */
export const confirm = asyncHandler(async (req: Request, res: Response) => {
  const input = confirmSchema.parse(req.body ?? {});
  const data = await bookingsService.confirm(req.user!.companyId, req.user!.sub, parseId(req.params.id), input);
  await audit(req, 'BOOKING_CONFIRM', 'bookings', data.bookingId, { invoice: data.invoice.invoiceNo });
  res.json({ success: true, data });
});

/**
 * POST /api/bookings/:id/cancel
 * Request: { "reason": "Customer changed plans" }
 * Response 200:
 * { "success": true, "data": { "bookingId": 8, "status": "CANCELLED", "creditNoteNo": "CN-2026-00001" } }
 */
export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    reason: z.string().trim().max(255).optional(),
    // Reversal date. Defaults to today, which is what allows a booking
    // confirmed inside a now-locked period to still be cancelled.
    date: isoDateSchema.optional(),
  }).parse(req.body ?? {});
  const data = await bookingsService.cancel(
    req.user!.companyId, req.user!.sub, parseId(req.params.id), body);
  await audit(req, 'BOOKING_CANCEL', 'bookings', data.bookingId,
    { reason: body.reason, reversalDate: data.reversalDate });
  res.json({ success: true, data });
});
