import type { HospitalStaffRole, MembershipStatus } from '@prisma/client';

/**
 * Server-resolved hospital scope for an authenticated HOSPITAL_STAFF caller.
 * Always derived from the caller's active membership, never from request input.
 */
export interface HospitalStaffContext {
  membershipId: string;
  hospitalId: string;
  staffRole: HospitalStaffRole;
  membershipStatus: MembershipStatus;
}
