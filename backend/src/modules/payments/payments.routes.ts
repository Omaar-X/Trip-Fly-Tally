import { Router } from 'express';
import * as c from './payments.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

const router = Router();
router.use(authenticate);
router.get('/', allow(ROLE.ACCOUNTANT, ROLE.ADMIN, ROLE.SALES), c.list);
// SALES may only record incoming payments ("Collection") — enforced in the controller.
router.post('/', allow(ROLE.ACCOUNTANT, ROLE.ADMIN, ROLE.SALES), c.record);
// Undoing money that was never really received or paid is an accounting
// correction, not a collection — it stays with Accounts.
router.post('/:id/reverse', allow(ROLE.ACCOUNTANT), c.reverse);
export default router;
