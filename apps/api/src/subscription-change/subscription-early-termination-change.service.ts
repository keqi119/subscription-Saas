import { HttpException, HttpStatus, Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditAction,
  BillStatus,
  BusinessType,
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  ESignTaskStatus,
  Prisma,
  SubscriptionChangeStatus,
  SubscriptionChangeType,
  type SubscriptionClosureStatus
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { createHash } from "node:crypto";

import { AuditService } from "../audit/audit.service";
import type { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo } from "../common/business-number";
import { persistContractChargeClausesInTransaction } from "../contract/contract-charge-clause";
import { ContractPdfArtifactWriterService } from "../contract/contract-pdf-artifact-writer.service";
import type { ContractPdfArtifactWriteResult } from "../contract/contract-pdf-artifact.types";
import {
  type ContractPdfAppendixRow,
  type ContractPdfRenderModel,
  createStage1ContractPdfSigningSlots
} from "../contract/contract-pdf-render-model";
import { PrismaService } from "../prisma/prisma.service";
import type { InitiatedEarlyTermination } from "../subscription-closure/subscription-closure.early-termination.dto";
import { SubscriptionClosureService } from "../subscription-closure/subscription-closure.service";
import {
  isSubscriptionChangeTypeEnabled,
  SUBSCRIPTION_CHANGE_CONFIG,
  SubscriptionChangeConfig
} from "./subscription-change.config";
import { SubscriptionChangeError } from "./subscription-change.errors";

const earlyTerminationInclude = Prisma.validator<Prisma.SubscriptionChangeOrderInclude>()({
  earlyTerminationDetail: {
    include: { agreementContract: true, closureCase: true }
  },
  order: { include: { contract: true } },
  sourceSegment: true
});

type EarlyTerminationChange = Prisma.SubscriptionChangeOrderGetPayload<{
  include: typeof earlyTerminationInclude;
}>;

type EarlyTerminationContractReservation = {
  change: EarlyTerminationChange;
  commandId: string;
  contract: {
    contractNo: string;
    id: string;
    status: ContractStatus;
  };
  generatedAt: Date;
  template: {
    contentTemplate: string;
    templateName: string;
    versionNo: string;
  };
};

const CONTRACT_PDF_CJK_FONT_PATH_ENV = "CONTRACT_PDF_CJK_FONT_PATH";

export type EarlyTerminationEstimate = Readonly<{
  accruedReceivableAmount: string;
  contractId: string;
  depositAppliedAmount: string;
  earlyTerminationChargeAmount: string;
  effectiveDate: string;
  estimatedAmountDue: string;
  estimatedRefundAmount: string;
  futureBillBoundary: Readonly<{
    amount: string;
    billIds: readonly string[];
    cancelOnlyAtExecution: true;
  }>;
  pendingInspection: true;
  revision: number;
  sourceSegmentId: string;
}>;

export function buildEarlyTerminationEstimate(input: {
  bills: ReadonlyArray<{
    amount: bigint;
    billStatus: BillStatus;
    dueDate: Date;
    id: string;
    remainingAmount: bigint;
  }>;
  contractId: string;
  contractSnapshot: Prisma.JsonValue;
  depositAmount: bigint;
  effectiveDate: Date;
  previousRevision: number;
  sourceSegmentId: string;
}): EarlyTerminationEstimate {
  const activeBills = input.bills.filter(({ billStatus }) => billStatus !== BillStatus.CANCELLED);
  const accrued = sum(
    activeBills
      .filter(({ dueDate }) => dueDate.getTime() < input.effectiveDate.getTime())
      .map(({ remainingAmount }) => remainingAmount)
  );
  const futureBills = activeBills.filter(
    ({ dueDate }) => dueDate.getTime() >= input.effectiveDate.getTime()
  );
  const terminationCharge = explicitTerminationCharge(input.contractSnapshot);
  const grossDue = accrued + terminationCharge;
  const depositApplied = minBigInt(input.depositAmount, grossDue);
  const amountDue = grossDue - depositApplied;
  const refund = input.depositAmount > grossDue ? input.depositAmount - grossDue : 0n;
  return Object.freeze({
    accruedReceivableAmount: accrued.toString(),
    contractId: input.contractId,
    depositAppliedAmount: depositApplied.toString(),
    earlyTerminationChargeAmount: terminationCharge.toString(),
    effectiveDate: input.effectiveDate.toISOString(),
    estimatedAmountDue: amountDue.toString(),
    estimatedRefundAmount: refund.toString(),
    futureBillBoundary: Object.freeze({
      amount: sum(futureBills.map(({ remainingAmount }) => remainingAmount)).toString(),
      billIds: Object.freeze(futureBills.map(({ id }) => id).sort()),
      cancelOnlyAtExecution: true as const
    }),
    pendingInspection: true as const,
    revision: input.previousRevision + 1,
    sourceSegmentId: input.sourceSegmentId
  });
}

export function earlyTerminationCompletionOutcome(
  status: SubscriptionClosureStatus
): "CANCELLED" | "COMPLETED" | "MANUAL_TAKEOVER" | "WAITING" {
  if (status === "TERMINATED") return "COMPLETED";
  if (status === "CANCELLED" || status === "REJECTED") return "CANCELLED";
  if (status === "MANUAL_TAKEOVER" || status === "PAUSED") return "MANUAL_TAKEOVER";
  return "WAITING";
}

export interface EarlyTerminationVersionedInput {
  idempotencyKey?: string;
  version: number;
}

export interface EarlyTerminationCancellationInput extends EarlyTerminationVersionedInput {
  reason: string;
}

@Injectable()
export class SubscriptionEarlyTerminationChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly closure: SubscriptionClosureService,
    private readonly audit: AuditService,
    @Inject(SUBSCRIPTION_CHANGE_CONFIG)
    private readonly config: SubscriptionChangeConfig,
    @Optional() private readonly artifactWriter?: ContractPdfArtifactWriterService,
    @Optional() private readonly configService?: ConfigService
  ) {}

  async previewEstimate(changeOrderId: string, actor: RequestUser) {
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_QUOTE);
    const change = await findEarlyTerminationChange(this.prisma, changeOrderId);
    assertEstimateState(change);
    return this.estimate(this.prisma, change);
  }

  async createEstimate(
    changeOrderId: string,
    input: EarlyTerminationVersionedInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_QUOTE);
    assertCommand(input);
    return this.prisma.$transaction(async (tx) => {
      await lockChange(tx, changeOrderId);
      const change = await findEarlyTerminationChange(tx, changeOrderId);
      if (
        change.status === SubscriptionChangeStatus.QUOTED &&
        change.version === input.version + 1
      ) {
        const estimate = persistedEstimate(requireDetail(change));
        if (estimate) return { change, estimate };
      }
      assertVersion(change, input.version);
      assertEstimateState(change);
      const estimate = await this.estimate(tx, change);
      const detail = requireDetail(change);
      const before = changeSnapshot(change);
      await tx.subscriptionEarlyTerminationChangeDetail.update({
        data: {
          estimatedSettlementRevision: estimate.revision,
          reasonSnapshot: appendEstimate(detail.reasonSnapshot, estimate)
        },
        where: { id: detail.id }
      });
      const updated = await tx.subscriptionChangeOrder.update({
        data: {
          status: SubscriptionChangeStatus.QUOTED,
          updatedBy: actor.id,
          version: { increment: 1 }
        },
        include: earlyTerminationInclude,
        where: { id: change.id }
      });
      await this.writeAudit(tx, actor, context, change.id, before, {
        ...changeSnapshot(updated),
        estimate
      });
      return { change: updated, estimate };
    }, readCommitted);
  }

  async publishCustomerConfirmation(
    changeOrderId: string,
    input: EarlyTerminationVersionedInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_SUBMIT);
    assertCommand(input);
    return this.prisma.$transaction(async (tx) => {
      await lockChange(tx, changeOrderId);
      const change = await findEarlyTerminationChange(tx, changeOrderId);
      if (
        change.status === SubscriptionChangeStatus.QUOTED &&
        change.customerConfirmationPublishedAt &&
        change.version === input.version + 1
      ) {
        return change;
      }
      assertVersion(change, input.version);
      if (change.customerConfirmationPublishedAt) {
        throw conflict(
          "EARLY_TERMINATION_ALREADY_PUBLISHED",
          "The published early-termination estimate cannot be republished or replaced."
        );
      }
      assertEarlyTerminationDecisionDeadline(this.config.now(), change.completionDeadlineAt);
      const detail = requireDetail(change);
      if (
        change.status !== SubscriptionChangeStatus.QUOTED ||
        !detail.estimatedSettlementRevision
      ) {
        throw conflict(
          "EARLY_TERMINATION_ESTIMATE_NOT_PUBLISHABLE",
          "A persisted early-termination estimate is required before customer publication."
        );
      }
      const updated = await tx.subscriptionChangeOrder.update({
        data: {
          customerConfirmationPublishedAt: this.config.now(),
          customerConfirmationPublishedBy: actor.id,
          updatedBy: actor.id,
          version: { increment: 1 }
        },
        include: earlyTerminationInclude,
        where: { id: change.id }
      });
      await this.writeAudit(
        tx,
        actor,
        context,
        change.id,
        changeSnapshot(change),
        changeSnapshot(updated)
      );
      return updated;
    }, readCommitted);
  }

  async getPortalChange(changeOrderId: string, customer: { customerId: string }) {
    const change = await findEarlyTerminationChange(this.prisma, changeOrderId);
    if (change.order.customerId !== customer.customerId) {
      throw new SubscriptionChangeError(
        "EARLY_TERMINATION_CHANGE_NOT_FOUND",
        "The early-termination change was not found.",
        HttpStatus.NOT_FOUND
      );
    }
    const detail = requireDetail(change);
    const snapshot = asRecord(detail.reasonSnapshot);
    const featureEnabled = isSubscriptionChangeTypeEnabled(
      this.config,
      SubscriptionChangeType.EARLY_TERMINATION
    );
    const customerDecisionReady = Boolean(
      featureEnabled &&
      change.status === SubscriptionChangeStatus.QUOTED &&
      change.customerConfirmationPublishedAt &&
      detail.estimatedSettlementRevision &&
      this.config.now().getTime() < change.completionDeadlineAt.getTime()
    );
    return {
      allowedActions: customerDecisionReady ? ["CONFIRM_QUOTE", "REJECT_QUOTE"] : [],
      changeType: change.changeType,
      completionDeadlineAt: change.completionDeadlineAt,
      contractId: change.contractId,
      currentEstimate: snapshot?.currentEstimate ?? null,
      customerConfirmationPublishedAt: change.customerConfirmationPublishedAt,
      effectiveDate: detail.effectiveDate,
      estimateRevision: detail.estimatedSettlementRevision,
      featureAvailability: {
        enabled: featureEnabled,
        flagName: "SUBSCRIPTION_EARLY_TERMINATION_ENABLED"
      },
      id: change.id,
      orderId: change.orderId,
      orderNo: change.order.orderNo,
      status: change.status,
      version: change.version
    };
  }

  async decide(
    changeOrderId: string,
    input: EarlyTerminationVersionedInput & {
      commercialSnapshotHash?: string;
      decision: "ACCEPT" | "DISPUTE" | "REJECT";
      quoteId: string;
      reason?: string;
      revision: number;
    },
    customer: { customerId: string },
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertCommand(input);
    const operation = "PORTAL_EARLY_TERMINATION_DECISION";
    const requestHash = earlyTerminationCommandHash({ changeOrderId, ...input });
    const replay = await findEarlyTerminationDecisionReplay(
      this.prisma,
      customer.customerId,
      operation,
      input.idempotencyKey!,
      requestHash
    );
    if (replay) {
      const change = await findEarlyTerminationChange(this.prisma, changeOrderId);
      if (change.order.customerId !== customer.customerId) {
        throw new SubscriptionChangeError(
          "EARLY_TERMINATION_CHANGE_NOT_FOUND",
          "The early-termination change was not found.",
          HttpStatus.NOT_FOUND
        );
      }
      return change;
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await tx.subscriptionChangeCommand.create({
          data: {
            actorId: customer.customerId,
            idempotencyKey: input.idempotencyKey!,
            operation,
            requestHash
          }
        });
        await lockChange(tx, changeOrderId);
        const change = await findEarlyTerminationChange(tx, changeOrderId);
        const detail = requireDetail(change);
        assertVersion(change, input.version);
        assertEarlyTerminationDecisionDeadline(this.config.now(), change.completionDeadlineAt);
        if (
          change.order.customerId !== customer.customerId ||
          input.quoteId !== change.id ||
          change.status !== SubscriptionChangeStatus.QUOTED ||
          !change.customerConfirmationPublishedAt ||
          detail.estimatedSettlementRevision !== input.revision
        ) {
          throw conflict(
            "EARLY_TERMINATION_CUSTOMER_DECISION_STALE",
            "The published early-termination estimate is stale or unavailable."
          );
        }
        if (input.decision !== "ACCEPT" && !input.reason?.trim()) {
          throw new SubscriptionChangeError(
            "EARLY_TERMINATION_CUSTOMER_REASON_REQUIRED",
            "A reason is required when rejecting or disputing early termination."
          );
        }
        const nextStatus =
          input.decision === "ACCEPT"
            ? SubscriptionChangeStatus.CUSTOMER_CONFIRMED
            : input.decision === "REJECT"
              ? SubscriptionChangeStatus.CANCELLED
              : SubscriptionChangeStatus.MANUAL_TAKEOVER;
        await tx.subscriptionEarlyTerminationChangeDetail.update({
          data: {
            reasonSnapshot: appendDecision(detail.reasonSnapshot, {
              customerId: customer.customerId,
              decidedAt: this.config.now().toISOString(),
              decision: input.decision,
              reason: input.reason?.trim() ?? null,
              revision: input.revision
            })
          },
          where: { id: detail.id }
        });
        const updated = await tx.subscriptionChangeOrder.update({
          data: {
            cancelReason: input.decision === "REJECT" ? input.reason!.trim() : null,
            manualTakeoverAt: input.decision === "DISPUTE" ? this.config.now() : null,
            manualTakeoverReason: input.decision === "DISPUTE" ? input.reason!.trim() : null,
            status: nextStatus,
            version: { increment: 1 }
          },
          include: earlyTerminationInclude,
          where: { id: change.id }
        });
        await this.audit.write(
          {
            action: input.decision === "ACCEPT" ? AuditAction.APPROVE : AuditAction.UPDATE,
            after: { customerId: customer.customerId, decision: input, status: nextStatus },
            before: changeSnapshot(change),
            entityId: change.id,
            entityType: "subscription_early_termination_decision",
            ipAddress: context.ipAddress,
            module: "portal_subscription_change",
            userAgent: context.userAgent
          },
          tx
        );
        await tx.subscriptionChangeCommand.update({
          data: {
            completedAt: this.config.now(),
            resourceId: change.id,
            resourceType: "CHANGE"
          },
          where: { id: command.id }
        });
        return updated;
      }, readCommitted);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const concurrentReplay = await findEarlyTerminationDecisionReplay(
        this.prisma,
        customer.customerId,
        operation,
        input.idempotencyKey!,
        requestHash
      );
      if (!concurrentReplay) throw error;
      return findEarlyTerminationChange(this.prisma, changeOrderId);
    }
  }

  async generate(
    changeOrderId: string,
    input: EarlyTerminationVersionedInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.CONTRACT_GENERATE);
    assertCommand(input);
    const operation = "GENERATE_EARLY_TERMINATION_CONTRACT";
    const requestHash = earlyTerminationCommandHash({ changeOrderId, version: input.version });
    const replay = await findContractCommandReplay(
      this.prisma,
      actor.id,
      operation,
      input.idempotencyKey!,
      requestHash
    );
    if (replay) return replay;
    const current = await findEarlyTerminationChange(this.prisma, changeOrderId);
    assertVersion(current, input.version);
    assertAgreementState(current);
    const detail = requireDetail(current);
    const effectiveAt = shanghaiStartOfBusinessDate(detail.effectiveDate);
    if (effectiveAt.getTime() < this.config.now().getTime()) {
      throw conflict(
        "EARLY_TERMINATION_EFFECTIVE_DATE_TOO_SOON",
        "The early-termination effective date must have a future Shanghai execution boundary."
      );
    }
    await this.closure.initiateEarlyTermination(
      {
        actorId: actor.id,
        effectiveAt,
        evidence: estimateEvidence(detail),
        idempotencyKey: earlyTerminationCommandKey(changeOrderId, "closure"),
        orderId: current.orderId,
        reason: terminationReason(detail.reasonSnapshot)
      },
      (tx, result) => this.linkClosureCase(tx, changeOrderId, input, result, actor, context)
    );
    const reservation = await this.reserveEarlyTerminationContract(
      changeOrderId,
      input,
      actor,
      operation,
      requestHash
    );
    if ("replay" in reservation) return reservation.replay;
    let artifact: ContractPdfArtifactWriteResult;
    try {
      artifact = await this.requireArtifactWriter().writeGeneratedContractPdfArtifact({
        cjkFontPath: this.configService?.get<string>(CONTRACT_PDF_CJK_FONT_PATH_ENV),
        contractStatus: reservation.contract.status,
        existingContractFileId: null,
        recoverExistingObject: true,
        renderModel: buildEarlyTerminationPdfRenderModel(reservation),
        uploadedBy: actor.id
      });
    } catch (error) {
      await this.abortEarlyTerminationContractReservation(
        changeOrderId,
        reservation.commandId,
        reservation.contract.id,
        actor.id
      );
      throw error;
    }
    return this.finalizeEarlyTerminationContract(reservation, artifact, input, actor, context);
  }

  async startOrRetryESign<T extends { id: string }>(
    changeOrderId: string,
    input: EarlyTerminationVersionedInput,
    actor: RequestUser,
    start?: (contractId: string) => Promise<T>,
    replay?: (taskId: string) => Promise<T>,
    recover?: (contractId: string) => Promise<T | null>
  ): Promise<T> {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_ESIGN_RETRY);
    assertCommand(input);
    if (!start || !replay) {
      throw conflict(
        "EARLY_TERMINATION_ESIGN_PROVIDER_REQUIRED",
        "The configured electronic-signature provider is required."
      );
    }
    const operation = "START_EARLY_TERMINATION_ESIGN";
    const requestHash = earlyTerminationCommandHash({ changeOrderId, version: input.version });
    const existing = await this.prisma.subscriptionChangeCommand.findUnique({
      where: {
        actorId_operation_idempotencyKey: {
          actorId: actor.id,
          idempotencyKey: input.idempotencyKey!,
          operation
        }
      }
    });
    if (existing) {
      assertMatchingCommand(existing.requestHash, requestHash);
      if (existing.resourceType === "ESIGN_TASK" && existing.resourceId) {
        return replay(existing.resourceId);
      }
      if (existing.resourceType !== "ESIGN_CONTRACT" || !existing.resourceId) {
        throw conflict("IDEMPOTENCY_COMMAND_IN_PROGRESS", "The e-sign command is in progress.");
      }
      const task =
        (recover ? await recover(existing.resourceId) : null) ?? (await start(existing.resourceId));
      await completeESignCommand(this.prisma, existing.id, task.id, this.config.now());
      return task;
    }
    const reserved = await this.prisma.$transaction(async (tx) => {
      const command = await tx.subscriptionChangeCommand.create({
        data: {
          actorId: actor.id,
          idempotencyKey: input.idempotencyKey!,
          operation,
          requestHash
        }
      });
      await lockChange(tx, changeOrderId);
      const change = await findEarlyTerminationChange(tx, changeOrderId);
      assertVersion(change, input.version);
      if (
        change.status !== SubscriptionChangeStatus.SIGNING_OR_PAYMENT ||
        !change.contractId ||
        !change.earlyTerminationDetail?.agreementContract?.fileId ||
        change.earlyTerminationDetail.agreementContract.status === ContractStatus.CANCELLED
      ) {
        throw conflict(
          "EARLY_TERMINATION_ESIGN_NOT_ALLOWED",
          "The early-termination agreement is not ready for electronic signature."
        );
      }
      await tx.subscriptionChangeCommand.update({
        data: { resourceId: change.contractId, resourceType: "ESIGN_CONTRACT" },
        where: { id: command.id }
      });
      return { commandId: command.id, contractId: change.contractId };
    }, readCommitted);
    const task =
      (recover ? await recover(reserved.contractId) : null) ?? (await start(reserved.contractId));
    await completeESignCommand(this.prisma, reserved.commandId, task.id, this.config.now());
    return task;
  }

  async execute(
    changeOrderId: string,
    input: EarlyTerminationVersionedInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE);
    assertCommand(input);
    const change = await findEarlyTerminationChange(this.prisma, changeOrderId);
    const detail = requireDetail(change);
    const replay =
      change.status === SubscriptionChangeStatus.EXECUTING && change.version === input.version + 1;
    if (!replay) assertVersion(change, input.version);
    if (
      (!replay && change.status !== SubscriptionChangeStatus.SCHEDULED) ||
      !detail.closureCaseId ||
      !detail.agreementContractId ||
      detail.agreementContract?.status !== ContractStatus.ARCHIVED
    ) {
      throw conflict(
        "EARLY_TERMINATION_EXECUTION_NOT_READY",
        "The signed early-termination agreement is not ready for execution."
      );
    }
    if (
      !replay &&
      this.config.now().getTime() < shanghaiStartOfBusinessDate(detail.effectiveDate).getTime()
    ) {
      throw conflict(
        "EARLY_TERMINATION_EFFECTIVE_TIME_NOT_REACHED",
        "The governed early-termination effective time has not been reached."
      );
    }
    if (!replay) {
      assertSignedEarlyTerminationAgreementFacts(change);
      const providerTask = await this.prisma.contractESignTask.findFirst({
        orderBy: [{ completedAt: "desc" }, { id: "desc" }],
        where: {
          contractId: detail.agreementContractId,
          documentType: "SUBSCRIPTION_EXTENSION_AGREEMENT",
          signedDocumentObjectKey: { not: null },
          signingStage: "STAGE3_SUBSCRIPTION_EXTENSION",
          sourceId: change.id,
          sourceKey: { startsWith: `subscription-change:${change.id}:esign:attempt:` },
          sourceType: "EARLY_TERMINATION_SUPPLEMENT",
          taskStatus: "COMPLETED"
        }
      });
      if (!providerTask) {
        throw conflict(
          "EARLY_TERMINATION_PROVIDER_EVIDENCE_REQUIRED",
          "A completed provider e-sign task with a retained signed PDF is required."
        );
      }
      await this.closure.archiveEarlyTerminationAgreement({
        actorId: actor.id,
        agreementContractId: detail.agreementContractId,
        closureCaseId: detail.closureCaseId,
        idempotencyKey: earlyTerminationCommandKey(changeOrderId, "agreement"),
        providerTaskId: providerTask.id
      });
    }
    return this.closure.executeEarlyTermination(
      {
        actorId: actor.id,
        closureCaseId: detail.closureCaseId,
        idempotencyKey: earlyTerminationCommandKey(changeOrderId, "execute")
      },
      async (tx, result) => {
        await lockChange(tx, changeOrderId);
        const locked = await findEarlyTerminationChange(tx, changeOrderId);
        const lockedDetail = requireDetail(locked);
        if (
          locked.status === SubscriptionChangeStatus.EXECUTING &&
          locked.version === input.version + 1 &&
          lockedDetail.closureCaseId === result.closureCaseId
        ) {
          return;
        }
        assertVersion(locked, input.version);
        if (
          locked.status !== SubscriptionChangeStatus.SCHEDULED ||
          lockedDetail.closureCaseId !== result.closureCaseId
        ) {
          throw conflict(
            "EARLY_TERMINATION_EXECUTION_STATE_CONFLICT",
            "The early-termination change no longer matches its Closure execution."
          );
        }
        const stale = "outcome" in result && result.outcome === "AGREEMENT_STALE";
        const updated = await tx.subscriptionChangeOrder.update({
          data: {
            failureCode: stale ? "EARLY_TERMINATION_AGREEMENT_STALE" : null,
            failureMessage: stale
              ? "The signed early-termination agreement no longer matches current facts."
              : null,
            manualTakeoverAt: stale ? this.config.now() : null,
            manualTakeoverReason: stale ? "Closure reported agreement fact drift." : null,
            status: stale
              ? SubscriptionChangeStatus.MANUAL_TAKEOVER
              : SubscriptionChangeStatus.EXECUTING,
            updatedBy: actor.id,
            version: { increment: 1 }
          },
          where: { id: locked.id }
        });
        await this.writeAudit(
          tx,
          actor,
          context,
          locked.id,
          changeSnapshot(locked),
          changeSnapshot(updated as never)
        );
      }
    );
  }

  async cancel(
    changeOrderId: string,
    input: EarlyTerminationCancellationInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_CANCEL);
    assertCommand(input);
    const reason = input.reason.trim();
    if (!reason) {
      throw new SubscriptionChangeError(
        "CANCEL_REASON_REQUIRED",
        "A cancellation reason is required."
      );
    }
    const current = await findEarlyTerminationChange(this.prisma, changeOrderId);
    if (
      current.status === SubscriptionChangeStatus.CANCELLED &&
      current.version === input.version + 1 &&
      current.cancelReason === reason
    ) {
      return current;
    }
    assertVersion(current, input.version);
    assertCancellable(current);
    const closureCaseId = requireDetail(current).closureCaseId;
    if (!closureCaseId) {
      return this.prisma.$transaction(async (tx) => {
        await lockChange(tx, changeOrderId);
        return this.cancelInTransaction(tx, changeOrderId, input, actor, context);
      }, readCommitted);
    }
    await this.closure.cancelEarlyTermination(
      {
        actorId: actor.id,
        closureCaseId,
        idempotencyKey: earlyTerminationCommandKey(changeOrderId, "cancel"),
        reason
      },
      async (tx, result) => {
        if (result.closureCaseId !== closureCaseId) {
          throw conflict(
            "EARLY_TERMINATION_CLOSURE_LINK_CONFLICT",
            "The cancelled Closure case does not match the early-termination change."
          );
        }
        await lockChange(tx, changeOrderId);
        await this.cancelInTransaction(tx, changeOrderId, input, actor, context);
      }
    );
    return findEarlyTerminationChange(this.prisma, changeOrderId);
  }

  async progress(changeOrderId: string) {
    this.assertWriteEnabled();
    const change = await findEarlyTerminationChange(this.prisma, changeOrderId);
    if (change.status === SubscriptionChangeStatus.EXECUTING) {
      return this.reconcile(changeOrderId);
    }
    if (change.status !== SubscriptionChangeStatus.SCHEDULED) {
      return { changeOrderId, outcome: "WAITING" as const };
    }
    const detail = requireDetail(change);
    if (this.config.now().getTime() < shanghaiStartOfBusinessDate(detail.effectiveDate).getTime()) {
      return { changeOrderId, outcome: "WAITING" as const };
    }
    const actorId = change.updatedBy ?? change.createdBy;
    if (!actorId) {
      throw conflict(
        "EARLY_TERMINATION_EXECUTION_ACTOR_MISSING",
        "The scheduled early-termination change has no governed execution actor."
      );
    }
    let result: ExecutedEarlyTerminationResult;
    try {
      result = await this.execute(
        changeOrderId,
        {
          idempotencyKey: earlyTerminationCommandKey(changeOrderId, "execute"),
          version: change.version
        },
        automationActor(actorId),
        {}
      );
    } catch (error) {
      throw asEarlyTerminationExecutionError(error);
    }
    return {
      changeOrderId,
      outcome:
        "outcome" in result && result.outcome === "AGREEMENT_STALE"
          ? ("MANUAL_TAKEOVER" as const)
          : ("EXECUTING" as const)
    };
  }

  async reconcile(changeOrderId: string) {
    this.assertWriteEnabled();
    return this.prisma.$transaction(async (tx) => {
      await lockChange(tx, changeOrderId);
      const change = await findEarlyTerminationChange(tx, changeOrderId);
      if (change.status === SubscriptionChangeStatus.COMPLETED) {
        return { changeOrderId, outcome: "COMPLETED" as const };
      }
      if (change.status !== SubscriptionChangeStatus.EXECUTING) {
        return { changeOrderId, outcome: "WAITING" as const };
      }
      const closureCaseId = requireDetail(change).closureCaseId;
      const closureCase = closureCaseId
        ? await tx.subscriptionClosureCase.findUnique({ where: { id: closureCaseId } })
        : null;
      if (!closureCase) {
        throw conflict(
          "EARLY_TERMINATION_CLOSURE_FACT_MISSING",
          "The executing early-termination change is missing its Closure case."
        );
      }
      const outcome = earlyTerminationCompletionOutcome(closureCase.status);
      if (outcome === "WAITING") return { changeOrderId, outcome };
      const status =
        outcome === "COMPLETED"
          ? SubscriptionChangeStatus.COMPLETED
          : outcome === "CANCELLED"
            ? SubscriptionChangeStatus.CANCELLED
            : SubscriptionChangeStatus.MANUAL_TAKEOVER;
      await tx.subscriptionChangeOrder.update({
        data: {
          manualTakeoverAt: outcome === "MANUAL_TAKEOVER" ? this.config.now() : undefined,
          manualTakeoverReason:
            outcome === "MANUAL_TAKEOVER" ? `Closure entered ${closureCase.status}.` : undefined,
          status,
          version: { increment: 1 }
        },
        where: { id: change.id }
      });
      return { changeOrderId, outcome };
    }, readCommitted);
  }

  async markManualTakeover(changeOrderId: string, failure: { code: string; message: string }) {
    return this.prisma.$transaction(async (tx) => {
      await lockChange(tx, changeOrderId);
      const change = await findEarlyTerminationChange(tx, changeOrderId);
      if (
        change.status !== SubscriptionChangeStatus.SCHEDULED &&
        change.status !== SubscriptionChangeStatus.EXECUTING
      ) {
        return { updated: false };
      }
      const updated = await tx.subscriptionChangeOrder.update({
        data: {
          failureCode: failure.code,
          failureMessage: failure.message.slice(0, 512),
          manualTakeoverAt: this.config.now(),
          manualTakeoverReason: "Early-termination orchestration requires governed intervention.",
          status: SubscriptionChangeStatus.MANUAL_TAKEOVER,
          version: { increment: 1 }
        },
        include: earlyTerminationInclude,
        where: { id: change.id }
      });
      await this.audit.write(
        {
          action: AuditAction.UPDATE,
          after: changeSnapshot(updated),
          before: changeSnapshot(change),
          entityId: change.id,
          entityType: "subscription_early_termination_change",
          module: "subscription_change"
        },
        tx
      );
      return { updated: true };
    }, readCommitted);
  }

  private async estimate(
    tx: Prisma.TransactionClient | PrismaService,
    change: EarlyTerminationChange
  ) {
    const detail = requireDetail(change);
    const contract = change.order.contract;
    if (!contract) {
      throw conflict(
        "EARLY_TERMINATION_CONTRACT_MISSING",
        "The active subscription contract is missing."
      );
    }
    const sourceSegment =
      change.sourceSegment ??
      (await tx.subscriptionContractSegment.findFirst({
        orderBy: [{ sequenceNo: "desc" }, { id: "desc" }],
        where: {
          orderId: change.orderId,
          startDate: { lte: detail.effectiveDate },
          status: "ACTIVE"
        }
      }));
    if (!sourceSegment) {
      throw conflict(
        "EARLY_TERMINATION_SOURCE_SEGMENT_MISSING",
        "The active contract segment is missing."
      );
    }
    const bills = await tx.receivableBill.findMany({
      select: {
        amount: true,
        billStatus: true,
        dueDate: true,
        id: true,
        remainingAmount: true
      },
      where: { deletedAt: null, orderId: change.orderId }
    });
    return buildEarlyTerminationEstimate({
      bills,
      contractId: contract.id,
      contractSnapshot: contract.contractSnapshot,
      depositAmount: change.order.finalDepositAmount ?? change.order.depositAmount,
      effectiveDate: shanghaiStartOfBusinessDate(detail.effectiveDate),
      previousRevision: detail.estimatedSettlementRevision ?? 0,
      sourceSegmentId: sourceSegment.id
    });
  }

  private async linkClosureCase(
    tx: Prisma.TransactionClient,
    changeOrderId: string,
    input: EarlyTerminationVersionedInput,
    result: InitiatedEarlyTermination,
    actor: RequestUser,
    context: RequestContext
  ) {
    await lockChange(tx, changeOrderId);
    const change = await findEarlyTerminationChange(tx, changeOrderId);
    assertVersion(change, input.version);
    assertAgreementState(change);
    const detail = requireDetail(change);
    if (detail.closureCaseId && detail.closureCaseId !== result.closureCaseId) {
      throw conflict(
        "EARLY_TERMINATION_CLOSURE_LINK_CONFLICT",
        "The early-termination change is linked to another Closure case."
      );
    }
    if (!detail.closureCaseId) {
      await tx.subscriptionEarlyTerminationChangeDetail.update({
        data: { closureCaseId: result.closureCaseId },
        where: { id: detail.id }
      });
      await this.writeAudit(tx, actor, context, change.id, changeSnapshot(change), {
        ...changeSnapshot(change),
        closureCaseId: result.closureCaseId
      });
    }
  }

  private async reserveEarlyTerminationContract(
    changeOrderId: string,
    input: EarlyTerminationVersionedInput,
    actor: RequestUser,
    operation: string,
    requestHash: string
  ): Promise<
    EarlyTerminationContractReservation | { replay: Awaited<ReturnType<typeof findContractById>> }
  > {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.subscriptionChangeCommand.findUnique({
        where: {
          actorId_operation_idempotencyKey: {
            actorId: actor.id,
            idempotencyKey: input.idempotencyKey!,
            operation
          }
        }
      });
      if (existing) {
        assertMatchingCommand(existing.requestHash, requestHash);
        if (existing.resourceType === "CONTRACT" && existing.resourceId) {
          return { replay: await findContractById(tx, existing.resourceId) };
        }
        if (existing.resourceType === "CONTRACT_RENDERING" && existing.resourceId) {
          await lockChange(tx, changeOrderId);
          const change = await findEarlyTerminationChange(tx, changeOrderId);
          assertVersion(change, input.version);
          assertAgreementState(change);
          const detail = requireDetail(change);
          if (
            detail.agreementContractId !== existing.resourceId ||
            change.contractId !== existing.resourceId
          ) {
            throw conflict(
              "EARLY_TERMINATION_AGREEMENT_LINK_CONFLICT",
              "The recoverable early-termination agreement is no longer linked."
            );
          }
          const contract = await findContractById(tx, existing.resourceId);
          if (contract.status !== ContractStatus.GENERATED || contract.fileId) {
            throw conflict(
              "EARLY_TERMINATION_AGREEMENT_RECOVERY_CONFLICT",
              "The recoverable early-termination agreement is no longer awaiting PDF finalization."
            );
          }
          const snapshot = asRecord(contract.contractSnapshot);
          const templateSnapshot = asRecord(snapshot?.template);
          const templateId =
            typeof templateSnapshot?.id === "string"
              ? templateSnapshot.id
              : contract.contractVersionId;
          const template = await tx.contractVersion.findUnique({ where: { id: templateId } });
          const generatedAt = parseSnapshotDate(snapshot?.generatedAt);
          if (!template || !generatedAt) {
            throw conflict(
              "EARLY_TERMINATION_AGREEMENT_RECOVERY_FACTS_MISSING",
              "The recoverable early-termination agreement is missing immutable render facts."
            );
          }
          return { change, commandId: existing.id, contract, generatedAt, template };
        }
        throw conflict("IDEMPOTENCY_COMMAND_IN_PROGRESS", "Contract rendering is in progress.");
      }
      const command = await tx.subscriptionChangeCommand.create({
        data: {
          actorId: actor.id,
          idempotencyKey: input.idempotencyKey!,
          operation,
          requestHash
        }
      });
      await lockChange(tx, changeOrderId);
      const change = await findEarlyTerminationChange(tx, changeOrderId);
      assertVersion(change, input.version);
      assertAgreementState(change);
      const detail = requireDetail(change);
      if (!detail.closureCaseId) {
        throw conflict(
          "EARLY_TERMINATION_CLOSURE_NOT_LINKED",
          "The Closure case must be linked before generating the agreement."
        );
      }
      if (detail.agreementContractId || change.contractId) {
        throw conflict(
          "EARLY_TERMINATION_AGREEMENT_LINK_CONFLICT",
          "An early-termination agreement is already linked."
        );
      }
      const baseContract = change.order.contract;
      if (!baseContract || baseContract.status !== ContractStatus.SIGNED) {
        throw conflict(
          "EARLY_TERMINATION_CONTRACT_MISSING",
          "An active signed source subscription contract is required."
        );
      }
      const generatedAt = this.config.now();
      const template = await tx.contractVersion.findFirst({
        orderBy: { effectiveFrom: "desc" },
        where: {
          businessType: BusinessType.SUBSCRIPTION,
          deletedAt: null,
          effectiveFrom: { lte: generatedAt },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: generatedAt } }],
          status: ContractVersionStatus.ACTIVE,
          templateType: ContractTemplateType.SUBSCRIPTION_EXTENSION
        }
      });
      if (!template) {
        throw conflict(
          "EARLY_TERMINATION_TEMPLATE_NOT_FOUND",
          "No active subscription supplement template is available."
        );
      }
      const contractSnapshot = jsonValue({
        agreementFacts: earlyTerminationAgreementFacts(detail),
        authority: "CUSTOMER_PROVIDER_ESIGN",
        changeOrderId: change.id,
        closureCaseId: detail.closureCaseId,
        contentTemplate: template.contentTemplate,
        estimate: persistedEstimate(detail),
        estimateRevision: detail.estimatedSettlementRevision,
        generatedAt: generatedAt.toISOString(),
        sourceContractId: baseContract.id,
        sourceContractNo: baseContract.contractNo,
        template: {
          id: template.id,
          name: template.templateName,
          type: template.templateType,
          version: template.versionNo
        }
      });
      const contract = await tx.contract.create({
        data: {
          businessType: BusinessType.SUBSCRIPTION,
          contractNo: createBusinessNo("CON"),
          contractSnapshot,
          contractTitle: `提前结束补充协议 ${change.changeNo}`,
          contractVersionId: template.id,
          createdBy: actor.id,
          customerId: change.order.customerId,
          orderId: change.orderId,
          status: ContractStatus.GENERATED,
          updatedBy: actor.id
        }
      });
      await persistContractChargeClausesInTransaction(tx, {
        actorId: actor.id,
        contractId: contract.id,
        contractSnapshot
      });
      await tx.subscriptionEarlyTerminationChangeDetail.update({
        data: { agreementContractId: contract.id },
        where: { id: detail.id }
      });
      await tx.subscriptionChangeOrder.update({
        data: { contractId: contract.id, updatedBy: actor.id },
        where: { id: change.id }
      });
      await tx.subscriptionChangeCommand.update({
        data: { resourceId: contract.id, resourceType: "CONTRACT_RENDERING" },
        where: { id: command.id }
      });
      return { change, commandId: command.id, contract, generatedAt, template };
    }, readCommitted);
  }

  private async finalizeEarlyTerminationContract(
    reservation: EarlyTerminationContractReservation,
    artifact: ContractPdfArtifactWriteResult,
    input: EarlyTerminationVersionedInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockChange(tx, reservation.change.id);
      const change = await findEarlyTerminationChange(tx, reservation.change.id);
      assertVersion(change, input.version);
      if (
        change.status !== SubscriptionChangeStatus.CUSTOMER_CONFIRMED ||
        change.contractId !== reservation.contract.id
      ) {
        throw conflict(
          "EARLY_TERMINATION_AGREEMENT_LINK_CONFLICT",
          "The early-termination agreement changed during rendering."
        );
      }
      const detail = requireDetail(change);
      const contract = await tx.contract.update({
        data: {
          contractSnapshot: appendPdfArtifact(
            detail.agreementContract?.contractSnapshot ?? {},
            artifact
          ),
          fileId: artifact.fileId,
          updatedBy: actor.id
        },
        where: { id: reservation.contract.id }
      });
      const updated = await tx.subscriptionChangeOrder.updateMany({
        data: {
          status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
          updatedBy: actor.id,
          version: { increment: 1 }
        },
        where: {
          id: change.id,
          status: SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
          version: input.version
        }
      });
      if (updated.count !== 1) {
        throw conflict(
          "EARLY_TERMINATION_AGREEMENT_LINK_CONFLICT",
          "The rendered early-termination agreement could not be linked atomically."
        );
      }
      await tx.subscriptionChangeCommand.update({
        data: {
          completedAt: this.config.now(),
          resourceId: contract.id,
          resourceType: "CONTRACT"
        },
        where: { id: reservation.commandId }
      });
      await this.writeAudit(tx, actor, context, change.id, changeSnapshot(change), {
        agreementContractId: contract.id,
        closureCaseId: detail.closureCaseId,
        status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT
      });
      return contract;
    }, readCommitted);
  }

  private async abortEarlyTerminationContractReservation(
    changeOrderId: string,
    commandId: string,
    contractId: string,
    actorId: string
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.contract.updateMany({
        data: { status: ContractStatus.CANCELLED, updatedBy: actorId },
        where: { id: contractId, status: ContractStatus.GENERATED }
      });
      await tx.subscriptionEarlyTerminationChangeDetail.updateMany({
        data: { agreementContractId: null },
        where: { agreementContractId: contractId, changeOrderId }
      });
      await tx.subscriptionChangeOrder.updateMany({
        data: { contractId: null, updatedBy: actorId },
        where: { contractId, id: changeOrderId }
      });
      await tx.subscriptionChangeCommand.deleteMany({ where: { id: commandId } });
    }, readCommitted);
  }

  private requireArtifactWriter() {
    if (!this.artifactWriter) {
      throw conflict(
        "EARLY_TERMINATION_PDF_WRITER_REQUIRED",
        "The early-termination PDF artifact writer is not configured."
      );
    }
    return this.artifactWriter;
  }

  private assertWriteEnabled() {
    if (isSubscriptionChangeTypeEnabled(this.config, SubscriptionChangeType.EARLY_TERMINATION)) {
      return;
    }
    throw new SubscriptionChangeError(
      "SUBSCRIPTION_EARLY_TERMINATION_DISABLED",
      "Early-termination subscription changes are disabled.",
      HttpStatus.SERVICE_UNAVAILABLE
    );
  }

  private async cancelInTransaction(
    tx: Prisma.TransactionClient,
    changeOrderId: string,
    input: EarlyTerminationCancellationInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    const change = await findEarlyTerminationChange(tx, changeOrderId);
    assertVersion(change, input.version);
    assertCancellable(change);
    const detail = requireDetail(change);
    if (
      detail.agreementContractId &&
      detail.agreementContract?.status === ContractStatus.GENERATED
    ) {
      await tx.contractESignTask.updateMany({
        data: {
          cancelledAt: this.config.now(),
          taskStatus: ESignTaskStatus.CANCELLED,
          updatedBy: actor.id
        },
        where: {
          contractId: detail.agreementContractId,
          taskStatus: {
            in: [
              ESignTaskStatus.CREATED,
              ESignTaskStatus.WAITING_CUSTOMER,
              ESignTaskStatus.SIGNING,
              ESignTaskStatus.FAILED
            ]
          }
        }
      });
      const cancelled = await tx.contract.updateMany({
        data: { status: ContractStatus.CANCELLED, updatedBy: actor.id },
        where: { id: detail.agreementContractId, status: ContractStatus.GENERATED }
      });
      if (cancelled.count !== 1) {
        throw conflict(
          "EARLY_TERMINATION_AGREEMENT_CANCEL_CONFLICT",
          "The early-termination agreement could not be cancelled."
        );
      }
    }
    const updated = await tx.subscriptionChangeOrder.update({
      data: {
        cancelReason: input.reason.trim(),
        status: SubscriptionChangeStatus.CANCELLED,
        updatedBy: actor.id,
        version: { increment: 1 }
      },
      include: earlyTerminationInclude,
      where: { id: change.id }
    });
    await this.writeAudit(
      tx,
      actor,
      context,
      change.id,
      changeSnapshot(change),
      changeSnapshot(updated)
    );
    return updated;
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    context: RequestContext,
    id: string,
    before: unknown,
    after: unknown
  ) {
    return this.audit.write(
      {
        action: AuditAction.UPDATE,
        after,
        before,
        entityId: id,
        entityType: "subscription_early_termination_change",
        ipAddress: context.ipAddress,
        module: "subscription_change",
        operatorId: actor.id,
        userAgent: context.userAgent
      },
      tx
    );
  }
}

