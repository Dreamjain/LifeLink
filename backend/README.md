# LifeLink Backend

Express + TypeScript + Prisma backend. See `docs/AuthenticationDesign.md` and `docs/DatabaseDesign.md` in the repo root for the authoritative design.

## Database-backed tests

The Vitest suite creates and deletes isolated fixtures. It never uses `DATABASE_URL` from
`backend/.env`. For this development setup, create the dedicated PostgreSQL database `lifelink_test`
on the local machine and set `TEST_DATABASE_URL` to it before running
`npm run test --workspace=backend`. The Vitest configuration accepts only `lifelink_test` on
`localhost` or a loopback address, and rejects missing, non-PostgreSQL, unexpected database, and
remote-host URLs before any test modules or fixture code load. Remote test databases require a
separately documented and deliberately approved configuration; they are not implicitly allowed.

Copy `backend/.env.test.example` to the ignored `backend/.env.test` for local reference, then
export `TEST_DATABASE_URL` in the shell that runs Vitest. Do not run migrations, resets, or test
fixtures against `lifelink_dev` or production data.

## Development admin bootstrap

There is **no public registration endpoint for `ADMIN` accounts** — `POST /api/v1/auth/register` only ever creates `PATIENT` users, by design. To get an `ADMIN` account for local development or a demo, use the bootstrap script instead.

This is a **development/demo-only** mechanism. It is not exposed over HTTP, has no API route, and must be run directly against your local database.

1. Set these variables in `backend/.env` (see `backend/.env.example`; never commit real values):

   ```env
   ADMIN_SEED_PHONE=+15550001111
   ADMIN_SEED_EMAIL=dev-admin@example.com
   ADMIN_SEED_DISPLAY_NAME=Development Admin
   ADMIN_SEED_PASSWORD=a-strong-local-only-password
   ```

2. Run:

   ```bash
   npm run seed:admin --workspace=backend
   ```

3. Log in normally via `POST /api/v1/auth/login` with the phone/password above — the created account is `role: ADMIN`, `status: ACTIVE` immediately, so no verification step is needed for it.

The script is idempotent: running it again with the same phone number is a no-op if an `ADMIN` already exists for that phone, and it refuses to overwrite a non-`ADMIN` user. It never prints the password or issues a token.
