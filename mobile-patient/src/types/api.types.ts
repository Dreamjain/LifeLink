/**
 * Mirror of the backend's patient-facing contracts.
 *
 * These are hand-written on purpose: Task 1.25 does not create a shared package, so the mobile
 * app owns its own view of the API. Whenever `backend/prisma/schema.prisma` or a Safe* projection
 * changes, this file is the one to update.
 */

/** backend/prisma/schema.prisma :: enum UserRole */
export type UserRole = 'PATIENT' | 'DRIVER' | 'HOSPITAL_STAFF' | 'ADMIN';

/** backend/prisma/schema.prisma :: enum UserStatus */
export type UserStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'REJECTED';

/** backend/prisma/schema.prisma :: enum EmergencyStatus (all 17 members, in lifecycle order) */
export type EmergencyStatus =
  | 'CREATED'
  | 'SEARCHING_HOSPITAL'
  | 'PENDING_HOSPITAL_RESPONSE'
  | 'HOSPITAL_REJECTED'
  | 'HOSPITAL_ACCEPTED'
  | 'BED_RESERVED'
  | 'AMBULANCE_ASSIGNED'
  | 'PENDING_DRIVER_ACCEPTANCE'
  | 'DRIVER_EN_ROUTE'
  | 'AT_PICKUP'
  | 'TRANSPORTING'
  | 'AT_HOSPITAL'
  | 'ADMITTED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'ESCALATED'
  | 'EXPIRED';

/** backend/prisma/schema.prisma :: enum EmergencyType */
export type EmergencyType = 'SOS' | 'AMBULANCE_REQUEST';

/** backend/prisma/schema.prisma :: enum Severity */
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

/** backend/prisma/schema.prisma :: enum BloodGroup */
export type BloodGroup =
  | 'A_POSITIVE'
  | 'A_NEGATIVE'
  | 'B_POSITIVE'
  | 'B_NEGATIVE'
  | 'AB_POSITIVE'
  | 'AB_NEGATIVE'
  | 'O_POSITIVE'
  | 'O_NEGATIVE'
  | 'UNKNOWN';

/**
 * An emergency is finished when it reaches one of these. The detail screen stops polling here;
 * nothing the patient can do will move it again.
 */
export const TERMINAL_EMERGENCY_STATUSES: readonly EmergencyStatus[] = [
  'COMPLETED',
  'CANCELLED',
  'ESCALATED',
  'EXPIRED',
  'HOSPITAL_REJECTED',
];

export const isTerminalEmergencyStatus = (status: EmergencyStatus): boolean =>
  TERMINAL_EMERGENCY_STATUSES.includes(status);

/** backend :: SafeUser */
export interface ApiUser {
  id: string;
  phone: string;
  email: string | null;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

/** backend :: LoginResult, returned by POST /auth/register and POST /auth/login */
export interface AuthResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: ApiUser;
}

/** backend :: SafePatientProfile */
export interface PatientProfile {
  id: string;
  userId: string;
  dateOfBirth: string | null;
  gender: string | null;
  bloodGroup: BloodGroup;
  allergies: string | null;
  medicalSummary: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  createdAt: string;
  updatedAt: string;
}

/** backend :: SafeEmergencyContact */
export interface EmergencyContact {
  id: string;
  patientId: string;
  name: string;
  relationship: string;
  phone: string;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * backend :: SafePatientEmergency.
 *
 * `pickupLatitude`/`pickupLongitude` arrive as STRINGS: Prisma Decimal columns are stringified
 * by the backend projection. Parse before doing arithmetic with them.
 */
export interface PatientEmergency {
  id: string;
  requestType: EmergencyType;
  severity: Severity;
  currentStatus: EmergencyStatus;
  description: string | null;
  pickupAddress: string | null;
  pickupLatitude: string | null;
  pickupLongitude: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
}

export interface CreateEmergencyInput {
  requestType?: EmergencyType;
  severity?: Severity;
  description?: string;
  pickupAddress?: string;
  pickupLatitude?: number;
  pickupLongitude?: number;
}

export interface UpdateProfileInput {
  dateOfBirth?: string;
  gender?: string;
  bloodGroup?: BloodGroup;
  allergies?: string;
  medicalSummary?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

export interface CreateContactInput {
  name: string;
  relationship: string;
  phone: string;
  isPrimary?: boolean;
}
