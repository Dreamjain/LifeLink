import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { requireAuth, requireRole } from '../../auth/index.js';
import { getMe, patchAvailability, registerDriver } from '../controllers/driver.controller.js';
import {
  acceptDriverAssignment,
  changeDriverAssignmentStatus,
  failDriverAssignment,
  getDriverAssignment,
  listDriverAssignments,
  rejectDriverAssignment,
} from '../../dispatch/index.js';

// Public driver application. Mounted under /api/v1/auth so registration stays on the
// documented auth API boundary, while the handler itself lives in the drivers module.
export const driverRegistrationRouter = Router();

driverRegistrationRouter.post('/register/driver', registerDriver);

// Authenticated driver self-service.
export const driverRouter = Router();

driverRouter.use(requireAuth, requireRole(UserRole.DRIVER));

driverRouter.get('/me', getMe);
driverRouter.patch('/me/availability', patchAvailability);

// Ambulance assignments (Task 1.16). Every route is scoped to the authenticated driver's
// own DriverProfile: no driver identifier is ever accepted from the client.
driverRouter.get('/me/assignments', listDriverAssignments);
driverRouter.get('/me/assignments/:assignmentId', getDriverAssignment);
driverRouter.post('/me/assignments/:assignmentId/accept', acceptDriverAssignment);
driverRouter.post('/me/assignments/:assignmentId/reject', rejectDriverAssignment);

// Trip lifecycle (Task 1.22). Same ownership rule: the assignment is reached only through the
// authenticated driver's own DriverProfile, and the action names what happened on the road
// rather than assigning a status directly.
driverRouter.post('/me/assignments/:assignmentId/status', changeDriverAssignmentStatus);
driverRouter.post('/me/assignments/:assignmentId/fail', failDriverAssignment);
