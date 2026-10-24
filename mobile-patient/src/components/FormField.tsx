import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { KeyboardTypeOptions } from 'react-native';
import { MIN_TOUCH_SIZE, colors, radii, spacing, typography } from '../theme';

interface FormFieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  hint?: string;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  multiline?: boolean;
  testID?: string;
}

/**
 * A labelled text input. The label is a real <Text> tied to the field by `accessibilityLabel`
 * rather than a placeholder, because a placeholder disappears as soon as typing starts.
 */
export const FormField = ({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  secureTextEntry = false,
  keyboardType,
  autoCapitalize = 'sentences',
  multiline = false,
  testID,
}: FormFieldProps) => (
  <View style={styles.wrapper}>
    <Text style={styles.label}>{label}</Text>
    <TextInput
      accessibilityLabel={label}
      accessibilityHint={hint}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      keyboardType={keyboardType}
      multiline={multiline}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textMuted}
      secureTextEntry={secureTextEntry}
      style={[styles.input, multiline ? styles.inputMultiline : null]}
      testID={testID}
      value={value}
    />
    {hint === undefined ? null : <Text style={styles.hint}>{hint}</Text>}
  </View>
);

const styles = StyleSheet.create({
  wrapper: {
    marginBottom: spacing.md,
  },
  label: {
    ...typography.body,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  input: {
    ...typography.body,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.sm,
    borderWidth: 1,
    minHeight: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  inputMultiline: {
    minHeight: MIN_TOUCH_SIZE * 2,
    textAlignVertical: 'top',
  },
  hint: {
    ...typography.caption,
    marginTop: spacing.xs,
  },
});
