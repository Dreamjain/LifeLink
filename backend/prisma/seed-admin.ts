// Development/demo-only admin bootstrap — see backend/README.md for usage. No public ADMIN registration exists by design.
import 'dotenv/config';
import { PrismaClient, UserRole, UserStatus } from '@prisma/client';
import { hashPassword } from '../src/modules/auth/index.js';

const prisma = new PrismaClient();

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value || value.trim().length === 0) {
    throw new Error(`${name} must be set to run the admin bootstrap. See backend/.env.example.`);
  }

  return value.trim();
};

const main = async (): Promise<void> => {
  const phone = requireEnv('ADMIN_SEED_PHONE');
  const displayName = requireEnv('ADMIN_SEED_DISPLAY_NAME');
  const password = requireEnv('ADMIN_SEED_PASSWORD');
  const email = process.env.ADMIN_SEED_EMAIL?.trim() || undefined;

  if (password.length < 12) {
    throw new Error('ADMIN_SEED_PASSWORD must be at least 12 characters long.');
  }

  const existing = await prisma.user.findUnique({ where: { phone } });

  if (existing) {
    if (existing.role !== UserRole.ADMIN) {
      throw new Error(
        `A user with phone ${phone} already exists with role ${existing.role}, not ADMIN. Refusing to overwrite.`,
      );
    }

    console.log(
      `Admin bootstrap: an ADMIN user already exists for this phone (id: ${existing.id}). No changes made.`,
    );
    return;
  }

  const passwordHash = await hashPassword(password);
  const admin = await prisma.user.create({
    data: {
      phone,
      email,
      passwordHash,
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      displayName,
    },
  });

  console.log(
    `Admin bootstrap: created ADMIN user (id: ${admin.id}, phone: ${admin.phone}). Credentials were not printed.`,
  );
};

main()
  .catch((error: unknown) => {
    console.error('Admin bootstrap failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
