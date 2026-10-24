import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/auth/auth-context';
import { RootNavigator } from './src/navigation/root-navigator';

/**
 * The patient app's root.
 *
 * `AuthProvider` sits above the navigator because the navigator IS the auth gate: which stack is
 * mounted is derived from the session, not from an imperative redirect.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
