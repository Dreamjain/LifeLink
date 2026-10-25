import { act, userEvent, waitFor } from '@testing-library/react-native';
import * as Auth from '../src/auth/auth-context';
import { ApiError } from '../src/api/api-error';
import { cancelEmergency } from '../src/api/endpoints';
import { EmergencyDetailScreen } from '../src/screens/EmergencyDetailScreen';
import { renderWithProviders } from '../src/test-support/render';
import type { EmergencyPollingState } from '../src/emergency/use-emergency-polling';
import type { EmergencyStatus, PatientEmergency } from '../src/types/api.types';

jest.mock('../src/auth/auth-context', () => ({
  useAuthToken: jest.fn(() => 'patient-token'),
}));

jest.mock('@react-navigation/native', () => ({ useIsFocused: jest.fn(() => true) }));

jest.mock('../src/api/endpoints', () => ({ cancelEmergency: jest.fn() }));

jest.mock('../src/emergency/use-emergency-polling', () => ({
  POLL_INTERVAL_MS: 5000,
  useEmergencyPolling: jest.fn(),
}));

const cancelEmergencyMock = cancelEmergency as jest.MockedFunction<typeof cancelEmergency>;
const useEmergencyPollingMock = jest.requireMock('../src/emergency/use-emergency-polling')
  .useEmergencyPolling as jest.Mock;
const refresh = jest.fn();
const navigate = jest.fn();

const emergency = (currentStatus: EmergencyStatus): PatientEmergency => ({
  id: 'emergency-1',
  requestType: 'SOS',
  severity: 'UNKNOWN',
  currentStatus,
  description: null,
  pickupAddress: null,
  pickupLatitude: null,
  pickupLongitude: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  cancelledAt: currentStatus === 'CANCELLED' ? '2026-01-01T00:05:00.000Z' : null,
  completedAt: null,
  expiresAt: null,
});

const renderScreen = async (currentStatus: EmergencyStatus) => {
  const route = {
    key: 'detail',
    name: 'EmergencyDetail',
    params: { emergencyId: 'emergency-1' },
  } as never;
  const navigation = { navigate } as never;
  const pollingState: EmergencyPollingState = {
    emergency: emergency(currentStatus),
    error: null,
    isLoading: false,
    isPolling: currentStatus === 'CREATED',
    refresh,
  };
  useEmergencyPollingMock.mockReturnValue(pollingState);

  const element = <EmergencyDetailScreen navigation={navigation} route={route} />;

  return { view: await renderWithProviders(element), element };
};

beforeEach(() => {
  navigate.mockReset();
  refresh.mockReset();
  cancelEmergencyMock.mockReset();
  jest.mocked(Auth.useAuthToken).mockReturnValue('patient-token');
});

describe('emergency cancellation', () => {
  it('offers cancellation only while the emergency is CREATED', async () => {
    const created = await renderScreen('CREATED');
    expect(await created.view.findByTestId('detail-cancel')).toBeOnTheScreen();

    await created.view.unmount();
    const pending = await renderScreen('PENDING_HOSPITAL_RESPONSE');
    expect(pending.view.queryByTestId('detail-cancel')).toBeNull();
    await pending.view.unmount();
  });

  it('refreshes details only after the backend confirms cancellation', async () => {
    let resolveCancellation: ((value: { emergency: PatientEmergency }) => void) | undefined;
    cancelEmergencyMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCancellation = resolve;
      }),
    );
    const interaction = userEvent.setup();
    const view = await renderScreen('CREATED');

    await interaction.press(await view.view.findByTestId('detail-cancel'));
    await waitFor(() =>
      expect(cancelEmergencyMock).toHaveBeenCalledWith('patient-token', 'emergency-1'),
    );
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      resolveCancellation?.({ emergency: emergency('CANCELLED') });
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    const updatedPollingState: EmergencyPollingState = {
      emergency: emergency('CANCELLED'),
      error: null,
      isLoading: false,
      isPolling: false,
      refresh,
    };
    useEmergencyPollingMock.mockReturnValue(updatedPollingState);
    await act(async () => view.view.rerender(view.element));
    expect(view.view.getByTestId('status-pill')).toHaveTextContent('Cancelled');
    expect(view.view.getByTestId('detail-polling-note')).toHaveTextContent(
      'This request is finished. Updates have stopped.',
    );
  });

  it.each([
    [
      'server status conflict',
      new ApiError({
        code: 'EMERGENCY_STATUS_CONFLICT',
        message: 'Only a CREATED emergency can be cancelled.',
        status: 409,
      }),
    ],
    [
      'network failure',
      new ApiError({ code: 'NETWORK_ERROR', message: 'Could not reach the server.', status: 0 }),
    ],
  ])('shows no false success after a %s', async (_label, failure) => {
    cancelEmergencyMock.mockRejectedValue(failure);
    const interaction = userEvent.setup();

    const view = await renderScreen('CREATED');
    await interaction.press(await view.view.findByTestId('detail-cancel'));

    expect(await view.view.findByTestId('detail-cancel-error')).toBeOnTheScreen();
    expect(view.view.getByTestId('status-pill')).toHaveTextContent('Request received');
    expect(view.view.queryByText('Cancelled')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});
