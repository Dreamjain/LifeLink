import { Router } from 'express';
import { HospitalStaffRole, UserRole } from '@prisma/client';
import { requireAuth, requireRole } from '../../auth/index.js';
import {
  requireHospitalMembership,
  requireHospitalStaffRole,
} from '../middleware/hospital-scope.middleware.js';
import { createStaff, getOwnHospital, listStaff } from '../controllers/hospital.controller.js';

export const hospitalRouter = Router();

// Every route is scoped to the caller's own hospital: no hospital id is accepted from the client.
hospitalRouter.use(requireAuth, requireRole(UserRole.HOSPITAL_STAFF), requireHospitalMembership);

hospitalRouter.get('/me', getOwnHospital);
hospitalRouter.get('/me/staff', requireHospitalStaffRole(HospitalStaffRole.ADMIN), listStaff);
hospitalRouter.post('/me/staff', requireHospitalStaffRole(HospitalStaffRole.ADMIN), createStaff);
