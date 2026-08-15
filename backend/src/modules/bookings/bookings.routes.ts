import { Router } from 'express';
import * as c from './bookings.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

const router = Router();
router.use(authenticate);
router.get('/', c.list);
router.get('/history/:customerId', c.history);
router.get('/:id', c.get);
router.post('/', allow(ROLE.SALES, ROLE.ADMIN), c.create);
router.post('/:id/confirm', allow(ROLE.SALES, ROLE.ACCOUNTANT, ROLE.ADMIN), c.confirm);
router.post('/:id/cancel', allow(ROLE.SALES, ROLE.ACCOUNTANT, ROLE.ADMIN), c.cancel);
export default router;
