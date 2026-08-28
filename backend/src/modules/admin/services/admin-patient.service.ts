import { UserRole, UserStatus } from '@prisma/client';
import type { EmergencyContact, PatientProfile, User } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';

export interface PendingPatientSummary {
  id: string;
  phone: string;
  displayName: string;
  createdAt: Date;
  hasProfile: boolean;
  contactCount: number;
}

// Admin verification is an identity/completeness check (AuthenticationDesign.md §4), not a clinical
// review, so clinical content (allergies, medicalSummary) is deliberately excluded from this view.
export interface AdminVisiblePatientProfile {
  id: string;
  dateOfBirth: Date | null;
  gender: string | null;
  bloodGroup: PatientProfile['bloodGroup'];
  addressLine: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminVisibleEmergencyContact {
  id: string;
  name: string;
  relationship: string;
  phone: string;
  isPrimary: boolean;
}

export interface PatientVerificationDetail {
  id: string;
  phone: string;
  email: string | null;
  displayName: string;
  status: UserStatus;
  createdAt: Date;
  profile: AdminVisiblePatientProfile | null;
  contacts: AdminVisibleEmergencyContact[];
  isReadyForApproval: boolean;
}

export interface SafeAdminActionResult {
  id: string;
  phone: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
}

const toSafeActionResult = (user: User): SafeAdminActionResult => ({
  id: user.id,
  phone: user.phone,
  displayName: user.displayName,
  role: user.role,
  status: user.status,
});

const toAdminProfile = (profile: PatientProfile): AdminVisiblePatientProfile => ({
  id: profile.id,
  dateOfBirth: profile.dateOfBirth,
  gender: profile.gender,
  bloodGroup: profile.bloodGroup,
  addressLine: profile.addressLine,
  city: profile.city,
  state: profile.state,
  postalCode: profile.postalCode,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

const toAdminContact = (contact: EmergencyContact): AdminVisibleEmergencyContact => ({
  id: contact.id,
  name: contact.name,
  relationship: contact.relationship,
  phone: contact.phone,
  isPrimary: contact.isPrimary,
});

export const listPendingPatients = async (): Promise<PendingPatientSummary[]> => {
  const users = await prisma.user.findMany({
    where: { role: UserRole.PATIENT, status: UserStatus.PENDING },
    orderBy: { createdAt: 'asc' },
    include: { patientProfile: true },
  });

  const profileIds = users
    .map((user) => user.patientProfile?.id)
    .filter((id): id is string => typeof id === 'string');

  const contactCounts =
    profileIds.length > 0
      ? await prisma.emergencyContact.groupBy({
          by: ['patientId'],
          where: { patientId: { in: profileIds } },
          _count: { _all: true },
        })
      : [];
  const countByProfileId = new Map(contactCounts.map((row) => [row.patientId, row._count._all]));

  return users.map((user) => ({
    id: user.id,
    phone: user.phone,
    displayName: user.displayName,
    createdAt: user.createdAt,
    hasProfile: user.patientProfile !== null,
    contactCount: user.patientProfile ? (countByProfileId.get(user.patientProfile.id) ?? 0) : 0,
  }));
};

const PATIENT_NOT_FOUND_ERROR = new AppError(
  'PATIENT_NOT_FOUND',
  'No patient account was found for this id.',
  404,
);

export const getPatientVerificationDetail = async (
  userId: string,
): Promise<PatientVerificationDetail> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { patientProfile: { include: { emergencyContacts: true } } },
  });

  if (!user || user.role !== UserRole.PATIENT) {
    throw PATIENT_NOT_FOUND_ERROR;
  }

  const contacts = user.patientProfile?.emergencyContacts ?? [];

  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt,
    profile: user.patientProfile ? toAdminProfile(user.patientProfile) : null,
    contacts: contacts.map(toAdminContact),
    isReadyForApproval: user.patientProfile !== null && contacts.length > 0,
  };
};

export const approvePatient = async (userId: string): Promise<SafeAdminActionResult> => {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: { patientProfile: true },
    });

    if (!user || user.role !== UserRole.PATIENT) {
      throw PATIENT_NOT_FOUND_ERROR;
    }

    if (user.status !== UserStatus.PENDING) {
      throw new AppError(
        'PATIENT_STATUS_CONFLICT',
        'This patient is not pending verification.',
        409,
      );
    }

    if (!user.patientProfile) {
      throw new AppError(
        'PATIENT_NOT_READY_FOR_APPROVAL',
        'This patient has not completed their profile.',
        409,
      );
    }

    const contactCount = await tx.emergencyContact.count({
      where: { patientId: user.patientProfile.id },
    });

    if (contactCount === 0) {
      throw new AppError(
        'PATIENT_NOT_READY_FOR_APPROVAL',
        'This patient has not added an emergency contact.',
        409,
      );
    }

    const result = await tx.user.updateMany({
      where: { id: userId, role: UserRole.PATIENT, status: UserStatus.PENDING },
      data: { status: UserStatus.ACTIVE },
    });

    if (result.count === 0) {
      throw new AppError(
        'PATIENT_STATUS_CONFLICT',
        'This patient was already processed by another request.',
        409,
      );
    }

    return toSafeActionResult(await tx.user.findUniqueOrThrow({ where: { id: userId } }));
  });
};

export const rejectPatient = async (userId: string): Promise<SafeAdminActionResult> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user || user.role !== UserRole.PATIENT) {
    throw PATIENT_NOT_FOUND_ERROR;
  }

  const result = await prisma.user.updateMany({
    where: { id: userId, role: UserRole.PATIENT, status: UserStatus.PENDING },
    data: { status: UserStatus.REJECTED },
  });

  if (result.count === 0) {
    throw new AppError(
      'PATIENT_STATUS_CONFLICT',
      'This patient was already processed by another request.',
      409,
    );
  }

  return toSafeActionResult(await prisma.user.findUniqueOrThrow({ where: { id: userId } }));
};
