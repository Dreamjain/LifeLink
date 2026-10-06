import { AmbulanceAssignmentStatus, AmbulanceStatus, DriverAvailability } from '@prisma/client';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { prisma } from '../../../database/prisma.js';
import {
  runDispatchRecoverySafely,
  type DispatchRecoveryResult,
  type DispatchRecoveryTrigger,
} from './dispatch-recovery.service.js';

interface TimeoutRule {
  trigger: DispatchRecoveryTrigger;
  timeoutSeconds: () => number;
  /** Where the vehicle stands while the assignment is in this status. */
  ambulanceFrom: AmbulanceStatus;
  reason: (seconds: number) => string;
}

/**
 * Only assignments that are waiting on the driver can time out. Once a trip has started, ending it
 * is the driver's explicit FAIL action (Task 1.22), never a timer.
 */
const TIMEOUT_RULES: Partial<Record<AmbulanceAssignmentStatus, TimeoutRule>> = {
  [AmbulanceAssignmentStatus.OFFERED]: {
    trigger: 'OFFER_TIMEOUT',
    timeoutSeconds: () => env.DRIVER_OFFER_TIMEOUT_SECONDS,
    ambulanceFrom: AmbulanceStatus.OFFERED,
    reason: (seconds) => `Offer timed out: the driver did not respond within ${seconds} seconds.`,
  },
  [AmbulanceAssignmentStatus.ACCEPTED]: {
    trigger: 'ACCEPTED_TIMEOUT',
    timeoutSeconds: () => env.DRIVER_ACCEPTED_TIMEOUT_SECONDS,
    ambulanceFrom: AmbulanceStatus.ASSIGNED,
    reason: (seconds) =>
      `Accepted offer timed out: the trip did not start within ${seconds} seconds of the offer.`,
  },
};

export interface StaleAssignmentExpiry {
  assignmentId: string;
  expired: boolean;
  /** Present only when this call cancelled the assignment and ran recovery. */
  recovery: DispatchRecoveryResult | null;
}

/**
 * Cancels one assignment if, and only if, it is still waiting on its driver past its timeout
 * (Task 1.24, decisions D4 and D5). Both timeouts are measured from `assignedAt`.
 *
 * The cancellation is an exact conditional claim on the status observed in this transaction and on
 * `assignedAt < cutoff`, so it races safely with the driver: an accept or reject that commits
 * first moves the row out of OFFERED, and a START that commits first moves it out of ACCEPTED, and
 * this claim then matches zero rows. If the timeout wins, the driver's own action finds the row
 * CANCELLED and reports a 409. Repeated or overlapping sweeps are equally harmless: only one claim
 * can succeed.
 *
 * Resources are released with the same conditional, best-effort releases rejectOwnAssignment uses,
 * and recovery runs only after the cancellation has committed (decision D7).
 */
export const expireStaleAssignment = async (
  assignmentId: string,
  now: Date = new Date(),
): Promise<StaleAssignmentExpiry> => {
  const cancelled = await prisma.$transaction(async (tx) => {
    const assignment = await tx.ambulanceAssignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, status: true, emergencyId: true, ambulanceId: true, driverId: true },
    });

    const rule = assignment ? TIMEOUT_RULES[assignment.status] : undefined;

    if (!assignment || !rule) {
      return null;
    }

    const timeoutSeconds = rule.timeoutSeconds();
    const cutoff = new Date(now.getTime() - timeoutSeconds * 1000);

    const claimed = await tx.ambulanceAssignment.updateMany({
      where: { id: assignmentId, status: assignment.status, assignedAt: { lt: cutoff } },
      data: {
        status: AmbulanceAssignmentStatus.CANCELLED,
        endedAt: now,
        rejectionReason: rule.reason(timeoutSeconds),
      },
    });

    if (claimed.count === 0) {
      return null;
    }

    await tx.ambulance.updateMany({
      where: { id: assignment.ambulanceId, status: rule.ambulanceFrom },
      data: { status: AmbulanceStatus.AVAILABLE },
    });

    await tx.driverProfile.updateMany({
      where: { id: assignment.driverId, availabilityStatus: DriverAvailability.BUSY },
      data: { availabilityStatus: DriverAvailability.AVAILABLE },
    });

    return { emergencyId: assignment.emergencyId, trigger: rule.trigger };
  });

  if (!cancelled) {
    return { assignmentId, expired: false, recovery: null };
  }

  logger.info(
    {
      assignmentId,
      emergencyId: cancelled.emergencyId,
      trigger: cancelled.trigger,
      action: 'dispatch-timeout',
    },
    'dispatch.timeout.assignment_cancelled',
  );

  const recovery = await runDispatchRecoverySafely(cancelled.emergencyId, cancelled.trigger);

  return { assignmentId, expired: true, recovery };
};

