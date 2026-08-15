import { Router } from 'express';
import * as c from './accounting.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

const router = Router();
router.use(authenticate);
// GET /ledgers has no allow() gate by design: frontend/src/pages/invoices/Invoices.tsx
// (reachable by SALES) fetches this list to populate the "Income ledger" dropdown
// when creating a manual invoice, so any authenticated role needs read access.
// See docs/reports/PRODUCTION_FIX_REPORT.md item 6 for the full analysis.
//
// GET /ledger-groups is Accountant/Admin-only (+ CEO via the allow() bypass):
// its only consumer is the Accounting page, which no other role can reach.
// See docs/reports/SECURITY_FIX_REPORT.md.
router.get('/ledger-groups', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.listGroups);
router.get('/ledgers', c.listLedgers);
router.post('/ledgers', allow(ROLE.ACCOUNTANT), c.createLedger);
router.get('/ledgers/:id/statement', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.ledgerStatement);
router.get('/vouchers', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.listVouchers);
router.get('/vouchers/:id', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.getVoucher);
router.post('/vouchers', allow(ROLE.ACCOUNTANT), c.createVoucher);
// Vouchers are immutable: correcting one posts a mirrored reversal. Vouchers
// owned by a document (invoice, payment, payroll run, stock movement) are
// refused here and must be unwound through that document — see
// voucherOwnership.service.ts.
router.post('/vouchers/:id/reverse', allow(ROLE.ACCOUNTANT), c.reverseVoucher);
export default router;
