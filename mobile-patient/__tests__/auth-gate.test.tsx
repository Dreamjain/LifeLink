import { screen, userEvent, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { AuthProvider } from '../src/auth/auth-context';
import { RootNavigator } from '../src/navigation/root-navigator';
import { renderWithProviders } from '../src/test-support/render';
import type { ApiUser, UserStatus } from '../src/types/api.types';

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
});

const renderApp = () =>
  renderWithProviders(
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>,
  );

describe('the auth gate', () => {
  it('shows the sign-in screen when no session is stored', async () => {
    await renderApp();

    expect(await screen.findByRole('header', { name: 'Sign in' })).toBeOnTheScreen();
    expect(screen.queryByTestId('sos-button')).toBeNull();
  });

  it('restores a PENDING patient into onboarding, not into the emergency screen', async () => {
    seedSession('PENDING');

    await renderApp();

    // A PENDING account holds a valid token but may not raise an emergency: the backend's
    // onboarding middleware allows the profile and contact routes and nothing else.
    expect(await screen.findByText('Your details')).toBeOnTheScreen();
    expect(screen.queryByTestId('sos-button')).toBeNull();
    expect(screen.queryByText('Sign in')).toBeNull();
  });

  it('restores an ACTIVE patient straight to the emergency screen', async () => {
    seedSession('ACTIVE');

    await renderApp();

    expect(await screen.findByTestId('sos-button')).toBeOnTheScreen();
    expect(screen.queryByText('Sign in')).toBeNull();
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
