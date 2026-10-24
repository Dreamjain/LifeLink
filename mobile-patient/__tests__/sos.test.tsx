import { screen, userEvent, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import { ApiError } from '../src/api/api-error';
import { createEmergency, getEmergency } from '../src/api/endpoints';
import { AuthProvider } from '../src/auth/auth-context';
import { peekIdempotencyKey } from '../src/emergency/idempotency';
import { RootNavigator } from '../src/navigation/root-navigator';
import { renderWithProviders } from '../src/test-support/render';
import type { ApiUser, PatientEmergency } from '../src/types/api.types';

jest.mock('../src/api/endpoints', () => ({
  registerPatient: jest.fn(),
  login: jest.fn(),
  getCurrentUser: jest.fn(),
  getProfile: jest.fn(async () => ({ profile: null })),
  saveProfile: jest.fn(),
  listContacts: jest.fn(async () => ({ contacts: [] })),
  createContact: jest.fn(),
  deleteContact: jest.fn(),
  createEmergency: jest.fn(),
  listEmergencies: jest.fn(async () => ({ emergencies: [] })),
  getEmergency: jest.fn(),
  cancelEmergency: jest.fn(),
}));

const TOKEN_KEY = 'lifelink.patient.accessToken';
const USER_KEY = 'lifelink.patient.user';

const store = new Map<string, string>();

const getItemAsync = SecureStore.getItemAsync as jest.Mock;
const setItemAsync = SecureStore.setItemAsync as jest.Mock;
const deleteItemAsync = SecureStore.deleteItemAsync as jest.Mock;
const requestPermissions = Location.requestForegroundPermissionsAsync as jest.Mock;
const getCurrentPosition = Location.getCurrentPositionAsync as jest.Mock;

const createEmergencyMock = createEmergency as jest.MockedFunction<typeof createEmergency>;
const getEmergencyMock = getEmergency as jest.MockedFunction<typeof getEmergency>;

const activeUser: ApiUser = {
  id: 'user-1',
  phone: '+15550001111',
  email: null,
  displayName: 'Asha Rao',
  role: 'PATIENT',
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const createdEmergency: PatientEmergency = {
  id: '11111111-1111-4111-8111-111111111111',
  requestType: 'SOS',
  severity: 'UNKNOWN',
  currentStatus: 'CREATED',
  description: null,
  pickupAddress: null,
  pickupLatitude: '12.9716',
  pickupLongitude: '77.5946',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  cancelledAt: null,
  completedAt: null,
  expiresAt: null,
};

/** The idempotency key the app sent on a given createEmergency call. */
const sentKey = (callIndex: number): string => {
  const call = createEmergencyMock.mock.calls[callIndex];

  if (call === undefined) {
    throw new Error(`createEmergency was not called ${callIndex + 1} time(s).`);
  }

  return call[1];
};

beforeEach(() => {
  store.clear();
  store.set(TOKEN_KEY, 'stored-token');
  store.set(USER_KEY, JSON.stringify(activeUser));

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

  requestPermissions.mockReset();
  getCurrentPosition.mockReset();
  requestPermissions.mockResolvedValue({ granted: true, status: 'granted' });
  getCurrentPosition.mockResolvedValue({ coords: { latitude: 12.9716, longitude: 77.5946 } });

  createEmergencyMock.mockReset();
  getEmergencyMock.mockReset();
  createEmergencyMock.mockResolvedValue({ emergency: createdEmergency, idempotentReplay: false });
  getEmergencyMock.mockResolvedValue({ emergency: createdEmergency });
});

const renderApp = () =>
  renderWithProviders(
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>,
  );

const pressSos = async (): Promise<void> => {
  const interaction = userEvent.setup();

  await interaction.press(await screen.findByTestId('sos-button'));
};

describe('raising an SOS', () => {
  it('sends the request with coordinates and a persisted idempotency key', async () => {
    await renderApp();
    await pressSos();

    await waitFor(() => {
      expect(createEmergencyMock).toHaveBeenCalledTimes(1);
    });

    const [token, key, input] = createEmergencyMock.mock.calls[0] ?? [];

    expect(token).toBe('stored-token');
    expect(key).toMatch(/^sos-[A-Za-z0-9._:-]+$/);
    expect(input).toEqual({
      requestType: 'SOS',
      pickupLatitude: 12.9716,
      pickupLongitude: 77.5946,
    });

    // The key was written to secure storage before the request, which is what makes a retry a
    // replay rather than a second ambulance.
    expect(setItemAsync).toHaveBeenCalledWith('lifelink.patient.pendingSosKey.user-1', key);
  });

  it('releases the key after a successful request, so the next SOS is a new emergency', async () => {
    await renderApp();
    await pressSos();

    await waitFor(() => {
      expect(createEmergencyMock).toHaveBeenCalledTimes(1);
    });

    await waitFor(async () => {
      await expect(peekIdempotencyKey(activeUser.id)).resolves.toBeNull();
    });
  });

  it('still sends the SOS when location permission is denied', async () => {
    requestPermissions.mockResolvedValue({ granted: false, status: 'denied' });

    await renderApp();
    await pressSos();

    await waitFor(() => {
      expect(createEmergencyMock).toHaveBeenCalledTimes(1);
    });

    // No coordinates, but the request went out. A denied permission must never block a call for
    // help; the dispatcher falls back to the typed address.
    expect(createEmergencyMock.mock.calls[0]?.[2]).toEqual({ requestType: 'SOS' });
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('still sends the SOS when the device cannot produce a fix', async () => {
    getCurrentPosition.mockRejectedValue(new Error('location services are disabled'));

    await renderApp();
    await pressSos();

    await waitFor(() => {
      expect(createEmergencyMock).toHaveBeenCalledTimes(1);
    });

    expect(createEmergencyMock.mock.calls[0]?.[2]).toEqual({ requestType: 'SOS' });
  });

  it('reuses the same idempotency key when a failed attempt is retried', async () => {
    createEmergencyMock.mockRejectedValueOnce(
      new ApiError({ code: 'NETWORK_ERROR', message: 'Could not reach the server.', status: 0 }),
    );

    await renderApp();
    await pressSos();

    expect(await screen.findByTestId('sos-error')).toBeOnTheScreen();

    await pressSos();

    await waitFor(() => {
      expect(createEmergencyMock).toHaveBeenCalledTimes(2);
    });

    // Identical keys: if the first attempt did reach the backend, the second is answered with
    // the emergency that already exists.
    expect(sentKey(1)).toBe(sentKey(0));
  });

  it('opens the status screen for the emergency it created', async () => {
    await renderApp();
    await pressSos();

    expect(await screen.findByText('Your request')).toBeOnTheScreen();
    await waitFor(() => {
      expect(getEmergencyMock).toHaveBeenCalledWith(
        'stored-token',
        createdEmergency.id,
        expect.anything(),
      );
    });
  });
});
