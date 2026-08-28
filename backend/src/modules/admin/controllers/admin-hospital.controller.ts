import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { AuthenticatedPrincipal } from '../../auth/index.js';
import {
  parseCreateHospitalInput,
  parseHospitalIdParam,
  parseProvisionHospitalAdminInput,
  parseRejectHospitalInput,
  parseVerifyHospitalInput,
} from '../../hospitals/schemas/hospital.schema.js';
import {
  createHospital,
  getHospitalDetail,
  listHospitals,
  provisionHospitalAdmin,
  rejectHospital,
  verifyHospital,
} from '../services/admin-hospital.service.js';

const requirePrincipal = (req: Request): AuthenticatedPrincipal => {
  if (!req.user) {
    throw new AppError('MISSING_TOKEN', 'Authentication is required.', 401);
  }

  return req.user;
};

export const create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const input = parseCreateHospitalInput(req.body);
    const hospital = await createHospital(input);

    logger.info(
      {
        correlationId: req.correlationId,
        adminUserId: principal.userId,
        hospitalId: hospital.id,
        action: 'create-hospital',
      },
      'admin.hospital.create.success',
    );
    res.status(201).json({ hospital });
  } catch (error) {
    next(error);
  }
};

export const list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    requirePrincipal(req);
    const hospitals = await listHospitals();

    res.status(200).json({ hospitals });
  } catch (error) {
    next(error);
  }
};

export const getDetail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    requirePrincipal(req);
    const hospitalId = parseHospitalIdParam(req.params.hospitalId);
    const hospital = await getHospitalDetail(hospitalId);

    res.status(200).json({ hospital });
  } catch (error) {
    next(error);
  }
};

export const verify = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const hospitalId = parseHospitalIdParam(req.params.hospitalId);
    parseVerifyHospitalInput(req.body ?? {});

    const hospital = await verifyHospital(hospitalId);

    logger.info(
      {
        correlationId: req.correlationId,
        adminUserId: principal.userId,
        hospitalId,
        action: 'verify',
      },
      'admin.hospital.verify.success',
    );
    res.status(200).json({ hospital });
  } catch (error) {
    next(error);
  }
};

export const reject = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const hospitalId = parseHospitalIdParam(req.params.hospitalId);
    const input = parseRejectHospitalInput(req.body ?? {});

    const hospital = await rejectHospital(hospitalId);

    logger.info(
      {
        correlationId: req.correlationId,
        adminUserId: principal.userId,
        hospitalId,
        action: 'reject',
        hasReason: Boolean(input.reason),
      },
      'admin.hospital.reject.success',
    );
    res.status(200).json({ hospital });
  } catch (error) {
    next(error);
  }
};

export const provisionAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const hospitalId = parseHospitalIdParam(req.params.hospitalId);
    const input = parseProvisionHospitalAdminInput(req.body);

    const membership = await provisionHospitalAdmin(hospitalId, input);

    logger.info(
      {
        correlationId: req.correlationId,
        adminUserId: principal.userId,
        hospitalId,
        staffUserId: membership.user.id,
        staffRole: membership.staffRole,
        action: 'provision-hospital-admin',
      },
      'admin.hospital.provisionAdmin.success',
    );
    res.status(201).json({ membership });
  } catch (error) {
    next(error);
  }
};
