import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError } from '../api/api-error';
import { createContact, deleteContact, listContacts } from '../api/endpoints';
import { FormField } from '../components/FormField';
import { MessageBanner } from '../components/MessageBanner';
import { PrimaryButton } from '../components/PrimaryButton';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAuthToken } from '../auth/auth-context';
import type { OnboardingStackParamList } from '../navigation/types';
import { MIN_TOUCH_SIZE, colors, radii, spacing, typography } from '../theme';
import type { EmergencyContact } from '../types/api.types';

type Props = NativeStackScreenProps<OnboardingStackParamList, 'EmergencyContacts'>;

export const EmergencyContactsScreen = ({ navigation }: Props) => {
  const token = useAuthToken();

  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('');
  const [phone, setPhone] = useState('');
  const [isPrimary, setIsPrimary] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await listContacts(token);

      setContacts(result.contacts);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.displayMessage
          : 'Could not load your emergency contacts.',
      );
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (): Promise<void> => {
    setError(null);
    setBusy(true);

    try {
      await createContact(token, {
        name: name.trim(),
        relationship: relationship.trim(),
        phone: phone.trim(),
        isPrimary,
      });

      setName('');
      setRelationship('');
      setPhone('');
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.displayMessage
          : 'Could not add that contact. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (contactId: string): Promise<void> => {
    setError(null);

    try {
      await deleteContact(token, contactId);
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.displayMessage : 'Could not remove that contact.',
      );
    }
  };

  const canSubmit =
    name.trim().length > 0 && relationship.trim().length > 0 && phone.trim().length > 0;

  return (
    <ScreenContainer
      title="Emergency contact"
      subtitle="Step 2 of 2. At least one contact is required before an administrator can approve your account."
    >
      {error === null ? null : (
        <MessageBanner tone="error" message={error} testID="contacts-error" />
      )}

      {contacts.length === 0 ? (
        <MessageBanner
          tone="info"
          message="You have no emergency contacts yet."
          testID="contacts-empty"
        />
      ) : (
        <View style={styles.list}>
          {contacts.map((contact) => (
            <View key={contact.id} style={styles.card} testID={`contact-${contact.id}`}>
              <View style={styles.cardText}>
                <Text style={styles.cardTitle}>
                  {contact.name}
                  {contact.isPrimary ? ' (primary)' : ''}
                </Text>
                <Text style={typography.caption}>
                  {contact.relationship} - {contact.phone}
                </Text>
              </View>
              <PrimaryButton
                label="Remove"
                variant="secondary"
                accessibilityLabel={`Remove ${contact.name}`}
                onPress={() => {
                  void remove(contact.id);
                }}
                testID={`remove-contact-${contact.id}`}
              />
            </View>
          ))}
        </View>
      )}

      <Text accessibilityRole="header" style={styles.heading}>
        Add a contact
      </Text>

      <FormField
        label="Name"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        testID="contact-name"
      />
      <FormField
        label="Relationship"
        value={relationship}
        onChangeText={setRelationship}
        placeholder="Sister"
        testID="contact-relationship"
      />
      <FormField
        label="Phone number"
        value={phone}
        onChangeText={setPhone}
        placeholder="+15551234567"
        keyboardType="phone-pad"
        autoCapitalize="none"
        testID="contact-phone"
      />

      <Pressable
        accessibilityLabel="Primary contact"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isPrimary }}
        onPress={() => {
          setIsPrimary((previous) => !previous);
        }}
        style={styles.checkboxRow}
        testID="contact-primary"
      >
        <View style={[styles.checkbox, isPrimary ? styles.checkboxChecked : null]}>
          <Text style={styles.checkboxMark}>{isPrimary ? 'X' : ' '}</Text>
        </View>
        <Text style={typography.body}>Call this person first</Text>
      </Pressable>

      <PrimaryButton
        label="Add contact"
        onPress={() => {
          void add();
        }}
        busy={busy}
        disabled={!canSubmit}
        testID="contact-submit"
      />

      <View style={styles.footer}>
        <PrimaryButton
          label="Continue"
          onPress={() => {
            navigation.navigate('PendingApproval');
          }}
          disabled={contacts.length === 0}
          accessibilityHint="Opens the account approval screen."
          testID="contacts-continue"
        />
        <PrimaryButton
          label="Back to your details"
          variant="secondary"
          onPress={() => {
            navigation.navigate('ProfileSetup');
          }}
          testID="contacts-back"
        />
      </View>
    </ScreenContainer>
  );
};

const styles = StyleSheet.create({
  list: {
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  card: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
    padding: spacing.sm,
  },
  cardText: {
    flexShrink: 1,
  },
  cardTitle: {
    ...typography.body,
    fontWeight: '700',
  },
  heading: {
    ...typography.heading,
    marginBottom: spacing.md,
  },
  checkboxRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
    minHeight: MIN_TOUCH_SIZE,
  },
  checkbox: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.sm,
    borderWidth: 2,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkboxMark: {
    ...typography.body,
    fontWeight: '700',
  },
  footer: {
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
});
