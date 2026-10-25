import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError } from '../api/api-error';
import { setAuthFailureListener } from '../api/client';
import {
  getCurrentUser,
  getPatientAccountStatus,
  login as loginRequest,
  registerPatient,
} from '../api/endpoints';
import type { ApiUser } from '../types/api.types';
import { clearSession, loadSession, saveSession, type StoredSession } from './session';

/**
 * The four account states the app can be in, plus the moment before the stored session is read.
 *
 * `onboarding` is a PENDING patient: they hold a valid token, they may finish their profile and
 * add an emergency contact, and they may not raise an emergency until an administrator approves
 * the account. That separation is enforced by the backend (`requirePatientOnboardingAuth` versus
 * `requireAuth`); the navigator mirrors it so the patient is never shown a control that would
 * fail with a 403.
 */
export type AuthStatus = 'restoring' | 'unauthenticated' | 'onboarding' | 'rejected' | 'active';

export interface RegisterInput {
  displayName: string;
  phone: string;
  password: string;
  email?: string;
}

export interface AuthContextValue {
  status: AuthStatus;
  token: string | null;
  user: ApiUser | null;
  signIn: (phone: string, password: string) => Promise<void>;
  signUp: (input: RegisterInput) => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Re-reads the account from the backend. A pending patient uses the status-only endpoint to
   * distinguish waiting, approval and rejection without broadening the active-only `/auth/me`.
   */
  refreshAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const statusFor = (user: ApiUser): AuthStatus => {
  if (user.role === 'PATIENT' && user.status === 'REJECTED') {
    return 'rejected';
  }

  if (user.status === 'ACTIVE') {
    return 'active';
  }

  // Only ACTIVE and PENDING patients can obtain a token at all, so anything else here means a
  // stored session that the backend would now refuse. Treat it as signed out.
  return user.status === 'PENDING' ? 'onboarding' : 'unauthenticated';
};

/** Refreshes a pending patient's cached safe user only when the status endpoint confirms change. */
const refreshPendingPatientSession = async (stored: StoredSession): Promise<StoredSession> => {
  const { status } = await getPatientAccountStatus(stored.accessToken);

  if (status === 'PENDING') {
    return stored;
  }

  if (status === 'REJECTED') {
    return { ...stored, user: { ...stored.user, status: 'REJECTED' } };
  }

  // The status endpoint intentionally returns no user profile. Once ACTIVE is confirmed, use
  // the existing active-only endpoint to refresh the complete safe user representation.
  const { user } = await getCurrentUser(stored.accessToken);

  return { ...stored, user };
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [status, setStatus] = useState<AuthStatus>('restoring');
  const [session, setSession] = useState<StoredSession | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  const adopt = useCallback(async (next: StoredSession): Promise<void> => {
    const nextStatus = statusFor(next.user);

    if (nextStatus === 'unauthenticated') {
      await clearSession();

      if (mounted.current) {
        setSession(null);
        setStatus('unauthenticated');
      }

      return;
    }

    await saveSession(next);

    if (mounted.current) {
      setSession(next);
      setStatus(nextStatus);
    }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    await clearSession();

    if (mounted.current) {
      setSession(null);
      setStatus('unauthenticated');
    }
  }, []);

  // Reconcile ACTIVE sessions before mounting the active navigator. A transient network/server
  // failure falls back to the cached session for offline use; only a definitive auth rejection
  // invalidates it. PENDING sessions intentionally skip /auth/me, which requires ACTIVE status.
  useEffect(() => {
    let cancelled = false;

    const restore = async (): Promise<void> => {
      const stored = await loadSession();

      if (cancelled || !mounted.current) {
        return;
      }

      if (stored === null) {
        setStatus('unauthenticated');

        return;
      }

      const nextStatus = statusFor(stored.user);

      if (nextStatus === 'unauthenticated') {
        await clearSession();

        if (!cancelled && mounted.current) {
          setStatus('unauthenticated');
        }

        return;
      }

      let restored = stored;

      if (nextStatus === 'active') {
        try {
          const { user } = await getCurrentUser(stored.accessToken);
          restored = { ...stored, user };
          await saveSession(restored);
        } catch (error) {
          if (error instanceof ApiError && (error.isAuthFailure || error.isInactiveAccount)) {
            await clearSession();

            if (!cancelled && mounted.current) {
              setSession(null);
              setStatus('unauthenticated');
            }

            return;
          }
          // Network and server failures do not prove that an account is disabled. Keep the
          // encrypted cached session usable and let its next request retry the connection.
        }
      } else if (nextStatus === 'onboarding' && stored.user.role === 'PATIENT') {
        try {
          restored = await refreshPendingPatientSession(stored);

          if (restored !== stored) {
            await saveSession(restored);
          }
        } catch (error) {
          if (error instanceof ApiError && error.isAuthFailure) {
            await clearSession();

            if (!cancelled && mounted.current) {
              setSession(null);
              setStatus('unauthenticated');
            }

            return;
          }
          // Preserve a pending session on transient failures or an undifferentiated inactive
          // response. The latter is not proof of rejection; the next status check may retry.
        }
      }

      if (!cancelled && mounted.current) {
        setSession(restored);
        setStatus(statusFor(restored.user));
      }
    };

    void restore();

    return () => {
      cancelled = true;
    };
  }, []);

  // One place decides that a token is finished. The API client reports every 401 that means the
  // token itself is invalid or expired, which signs the patient out once instead of leaving each
  // screen to discover the failure separately.
  useEffect(() => {
    setAuthFailureListener((error) => {
      if (error.isAuthFailure || (error.isInactiveAccount && session?.user.status === 'ACTIVE')) {
        void signOut();
      }
    });

    return () => {
      setAuthFailureListener(null);
    };
  }, [session, signOut]);

  const signIn = useCallback(
    async (phone: string, password: string): Promise<void> => {
      const result = await loginRequest({ phone: phone.trim(), password });

      await adopt({ accessToken: result.accessToken, user: result.user });
    },
    [adopt],
  );

  const signUp = useCallback(
    async (input: RegisterInput): Promise<void> => {
      const email = input.email?.trim();
      const result = await registerPatient({
        phone: input.phone.trim(),
        password: input.password,
        displayName: input.displayName.trim(),
        ...(email !== undefined && email.length > 0 ? { email } : {}),
      });

      await adopt({ accessToken: result.accessToken, user: result.user });
    },
    [adopt],
  );

  const refreshAccount = useCallback(async (): Promise<void> => {
    if (session === null) {
      return;
    }

    try {
      if (session.user.role === 'PATIENT' && session.user.status === 'PENDING') {
        await adopt(await refreshPendingPatientSession(session));

        return;
      }

      if (session.user.status === 'REJECTED') {
        return;
      }

      const { user } = await getCurrentUser(session.accessToken);

      await adopt({ accessToken: session.accessToken, user });
    } catch (error) {
      // A pending patient may receive an undifferentiated inactive response from the status
      // endpoint. Preserve that session: only the explicit REJECTED status changes its UI.
      if (error instanceof ApiError && error.isInactiveAccount) {
        if (session.user.status === 'ACTIVE') {
          await signOut();
        }

        return;
      }

      if (error instanceof ApiError && error.isAuthFailure) {
        return;
      }

      throw error;
    }
  }, [adopt, session, signOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      token: session?.accessToken ?? null,
      user: session?.user ?? null,
      signIn,
      signUp,
      signOut,
      refreshAccount,
    }),
    [refreshAccount, session, signIn, signOut, signUp, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const value = useContext(AuthContext);

  if (value === null) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }

  return value;
};

/**
 * The token, for screens that only run when a session exists. Throwing here turns a programming
 * mistake into a loud failure in development rather than a silent unauthenticated request.
 */
export const useAuthToken = (): string => {
  const { token } = useAuth();

  if (token === null) {
    throw new Error('This screen requires an authenticated session.');
  }

  return token;
};
