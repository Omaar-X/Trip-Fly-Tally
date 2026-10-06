import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../middleware/audit';
import { parseId } from '../../utils/validation';
import { migrationService } from './migration.service';

const period = z.string().regex(/^\d{4}-\d{2}$/, 'Period must be YYYY-MM.');

export const createBatch = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    period,
    description: z.string().max(255).optional(),
    // The operator names the backup they took. The engine records which
    // snapshot belongs to which batch; it does not take one for you, because a
    // snapshot this process could create is one it could also overwrite.
    snapshotRef: z.string().max(255).optional(),
  }).parse(req.body);

  const out = await migrationService.createBatch(req.user!.companyId, req.user!.sub, body);
  await audit(req, 'MIGRATION_BATCH_CREATE', 'migration_batches', out.id, body);
  res.status(201).json({ success: true, data: out });
});

export const listBatches = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await migrationService.listBatches(req.user!.companyId) });
});

export const getBatch = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const [batch, reconciliation] = await Promise.all([
    migrationService.getBatch(req.user!.companyId, id),
    migrationService.reconciliation(req.user!.companyId, id),
  ]);
  res.json({ success: true, data: { batch, reconciliation } });
});

export const rollbackBatch = asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const out = await migrationService.rollbackBatch(req.user!.companyId, id, req.user!.sub);
  await audit(req, 'MIGRATION_BATCH_ROLLBACK', 'migration_batches', id, out);
  res.json({ success: true, data: out });
});

export const reconcile = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    controls: z.record(z.string(), z.object({
      sourceValue: z.number().nullable(),
      migratedValue: z.number(),
      note: z.string().max(255).optional(),
    })),
  }).parse(req.body);
  const id = parseId(req.params.id);
  const out = await migrationService.reconcile(req.user!.companyId, id, body.controls as never);
  await audit(req, 'MIGRATION_RECONCILE', 'migration_batches', id, out);
  res.json({ success: true, data: out });
});

/**
 * CEO final approval closes the month. The reason is mandatory whenever review
 * items are still open — enforced in the service, where the open count is
 * known.
 */
export const finalizeMonth = asyncHandler(async (req: Request, res: Response) => {
  const { reason, comment } = z.object({
    reason: z.string().max(1000).optional().default(''),
    comment: z.string().max(1000).optional().default(''),
  }).parse(req.body);
  const id = parseId(req.params.id);
  const out = await migrationService.finalizeMonth(req.user!.companyId, id, req.user!.sub, reason, comment);
  // The audit action names the OUTCOME, so an accepted limitation never reads
  // as a verification in the audit trail either.
  await audit(req,
    out.outcome === 'ACCEPTED_HISTORICAL_DATA_LIMITATION'
      ? 'MIGRATION_PERIOD_ACCEPTED_WITH_LIMITATION'
      : 'MIGRATION_MONTH_VERIFIED',
    'migration_batches', id, { reason, comment, ...out });
  res.json({ success: true, data: out });
});

/**
 * Reopen an approved historical period because authoritative source data
 * turned up. The earlier acceptance is preserved in the period approval
 * history; this only makes the period writable again.
 */
export const reopenPeriod = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = z.object({ reason: z.string().min(1).max(1000) }).parse(req.body);
  const id = parseId(req.params.id);
  const out = await migrationService.reopenPeriod(req.user!.companyId, id, req.user!.sub, reason);
  await audit(req, 'MIGRATION_PERIOD_REOPENED', 'migration_batches', id, { reason, ...out });
  res.json({ success: true, data: out });
});

/** Every approval and reopening one period has ever had. */
export const periodApprovalHistory = asyncHandler(async (req: Request, res: Response) => {
  const period = z.string().regex(/^\d{4}-\d{2}$/).parse(req.query.period);
  res.json({ success: true,
    data: await migrationService.periodApprovalHistory(req.user!.companyId, period) });
});

// ─── review queue ───────────────────────────────────────────────────────────

export const listReviewItems = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    success: true,
    data: await migrationService.listReviewItems(req.user!.companyId, {
      status: req.query.status as string | undefined,
      module: req.query.module as string | undefined,
      batchId: req.query.batchId ? Number(req.query.batchId) : undefined,
    }),
  });
});

