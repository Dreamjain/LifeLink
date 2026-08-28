import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { requireAuth, requireRole } from '../../auth/index.js';
import {
  approve,
  getDetail,
  listPending,
  reject,
} from '../controllers/admin-patient.controller.js';
import {
  approve as approveDriverAccount,
  getDriverDetail,
  listPendingDriverAccounts,
  reject as rejectDriverAccount,
} from '../controllers/admin-driver.controller.js';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole(UserRole.ADMIN));

adminRouter.get('/patients/pending', listPending);
adminRouter.get('/patients/:userId', getDetail);
adminRouter.post('/patients/:userId/approve', approve);
adminRouter.post('/patients/:userId/reject', reject);

adminRouter.get('/drivers/pending', listPendingDriverAccounts);
adminRouter.get('/drivers/:userId', getDriverDetail);
adminRouter.post('/drivers/:userId/approve', approveDriverAccount);
adminRouter.post('/drivers/:userId/reject', rejectDriverAccount);
