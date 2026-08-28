import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { requireRole } from '../../auth/index.js';
import { requirePatientOnboardingAuth } from '../middleware/patient-onboarding-auth.middleware.js';
import {
  createContact,
  deleteContact,
  getProfile,
  listContacts,
  putProfile,
  updateContact,
} from '../controllers/patient.controller.js';

export const patientRouter = Router();

patientRouter.use(requirePatientOnboardingAuth, requireRole(UserRole.PATIENT));

patientRouter.get('/me', getProfile);
patientRouter.put('/me', putProfile);
patientRouter.get('/me/emergency-contacts', listContacts);
patientRouter.post('/me/emergency-contacts', createContact);
patientRouter.patch('/me/emergency-contacts/:contactId', updateContact);
patientRouter.delete('/me/emergency-contacts/:contactId', deleteContact);
