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
import { getCurrentUser, login as loginRequest, registerPatient } from '../api/endpoints';
import type { ApiUser } from '../types/api.types';
import { clearSession, loadSession, saveSession, type StoredSession } from './session';

/**
 * The three states the app can be in, plus the moment before the stored session has been read.
 *
 * `onboarding` is a PENDING patient: they hold a valid token, they may finish their profile and
 * add an emergency contact, and they may not raise an emergency until an administrator approves
 * the account. That separation is enforced by the backend (`requirePatientOnboardingAuth` versus
 * `requireAuth`); the navigator mirrors it so the patient is never shown a control that would
 * fail with a 403.
 */
export type AuthStatus = 'restoring' | 'unauthenticated' | 'onboarding' | 'active';

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
   * Re-reads the account from the backend. A PENDING patient uses this to find out whether an
   * administrator has approved them: `GET /auth/me` answers 403 INACTIVE_ACCOUNT while they are
   * still pending and 200 once they are ACTIVE.
   */
  refreshAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const statusFor = (user: ApiUser): AuthStatus => {
  if (user.status === 'ACTIVE') {
    return 'active';
  }

  // Only ACTIVE and PENDING patients can obtain a token at all, so anything else here means a
  // stored session that the backend would now refuse. Treat it as signed out.
  return user.status === 'PENDING' ? 'onboarding' : 'unauthenticated';
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

  // Restore on launch. A stored session is trusted without a network round trip, so the app is
  // usable offline up to the first request; the token is only ever proved by using it.
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

      setSession(stored);
      setStatus(nextStatus);
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
    setAuthFailureListener(() => {
      void signOut();
    });

    return () => {
      setAuthFailureListener(null);
    };
  }, [signOut]);

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
      const { user } = await getCurrentUser(session.accessToken);

      await adopt({ accessToken: session.accessToken, user });
    } catch (error) {
      // 403 INACTIVE_ACCOUNT is the expected answer for a patient who is still PENDING: the
      // account is intact and the session must survive. A 401 is handled by the auth-failure
      // listener above, so nothing else has to be done here either.
      if (error instanceof ApiError && (error.status === 403 || error.isAuthFailure)) {
        return;
      }

      throw error;
    }
  }, [adopt, session]);

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
