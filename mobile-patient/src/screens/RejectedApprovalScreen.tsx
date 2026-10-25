import { View, StyleSheet } from 'react-native';
import { MessageBanner } from '../components/MessageBanner';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAuth } from '../auth/auth-context';
import { spacing } from '../theme';

/** A restricted terminal onboarding view; it exposes no profile, contact, or emergency routes. */
export const RejectedApprovalScreen = () => {
  const { signOut } = useAuth();

  return (
    <ScreenContainer title="Registration not approved">
      <MessageBanner
        tone="error"
        message="Your patient registration was rejected during review. Please contact LifeLink support for next steps."
        testID="registration-rejected"
      />
      <View style={styles.footer}>
        <PrimaryButton
          label="Sign out"
          variant="secondary"
          onPress={() => {
            void signOut();
          }}
          testID="rejected-sign-out"
        />
      </View>
    </ScreenContainer>
  );
};

const styles = StyleSheet.create({
  footer: {
    marginTop: spacing.lg,
  },
});
