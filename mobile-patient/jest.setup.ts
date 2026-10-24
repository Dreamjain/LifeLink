import { AppState } from 'react-native';

// The base URL must not depend on whoever runs the suite, so a developer's own
// EXPO_PUBLIC_API_BASE_URL is removed before src/config/env.ts resolves it. With it gone the URL
// is derived from the mocked Expo host below, which keeps the API client's assertions stable.
delete process.env.EXPO_PUBLIC_API_BASE_URL;

// Jest's React Native AppState shim has no foreground state. The application correctly pauses
// polling in that case, so establish the normal foreground state for component tests. Individual
// polling tests still replace and restore this value to exercise lifecycle transitions.
(AppState as unknown as { currentState: string }).currentState = 'active';

// Native modules the app touches. Each test that cares overrides these with a local mock.
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-location', () => ({
  // `granted` is the field src/emergency/location.ts reads; `status` is kept for realism.
  requestForegroundPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  getCurrentPositionAsync: jest.fn(async () => ({
    coords: { latitude: 12.9716, longitude: 77.5946 },
  })),
  Accuracy: { Balanced: 3 },
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { hostUri: '192.168.1.42:8081' } },
}));
