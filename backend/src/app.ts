import express from 'express';
import { correlationIdMiddleware } from './common/middleware/correlation-id.middleware.js';
import { errorHandler } from './common/middleware/error-handler.middleware.js';
import { authRouter } from './modules/auth/index.js';
import { patientRouter } from './modules/patients/index.js';
import { adminRouter } from './modules/admin/index.js';
import { driverRegistrationRouter, driverRouter } from './modules/drivers/index.js';
import { hospitalRouter } from './modules/hospitals/index.js';

export const app = express();

app.disable('x-powered-by');
app.use(correlationIdMiddleware);
app.use(express.json({ limit: '1mb' }));
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/auth', driverRegistrationRouter);
app.use('/api/v1/patients', patientRouter);
app.use('/api/v1/drivers', driverRouter);
app.use('/api/v1/hospitals', hospitalRouter);
app.use('/api/v1/admin', adminRouter);
app.use(errorHandler);
