import type { EmergencyRequest, EmergencyStatus } from '@prisma/client';

/**
 * Operational subset of the emergency that a non-patient actor needs in order to decide and
 * prepare: hospital staff reading an offer, a dispatcher reading an assignment, a driver
 * reading their run.
 *
 * Deliberately excludes every PatientProfile field (allergies, medicalSummary, identity) per
 * DatabaseDesign.md section 9 and the Task 1.11 privacy precedent.
 *
 * This lives in `common/` rather than in either owning module because the hospitals module
 * and the dispatch module both project emergencies this way. Keeping it here is what allows
 * the hospitals module to call into dispatch (Task 1.21 automatic assignment) without a
 * hospitals -> dispatch -> hospitals import cycle.
 */
export interface SafeEmergencySummary {
  id: string;
  requestType: EmergencyRequest['requestType'];
  severity: EmergencyRequest['severity'];
  currentStatus: EmergencyStatus;
  description: string | null;
  pickupAddress: string | null;
  pickupLatitude: string | null;
  pickupLongitude: string | null;
  createdAt: Date;
}

export const toSafeEmergency = (emergency: EmergencyRequest): SafeEmergencySummary => ({
  id: emergency.id,
  requestType: emergency.requestType,
  severity: emergency.severity,
  currentStatus: emergency.currentStatus,
  description: emergency.description,
  pickupAddress: emergency.pickupAddress,
  pickupLatitude: emergency.pickupLatitude?.toString() ?? null,
  pickupLongitude: emergency.pickupLongitude?.toString() ?? null,
  createdAt: emergency.createdAt,
});
