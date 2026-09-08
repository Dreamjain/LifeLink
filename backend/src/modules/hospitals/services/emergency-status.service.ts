import { TransitionActorType } from '@prisma/client';
import type { EmergencyStatus, Prisma } from '@prisma/client';

export interface EmergencyTransitionInput {
  emergencyId: string;
  from: EmergencyStatus;
  to: EmergencyStatus;
  actorUserId: string;
  reason?: string;
}

/**
 * Conditionally moves an emergency between two exact states and appends the immutable
 * history row in the same transaction (DatabaseDesign.md §7). Returns false when the row
 * is no longer in `from` — that conditional update is what serializes competing writers.
 */
export const transitionEmergency = async (
  tx: Prisma.TransactionClient,
  input: EmergencyTransitionInput,
): Promise<boolean> => {
  const result = await tx.emergencyRequest.updateMany({
    where: { id: input.emergencyId, currentStatus: input.from },
    data: { currentStatus: input.to },
  });

  if (result.count === 0) {
    return false;
  }

  await tx.emergencyStatusHistory.create({
    data: {
      emergencyId: input.emergencyId,
      fromStatus: input.from,
      toStatus: input.to,
      actorUserId: input.actorUserId,
      actorType: TransitionActorType.HOSPITAL_STAFF,
      reason: input.reason,
    },
  });

  return true;
};
