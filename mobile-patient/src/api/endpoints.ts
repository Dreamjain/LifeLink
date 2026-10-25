import type {
  ApiUser,
  AuthResult,
  CreateContactInput,
  CreateEmergencyInput,
  EmergencyContact,
  PatientAccountStatus,
  PatientEmergency,
  PatientProfile,
  UpdateProfileInput,
} from '../types/api.types';
import { request } from './client';

/**
 * Every patient-facing backend route the app uses, in one place, named after what the patient is
 * doing rather than after the HTTP verb. Nothing else in the app composes URLs.
 */

export const registerPatient = (input: {
  phone: string;
  password: string;
  displayName: string;
  email?: string;
}): Promise<AuthResult> => request<AuthResult>('/auth/register', { method: 'POST', body: input });

export const login = (input: { phone: string; password: string }): Promise<AuthResult> =>
  request<AuthResult>('/auth/login', { method: 'POST', body: input });

export const getCurrentUser = (token: string): Promise<{ user: ApiUser }> =>
  request<{ user: ApiUser }>('/auth/me', { token });

/** Reads only the caller's patient account state, including PENDING and REJECTED. */
export const getPatientAccountStatus = (token: string): Promise<{ status: PatientAccountStatus }> =>
  request<{ status: PatientAccountStatus }>('/auth/patient-status', { token });

export const getProfile = (token: string): Promise<{ profile: PatientProfile | null }> =>
  request<{ profile: PatientProfile | null }>('/patients/me', { token });

export const saveProfile = (
  token: string,
  input: UpdateProfileInput,
): Promise<{ profile: PatientProfile }> =>
  request<{ profile: PatientProfile }>('/patients/me', { method: 'PUT', body: input, token });

export const listContacts = (token: string): Promise<{ contacts: EmergencyContact[] }> =>
  request<{ contacts: EmergencyContact[] }>('/patients/me/emergency-contacts', { token });

export const createContact = (
  token: string,
  input: CreateContactInput,
): Promise<{ contact: EmergencyContact }> =>
  request<{ contact: EmergencyContact }>('/patients/me/emergency-contacts', {
    method: 'POST',
    body: input,
    token,
  });

export const deleteContact = (token: string, contactId: string): Promise<void> =>
  request<void>(`/patients/me/emergency-contacts/${contactId}`, { method: 'DELETE', token });

/**
 * Raises an SOS. The Idempotency-Key is mandatory: the backend namespaces it per patient and
 * answers a repeat with the original emergency and `idempotentReplay: true` (200) instead of
 * creating a second one (201).
 */
export const createEmergency = (
  token: string,
  idempotencyKey: string,
  input: CreateEmergencyInput,
): Promise<{ emergency: PatientEmergency; idempotentReplay: boolean }> =>
  request<{ emergency: PatientEmergency; idempotentReplay: boolean }>('/patients/me/emergencies', {
    method: 'POST',
    body: input,
    token,
    idempotencyKey,
  });

export const listEmergencies = (token: string): Promise<{ emergencies: PatientEmergency[] }> =>
  request<{ emergencies: PatientEmergency[] }>('/patients/me/emergencies', { token });

export const getEmergency = (
  token: string,
  emergencyId: string,
  signal?: AbortSignal,
): Promise<{ emergency: PatientEmergency }> =>
  request<{ emergency: PatientEmergency }>(`/patients/me/emergencies/${emergencyId}`, {
    token,
    signal,
  });

export const cancelEmergency = (
  token: string,
  emergencyId: string,
): Promise<{ emergency: PatientEmergency }> =>
  request<{ emergency: PatientEmergency }>(`/patients/me/emergencies/${emergencyId}/cancel`, {
    method: 'POST',
    body: {},
    token,
  });
