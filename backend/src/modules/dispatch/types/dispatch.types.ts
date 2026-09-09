/**
 * Server-resolved driver scope for an authenticated DRIVER caller.
 * Always derived from the authenticated user, never from request input
 * (AuthenticationDesign.md section 12).
 */
export interface DriverContext {
  driverProfileId: string;
  userId: string;
}
