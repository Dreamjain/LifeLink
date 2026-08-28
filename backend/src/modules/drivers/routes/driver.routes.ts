import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { requireAuth, requireRole } from '../../auth/index.js';
import { getMe, patchAvailability, registerDriver } from '../controllers/driver.controller.js';

// Public driver application. Mounted under /api/v1/auth so registration stays on the
// documented auth API boundary, while the handler itself lives in the drivers module.
export const driverRegistrationRouter = Router();

driverRegistrationRouter.post('/register/driver', registerDriver);

// Authenticated driver self-service.
export const driverRouter = Router();

driverRouter.use(requireAuth, requireRole(UserRole.DRIVER));

driverRouter.get('/me', getMe);
driverRouter.patch('/me/availability', patchAvailability);
