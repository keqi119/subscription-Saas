import { Injectable } from "@nestjs/common";
import {
  AuditAction,
  ContractSegmentStatus,
  ContractSegmentType,
  ContractStatus,
  ESignDocumentType,
  ESignSigningStage,
  ESignTaskStatus,
  Prisma,
  RenewalConsiderationStatus,
  RenewalReminderStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType,
  SubscriptionChangeStatus,
  SubscriptionChangeType,
  VehicleStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-number";
import { runSerializableTransaction } from "../common/serializable-transaction";
import { PrismaService } from "../prisma/prisma.service";
import { SubscriptionChangeError } from "../subscription-change/subscription-change.errors";
import {
  ExtensionChangeProjection,
  requireExtensionChangeProjection
} from "../subscription-change/subscription-extension-compat";

const extensionArchiveInclude = Prisma.validator<Prisma.SubscriptionChangeOrderInclude>()({
  confirmedQuote: true,
  contract: true,
  earlyTerminationDetail: true,
  extensionDetail: { include: { sourceSegment: true } },
  managedOtherDetail: true,
  sourceSegment: true,
  targetSegment: true,
  vehicleSwapDetail: { include: { targetVehicle: true } }
});

type ExtensionArchiveChange = Prisma.SubscriptionChangeOrderGetPayload<{
  include: typeof extensionArchiveInclude;
}>;
type ProjectedExtensionArchiveChange = ExtensionChangeProjection<ExtensionArchiveChange>;
type VehicleSwapArchiveChange = ExtensionArchiveChange & {
  vehicleSwapDetail: NonNullable<ExtensionArchiveChange["vehicleSwapDetail"]>;
};

export interface FinalizeStage3ExtensionInput {
  completedAt: Date;
  contractId: string;
  source: "CALLBACK" | "RECONCILE";
  taskId: string;
}

export type FinalizeStage3ExtensionResult =
  | { changeOrderId: string; outcome: "DUPLICATE" }
  | { changeOrderId: string; outcome: "SCHEDULED" }
  | { outcome: "DUPLICATE"; segmentId: string }
  | { outcome: "LATE_EVIDENCE_ONLY" }
  | { outcome: "SCHEDULED"; segmentId: string };

const EXPIRY_WINS_CHANGE_STATUSES: SubscriptionChangeStatus[] = [
  SubscriptionChangeStatus.CANCELLED,
  SubscriptionChangeStatus.FAILED,
  SubscriptionChangeStatus.MANUAL_TAKEOVER
];

const EXPIRY_WINS_CONSIDERATION_STATUSES: RenewalConsiderationStatus[] = [
  RenewalConsiderationStatus.EXPIRED,
  RenewalConsiderationStatus.EXPIRY_CONFIRMED,
  RenewalConsiderationStatus.CANCELLED
];

const CANCELLED_RENEWAL_JOB_TYPES: SubscriptionAutomationJobType[] = [
  SubscriptionAutomationJobType.RENEWAL_REMINDER_D30,
  SubscriptionAutomationJobType.RENEWAL_REMINDER_D14,
  SubscriptionAutomationJobType.RENEWAL_REMINDER_D3,
  SubscriptionAutomationJobType.RENEWAL_EXPIRY_PROCESS,
  SubscriptionAutomationJobType.RENEWAL_RETURN_OVERDUE_D1
];

@Injectable()
export class Stage3ExtensionArchiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService
  ) {}

  async finalizeArchivedContract(
    input: FinalizeStage3ExtensionInput
  ): Promise<FinalizeStage3ExtensionResult> {
    assertValidInput(input);

    return runSerializableTransaction(this.prisma, async (tx) => {
      await lockArchiveRows(tx, input.contractId, input.taskId);
      const storedChange = await tx.subscriptionChangeOrder.findUnique({
        include: extensionArchiveInclude,
        where: { contractId: input.contractId }
      });
      if (!storedChange) {
        throw new SubscriptionChangeError(
          "STAGE3_EXTENSION_CHANGE_NOT_FOUND",
          "The extension change for this contract was not found.",
          404
        );
      }
      const task = await tx.contractESignTask.findUnique({ where: { id: input.taskId } });
      assertArchivedEvidence(task, input.contractId, storedChange);
      if (storedChange.changeType === SubscriptionChangeType.EARLY_TERMINATION) {
        return this.finalizeEarlyTermination(tx, storedChange, input);
      }
      if (storedChange.changeType === SubscriptionChangeType.MANAGED_OTHER) {
        return this.finalizeManagedOther(tx, storedChange, input);
      }
      if (storedChange.changeType === SubscriptionChangeType.VEHICLE_SWAP) {
        return this.finalizeVehicleSwap(tx, requireVehicleSwapChange(storedChange), input);
      }
      const change = requireExtensionChangeProjection(storedChange);
      await lockExtensionBusinessRows(tx, change);
      const decisionAt = await readDatabaseClock(tx);

      const existingSegment =
        change.targetSegment ??
        (await tx.subscriptionContractSegment.findFirst({
          where: { sourceChangeOrderId: change.id }
        }));
      if (change.status === SubscriptionChangeStatus.SCHEDULED && existingSegment) {
        return { outcome: "DUPLICATE", segmentId: existingSegment.id };
      }

      await archiveContractEvidence(tx, input.contractId, input.completedAt, decisionAt);
      const consideration = change.renewalConsiderationId
        ? await tx.renewalConsideration.findUnique({
            where: { id: change.renewalConsiderationId }
          })
        : null;
      if (expiryWins(change, consideration?.status, decisionAt)) {
        await this.auditService.write(
          {
            action: AuditAction.UPDATE,
            after: {
              changeStatus: change.status,
              completedAt: input.completedAt,
              considerationStatus: consideration?.status ?? null,
              decisionAt,
              outcome: "LATE_EVIDENCE_ONLY",
              source: input.source,
              taskId: input.taskId
            },
            entityId: change.id,
            entityType: "subscription_extension_archive",
            module: "subscription_change"
          },
          tx
        );
        return { outcome: "LATE_EVIDENCE_ONLY" };
      }

      assertScheduleSource(change, consideration?.status);
      const quote = change.confirmedQuote!;
      const segment = await tx.subscriptionContractSegment.create({
        data: {
          contractSnapshot: change.contract?.contractSnapshot as Prisma.InputJsonValue,
          createdBy: null,
          endDate: change.targetEndDate,
          energyLimitCount: quote.energyLimitCount,
          energyLimitKwh: quote.energyLimitKwh,
          mileageLimitKm: quote.mileageLimitKm,
          monthlyFeeAmount: quote.monthlyFeeAmount,
          orderId: change.orderId,
          overMileageFeeAmount: quote.overMileageFeeAmount,
          planSnapshot: quote.planSnapshot as Prisma.InputJsonValue,
          productId: quote.productId,
          productVersionId: quote.productVersionId,
          quoteSnapshot: quote.quoteSnapshot as Prisma.InputJsonValue,
          segmentNo: createBusinessNo("SEG"),
          segmentType: ContractSegmentType.EXTENSION,
          sequenceNo: change.sourceSegment.sequenceNo + 1,
          sourceChangeOrderId: change.id,
          sourceContractId: input.contractId,
          startDate: change.targetStartDate,
          status: ContractSegmentStatus.SCHEDULED,
          subscriptionPlanId: quote.subscriptionPlanId
        }
      });
      const activationIdempotencyKey = `extension-activate:${segment.id}:${dateKey(segment.startDate)}`;
      await tx.subscriptionAutomationJob.upsert({
        create: {
          availableAt: shanghaiStartOfDate(segment.startDate),
          changeOrderId: change.id,
          contractSegmentId: segment.id,
          idempotencyKey: activationIdempotencyKey,
          jobType: SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE,
          orderId: change.orderId,
          payload: {
            segmentId: segment.id,
            startDate: dateKey(segment.startDate)
          }
        },
        update: {},
        where: { idempotencyKey: activationIdempotencyKey }
      });
      await tx.subscriptionChangeOrder.update({
        data: {
          status: SubscriptionChangeStatus.SCHEDULED,
          version: { increment: 1 }
        },
        where: {
          id: change.id,
          status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
          version: change.version
        }
      });
      if (change.renewalConsiderationId) {
        await tx.renewalConsideration.update({
          data: {
            status: RenewalConsiderationStatus.EXTENDED,
            version: { increment: 1 }
          },
          where: { id: change.renewalConsiderationId }
        });
        await tx.renewalReminder.updateMany({
          data: {
            cancelledAt: input.completedAt,
            status: RenewalReminderStatus.CANCELLED
          },
          where: {
            renewalConsiderationId: change.renewalConsiderationId,
            status: { in: [RenewalReminderStatus.PENDING, RenewalReminderStatus.FAILED] }
          }
        });
      }
      await tx.subscriptionAutomationJob.updateMany({
        data: { jobStatus: SubscriptionAutomationJobStatus.CANCELLED },
        where: {
          jobType: { in: CANCELLED_RENEWAL_JOB_TYPES },
          OR: [
            { changeOrderId: change.id },
            ...(change.renewalConsiderationId
              ? [{ renewalConsiderationId: change.renewalConsiderationId }]
              : [])
          ],
          jobStatus: {
            in: [
              SubscriptionAutomationJobStatus.PENDING,
              SubscriptionAutomationJobStatus.PROCESSING
            ]
          }
        }
      });
      await this.auditService.write(
        {
          action: AuditAction.CREATE,
          after: {
            changeOrderId: change.id,
            completedAt: input.completedAt,
            contractId: input.contractId,
            decisionAt,
            outcome: "SCHEDULED",
            segmentId: segment.id,
            source: input.source,
            taskId: input.taskId
          },
          entityId: segment.id,
          entityType: "subscription_contract_segment",
          module: "subscription_change"
        },
        tx
      );

      return { outcome: "SCHEDULED", segmentId: segment.id };
    });
  }

  private async finalizeVehicleSwap(
    tx: Prisma.TransactionClient,
    change: VehicleSwapArchiveChange,
    input: FinalizeStage3ExtensionInput
  ): Promise<FinalizeStage3ExtensionResult> {
    await lockVehicleSwapBusinessRows(tx, change);
    const decisionAt = await readDatabaseClock(tx);
    if (change.status === SubscriptionChangeStatus.SCHEDULED) {
      return { changeOrderId: change.id, outcome: "DUPLICATE" };
    }
    await archiveContractEvidence(tx, input.contractId, input.completedAt, decisionAt);
    if (
      decisionAt >= change.completionDeadlineAt ||
      EXPIRY_WINS_CHANGE_STATUSES.includes(change.status)
    ) {
      await this.auditService.write(
        {
          action: AuditAction.UPDATE,
          after: {
            changeStatus: change.status,
            completedAt: input.completedAt,
            decisionAt,
            outcome: "LATE_EVIDENCE_ONLY",
            source: input.source,
            taskId: input.taskId
          },
          entityId: change.id,
          entityType: "subscription_vehicle_swap_archive",
          module: "subscription_change"
        },
        tx
      );
      return { outcome: "LATE_EVIDENCE_ONLY" };
    }
    if (
      change.status !== SubscriptionChangeStatus.SIGNING_OR_PAYMENT ||
      !change.confirmedQuote ||
      change.confirmedQuote.status !== "CUSTOMER_CONFIRMED" ||
      !change.contract ||
      change.contract.id !== input.contractId ||
      change.vehicleSwapDetail.targetVehicle.status !== VehicleStatus.REVIEW_RESERVED
    ) {
      throw new SubscriptionChangeError(
        "STAGE3_VEHICLE_SWAP_STATE_INVALID",
        "The vehicle-swap supplement cannot be scheduled from its current state."
      );
    }
    await tx.subscriptionChangeOrder.update({
      data: {
        status: SubscriptionChangeStatus.SCHEDULED,
        version: { increment: 1 }
      },
      where: {
        id: change.id,
        status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
        version: change.version
      }
    });
    await this.auditService.write(
      {
        action: AuditAction.UPDATE,
        after: {
          changeOrderId: change.id,
          completedAt: input.completedAt,
          contractId: input.contractId,
          outcome: "SCHEDULED",
          source: input.source,
          targetVehicleId: change.vehicleSwapDetail.targetVehicleId,
          taskId: input.taskId
        },
        entityId: change.id,
        entityType: "subscription_vehicle_swap_archive",
        module: "subscription_change"
      },
      tx
    );
    return { changeOrderId: change.id, outcome: "SCHEDULED" };
  }

  private async finalizeEarlyTermination(
    tx: Prisma.TransactionClient,
    change: ExtensionArchiveChange,
    input: FinalizeStage3ExtensionInput
  ): Promise<FinalizeStage3ExtensionResult> {
    const decisionAt = await readDatabaseClock(tx);
    if (change.status === SubscriptionChangeStatus.SCHEDULED) {
      return { changeOrderId: change.id, outcome: "DUPLICATE" };
    }
    await archiveContractEvidence(tx, input.contractId, input.completedAt, decisionAt);
    if (
      decisionAt >= change.completionDeadlineAt ||
      EXPIRY_WINS_CHANGE_STATUSES.includes(change.status)
    ) {
      await this.auditService.write(
        {
          action: AuditAction.UPDATE,
          after: {
            changeStatus: change.status,
            completedAt: input.completedAt,
            decisionAt,
            outcome: "LATE_EVIDENCE_ONLY",
            source: input.source,
            taskId: input.taskId
          },
          entityId: change.id,
          entityType: "subscription_early_termination_archive",
          module: "subscription_change"
        },
        tx
      );
      return { outcome: "LATE_EVIDENCE_ONLY" };
    }
    if (
      change.status !== SubscriptionChangeStatus.SIGNING_OR_PAYMENT ||
      !change.contract ||
      change.contract.id !== input.contractId ||
      !change.earlyTerminationDetail?.closureCaseId ||
      change.earlyTerminationDetail.agreementContractId !== input.contractId
    ) {
      throw new SubscriptionChangeError(
        "STAGE3_EARLY_TERMINATION_STATE_INVALID",
        "The early-termination agreement cannot be scheduled from its current state."
      );
    }
    const updated = await tx.subscriptionChangeOrder.updateMany({
      data: {
        status: SubscriptionChangeStatus.SCHEDULED,
        version: { increment: 1 }
      },
      where: {
        contractId: input.contractId,
        id: change.id,
        status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
        version: change.version
      }
    });
    if (updated.count !== 1) {
      throw new SubscriptionChangeError(
        "STAGE3_EARLY_TERMINATION_STATE_CONFLICT",
        "The early-termination agreement changed during archival."
      );
    }
    await this.auditService.write(
      {
        action: AuditAction.UPDATE,
        after: {
          changeOrderId: change.id,
          closureCaseId: change.earlyTerminationDetail.closureCaseId,
          completedAt: input.completedAt,
          contractId: input.contractId,
          outcome: "SCHEDULED",
          source: input.source,
          taskId: input.taskId
        },
        entityId: change.id,
        entityType: "subscription_early_termination_archive",
        module: "subscription_change"
      },
      tx
    );
    return { changeOrderId: change.id, outcome: "SCHEDULED" };
  }

  private async finalizeManagedOther(
    tx: Prisma.TransactionClient,
    change: ExtensionArchiveChange,
    input: FinalizeStage3ExtensionInput
  ): Promise<FinalizeStage3ExtensionResult> {
    const decisionAt = await readDatabaseClock(tx);
    if (change.status === SubscriptionChangeStatus.SCHEDULED) {
      return { changeOrderId: change.id, outcome: "DUPLICATE" };
    }
    await archiveContractEvidence(tx, input.contractId, input.completedAt, decisionAt);
    if (
      decisionAt >= change.completionDeadlineAt ||
      EXPIRY_WINS_CHANGE_STATUSES.includes(change.status)
    ) {
      await this.auditService.write(
        {
          action: AuditAction.UPDATE,
          after: {
            changeStatus: change.status,
            completedAt: input.completedAt,
            decisionAt,
            outcome: "LATE_EVIDENCE_ONLY",
            source: input.source,
            taskId: input.taskId
          },
          entityId: change.id,
          entityType: "subscription_managed_other_archive",
          module: "subscription_change"
        },
        tx
      );
      return { outcome: "LATE_EVIDENCE_ONLY" };
    }
    if (
      change.status !== SubscriptionChangeStatus.SIGNING_OR_PAYMENT ||
      !change.contract ||
      change.contract.id !== input.contractId ||
      change.managedOtherDetail?.supplementContractId !== input.contractId
    ) {
      throw new SubscriptionChangeError(
        "STAGE3_MANAGED_OTHER_STATE_INVALID",
        "The managed-other supplement cannot be scheduled from its current state."
      );
    }
    const updated = await tx.subscriptionChangeOrder.updateMany({
      data: {
        status: SubscriptionChangeStatus.SCHEDULED,
        version: { increment: 1 }
      },
      where: {
        contractId: input.contractId,
        id: change.id,
        status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
        version: change.version
      }
    });
    if (updated.count !== 1) {
      throw new SubscriptionChangeError(
        "STAGE3_MANAGED_OTHER_STATE_CONFLICT",
        "The managed-other supplement changed during archival."
      );
    }
    await this.auditService.write(
      {
        action: AuditAction.UPDATE,
        after: {
          changeOrderId: change.id,
          completedAt: input.completedAt,
          contractId: input.contractId,
          outcome: "SCHEDULED",
          source: input.source,
          taskId: input.taskId
        },
        entityId: change.id,
        entityType: "subscription_managed_other_archive",
        module: "subscription_change"
      },
      tx
    );
    return { changeOrderId: change.id, outcome: "SCHEDULED" };
  }
}

