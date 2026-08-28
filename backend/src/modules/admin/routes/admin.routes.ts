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
import {
  create as createHospital,
  getDetail as getHospitalDetail,
  list as listHospitals,
  provisionAdmin as provisionHospitalAdmin,
  reject as rejectHospital,
  verify as verifyHospital,
} from '../controllers/admin-hospital.controller.js';

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

adminRouter.post('/hospitals', createHospital);
adminRouter.get('/hospitals', listHospitals);
adminRouter.get('/hospitals/:hospitalId', getHospitalDetail);
adminRouter.post('/hospitals/:hospitalId/verify', verifyHospital);
adminRouter.post('/hospitals/:hospitalId/reject', rejectHospital);
adminRouter.post('/hospitals/:hospitalId/staff', provisionHospitalAdmin);
