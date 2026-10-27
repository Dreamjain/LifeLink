import { act, screen, userEvent, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { ApiError } from '../src/api/api-error';
import { createEmergency, getEmergency, listEmergencies } from '../src/api/endpoints';
import { AuthProvider } from '../src/auth/auth-context';
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
  listEmergencies: jest.fn(),
  getEmergency: jest.fn(),
  cancelEmergency: jest.fn(),
}));

const getItemAsync = SecureStore.getItemAsync as jest.Mock;
const setItemAsync = SecureStore.setItemAsync as jest.Mock;
const deleteItemAsync = SecureStore.deleteItemAsync as jest.Mock;
const listEmergenciesMock = listEmergencies as jest.MockedFunction<typeof listEmergencies>;
const createEmergencyMock = createEmergency as jest.MockedFunction<typeof createEmergency>;
const getEmergencyMock = getEmergency as jest.MockedFunction<typeof getEmergency>;
const TOKEN_KEY = 'lifelink.patient.accessToken';
const USER_KEY = 'lifelink.patient.user';
const store = new Map<string, string>();

const activeUser: ApiUser = {
  id: 'user-1',
  phone: '+15550001111',
  email: null,
  displayName: 'Asha Rao',
  role: 'PATIENT',
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const listedEmergency: PatientEmergency = {
  id: 'emergency-history-1',
  requestType: 'SOS',
  severity: 'UNKNOWN',
  currentStatus: 'DRIVER_EN_ROUTE',
  description: null,
  pickupAddress: null,
  pickupLatitude: null,
  pickupLongitude: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  cancelledAt: null,
  completedAt: null,
  expiresAt: null,
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
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
  listEmergenciesMock.mockReset();
  createEmergencyMock.mockReset();
  getEmergencyMock.mockReset();
  getEmergencyMock.mockResolvedValue({ emergency: listedEmergency });
});

const renderApp = () =>
  renderWithProviders(
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>,
  );

describe('emergency history feedback', () => {
  it('shows a loading state without disabling SOS', async () => {
    listEmergenciesMock.mockImplementation(() => new Promise(() => undefined));
    await renderApp();
    expect(await screen.findByTestId('history-loading')).toBeOnTheScreen();
    expect(screen.getByTestId('sos-button')).toBeOnTheScreen();
  });

  it('shows an empty state only after a successful empty response', async () => {
    listEmergenciesMock.mockResolvedValue({ emergencies: [] });
    await renderApp();
    expect(await screen.findByTestId('history-empty')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-error')).toBeNull();
  });

  it('shows each successfully loaded emergency', async () => {
    listEmergenciesMock.mockResolvedValue({ emergencies: [listedEmergency] });
    await renderApp();
    expect(await screen.findByTestId(`emergency-${listedEmergency.id}`)).toBeOnTheScreen();
  });

  it('shows a recoverable error instead of presenting a failed request as empty history', async () => {
    listEmergenciesMock.mockRejectedValue(
      new ApiError({ code: 'NETWORK_ERROR', message: 'Could not reach the server.', status: 0 }),
    );
    await renderApp();
    expect(await screen.findByTestId('history-error')).toBeOnTheScreen();
    expect(screen.queryByTestId('history-empty')).toBeNull();
    expect(screen.getByTestId('history-retry')).toBeOnTheScreen();
  });

  it('retries the failed history request', async () => {
    listEmergenciesMock
      .mockRejectedValueOnce(
        new ApiError({ code: 'NETWORK_ERROR', message: 'Offline.', status: 0 }),
      )
      .mockResolvedValueOnce({ emergencies: [listedEmergency] });
    const interaction = userEvent.setup();
    await renderApp();
    await interaction.press(await screen.findByTestId('history-retry'));
    await waitFor(() => expect(listEmergenciesMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId(`emergency-${listedEmergency.id}`)).toBeOnTheScreen();
  });

  it('ignores an older history response that arrives after a newer focus request', async () => {
    const olderRequest = deferred<{ emergencies: PatientEmergency[] }>();
    const newerRequest = deferred<{ emergencies: PatientEmergency[] }>();
    const olderEmergency = { ...listedEmergency, id: 'older-history-result' };
    const newerEmergency = { ...listedEmergency, id: 'newer-history-result' };
    listEmergenciesMock
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(newerRequest.promise);
    createEmergencyMock.mockResolvedValue({
      emergency: listedEmergency,
      idempotentReplay: false,
    });
    const interaction = userEvent.setup();

    await renderApp();
    await waitFor(() => expect(listEmergenciesMock).toHaveBeenCalledTimes(1));

    // Open and leave the detail screen to create a second Home focus/load cycle while the first
    // history request is still pending.
    await interaction.press(await screen.findByTestId('sos-button'));
    await interaction.press(await screen.findByTestId('detail-back'));
    await waitFor(() => expect(listEmergenciesMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      newerRequest.resolve({ emergencies: [newerEmergency] });
      await newerRequest.promise;
    });
    expect(await screen.findByTestId(`emergency-${newerEmergency.id}`)).toBeOnTheScreen();
    expect(screen.queryByTestId('history-loading')).toBeNull();

    await act(async () => {
      olderRequest.resolve({ emergencies: [olderEmergency] });
      await olderRequest.promise;
    });

    expect(screen.getByTestId(`emergency-${newerEmergency.id}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`emergency-${olderEmergency.id}`)).toBeNull();
    expect(screen.queryByTestId('history-error')).toBeNull();
    expect(screen.queryByTestId('history-loading')).toBeNull();
  });

  it('does not let a stale error replace a newer history result or loading state', async () => {
    const olderRequest = deferred<{ emergencies: PatientEmergency[] }>();
    const newerRequest = deferred<{ emergencies: PatientEmergency[] }>();
    const newerEmergency = { ...listedEmergency, id: 'confirmed-newer-result' };
    listEmergenciesMock
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(newerRequest.promise);
    createEmergencyMock.mockResolvedValue({
      emergency: listedEmergency,
      idempotentReplay: false,
    });
    const interaction = userEvent.setup();

    await renderApp();
    await waitFor(() => expect(listEmergenciesMock).toHaveBeenCalledTimes(1));
    await interaction.press(await screen.findByTestId('sos-button'));
    await interaction.press(await screen.findByTestId('detail-back'));
    await waitFor(() => expect(listEmergenciesMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      newerRequest.resolve({ emergencies: [newerEmergency] });
      await newerRequest.promise;
    });
    expect(await screen.findByTestId(`emergency-${newerEmergency.id}`)).toBeOnTheScreen();

    await act(async () => {
      olderRequest.reject(
        new ApiError({ code: 'NETWORK_ERROR', message: 'Stale offline.', status: 0 }),
      );
      await olderRequest.promise.catch(() => undefined);
    });

    expect(screen.getByTestId(`emergency-${newerEmergency.id}`)).toBeOnTheScreen();
    expect(screen.queryByTestId('history-error')).toBeNull();
    expect(screen.queryByTestId('history-loading')).toBeNull();
  });
});
