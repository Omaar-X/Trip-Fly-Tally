import { Router } from 'express';
import * as c from './hr.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

const router = Router();
router.use(authenticate);
// Employee management: HR's core scope, with Admin oversight.
// Attendance is NOT served here — it is kept in a separate system, and payroll
// takes the resulting deduction as a figure rather than deriving one.
router.get('/employees', allow(ROLE.HR, ROLE.ADMIN), c.listEmployees);
router.post('/employees', allow(ROLE.HR, ROLE.ADMIN), c.createEmployee);
router.patch('/employees/:id', allow(ROLE.HR, ROLE.ADMIN), c.updateEmployee);
// Payroll: not part of HR's stated scope (no payroll access at all) and not
// part of Accountant's (Accountant cannot access HR/payroll) — owned by
// Admin for operational handling, with final approval reserved for CEO.
router.get('/payroll', allow(ROLE.ADMIN), c.listRuns);
router.get('/payroll/:id', allow(ROLE.ADMIN), c.runDetail);
router.post('/payroll/generate', allow(ROLE.ADMIN), c.generateRun);
router.post('/payroll/:id/approve', allow(), c.approveRun);     // CEO only (final approval)
router.post('/payroll/:id/unapprove', allow(), c.unapproveRun); // CEO only — undoing approval is approval
router.post('/payroll/:id/pay', allow(ROLE.ADMIN), c.payRun);
router.get('/payslips/:id/pdf', allow(ROLE.ADMIN), c.payslipPdf);
export default router;
