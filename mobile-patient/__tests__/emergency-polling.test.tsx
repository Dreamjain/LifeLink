import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { ApiError } from '../src/api/api-error';
import { getEmergency } from '../src/api/endpoints';
import {
  POLL_INTERVAL_MS,
  type EmergencyPollingState,
  useEmergencyPolling,
} from '../src/emergency/use-emergency-polling';
import type { EmergencyStatus, PatientEmergency } from '../src/types/api.types';

jest.mock('../src/api/endpoints', () => ({ getEmergency: jest.fn() }));

const getEmergencyMock = getEmergency as jest.MockedFunction<typeof getEmergency>;
let appStateListener: ((next: AppStateStatus) => void) | null = null;
let appStateSubscription: { remove: jest.Mock };
let appStateSpy: jest.SpyInstance;
let originalAppStateCurrentState: unknown;

const emergency = (currentStatus: EmergencyStatus, id = 'emergency-1'): PatientEmergency => ({
  id,
  requestType: 'SOS',
  severity: 'UNKNOWN',
  currentStatus,
  description: null,
  pickupAddress: null,
  pickupLatitude: null,
  pickupLongitude: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  cancelledAt: null,
  completedAt: null,
  expiresAt: null,
});

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  getEmergencyMock.mockReset();
  appStateListener = null;
  appStateSubscription = { remove: jest.fn() };
  originalAppStateCurrentState = AppState.currentState;
  (AppState as unknown as { currentState: AppStateStatus }).currentState = 'active';
  appStateSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    event: 'change',
    listener: (next: AppStateStatus) => void,
  ) => {
    if (event === 'change') appStateListener = listener;
    return appStateSubscription as unknown as NativeEventSubscription;
  }) as typeof AppState.addEventListener);
});

afterEach(() => {
  appStateSpy.mockRestore();
  (AppState as unknown as { currentState: unknown }).currentState = originalAppStateCurrentState;
  jest.useRealTimers();
});

