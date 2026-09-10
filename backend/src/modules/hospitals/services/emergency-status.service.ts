import { TransitionActorType } from '@prisma/client';
import type { EmergencyStatus, Prisma } from '@prisma/client';

export interface EmergencyTransitionInput {
  emergencyId: string;
  from: EmergencyStatus;
  to: EmergencyStatus;
  actorUserId: string;
  reason?: string;
  /**
   * Who performed the transition. Defaults to HOSPITAL_STAFF so every Task 1.15/1.16
   * call site keeps its existing behaviour unchanged.
   */
  actorType?: TransitionActorType;
  /**
   * Extra predicate ANDed into the conditional claim, e.g. patient ownership. It can
   * only narrow the claim: `id` and the expected `from` status are applied after it.
   */
  guard?: Prisma.EmergencyRequestWhereInput;
  /**
   * Extra columns written in the same conditional update, e.g. `cancelledAt`. The
   * target status is applied after it and cannot be overridden.
   */
  fields?: Prisma.EmergencyRequestUpdateManyMutationInput;
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
    where: { ...input.guard, id: input.emergencyId, currentStatus: input.from },
    data: { ...input.fields, currentStatus: input.to },
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
      actorType: input.actorType ?? TransitionActorType.HOSPITAL_STAFF,
      reason: input.reason,
    },
  });

  return true;
};
