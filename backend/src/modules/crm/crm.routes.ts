import { Router } from 'express';
import * as c from './crm.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

const router = Router();
router.use(authenticate);
router.get('/customers', c.listCustomers);
router.post('/customers', allow(ROLE.SALES, ROLE.ACCOUNTANT, ROLE.ADMIN), c.createCustomer);
router.get('/customers/:id', c.customerProfile);
router.get('/suppliers', c.listSuppliers);
router.post('/suppliers', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.createSupplier);
export default router;
