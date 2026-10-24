import * as SecureStore from 'expo-secure-store';

/**
 * The key that makes an SOS safe to retry.
 *
 * `POST /patients/me/emergencies` requires an Idempotency-Key header and namespaces it per
 * patient. Sending the same key twice replays the first emergency (200) instead of creating a
 * second one (201). The whole point is therefore that a retry must reuse the key, so the key is
 * reserved and persisted BEFORE the request goes out: if the request times out, the app is
 * killed mid-flight, or the patient presses SOS again, the same key is sent again and the
 * backend answers with the one emergency that already exists.
 *
 * The key is cleared only once an attempt has definitively finished, which starts a genuinely
 * new attempt the next time.
 *
 * Format: `sos-<base36 timestamp>-<random>`. Well inside the backend's 91-character limit for
 * the client portion, and composed only of characters its /^[A-Za-z0-9._:-]+$/ check allows.
 */
const PENDING_KEY_PREFIX = 'lifelink.patient.pendingSosKey';

/**
 * A device can legitimately be shared. Keep each patient's unresolved request separate so an
 * account switch can neither replay nor release another patient's SOS. The user id is a UUID in
 * the current backend, but encoding also keeps this key safe if that implementation changes.
 */
const storageKeyForPatient = (patientUserId: string): string =>
  `${PENDING_KEY_PREFIX}.${encodeURIComponent(patientUserId)}`;

export const newIdempotencyKey = (): string => {
  const random = Math.random().toString(36).slice(2, 12);

  return `sos-${Date.now().toString(36)}-${random}`;
};

/**
 * The key for the current SOS attempt: whatever was reserved by an attempt that never finished,
 * or a fresh key, persisted before it is returned.
 */
export const reserveIdempotencyKey = async (patientUserId: string): Promise<string> => {
  const storageKey = storageKeyForPatient(patientUserId);

  try {
    const existing = await SecureStore.getItemAsync(storageKey);

    if (existing !== null && existing.length > 0) {
      return existing;
    }
  } catch {
    // Unreadable storage must not stop an SOS; fall through to a fresh key.
  }

  const key = newIdempotencyKey();

  try {
    await SecureStore.setItemAsync(storageKey, key);
  } catch {
    // The key still protects this attempt's in-process retries, just not one across a restart.
  }

  return key;
};

/** Ends the current attempt, so the next SOS is a new emergency rather than a replay. */
export const releaseIdempotencyKey = async (patientUserId: string): Promise<void> => {
  try {
    await SecureStore.deleteItemAsync(storageKeyForPatient(patientUserId));
  } catch {
    // A stale key only ever causes a replay of the emergency it created, never a lost one.
  }
};

/** The reserved key, if an attempt is outstanding. Exposed for tests and diagnostics. */
export const peekIdempotencyKey = async (patientUserId: string): Promise<string | null> => {
  try {
    return await SecureStore.getItemAsync(storageKeyForPatient(patientUserId));
  } catch {
    return null;
  }
};
