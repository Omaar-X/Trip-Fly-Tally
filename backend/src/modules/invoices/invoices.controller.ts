import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../middleware/audit';
import { invoicesService } from './invoices.service';
import { renderInvoicePdf } from './invoice.pdf';
import { isoDateSchema, parseId } from '../../utils/validation';
import { listQuerySchema } from '../../utils/paging';

const manualSchema = z.object({
  customerId: z.number().int().positive(),
  invoiceDate: isoDateSchema,
  dueDate: isoDateSchema.optional(),
  incomeLedgerId: z.number().int().positive(),
  discount: z.number().min(0).optional(),
  vatPercent: z.number().min(0).max(100).optional(),
  items: z.array(z.object({
    description: z.string().min(1).max(255),
    quantity: z.number().positive(),
    rate: z.number().positive()
  })).min(1)
});

/**
 * GET /api/invoices?status=PARTIAL&q=tanvir
 * Response 200:
 * { "success": true, "data": [ { "invoice_no": "INV-2026-00006", "customer_name": "Tanvir Ahmed",
 *     "total": 58800, "paid_amount": 20000, "due": 38800, "status": "PARTIAL" } ] }
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const filters = z.object({
    status: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'VOID']).optional(),
    customerId: z.coerce.number().int().positive().optional(),
    q: z.string().trim().max(120).optional(),
  }).parse(req.query);
  const page = listQuerySchema.parse(req.query);
  res.json({ success: true, ...await invoicesService.list(req.user!.companyId, filters, page) });
});

/** GET /api/invoices/:id — full invoice with line items + payment history */
export const get = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await invoicesService.get(req.user!.companyId, parseId(req.params.id)) });
});

/** GET /api/invoices/:id/pdf — streams the print-ready A4 PDF */
export const pdf = asyncHandler(async (req: Request, res: Response) => {
  const invoice = await invoicesService.get(req.user!.companyId, parseId(req.params.id));
  await renderInvoicePdf(res, invoice as never);
});

/**
 * POST /api/invoices — manual invoice (visa fees, service charges…)
 * Request:
 * { "customerId": 2, "invoiceDate": "2026-06-10", "incomeLedgerId": 7,
 *   "vatPercent": 5, "discount": 0,
 *   "items": [ { "description": "Visa processing — UAE (2 pax)", "quantity": 2, "rate": 7500 } ] }
 * Response 201:
 * { "success": true, "data": { "id": 9, "invoiceNo": "INV-2026-00009",
 *     "subtotal": 15000, "vatAmount": 750, "total": 15750, "voucherNo": "SV-2026-00016" } }
 */
export const createManual = asyncHandler(async (req: Request, res: Response) => {
  const input = manualSchema.parse(req.body);
  const data = await invoicesService.createManual(req.user!.companyId, req.user!.sub, input);
  await audit(req, 'INVOICE_CREATE', 'invoices', data.id, { invoiceNo: data.invoiceNo, total: data.total });
  res.status(201).json({ success: true, data });
});
