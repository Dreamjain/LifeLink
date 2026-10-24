import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing, typography } from '../theme';

interface ScreenContainerProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Set for screens whose content must not scroll away, such as the SOS screen. */
  scroll?: boolean;
}

/**
 * Title, optional subtitle and a consistently padded body. Everything scrolls by default so
 * that a large OS text size never hides a submit button.
 */
export const ScreenContainer = ({
  title,
  subtitle,
  children,
  scroll = true,
}: ScreenContainerProps) => {
  const body = (
    <>
      <Text accessibilityRole="header" style={typography.title}>
        {title}
      </Text>
      {subtitle === undefined ? null : <Text style={styles.subtitle}>{subtitle}</Text>}
      <View style={styles.content}>{children}</View>
    </>
  );

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          style={styles.screen}
        >
          {body}
        </ScrollView>
      ) : (
        <View style={styles.screen}>{body}</View>
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.background,
    flex: 1,
  },
  screen: {
    backgroundColor: colors.background,
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  scrollContent: {
    paddingBottom: spacing.xl,
  },
  subtitle: {
    ...typography.caption,
    marginTop: spacing.xs,
  },
  content: {
    marginTop: spacing.lg,
  },
});
