import { Router } from 'express';
import * as c from './invoices.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

const router = Router();
router.use(authenticate);
router.get('/', c.list);
router.get('/:id', c.get);
router.get('/:id/pdf', c.pdf);
router.post('/', allow(ROLE.ACCOUNTANT, ROLE.SALES, ROLE.ADMIN), c.createManual);
export default router;