async function findEarlyTerminationChange(
  tx: Prisma.TransactionClient | PrismaService,
  changeOrderId: string
) {
  const change = await tx.subscriptionChangeOrder.findUnique({
    include: earlyTerminationInclude,
    where: { id: changeOrderId }
  });
  if (!change || change.changeType !== SubscriptionChangeType.EARLY_TERMINATION) {
    throw new SubscriptionChangeError(
      "EARLY_TERMINATION_CHANGE_NOT_FOUND",
      "The early-termination change was not found.",
      HttpStatus.NOT_FOUND
    );
  }
  return change;
}

function requireDetail(change: EarlyTerminationChange) {
  if (!change.earlyTerminationDetail) {
    throw conflict("EARLY_TERMINATION_DETAIL_MISSING", "The early-termination detail is missing.");
  }
  return change.earlyTerminationDetail;
}

function assertEstimateState(change: EarlyTerminationChange) {
  if (change.status !== SubscriptionChangeStatus.DRAFT) {
    throw conflict(
      "EARLY_TERMINATION_ESTIMATE_NOT_ALLOWED",
      "Only a draft early-termination change can create an estimate."
    );
  }
}

function assertAgreementState(change: EarlyTerminationChange) {
  if (change.status !== SubscriptionChangeStatus.CUSTOMER_CONFIRMED) {
    throw conflict(
      "EARLY_TERMINATION_CUSTOMER_CONFIRMATION_REQUIRED",
      "Customer acceptance is required before archiving the early-termination agreement."
    );
  }
  if (!requireDetail(change).estimatedSettlementRevision) {
    throw conflict(
      "EARLY_TERMINATION_ESTIMATE_REQUIRED",
      "A persisted early-termination estimate is required."
    );
  }
}

