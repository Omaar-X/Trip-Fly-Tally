import { Router } from 'express';
import * as c from './approvals.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

const router = Router();
router.use(authenticate);

/**
 * Route guards here are the coarse filter — "may this role reach the handler".
 * The fine-grained questions (is this actor the requester, does the CEO's grant
 * cover them, is the request still open) are answered by changeRequest.policy
 * and bdr.policy inside the service, because they need the request itself.
 *
 * `allow()` with no arguments means CEO only; CEO bypasses every other guard.
 */

// ─── change requests ────────────────────────────────────────────────────────
router.get('/change-requests', c.listChangeRequests);
router.post('/change-requests', allow(ROLE.ACCOUNTANT, ROLE.SALES, ROLE.ADMIN), c.createChangeRequest);
router.get('/change-requests/:id', c.getChangeRequest);
router.post('/change-requests/:id/comments', allow(ROLE.ACCOUNTANT, ROLE.SALES, ROLE.ADMIN), c.addComment);
router.post('/change-requests/:id/resubmit', allow(ROLE.ACCOUNTANT, ROLE.SALES, ROLE.ADMIN), c.resubmit);
router.post('/change-requests/:id/cancel', allow(ROLE.ACCOUNTANT, ROLE.SALES, ROLE.ADMIN), c.cancelChangeRequest);
// Recommendation is Admin-only at the route; the CEO's grant is checked in the service.
router.post('/change-requests/:id/recommend', allow(ROLE.ADMIN), c.recommend);
// Final decision — CEO only, and the service refuses self-approval on top.
router.post('/change-requests/:id/decide', allow(), c.decide);

// ─── soft delete restore — CEO only ─────────────────────────────────────────
router.post('/restore', allow(), c.restore);

// ─── backdated access ───────────────────────────────────────────────────────
router.get('/bdr', c.listBdr);
router.post('/bdr', allow(ROLE.ACCOUNTANT, ROLE.SALES, ROLE.ADMIN), c.createBdr);
router.post('/bdr/:id/cancel', allow(ROLE.ACCOUNTANT, ROLE.SALES, ROLE.ADMIN), c.cancelBdr);
// Approve/reject/revoke reach Admin too: an Admin the CEO authorised may decide
// BDR outright, which is the one place Admin authority is final.
router.post('/bdr/:id/approve', allow(ROLE.ADMIN), c.approveBdr);
router.post('/bdr/:id/reject', allow(ROLE.ADMIN), c.rejectBdr);
router.post('/bdr/:id/revoke', allow(ROLE.ADMIN), c.revokeBdr);

// ─── admin approval authority — CEO only ────────────────────────────────────
router.get('/admin-grants', allow(ROLE.ADMIN), c.listAdminGrants);
router.post('/admin-grants', allow(), c.grantAdminAuthority);
router.delete('/admin-grants/:id', allow(), c.revokeAdminAuthority);

// ─── dashboard notifications ────────────────────────────────────────────────
router.get('/notifications', c.inbox);
router.post('/notifications/read', c.markRead);

export default router;
