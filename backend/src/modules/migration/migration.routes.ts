import { Router } from 'express';
import * as c from './migration.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

const router = Router();
router.use(authenticate);

/**
 * The migration engine writes history. Nobody below Admin reaches it, and the
 * two irreversible verbs — rolling a batch back, and closing a month — are the
 * CEO's alone. `allow()` with no arguments means CEO only.
 */
router.get('/batches', allow(ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT), c.listBatches);
router.post('/batches', allow(ROLE.ADMIN), c.createBatch);
router.get('/batches/:id', allow(ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT), c.getBatch);
router.post('/batches/:id/reconcile', allow(ROLE.ADMIN), c.reconcile);
router.post('/batches/:id/rollback', allow(), c.rollbackBatch);
router.post('/batches/:id/finalize', allow(), c.finalizeMonth);
// Reopening an approved period is a CEO action: it unlocks history someone has
// already signed off. The prior acceptance is kept, never overwritten.
router.post('/batches/:id/reopen', allow(), c.reopenPeriod);
router.get('/period-approvals', allow(ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT), c.periodApprovalHistory);

router.get('/review-items', allow(ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT), c.listReviewItems);
router.get('/review-items/:id/detail', allow(ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT), c.reviewItemDetail);
router.post('/review-items/:id/resolve', allow(ROLE.ADMIN, ROLE.ACCOUNTANT), c.resolveReviewItem);
router.post('/review-items/:id/decision', allow(ROLE.ADMIN, ROLE.ACCOUNTANT), c.recordReviewDecision);

router.get('/source-rows', allow(ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT), c.sourceRows);

// The decision reports. Read-only, and open to whoever works the review queue.
router.get('/reports/unknown-supplier', allow(ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT), c.unknownSupplierReport);
router.get('/reports/unclassified-expense', allow(ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT), c.unclassifiedExpenseReport);
router.get('/reports/material-review', allow(ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT), c.materialReview);
router.get('/reports/clearing-breakdown', allow(ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT), c.clearingBreakdown);
router.get('/reports/period-readiness', allow(ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT), c.periodReadiness);
router.get('/reports/duplicates', allow(ROLE.CEO, ROLE.ADMIN, ROLE.ACCOUNTANT), c.duplicateReport);

// Accepting an unresolved historical limitation is the CEO's, and needs a reason.
router.post('/review-items/:id/ceo-accept', allow(), c.ceoAcceptReview);

// An adjustment is the last resort and is the CEO's signature, not an operator's.
router.post('/adjustments', allow(), c.recordAdjustment);

export default router;
