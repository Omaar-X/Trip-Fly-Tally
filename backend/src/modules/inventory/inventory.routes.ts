import { Router } from 'express';
import * as c from './inventory.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

const router = Router();
router.use(authenticate);
router.get('/items', c.listItems);
router.post('/items', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.createItem);
router.get('/warehouses', c.listWarehouses);
router.post('/warehouses', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.createWarehouse);
router.put('/warehouses/:id', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.updateWarehouse);
router.delete('/warehouses/:id', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.deleteWarehouse);
router.get('/movements', c.listMovements);
router.post('/movements', allow(ROLE.ACCOUNTANT, ROLE.SALES, ROLE.ADMIN), c.recordMovement);
// A movement now posts to the ledger, so undoing one is an accounting
// correction and stays with Accounts (+ Admin oversight, + CEO).
router.post('/movements/:id/reverse', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.reverseMovement);
router.get('/items/:id/valuation', c.valuation);
router.get('/stock-report', c.stockReport);
export default router;
