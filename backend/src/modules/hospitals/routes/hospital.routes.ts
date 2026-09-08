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
import {
  acceptResponse,
  getResponse,
  listResponses,
  rejectResponse,
} from '../controllers/hospital-response.controller.js';
import {
  createReservation,
  getReservation,
  listReservations,
  releaseReservation,
} from '../controllers/bed-reservation.controller.js';

export const hospitalRouter = Router();

// Every route is scoped to the caller's own hospital: no hospital id is accepted from the client.
hospitalRouter.use(requireAuth, requireRole(UserRole.HOSPITAL_STAFF), requireHospitalMembership);

const requireHospitalAdmin = requireHospitalStaffRole(HospitalStaffRole.ADMIN);

// Operational decisions: RECEPTIONIST is read-only.
const requireResponder = requireHospitalStaffRole(
  HospitalStaffRole.ADMIN,
  HospitalStaffRole.DISPATCHER,
  HospitalStaffRole.CLINICAL_COORDINATOR,
);

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

// Hospital responses: any active staff may read; RECEPTIONIST may not decide.
hospitalRouter.get('/me/responses', listResponses);
hospitalRouter.get('/me/responses/:responseId', getResponse);
hospitalRouter.post('/me/responses/:responseId/accept', requireResponder, acceptResponse);
hospitalRouter.post('/me/responses/:responseId/reject', requireResponder, rejectResponse);
hospitalRouter.post('/me/responses/:responseId/reservations', requireResponder, createReservation);

// Bed reservations: any active staff may read; RECEPTIONIST may not reserve or release.
hospitalRouter.get('/me/reservations', listReservations);
hospitalRouter.get('/me/reservations/:reservationId', getReservation);
hospitalRouter.post(
  '/me/reservations/:reservationId/release',
  requireResponder,
  releaseReservation,
);
