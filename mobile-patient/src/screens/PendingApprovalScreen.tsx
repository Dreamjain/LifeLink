import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ApiError } from '../api/api-error';
import { MessageBanner } from '../components/MessageBanner';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAuth } from '../auth/auth-context';
import { spacing } from '../theme';

/**
 * The end of onboarding. A patient's account is PENDING until an administrator approves it, and
 * only an ACTIVE account may raise an emergency - the backend enforces that, so there is nothing
 * useful to show here but an honest explanation and a way to check again.
 */
export const PendingApprovalScreen = () => {
  const { refreshAccount, signOut, user } = useAuth();
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async (): Promise<void> => {
    setError(null);
    setBusy(true);

    try {
      await refreshAccount();
      // When approval has happened the auth gate swaps navigators and this screen unmounts.
      // Reaching the line below therefore means the account is still pending.
      setChecked(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.displayMessage
          : 'Could not check your account just now.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContainer
      title="Waiting for approval"
      subtitle={user === null ? undefined : `Signed in as ${user.displayName}.`}
    >
      <MessageBanner
        tone="info"
        message="Your details are saved. An administrator has to approve your account before you can send an SOS. You can close the app; your place is kept."
        testID="approval-explainer"
      />

      {checked ? (
        <MessageBanner
          tone="info"
          message="Still waiting. Your account has not been approved yet."
          testID="approval-still-pending"
        />
      ) : null}

      {error === null ? null : (
        <MessageBanner tone="error" message={error} testID="approval-error" />
      )}

      <PrimaryButton
        label="Check again"
        onPress={() => {
          void check();
        }}
        busy={busy}
        testID="approval-check"
      />

      <View style={styles.footer}>
        <PrimaryButton
          label="Sign out"
          variant="secondary"
          onPress={() => {
            void signOut();
          }}
          testID="approval-sign-out"
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
