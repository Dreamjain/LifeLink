import { UserRole, UserStatus, VerificationStatus } from '@prisma/client';
import type { DriverAvailability, DriverProfile, User } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';

export interface PendingDriverSummary {
  id: string;
  phone: string;
  email: string | null;
  displayName: string;
  createdAt: Date;
  driverProfileId: string;
  licenceNumber: string;
  verificationStatus: VerificationStatus;
  availabilityStatus: DriverAvailability;
}

export interface DriverVerificationDetail {
  id: string;
  phone: string;
  email: string | null;
  displayName: string;
  status: UserStatus;
  createdAt: Date;
  driverProfile: {
    id: string;
    licenceNumber: string;
    verificationStatus: VerificationStatus;
    availabilityStatus: DriverAvailability;
    createdAt: Date;
    updatedAt: Date;
  } | null;
}

export interface SafeDriverActionResult {
  id: string;
  phone: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  verificationStatus: VerificationStatus;
}

const DRIVER_NOT_FOUND_ERROR = new AppError(
  'DRIVER_NOT_FOUND',
  'No driver account was found for this id.',
  404,
);

const statusConflict = (): AppError =>
  new AppError('DRIVER_STATUS_CONFLICT', 'This driver is not pending verification.', 409);

const toSummary = (user: User & { driverProfile: DriverProfile }): PendingDriverSummary => ({
  id: user.id,
  phone: user.phone,
  email: user.email,
  displayName: user.displayName,
  createdAt: user.createdAt,
  driverProfileId: user.driverProfile.id,
  licenceNumber: user.driverProfile.licenceNumber,
  verificationStatus: user.driverProfile.verificationStatus,
  availabilityStatus: user.driverProfile.availabilityStatus,
});

export const listPendingDrivers = async (): Promise<PendingDriverSummary[]> => {
  const users = await prisma.user.findMany({
    where: { role: UserRole.DRIVER, status: UserStatus.PENDING },
    orderBy: { createdAt: 'asc' },
    include: { driverProfile: true },
  });

  return users
    .filter((user): user is User & { driverProfile: DriverProfile } => user.driverProfile !== null)
    .map(toSummary);
};

export const getDriverVerificationDetail = async (
  userId: string,
): Promise<DriverVerificationDetail> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { driverProfile: true },
  });

  if (!user || user.role !== UserRole.DRIVER) {
    throw DRIVER_NOT_FOUND_ERROR;
  }

  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt,
    driverProfile: user.driverProfile
      ? {
          id: user.driverProfile.id,
          licenceNumber: user.driverProfile.licenceNumber,
          verificationStatus: user.driverProfile.verificationStatus,
          availabilityStatus: user.driverProfile.availabilityStatus,
          createdAt: user.driverProfile.createdAt,
          updatedAt: user.driverProfile.updatedAt,
        }
      : null,
  };
};

const transitionDriver = async (
  userId: string,
  nextUserStatus: UserStatus,
  nextVerificationStatus: VerificationStatus,
): Promise<SafeDriverActionResult> => {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: { driverProfile: true },
    });

    if (!user || user.role !== UserRole.DRIVER || !user.driverProfile) {
      throw DRIVER_NOT_FOUND_ERROR;
    }

    if (
      user.status !== UserStatus.PENDING ||
      user.driverProfile.verificationStatus !== VerificationStatus.PENDING
    ) {
      throw statusConflict();
    }

    // Conditional updates: a concurrent decision that already moved either row
    // away from PENDING makes this transition affect zero rows and roll back.
    const userResult = await tx.user.updateMany({
      where: { id: userId, role: UserRole.DRIVER, status: UserStatus.PENDING },
      data: { status: nextUserStatus },
    });

    if (userResult.count === 0) {
      throw statusConflict();
    }

    const profileResult = await tx.driverProfile.updateMany({
      where: { userId, verificationStatus: VerificationStatus.PENDING },
      data: { verificationStatus: nextVerificationStatus },
    });

    if (profileResult.count === 0) {
      throw statusConflict();
    }

    const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const updatedProfile = await tx.driverProfile.findUniqueOrThrow({ where: { userId } });

    return {
      id: updatedUser.id,
      phone: updatedUser.phone,
      displayName: updatedUser.displayName,
      role: updatedUser.role,
      status: updatedUser.status,
      verificationStatus: updatedProfile.verificationStatus,
    };
  });
};

export const approveDriver = async (userId: string): Promise<SafeDriverActionResult> =>
  transitionDriver(userId, UserStatus.ACTIVE, VerificationStatus.VERIFIED);

export const rejectDriver = async (userId: string): Promise<SafeDriverActionResult> =>
  transitionDriver(userId, UserStatus.REJECTED, VerificationStatus.REJECTED);
