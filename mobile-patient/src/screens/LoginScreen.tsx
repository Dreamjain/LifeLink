import { useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError } from '../api/api-error';
import { FormField } from '../components/FormField';
import { MessageBanner } from '../components/MessageBanner';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAuth } from '../auth/auth-context';
import type { UnauthenticatedStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<UnauthenticatedStackParamList, 'Login'>;

export const LoginScreen = ({ navigation }: Props) => {
  const { signIn } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);

    try {
      await signIn(phone, password);
      // No navigation on success: the auth gate swaps the whole navigator once the status
      // changes, which is also what sends a PENDING patient back into onboarding.
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.displayMessage : 'Could not sign in. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContainer title="Sign in" subtitle="LifeLink emergency response">
      {error === null ? null : <MessageBanner tone="error" message={error} testID="login-error" />}

      <FormField
        label="Phone number"
        value={phone}
        onChangeText={setPhone}
        placeholder="+15551234567"
        keyboardType="phone-pad"
        autoCapitalize="none"
        testID="login-phone"
      />
      <FormField
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        testID="login-password"
      />

      <PrimaryButton
        label="Sign in"
        onPress={() => {
          void submit();
        }}
        busy={busy}
        disabled={phone.trim().length === 0 || password.length === 0}
        testID="login-submit"
      />

      <PrimaryButton
        label="Create an account"
        variant="secondary"
        onPress={() => {
          navigation.navigate('Register');
        }}
        testID="login-register-link"
      />
    </ScreenContainer>
  );
};