/** Upper bound on assignments one sweep pass inspects; the next pass picks up the rest. */
const SWEEP_BATCH_SIZE = 50;

export interface DispatchTimeoutSweepResult {
  candidates: number;
  expired: number;
}

/**
 * One pass of the periodic timeout sweep: finds OFFERED and ACCEPTED assignments past their
 * timeouts and expires each through `expireStaleAssignment`, which re-checks everything under its
 * own conditional claim. The candidate query is only a hint, so a row that moved on in between is
 * simply skipped.
 */
export const sweepStaleAssignments = async (
  now: Date = new Date(),
): Promise<DispatchTimeoutSweepResult> => {
  const offerCutoff = new Date(now.getTime() - env.DRIVER_OFFER_TIMEOUT_SECONDS * 1000);
  const acceptedCutoff = new Date(now.getTime() - env.DRIVER_ACCEPTED_TIMEOUT_SECONDS * 1000);

  const candidates = await prisma.ambulanceAssignment.findMany({
    where: {
      OR: [
        { status: AmbulanceAssignmentStatus.OFFERED, assignedAt: { lt: offerCutoff } },
        { status: AmbulanceAssignmentStatus.ACCEPTED, assignedAt: { lt: acceptedCutoff } },
      ],
    },
    orderBy: { assignedAt: 'asc' },
    take: SWEEP_BATCH_SIZE,
    select: { id: true },
  });

  let expired = 0;

  for (const candidate of candidates) {
    try {
      const outcome = await expireStaleAssignment(candidate.id, now);
      if (outcome.expired) expired += 1;
    } catch (error) {
      logger.error(
        { err: error, assignmentId: candidate.id, action: 'dispatch-timeout' },
        'dispatch.timeout.expire_failed',
      );
    }
  }

  return { candidates: candidates.length, expired };
};

export interface DispatchTimeoutSweepOptions {
  intervalMs?: number;
  /** Injectable for tests; defaults to the real sweep. */
  sweep?: () => Promise<DispatchTimeoutSweepResult>;
}

/**
 * Starts the lightweight in-process timer that drives the timeout sweep (decision D4). Not a job
 * queue: a pass is skipped while the previous one is still running, the timer never keeps the
 * process alive, and correctness under several server processes comes from the conditional claims,
 * not from the timer. Returns a function that stops it.
 */
export const startDispatchTimeoutSweep = (
  options: DispatchTimeoutSweepOptions = {},
): (() => void) => {
  const intervalMs = options.intervalMs ?? env.DISPATCH_TIMEOUT_SWEEP_INTERVAL_SECONDS * 1000;
  const sweep = options.sweep ?? (() => sweepStaleAssignments());
  let running = false;

  const timer = setInterval(() => {
    if (running) {
      return;
    }

    running = true;
    void sweep()
      .then((result) => {
        if (result.expired > 0) {
          logger.info(
            { ...result, action: 'dispatch-timeout' },
            'dispatch.timeout.sweep_completed',
          );
        }
      })
      .catch((error: unknown) => {
        logger.error({ err: error, action: 'dispatch-timeout' }, 'dispatch.timeout.sweep_failed');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  timer.unref();

  return () => clearInterval(timer);
};