function assertSignedEarlyTerminationAgreementFacts(change: EarlyTerminationChange) {
  const detail = requireDetail(change);
  const signedSnapshot = asRecord(detail.agreementContract?.contractSnapshot);
  if (
    !signedSnapshot?.agreementFacts ||
    earlyTerminationCommandHash(signedSnapshot.agreementFacts) !==
      earlyTerminationCommandHash(earlyTerminationAgreementFacts(detail))
  ) {
    throw conflict(
      "EARLY_TERMINATION_SIGNED_FACT_DRIFT",
      "The customer-signed early-termination agreement no longer matches the current governed facts."
    );
  }
}

function earlyTerminationAgreementFacts(detail: ReturnType<typeof requireDetail>) {
  return jsonValue({
    closureCaseId: detail.closureCaseId,
    effectiveDate: detail.effectiveDate.toISOString(),
    estimate: persistedEstimate(detail),
    estimateRevision: detail.estimatedSettlementRevision,
    reason: terminationReason(detail.reasonSnapshot)
  });
}

function assertCancellable(change: EarlyTerminationChange) {
  if (
    !new Set<SubscriptionChangeStatus>([
      SubscriptionChangeStatus.DRAFT,
      SubscriptionChangeStatus.QUOTED,
      SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
      SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
      SubscriptionChangeStatus.SCHEDULED,
      SubscriptionChangeStatus.MANUAL_TAKEOVER
    ]).has(change.status)
  ) {
    throw conflict(
      "EARLY_TERMINATION_NOT_CANCELLABLE",
      "The early-termination change can no longer be cancelled directly."
    );
  }
}

