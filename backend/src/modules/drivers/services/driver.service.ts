import { Prisma, UserRole, UserStatus, VerificationStatus } from '@prisma/client';
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

export const updateOwnAvailability = async (
  userId: string,
  availabilityStatus: DriverAvailability,
): Promise<SafeDriverProfile> => {
  // Conditional update so an unverified profile can never have availability changed,
  // even if verification state changes between the check and the write.
  const result = await prisma.driverProfile.updateMany({
    where: { userId, verificationStatus: VerificationStatus.VERIFIED },
    data: { availabilityStatus },
  });

  if (result.count === 0) {
    const profile = await prisma.driverProfile.findUnique({ where: { userId } });

    if (!profile) {
      throw DRIVER_NOT_FOUND_ERROR;
    }

    throw new AppError(
      'DRIVER_NOT_VERIFIED',
      'Your driver profile must be verified before you can change availability.',
      403,
    );
  }

  return toSafeDriverProfile(await prisma.driverProfile.findUniqueOrThrow({ where: { userId } }));
};
