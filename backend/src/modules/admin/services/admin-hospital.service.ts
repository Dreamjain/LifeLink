import {
  Prisma,
  HospitalStaffRole,
  HospitalStatus,
  MembershipStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import { hashPassword } from '../../auth/index.js';
import {
  toSafeHospital,
  toSafeMembership,
  type SafeHospital,
  type SafeStaffMembership,
} from '../../hospitals/services/hospital.service.js';
import type {
  CreateHospitalInput,
  ProvisionHospitalAdminInput,
} from '../../hospitals/schemas/hospital.schema.js';

const HOSPITAL_NOT_FOUND_ERROR = new AppError(
  'HOSPITAL_NOT_FOUND',
  'No hospital was found for this id.',
  404,
);

const statusConflict = (): AppError =>
  new AppError('HOSPITAL_STATUS_CONFLICT', 'This hospital is not pending verification.', 409);

export interface HospitalDetail extends SafeHospital {
  staff: SafeStaffMembership[];
}

export const createHospital = async (input: CreateHospitalInput): Promise<SafeHospital> => {
  try {
    const hospital = await prisma.hospital.create({
      data: {
        name: input.name,
        registrationNumber: input.registrationNumber,
        phone: input.phone,
        email: input.email,
        addressLine: input.addressLine,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        latitude: input.latitude,
        longitude: input.longitude,
        capabilities: input.capabilities ?? [],
        status: HospitalStatus.PENDING_VERIFICATION,
      },
    });

    return toSafeHospital(hospital);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(
        'HOSPITAL_ALREADY_EXISTS',
        'A hospital with this registration number or email already exists.',
        409,
      );
    }

    throw error;
  }
};

export const listHospitals = async (): Promise<SafeHospital[]> => {
  const hospitals = await prisma.hospital.findMany({ orderBy: { createdAt: 'asc' } });
  return hospitals.map(toSafeHospital);
};

export const getHospitalDetail = async (hospitalId: string): Promise<HospitalDetail> => {
  const hospital = await prisma.hospital.findUnique({
    where: { id: hospitalId },
    include: { staffMemberships: { include: { user: true }, orderBy: { createdAt: 'asc' } } },
  });

  if (!hospital) {
    throw HOSPITAL_NOT_FOUND_ERROR;
  }

  return {
    ...toSafeHospital(hospital),
    staff: hospital.staffMemberships.map(toSafeMembership),
  };
};

const transitionHospital = async (
  hospitalId: string,
  nextStatus: HospitalStatus,
): Promise<SafeHospital> => {
  const hospital = await prisma.hospital.findUnique({ where: { id: hospitalId } });

  if (!hospital) {
    throw HOSPITAL_NOT_FOUND_ERROR;
  }

  // Conditional update: only a hospital still PENDING_VERIFICATION can transition, so a
  // concurrent verify/reject that already landed makes this affect zero rows.
  const result = await prisma.hospital.updateMany({
    where: { id: hospitalId, status: HospitalStatus.PENDING_VERIFICATION },
    data: { status: nextStatus },
  });

  if (result.count === 0) {
    throw statusConflict();
  }

  return toSafeHospital(await prisma.hospital.findUniqueOrThrow({ where: { id: hospitalId } }));
};

export const verifyHospital = async (hospitalId: string): Promise<SafeHospital> =>
  transitionHospital(hospitalId, HospitalStatus.VERIFIED);

export const rejectHospital = async (hospitalId: string): Promise<SafeHospital> =>
  transitionHospital(hospitalId, HospitalStatus.REJECTED);

/**
 * Provisions a hospital's administrator: creates the HOSPITAL_STAFF user and its
 * HospitalStaffRole.ADMIN membership atomically. Requires the hospital to be VERIFIED.
 */
export const provisionHospitalAdmin = async (
  hospitalId: string,
  input: ProvisionHospitalAdminInput,
): Promise<SafeStaffMembership> => {
  const hospital = await prisma.hospital.findUnique({ where: { id: hospitalId } });

  if (!hospital) {
    throw HOSPITAL_NOT_FOUND_ERROR;
  }

  if (hospital.status !== HospitalStatus.VERIFIED) {
    throw new AppError(
      'HOSPITAL_NOT_VERIFIED',
      'This hospital must be verified before staff can be provisioned.',
      409,
    );
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const membership = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          phone: input.phone,
          email: input.email,
          passwordHash,
          role: UserRole.HOSPITAL_STAFF,
          status: UserStatus.ACTIVE,
          displayName: input.displayName,
        },
      });

      return tx.hospitalStaffMembership.create({
        data: {
          hospitalId,
          userId: user.id,
          staffRole: HospitalStaffRole.ADMIN,
          status: MembershipStatus.ACTIVE,
        },
        include: { user: true },
      });
    });

    return toSafeMembership(membership);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(
        'ACCOUNT_ALREADY_EXISTS',
        'An account with this phone number or email already exists.',
        409,
      );
    }

    throw error;
  }
};
