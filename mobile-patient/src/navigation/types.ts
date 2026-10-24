/**
 * One parameter list per authentication state. Keeping them separate is what makes the auth gate
 * structural rather than advisory: a screen that belongs to another state is not merely hidden,
 * it does not exist in the navigator that is mounted, so there is no route to it at all.
 */
export type UnauthenticatedStackParamList = {
  Login: undefined;
  Register: undefined;
};

export type OnboardingStackParamList = {
  ProfileSetup: undefined;
  EmergencyContacts: undefined;
  PendingApproval: undefined;
};

export type ActiveStackParamList = {
  Home: undefined;
  EmergencyDetail: { emergencyId: string };
};
