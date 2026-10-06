import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../middleware/audit';
import { parseId } from '../../utils/validation';
import { RoleName } from '../../constants/roles';
import { approvalsService, loadActor } from './approvals.service';
import { notificationsService } from './notifications.service';

const priority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional();
const entity = z.enum(['vouchers', 'payments', 'invoices', 'bookings']);

const createChangeSchema = z.object({
  kind: z.enum(['EDIT', 'DELETE']),
  entity,
  entityId: z.number().int().positive(),
  isFinancial: z.boolean().optional(),
  reason: z.string().min(3).max(1000),
  description: z.string().max(2000).optional(),
  priority,
  originalValues: z.unknown().optional(),
  proposedValues: z.unknown().optional(),
});

const decideSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'NEEDS_CORRECTION']),
  note: z.string().max(1000).optional(),
});

const bdrSchema = z.object({
  module: z.enum(['VOUCHER', 'PAYMENT', 'BOOKING', 'INVOICE', 'INVENTORY', 'PAYROLL']),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().min(3).max(1000),
  priority,
});

const reasonSchema = z.object({ reason: z.string().min(3).max(500) });

/** Every handler needs the actor's granted authorities, not just their role. */
const actorOf = (req: Request) =>
  loadActor(req.user!.companyId, { id: req.user!.sub, role: req.user!.role as RoleName });

// ───────────────────────────── change requests ──────────────────────────────

export const createChangeRequest = asyncHandler(async (req: Request, res: Response) => {
  const body = createChangeSchema.parse(req.body);
  const actor = await actorOf(req);
  const out = await approvalsService.createChangeRequest(req.user!.companyId, actor, body);
  await audit(req, `CHANGE_REQUEST_${body.kind}`, body.entity, body.entityId,
    { requestNo: out.requestNo, reason: body.reason });
  res.status(201).json({ success: true, data: out });
});

export const listChangeRequests = asyncHandler(async (req: Request, res: Response) => {
  const mine = req.query.mine === '1' ? req.user!.sub : undefined;
  res.json({
    success: true,
    data: await approvalsService.listChangeRequests(req.user!.companyId, {
      status: req.query.status as string | undefined,
      kind: req.query.kind as string | undefined,
      mine,
    }),
  });
});

export const getChangeRequest = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const [request, comments, versions] = await Promise.all([
    approvalsService.getChangeRequest(req.user!.companyId, id),
    approvalsService.comments(id),
    approvalsService.versions(id),
  ]);
  res.json({ success: true, data: { request, comments, versions } });
});

/** Admin recommendation — advisory, never a decision. */
export const recommend = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    recommendation: z.enum(['APPROVE', 'REJECT', 'NEEDS_CORRECTION']),
    note: z.string().max(1000).optional(),
  }).parse(req.body);
  const actor = await actorOf(req);
  const id = parseId(req.params.id);
  const out = await approvalsService.recommend(req.user!.companyId, actor, id, body);
  await audit(req, 'CHANGE_REQUEST_RECOMMEND', 'change_requests', id, out);
  res.json({ success: true, data: out });
});

export const decide = asyncHandler(async (req: Request, res: Response) => {
  const body = decideSchema.parse(req.body);
  const actor = await actorOf(req);
  const id = parseId(req.params.id);
  const out = await approvalsService.decide(req.user!.companyId, actor, id, body.action, body);
  await audit(req, `CHANGE_REQUEST_${body.action}`, 'change_requests', id,
    { note: body.note, status: out.status });
  res.json({ success: true, data: out });
});

export const resubmit = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    reason: z.string().min(3).max(1000),
    proposedValues: z.unknown().optional(),
  }).parse(req.body);
  const actor = await actorOf(req);
  const id = parseId(req.params.id);
  const out = await approvalsService.resubmit(req.user!.companyId, actor, id, body);
  await audit(req, 'CHANGE_REQUEST_RESUBMIT', 'change_requests', id, out);
  res.json({ success: true, data: out });
});

export const cancelChangeRequest = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = reasonSchema.parse(req.body);
  const actor = await actorOf(req);
  const id = parseId(req.params.id);
  const out = await approvalsService.cancel(req.user!.companyId, actor, id, reason);
  await audit(req, 'CHANGE_REQUEST_CANCEL', 'change_requests', id, { reason });
  res.json({ success: true, data: out });
});

export const addComment = asyncHandler(async (req: Request, res: Response) => {
  const { body } = z.object({ body: z.string().min(1).max(2000) }).parse(req.body);
  const actor = await actorOf(req);
  const id = parseId(req.params.id);
  res.status(201).json({
    success: true,
    data: await approvalsService.addComment(req.user!.companyId, actor, id, body),
  });
});

