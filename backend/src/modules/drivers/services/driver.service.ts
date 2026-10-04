import {
  AmbulanceAssignmentStatus,
  Prisma,
  UserRole,
  UserStatus,
  VerificationStatus,
} from '@prisma/client';
import type { DriverAvailability, DriverProfile, User } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import { hashPassword } from '../../auth/index.js';
import type { RegisterDriverInput } from '../schemas/driver.schema.js';

export interface SafeDriverUser {
  id: string;
  phone: string;
  email: string | null;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
}

export interface SafeDriverProfile {
  id: string;
  licenceNumber: string;
  verificationStatus: VerificationStatus;
  availabilityStatus: DriverAvailability;
  createdAt: Date;
  updatedAt: Date;
}

export interface DriverRegistrationResult {
  user: SafeDriverUser;
  driverProfile: SafeDriverProfile;
}

const toSafeDriverUser = (user: User): SafeDriverUser => ({
  id: user.id,
  phone: user.phone,
  email: user.email,
  displayName: user.displayName,
  role: user.role,
  status: user.status,
  createdAt: user.createdAt,
});

const toSafeDriverProfile = (profile: DriverProfile): SafeDriverProfile => ({
  id: profile.id,
  licenceNumber: profile.licenceNumber,
  verificationStatus: profile.verificationStatus,
  availabilityStatus: profile.availabilityStatus,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

const DRIVER_NOT_FOUND_ERROR = new AppError(
  'DRIVER_NOT_FOUND',
  'No driver profile was found for this account.',
  404,
);

export const registerDriver = async (
  input: RegisterDriverInput,
): Promise<DriverRegistrationResult> => {
  const passwordHash = await hashPassword(input.password);

  try {
    // User and DriverProfile are created together: either both exist or neither does.
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          phone: input.phone,
          email: input.email,
          passwordHash,
          role: UserRole.DRIVER,
          status: UserStatus.PENDING,
          displayName: input.displayName,
        },
      });

      const driverProfile = await tx.driverProfile.create({
        data: {
          userId: user.id,
          licenceNumber: input.licenceNumber,
        },
      });

      return { user, driverProfile };
    });

    return {
      user: toSafeDriverUser(created.user),
      driverProfile: toSafeDriverProfile(created.driverProfile),
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(
        'ACCOUNT_ALREADY_EXISTS',
        'An account with this phone number, email, or licence number already exists.',
        409,
      );
    }

    throw error;
  }
};

export const getOwnDriverProfile = async (userId: string): Promise<SafeDriverProfile> => {
  const profile = await prisma.driverProfile.findUnique({ where: { userId } });

  if (!profile) {
    throw DRIVER_NOT_FOUND_ERROR;
  }

  return toSafeDriverProfile(profile);
};

/**
 * Statuses in which a dispatch still owns the driver: an offer awaiting their answer, or a
 * trip they are part-way through. While any of these exists the dispatch workflow is the only
 * thing that may move their availability, so self-service is refused.
 *
 * Without this, a driver mid-trip could set themselves AVAILABLE and be selected again by the
 * Task 1.21 automatic dispatch, giving one driver two live assignments — the invariant
 * DatabaseDesign.md section 6 describes as "only one active assignment per ambulance/driver".
 */
const ACTIVE_ASSIGNMENT_STATUSES = [
  AmbulanceAssignmentStatus.OFFERED,
  AmbulanceAssignmentStatus.ACCEPTED,
  AmbulanceAssignmentStatus.EN_ROUTE,
  AmbulanceAssignmentStatus.AT_PICKUP,
  AmbulanceAssignmentStatus.TRANSPORTING,
];

export const updateOwnAvailability = async (
  userId: string,
  availabilityStatus: DriverAvailability,
): Promise<SafeDriverProfile> => {
  // Conditional update so neither an unverified profile nor a driver committed to a dispatch
  // can have availability changed, even if either state changes between check and write.
  const result = await prisma.driverProfile.updateMany({
    where: {
      userId,
      verificationStatus: VerificationStatus.VERIFIED,
      assignments: { none: { status: { in: ACTIVE_ASSIGNMENT_STATUSES } } },
    },
    data: { availabilityStatus },
  });

  if (result.count === 0) {
    const profile = await prisma.driverProfile.findUnique({ where: { userId } });

    if (!profile) {
      throw DRIVER_NOT_FOUND_ERROR;
    }

    if (profile.verificationStatus !== VerificationStatus.VERIFIED) {
      throw new AppError(
        'DRIVER_NOT_VERIFIED',
        'Your driver profile must be verified before you can change availability.',
        403,
      );
    }

    throw new AppError(
      'DRIVER_HAS_ACTIVE_ASSIGNMENT',
      'Your availability is managed by the dispatch workflow while you hold an active assignment.',
      409,
    );
  }

  return toSafeDriverProfile(await prisma.driverProfile.findUniqueOrThrow({ where: { userId } }));
};