function assertVersion(change: Pick<EarlyTerminationChange, "version">, version: number) {
  if (change.version !== version) {
    throw conflict("VERSION_CONFLICT", "The subscription change was updated by another request.");
  }
}

function assertCommand(input: EarlyTerminationVersionedInput) {
  if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 128) {
    throw new SubscriptionChangeError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key header is required."
    );
  }
  if (!Number.isInteger(input.version) || input.version < 0) {
    throw new SubscriptionChangeError("VERSION_INVALID", "A non-negative version is required.");
  }
}

function assertEarlyTerminationDecisionDeadline(now: Date, completionDeadlineAt: Date) {
  if (now.getTime() < completionDeadlineAt.getTime()) return;
  throw conflict(
    "EARLY_TERMINATION_DECISION_DEADLINE_PASSED",
    "The early-termination customer decision deadline has passed."
  );
}

async function findEarlyTerminationDecisionReplay(
  db: Pick<Prisma.TransactionClient, "subscriptionChangeCommand">,
  actorId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string
) {
  const command = await db.subscriptionChangeCommand.findUnique({
    where: { actorId_operation_idempotencyKey: { actorId, idempotencyKey, operation } }
  });
  if (!command) return null;
  if (command.requestHash !== requestHash) {
    throw conflict(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
      "The Idempotency-Key was already used with a different request."
    );
  }
  if (command.resourceType !== "CHANGE" || !command.resourceId || !command.completedAt) {
    throw conflict(
      "IDEMPOTENCY_COMMAND_IN_PROGRESS",
      "The idempotent customer decision has not completed."
    );
  }
  return command;
}

