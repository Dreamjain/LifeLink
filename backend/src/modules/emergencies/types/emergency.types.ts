/**
 * Server-resolved patient scope for an authenticated PATIENT caller.
 * Always derived from the authenticated user, never from request input
 * (AuthenticationDesign.md section 13).
 */
export interface PatientContext {
  patientProfileId: string;
  userId: string;
}
