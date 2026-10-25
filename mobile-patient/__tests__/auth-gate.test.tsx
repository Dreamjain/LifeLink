import { Pressable, Text } from 'react-native';
import { screen, userEvent, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { AuthProvider, useAuth } from '../src/auth/auth-context';
import { ApiError } from '../src/api/api-error';
import { getCurrentUser, getPatientAccountStatus, login } from '../src/api/endpoints';
import { RootNavigator } from '../src/navigation/root-navigator';
import { PendingApprovalScreen } from '../src/screens/PendingApprovalScreen';
import { renderWithProviders } from '../src/test-support/render';
import type { ApiUser, UserStatus } from '../src/types/api.types';

jest.mock('../src/api/endpoints', () => ({
  registerPatient: jest.fn(),
  login: jest.fn(),
  getCurrentUser: jest.fn(),
  getPatientAccountStatus: jest.fn(),
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
const getCurrentUserMock = getCurrentUser as jest.MockedFunction<typeof getCurrentUser>;
const getPatientAccountStatusMock = getPatientAccountStatus as jest.MockedFunction<
  typeof getPatientAccountStatus
>;
const loginMock = login as jest.MockedFunction<typeof login>;

const storedUser = (status: UserStatus): ApiUser => ({
  id: 'user-1',
  phone: '+15550001111',
  email: null,
  displayName: 'Asha Rao',
  role: 'PATIENT',
  status,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const seedSession = (status: UserStatus): void => {
  store.set(TOKEN_KEY, 'stored-token');
  store.set(USER_KEY, JSON.stringify(storedUser(status)));
};

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
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue({ user: storedUser('ACTIVE') });
  getPatientAccountStatusMock.mockReset();
  getPatientAccountStatusMock.mockResolvedValue({ status: 'PENDING' });
  loginMock.mockReset();
});

const renderApp = () =>
  renderWithProviders(
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>,
  );

const AccountRefreshProbe = () => {
  const { refreshAccount, status } = useAuth();

  return (
    <>
      <Text testID="auth-status">{status}</Text>
      <Pressable
        testID="refresh-account"
        onPress={() => {
          void refreshAccount();
        }}
      >
        <Text>Refresh account</Text>
      </Pressable>
    </>
  );
};

describe('the auth gate', () => {
  it('shows the sign-in screen when no session is stored', async () => {
    await renderApp();

    expect(await screen.findByRole('header', { name: 'Sign in' })).toBeOnTheScreen();
    expect(screen.queryByTestId('sos-button')).toBeNull();
  });

  it('shows the rejected-account response after a rejected patient signs in again', async () => {
    loginMock.mockRejectedValue(
      new ApiError({
        code: 'ACCOUNT_REJECTED',
        message:
          'Your patient registration was rejected. Please contact LifeLink support for next steps.',
        status: 403,
      }),
    );
    const interaction = userEvent.setup();

    await renderApp();
    await interaction.type(await screen.findByTestId('login-phone'), '+15550001111');
    await interaction.type(await screen.findByTestId('login-password'), 'correct-password');
    await interaction.press(await screen.findByTestId('login-submit'));

    expect(await screen.findByTestId('login-error')).toHaveTextContent(
      'Your patient registration was rejected. Please contact LifeLink support for next steps.',
    );
    expect(screen.queryByTestId('sos-button')).toBeNull();
    expect(screen.queryByTestId('registration-rejected')).toBeNull();
  });

  it('restores a PENDING patient into onboarding, not into the emergency screen', async () => {
    seedSession('PENDING');

    await renderApp();

    // A PENDING account holds a valid token but may not raise an emergency: the backend's
    // onboarding middleware allows the profile and contact routes and nothing else.
    expect(await screen.findByText('Your details')).toBeOnTheScreen();
    expect(screen.queryByTestId('sos-button')).toBeNull();
    expect(screen.queryByText('Sign in')).toBeNull();
    expect(getPatientAccountStatusMock).toHaveBeenCalledWith('stored-token');
    expect(getCurrentUserMock).not.toHaveBeenCalled();
  });

  it('restores a rejected patient to a restricted rejection screen and persists that result', async () => {
    seedSession('PENDING');
    getPatientAccountStatusMock.mockResolvedValue({ status: 'REJECTED' });

    await renderApp();

    expect(await screen.findByTestId('registration-rejected')).toBeOnTheScreen();
    expect(screen.queryByText('Your details')).toBeNull();
    expect(screen.queryByTestId('contacts-continue')).toBeNull();
    expect(screen.queryByTestId('sos-button')).toBeNull();
    expect(screen.queryByTestId('approval-still-pending')).toBeNull();
    expect(store.get(USER_KEY)).toContain('REJECTED');
  });

  it('restores a cached rejected state without mounting protected patient features', async () => {
    seedSession('REJECTED');

    await renderApp();

    expect(await screen.findByTestId('registration-rejected')).toBeOnTheScreen();
    expect(getPatientAccountStatusMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sos-button')).toBeNull();
  });

  it('moves a pending patient into the active app only after status and /auth/me confirm ACTIVE', async () => {
    seedSession('PENDING');
    getPatientAccountStatusMock.mockResolvedValue({ status: 'ACTIVE' });
    getCurrentUserMock.mockResolvedValue({ user: storedUser('ACTIVE') });

    await renderApp();

    expect(await screen.findByTestId('sos-button')).toBeOnTheScreen();
    expect(getPatientAccountStatusMock).toHaveBeenCalledWith('stored-token');
    expect(getCurrentUserMock).toHaveBeenCalledWith('stored-token');
  });

  it('restores an ACTIVE patient straight to the emergency screen', async () => {
    seedSession('ACTIVE');

    await renderApp();

    expect(await screen.findByTestId('sos-button')).toBeOnTheScreen();
    expect(getCurrentUserMock).toHaveBeenCalledWith('stored-token');
    expect(screen.queryByText('Sign in')).toBeNull();
  });

  it('invalidates an ACTIVE stored session when the backend says the account is inactive', async () => {
    seedSession('ACTIVE');
    getCurrentUserMock.mockRejectedValue(
      new ApiError({
        code: 'INACTIVE_ACCOUNT',
        message: 'This account is not active.',
        status: 403,
      }),
    );

    await renderApp();

    expect(await screen.findByRole('header', { name: 'Sign in' })).toBeOnTheScreen();
    await waitFor(() => {
      expect(deleteItemAsync).toHaveBeenCalledWith(TOKEN_KEY);
      expect(deleteItemAsync).toHaveBeenCalledWith(USER_KEY);
    });
  });

  it('preserves a PENDING session on an undifferentiated INACTIVE_ACCOUNT status response', async () => {
    seedSession('PENDING');
    getPatientAccountStatusMock.mockRejectedValue(
      new ApiError({
        code: 'INACTIVE_ACCOUNT',
        message: 'This account is not active.',
        status: 403,
      }),
    );

    const interaction = userEvent.setup();
    await renderWithProviders(
      <AuthProvider>
        <AccountRefreshProbe />
      </AuthProvider>,
    );
    await interaction.press(await screen.findByTestId('refresh-account'));

    expect(await screen.findByTestId('auth-status')).toHaveTextContent('onboarding');
    expect(getPatientAccountStatusMock).toHaveBeenCalledWith('stored-token');
    expect(deleteItemAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['network', new ApiError({ code: 'NETWORK_ERROR', message: 'Offline.', status: 0 })],
    ['server', new ApiError({ code: 'INTERNAL_SERVER_ERROR', message: 'Try again.', status: 500 })],
  ])(
    'preserves pending onboarding and reports transient %s failures without claiming rejection',
    async (_kind, transientError) => {
      seedSession('PENDING');
      getPatientAccountStatusMock.mockRejectedValue(transientError);
      const interaction = userEvent.setup();

      await renderWithProviders(
        <AuthProvider>
          <PendingApprovalScreen />
        </AuthProvider>,
      );
      await interaction.press(await screen.findByTestId('approval-check'));

      expect(await screen.findByTestId('approval-error')).toBeOnTheScreen();
      expect(screen.queryByTestId('approval-still-pending')).toBeNull();
      expect(screen.queryByTestId('registration-rejected')).toBeNull();
      expect(deleteItemAsync).not.toHaveBeenCalled();
      expect(store.get(TOKEN_KEY)).toBe('stored-token');
    },
  );

  it('keeps expired-token semantics for a pending session during status restoration', async () => {
    seedSession('PENDING');
    getPatientAccountStatusMock.mockRejectedValue(
      new ApiError({ code: 'TOKEN_EXPIRED', message: 'Expired.', status: 401 }),
    );

    await renderApp();

    expect(await screen.findByRole('header', { name: 'Sign in' })).toBeOnTheScreen();
    await waitFor(() => expect(deleteItemAsync).toHaveBeenCalledWith(TOKEN_KEY));
  });

  it('clears an ACTIVE session when the backend rejects its token', async () => {
    seedSession('ACTIVE');
    getCurrentUserMock.mockRejectedValue(
      new ApiError({ code: 'TOKEN_EXPIRED', message: 'Expired.', status: 401 }),
    );

    await renderApp();

    expect(await screen.findByRole('header', { name: 'Sign in' })).toBeOnTheScreen();
    await waitFor(() => expect(deleteItemAsync).toHaveBeenCalledWith(TOKEN_KEY));
  });

  it('keeps the cached ACTIVE session on a transient network failure', async () => {
    seedSession('ACTIVE');
    getCurrentUserMock.mockRejectedValue(
      new ApiError({ code: 'NETWORK_ERROR', message: 'Offline.', status: 0 }),
    );

    await renderApp();

    expect(await screen.findByTestId('sos-button')).toBeOnTheScreen();
    expect(deleteItemAsync).not.toHaveBeenCalled();
  });

  it('ignores a stored session whose account could no longer authenticate', async () => {
    store.set(TOKEN_KEY, 'stored-token');
    store.set(USER_KEY, JSON.stringify(storedUser('SUSPENDED')));

    await renderApp();

    expect(await screen.findByRole('header', { name: 'Sign in' })).toBeOnTheScreen();
    await waitFor(() => {
      expect(deleteItemAsync).toHaveBeenCalledWith(TOKEN_KEY);
    });
  });

  it('treats an unreadable stored session as no session', async () => {
    store.set(TOKEN_KEY, 'stored-token');
    store.set(USER_KEY, 'not-json');

    await renderApp();

    expect(await screen.findByRole('header', { name: 'Sign in' })).toBeOnTheScreen();
  });

  it('clears secure storage and returns to sign-in on sign out', async () => {
    seedSession('ACTIVE');

    const interaction = userEvent.setup();

    await renderApp();

    await interaction.press(await screen.findByTestId('home-sign-out'));

    expect(await screen.findByRole('header', { name: 'Sign in' })).toBeOnTheScreen();
    expect(deleteItemAsync).toHaveBeenCalledWith(TOKEN_KEY);
    expect(deleteItemAsync).toHaveBeenCalledWith(USER_KEY);
  });
});
