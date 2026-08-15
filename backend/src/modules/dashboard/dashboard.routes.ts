import { Router } from 'express';
import * as c from './dashboard.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();
router.use(authenticate);
router.get('/summary', c.summary);
router.get('/monthly', c.monthly);
router.get('/revenue-by-type', c.revenueByType);
router.get('/activity', c.activity);
export default router;
