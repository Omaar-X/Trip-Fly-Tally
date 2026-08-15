import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { inventoryService } from './inventory.service';
import { audit } from '../../middleware/audit';
import { isoDateSchema, parseId } from '../../utils/validation';
import { listQuerySchema } from '../../utils/paging';

const itemSchema = z.object({
  sku: z.string().min(1).max(50), name: z.string().min(2).max(150),
  category: z.string().max(80).optional(), unit: z.string().max(20).default('pcs'),
  purchasePrice: z.number().min(0), salePrice: z.number().min(0),
  reorderLevel: z.number().min(0).default(0)
});
const movementSchema = z.object({
  itemId: z.number().int().positive(), warehouseId: z.number().int().positive(),
  type: z.enum(['IN', 'OUT']), quantity: z.number().positive(),
  rate: z.number().min(0), date: isoDateSchema,
  // Naming the supplier on an incoming movement books the payable on THEIR
  // sub-ledger instead of the generic Stock Adjustment contra.
  supplierId: z.number().int().positive().optional(),
  note: z.string().max(255).optional()
}).refine(v => v.type === 'OUT' || v.rate > 0, {
  message: 'An incoming movement needs a rate greater than zero', path: ['rate'],
});

/** GET /api/inventory/items — items with live stock quantity */
export const listItems = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await inventoryService.listItems(req.user!.companyId) });
});

/** POST /api/inventory/items */
export const createItem = asyncHandler(async (req: Request, res: Response) => {
  const body = itemSchema.parse(req.body);
  const id = await inventoryService.createItem(req.user!.companyId, body);
  await audit(req, 'ITEM_CREATE', 'items', id, { sku: body.sku });
  res.status(201).json({ success: true, data: { id, ...body } });
});

const warehouseSchema = z.object({
  name: z.string().trim().min(2).max(100),
  location: z.string().trim().max(150).optional()
});
const warehouseUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  location: z.string().trim().max(150).optional(),
  isActive: z.boolean().optional()
});

/** GET /api/inventory/warehouses — includes movement_count per warehouse */
export const listWarehouses = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await inventoryService.listWarehouses(req.user!.companyId) });
});

/**
 * POST /api/inventory/warehouses
 * Request:  { "name": "Uttara Branch Store", "location": "Uttara, Dhaka" }
 * Response 201: { "success": true, "data": { "id": 2, "name": "Uttara Branch Store", ... } }
 * A duplicate name within the company is rejected with 409.
 */
export const createWarehouse = asyncHandler(async (req: Request, res: Response) => {
  const body = warehouseSchema.parse(req.body);
  const data = await inventoryService.createWarehouse(req.user!.companyId, body);
  await audit(req, 'WAREHOUSE_CREATE', 'warehouses', data.id, { name: data.name });
  res.status(201).json({ success: true, data });
});

/**
 * PUT /api/inventory/warehouses/:id
 * Request: { "name": "Main Warehouse", "location": "Banani", "isActive": true }
 */
export const updateWarehouse = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const body = warehouseUpdateSchema.parse(req.body);
  const data = await inventoryService.updateWarehouse(req.user!.companyId, id, body);
  await audit(req, 'WAREHOUSE_UPDATE', 'warehouses', id, body);
  res.json({ success: true, data });
});

/**
 * DELETE /api/inventory/warehouses/:id
 * A warehouse with no stock movements is removed; one that has movements is
 * deactivated instead, so the stock journal keeps its history.
 * Response 200: { "success": true, "data": { "id": 2, "deleted": false, "deactivated": true } }
 */
export const deleteWarehouse = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const data = await inventoryService.deleteWarehouse(req.user!.companyId, id);
  await audit(req, data.deleted ? 'WAREHOUSE_DELETE' : 'WAREHOUSE_DEACTIVATE', 'warehouses', id, data);
  res.json({ success: true, data });
});

/**
 * POST /api/inventory/movements — stock IN / OUT, and its ledger posting.
 *
 * Request: { "itemId": 1, "warehouseId": 1, "type": "IN", "quantity": 50,
 *            "rate": 270, "date": "2026-06-10", "supplierId": 3 }
 * Response 201: { "success": true, "data": { "id": 14, "quantity": 50,
 *                 "unitCost": 270, "value": 13500, "voucherNo": "PUR-2026-2027-00004" } }
 *
 * An OUT is valued at weighted-average cost regardless of the rate supplied,
 * and is rejected when it would drive THAT WAREHOUSE negative.
 */
export const recordMovement = asyncHandler(async (req: Request, res: Response) => {
  const body = movementSchema.parse(req.body);
  const data = await inventoryService.recordMovement(req.user!.companyId, req.user!.sub, body);
  await audit(req, 'STOCK_MOVE', 'stock_entries', data.id, { ...body, voucherNo: data.voucherNo });
  res.status(201).json({ success: true, data });
});

/**
 * POST /api/inventory/movements/:id/reverse — undo a movement recorded in error.
 * Posts a mirrored voucher and an opposite stock entry at the original value.
 * Request: { "reason": "Wrong warehouse" }
 */
export const reverseMovement = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    reason: z.string().trim().min(1).max(255),
    date: isoDateSchema.optional(),
  }).parse(req.body);
  const data = await inventoryService.reverseMovement(
    req.user!.companyId, req.user!.sub, parseId(req.params.id), body);
  await audit(req, 'STOCK_MOVE_REVERSE', 'stock_entries', data.id, {
    reversalVoucherNo: data.reversalVoucherNo, reason: body.reason,
  });
  res.status(201).json({ success: true, data });
});

/** GET /api/inventory/movements?itemId= */
export const listMovements = asyncHandler(async (req: Request, res: Response) => {
  const { itemId } = z.object({ itemId: z.coerce.number().int().positive().optional() }).parse(req.query);
  const page = listQuerySchema.parse(req.query);
  res.json({ success: true, ...await inventoryService.movements(req.user!.companyId, itemId, page) });
});

/** GET /api/inventory/items/:id/valuation — FIFO layers + weighted average */
export const valuation = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true,
    data: await inventoryService.valuation(req.user!.companyId, parseId(req.params.id)) });
});

/** GET /api/inventory/stock-report */
export const stockReport = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await inventoryService.stockReport(req.user!.companyId) });
});