export const resolveReviewItem = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    status: z.enum(['RESOLVED', 'ACCEPTED_AS_IS', 'WONT_FIX']),
    resolution: z.string().min(3).max(1000),
    resolutionCode: z.enum(['CONFIRMED_DUPLICATE', 'CLEARED_NOT_DUPLICATE', 'PARTY_RECLASSIFIED']).optional(),
    notes: z.string().max(1000).optional(),
  }).parse(req.body);
  const id = parseId(req.params.id);
  const out = await migrationService.resolveReviewItem(req.user!.companyId, id, req.user!.sub, body);
  await audit(req, 'MIGRATION_REVIEW_RESOLVE', 'migration_review_items', id, body);
  res.json({ success: true, data: out });
});

// ─── traceability ───────────────────────────────────────────────────────────

/** Where a migrated transaction came from, or every row sharing one PNR. */
export const sourceRows = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    success: true,
    data: await migrationService.sourceRows(req.user!.companyId, {
      batchId: req.query.batchId ? Number(req.query.batchId) : undefined,
      pnr: req.query.pnr as string | undefined,
      targetId: req.query.targetId ? Number(req.query.targetId) : undefined,
    }),
  });
});

/** Decision 1's report — the evidence needed to identify the real suppliers. */
export const unknownSupplierReport = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const [rows, totals] = await Promise.all([
    migrationService.unknownSupplierRows(companyId),
    migrationService.unknownSupplierTotal(companyId),
  ]);
  res.json({
    success: true,
    data: { rows, count: totals.rows, totalUnassignedSupplierPayable: totals.total },
  });
});

/** Decision 2's report — original narration first; suggestions are never applied. */
export const unclassifiedExpenseReport = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await migrationService.unclassifiedExpenseRows(req.user!.companyId) });
});

/** Decision 5 — the queue filtered to what materially moves the books. */
export const materialReview = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const [items, summary] = await Promise.all([
    migrationService.materialReviewItems(companyId, {
      onlyMaterial: req.query.all !== '1', status: req.query.status as string | undefined,
      issueType: req.query.issueType as string | undefined, period: req.query.period as string | undefined,
      search: req.query.search as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    }),
    migrationService.materialReviewSummary(companyId),
  ]);
  res.json({ success: true, data: { items, summary } });
});

export const reviewItemDetail = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await migrationService.reviewItemDetail(
    req.user!.companyId, parseId(req.params.id)) });
});

export const recordReviewDecision = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    actionCode: z.enum(['CLEARED_NOT_DUPLICATE', 'CONFIRMED_DUPLICATE', 'NEEDS_MORE_EVIDENCE']),
    evidence: z.string().min(10).max(2000), ruleCode: z.string().max(100).optional(),
  }).parse(req.body);
  const id = parseId(req.params.id);
  const out = await migrationService.recordReviewDecision(req.user!.companyId, id, req.user!.sub, body);
  await audit(req, 'HISTORICAL_REVIEW_DECISION', 'migration_review_items', id, body);
  res.json({ success: true, data: out });
});

/** Why the unexplained amount exists, by category and period. */
export const clearingBreakdown = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await migrationService.clearingBreakdown(req.user!.companyId) });
});

export const periodReadiness = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await migrationService.periodReadiness(req.user!.companyId) });
});

export const duplicateReport = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await migrationService.duplicateReport(req.user!.companyId) });
});

/** CEO accepts an unresolved historical limitation. The reason is mandatory. */
export const ceoAcceptReview = asyncHandler(async (req: Request, res: Response) => {
  const { reason } = z.object({ reason: z.string().min(3).max(1000) }).parse(req.body);
  const id = parseId(req.params.id);
  const out = await migrationService.ceoAcceptReviewItem(req.user!.companyId, id, req.user!.sub, reason);
  await audit(req, 'MIGRATION_REVIEW_CEO_ACCEPTED', 'migration_review_items', id, { reason });
  res.json({ success: true, data: out });
});

export const recordAdjustment = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    batchId: z.number().int().positive(),
    partyType: z.enum(['CUSTOMER', 'SUPPLIER']),
    partyId: z.number().int().positive(),
    controlAmount: z.number(),
    calculatedAmount: z.number(),
    controlSource: z.string().min(3).max(255),
    investigation: z.string().min(10).max(1000),
    reason: z.string().min(3).max(1000),
    voucherId: z.number().int().positive().nullable().optional(),
  }).parse(req.body);

  const out = await migrationService.recordOutstandingAdjustment(
    req.user!.companyId, req.user!.sub, body);
  await audit(req, 'MIGRATION_OUTSTANDING_ADJUSTMENT', 'historical_outstanding_adjustments',
    out.id, body);
  res.status(201).json({ success: true, data: out });
});
