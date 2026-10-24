import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { z } from 'zod';

const DEFAULT_PORT = 3000;
const API_PREFIX = '/api/v1';

const baseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .url('EXPO_PUBLIC_API_BASE_URL must be a valid URL, e.g. http://192.168.1.42:3000/api/v1')
  // A trailing slash would produce `//auth/login` once a path is appended.
  .transform((value) => value.replace(/\/+$/, ''));

/**
 * Host of the Expo dev server, e.g. "192.168.1.42:8081". Expo fills this in when the app is
 * served by `expo start`, which makes it the most reliable way to find the developer's machine
 * on a LAN without hardcoding an IP that changes with the network.
 */
const devServerHost = (): string | null => {
  const hostUri = Constants.expoConfig?.hostUri;

  if (typeof hostUri !== 'string' || hostUri.length === 0) {
    return null;
  }

  const [host] = hostUri.split(':');

  return host && host.length > 0 ? host : null;
};

/**
 * Where the backend is, when no EXPO_PUBLIC_API_BASE_URL was given.
 *
 * Derived from the Expo dev server host, because the backend listens on every interface of the
 * same machine that serves the bundle. The platform fallbacks only matter when that host is
 * unavailable: 10.0.2.2 is the Android emulator's alias for its host, and `localhost` works on
 * the iOS simulator and on web. On a physical device `localhost` is the phone itself, which is
 * why the derived host is tried first.
 */
const derivedBaseUrl = (): string => {
  const host = devServerHost();

  if (host) {
    return `http://${host}:${DEFAULT_PORT}${API_PREFIX}`;
  }

  const fallbackHost = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';

  return `http://${fallbackHost}:${DEFAULT_PORT}${API_PREFIX}`;
};

export interface AppConfig {
  apiBaseUrl: string;
  /** True when the URL came from EXPO_PUBLIC_API_BASE_URL rather than being derived. */
  apiBaseUrlIsExplicit: boolean;
}

/**
 * Resolves configuration once per app start. An explicitly configured base URL always wins and
 * is validated; a malformed one throws here rather than failing later as an opaque fetch error.
 */
export const resolveConfig = (env: Record<string, string | undefined> = process.env): AppConfig => {
  const configured = env.EXPO_PUBLIC_API_BASE_URL;

  if (typeof configured === 'string' && configured.trim().length > 0) {
    const parsed = baseUrlSchema.safeParse(configured);

    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? 'EXPO_PUBLIC_API_BASE_URL is invalid.');
    }

    return { apiBaseUrl: parsed.data, apiBaseUrlIsExplicit: true };
  }

  return { apiBaseUrl: derivedBaseUrl(), apiBaseUrlIsExplicit: false };
};

export const config: AppConfig = resolveConfig();
