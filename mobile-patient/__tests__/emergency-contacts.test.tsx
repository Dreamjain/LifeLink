import { act, fireEvent, userEvent, waitFor } from '@testing-library/react-native';
import * as Auth from '../src/auth/auth-context';
import { createContact, deleteContact, listContacts } from '../src/api/endpoints';
import { EmergencyContactsScreen } from '../src/screens/EmergencyContactsScreen';
import { renderWithProviders } from '../src/test-support/render';
import type { EmergencyContact } from '../src/types/api.types';

jest.mock('../src/auth/auth-context', () => ({
  useAuthToken: jest.fn(() => 'patient-token'),
}));

jest.mock('../src/api/endpoints', () => ({
  listContacts: jest.fn(),
  createContact: jest.fn(),
  deleteContact: jest.fn(),
}));

const listContactsMock = listContacts as jest.MockedFunction<typeof listContacts>;
const createContactMock = createContact as jest.MockedFunction<typeof createContact>;
const deleteContactMock = deleteContact as jest.MockedFunction<typeof deleteContact>;
const navigate = jest.fn();

const contact: EmergencyContact = {
  id: 'contact-1',
  patientId: 'patient-profile-1',
  name: 'Ravi Rao',
  relationship: 'Brother',
  phone: '+15551234567',
  isPrimary: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const secondContact: EmergencyContact = {
  ...contact,
  id: 'contact-2',
  name: 'Maya Rao',
  relationship: 'Sister',
  isPrimary: false,
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
};

const renderScreen = async () =>
  await renderWithProviders(
    <EmergencyContactsScreen
      navigation={{ navigate } as never}
      route={{ key: 'contacts', name: 'EmergencyContacts', params: undefined } as never}
    />,
  );

beforeEach(() => {
  navigate.mockReset();
  listContactsMock.mockReset();
  createContactMock.mockReset();
  deleteContactMock.mockReset();
  jest.mocked(Auth.useAuthToken).mockReturnValue('patient-token');
});

describe('emergency contact loading recovery', () => {
  it('shows an initial load failure and keeps Continue disabled', async () => {
    listContactsMock.mockRejectedValue(new Error('offline'));
    const view = await renderScreen();

    expect(await view.findByTestId('contacts-error')).toBeOnTheScreen();
    expect(view.getByTestId('contacts-retry')).toBeOnTheScreen();
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(true);
    expect(view.queryByTestId('contacts-empty')).toBeNull();
  });

  it('retries a failed load and enables Continue only after contacts are confirmed', async () => {
    listContactsMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ contacts: [contact] });
    const interaction = userEvent.setup();

    const view = await renderScreen();
    await interaction.press(await view.findByTestId('contacts-retry'));

    await waitFor(() => expect(listContactsMock).toHaveBeenCalledTimes(2));
    expect(await view.findByTestId(`contact-${contact.id}`)).toBeOnTheScreen();
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(false);
    expect(view.queryByTestId('contacts-error')).toBeNull();
  });

  it('clears unconfirmed contacts after a successful mutation and failed reload', async () => {
    listContactsMock
      .mockResolvedValueOnce({ contacts: [contact] })
      .mockResolvedValueOnce({ contacts: [contact] })
      .mockRejectedValueOnce(new Error('offline after create'));
    createContactMock.mockResolvedValue({ contact: { ...contact, id: 'contact-2' } });
    const interaction = userEvent.setup();

    const view = await renderScreen();
    expect(await view.findByTestId(`contact-${contact.id}`)).toBeOnTheScreen();
    await fireEvent.changeText(view.getByTestId('contact-name'), 'Maya Rao');
    await fireEvent.changeText(view.getByTestId('contact-relationship'), 'Sister');
    await fireEvent.changeText(view.getByTestId('contact-phone'), '+15557654321');
    await waitFor(() =>
      expect(view.getByTestId('contact-submit').props.accessibilityState.disabled).toBe(false),
    );
    await interaction.press(view.getByTestId('contact-submit'));

    await waitFor(() => expect(createContactMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listContactsMock).toHaveBeenCalledTimes(3));
    expect(await view.findByTestId('contacts-error')).toBeOnTheScreen();
    expect(view.queryByTestId(`contact-${contact.id}`)).toBeNull();
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(true);
    expect(view.getByTestId('contacts-retry')).toBeOnTheScreen();
  });

  it('shows the empty state only after the backend confirms an empty contact list', async () => {
    listContactsMock.mockResolvedValue({ contacts: [] });
    const view = await renderScreen();

    expect(await view.findByTestId('contacts-empty')).toBeOnTheScreen();
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(true);
  });

  it('ignores an older contact-list response that arrives after a newer empty result', async () => {
    const olderRequest = deferred<{ contacts: EmergencyContact[] }>();
    const baselineRequest = deferred<{ contacts: EmergencyContact[] }>();
    const newerRequest = deferred<{ contacts: EmergencyContact[] }>();
    listContactsMock
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(baselineRequest.promise)
      .mockReturnValueOnce(newerRequest.promise);
    createContactMock.mockResolvedValue({ contact: secondContact });
    const interaction = userEvent.setup();

    const view = await renderScreen();
    await waitFor(() => expect(listContactsMock).toHaveBeenCalledTimes(1));
    await fireEvent.changeText(view.getByTestId('contact-name'), 'Maya Rao');
    await fireEvent.changeText(view.getByTestId('contact-relationship'), 'Sister');
    await fireEvent.changeText(view.getByTestId('contact-phone'), '+15557654321');
    await interaction.press(view.getByTestId('contact-submit'));
    await waitFor(() => expect(listContactsMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      baselineRequest.resolve({ contacts: [] });
      await baselineRequest.promise;
    });
    await waitFor(() => expect(listContactsMock).toHaveBeenCalledTimes(3));

    await act(async () => {
      newerRequest.resolve({ contacts: [] });
      await newerRequest.promise;
    });
    expect(await view.findByTestId('contacts-empty')).toBeOnTheScreen();
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(true);

    await act(async () => {
      olderRequest.resolve({ contacts: [contact] });
      await olderRequest.promise;
    });

    expect(view.queryByTestId(`contact-${contact.id}`)).toBeNull();
    expect(view.getByTestId('contacts-empty')).toBeOnTheScreen();
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(true);
  });

  it('keeps Continue disabled through removal and its pending list reconciliation', async () => {
    const removal = deferred<void>();
    const reconciliation = deferred<{ contacts: EmergencyContact[] }>();
    listContactsMock
      .mockResolvedValueOnce({ contacts: [contact] })
      .mockReturnValueOnce(reconciliation.promise);
    deleteContactMock.mockReturnValueOnce(removal.promise);
    const interaction = userEvent.setup();

    const view = await renderScreen();
    expect(await view.findByTestId(`contact-${contact.id}`)).toBeOnTheScreen();
    await interaction.press(view.getByTestId(`remove-contact-${contact.id}`));
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(true);

    await act(async () => {
      removal.resolve(undefined);
      await removal.promise;
    });
    await waitFor(() => expect(listContactsMock).toHaveBeenCalledTimes(2));
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(true);

    await act(async () => {
      reconciliation.resolve({ contacts: [] });
      await reconciliation.promise;
    });
    expect(await view.findByTestId('contacts-empty')).toBeOnTheScreen();
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(true);
  });

  it('keeps stale contacts unconfirmed after reconciliation fails and restores state on retry', async () => {
    listContactsMock
      .mockResolvedValueOnce({ contacts: [contact, secondContact] })
      .mockRejectedValueOnce(new Error('offline after removal'))
      .mockResolvedValueOnce({ contacts: [secondContact] });
    deleteContactMock.mockResolvedValueOnce(undefined);
    const interaction = userEvent.setup();

    const view = await renderScreen();
    expect(await view.findByTestId(`contact-${contact.id}`)).toBeOnTheScreen();
    await interaction.press(view.getByTestId(`remove-contact-${contact.id}`));

    expect(await view.findByTestId('contacts-error')).toBeOnTheScreen();
    expect(view.queryByTestId(`contact-${contact.id}`)).toBeNull();
    expect(view.queryByTestId(`contact-${secondContact.id}`)).toBeNull();
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(true);

    await interaction.press(view.getByTestId('contacts-retry'));
    expect(await view.findByTestId(`contact-${secondContact.id}`)).toBeOnTheScreen();
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(false);
  });

  it('treats an ambiguous create as successful when a new matching contact appears', async () => {
    const submittedContact: EmergencyContact = {
      ...secondContact,
      id: 'contact-created-after-lost-response',
      phone: '+15557654321',
      isPrimary: true,
    };
    listContactsMock
      .mockResolvedValueOnce({ contacts: [contact] })
      .mockResolvedValueOnce({ contacts: [contact] })
      .mockResolvedValueOnce({ contacts: [contact, submittedContact] });
    createContactMock.mockRejectedValueOnce(new Error('response lost after server commit'));
    const interaction = userEvent.setup();

    const view = await renderScreen();
    expect(await view.findByTestId(`contact-${contact.id}`)).toBeOnTheScreen();
    await fireEvent.changeText(view.getByTestId('contact-name'), submittedContact.name);
    await fireEvent.changeText(
      view.getByTestId('contact-relationship'),
      submittedContact.relationship,
    );
    await fireEvent.changeText(view.getByTestId('contact-phone'), submittedContact.phone);
    await interaction.press(view.getByTestId('contact-submit'));

    await waitFor(() => expect(createContactMock).toHaveBeenCalledTimes(1));
    expect(await view.findByTestId(`contact-${submittedContact.id}`)).toBeOnTheScreen();
    expect(view.getByTestId('contact-name').props.value).toBe('');
    expect(view.getByTestId('contact-relationship').props.value).toBe('');
    expect(view.getByTestId('contact-phone').props.value).toBe('');
    expect(view.queryByTestId('contacts-error')).toBeNull();
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(false);
  });

  it('preserves the form and allows retry when reconciliation confirms no new matching contact', async () => {
    listContactsMock
      .mockResolvedValueOnce({ contacts: [] })
      .mockResolvedValueOnce({ contacts: [] })
      .mockResolvedValueOnce({ contacts: [] });
    createContactMock.mockRejectedValueOnce(new Error('connection dropped before create'));
    const interaction = userEvent.setup();

    const view = await renderScreen();
    expect(await view.findByTestId('contacts-empty')).toBeOnTheScreen();
    await fireEvent.changeText(view.getByTestId('contact-name'), 'Maya Rao');
    await fireEvent.changeText(view.getByTestId('contact-relationship'), 'Sister');
    await fireEvent.changeText(view.getByTestId('contact-phone'), '+15557654321');
    await interaction.press(view.getByTestId('contact-submit'));

    expect(await view.findByTestId('contacts-error')).toHaveTextContent(
      /No new matching contact is currently listed\./,
    );
    expect(view.getByTestId('contact-name').props.value).toBe('Maya Rao');
    expect(view.getByTestId('contact-relationship').props.value).toBe('Sister');
    expect(view.getByTestId('contact-phone').props.value).toBe('+15557654321');
    expect(view.getByTestId('contact-submit').props.accessibilityState.disabled).toBe(false);
    expect(createContactMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the result explicitly unconfirmed when POST and reconciliation both fail', async () => {
    listContactsMock
      .mockResolvedValueOnce({ contacts: [] })
      .mockResolvedValueOnce({ contacts: [] })
      .mockRejectedValueOnce(new Error('reconciliation offline'))
      .mockResolvedValueOnce({ contacts: [] });
    createContactMock.mockRejectedValueOnce(new Error('POST outcome unknown'));
    const interaction = userEvent.setup();

    const view = await renderScreen();
    expect(await view.findByTestId('contacts-empty')).toBeOnTheScreen();
    await fireEvent.changeText(view.getByTestId('contact-name'), 'Maya Rao');
    await fireEvent.changeText(view.getByTestId('contact-relationship'), 'Sister');
    await fireEvent.changeText(view.getByTestId('contact-phone'), '+15557654321');
    await interaction.press(view.getByTestId('contact-submit'));

    expect(await view.findByTestId('contacts-error')).toHaveTextContent(
      /Could not confirm whether the contact was added\./,
    );
    expect(view.getByTestId('contacts-retry')).toBeOnTheScreen();
    expect(view.getByTestId('contacts-continue').props.accessibilityState.disabled).toBe(true);
    expect(view.getByTestId('contact-name').props.value).toBe('Maya Rao');
    expect(view.getByTestId('contact-submit').props.accessibilityState.disabled).toBe(true);
    expect(createContactMock).toHaveBeenCalledTimes(1);

    await interaction.press(view.getByTestId('contacts-retry'));

    expect(await view.findByTestId('contacts-error')).toHaveTextContent(
      /No new matching contact is currently listed\./,
    );
    expect(view.getByTestId('contact-submit').props.accessibilityState.disabled).toBe(false);
    expect(view.getByTestId('contact-name').props.value).toBe('Maya Rao');
    expect(createContactMock).toHaveBeenCalledTimes(1);
  });

  it('does not treat a matching contact from the pre-submit snapshot as a successful create', async () => {
    listContactsMock
      .mockResolvedValueOnce({ contacts: [contact] })
      .mockResolvedValueOnce({ contacts: [contact] })
      .mockResolvedValueOnce({ contacts: [contact] });
    createContactMock.mockRejectedValueOnce(new Error('ambiguous POST failure'));
    const interaction = userEvent.setup();

    const view = await renderScreen();
    expect(await view.findByTestId(`contact-${contact.id}`)).toBeOnTheScreen();
    await fireEvent.changeText(view.getByTestId('contact-name'), contact.name);
    await fireEvent.changeText(view.getByTestId('contact-relationship'), contact.relationship);
    await fireEvent.changeText(view.getByTestId('contact-phone'), contact.phone);
    await interaction.press(view.getByTestId('contact-submit'));

    expect(await view.findByTestId('contacts-error')).toHaveTextContent(
      /No new matching contact is currently listed\./,
    );
    expect(view.getByTestId('contact-name').props.value).toBe(contact.name);
    expect(view.getByTestId(`contact-${contact.id}`)).toBeOnTheScreen();
    expect(createContactMock).toHaveBeenCalledTimes(1);
  });
});
