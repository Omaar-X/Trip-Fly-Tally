import { Router } from 'express';
import multer from 'multer';
import * as c from './companySettings.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const router = Router();

router.get('/public', c.getPublic);

router.use(authenticate);
router.get('/', c.get);
router.put('/', allow(ROLE.CEO), c.update);
// Closing and reopening a period is the strongest control in the system, so it
// sits with the CEO alongside company identity and payroll approval.
router.put('/period-lock', allow(ROLE.CEO), c.setPeriodLock);
router.post('/logo', allow(ROLE.CEO), upload.single('logo'), c.uploadLogo);
router.post('/favicon', allow(ROLE.CEO), upload.single('favicon'), c.uploadFavicon);

export default router;
