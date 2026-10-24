import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError } from '../api/api-error';
import { getProfile, saveProfile } from '../api/endpoints';
import { FormField } from '../components/FormField';
import { MessageBanner } from '../components/MessageBanner';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAuth, useAuthToken } from '../auth/auth-context';
import type { OnboardingStackParamList } from '../navigation/types';
import { MIN_TOUCH_SIZE, colors, radii, spacing, typography } from '../theme';
import type { BloodGroup, UpdateProfileInput } from '../types/api.types';

type Props = NativeStackScreenProps<OnboardingStackParamList, 'ProfileSetup'>;

const BLOOD_GROUPS: { value: BloodGroup; label: string }[] = [
  { value: 'A_POSITIVE', label: 'A+' },
  { value: 'A_NEGATIVE', label: 'A-' },
  { value: 'B_POSITIVE', label: 'B+' },
  { value: 'B_NEGATIVE', label: 'B-' },
  { value: 'AB_POSITIVE', label: 'AB+' },
  { value: 'AB_NEGATIVE', label: 'AB-' },
  { value: 'O_POSITIVE', label: 'O+' },
  { value: 'O_NEGATIVE', label: 'O-' },
  { value: 'UNKNOWN', label: 'Not known' },
];

/**
 * The profile schema is `.strict()` and every string field it accepts has a minimum length of
 * one, so an untouched field must be left out of the payload entirely rather than sent empty.
 */
const trimmed = (value: string): string | undefined => {
  const next = value.trim();

  return next.length > 0 ? next : undefined;
};

export const ProfileSetupScreen = ({ navigation }: Props) => {
  const token = useAuthToken();
  const { signOut, user } = useAuth();

  const [dateOfBirth, setDateOfBirth] = useState('');
  const [gender, setGender] = useState('');
  const [bloodGroup, setBloodGroup] = useState<BloodGroup>('UNKNOWN');
  const [allergies, setAllergies] = useState('');
  const [medicalSummary, setMedicalSummary] = useState('');
  const [addressLine, setAddressLine] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Prefill from whatever is already saved, so returning to this step does not blank it out.
  const load = useCallback(async (): Promise<void> => {
    try {
      const { profile } = await getProfile(token);

      if (profile === null) {
        return;
      }

      setDateOfBirth(profile.dateOfBirth === null ? '' : profile.dateOfBirth.slice(0, 10));
      setGender(profile.gender ?? '');
      setBloodGroup(profile.bloodGroup);
      setAllergies(profile.allergies ?? '');
      setMedicalSummary(profile.medicalSummary ?? '');
      setAddressLine(profile.addressLine ?? '');
      setCity(profile.city ?? '');
      setState(profile.state ?? '');
      setPostalCode(profile.postalCode ?? '');
    } catch {
      // A profile that cannot be read is not worth blocking onboarding over: the patient simply
      // starts from empty fields and the save below overwrites whatever is there.
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);

    const values = {
      dateOfBirth: trimmed(dateOfBirth),
      gender: trimmed(gender),
      allergies: trimmed(allergies),
      medicalSummary: trimmed(medicalSummary),
      addressLine: trimmed(addressLine),
      city: trimmed(city),
      state: trimmed(state),
      postalCode: trimmed(postalCode),
    };

    const input: UpdateProfileInput = { bloodGroup };

    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) {
        input[key as keyof typeof values] = value;
      }
    }

    try {
      await saveProfile(token, input);
      navigation.navigate('EmergencyContacts');
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.displayMessage
          : 'Could not save your details. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContainer
      title="Your details"
      subtitle={`Step 1 of 2${user === null ? '' : ` for ${user.displayName}`}. These reach the hospital with your emergency.`}
    >
      {error === null ? null : (
        <MessageBanner tone="error" message={error} testID="profile-error" />
      )}

      <Text style={styles.groupLabel}>Blood group</Text>
      <View accessibilityRole="radiogroup" style={styles.chipRow}>
        {BLOOD_GROUPS.map((option) => {
          const selected = option.value === bloodGroup;

          return (
            <Pressable
              accessibilityLabel={`Blood group ${option.label}`}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              key={option.value}
              onPress={() => {
                setBloodGroup(option.value);
              }}
              style={[styles.chip, selected ? styles.chipSelected : null]}
              testID={`blood-group-${option.value}`}
            >
              <Text style={styles.chipLabel}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <FormField
        label="Date of birth"
        value={dateOfBirth}
        onChangeText={setDateOfBirth}
        placeholder="1990-04-21"
        hint="Year, month and day."
        autoCapitalize="none"
        testID="profile-dob"
      />
      <FormField label="Gender" value={gender} onChangeText={setGender} testID="profile-gender" />
      <FormField
        label="Allergies"
        value={allergies}
        onChangeText={setAllergies}
        hint="Anything a paramedic must know before giving you medication."
        multiline
        testID="profile-allergies"
      />
      <FormField
        label="Medical summary"
        value={medicalSummary}
        onChangeText={setMedicalSummary}
        multiline
        testID="profile-summary"
      />
      <FormField
        label="Address"
        value={addressLine}
        onChangeText={setAddressLine}
        testID="profile-address"
      />
      <FormField label="City" value={city} onChangeText={setCity} testID="profile-city" />
      <FormField label="State" value={state} onChangeText={setState} testID="profile-state" />
      <FormField
        label="Postal code"
        value={postalCode}
        onChangeText={setPostalCode}
        autoCapitalize="characters"
        testID="profile-postal"
      />

      <PrimaryButton
        label="Save and continue"
        onPress={() => {
          void submit();
        }}
        busy={busy}
        testID="profile-submit"
      />
      <View style={styles.footer}>
        <PrimaryButton
          label="Sign out"
          variant="secondary"
          onPress={() => {
            void signOut();
          }}
          testID="profile-sign-out"
        />
      </View>
    </ScreenContainer>
  );
};

const styles = StyleSheet.create({
  groupLabel: {
    ...typography.body,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  chip: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.sm,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_SIZE,
    minWidth: MIN_TOUCH_SIZE + spacing.md,
    paddingHorizontal: spacing.sm,
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipLabel: {
    ...typography.body,
    fontWeight: '700',
  },
  footer: {
    marginTop: spacing.lg,
  },
});