describe('useEmergencyPolling', () => {
  it('fetches immediately and then once per interval', async () => {
    getEmergencyMock.mockResolvedValue({ emergency: emergency('SEARCHING_HOSPITAL') });
    const { result } = await renderHook(() =>
      useEmergencyPolling({ token: 'token', emergencyId: 'emergency-1' }),
    );
    await waitFor(() => expect(result.current.emergency?.currentStatus).toBe('SEARCHING_HOSPITAL'));
    expect(getEmergencyMock).toHaveBeenCalledTimes(1);
    await advance(POLL_INTERVAL_MS);
    expect(getEmergencyMock).toHaveBeenCalledTimes(2);
    await advance(POLL_INTERVAL_MS);
    expect(getEmergencyMock).toHaveBeenCalledTimes(3);
    expect(result.current.isPolling).toBe(true);
  });

  it('stops polling once the emergency reaches a terminal status', async () => {
    getEmergencyMock.mockResolvedValue({ emergency: emergency('COMPLETED') });
    const { result } = await renderHook(() =>
      useEmergencyPolling({ token: 'token', emergencyId: 'emergency-1' }),
    );
    await waitFor(() => expect(result.current.emergency?.currentStatus).toBe('COMPLETED'));
    const callsWhenFinished = getEmergencyMock.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 4);
    expect(getEmergencyMock).toHaveBeenCalledTimes(callsWhenFinished);
    expect(result.current.isPolling).toBe(false);
  });

  it('clears a terminal emergency and starts polling a new ID without unmounting', async () => {
    let resolveEmergencyB: ((value: { emergency: PatientEmergency }) => void) | undefined;
    getEmergencyMock
      .mockResolvedValueOnce({ emergency: emergency('COMPLETED', 'emergency-A') })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveEmergencyB = resolve;
          }),
      );
    const { result, rerender } = await renderHook<EmergencyPollingState, { emergencyId: string }>(
      ({ emergencyId }) => useEmergencyPolling({ token: 'token', emergencyId }),
      { initialProps: { emergencyId: 'emergency-A' } },
    );

    await waitFor(() => expect(result.current.emergency?.currentStatus).toBe('COMPLETED'));
    expect(result.current.isPolling).toBe(false);

    await act(async () => rerender({ emergencyId: 'emergency-B' }));

    expect(result.current.emergency).toBeNull();
    expect(result.current.isPolling).toBe(true);

    await act(async () => {
      resolveEmergencyB?.({ emergency: emergency('DRIVER_EN_ROUTE', 'emergency-B') });
    });

    await waitFor(() => expect(result.current.emergency?.id).toBe('emergency-B'));
    expect(getEmergencyMock.mock.calls.map(([, id]) => id)).toEqual(['emergency-A', 'emergency-B']);
  });

  it('ignores a late response from the previous emergency after an ID switch', async () => {
    let resolveEmergencyA: ((value: { emergency: PatientEmergency }) => void) | undefined;
    getEmergencyMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveEmergencyA = resolve;
          }),
      )
      .mockResolvedValueOnce({ emergency: emergency('AT_PICKUP', 'emergency-B') });
    const { result, rerender } = await renderHook<EmergencyPollingState, { emergencyId: string }>(
      ({ emergencyId }) => useEmergencyPolling({ token: 'token', emergencyId }),
      { initialProps: { emergencyId: 'emergency-A' } },
    );
    await waitFor(() => expect(getEmergencyMock).toHaveBeenCalledTimes(1));

    await act(async () => rerender({ emergencyId: 'emergency-B' }));
    await waitFor(() => expect(result.current.emergency?.id).toBe('emergency-B'));

    await act(async () => {
      resolveEmergencyA?.({ emergency: emergency('COMPLETED', 'emergency-A') });
    });

    expect(result.current.emergency).toMatchObject({
      id: 'emergency-B',
      currentStatus: 'AT_PICKUP',
    });
  });

  it('does not poll while the screen is unfocused or credentials are missing', async () => {
    const { result: unfocused } = await renderHook(() =>
      useEmergencyPolling({ token: 'token', emergencyId: 'emergency-1', enabled: false }),
    );
    const { result: missingCredentials } = await renderHook(() =>
      useEmergencyPolling({ token: null, emergencyId: null }),
    );
    await advance(POLL_INTERVAL_MS * 3);
    expect(getEmergencyMock).not.toHaveBeenCalled();
    expect(unfocused.current.isPolling).toBe(false);
    expect(missingCredentials.current.isPolling).toBe(false);
  });

  it('does not let a manual refresh bypass a screen that has lost focus', async () => {
    getEmergencyMock.mockResolvedValue({ emergency: emergency('AT_PICKUP') });
    const { result } = await renderHook(() =>
      useEmergencyPolling({ token: 'token', emergencyId: 'emergency-1', enabled: false }),
    );
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
    });
    await advance(POLL_INTERVAL_MS * 2);
    expect(getEmergencyMock).not.toHaveBeenCalled();
  });

  it('performs one immediate manual refresh while eligible, then keeps its normal interval', async () => {
    getEmergencyMock.mockResolvedValue({ emergency: emergency('AT_PICKUP') });
    const { result } = await renderHook(() =>
      useEmergencyPolling({ token: 'token', emergencyId: 'emergency-1' }),
    );
    await waitFor(() => expect(result.current.emergency?.currentStatus).toBe('AT_PICKUP'));
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
    });
    expect(getEmergencyMock).toHaveBeenCalledTimes(2);
    await advance(POLL_INTERVAL_MS);
    expect(getEmergencyMock).toHaveBeenCalledTimes(3);
  });

  it('does not queue a manual refresh when focus is lost immediately afterwards', async () => {
    getEmergencyMock.mockResolvedValue({ emergency: emergency('AT_PICKUP') });
    const { result, rerender } = await renderHook<EmergencyPollingState, { enabled: boolean }>(
      ({ enabled }) => useEmergencyPolling({ token: 'token', emergencyId: 'emergency-1', enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.emergency?.currentStatus).toBe('AT_PICKUP'));
    await act(async () => {
      result.current.refresh();
      await rerender({ enabled: false });
    });
    await advance(POLL_INTERVAL_MS * 2);
    expect(getEmergencyMock).toHaveBeenCalledTimes(1);
  });

  it('does not queue a manual refresh when the app backgrounds immediately afterwards', async () => {
    getEmergencyMock.mockResolvedValue({ emergency: emergency('AT_PICKUP') });
    const { result } = await renderHook(() =>
      useEmergencyPolling({ token: 'token', emergencyId: 'emergency-1' }),
    );
    await waitFor(() => expect(result.current.emergency?.currentStatus).toBe('AT_PICKUP'));
    await act(async () => {
      result.current.refresh();
      appStateListener?.('background');
      await Promise.resolve();
    });
    await advance(POLL_INTERVAL_MS * 2);
    expect(getEmergencyMock).toHaveBeenCalledTimes(1);
  });

  it('resumes polling when the app returns to the foreground', async () => {
    getEmergencyMock.mockResolvedValue({ emergency: emergency('AT_PICKUP') });
    const { result } = await renderHook(() =>
      useEmergencyPolling({ token: 'token', emergencyId: 'emergency-1' }),
    );
    await waitFor(() => expect(result.current.emergency?.currentStatus).toBe('AT_PICKUP'));
    await act(async () => {
      appStateListener?.('background');
      await Promise.resolve();
    });
    await advance(POLL_INTERVAL_MS * 2);
    expect(getEmergencyMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      appStateListener?.('active');
      await Promise.resolve();
    });
    await waitFor(() => expect(getEmergencyMock).toHaveBeenCalledTimes(2));
  });

  it('cleans up the interval and AppState subscription on unmount', async () => {
    getEmergencyMock.mockResolvedValue({ emergency: emergency('AT_PICKUP') });
    const { result, unmount } = await renderHook(() =>
      useEmergencyPolling({ token: 'token', emergencyId: 'emergency-1' }),
    );
    await waitFor(() => expect(result.current.emergency?.currentStatus).toBe('AT_PICKUP'));
    await unmount();
    await advance(POLL_INTERVAL_MS * 2);
    expect(getEmergencyMock).toHaveBeenCalledTimes(1);
    expect(appStateSubscription.remove).toHaveBeenCalledTimes(1);
  });

  it('does not overlap an in-flight request with interval ticks', async () => {
    let resolveFirstRequest: ((value: { emergency: PatientEmergency }) => void) | undefined;
    getEmergencyMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstRequest = resolve;
        }),
    );
    getEmergencyMock.mockResolvedValue({ emergency: emergency('AT_PICKUP') });
    await renderHook(() => useEmergencyPolling({ token: 'token', emergencyId: 'emergency-1' }));
    await waitFor(() => expect(getEmergencyMock).toHaveBeenCalledTimes(1));
    await advance(POLL_INTERVAL_MS * 3);
    expect(getEmergencyMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFirstRequest?.({ emergency: emergency('AT_PICKUP') });
    });
    await advance(POLL_INTERVAL_MS);
    expect(getEmergencyMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known status when a poll fails', async () => {
    getEmergencyMock.mockResolvedValueOnce({ emergency: emergency('DRIVER_EN_ROUTE') });
    getEmergencyMock.mockRejectedValueOnce(
      new ApiError({ code: 'NETWORK_ERROR', message: 'Could not reach the server.', status: 0 }),
    );
    const { result } = await renderHook(() =>
      useEmergencyPolling({ token: 'token', emergencyId: 'emergency-1' }),
    );
    await waitFor(() => expect(result.current.emergency?.currentStatus).toBe('DRIVER_EN_ROUTE'));
    await advance(POLL_INTERVAL_MS);
    await waitFor(() => expect(result.current.error?.code).toBe('NETWORK_ERROR'));
    expect(result.current.emergency?.currentStatus).toBe('DRIVER_EN_ROUTE');
  });
});
