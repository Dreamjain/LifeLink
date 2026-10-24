import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError } from '../api/api-error';
import { cancelEmergency } from '../api/endpoints';
import { MessageBanner } from '../components/MessageBanner';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenContainer } from '../components/ScreenContainer';
import { StatusPill } from '../components/StatusPill';
import { useAuthToken } from '../auth/auth-context';
import { POLL_INTERVAL_MS, useEmergencyPolling } from '../emergency/use-emergency-polling';
import type { ActiveStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { isTerminalEmergencyStatus } from '../types/api.types';

type Props = NativeStackScreenProps<ActiveStackParamList, 'EmergencyDetail'>;

const Row = ({ label, value }: { label: string; value: string }) => (
  <View style={styles.row}>
    <Text style={styles.rowLabel}>{label}</Text>
    <Text style={styles.rowValue}>{value}</Text>
  </View>
);

const formatTime = (iso: string): string => new Date(iso).toLocaleString();

export const EmergencyDetailScreen = ({ navigation, route }: Props) => {
  const token = useAuthToken();
  const { emergencyId } = route.params;
  // Navigation focus is the caller's half of the polling contract; the hook watches the app's
  // foreground state itself. Together they mean the timer only runs while someone is looking.
  const isFocused = useIsFocused();
  const { emergency, error, isLoading, isPolling, refresh } = useEmergencyPolling({
    token,
    emergencyId,
    enabled: isFocused,
  });

  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const cancel = async (): Promise<void> => {
    setCancelError(null);
    setCancelling(true);

    try {
      await cancelEmergency(token, emergencyId);
      refresh();
    } catch (caught) {
      setCancelError(
        caught instanceof ApiError
          ? caught.displayMessage
          : 'Could not cancel the request. Please try again.',
      );
    } finally {
      setCancelling(false);
    }
  };

  const finished = emergency !== null && isTerminalEmergencyStatus(emergency.currentStatus);
  // Cancelling is only possible before a hospital has been involved, which is exactly the
  // window the backend allows: CREATED and nothing later.
  const canCancel = emergency !== null && emergency.currentStatus === 'CREATED';

  return (
    <ScreenContainer title="Your request" subtitle={`Reference ${emergencyId.slice(0, 8)}`}>
      {emergency === null ? (
        <MessageBanner
          tone="info"
          message={isLoading ? 'Loading your request...' : 'Waiting for the latest status.'}
          testID="detail-loading"
        />
      ) : (
        <>
          <StatusPill status={emergency.currentStatus} />

          <View style={styles.card}>
            <Row label="Raised" value={formatTime(emergency.createdAt)} />
            <Row label="Last change" value={formatTime(emergency.updatedAt)} />
            <Row label="Severity" value={emergency.severity} />
            {emergency.description === null ? null : (
              <Row label="Details" value={emergency.description} />
            )}
            {emergency.pickupAddress === null ? null : (
              <Row label="Address" value={emergency.pickupAddress} />
            )}
            {emergency.pickupLatitude === null || emergency.pickupLongitude === null ? (
              <Row label="Location" value="Not sent with this request" />
            ) : (
              <Row
                label="Location"
                value={`${emergency.pickupLatitude}, ${emergency.pickupLongitude}`}
              />
            )}
          </View>

          <Text style={styles.pollingNote} testID="detail-polling-note">
            {finished
              ? 'This request is finished. Updates have stopped.'
              : isPolling
                ? `Checking for updates every ${POLL_INTERVAL_MS / 1000} seconds.`
                : 'Updates are paused while this screen is in the background.'}
          </Text>
        </>
      )}

      {error === null ? null : (
        <MessageBanner
          tone="error"
          message={`Could not refresh the status: ${error.displayMessage}`}
          testID="detail-poll-error"
        />
      )}

      {cancelError === null ? null : (
        <MessageBanner tone="error" message={cancelError} testID="detail-cancel-error" />
      )}

      <View style={styles.actions}>
        <PrimaryButton
          label="Refresh now"
          variant="secondary"
          onPress={refresh}
          busy={isLoading}
          testID="detail-refresh"
        />
        {canCancel ? (
          <PrimaryButton
            label="Cancel this request"
            variant="danger"
            onPress={() => {
              void cancel();
            }}
            busy={cancelling}
            accessibilityHint="Stops the search for an ambulance."
            testID="detail-cancel"
          />
        ) : null}
        <PrimaryButton
          label="Back to emergency screen"
          variant="secondary"
          onPress={() => {
            navigation.navigate('Home');
          }}
          testID="detail-back"
        />
      </View>
    </ScreenContainer>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.sm,
    borderWidth: 1,
    marginTop: spacing.md,
    padding: spacing.sm,
  },
  row: {
    marginBottom: spacing.sm,
  },
  rowLabel: {
    ...typography.caption,
    fontWeight: '700',
  },
  rowValue: {
    ...typography.body,
  },
  pollingNote: {
    ...typography.caption,
    marginTop: spacing.sm,
  },
  actions: {
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
});
