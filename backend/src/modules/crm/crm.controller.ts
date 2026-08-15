import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { crmService } from './crm.service';
import { audit } from '../../middleware/audit';
import { parseId } from '../../utils/validation';

const customerSchema = z.object({
  name: z.string().min(2).max(150), email: z.string().email().optional(),
  phone: z.string().max(30).optional(), address: z.string().max(255).optional(),
  passportNo: z.string().max(40).optional(), creditLimit: z.number().min(0).default(0)
});
const supplierSchema = z.object({
  name: z.string().min(2).max(150), email: z.string().email().optional(),
  phone: z.string().max(30).optional(), address: z.string().max(255).optional()
});

/** GET /api/crm/customers — with live outstanding balance from the books */
export const listCustomers = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await crmService.listCustomers(req.user!.companyId) });
});

/** POST /api/crm/customers — also auto-creates the receivable sub-ledger */
export const createCustomer = asyncHandler(async (req: Request, res: Response) => {
  const body = customerSchema.parse(req.body);
  const id = await crmService.createCustomer(req.user!.companyId, body);
  await audit(req, 'CUSTOMER_CREATE', 'customers', id, { name: body.name });
  res.status(201).json({ success: true, data: { id, ...body } });
});

/** GET /api/crm/customers/:id — profile + payments + bookings + invoices */
export const customerProfile = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true,
    data: await crmService.customerProfile(req.user!.companyId, parseId(req.params.id)) });
});

/** GET /api/crm/suppliers */
export const listSuppliers = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await crmService.listSuppliers(req.user!.companyId) });
});

/** POST /api/crm/suppliers */
export const createSupplier = asyncHandler(async (req: Request, res: Response) => {
  const body = supplierSchema.parse(req.body);
  const id = await crmService.createSupplier(req.user!.companyId, body);
  await audit(req, 'SUPPLIER_CREATE', 'suppliers', id, { name: body.name });
  res.status(201).json({ success: true, data: { id, ...body } });
});
