import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { MIN_TOUCH_SIZE, colors, radii, spacing, typography } from '../theme';

type ButtonVariant = 'primary' | 'secondary' | 'danger';

interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  /** Spoken by a screen reader in place of the label when the label alone is not enough. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

export const PrimaryButton = ({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: PrimaryButtonProps) => {
  const isInactive = disabled || busy;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isInactive, busy }}
      disabled={isInactive}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        variantStyles[variant],
        pressed ? styles.pressed : null,
        isInactive ? styles.inactive : null,
      ]}
    >
      {busy ? <ActivityIndicator color={colors.primaryText} /> : null}
      <Text style={[styles.label, variant === 'secondary' ? styles.secondaryLabel : null]}>
        {label}
      </Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  pressed: {
    opacity: 0.85,
  },
  inactive: {
    opacity: 0.5,
  },
  label: {
    ...typography.body,
    color: colors.primaryText,
    fontWeight: '700',
  },
  secondaryLabel: {
    color: colors.text,
  },
});

const variantStyles = StyleSheet.create({
  primary: { backgroundColor: colors.primary },
  secondary: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
  },
  danger: { backgroundColor: colors.danger },
});
