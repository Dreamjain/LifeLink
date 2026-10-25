import { NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../auth/auth-context';
import { EmergencyContactsScreen } from '../screens/EmergencyContactsScreen';
import { EmergencyDetailScreen } from '../screens/EmergencyDetailScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { PendingApprovalScreen } from '../screens/PendingApprovalScreen';
import { ProfileSetupScreen } from '../screens/ProfileSetupScreen';
import { RejectedApprovalScreen } from '../screens/RejectedApprovalScreen';
import { RegisterScreen } from '../screens/RegisterScreen';
import { RestoringScreen } from '../screens/RestoringScreen';
import { colors } from '../theme';
import type {
  ActiveStackParamList,
  OnboardingStackParamList,
  UnauthenticatedStackParamList,
} from './types';

const UnauthenticatedStack = createNativeStackNavigator<UnauthenticatedStackParamList>();
const OnboardingStack = createNativeStackNavigator<OnboardingStackParamList>();
const ActiveStack = createNativeStackNavigator<ActiveStackParamList>();

/**
 * Headers are off everywhere: each screen draws its own title through `ScreenContainer`, which
 * keeps one type scale across the app and leaves the full height of a small screen for content.
 * The platform back gesture and the Android back button still pop the stack.
 */
const screenOptions = { headerShown: false } as const;

const navigationTheme: Theme = {
  dark: true,
  colors: {
    primary: colors.primary,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    notification: colors.danger,
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' },
    medium: { fontFamily: 'System', fontWeight: '500' },
    bold: { fontFamily: 'System', fontWeight: '700' },
    heavy: { fontFamily: 'System', fontWeight: '800' },
  },
};

/**
 * The auth gate.
 *
 * `restoring` renders before the stored session has been read, so the app never flashes the
 * login screen at a patient who is already signed in. `onboarding` is a PENDING account: profile
 * and emergency contact only, exactly the routes the backend's onboarding middleware allows.
 * `active` is an approved patient, and the only state from which an SOS can be raised.
 */
export const RootNavigator = () => {
  const { status } = useAuth();

  if (status === 'restoring') {
    return <RestoringScreen />;
  }

  // Exactly one navigator is ever mounted, so `NavigationContainer` always has a single child.
  const stack =
    status === 'unauthenticated' ? (
      <UnauthenticatedStack.Navigator screenOptions={screenOptions}>
        <UnauthenticatedStack.Screen name="Login" component={LoginScreen} />
        <UnauthenticatedStack.Screen name="Register" component={RegisterScreen} />
      </UnauthenticatedStack.Navigator>
    ) : status === 'onboarding' ? (
      <OnboardingStack.Navigator screenOptions={screenOptions}>
        <OnboardingStack.Screen name="ProfileSetup" component={ProfileSetupScreen} />
        <OnboardingStack.Screen name="EmergencyContacts" component={EmergencyContactsScreen} />
        <OnboardingStack.Screen name="PendingApproval" component={PendingApprovalScreen} />
      </OnboardingStack.Navigator>
    ) : status === 'rejected' ? (
      <UnauthenticatedStack.Navigator screenOptions={screenOptions}>
        <UnauthenticatedStack.Screen name="RejectedApproval" component={RejectedApprovalScreen} />
      </UnauthenticatedStack.Navigator>
    ) : (
      <ActiveStack.Navigator screenOptions={screenOptions}>
        <ActiveStack.Screen name="Home" component={HomeScreen} />
        <ActiveStack.Screen name="EmergencyDetail" component={EmergencyDetailScreen} />
      </ActiveStack.Navigator>
    );

  return <NavigationContainer theme={navigationTheme}>{stack}</NavigationContainer>;
};
