import { Router } from 'express';
import * as c from './auth.controller';
import { authenticate } from '../../middleware/auth';
import { allow } from '../../middleware/rbac';
import { ROLE } from '../../constants/roles';
import { authRateLimiter } from '../../middleware/security';

const router = Router();
router.post('/login', c.login);
router.post('/forgot-password', authRateLimiter, c.forgotPassword);
router.post('/reset-password', authRateLimiter, c.resetPassword);
router.post('/refresh', c.refresh);
router.post('/logout', c.logout);
router.get('/me', authenticate, c.me);
router.post('/register', c.register);                           // public self-registration; CEO role is blocked in the service
router.put('/users/:id/approval', authenticate, allow(), c.setApproval); // CEO only
router.get('/users', authenticate, allow(ROLE.ADMIN), c.listUsers);   // + CEO (bypass)
export default router;
