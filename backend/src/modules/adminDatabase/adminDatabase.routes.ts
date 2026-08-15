import { Router } from 'express';
import * as c from './adminDatabase.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

const router = Router();

router.use(authenticate, allow(ROLE.CEO));
router.get('/tables', c.tables);
router.get('/tables/:table', c.tableData);
router.get('/tables/:table/export.csv', c.tableCsv);
router.get('/export.json', c.fullBackup);

export default router;