// ─────────────────────────── soft delete / restore ──────────────────────────

export const restore = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({ entity, entityId: z.number().int().positive() }).parse(req.body);
  const actor = await actorOf(req);
  const out = await approvalsService.restore(req.user!.companyId, actor, body.entity, body.entityId);
  await audit(req, 'TRANSACTION_RESTORE', body.entity, body.entityId, out);
  res.json({ success: true, data: out });
});

// ────────────────────────────────── BDR ─────────────────────────────────────

export const createBdr = asyncHandler(async (req: Request, res: Response) => {
  const body = bdrSchema.parse(req.body);
  const actor = await actorOf(req);
  const out = await approvalsService.createBdr(req.user!.companyId, actor, body);
  await audit(req, 'BDR_CREATE', 'backdated_access_requests', out.id,
    { requestNo: out.requestNo, module: body.module, from: body.from, to: body.to });
  res.status(201).json({ success: true, data: out });
});

export const listBdr = asyncHandler(async (req: Request, res: Response) => {
  const mine = req.query.mine === '1' ? req.user!.sub : undefined;
  res.json({
    success: true,
    data: await approvalsService.listBdr(req.user!.companyId, {
      status: req.query.status as string | undefined, mine,
    }),
  });
});

export const approveBdr = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    note: z.string().max(1000).optional(),
  }).parse(req.body);
  const actor = await actorOf(req);
  const id = parseId(req.params.id);
  const out = await approvalsService.approveBdr(req.user!.companyId, actor, id, body);
  await audit(req, 'BDR_APPROVE', 'backdated_access_requests', id, out);
  res.json({ success: true, data: out });
});

export const rejectBdr = asyncHandler(async (req: Request, res: Response) => {
  const { note } = z.object({ note: z.string().max(1000).optional() }).parse(req.body);
  const actor = await actorOf(req);
  const id = parseId(req.params.id);
  const out = await approvalsService.rejectBdr(req.user!.companyId, actor, id, note);
  await audit(req, 'BDR_REJECT', 'backdated_access_requests', id, { note });
  res.json({ success: true, data: out });
});

export const cancelBdr = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = reasonSchema.parse(req.body);
  const actor = await actorOf(req);
  const id = parseId(req.params.id);
  const out = await approvalsService.cancelBdr(req.user!.companyId, actor, id, reason);
  await audit(req, 'BDR_CANCEL', 'backdated_access_requests', id, { reason });
  res.json({ success: true, data: out });
});

export const revokeBdr = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = reasonSchema.parse(req.body);
  const actor = await actorOf(req);
  const id = parseId(req.params.id);
  const out = await approvalsService.revokeBdr(req.user!.companyId, actor, id, reason);
  await audit(req, 'BDR_REVOKE', 'backdated_access_requests', id, { reason });
  res.json({ success: true, data: out });
});

// ─────────────────────── admin authority · notifications ────────────────────

export const grantAdminAuthority = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    userId: z.number().int().positive(),
    scope: z.enum(['CHANGE_REVIEW', 'BDR_APPROVE']),
    note: z.string().max(500).optional(),
  }).parse(req.body);
  const actor = await actorOf(req);
  const out = await approvalsService.grantAdminAuthority(req.user!.companyId, actor, body);
  await audit(req, 'ADMIN_AUTHORITY_GRANT', 'admin_approval_grants', out.id, body);
  res.status(201).json({ success: true, data: out });
});

export const revokeAdminAuthority = asyncHandler(async (req: Request, res: Response) => {
  const actor = await actorOf(req);
  const id = parseId(req.params.id);
  const out = await approvalsService.revokeAdminAuthority(req.user!.companyId, actor, id);
  await audit(req, 'ADMIN_AUTHORITY_REVOKE', 'admin_approval_grants', id, out);
  res.json({ success: true, data: out });
});

export const listAdminGrants = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await approvalsService.listAdminGrants(req.user!.companyId) });
});

export const inbox = asyncHandler(async (req: Request, res: Response) => {
  const [items, unread] = await Promise.all([
    notificationsService.inbox(req.user!.companyId, req.user!.sub),
    notificationsService.unreadCount(req.user!.companyId, req.user!.sub),
  ]);
  res.json({ success: true, data: { items, unread } });
});

export const markRead = asyncHandler(async (req: Request, res: Response) => {
  const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(200) }).parse(req.body);
  const n = await notificationsService.markRead(req.user!.companyId, req.user!.sub, ids);
  res.json({ success: true, data: { marked: n } });
});
