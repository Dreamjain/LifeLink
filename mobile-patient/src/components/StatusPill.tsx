import { StyleSheet, Text, View } from 'react-native';
import type { EmergencyStatus } from '../types/api.types';
import { colors, radii, spacing, typography } from '../theme';

/**
 * Plain-language names for the backend's seventeen emergency statuses. A patient should never be
 * shown SCREAMING_SNAKE_CASE, and should never have to guess whether an ambulance is coming.
 */
const STATUS_LABELS: Record<EmergencyStatus, string> = {
  CREATED: 'Request received',
  SEARCHING_HOSPITAL: 'Finding a hospital',
  PENDING_HOSPITAL_RESPONSE: 'Waiting for a hospital to answer',
  HOSPITAL_REJECTED: 'No hospital could take this request',
  HOSPITAL_ACCEPTED: 'A hospital accepted',
  BED_RESERVED: 'A bed is reserved for you',
  AMBULANCE_ASSIGNED: 'An ambulance is assigned',
  PENDING_DRIVER_ACCEPTANCE: 'Waiting for the driver to confirm',
  DRIVER_EN_ROUTE: 'The ambulance is on its way',
  AT_PICKUP: 'The ambulance has arrived',
  TRANSPORTING: 'On the way to hospital',
  AT_HOSPITAL: 'Arrived at the hospital',
  ADMITTED: 'Admitted',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  ESCALATED: 'Escalated for manual help',
  EXPIRED: 'Expired without a response',
};

export const statusLabel = (status: EmergencyStatus): string => STATUS_LABELS[status];

export const StatusPill = ({ status }: { status: EmergencyStatus }) => (
  <View style={styles.pill} testID="status-pill">
    <Text style={styles.text}>{statusLabel(status)}</Text>
  </View>
);

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  text: {
    ...typography.body,
    fontWeight: '700',
  },
});
