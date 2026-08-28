import { Prisma, MembershipStatus, UserRole, UserStatus } from '@prisma/client';
import type { Hospital, HospitalStaffMembership, HospitalStaffRole, User } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import { hashPassword } from '../../auth/index.js';
import type { CreateHospitalStaffInput } from '../schemas/hospital.schema.js';
import type { HospitalStaffContext } from '../types/hospital.types.js';

export interface SafeHospital {
  id: string;
  name: string;
  registrationNumber: string;
  phone: string;
  email: string | null;
  addressLine: string;
  city: string;
  state: string;
  postalCode: string;
  latitude: string | null;
  longitude: string | null;
  capabilities: Prisma.JsonValue;
  status: Hospital['status'];
  createdAt: Date;
  updatedAt: Date;
}

export interface SafeStaffMembership {
  id: string;
  hospitalId: string;
  staffRole: HospitalStaffRole;
  status: MembershipStatus;
  createdAt: Date;
  user: {
    id: string;
    phone: string;
    email: string | null;
    displayName: string;
    status: UserStatus;
  };
}

export const toSafeHospital = (hospital: Hospital): SafeHospital => ({
  id: hospital.id,
  name: hospital.name,
  registrationNumber: hospital.registrationNumber,
  phone: hospital.phone,
  email: hospital.email,
  addressLine: hospital.addressLine,
  city: hospital.city,
  state: hospital.state,
  postalCode: hospital.postalCode,
  latitude: hospital.latitude?.toString() ?? null,
  longitude: hospital.longitude?.toString() ?? null,
  capabilities: hospital.capabilities,
  status: hospital.status,
  createdAt: hospital.createdAt,
  updatedAt: hospital.updatedAt,
});

export const toSafeMembership = (
  membership: HospitalStaffMembership & { user: User },
): SafeStaffMembership => ({
  id: membership.id,
  hospitalId: membership.hospitalId,
  staffRole: membership.staffRole,
  status: membership.status,
  createdAt: membership.createdAt,
  user: {
    id: membership.user.id,
    phone: membership.user.phone,
    email: membership.user.email,
    displayName: membership.user.displayName,
    status: membership.user.status,
  },
});

export const HOSPITAL_SCOPE_DENIED_ERROR = new AppError(
  'HOSPITAL_SCOPE_DENIED',
  'You do not have an active hospital membership.',
  403,
);

/**
 * Resolves the caller's hospital scope purely from their own active membership.
 * No hospital identifier is ever accepted from the request.
 */
export const resolveHospitalStaffContext = async (
  userId: string,
): Promise<HospitalStaffContext> => {
  const membership = await prisma.hospitalStaffMembership.findFirst({
    where: { userId, status: MembershipStatus.ACTIVE },
    orderBy: { createdAt: 'asc' },
  });

  if (!membership) {
    throw HOSPITAL_SCOPE_DENIED_ERROR;
  }

  return {
    membershipId: membership.id,
    hospitalId: membership.hospitalId,
    staffRole: membership.staffRole,
    membershipStatus: membership.status,
  };
};

export interface OwnHospitalContext {
  hospital: SafeHospital;
  membership: {
    id: string;
    staffRole: HospitalStaffRole;
    status: MembershipStatus;
  };
}

export const getOwnHospitalContext = async (
  context: HospitalStaffContext,
): Promise<OwnHospitalContext> => {
  const hospital = await prisma.hospital.findUnique({ where: { id: context.hospitalId } });

  if (!hospital) {
    throw HOSPITAL_SCOPE_DENIED_ERROR;
  }

  return {
    hospital: toSafeHospital(hospital),
    membership: {
      id: context.membershipId,
      staffRole: context.staffRole,
      status: context.membershipStatus,
    },
  };
};

export const listOwnHospitalStaff = async (
  context: HospitalStaffContext,
): Promise<SafeStaffMembership[]> => {
  const memberships = await prisma.hospitalStaffMembership.findMany({
    where: { hospitalId: context.hospitalId },
    orderBy: { createdAt: 'asc' },
    include: { user: true },
  });

  return memberships.map(toSafeMembership);
};

/**
 * Creates a new hospital staff account plus its membership atomically, scoped to the
 * caller's own hospital. The staff role is validated by the schema to exclude ADMIN,
 * and User.role/status are server-assigned.
 */
export const createHospitalStaff = async (
  context: HospitalStaffContext,
  input: CreateHospitalStaffInput,
): Promise<SafeStaffMembership> => {
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
          hospitalId: context.hospitalId,
          userId: user.id,
          staffRole: input.staffRole,
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
