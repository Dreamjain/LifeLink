import { screen, userEvent, waitFor } from '@testing-library/react-native';
import * as Auth from '../src/auth/auth-context';
import { getProfile, saveProfile } from '../src/api/endpoints';
import { renderWithProviders } from '../src/test-support/render';
import type { PatientProfile } from '../src/types/api.types';
import { ProfileSetupScreen } from '../src/screens/ProfileSetupScreen';

jest.mock('../src/auth/auth-context', () => ({
  useAuth: jest.fn(() => ({ signOut: jest.fn(), user: null })),
  useAuthToken: jest.fn(() => 'patient-token'),
}));

jest.mock('../src/api/endpoints', () => ({
  getProfile: jest.fn(),
  saveProfile: jest.fn(),
}));

const getProfileMock = getProfile as jest.MockedFunction<typeof getProfile>;
const saveProfileMock = saveProfile as jest.MockedFunction<typeof saveProfile>;
const navigate = jest.fn();

const profile: PatientProfile = {
  id: 'profile-1',
  userId: 'patient-1',
  dateOfBirth: '1990-04-21T00:00:00.000Z',
  gender: 'Woman',
  bloodGroup: 'B_POSITIVE',
  allergies: 'Penicillin',
  medicalSummary: null,
  addressLine: '10 Main Street',
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411001',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const renderScreen = () =>
  renderWithProviders(
    <ProfileSetupScreen
      navigation={{ navigate } as never}
      route={{ key: 'profile', name: 'ProfileSetup', params: undefined } as never}
    />,
  );

beforeEach(() => {
  navigate.mockReset();
  getProfileMock.mockReset();
  saveProfileMock.mockReset();
  saveProfileMock.mockResolvedValue({ profile });
  jest.mocked(Auth.useAuth).mockReturnValue({ signOut: jest.fn(), user: null } as never);
  jest.mocked(Auth.useAuthToken).mockReturnValue('patient-token');
});

describe('patient profile prefill', () => {
  it('prefills a successfully loaded profile before allowing save', async () => {
    getProfileMock.mockResolvedValue({ profile });

    await renderScreen();

    await waitFor(() => expect(screen.getByTestId('profile-gender').props.value).toBe('Woman'));
    expect(screen.getByTestId('profile-dob').props.value).toBe('1990-04-21');
    expect(screen.getByTestId('profile-allergies').props.value).toBe('Penicillin');
    expect(screen.getByTestId('profile-submit').props.accessibilityState.disabled).toBe(false);
  });

  it('allows new-profile onboarding after the backend confirms no profile exists', async () => {
    getProfileMock.mockResolvedValue({ profile: null });
    const interaction = userEvent.setup();

    await renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId('profile-submit').props.accessibilityState.disabled).toBe(false),
    );
    await interaction.press(screen.getByTestId('profile-submit'));

    await waitFor(() =>
      expect(saveProfileMock).toHaveBeenCalledWith('patient-token', {
        bloodGroup: 'UNKNOWN',
      }),
    );
    expect(navigate).toHaveBeenCalledWith('EmergencyContacts');
  });

  it('shows a load error, offers retry, and prevents save after an unsuccessful prefill', async () => {
    getProfileMock.mockRejectedValue(new Error('offline'));
    const interaction = userEvent.setup();

    await renderScreen();

    expect(await screen.findByTestId('profile-load-error')).toBeOnTheScreen();
    expect(screen.getByTestId('profile-load-retry')).toBeOnTheScreen();
    expect(screen.getByTestId('profile-submit').props.accessibilityState.disabled).toBe(true);
    await interaction.press(screen.getByTestId('profile-submit'));
    expect(saveProfileMock).not.toHaveBeenCalled();
  });

  it('retries the profile load and enables save after a successful response', async () => {
    getProfileMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ profile });
    const interaction = userEvent.setup();

    await renderScreen();
    await interaction.press(await screen.findByTestId('profile-load-retry'));

    await waitFor(() => expect(getProfileMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('profile-load-error')).toBeNull();
    expect(screen.getByTestId('profile-submit').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByTestId('profile-gender').props.value).toBe('Woman');
  });
});
