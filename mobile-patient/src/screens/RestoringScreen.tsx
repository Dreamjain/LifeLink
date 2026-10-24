import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '../theme';

/** Shown for the moment it takes to read the stored session out of secure storage. */
export const RestoringScreen = () => (
  <View style={styles.screen}>
    <ActivityIndicator color={colors.text} size="large" />
    <Text style={styles.label}>Starting LifeLink</Text>
  </View>
);

const styles = StyleSheet.create({
  screen: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
  },
  label: {
    ...typography.body,
  },
});
