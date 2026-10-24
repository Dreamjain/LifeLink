# LifeLink — Patient App

The patient-facing half of LifeLink: register, finish onboarding, raise an SOS, and watch what
happens to it. Built with Expo (SDK 57) and React Native, talking to the LifeLink backend over
plain HTTP.

Task 1.25 covers authentication, onboarding and SOS. Live ambulance positions, maps, ETAs, push
notifications and Socket.IO updates are later tasks; this version polls for status instead.

## What it does

| State             | What the patient sees                                              |
| ----------------- | ------------------------------------------------------------------ |
| Signed out        | Sign in, or create an account                                      |
| `PENDING` account | Their details, then an emergency contact, then the approval screen |
| `ACTIVE` account  | The SOS screen and the status of each request                      |

The three states come straight from the backend's own rules. A newly registered patient is
`PENDING`: they hold a valid token and may complete `GET/PUT /patients/me` and the
`/patients/me/emergency-contacts` routes, which sit behind `requirePatientOnboardingAuth`. They
may **not** raise an emergency — `/patients/me/emergencies` sits behind `requireAuth`, which
admits `ACTIVE` accounts only. An administrator approves the account, after which the app moves
itself to the SOS screen.

## Prerequisites

- Node.js 20 or newer, and npm 10 or newer
- The LifeLink backend running with a reachable PostgreSQL database
- The Expo Go app, an Android emulator, or an iOS simulator

## Install

Dependencies are installed from the repository root, because this app is an npm workspace:

```bash
npm install            # in the repository root, not in mobile-patient/
```

## Connecting to the backend

This is the one piece of setup that regularly goes wrong, so the app tries hard to get it right
on its own: with nothing configured it derives the backend URL from the Expo dev server's own
host (`Constants.expoConfig.hostUri`), because the backend listens on port 3000 of the same
machine that is serving the bundle. On a physical phone sharing a Wi-Fi network with your
laptop, that is usually all you need.

Set `EXPO_PUBLIC_API_BASE_URL` when it is not. Copy `.env.example` to `.env` and fill it in:

| Running on                 | Value                              |
| -------------------------- | ---------------------------------- |
| Physical device over Wi-Fi | `http://<your-LAN-IP>:3000/api/v1` |
| Android emulator           | `http://10.0.2.2:3000/api/v1`      |
| Genymotion                 | `http://10.0.3.2:3000/api/v1`      |
| iOS simulator              | `http://localhost:3000/api/v1`     |

`localhost` on a physical device means the phone itself, which is the most common cause of
"could not reach the LifeLink server". The app names the URL it tried in that error for exactly
this reason.

Two further notes on plain HTTP: `app.json` sets `usesCleartextTraffic` on Android and
`NSAllowsLocalNetworking` on iOS, because the backend serves HTTP rather than HTTPS. The backend
also has no CORS, rate limiting or `/health` endpoint yet, and an unmatched path returns Express's
HTML 404 — the API client tolerates a non-JSON error body for that reason.

## Running

```bash
npm run start --workspace=mobile-patient     # or: npm run dev:patient
npm run android --workspace=mobile-patient
npm run ios --workspace=mobile-patient
```

## Scripts

| Command                                        | What it does                                    |
| ---------------------------------------------- | ----------------------------------------------- |
| `npm run typecheck --workspace=mobile-patient` | `tsc --noEmit`                                  |
| `npm run lint --workspace=mobile-patient`      | ESLint, warnings fatal                          |
| `npm run test --workspace=mobile-patient`      | Jest (jest-expo + React Native Testing Library) |

## How the code is arranged

```
src/
  api/          api-error.ts, client.ts, endpoints.ts  - every HTTP call in the app
  auth/         session.ts (SecureStore), auth-context.tsx (the session + the three states)
  config/       env.ts - the one place a backend URL is decided
  emergency/    idempotency.ts, location.ts, use-emergency-polling.ts
  navigation/   root-navigator.tsx - the auth gate, one stack per state
  screens/      one file per screen
  components/   the shared primitives every screen is built from
  theme/        colours, spacing, type scale
  types/        api.types.ts - a hand-written mirror of the backend contracts
```

