import { Router } from 'express';
import multer from 'multer';
import * as c from './salesFiles.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

/**
 * A monthly workbook runs to a couple of hundred kilobytes; 15 MB is generous
 * headroom and still small enough that an accidental upload of something else
 * is rejected rather than buffered.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

const router = Router();
router.use(authenticate);

/**
 * The archive is money the company is owed, so it stops at the accounting
 * side of the house: Admin and Accountant, plus the CEO, who passes `allow()`
 * unconditionally and is never listed. Sales and HR do not reach it.
 *
 * Scanning is narrower still. It creates customers and bookings in bulk, and
 * that is an Admin action, not something an Accountant triggers in passing.
 */
router.get('/', allow(ROLE.ADMIN, ROLE.ACCOUNTANT), c.list);
router.get('/balance', allow(ROLE.ADMIN, ROLE.ACCOUNTANT), c.balance);
// The receivable is read by the same people who read the archive it comes
// from. Registered before '/:id/...' so "receivables" is never read as an id.
router.get('/receivables', allow(ROLE.ADMIN, ROLE.ACCOUNTANT), c.receivables);
router.get('/receivables/name-groups', allow(ROLE.ADMIN, ROLE.ACCOUNTANT), c.receivableNameGroups);
router.get('/receivables/history', allow(ROLE.ADMIN, ROLE.ACCOUNTANT), c.receivableHistory);
router.post('/scan', allow(ROLE.ADMIN), c.scan);
router.post('/upload', allow(ROLE.ADMIN, ROLE.ACCOUNTANT), upload.single('file'), c.upload);
router.get('/:id/rows', allow(ROLE.ADMIN, ROLE.ACCOUNTANT), c.rows);
router.get('/:id/download', allow(ROLE.ADMIN, ROLE.ACCOUNTANT), c.download);

export default router;
