import { useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError } from '../api/api-error';
import { FormField } from '../components/FormField';
import { MessageBanner } from '../components/MessageBanner';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAuth } from '../auth/auth-context';
import type { UnauthenticatedStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<UnauthenticatedStackParamList, 'Register'>;

/** The backend rejects anything shorter; stating it up front avoids a round trip to find out. */
const MIN_PASSWORD_LENGTH = 12;

export const RegisterScreen = ({ navigation }: Props) => {
  const { signUp } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);

      return;
    }

    setBusy(true);

    try {
      await signUp({ displayName, phone, password, email });
      // Registration returns a token for a PENDING account, so the gate moves straight to
      // onboarding. Nothing to navigate to here.
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.displayMessage
          : 'Could not create the account. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContainer
      title="Create an account"
      subtitle="An administrator approves new patients before emergencies can be raised."
    >
      {error === null ? null : (
        <MessageBanner tone="error" message={error} testID="register-error" />
      )}

      <FormField
        label="Full name"
        value={displayName}
        onChangeText={setDisplayName}
        autoCapitalize="words"
        testID="register-name"
      />
      <FormField
        label="Phone number"
        value={phone}
        onChangeText={setPhone}
        placeholder="+15551234567"
        hint="Digits only, with an optional leading plus sign."
        keyboardType="phone-pad"
        autoCapitalize="none"
        testID="register-phone"
      />
      <FormField
        label="Email (optional)"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        testID="register-email"
      />
      <FormField
        label="Password"
        value={password}
        onChangeText={setPassword}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        secureTextEntry
        autoCapitalize="none"
        testID="register-password"
      />

      <PrimaryButton
        label="Create account"
        onPress={() => {
          void submit();
        }}
        busy={busy}
        disabled={displayName.trim().length === 0 || phone.trim().length === 0}
        testID="register-submit"
      />

      <PrimaryButton
        label="I already have an account"
        variant="secondary"
        onPress={() => {
          navigation.navigate('Login');
        }}
        testID="register-login-link"
      />
    </ScreenContainer>
  );
};