Four decisions are worth knowing about:

**The auth gate is structural.** Each state mounts its own navigator, so a screen that belongs to
another state has no route at all. A `PENDING` patient cannot reach the SOS screen even by
mistake, which matches what the backend would allow.

**An SOS reserves its idempotency key before it sends anything.** `POST
/patients/me/emergencies` requires an `Idempotency-Key`, namespaces it per patient, and answers a
repeat with the original emergency (200) instead of creating a second one (201). The key is
therefore generated and written to secure storage _first_, kept if the request fails, and
released only once the attempt has definitively finished. Pressing SOS again after a timeout
replays the one emergency that exists; it never books a second ambulance.

**Location can never block an SOS.** A denied permission, disabled location services, or a fix
that takes longer than five seconds all result in the emergency being sent without coordinates,
and the patient being told so. The typed address is the fallback.

**Status polling stops when it should.** The detail screen asks the backend every five seconds,
and stops on a terminal status (`COMPLETED`, `CANCELLED`, `ESCALATED`, `EXPIRED`,
`HOSPITAL_REJECTED`), when the screen loses navigation focus, and when the app goes to the
background.

## Tests

`npm run test --workspace=mobile-patient`

| Suite                                  | What it pins down                                                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__tests__/api-client.test.ts`         | Base URL derivation, headers, correlation ids, the error envelope, network failure, and that a 401 signs the patient out while a 403 does not      |
| `__tests__/auth-gate.test.tsx`         | Session restoration and the three states, including a stored session that could no longer authenticate                                             |
| `__tests__/sos.test.tsx`               | The SOS path end to end: coordinates, denial, no fix, retry reusing the key, and navigation to the status screen                                   |
| `__tests__/idempotency.test.ts`        | Key format, persistence, reuse on retry, release, and behaviour when secure storage fails                                                          |
| `__tests__/emergency-polling.test.tsx` | The five-second interval, stopping on a terminal status, not polling while inactive, manual refresh, and keeping the last status when a poll fails |

Native modules (`expo-secure-store`, `expo-location`, `expo-constants`) are mocked in
`jest.setup.ts`; each suite overrides them where the behaviour under test depends on them.

## Manual end-to-end walkthrough

1. Start PostgreSQL and the backend (`npm run dev --workspace=backend`).
2. Start this app and check the sign-in screen appears.
3. **Register** with a name, a phone number such as `+15550001111`, and a password of at least
   12 characters. The app moves to "Your details".
4. **Save a profile** — blood group at minimum — and continue.
5. **Add an emergency contact**, then continue to the approval screen.
6. **Approve the account** as an administrator (`POST /api/v1/admin/patients/:userId/approve` with
   an admin token; `GET /api/v1/admin/patients/pending` lists who is waiting). The app stays on the approval screen until asked.
7. Press **Check again**. The app moves to the SOS screen.
8. Press **SOS**. Accept or deny the location prompt — both must send the request — and the
   status screen opens showing "Request received".
9. Watch the status change as a hospital accepts, a bed is reserved and an ambulance is assigned;
   the screen updates within about five seconds of each change.
10. **Cancel** while the status is still "Request received", and confirm it becomes "Cancelled"
    and that updates stop.
11. Force-quit and reopen the app: it returns to the SOS screen without asking for a password.

## Known limitations

- No refresh token. When the access token expires the patient is signed out and signs in again.
- No live ambulance position, no map, no ETA, and no push notifications.
- Status is polled, not pushed. A change is visible within about five seconds.
- No offline SOS queue: an SOS raised with no connectivity fails and must be retried, though the
  retry is safe because the idempotency key is kept.
- No biometric unlock, and no `shared` package — `src/types/api.types.ts` mirrors the backend
  contracts by hand and must be updated when they change.