function requireVehicleSwapChange(change: ExtensionArchiveChange): VehicleSwapArchiveChange {
  if (!change.vehicleSwapDetail) {
    throw new SubscriptionChangeError(
      "STAGE3_VEHICLE_SWAP_DETAIL_REQUIRED",
      "The vehicle-swap detail is required for Stage 3 archival."
    );
  }
  return change as VehicleSwapArchiveChange;
}

async function lockVehicleSwapBusinessRows(
  tx: Prisma.TransactionClient,
  change: VehicleSwapArchiveChange
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "subscription_order"
    WHERE "id" = ${change.orderId}::uuid
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "vehicle"
    WHERE "id" = ${change.vehicleSwapDetail.targetVehicleId}::uuid
    FOR UPDATE
  `);
}

function assertValidInput(input: FinalizeStage3ExtensionInput) {
  if (!(input.completedAt instanceof Date) || Number.isNaN(input.completedAt.getTime())) {
    throw new SubscriptionChangeError(
      "STAGE3_COMPLETED_AT_INVALID",
      "A valid provider completion time is required."
    );
  }
}

function assertArchivedEvidence(
  task: null | {
    contractId: string;
    documentType: ESignDocumentType;
    signedDocumentObjectKey: string | null;
    signingStage: ESignSigningStage;
    sourceId: string | null;
    sourceKey: string | null;
    sourceType: string | null;
    taskStatus: ESignTaskStatus;
  },
  contractId: string,
  change: Pick<ExtensionArchiveChange, "changeType" | "id">
) {
  const expectedSourceType = stage3SourceType(change.changeType);
  if (
    !task ||
    task.contractId !== contractId ||
    task.signingStage !== ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION ||
    task.documentType !== ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT ||
    task.taskStatus !== ESignTaskStatus.COMPLETED ||
    !task.signedDocumentObjectKey ||
    task.sourceId !== change.id ||
    task.sourceType !== expectedSourceType ||
    !isStage3AttemptKey(task.sourceKey, change.id)
  ) {
    throw new SubscriptionChangeError(
      "STAGE3_SIGNED_ARTIFACT_REQUIRED",
      "A completed Stage 3 task with a retained signed PDF is required."
    );
  }
}

function stage3SourceType(changeType: SubscriptionChangeType) {
  switch (changeType) {
    case SubscriptionChangeType.VEHICLE_SWAP:
      return "VEHICLE_SWAP_SUPPLEMENT";
    case SubscriptionChangeType.EARLY_TERMINATION:
      return "EARLY_TERMINATION_SUPPLEMENT";
    case SubscriptionChangeType.MANAGED_OTHER:
      return "MANAGED_OTHER_SUPPLEMENT";
    case SubscriptionChangeType.EXTENSION:
      return "SUBSCRIPTION_EXTENSION";
  }
}

function isStage3AttemptKey(sourceKey: string | null, changeOrderId: string) {
  if (!sourceKey) return false;
  const prefix = `subscription-change:${changeOrderId}:esign:attempt:`;
  return sourceKey.startsWith(prefix) && /^[1-9]\d*$/.test(sourceKey.slice(prefix.length));
}

function expiryWins(
  change: ProjectedExtensionArchiveChange,
  considerationStatus: RenewalConsiderationStatus | undefined,
  completedAt: Date
) {
  return (
    completedAt.getTime() >= change.completionDeadlineAt.getTime() ||
    EXPIRY_WINS_CHANGE_STATUSES.includes(change.status) ||
    (considerationStatus !== undefined &&
      EXPIRY_WINS_CONSIDERATION_STATUSES.includes(considerationStatus))
  );
}

function assertScheduleSource(
  change: ProjectedExtensionArchiveChange,
  considerationStatus: RenewalConsiderationStatus | undefined
) {
  if (
    change.status !== SubscriptionChangeStatus.SIGNING_OR_PAYMENT ||
    !change.confirmedQuote ||
    !change.contract ||
    change.targetStartDate.getTime() !== addUtcDays(change.sourceSegment.endDate, 1).getTime() ||
    (considerationStatus !== undefined &&
      considerationStatus !== RenewalConsiderationStatus.EXTENSION_IN_PROGRESS &&
      considerationStatus !== RenewalConsiderationStatus.RENEWAL_REQUESTED)
  ) {
    throw new SubscriptionChangeError(
      "STAGE3_EXTENSION_STATE_INVALID",
      "The extension cannot be scheduled from its current state."
    );
  }
}

async function lockExtensionBusinessRows(
  tx: Prisma.TransactionClient,
  change: ProjectedExtensionArchiveChange
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "renewal_consideration"
    WHERE "id" = ${change.renewalConsiderationId}::uuid
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "subscription_contract_segment"
    WHERE "id" = ${change.sourceSegment.id}::uuid
       OR "source_change_order_id" = ${change.id}::uuid
    ORDER BY "sequence_no"
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "subscription_order"
    WHERE "id" = ${change.orderId}::uuid
    FOR UPDATE
  `);
}

async function archiveContractEvidence(
  tx: Prisma.TransactionClient,
  contractId: string,
  completedAt: Date,
  archivedAt: Date
) {
  await tx.contract.update({
    data: {
      archivedAt,
      signedAt: completedAt,
      status: ContractStatus.ARCHIVED
    },
    where: { id: contractId }
  });
}

async function readDatabaseClock(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "now"
  `);
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new SubscriptionChangeError(
      "STAGE3_DATABASE_CLOCK_UNAVAILABLE",
      "The database decision time is unavailable."
    );
  }
  return now;
}

async function lockArchiveRows(tx: Prisma.TransactionClient, contractId: string, taskId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "subscription_change_order"
    WHERE "contract_id" = ${contractId}::uuid
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "contract_esign_task"
    WHERE "id" = ${taskId}::uuid
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "contract"
    WHERE "id" = ${contractId}::uuid
    FOR UPDATE
  `);
}

function addUtcDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 86_400_000);
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function shanghaiStartOfDate(value: Date) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) - 8 * 3_600_000
  );
}