function earlyTerminationCommandHash(value: unknown) {
  return createHash("sha256").update(stableCommandJson(value)).digest("hex");
}

function stableCommandJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableCommandJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableCommandJson(item)}`)
    .join(",")}}`;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function findContractCommandReplay(
  db: Pick<Prisma.TransactionClient, "contract" | "subscriptionChangeCommand">,
  actorId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string
) {
  const command = await db.subscriptionChangeCommand.findUnique({
    where: { actorId_operation_idempotencyKey: { actorId, idempotencyKey, operation } }
  });
  if (!command) return null;
  assertMatchingCommand(command.requestHash, requestHash);
  if (command.resourceType === "CONTRACT_RENDERING" && command.resourceId) return null;
  if (command.resourceType !== "CONTRACT" || !command.resourceId || !command.completedAt) {
    throw conflict("IDEMPOTENCY_COMMAND_IN_PROGRESS", "Contract rendering is in progress.");
  }
  return findContractById(db, command.resourceId);
}

async function findContractById(
  db: Pick<Prisma.TransactionClient, "contract">,
  contractId: string
) {
  const contract = await db.contract.findUnique({ where: { id: contractId } });
  if (!contract) {
    throw conflict("IDEMPOTENCY_RESOURCE_MISSING", "The generated contract is missing.");
  }
  return contract;
}

