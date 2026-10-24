import * as Location from 'expo-location';

export interface PickupCoordinates {
  latitude: number;
  longitude: number;
}

export type LocationOutcome =
  | { kind: 'granted'; coordinates: PickupCoordinates }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

/**
 * How long an SOS is willing to wait for a fix. A cold GPS start can take far longer than this,
 * and `getCurrentPositionAsync` has no timeout of its own, so the wait is bounded here: the
 * emergency goes out without coordinates rather than waiting indefinitely for them.
 */
export const LOCATION_TIMEOUT_MS = 5000;

const timeout = (ms: number): Promise<LocationOutcome> =>
  new Promise((resolve) => {
    setTimeout(() => {
      resolve({ kind: 'unavailable' });
    }, ms);
  });

/**
 * One attempt to read the device's position. Resolves to an outcome; never rejects.
 */
const readCoordinates = async (): Promise<LocationOutcome> => {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();

    if (!permission.granted) {
      return { kind: 'denied' };
    }

    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    const { latitude, longitude } = position.coords;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return { kind: 'unavailable' };
    }

    return { kind: 'granted', coordinates: { latitude, longitude } };
  } catch {
    return { kind: 'unavailable' };
  }
};

/**
 * The patient's coordinates, if they can be had.
 *
 * This function never throws and never blocks an SOS. A denied permission, a disabled GPS, a
 * timeout, or a device that simply cannot produce a fix all resolve to an outcome the caller can
 * carry on from: the emergency is created without coordinates and the dispatcher works from the
 * typed address instead. Refusing to send for help because a location is missing would be the
 * worst possible failure mode for this app.
 */
export const requestPickupCoordinates = (): Promise<LocationOutcome> =>
  Promise.race([readCoordinates(), timeout(LOCATION_TIMEOUT_MS)]);
