import { Router } from 'express';
import * as c from './reports.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

// Report access is split by category, not one blanket gate — see ROLE_MIGRATION_REPORT.md:
//   accounting reports (trial balance / P&L / balance sheet / cash & bank / day book) -> Accountant (+ Admin oversight)
//   sales reports (daily sales / customer outstanding)                                -> Sales (+ Accountant, Admin)
//   HR gets no report access here — its "employee reports" are served by /api/hr/* directly.
//   CEO reaches every route regardless via the allow() bypass.
const router = Router();
router.use(authenticate);
router.get('/trial-balance', allow(ROLE.ACCOUNTANT), c.trialBalance);
router.get('/profit-loss', allow(ROLE.ACCOUNTANT), c.profitLoss);
router.get('/balance-sheet', allow(ROLE.ACCOUNTANT), c.balanceSheet);
router.get('/cash-book', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.cashBook);
router.get('/bank-book', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.bankBook);
router.get('/day-book', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.dayBook);
router.get('/daily-sales', allow(ROLE.SALES, ROLE.ACCOUNTANT, ROLE.ADMIN), c.dailySales);
router.get('/customer-outstanding', allow(ROLE.SALES, ROLE.ACCOUNTANT, ROLE.ADMIN), c.customerOutstanding);
export default router;
