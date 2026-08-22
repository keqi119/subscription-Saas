import { ConflictException } from "@nestjs/common";
import {
  BillingScheduleStatus,
  EntitlementAccountStatus,
  Prisma,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";

import {
  bindSubscriptionClosureAuthorityConsumer,
  consumeSubscriptionClosureAuthorityAttestation,
  type ClosureAuthorityAttestation,
  type SubscriptionClosureAuthorityLock,
  type SubscriptionClosureAuthorityRequirement,
  type SubscriptionClosureAuthoritySession
} from "../subscription-closure/subscription-closure.repository";
import {
  canonicalSubscriptionClosureJson,
  hashSubscriptionClosureSnapshot
} from "../subscription-closure/subscription-closure.domain";
import type { SubscriptionClosureSnapshotObject } from "../subscription-closure/subscription-closure.types";

const FUTURE_AUTOMATION_JOB_TYPES = new Set<SubscriptionAutomationJobType>([
  SubscriptionAutomationJobType.RENEWAL_REMINDER_D30,
  SubscriptionAutomationJobType.RENEWAL_REMINDER_D14,
  SubscriptionAutomationJobType.RENEWAL_REMINDER_D3,
  SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE,
  SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME,
  SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW,
  SubscriptionAutomationJobType.EXTENSION_INSURANCE_VALIDATION,
  SubscriptionAutomationJobType.EXTENSION_EFFECTIVE_NOTICE
]);

const EFFECTIVE_BOUNDARY_AUTHORITY_CONSUMER = Object.freeze({});

declare const effectiveBoundaryCapabilityBrand: unique symbol;
export type EffectiveBoundaryTransactionCapability = Readonly<{
  [effectiveBoundaryCapabilityBrand]: true;
}>;

export type PrepareEffectiveBoundaryInput = Readonly<{
  boundaryAt: Date;
  occurredAt: Date;
  orderId: string;
}>;

type EffectiveBoundaryCommand = SubscriptionClosureSnapshotObject &
  Readonly<{
    automationJobs: readonly SubscriptionClosureSnapshotObject[];
    boundaryAt: Date;
    cancelAutomationJobIds: readonly string[];
    closeEntitlementAccountIds: readonly string[];
    entitlementAccounts: readonly SubscriptionClosureSnapshotObject[];
    occurredAt: Date;
    orderId: string;
    schedule: SubscriptionClosureSnapshotObject | null;
    scheduleAction: "COMPLETE_FUTURE" | "NONE" | "PRESERVE_EARNED";
  }>;

type EffectiveBoundaryCapabilityState = Readonly<{
  command: EffectiveBoundaryCommand;
  session: SubscriptionClosureAuthoritySession;
  transaction: Prisma.TransactionClient;
}>;

export class SubscriptionEffectiveBoundaryOwner {
  private readonly capabilities = new WeakMap<
    EffectiveBoundaryTransactionCapability,
    EffectiveBoundaryCapabilityState
  >();

  async prepareInTransaction(
    tx: Prisma.TransactionClient,
    session: SubscriptionClosureAuthoritySession,
    input: PrepareEffectiveBoundaryInput
  ) {
    const command = await resolveEffectiveBoundaryCommand(tx, input);
    const capability = Object.freeze({}) as EffectiveBoundaryTransactionCapability;
    this.capabilities.set(capability, Object.freeze({ command, session, transaction: tx }));
    return Object.freeze({
      capability,
      requirement: effectiveBoundaryAuthorityRequirement(session, command)
    });
  }

  async applyPreparedInTransaction(
    tx: Prisma.TransactionClient,
    session: SubscriptionClosureAuthoritySession,
    capability: EffectiveBoundaryTransactionCapability,
    authorityAttestation: ClosureAuthorityAttestation
  ) {
    const state = await this.consumePreparedInTransaction(
      tx,
      session,
      capability,
      authorityAttestation
    );

    if (state.command.schedule && state.command.scheduleAction !== "NONE") {
      const schedule = state.command.schedule;
      const updated = await tx.billingSchedule.updateMany({
        data:
          state.command.scheduleAction === "PRESERVE_EARNED"
            ? {
                completedAt: null,
                pauseReason: null,
                status: BillingScheduleStatus.ACTIVE,
                version: { increment: 1 }
              }
            : {
                completedAt: state.command.occurredAt,
                pauseReason: null,
                status: BillingScheduleStatus.COMPLETED,
                version: { increment: 1 }
              },
        where: {
          id: schedule.id as string,
          status: schedule.status as BillingScheduleStatus,
          version: schedule.version as number
        }
      });
      if (updated.count !== 1) throw authorityMismatch();
    }

    if (state.command.closeEntitlementAccountIds.length > 0) {
      const updated = await tx.orderEntitlementAccount.updateMany({
        data: { accountStatus: EntitlementAccountStatus.CLOSED },
        where: {
          accountStatus: EntitlementAccountStatus.ACTIVE,
          deletedAt: null,
          id: { in: [...state.command.closeEntitlementAccountIds] },
          orderId: state.command.orderId
        }
      });
      if (updated.count !== state.command.closeEntitlementAccountIds.length) {
        throw authorityMismatch();
      }
    }

    if (state.command.cancelAutomationJobIds.length > 0) {
      const updated = await tx.subscriptionAutomationJob.updateMany({
        data: {
          cancelledAt: state.command.occurredAt,
          completedAt: state.command.occurredAt,
          jobStatus: SubscriptionAutomationJobStatus.CANCELLED,
          leaseExpiresAt: null,
          leaseToken: null
        },
        where: {
          billId: null,
          id: { in: [...state.command.cancelAutomationJobIds] },
          jobStatus: {
            in: [
              SubscriptionAutomationJobStatus.PENDING,
              SubscriptionAutomationJobStatus.PROCESSING
            ]
          },
          orderId: state.command.orderId
        }
      });
      if (updated.count !== state.command.cancelAutomationJobIds.length) {
        throw authorityMismatch();
      }
    }

    return effectiveBoundaryOutcome(state.command);
  }

  async validatePreparedInTransaction(
    tx: Prisma.TransactionClient,
    session: SubscriptionClosureAuthoritySession,
    capability: EffectiveBoundaryTransactionCapability,
    authorityAttestation: ClosureAuthorityAttestation
  ) {
    const state = await this.consumePreparedInTransaction(
      tx,
      session,
      capability,
      authorityAttestation
    );
    return effectiveBoundaryOutcome(state.command);
  }

  private async consumePreparedInTransaction(
    tx: Prisma.TransactionClient,
    session: SubscriptionClosureAuthoritySession,
    capability: EffectiveBoundaryTransactionCapability,
    authorityAttestation: ClosureAuthorityAttestation
  ) {
    const state = this.capabilities.get(capability);
    this.capabilities.delete(capability);
    if (!state || state.transaction !== tx || state.session !== session) {
      throw capabilityInvalid();
    }
    try {
      consumeSubscriptionClosureAuthorityAttestation(
        tx,
        session,
        authorityAttestation,
        () => effectiveBoundaryAuthorityRequirement(session, state.command),
        null
      );
    } catch (error) {
      throw capabilityInvalid(error);
    }
    const current = await resolveEffectiveBoundaryCommand(tx, {
      boundaryAt: state.command.boundaryAt,
      occurredAt: state.command.occurredAt,
      orderId: state.command.orderId
    });
    if (
      canonicalSubscriptionClosureJson(current) !== canonicalSubscriptionClosureJson(state.command)
    ) {
      throw authorityMismatch();
    }
    return state;
  }
}

export const subscriptionEffectiveBoundaryOwner = new SubscriptionEffectiveBoundaryOwner();

function effectiveBoundaryOutcome(command: EffectiveBoundaryCommand) {
  return Object.freeze({
    cancelledAutomationJobCount: command.cancelAutomationJobIds.length,
    closedEntitlementAccountCount: command.closeEntitlementAccountIds.length,
    commandFingerprint: hashSubscriptionClosureSnapshot(command),
    scheduleAction: command.scheduleAction
  });
}

async function resolveEffectiveBoundaryCommand(
  tx: Prisma.TransactionClient,
  input: PrepareEffectiveBoundaryInput
): Promise<EffectiveBoundaryCommand> {
  const [schedule, entitlementAccounts, automationJobs] = await Promise.all([
    tx.billingSchedule.findUnique({
      select: {
        completedAt: true,
        id: true,
        nextPeriodStart: true,
        orderId: true,
        pauseReason: true,
        status: true,
        version: true
      },
      where: { orderId: input.orderId }
    }),
    tx.orderEntitlementAccount.findMany({
      orderBy: { id: "asc" },
      select: { accountStatus: true, deletedAt: true, id: true, orderId: true },
      where: { orderId: input.orderId }
    }),
    tx.subscriptionAutomationJob.findMany({
      orderBy: { id: "asc" },
      select: {
        billId: true,
        cancelledAt: true,
        completedAt: true,
        id: true,
        jobStatus: true,
        jobType: true,
        leaseExpiresAt: true,
        leaseToken: true,
        orderId: true,
        payload: true
      },
      where: { orderId: input.orderId }
    })
  ]);
  const entitlementSnapshots = entitlementAccounts.map((account) => Object.freeze({ ...account }));
  const jobSnapshots = automationJobs.map((job) =>
    Object.freeze({ ...job, payload: job.payload as never })
  );
  const closeEntitlementAccountIds = entitlementAccounts
    .filter(
      ({ accountStatus, deletedAt }) =>
        accountStatus === EntitlementAccountStatus.ACTIVE && deletedAt === null
    )
    .map(({ id }) => id);
  const boundaryDate = input.boundaryAt.toISOString().slice(0, 10);
  const cancelAutomationJobIds = automationJobs
    .filter((job) => {
      if (
        job.billId !== null ||
        (job.jobStatus !== SubscriptionAutomationJobStatus.PENDING &&
          job.jobStatus !== SubscriptionAutomationJobStatus.PROCESSING)
      ) {
        return false;
      }
      if (FUTURE_AUTOMATION_JOB_TYPES.has(job.jobType)) return true;
      if (job.jobType !== SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL) {
        return false;
      }
      const periodStart = jsonObject(job.payload).periodStart;
      return typeof periodStart === "string" && periodStart > boundaryDate;
    })
    .map(({ id }) => id);
  const scheduleAction =
    schedule &&
    (schedule.status === BillingScheduleStatus.ACTIVE ||
      schedule.status === BillingScheduleStatus.PAUSED)
      ? schedule.nextPeriodStart.getTime() <= input.boundaryAt.getTime()
        ? "PRESERVE_EARNED"
        : "COMPLETE_FUTURE"
      : "NONE";
  return Object.freeze({
    automationJobs: Object.freeze(jobSnapshots),
    boundaryAt: input.boundaryAt,
    cancelAutomationJobIds: Object.freeze(cancelAutomationJobIds),
    closeEntitlementAccountIds: Object.freeze(closeEntitlementAccountIds),
    entitlementAccounts: Object.freeze(entitlementSnapshots),
    occurredAt: input.occurredAt,
    orderId: input.orderId,
    schedule: schedule ? Object.freeze({ ...schedule }) : null,
    scheduleAction
  });
}

function effectiveBoundaryAuthorityRequirement(
  session: SubscriptionClosureAuthoritySession,
  command: EffectiveBoundaryCommand
): SubscriptionClosureAuthorityRequirement {
  const locks: SubscriptionClosureAuthorityLock[] = [
    { id: command.orderId, mode: "UPDATE", table: "subscription_order" },
    ...(command.schedule
      ? [
          {
            id: command.schedule.id as string,
            mode: "UPDATE" as const,
            table: "billing_schedule" as const
          }
        ]
      : []),
    ...command.entitlementAccounts.map((account) => ({
      id: account.id as string,
      mode: "UPDATE" as const,
      table: "order_entitlement_account" as const
    })),
    ...command.automationJobs.map((job) => ({
      id: job.id as string,
      mode: "UPDATE" as const,
      table: "subscription_automation_job" as const
    }))
  ];
  return bindSubscriptionClosureAuthorityConsumer(
    Object.freeze({ command, key: "effective-boundary-stop", locks }),
    EFFECTIVE_BOUNDARY_AUTHORITY_CONSUMER,
    session
  );
}

function jsonObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function capabilityInvalid(cause?: unknown) {
  return new ConflictException(
    {
      code: "SUBSCRIPTION_CLOSURE_CAPABILITY_INVALID",
      message: "The prepared effective-boundary capability is invalid."
    },
    cause ? { cause } : undefined
  );
}

function authorityMismatch() {
  return new ConflictException({
    code: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH",
    message: "The prepared effective-boundary facts changed before execution."
  });
}
