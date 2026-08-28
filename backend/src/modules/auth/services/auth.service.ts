import { Prisma, UserRole, UserStatus } from '@prisma/client';
import type { User } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import { hashPassword, verifyPassword } from '../utils/password.util.js';
import { signAccessToken, verifyAccessToken } from '../utils/jwt.util.js';
import type { AuthenticatedPrincipal } from '../types/auth.types.js';
import type { LoginInput, RegisterInput } from '../schemas/auth.schema.js';

export interface SafeUser {
  id: string;
  phone: string;
  email: string | null;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
}

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: SafeUser;
}

// Not a real credential; keeps login on the same bcrypt-compare path for unknown phones (no existence oracle).
const DUMMY_PASSWORD_HASH = '$2b$12$GN/dDZsvWDvh2kELfg42WOdUB3/XwInVBOsWoe6DfZDv9W0RjIerm';

const toSafeUser = (user: User): SafeUser => ({
  id: user.id,
  phone: user.phone,
  email: user.email,
  displayName: user.displayName,
  role: user.role,
  status: user.status,
  createdAt: user.createdAt,
});

const buildAuthResult = (user: User): LoginResult => {
  const accessToken = signAccessToken({ userId: user.id, role: user.role });
  const claims = verifyAccessToken(accessToken);

  return {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: claims.exp - claims.iat,
    user: toSafeUser(user),
  };
};

export const registerPatient = async (input: RegisterInput): Promise<LoginResult> => {
  const passwordHash = await hashPassword(input.password);

  try {
    const user = await prisma.user.create({
      data: {
        phone: input.phone,
        email: input.email,
        passwordHash,
        role: UserRole.PATIENT,
        status: UserStatus.PENDING,
        displayName: input.displayName,
      },
    });

    return buildAuthResult(user);
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

export const login = async (input: LoginInput): Promise<LoginResult> => {
  const user = await prisma.user.findUnique({ where: { phone: input.phone } });
  const passwordIsValid = await verifyPassword(
    input.password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );

  if (!user || !user.passwordHash || !passwordIsValid) {
    throw new AppError('INVALID_CREDENTIALS', 'Invalid phone number or password.', 401);
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw new AppError('INACTIVE_ACCOUNT', 'This account is not active.', 403);
  }

  return buildAuthResult(user);
};

export const loadActivePrincipalFromClaims = async (claims: {
  sub: string;
  jti: string;
}): Promise<AuthenticatedPrincipal> => {
  const user = await prisma.user.findUnique({ where: { id: claims.sub } });

  if (!user || user.status !== UserStatus.ACTIVE) {
    throw new AppError('INACTIVE_ACCOUNT', 'This account is not active.', 403);
  }

  return { userId: user.id, role: user.role, jti: claims.jti };
};

export const getCurrentUser = async (principal: AuthenticatedPrincipal): Promise<SafeUser> => {
  const user = await prisma.user.findUnique({ where: { id: principal.userId } });

  if (!user || user.status !== UserStatus.ACTIVE) {
    throw new AppError('INACTIVE_ACCOUNT', 'This account is not active.', 403);
  }

  return toSafeUser(user);
};
