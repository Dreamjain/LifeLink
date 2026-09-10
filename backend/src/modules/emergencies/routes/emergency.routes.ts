import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { requireAuth, requireRole } from '../../auth/index.js';
import {
  cancelEmergency,
  createEmergency,
  getEmergency,
  listEmergencies,
} from '../controllers/emergency.controller.js';

/**
 * Patient emergency routes, mounted alongside the patient onboarding router under
 * /api/v1/patients.
 *
 * These routes deliberately use `requireAuth` rather than the patient module's
 * `requirePatientOnboardingAuth`: onboarding tolerates a PENDING account so a patient can
 * finish their profile, but raising an emergency requires an ACTIVE account
 * (AuthenticationDesign.md sections 4, 5 and 17). The guard is bound to the
 * /me/emergencies path so that mounting this router does not affect the onboarding routes.
 */
export const patientEmergencyRouter = Router();

patientEmergencyRouter.use('/me/emergencies', requireAuth, requireRole(UserRole.PATIENT));

patientEmergencyRouter.post('/me/emergencies', createEmergency);
patientEmergencyRouter.get('/me/emergencies', listEmergencies);
patientEmergencyRouter.get('/me/emergencies/:emergencyId', getEmergency);
patientEmergencyRouter.post('/me/emergencies/:emergencyId/cancel', cancelEmergency);
