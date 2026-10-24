import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError } from '../api/api-error';
import { createEmergency, listEmergencies } from '../api/endpoints';
import { FormField } from '../components/FormField';
import { MessageBanner } from '../components/MessageBanner';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenContainer } from '../components/ScreenContainer';
import { statusLabel } from '../components/StatusPill';
import { useAuth, useAuthToken } from '../auth/auth-context';
import { releaseIdempotencyKey, reserveIdempotencyKey } from '../emergency/idempotency';
import { requestPickupCoordinates, type LocationOutcome } from '../emergency/location';
import type { ActiveStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import {
  isTerminalEmergencyStatus,
  type CreateEmergencyInput,
  type PatientEmergency,
} from '../types/api.types';

type Props = NativeStackScreenProps<ActiveStackParamList, 'Home'>;

const LOCATION_MESSAGES: Record<LocationOutcome['kind'], string> = {
  granted: 'Your location was sent with the request.',
  denied: 'Location permission is off, so the request was sent without coordinates.',
  unavailable: 'Your location could not be read, so the request was sent without coordinates.',
};

export const HomeScreen = ({ navigation }: Props) => {
  const token = useAuthToken();
  const { signOut, user } = useAuth();

  const [description, setDescription] = useState('');
  const [pickupAddress, setPickupAddress] = useState('');
  const [emergencies, setEmergencies] = useState<PatientEmergency[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setHistoryLoading(true);
    setHistoryError(null);

    try {
      const result = await listEmergencies(token);

      setEmergencies(result.emergencies);
    } catch (caught) {
      setHistoryError(
        caught instanceof ApiError
          ? caught.displayMessage
          : 'Could not load your emergency history. Please try again.',
      );
    } finally {
      setHistoryLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // A previous attempt may have been interrupted mid-flight. Telling the patient that help is
  // already on the way matters more than a tidy screen.
  useEffect(() => {
    const active = emergencies.find(
      (emergency) => !isTerminalEmergencyStatus(emergency.currentStatus),
    );

    if (active !== undefined) {
      setNotice(`You have a request in progress: ${statusLabel(active.currentStatus)}.`);
    }
  }, [emergencies]);

  /**
   * Raises an SOS.
   *
   * The order of the first two steps is deliberate. The idempotency key is reserved and
   * persisted BEFORE anything can go wrong, so a timeout, a crash or a second press replays the
   * one emergency that exists instead of creating another. The location is then attempted with a
   * bounded wait, and any outcome at all - denied, disabled, timed out - still sends the
   * request. Nothing between the button and the backend is allowed to stop the call for help.
   */
  const raiseSos = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);

    try {
      if (user === null) {
        throw new Error('Your account is unavailable. Please sign in again.');
      }

      const idempotencyKey = await reserveIdempotencyKey(user.id);
      const location = await requestPickupCoordinates();

      const input: CreateEmergencyInput = { requestType: 'SOS' };

      if (description.trim().length > 0) {
        input.description = description.trim();
      }

      if (pickupAddress.trim().length > 0) {
        input.pickupAddress = pickupAddress.trim();
      }

      if (location.kind === 'granted') {
        input.pickupLatitude = location.coordinates.latitude;
        input.pickupLongitude = location.coordinates.longitude;
      }

      const result = await createEmergency(token, idempotencyKey, input);

      // The attempt is finished either way: a replay means the emergency already exists, so the
      // key has done its job and the next SOS must be a new one.
      await releaseIdempotencyKey(user.id);

      setNotice(
        result.idempotentReplay
          ? 'This request was already sent; showing the existing one.'
          : LOCATION_MESSAGES[location.kind],
      );
      setDescription('');
      navigation.navigate('EmergencyDetail', { emergencyId: result.emergency.id });
    } catch (caught) {
      // The key is intentionally NOT released here. Pressing SOS again reuses it, and the
      // backend answers with the original emergency if the first attempt did reach it.
      setError(
        caught instanceof ApiError
          ? caught.displayMessage
          : 'Could not send the request. Press SOS again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContainer
      title="Emergency"
      subtitle={user === null ? undefined : `Signed in as ${user.displayName}.`}
    >
      {error === null ? null : <MessageBanner tone="error" message={error} testID="sos-error" />}
      {notice === null ? null : <MessageBanner tone="info" message={notice} testID="sos-notice" />}

      <Pressable
        accessibilityHint="Sends your location and details to the nearest available hospital."
        accessibilityLabel="Send SOS"
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: busy }}
        disabled={busy}
        onPress={() => {
          void raiseSos();
        }}
        style={({ pressed }) => [
          styles.sos,
          pressed ? styles.sosPressed : null,
          busy ? styles.sosBusy : null,
        ]}
        testID="sos-button"
      >
        <Text style={styles.sosLabel}>SOS</Text>
        <Text style={styles.sosCaption}>{busy ? 'Sending...' : 'Tap to send for help'}</Text>
      </Pressable>

      <View style={styles.form}>
        <FormField
          label="What is happening? (optional)"
          value={description}
          onChangeText={setDescription}
          multiline
          testID="sos-description"
        />
        <FormField
          label="Where are you? (optional)"
          value={pickupAddress}
          onChangeText={setPickupAddress}
          hint="Useful if your phone cannot find your location."
          testID="sos-address"
        />
      </View>

      <View style={styles.history}>
        <Text accessibilityRole="header" style={styles.heading}>
          Your requests
        </Text>
        {historyLoading ? (
          <MessageBanner tone="info" message="Loading your requests..." testID="history-loading" />
        ) : historyError !== null ? (
          <>
            <MessageBanner tone="error" message={historyError} testID="history-error" />
            <PrimaryButton
              label="Retry loading requests"
              variant="secondary"
              onPress={() => {
                void load();
              }}
              accessibilityHint="Tries to load your previous emergency requests again."
              testID="history-retry"
            />
          </>
        ) : emergencies.length === 0 ? (
          <MessageBanner
            tone="info"
            message="You have no previous requests."
            testID="history-empty"
          />
        ) : (
          emergencies.map((emergency) => (
            <Pressable
              accessibilityLabel={`Request from ${new Date(emergency.createdAt).toLocaleString()}: ${statusLabel(emergency.currentStatus)}`}
              accessibilityRole="button"
              key={emergency.id}
              onPress={() => {
                navigation.navigate('EmergencyDetail', { emergencyId: emergency.id });
              }}
              style={styles.historyRow}
              testID={`emergency-${emergency.id}`}
            >
              <Text style={styles.historyStatus}>{statusLabel(emergency.currentStatus)}</Text>
              <Text style={typography.caption}>
                {new Date(emergency.createdAt).toLocaleString()}
              </Text>
            </Pressable>
          ))
        )}
      </View>

      <View style={styles.footer}>
        <PrimaryButton
          label="Sign out"
          variant="secondary"
          onPress={() => {
            void signOut();
          }}
          testID="home-sign-out"
        />
      </View>
    </ScreenContainer>
  );
};

const styles = StyleSheet.create({
  sos: {
    alignItems: 'center',
    backgroundColor: colors.danger,
    borderRadius: radii.md,
    gap: spacing.xs,
    justifyContent: 'center',
    paddingVertical: spacing.xl,
  },
  sosPressed: {
    opacity: 0.85,
  },
  sosBusy: {
    opacity: 0.6,
  },
  sosLabel: {
    color: colors.dangerText,
    fontSize: 56,
    fontWeight: '800',
    letterSpacing: 2,
  },
  sosCaption: {
    color: colors.dangerText,
    fontSize: 16,
    fontWeight: '700',
  },
  form: {
    marginTop: spacing.lg,
  },
  history: {
    marginTop: spacing.sm,
  },
  heading: {
    ...typography.heading,
    marginBottom: spacing.sm,
  },
  historyRow: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.sm,
    borderWidth: 1,
    marginBottom: spacing.sm,
    padding: spacing.sm,
  },
  historyStatus: {
    ...typography.body,
    fontWeight: '700',
  },
  footer: {
    marginTop: spacing.lg,
  },
});
