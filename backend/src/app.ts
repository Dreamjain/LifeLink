import express from 'express';
import { correlationIdMiddleware } from './common/middleware/correlation-id.middleware.js';
import { errorHandler } from './common/middleware/error-handler.middleware.js';

export const app = express();

app.disable('x-powered-by');
app.use(correlationIdMiddleware);
app.use(express.json({ limit: '1mb' }));
app.use(errorHandler);
