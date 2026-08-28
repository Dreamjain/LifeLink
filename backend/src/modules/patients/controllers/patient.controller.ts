import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { AuthenticatedPrincipal } from '../../auth/index.js';
import {
  parseContactIdParam,
  parseCreateContactInput,
  parseUpdateContactInput,
  parseUpdateProfileInput,
} from '../schemas/patient.schema.js';
import {
  createOwnContact,
  deleteOwnContact,
  getOwnProfile,
  listOwnContacts,
  updateOwnContact,
  upsertOwnProfile,
} from '../services/patient.service.js';

const requirePrincipal = (req: Request): AuthenticatedPrincipal => {
  if (!req.user) {
    throw new AppError('MISSING_TOKEN', 'Authentication is required.', 401);
  }

  return req.user;
};

export const getProfile = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const profile = await getOwnProfile(principal.userId);

    res.status(200).json({ profile });
  } catch (error) {
    next(error);
  }
};

export const putProfile = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const input = parseUpdateProfileInput(req.body);
    const profile = await upsertOwnProfile(principal.userId, input);

    logger.info(
      { correlationId: req.correlationId, userId: principal.userId },
      'patients.profile.upsert.success',
    );
    res.status(200).json({ profile });
  } catch (error) {
    next(error);
  }
};

export const listContacts = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const contacts = await listOwnContacts(principal.userId);

    res.status(200).json({ contacts });
  } catch (error) {
    next(error);
  }
};

export const createContact = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const input = parseCreateContactInput(req.body);
    const contact = await createOwnContact(principal.userId, input);

    logger.info(
      { correlationId: req.correlationId, userId: principal.userId },
      'patients.contact.create.success',
    );
    res.status(201).json({ contact });
  } catch (error) {
    next(error);
  }
};

export const updateContact = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const contactId = parseContactIdParam(req.params.contactId);
    const input = parseUpdateContactInput(req.body);
    const contact = await updateOwnContact(principal.userId, contactId, input);

    logger.info(
      { correlationId: req.correlationId, userId: principal.userId },
      'patients.contact.update.success',
    );
    res.status(200).json({ contact });
  } catch (error) {
    next(error);
  }
};

export const deleteContact = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const contactId = parseContactIdParam(req.params.contactId);
    await deleteOwnContact(principal.userId, contactId);

    logger.info(
      { correlationId: req.correlationId, userId: principal.userId },
      'patients.contact.delete.success',
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
