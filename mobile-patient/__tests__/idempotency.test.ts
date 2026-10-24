import * as SecureStore from 'expo-secure-store';
import {
  newIdempotencyKey,
  peekIdempotencyKey,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
} from '../src/emergency/idempotency';

const store = new Map<string, string>();

const getItemAsync = SecureStore.getItemAsync as jest.Mock;
const setItemAsync = SecureStore.setItemAsync as jest.Mock;
const deleteItemAsync = SecureStore.deleteItemAsync as jest.Mock;
const patientA = 'patient-a';
const patientB = 'patient-b';

beforeEach(() => {
  store.clear();
  getItemAsync.mockReset();
  setItemAsync.mockReset();
  deleteItemAsync.mockReset();
  getItemAsync.mockImplementation(async (key: string) => store.get(key) ?? null);
  setItemAsync.mockImplementation(async (key: string, value: string) => {
    store.set(key, value);
  });
  deleteItemAsync.mockImplementation(async (key: string) => {
    store.delete(key);
  });
});

describe('SOS idempotency key', () => {
  it('produces a key the backend will accept', () => {
    const key = newIdempotencyKey();

    // The backend caps the client portion at 91 characters and allows only these characters.
    expect(key.length).toBeLessThanOrEqual(91);
    expect(key).toMatch(/^[A-Za-z0-9._:-]+$/);
  });

  it('persists the key before the request goes out', async () => {
    const key = await reserveIdempotencyKey(patientA);

    expect(setItemAsync).toHaveBeenCalledWith('lifelink.patient.pendingSosKey.patient-a', key);
    await expect(peekIdempotencyKey(patientA)).resolves.toBe(key);
  });

  it('reuses the reserved key, so a retry replays instead of creating a second emergency', async () => {
    const first = await reserveIdempotencyKey(patientA);
    const second = await reserveIdempotencyKey(patientA);

    expect(second).toBe(first);
    expect(setItemAsync).toHaveBeenCalledTimes(1);
  });

  it('starts a new attempt once the previous one is released', async () => {
    const first = await reserveIdempotencyKey(patientA);

    await releaseIdempotencyKey(patientA);

    await expect(peekIdempotencyKey(patientA)).resolves.toBeNull();

    const second = await reserveIdempotencyKey(patientA);

    expect(second).not.toBe(first);
  });

  it('still returns a key when secure storage is unavailable', async () => {
    getItemAsync.mockRejectedValue(new Error('keychain locked'));
    setItemAsync.mockRejectedValue(new Error('keychain locked'));

    const key = await reserveIdempotencyKey(patientA);

    // Losing persistence must never stop an SOS; only the cross-restart guarantee is lost.
    expect(key).toMatch(/^sos-/);
  });

  it('keeps unresolved SOS records separate for two accounts on one device', async () => {
    const aKey = await reserveIdempotencyKey(patientA);
    const bKey = await reserveIdempotencyKey(patientB);

    expect(aKey).not.toBe(bKey);
    await expect(peekIdempotencyKey(patientA)).resolves.toBe(aKey);
    await expect(peekIdempotencyKey(patientB)).resolves.toBe(bKey);

    await releaseIdempotencyKey(patientB);

    // Signing in as B and completing B's request never releases A's unresolved retry key.
    await expect(peekIdempotencyKey(patientA)).resolves.toBe(aKey);
    await expect(peekIdempotencyKey(patientB)).resolves.toBeNull();
  });

  it('returns to an account after a switch with its original unresolved retry key', async () => {
    const firstAttempt = await reserveIdempotencyKey(patientA);
    await reserveIdempotencyKey(patientB);

    const retryAfterSwitch = await reserveIdempotencyKey(patientA);

    expect(retryAfterSwitch).toBe(firstAttempt);
  });
});
