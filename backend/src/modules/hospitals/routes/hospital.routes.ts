import { Router } from 'express';
import { HospitalStaffRole, UserRole } from '@prisma/client';
import { requireAuth, requireRole } from '../../auth/index.js';
import {
  requireHospitalMembership,
  requireHospitalStaffRole,
} from '../middleware/hospital-scope.middleware.js';
import { createStaff, getOwnHospital, listStaff } from '../controllers/hospital.controller.js';
import {
  changeBedStatus,
  createBed,
  getBed,
  listBeds,
  updateBed,
} from '../controllers/bed.controller.js';
import {
  changeAmbulanceStatus,
  createAmbulance,
  getAmbulance,
  listAmbulances,
  updateAmbulance,
} from '../controllers/ambulance.controller.js';

export const hospitalRouter = Router();

// Every route is scoped to the caller's own hospital: no hospital id is accepted from the client.
hospitalRouter.use(requireAuth, requireRole(UserRole.HOSPITAL_STAFF), requireHospitalMembership);

const requireHospitalAdmin = requireHospitalStaffRole(HospitalStaffRole.ADMIN);

hospitalRouter.get('/me', getOwnHospital);
hospitalRouter.get('/me/staff', requireHospitalAdmin, listStaff);
hospitalRouter.post('/me/staff', requireHospitalAdmin, createStaff);

// Beds: any active staff may read; only hospital ADMIN may write.
hospitalRouter.get('/me/beds', listBeds);
hospitalRouter.post('/me/beds', requireHospitalAdmin, createBed);
hospitalRouter.get('/me/beds/:bedId', getBed);
hospitalRouter.patch('/me/beds/:bedId', requireHospitalAdmin, updateBed);
hospitalRouter.post('/me/beds/:bedId/status', requireHospitalAdmin, changeBedStatus);

// Ambulances: any active staff may read; only hospital ADMIN may write.
hospitalRouter.get('/me/ambulances', listAmbulances);
hospitalRouter.post('/me/ambulances', requireHospitalAdmin, createAmbulance);
hospitalRouter.get('/me/ambulances/:ambulanceId', getAmbulance);
hospitalRouter.patch('/me/ambulances/:ambulanceId', requireHospitalAdmin, updateAmbulance);
hospitalRouter.post(
  '/me/ambulances/:ambulanceId/status',
  requireHospitalAdmin,
  changeAmbulanceStatus,
);