function assertMatchingCommand(actual: string, expected: string) {
  if (actual !== expected) {
    throw conflict(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
      "The Idempotency-Key was already used with a different request."
    );
  }
}

async function completeESignCommand(
  db: Pick<Prisma.TransactionClient, "subscriptionChangeCommand">,
  commandId: string,
  taskId: string,
  completedAt: Date
) {
  await db.subscriptionChangeCommand.update({
    data: { completedAt, resourceId: taskId, resourceType: "ESIGN_TASK" },
    where: { id: commandId }
  });
}

function buildEarlyTerminationPdfRenderModel(
  reservation: EarlyTerminationContractReservation
): ContractPdfRenderModel {
  const detail = requireDetail(reservation.change);
  const estimate = persistedEstimate(detail);
  const reason = terminationReason(detail.reasonSnapshot);
  return {
    agreementKind: "SUBSCRIPTION_STANDARD",
    appendix: {
      sections: [
        {
          title: "Early termination authority",
          rows: compactPdfRows([
            pdfRow("Change order no.", reservation.change.changeNo),
            pdfRow("Source contract no.", reservation.change.order.contract?.contractNo),
            pdfRow("Effective date", detail.effectiveDate),
            pdfRow("Customer-confirmed estimate revision", detail.estimatedSettlementRevision),
            pdfRow("Reason", reason)
          ])
        },
        {
          title: "Estimated settlement",
          rows: compactPdfRows([
            pdfRow("Accrued receivable amount", estimate?.accruedReceivableAmount),
            pdfRow("Early termination charge", estimate?.earlyTerminationChargeAmount),
            pdfRow("Deposit applied amount", estimate?.depositAppliedAmount),
            pdfRow("Estimated amount due", estimate?.estimatedAmountDue),
            pdfRow("Estimated refund amount", estimate?.estimatedRefundAmount),
            pdfRow("Inspection pending", estimate?.pendingInspection ?? true)
          ])
        }
      ]
    },
    contentTemplate: reservation.template.contentTemplate,
    contractId: reservation.contract.id,
    contractNo: reservation.contract.contractNo,
    generatedAt: reservation.generatedAt,
    orderNo: reservation.change.order.orderNo,
    signingSlots: createStage1ContractPdfSigningSlots(),
    signingStage: "STAGE1_CONTRACT",
    templateName: reservation.template.templateName,
    templateVersion: reservation.template.versionNo
  };
}

