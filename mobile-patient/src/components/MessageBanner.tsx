import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../theme';

type BannerTone = 'error' | 'info' | 'success';

interface MessageBannerProps {
  tone: BannerTone;
  message: string;
  testID?: string;
}

/**
 * The single way this app reports a problem or a confirmation. Announced politely so a screen
 * reader picks it up without interrupting whatever the patient is doing.
 */
export const MessageBanner = ({ tone, message, testID }: MessageBannerProps) => (
  <View
    accessibilityLiveRegion="polite"
    accessibilityRole={tone === 'error' ? 'alert' : 'text'}
    style={[styles.banner, toneStyles[tone]]}
    testID={testID}
  >
    <Text style={styles.text}>{message}</Text>
  </View>
);

const styles = StyleSheet.create({
  banner: {
    borderRadius: radii.sm,
    borderWidth: 1,
    marginBottom: spacing.md,
    padding: spacing.sm,
  },
  text: {
    ...typography.body,
  },
});

const toneStyles = StyleSheet.create({
  error: { backgroundColor: '#3A1016', borderColor: colors.danger },
  info: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
  success: { backgroundColor: '#0E2A1B', borderColor: colors.success },
});
