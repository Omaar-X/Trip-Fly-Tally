import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../middleware/audit';
import { hrService } from './hr.service';
import { renderPayslipPdf } from './payslip.pdf';
import { isoDateSchema, parseId } from '../../utils/validation';

const employeeSchema = z.object({
  empCode: z.string().min(1).max(30),
  name: z.string().min(2).max(120),
  designation: z.string().max(80).optional(),
  department: z.string().max(80).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().optional(),
  joiningDate: isoDateSchema.optional(),
  basicSalary: z.number().min(0),
  houseRent: z.number().min(0).optional(),
  medicalAllow: z.number().min(0).optional(),
  conveyance: z.number().min(0).optional(),
  commissionRate: z.number().min(0).max(100).optional()
});

const periodSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12)
});

/** GET /api/hr/employees */
export const listEmployees = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await hrService.listEmployees(req.user!.companyId) });
});

/**
 * POST /api/hr/employees
 * Request: { "empCode": "EMP-004", "name": "Farzana Akter", "designation": "Tour Consultant",
 *   "department": "Sales", "basicSalary": 24000, "houseRent": 9500, "medicalAllow": 2500,
 *   "conveyance": 2000, "commissionRate": 4.5, "joiningDate": "2026-06-01" }
 * Response 201: { "success": true, "data": { "id": 4 } }
 */
export const createEmployee = asyncHandler(async (req: Request, res: Response) => {
  const input = employeeSchema.parse(req.body);
  const id = await hrService.createEmployee(req.user!.companyId, input);
  await audit(req, 'EMPLOYEE_CREATE', 'employees', id, { empCode: input.empCode });
  res.status(201).json({ success: true, data: { id } });
});

/** PATCH /api/hr/employees/:id — partial update incl. { "isActive": false } */
export const updateEmployee = asyncHandler(async (req: Request, res: Response) => {
  const input = employeeSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
  const id = parseId(req.params.id);
  await hrService.updateEmployee(req.user!.companyId, id, input);
  await audit(req, 'EMPLOYEE_UPDATE', 'employees', id, input);
  res.json({ success: true });
});

/** GET /api/hr/payroll — all runs */
export const listRuns = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await hrService.listRuns(req.user!.companyId) });
});

/** GET /api/hr/payroll/:id — run + payslips */
export const runDetail = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await hrService.runDetail(req.user!.companyId, parseId(req.params.id)) });
});

/**
 * POST /api/hr/payroll/generate
 *
 * Attendance lives outside this system, so no absence deduction is derived
 * here. Send the deduction per employee as a taka figure — computed wherever
 * attendance is actually recorded — keyed by employee id:
 *
 * Request:  { "year": 2026, "month": 6, "deductions": { "2": 8181.82 } }
 * Response: { "success": true, "data": { "runId": 3, "employees": 3,
 *             "totalDeduction": 8181.82, "totalNet": 118450 } }
 *
 * net pay = basic + allowances + commission − deduction
 */
export const generateRun = asyncHandler(async (req: Request, res: Response) => {
  const body = periodSchema.extend({
    // Keys arrive as JSON object keys (strings) and are coerced to employee ids.
    deductions: z.record(z.coerce.number().int().positive(), z.number().nonnegative()).optional(),
  }).parse(req.body);

  const data = await hrService.generateRun(
    req.user!.companyId, body.year, body.month, { deductions: body.deductions });

  await audit(req, 'PAYROLL_GENERATE', 'payroll_runs', data.runId, {
    year: body.year, month: body.month,
    totalNet: data.totalNet, totalDeduction: data.totalDeduction,
    employees: data.employees,
  });
  res.json({ success: true, data });
});

/**
 * POST /api/hr/payroll/:id/approve — posts Dr Salary Expense / Cr Salaries Payable
 * Response 200: { "success": true, "data": { "runId": 3, "status": "APPROVED",
 *                 "voucherNo": "JV-2026-00021", "total": 118450 } }
 */
export const approveRun = asyncHandler(async (req: Request, res: Response) => {
  // Defaults to the last day of the payroll period, so June's salary is June's
  // expense however late the approval comes.
  const body = z.object({ date: isoDateSchema.optional() }).parse(req.body ?? {});
  const data = await hrService.approveRun(
    req.user!.companyId, req.user!.sub, parseId(req.params.id), body);
  await audit(req, 'PAYROLL_APPROVE', 'payroll_runs', data.runId,
    { voucherNo: data.voucherNo, date: data.date });
  res.json({ success: true, data });
});

/**
 * POST /api/hr/payroll/:id/unapprove — APPROVED → DRAFT.
 *
 * Reverses the accrual voucher so a run approved in error can be corrected and
 * regenerated. A PAID run cannot be un-approved: the money has left, and that
 * has to be unwound as a payment first.
 *
 * Request:  { "reason": "Attendance for two staff was missing" }
 * Response: { "success": true, "data": { "runId": 3, "status": "DRAFT",
 *             "reversalVoucherNo": "JV-2026-2027-00042" } }
 */
export const unapproveRun = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    reason: z.string().trim().min(1).max(255),
    date: isoDateSchema.optional(),
  }).parse(req.body);
  const data = await hrService.unapproveRun(
    req.user!.companyId, req.user!.sub, parseId(req.params.id), body);
  await audit(req, 'PAYROLL_UNAPPROVE', 'payroll_runs', data.runId,
    { reversalVoucherNo: data.reversalVoucherNo, reason: body.reason });
  res.json({ success: true, data });
});

/**
 * POST /api/hr/payroll/:id/pay — posts Dr Salaries Payable / Cr Cash-Bank
 * Request: { "method": "BANK" }
 */
export const payRun = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    method: z.enum(['CASH', 'BANK', 'BKASH', 'NAGAD', 'CARD']).default('BANK'),
    date: isoDateSchema.optional(),
  }).parse(req.body ?? {});
  const data = await hrService.payRun(
    req.user!.companyId, req.user!.sub, parseId(req.params.id), body.method, { date: body.date });
  await audit(req, 'PAYROLL_PAY', 'payroll_runs', data.runId,
    { method: body.method, total: data.total, date: data.date });
  res.json({ success: true, data });
});

/** GET /api/hr/payslips/:id/pdf — printable payslip */
export const payslipPdf = asyncHandler(async (req: Request, res: Response) => {
  const slip = await hrService.payslip(req.user!.companyId, parseId(req.params.id));
  await renderPayslipPdf(res, slip);
});
