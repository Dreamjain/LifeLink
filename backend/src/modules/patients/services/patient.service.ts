import { Prisma, UserStatus } from '@prisma/client';
import type { EmergencyContact, PatientProfile } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { AuthenticatedPrincipal } from '../../auth/index.js';
import type {
  CreateContactInput,
  UpdateContactInput,
  UpdateProfileInput,
} from '../schemas/patient.schema.js';

const ONBOARDING_ALLOWED_STATUSES: UserStatus[] = [UserStatus.PENDING, UserStatus.ACTIVE];

export interface SafePatientProfile {
  id: string;
  userId: string;
  dateOfBirth: Date | null;
  gender: string | null;
  bloodGroup: PatientProfile['bloodGroup'];
  allergies: string | null;
  medicalSummary: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SafeEmergencyContact {
  id: string;
  patientId: string;
  name: string;
  relationship: string;
  phone: string;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const toSafeProfile = (profile: PatientProfile): SafePatientProfile => ({
  id: profile.id,
  userId: profile.userId,
  dateOfBirth: profile.dateOfBirth,
  gender: profile.gender,
  bloodGroup: profile.bloodGroup,
  allergies: profile.allergies,
  medicalSummary: profile.medicalSummary,
  addressLine: profile.addressLine,
  city: profile.city,
  state: profile.state,
  postalCode: profile.postalCode,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

const toSafeContact = (contact: EmergencyContact): SafeEmergencyContact => ({
  id: contact.id,
  patientId: contact.patientId,
  name: contact.name,
  relationship: contact.relationship,
  phone: contact.phone,
  isPrimary: contact.isPrimary,
  createdAt: contact.createdAt,
  updatedAt: contact.updatedAt,
});

export const loadOnboardingPrincipalFromClaims = async (claims: {
  sub: string;
  jti: string;
}): Promise<AuthenticatedPrincipal> => {
  const user = await prisma.user.findUnique({ where: { id: claims.sub } });

  if (!user || !ONBOARDING_ALLOWED_STATUSES.includes(user.status)) {
    throw new AppError('INACTIVE_ACCOUNT', 'This account is not active.', 403);
  }

  return { userId: user.id, role: user.role, jti: claims.jti };
};

export const getOwnProfile = async (userId: string): Promise<SafePatientProfile | null> => {
  const profile = await prisma.patientProfile.findUnique({ where: { userId } });
  return profile ? toSafeProfile(profile) : null;
};

export const upsertOwnProfile = async (
  userId: string,
  input: UpdateProfileInput,
): Promise<SafePatientProfile> => {
  const profile = await prisma.patientProfile.upsert({
    where: { userId },
    create: { userId, ...input },
    update: { ...input },
  });

  return toSafeProfile(profile);
};

const requireOwnProfile = async (userId: string): Promise<PatientProfile> => {
  const profile = await prisma.patientProfile.findUnique({ where: { userId } });

  if (!profile) {
    throw new AppError(
      'PATIENT_PROFILE_REQUIRED',
      'Complete your patient profile before managing emergency contacts.',
      409,
    );
  }

  return profile;
};

export const listOwnContacts = async (userId: string): Promise<SafeEmergencyContact[]> => {
  const profile = await prisma.patientProfile.findUnique({ where: { userId } });

  if (!profile) {
    return [];
  }

  const contacts = await prisma.emergencyContact.findMany({
    where: { patientId: profile.id },
    orderBy: { createdAt: 'asc' },
  });

  return contacts.map(toSafeContact);
};

export const createOwnContact = async (
  userId: string,
  input: CreateContactInput,
): Promise<SafeEmergencyContact> => {
  const profile = await requireOwnProfile(userId);
  const existingCount = await prisma.emergencyContact.count({ where: { patientId: profile.id } });
  const isPrimary = existingCount === 0 ? true : Boolean(input.isPrimary);

  if (isPrimary && existingCount > 0) {
    const created = await prisma.$transaction(async (tx) => {
      await tx.emergencyContact.updateMany({
        where: { patientId: profile.id, isPrimary: true },
        data: { isPrimary: false },
      });

      return tx.emergencyContact.create({
        data: {
          patientId: profile.id,
          name: input.name,
          relationship: input.relationship,
          phone: input.phone,
          isPrimary: true,
        },
      });
    });

    return toSafeContact(created);
  }

  const created = await prisma.emergencyContact.create({
    data: {
      patientId: profile.id,
      name: input.name,
      relationship: input.relationship,
      phone: input.phone,
      isPrimary,
    },
  });

  return toSafeContact(created);
};

export const updateOwnContact = async (
  userId: string,
  contactId: string,
  input: UpdateContactInput,
): Promise<SafeEmergencyContact> => {
  const profile = await requireOwnProfile(userId);
  const wantsPrimary = input.isPrimary === true;

  const updated = await prisma.$transaction(async (tx) => {
    if (wantsPrimary) {
      await tx.emergencyContact.updateMany({
        where: { patientId: profile.id, isPrimary: true, id: { not: contactId } },
        data: { isPrimary: false },
      });
    }

    const result = await tx.emergencyContact.updateMany({
      where: { id: contactId, patientId: profile.id },
      data: { ...input },
    });

    if (result.count === 0) {
      throw new AppError('RESOURCE_NOT_FOUND', 'Emergency contact not found.', 404);
    }

    return tx.emergencyContact.findUniqueOrThrow({ where: { id: contactId } });
  });

  return toSafeContact(updated);
};

const CONTACT_IN_USE_ERROR = new AppError(
  'CONTACT_IN_USE',
  'This emergency contact cannot be deleted because it has already been referenced by a notification.',
  409,
);

const isForeignKeyRestrictViolation = (error: unknown): boolean =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') ||
  (error instanceof Error && error.message.includes('23001'));

export const deleteOwnContact = async (userId: string, contactId: string): Promise<void> => {
  const profile = await requireOwnProfile(userId);

  const referencedByNotification = await prisma.notification.count({
    where: { emergencyContactId: contactId },
  });

  if (referencedByNotification > 0) {
    throw CONTACT_IN_USE_ERROR;
  }

  try {
    const result = await prisma.emergencyContact.deleteMany({
      where: { id: contactId, patientId: profile.id },
    });

    if (result.count === 0) {
      throw new AppError('RESOURCE_NOT_FOUND', 'Emergency contact not found.', 404);
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (isForeignKeyRestrictViolation(error)) {
      throw CONTACT_IN_USE_ERROR;
    }

    throw error;
  }
};
