import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { ApiError } from '../api/api-error';
import { getEmergency } from '../api/endpoints';
import { isTerminalEmergencyStatus, type PatientEmergency } from '../types/api.types';

/**
 * How often the status screen asks the backend for the current state of an emergency.
 *
 * Five seconds is the figure the project settled on for Task 1.25: fast enough that a patient
 * sees "the ambulance is on its way" within one breath of it becoming true, slow enough to be
 * affordable. Live updates over Socket.IO are explicitly a later task; this is the interim.
 */
export const POLL_INTERVAL_MS = 5000;

interface UseEmergencyPollingInput {
  token: string | null;
  emergencyId: string | null;
  /**
   * Whether the screen that owns this hook is the one the patient is looking at. The caller
   * supplies navigation focus; the hook watches the app's foreground state itself.
   */
  enabled?: boolean;
  initialEmergency?: PatientEmergency | null;
}

export interface EmergencyPollingState {
  emergency: PatientEmergency | null;
  error: ApiError | null;
  /** True while a request is in flight. */
  isLoading: boolean;
  /** True while the timer is running. False once the emergency is finished, or in the background. */
  isPolling: boolean;
  refresh: () => void;
}

interface PollState {
  identity: string;
  emergency: PatientEmergency | null;
  error: ApiError | null;
  isLoading: boolean;
}

/**
 * Polls one emergency until it is finished.
 *
 * Three things stop the timer, and all three matter: a terminal status (nothing will change
 * again), the screen losing focus, and the app going to the background. Polling a backend from a
 * backgrounded app would spend a patient's battery and data to learn something no one is looking
 * at, and the platforms throttle or kill those timers anyway.
 */
export const useEmergencyPolling = ({
  token,
  emergencyId,
  enabled = true,
  initialEmergency = null,
}: UseEmergencyPollingInput): EmergencyPollingState => {
  const identity = JSON.stringify([token, emergencyId]);
  const [pollState, setPollState] = useState<PollState>(() => ({
    identity,
    emergency: initialEmergency?.id === emergencyId ? initialEmergency : null,
    error: null,
    isLoading: false,
  }));
  const [appActive, setAppActive] = useState(() => AppState.currentState === 'active');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const mounted = useRef(true);

  // Key the visible state to both account and emergency. A new route parameter takes effect in
  // this render, before effects run, so a terminal or private previous emergency is never shown.
  const currentState: PollState =
    pollState.identity === identity
      ? pollState
      : { identity, emergency: null, error: null, isLoading: false };
  const { emergency, error, isLoading } = currentState;

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setAppActive(next === 'active');
    });

    return () => {
      subscription.remove();
    };
  }, []);

  const isFinished = emergency !== null && isTerminalEmergencyStatus(emergency.currentStatus);
  const isPolling = enabled && appActive && !isFinished && token !== null && emergencyId !== null;

  const refresh = useCallback(() => {
    // A manual refresh is permitted only while this screen is eligible to poll. It deliberately
    // does not queue work for a later foreground/focus transition.
    if (isPolling) {
      setRefreshVersion((version) => version + 1);
    }
  }, [isPolling]);

  // Focus, foreground state and terminality are all folded into `isPolling`. A manual refresh
  // changes only `refreshVersion`, which produces one immediate request and a fresh interval;
  // it cannot survive a later transition to an ineligible state.
  useEffect(() => {
    if (!isPolling || token === null || emergencyId === null) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    let requestInFlight = false;

    const poll = async (): Promise<void> => {
      // An interval tick, a foreground transition and a manual refresh may land together. One
      // request at a time prevents stale responses from overwriting newer emergency state.
      if (requestInFlight) {
        return;
      }

      requestInFlight = true;

      if (mounted.current) {
        setPollState((previous) =>
          previous.identity === identity
            ? { ...previous, isLoading: true }
            : { identity, emergency: null, error: null, isLoading: true },
        );
      }

      try {
        const result = await getEmergency(token, emergencyId, controller.signal);

        if (cancelled || !mounted.current) {
          return;
        }

        setPollState({ identity, emergency: result.emergency, error: null, isLoading: true });
      } catch (caught) {
        if (cancelled || !mounted.current) {
          return;
        }

        // A failed poll is not a failed emergency: the last known status stays on screen and the
        // next tick tries again. Only the banner changes.
        setPollState((previous) => ({
          identity,
          emergency: previous.identity === identity ? previous.emergency : null,
          error: caught as ApiError,
          isLoading: true,
        }));
      } finally {
        requestInFlight = false;

        if (!cancelled && mounted.current) {
          setPollState((previous) =>
            previous.identity === identity ? { ...previous, isLoading: false } : previous,
          );
        }
      }
    };

    void poll();

    const timer = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [emergencyId, identity, isPolling, refreshVersion, token]);

  return { emergency, error, isLoading, isPolling, refresh };
};