function pdfRow(label: string, value: unknown): ContractPdfAppendixRow | null {
  if (value === null || value === undefined || value === "") return null;
  return {
    label,
    value:
      value instanceof Date || ["boolean", "number", "string"].includes(typeof value)
        ? (value as Date | boolean | number | string)
        : String(value)
  };
}

function compactPdfRows(rows: Array<ContractPdfAppendixRow | null>) {
  return rows.filter((row): row is ContractPdfAppendixRow => Boolean(row));
}

function parseSnapshotDate(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function appendPdfArtifact(snapshot: Prisma.JsonValue, artifact: ContractPdfArtifactWriteResult) {
  return jsonValue({
    ...(asRecord(snapshot) ?? {}),
    generatedPdfArtifact: {
      bucket: artifact.bucket,
      diagnostics: artifact.diagnostics,
      fileId: artifact.fileId,
      mimeType: artifact.mimeType,
      objectKey: artifact.objectKey,
      originalName: artifact.originalName,
      sizeBytes: artifact.sizeBytes
    }
  });
}

function assertPermission(actor: RequestUser, permission: PermissionCode) {
  if (!actor.permissions.includes(permission)) {
    throw new SubscriptionChangeError(
      "SUBSCRIPTION_CHANGE_PERMISSION_DENIED",
      "The actor is not allowed to perform this subscription-change action.",
      HttpStatus.FORBIDDEN
    );
  }
}

async function lockChange(tx: Prisma.TransactionClient, id: string) {
  if (typeof tx.$queryRaw !== "function") return;
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "subscription_change_order"
    WHERE "id" = ${id}::uuid
    FOR UPDATE
  `);
}

function appendEstimate(snapshot: Prisma.JsonValue, estimate: EarlyTerminationEstimate) {
  const source = asRecord(snapshot) ?? {};
  const history = Array.isArray(source.estimates) ? source.estimates : [];
  return jsonValue({ ...source, currentEstimate: estimate, estimates: [...history, estimate] });
}

function appendDecision(snapshot: Prisma.JsonValue, decision: Record<string, unknown>) {
  const source = asRecord(snapshot) ?? {};
  const history = Array.isArray(source.customerDecisions) ? source.customerDecisions : [];
  return jsonValue({
    ...source,
    customerDecisions: [...history, decision],
    latestCustomerDecision: decision
  });
}

function persistedEstimate(detail: ReturnType<typeof requireDetail>) {
  const value = asRecord(detail.reasonSnapshot)?.currentEstimate;
  const estimate = asRecord(value);
  return estimate && estimate.revision === detail.estimatedSettlementRevision
    ? (estimate as EarlyTerminationEstimate)
    : null;
}

function estimateEvidence(detail: ReturnType<typeof requireDetail>) {
  const snapshot = asRecord(detail.reasonSnapshot);
  const estimate = asRecord(snapshot?.currentEstimate);
  return [
    {
      reference: `change:${detail.changeOrderId}:estimate:${detail.estimatedSettlementRevision}`,
      type: "EARLY_TERMINATION_ESTIMATE"
    },
    ...(estimate
      ? [
          {
            reference: `contract:${String(estimate.contractId ?? "unknown")}`,
            type: "CONTRACT_BASIS"
          }
        ]
      : [])
  ];
}

function terminationReason(snapshot: Prisma.JsonValue) {
  const reason = asRecord(snapshot)?.reason;
  if (typeof reason !== "string" || !reason.trim()) {
    throw conflict(
      "EARLY_TERMINATION_REASON_MISSING",
      "The immutable early-termination reason is missing."
    );
  }
  return reason.trim();
}

function explicitTerminationCharge(snapshot: Prisma.JsonValue) {
  const candidates = collectRecords(snapshot);
  for (const record of candidates) {
    for (const key of [
      "earlyTerminationFeeAmount",
      "earlyTerminationChargeAmount",
      "terminationFeeAmount"
    ]) {
      const value = record[key];
      if (
        (typeof value === "string" && /^\d+$/.test(value)) ||
        (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      ) {
        return BigInt(value);
      }
    }
  }
  return 0n;
}

function collectRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  const record = asRecord(value);
  if (!record || depth > 4) return [];
  return [record, ...Object.values(record).flatMap((item) => collectRecords(item, depth + 1))];
}

function shanghaiStartOfBusinessDate(value: Date) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) - 8 * 3_600_000
  );
}

function changeSnapshot(
  change: Pick<EarlyTerminationChange, "contractId" | "id" | "status" | "version">
) {
  return {
    contractId: change.contractId,
    id: change.id,
    status: change.status,
    version: change.version
  };
}

function earlyTerminationCommandKey(
  changeOrderId: string,
  operation: "agreement" | "cancel" | "closure" | "execute"
) {
  return `early-termination-change:${changeOrderId}:${operation}`;
}

function automationActor(actorId: string): RequestUser {
  return {
    id: actorId,
    menus: [],
    name: "Subscription change automation",
    permissions: [PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE],
    roles: ["SYSTEM_AUTOMATION"],
    username: "subscription-change-worker"
  };
}

type ExecutedEarlyTerminationResult = Awaited<
  ReturnType<SubscriptionClosureService["executeEarlyTermination"]>
>;

function asEarlyTerminationExecutionError(error: unknown): never {
  if (error instanceof SubscriptionChangeError) throw error;
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const body = asRecord(response);
    throw new SubscriptionChangeError(
      typeof body?.code === "string" ? body.code : "EARLY_TERMINATION_CLOSURE_EXECUTION_FAILED",
      typeof body?.message === "string"
        ? body.message
        : "Closure could not execute the scheduled early termination.",
      error.getStatus()
    );
  }
  throw error;
}

function conflict(code: string, message: string) {
  return new SubscriptionChangeError(code, message, HttpStatus.CONFLICT);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))
  ) as Prisma.InputJsonValue;
}

function sum(values: readonly bigint[]) {
  return values.reduce((total, value) => total + value, 0n);
}

function minBigInt(left: bigint, right: bigint) {
  return left < right ? left : right;
}

const readCommitted = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;
