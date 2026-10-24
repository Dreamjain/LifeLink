import * as SecureStore from 'expo-secure-store';
import type { ApiUser } from '../types/api.types';

/**
 * Where the patient's session lives between app launches.
 *
 * SecureStore keeps these values in the iOS keychain and in Android's EncryptedSharedPreferences,
 * which is the right place for a bearer token. Task 1.25 has no refresh token, so the token here
 * is the whole session: when it expires the patient signs in again.
 *
 * Every function below is failure-tolerant on purpose. Secure storage can be unavailable (a
 * locked keychain, a device with no secure hardware, a simulator reset), and losing a stored
 * session must only ever mean "sign in again" - never a crash on launch.
 */
const TOKEN_KEY = 'lifelink.patient.accessToken';
const USER_KEY = 'lifelink.patient.user';

export interface StoredSession {
  accessToken: string;
  user: ApiUser;
}

/** Narrow a value read back from storage. Anything unexpected is treated as no session at all. */
const asStoredUser = (value: unknown): ApiUser | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const candidate = value as Partial<ApiUser>;

  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.phone !== 'string' ||
    typeof candidate.displayName !== 'string' ||
    typeof candidate.role !== 'string' ||
    typeof candidate.status !== 'string'
  ) {
    return null;
  }

  return candidate as ApiUser;
};

export const loadSession = async (): Promise<StoredSession | null> => {
  try {
    const [accessToken, rawUser] = await Promise.all([
      SecureStore.getItemAsync(TOKEN_KEY),
      SecureStore.getItemAsync(USER_KEY),
    ]);

    if (!accessToken || !rawUser) {
      return null;
    }

    const user = asStoredUser(JSON.parse(rawUser) as unknown);

    return user === null ? null : { accessToken, user };
  } catch {
    return null;
  }
};

export const saveSession = async (session: StoredSession): Promise<void> => {
  try {
    await Promise.all([
      SecureStore.setItemAsync(TOKEN_KEY, session.accessToken),
      SecureStore.setItemAsync(USER_KEY, JSON.stringify(session.user)),
    ]);
  } catch {
    // The session stays usable for this launch; only persistence across launches is lost.
  }
};

export const clearSession = async (): Promise<void> => {
  try {
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(USER_KEY),
    ]);
  } catch {
    // Nothing more can be done here; the in-memory session is cleared by the caller regardless.
  }
};
