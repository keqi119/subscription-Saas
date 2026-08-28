import { HttpStatus, Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditAction,
  BusinessType,
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  ESignTaskStatus,
  Prisma,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { createHash } from "node:crypto";

import { AuditService } from "../audit/audit.service";
import type { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo } from "../common/business-number";
import { ContractPdfArtifactWriterService } from "../contract/contract-pdf-artifact-writer.service";
import type { ContractPdfArtifactWriteResult } from "../contract/contract-pdf-artifact.types";
import {
  type ContractPdfAppendixRow,
  type ContractPdfRenderModel,
  createStage1ContractPdfSigningSlots
} from "../contract/contract-pdf-render-model";
import { PrismaService } from "../prisma/prisma.service";
import {
  isSubscriptionChangeTypeEnabled,
  SUBSCRIPTION_CHANGE_CONFIG,
  SubscriptionChangeConfig
} from "./subscription-change.config";
import { SubscriptionChangeError } from "./subscription-change.errors";

const managedOtherInclude = Prisma.validator<Prisma.SubscriptionChangeOrderInclude>()({
  managedOtherDetail: {
    include: {
      supplementContract: {
        include: {
          esignTasks: {
            orderBy: [{ completedAt: "desc" }, { id: "desc" }],
            take: 1,
            where: { taskStatus: ESignTaskStatus.COMPLETED }
          }
        }
      }
    }
  },
  order: { include: { contract: true } }
});

type ManagedOtherChange = Prisma.SubscriptionChangeOrderGetPayload<{
  include: typeof managedOtherInclude;
}>;

type ManagedOtherOperationRule = Readonly<{
  operation: ManagedOtherOperation;
  requiresSignedSupplement: boolean;
}>;

export const MANAGED_OTHER_OPERATION = Object.freeze({
  RECORD_CONTRACT_CLARIFICATION: "RECORD_CONTRACT_CLARIFICATION",
  RECORD_SERVICE_ACCOMMODATION: "RECORD_SERVICE_ACCOMMODATION",
  UPDATE_CONTACT_PREFERENCE: "UPDATE_CONTACT_PREFERENCE"
} as const);

export type ManagedOtherOperation =
  (typeof MANAGED_OTHER_OPERATION)[keyof typeof MANAGED_OTHER_OPERATION];

const OPERATION_RULES: Readonly<Record<ManagedOtherOperation, ManagedOtherOperationRule>> =
  Object.freeze({
    [MANAGED_OTHER_OPERATION.RECORD_CONTRACT_CLARIFICATION]: Object.freeze({
      operation: MANAGED_OTHER_OPERATION.RECORD_CONTRACT_CLARIFICATION,
      requiresSignedSupplement: true
    }),
    [MANAGED_OTHER_OPERATION.RECORD_SERVICE_ACCOMMODATION]: Object.freeze({
      operation: MANAGED_OTHER_OPERATION.RECORD_SERVICE_ACCOMMODATION,
      requiresSignedSupplement: true
    }),
    [MANAGED_OTHER_OPERATION.UPDATE_CONTACT_PREFERENCE]: Object.freeze({
      operation: MANAGED_OTHER_OPERATION.UPDATE_CONTACT_PREFERENCE,
      requiresSignedSupplement: false
    })
  });

const DEDICATED_OPERATION_PATTERN =
  /(EXTEND|EXTENSION|TERM_|TERM$|DURATION|VEHICLE|SWAP|TERMINAT|PRICE|MONTHLY_FEE|HISTORICAL_BILL|CONTRACT_SEGMENT)/i;
const APPROVE_OPERATION = "APPROVE_MANAGED_OTHER";
const EXECUTE_OPERATION = "EXECUTE_MANAGED_OTHER";
const GENERATE_CONTRACT_OPERATION = "GENERATE_MANAGED_OTHER_CONTRACT";
const START_ESIGN_OPERATION = "START_MANAGED_OTHER_ESIGN";
const CONTRACT_PDF_CJK_FONT_PATH_ENV = "CONTRACT_PDF_CJK_FONT_PATH";

type ManagedOtherContractReservation = Readonly<{
  change: ManagedOtherChange;
  commandId: string;
  contract: { contractNo: string; id: string; status: ContractStatus };
  generatedAt: Date;
  template: {
    contentTemplate: string;
    templateName: string;
    versionNo: string;
  };
}>;

export interface ManagedOtherRequestInput {
  beforeSnapshot: unknown;
  evidence: unknown;
  operation: unknown;
  operationPayload: unknown;
}

export type NormalizedManagedOtherRequest = Readonly<{
  beforeSnapshot: Prisma.InputJsonObject;
  evidence: readonly Prisma.InputJsonObject[];
  operation: ManagedOtherOperation;
  operationPayload: Prisma.InputJsonObject;
  requiresSignedSupplement: boolean;
}>;

export function normalizeManagedOtherRequest(
  input: ManagedOtherRequestInput
): NormalizedManagedOtherRequest {
  const operation = typeof input.operation === "string" ? input.operation.trim() : "";
  if (!operation) throw badRequest("MANAGED_OTHER_OPERATION_REQUIRED", "Operation is required.");
  if (DEDICATED_OPERATION_PATTERN.test(operation)) {
    throw conflict(
      "MANAGED_OTHER_DEDICATED_CHANGE_REQUIRED",
      "Term, vehicle, termination, price, historical-bill, and contract-segment changes must use their dedicated workflow."
    );
  }
  const rule = OPERATION_RULES[operation as ManagedOtherOperation];
  if (!rule) {
    throw badRequest(
      "MANAGED_OTHER_OPERATION_NOT_ALLOWED",
      "The requested managed-other operation is not in the Stage 1 allowlist."
    );
  }
  const beforeSnapshot = requireNonEmptyRecord(
    input.beforeSnapshot,
    "MANAGED_OTHER_BEFORE_SNAPSHOT_REQUIRED",
    "A non-empty before snapshot is required."
  );
  const operationPayload = normalizeOperationPayload(rule.operation, input.operationPayload);
  const evidence = normalizeEvidence(input.evidence);
  return Object.freeze({
    beforeSnapshot: jsonObject(beforeSnapshot),
    evidence: Object.freeze(evidence.map((item) => jsonObject(item))),
    operation: rule.operation,
    operationPayload: jsonObject(operationPayload),
    requiresSignedSupplement: rule.requiresSignedSupplement
  });
}

export interface ApproveManagedOtherInput {
  approvalReason: string;
  approvalReference: string;
  idempotencyKey?: string;
  supplementContractId?: string;
  version: number;
}

export interface ExecuteManagedOtherInput {
  executionNote: string;
  idempotencyKey?: string;
  version: number;
}

@Injectable()
export class SubscriptionManagedOtherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(SUBSCRIPTION_CHANGE_CONFIG)
    private readonly config: SubscriptionChangeConfig,
    @Optional() private readonly artifactWriter?: ContractPdfArtifactWriterService,
    @Optional() private readonly configService?: ConfigService
  ) {}

  async approve(
    changeOrderId: string,
    input: ApproveManagedOtherInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_APPROVE);
    assertCommand(input);
    const approvalReference = requireText(
      input.approvalReference,
      "MANAGED_OTHER_APPROVAL_REFERENCE_REQUIRED",
      "Approval reference is required."
    );
    const approvalReason = requireText(
      input.approvalReason,
      "MANAGED_OTHER_APPROVAL_REASON_REQUIRED",
      "Approval reason is required."
    );
    const requestHash = commandHash({
      approvalReason,
      approvalReference,
      changeOrderId,
      supplementContractId: input.supplementContractId ?? null,
      version: input.version
    });
    const replay = await this.replay(
      APPROVE_OPERATION,
      input.idempotencyKey!,
      actor.id,
      requestHash
    );
    if (replay) return replay;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockChange(tx, changeOrderId);
        const change = await findManagedOtherChange(tx, changeOrderId);
        assertVersion(change, input.version);
        if (change.status !== SubscriptionChangeStatus.DRAFT) {
          throw conflict(
            "MANAGED_OTHER_APPROVAL_NOT_ALLOWED",
            "Only a draft managed-other change can be approved."
          );
        }
        const detail = requireDetail(change);
        if (detail.afterSnapshot !== null) {
          throw conflict(
            "MANAGED_OTHER_EXECUTION_ALREADY_RECORDED",
            "The managed-other execution result is already immutable."
          );
        }
        const request = requestFromSnapshot(detail.approvedOperationSnapshot);
        const normalized = normalizeManagedOtherRequest({
          beforeSnapshot: detail.beforeSnapshot,
          evidence: detail.evidenceSnapshot,
          operation: request.operation,
          operationPayload: request.operationPayload
        });
        if (input.supplementContractId) {
          throw badRequest(
            "MANAGED_OTHER_MANUAL_SUPPLEMENT_FORBIDDEN",
            "Managed-other supplements are generated and bound by this workflow; a manual contract ID is not accepted."
          );
        }
        const command = await tx.subscriptionChangeCommand.create({
          data: {
            actorId: actor.id,
            idempotencyKey: input.idempotencyKey!,
            operation: APPROVE_OPERATION,
            requestHash
          }
        });
        const approvedAt = this.config.now();
        const approvedOperationSnapshot = jsonValue({
          approval: {
            approvalReason,
            approvalReference,
            approvedAt: approvedAt.toISOString(),
            approvedBy: actor.id,
            beforeSnapshotHash: commandHash(normalized.beforeSnapshot),
            evidenceSnapshotHash: commandHash(normalized.evidence),
            requiresSignedSupplement: normalized.requiresSignedSupplement,
            supplementContractId: null
          },
          request: {
            operation: normalized.operation,
            operationPayload: normalized.operationPayload
          }
        });
        await tx.subscriptionManagedOtherChangeDetail.update({
          data: {
            approvedOperationSnapshot,
            supplementContractId: null
          },
          where: { id: detail.id }
        });
        const updated = await tx.subscriptionChangeOrder.update({
          data: {
            contractId: null,
            status: normalized.requiresSignedSupplement
              ? SubscriptionChangeStatus.CUSTOMER_CONFIRMED
              : SubscriptionChangeStatus.SCHEDULED,
            updatedBy: actor.id,
            version: { increment: 1 }
          },
          include: managedOtherInclude,
          where: { id: change.id }
        });
        await this.audit.write(
          auditInput(AuditAction.APPROVE, change, updated, actor, context),
          tx
        );
        await completeCommand(tx, command.id, change.id, approvedAt);
        return updated;
      }, readCommitted);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const duplicate = await this.replay(
        APPROVE_OPERATION,
        input.idempotencyKey!,
        actor.id,
        requestHash
      );
      if (duplicate) return duplicate;
      throw error;
    }
  }

  async generate(
    changeOrderId: string,
    input: { idempotencyKey?: string; version: number },
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.CONTRACT_GENERATE);
    assertCommand(input);
    const requestHash = commandHash({ changeOrderId, version: input.version });
    const replay = await findContractCommandReplay(
      this.prisma,
      actor.id,
      GENERATE_CONTRACT_OPERATION,
      input.idempotencyKey!,
      requestHash
    );
    if (replay) return replay;
    const reservation = await this.reserveContract(changeOrderId, input, actor, requestHash);
    if ("replay" in reservation) return reservation.replay;
    let artifact: ContractPdfArtifactWriteResult;
    try {
      if (!this.artifactWriter) {
        throw conflict(
          "MANAGED_OTHER_PDF_WRITER_REQUIRED",
          "The managed-other PDF artifact writer is not configured."
        );
      }
      artifact = await this.artifactWriter.writeGeneratedContractPdfArtifact({
        cjkFontPath: this.configService?.get<string>(CONTRACT_PDF_CJK_FONT_PATH_ENV),
        contractStatus: reservation.contract.status,
        existingContractFileId: null,
        recoverExistingObject: true,
        renderModel: buildManagedOtherPdfRenderModel(reservation),
        uploadedBy: actor.id
      });
    } catch (error) {
      await this.abortContractReservation(
        changeOrderId,
        reservation.commandId,
        reservation.contract.id,
        actor.id
      );
      throw error;
    }
    return this.finalizeContract(reservation, artifact, input, actor, context);
  }

  async startOrRetryESign<T extends { id: string }>(
    changeOrderId: string,
    input: { idempotencyKey?: string; version: number },
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
        "MANAGED_OTHER_ESIGN_PROVIDER_REQUIRED",
        "The configured electronic-signature provider is required."
      );
    }
    const requestHash = commandHash({ changeOrderId, version: input.version });
    const existing = await this.prisma.subscriptionChangeCommand.findUnique({
      where: {
        actorId_operation_idempotencyKey: {
          actorId: actor.id,
          idempotencyKey: input.idempotencyKey!,
          operation: START_ESIGN_OPERATION
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
          operation: START_ESIGN_OPERATION,
          requestHash
        }
      });
      await lockChange(tx, changeOrderId);
      const change = await findManagedOtherChange(tx, changeOrderId);
      assertVersion(change, input.version);
      const detail = requireDetail(change);
      if (
        change.status !== SubscriptionChangeStatus.SIGNING_OR_PAYMENT ||
        !change.contractId ||
        detail.supplementContractId !== change.contractId ||
        !detail.supplementContract?.fileId ||
        detail.supplementContract.status === ContractStatus.CANCELLED
      ) {
        throw conflict(
          "MANAGED_OTHER_ESIGN_NOT_ALLOWED",
          "The managed-other supplement is not ready for electronic signature."
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
    input: ExecuteManagedOtherInput,
    actor: RequestUser,
    context: RequestContext
  ) {
    this.assertWriteEnabled();
    assertPermission(actor, PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE);
    assertCommand(input);
    const executionNote = requireText(
      input.executionNote,
      "MANAGED_OTHER_EXECUTION_NOTE_REQUIRED",
      "Execution note is required."
    );
    const requestHash = commandHash({
      changeOrderId,
      executionNote,
      version: input.version
    });
    const replay = await this.replay(
      EXECUTE_OPERATION,
      input.idempotencyKey!,
      actor.id,
      requestHash
    );
    if (replay) return replay;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockChange(tx, changeOrderId);
        const change = await findManagedOtherChange(tx, changeOrderId);
        assertVersion(change, input.version);
        if (change.status !== SubscriptionChangeStatus.SCHEDULED) {
          throw conflict(
            "MANAGED_OTHER_EXECUTION_NOT_ALLOWED",
            "Only an approved scheduled managed-other change can execute."
          );
        }
        const detail = requireDetail(change);
        if (detail.afterSnapshot !== null) {
          throw conflict(
            "MANAGED_OTHER_EXECUTION_ALREADY_RECORDED",
            "The managed-other execution result is already immutable."
          );
        }
        if (
          this.config.now().getTime() < shanghaiStartOfBusinessDate(detail.effectiveDate).getTime()
        ) {
          throw conflict(
            "MANAGED_OTHER_EFFECTIVE_TIME_NOT_REACHED",
            "The approved managed-other effective time has not been reached."
          );
        }
        const approved = approvedOperation(detail.approvedOperationSnapshot);
        const normalized = normalizeManagedOtherRequest({
          beforeSnapshot: detail.beforeSnapshot,
          evidence: detail.evidenceSnapshot,
          operation: approved.request.operation,
          operationPayload: approved.request.operationPayload
        });
        if (
          approved.approval.beforeSnapshotHash !== commandHash(normalized.beforeSnapshot) ||
          approved.approval.evidenceSnapshotHash !== commandHash(normalized.evidence)
        ) {
          throw conflict(
            "MANAGED_OTHER_APPROVED_FACT_DRIFT",
            "The approved before/evidence facts no longer match the immutable request."
          );
        }
        if (normalized.requiresSignedSupplement) assertLinkedSignedSupplement(change);
        const command = await tx.subscriptionChangeCommand.create({
          data: {
            actorId: actor.id,
            idempotencyKey: input.idempotencyKey!,
            operation: EXECUTE_OPERATION,
            requestHash
          }
        });
        const executedAt = this.config.now();
        const afterSnapshot = jsonValue({
          approvalReference: approved.approval.approvalReference,
          beforeSnapshotHash: approved.approval.beforeSnapshotHash,
          evidenceSnapshotHash: approved.approval.evidenceSnapshotHash,
          executedAt: executedAt.toISOString(),
          executedBy: actor.id,
          executionMode: "IMMUTABLE_FACT_ONLY",
          executionNote,
          operation: normalized.operation,
          operationResult: normalized.operationPayload,
          supplementContractId: detail.supplementContractId
        });
        await tx.subscriptionManagedOtherChangeDetail.update({
          data: { afterSnapshot },
          where: { id: detail.id }
        });
        const updated = await tx.subscriptionChangeOrder.update({
          data: {
            status: SubscriptionChangeStatus.COMPLETED,
            updatedBy: actor.id,
            version: { increment: 1 }
          },
          include: managedOtherInclude,
          where: { id: change.id }
        });
        await this.audit.write(auditInput(AuditAction.UPDATE, change, updated, actor, context), tx);
        await completeCommand(tx, command.id, change.id, executedAt);
        return updated;
      }, readCommitted);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const duplicate = await this.replay(
        EXECUTE_OPERATION,
        input.idempotencyKey!,
        actor.id,
        requestHash
      );
      if (duplicate) return duplicate;
      throw error;
    }
  }

  private async replay(operation: string, idempotencyKey: string, actorId: string, hash: string) {
    const command = await this.prisma.subscriptionChangeCommand.findUnique({
      where: {
        actorId_operation_idempotencyKey: { actorId, idempotencyKey, operation }
      }
    });
    if (!command) return null;
    if (command.requestHash !== hash) {
      throw conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "The idempotency key was already used with a different managed-other command."
      );
    }
    if (command.resourceType !== "CHANGE" || !command.resourceId || !command.completedAt) {
      throw conflict(
        "IDEMPOTENCY_COMMAND_IN_PROGRESS",
        "The idempotent managed-other command has not completed."
      );
    }
    return findManagedOtherChange(this.prisma, command.resourceId);
  }

  private reserveContract(
    changeOrderId: string,
    input: { idempotencyKey?: string; version: number },
    actor: RequestUser,
    requestHash: string
  ): Promise<
    ManagedOtherContractReservation | { replay: Awaited<ReturnType<typeof findContractById>> }
  > {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.subscriptionChangeCommand.findUnique({
        where: {
          actorId_operation_idempotencyKey: {
            actorId: actor.id,
            idempotencyKey: input.idempotencyKey!,
            operation: GENERATE_CONTRACT_OPERATION
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
          const change = await findManagedOtherChange(tx, changeOrderId);
          assertVersion(change, input.version);
          const detail = requireDetail(change);
          if (
            change.status !== SubscriptionChangeStatus.CUSTOMER_CONFIRMED ||
            change.contractId !== existing.resourceId ||
            detail.supplementContractId !== existing.resourceId
          ) {
            throw conflict(
              "MANAGED_OTHER_CONTRACT_LINK_CONFLICT",
              "The recoverable managed-other supplement is no longer linked."
            );
          }
          const contract = await findContractById(tx, existing.resourceId);
          if (contract.status !== ContractStatus.GENERATED || contract.fileId) {
            throw conflict(
              "MANAGED_OTHER_CONTRACT_RECOVERY_CONFLICT",
              "The recoverable managed-other supplement is no longer awaiting PDF finalization."
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
              "MANAGED_OTHER_CONTRACT_RECOVERY_FACTS_MISSING",
              "The recoverable managed-other supplement is missing immutable render facts."
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
          operation: GENERATE_CONTRACT_OPERATION,
          requestHash
        }
      });
      await lockChange(tx, changeOrderId);
      const change = await findManagedOtherChange(tx, changeOrderId);
      assertVersion(change, input.version);
      const detail = requireDetail(change);
      const approved = approvedOperation(detail.approvedOperationSnapshot);
      if (
        change.status !== SubscriptionChangeStatus.CUSTOMER_CONFIRMED ||
        !approved.approval.requiresSignedSupplement ||
        detail.supplementContractId ||
        change.contractId
      ) {
        throw conflict(
          "MANAGED_OTHER_CONTRACT_NOT_ALLOWED",
          "Only an approved customer-rights change without an existing supplement can generate a contract."
        );
      }
      const baseContract = change.order.contract;
      if (!baseContract || baseContract.status !== ContractStatus.SIGNED) {
        throw conflict(
          "MANAGED_OTHER_SOURCE_CONTRACT_REQUIRED",
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
          "MANAGED_OTHER_TEMPLATE_NOT_FOUND",
          "No active subscription supplement template is available."
        );
      }
      const contract = await tx.contract.create({
        data: {
          businessType: BusinessType.SUBSCRIPTION,
          contractNo: createBusinessNo("CON"),
          contractSnapshot: jsonValue({
            approvedOperationSnapshot: detail.approvedOperationSnapshot,
            authority: "CUSTOMER_PROVIDER_ESIGN",
            beforeSnapshot: detail.beforeSnapshot,
            changeOrderId: change.id,
            evidenceSnapshot: detail.evidenceSnapshot,
            generatedAt: generatedAt.toISOString(),
            sourceContractId: baseContract.id,
            sourceContractNo: baseContract.contractNo,
            template: {
              id: template.id,
              name: template.templateName,
              type: template.templateType,
              version: template.versionNo
            }
          }),
          contractTitle: `合同变更补充协议 ${change.changeNo}`,
          contractVersionId: template.id,
          createdBy: actor.id,
          customerId: change.order.customerId,
          orderId: change.orderId,
          status: ContractStatus.GENERATED,
          updatedBy: actor.id
        }
      });
      await tx.subscriptionManagedOtherChangeDetail.update({
        data: { supplementContractId: contract.id },
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

  private finalizeContract(
    reservation: ManagedOtherContractReservation,
    artifact: ContractPdfArtifactWriteResult,
    input: { idempotencyKey?: string; version: number },
    actor: RequestUser,
    context: RequestContext
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockChange(tx, reservation.change.id);
      const change = await findManagedOtherChange(tx, reservation.change.id);
      assertVersion(change, input.version);
      const detail = requireDetail(change);
      if (
        change.status !== SubscriptionChangeStatus.CUSTOMER_CONFIRMED ||
        change.contractId !== reservation.contract.id ||
        detail.supplementContractId !== reservation.contract.id
      ) {
        throw conflict(
          "MANAGED_OTHER_CONTRACT_LINK_CONFLICT",
          "The managed-other supplement changed during rendering."
        );
      }
      const contract = await tx.contract.update({
        data: {
          contractSnapshot: appendPdfArtifact(
            detail.supplementContract?.contractSnapshot ?? {},
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
          "MANAGED_OTHER_CONTRACT_LINK_CONFLICT",
          "The rendered managed-other supplement could not be linked atomically."
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
      await this.audit.write(
        {
          action: AuditAction.CREATE,
          after: {
            changeOrderId: change.id,
            contractId: contract.id,
            status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT
          },
          entityId: contract.id,
          entityType: "subscription_managed_other_contract",
          ipAddress: context.ipAddress,
          module: "subscription_change",
          operatorId: actor.id,
          userAgent: context.userAgent
        },
        tx
      );
      return contract;
    }, readCommitted);
  }

  private abortContractReservation(
    changeOrderId: string,
    commandId: string,
    contractId: string,
    actorId: string
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.contract.updateMany({
        data: { status: ContractStatus.CANCELLED, updatedBy: actorId },
        where: { id: contractId, status: ContractStatus.GENERATED }
      });
      await tx.subscriptionManagedOtherChangeDetail.updateMany({
        data: { supplementContractId: null },
        where: { changeOrderId, supplementContractId: contractId }
      });
      await tx.subscriptionChangeOrder.updateMany({
        data: { contractId: null, updatedBy: actorId },
        where: { contractId, id: changeOrderId }
      });
      await tx.subscriptionChangeCommand.deleteMany({ where: { id: commandId } });
    }, readCommitted);
  }

  private assertWriteEnabled() {
    if (isSubscriptionChangeTypeEnabled(this.config, SubscriptionChangeType.MANAGED_OTHER)) return;
    throw new SubscriptionChangeError(
      "SUBSCRIPTION_MANAGED_OTHER_DISABLED",
      "Managed-other subscription changes are disabled.",
      HttpStatus.SERVICE_UNAVAILABLE
    );
  }
}

async function findManagedOtherChange(
  tx: Prisma.TransactionClient | PrismaService,
  changeOrderId: string
) {
  const change = await tx.subscriptionChangeOrder.findUnique({
    include: managedOtherInclude,
    where: { id: changeOrderId }
  });
  if (!change || change.changeType !== SubscriptionChangeType.MANAGED_OTHER) {
    throw new SubscriptionChangeError(
      "MANAGED_OTHER_CHANGE_NOT_FOUND",
      "The managed-other subscription change was not found.",
      HttpStatus.NOT_FOUND
    );
  }
  return change;
}

function requireDetail(change: ManagedOtherChange) {
  if (!change.managedOtherDetail) {
    throw conflict("MANAGED_OTHER_DETAIL_MISSING", "The managed-other detail is missing.");
  }
  return change.managedOtherDetail;
}

function assertLinkedSignedSupplement(change: ManagedOtherChange) {
  const detail = requireDetail(change);
  const contract = detail.supplementContract;
  if (
    !contract ||
    contract.id !== detail.supplementContractId ||
    change.contractId !== detail.supplementContractId ||
    contract.status !== ContractStatus.ARCHIVED ||
    !contract.fileId ||
    !contract.signedAt ||
    !contract.archivedAt ||
    contract.esignTasks.length !== 1 ||
    !contract.esignTasks[0]?.signedDocumentObjectKey
  ) {
    throw conflict(
      "MANAGED_OTHER_SIGNED_SUPPLEMENT_REQUIRED",
      "The approved customer-rights supplement is no longer a signed archived fact."
    );
  }
  const signedSnapshot = asRecord(contract.contractSnapshot);
  if (
    signedSnapshot?.changeOrderId !== change.id ||
    commandHash(signedSnapshot.approvedOperationSnapshot) !==
      commandHash(detail.approvedOperationSnapshot) ||
    commandHash(signedSnapshot.beforeSnapshot) !== commandHash(detail.beforeSnapshot) ||
    commandHash(signedSnapshot.evidenceSnapshot) !== commandHash(detail.evidenceSnapshot)
  ) {
    throw conflict(
      "MANAGED_OTHER_SIGNED_FACT_DRIFT",
      "The signed managed-other supplement no longer matches the approved immutable facts."
    );
  }
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

function buildManagedOtherPdfRenderModel(
  reservation: ManagedOtherContractReservation
): ContractPdfRenderModel {
  const detail = requireDetail(reservation.change);
  const approved = approvedOperation(detail.approvedOperationSnapshot);
  return {
    agreementKind: "SUBSCRIPTION_STANDARD",
    appendix: {
      sections: [
        {
          title: "Approved contract change",
          rows: compactPdfRows([
            pdfRow("Change order no.", reservation.change.changeNo),
            pdfRow("Source contract no.", reservation.change.order.contract?.contractNo),
            pdfRow("Effective date", detail.effectiveDate),
            pdfRow("Operation", approved.request.operation),
            pdfRow("Description", asRecord(approved.request.operationPayload)?.description),
            pdfRow("Approval reference", approved.approval.approvalReference)
          ])
        },
        {
          title: "Immutable evidence",
          rows: compactPdfRows([
            pdfRow("Before snapshot hash", approved.approval.beforeSnapshotHash),
            pdfRow("Evidence snapshot hash", approved.approval.evidenceSnapshotHash),
            pdfRow(
              "Evidence count",
              Array.isArray(detail.evidenceSnapshot) ? detail.evidenceSnapshot.length : 0
            )
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

function requestFromSnapshot(snapshot: Prisma.JsonValue) {
  const root = asRecord(snapshot);
  const request = asRecord(root?.request);
  const operation = request?.operation;
  const operationPayload = request?.operationPayload;
  if (typeof operation !== "string" || !asRecord(operationPayload)) {
    throw conflict(
      "MANAGED_OTHER_REQUEST_SNAPSHOT_INVALID",
      "The immutable managed-other request snapshot is invalid."
    );
  }
  return { operation, operationPayload };
}

function approvedOperation(snapshot: Prisma.JsonValue) {
  const root = asRecord(snapshot);
  const request = requestFromSnapshot(snapshot);
  const approval = asRecord(root?.approval);
  if (
    !approval ||
    typeof approval.approvedBy !== "string" ||
    typeof approval.approvalReference !== "string" ||
    typeof approval.beforeSnapshotHash !== "string" ||
    typeof approval.evidenceSnapshotHash !== "string" ||
    typeof approval.requiresSignedSupplement !== "boolean"
  ) {
    throw conflict(
      "MANAGED_OTHER_APPROVAL_SNAPSHOT_INVALID",
      "The immutable managed-other approval snapshot is invalid."
    );
  }
  return {
    approval: {
      approvalReference: approval.approvalReference,
      beforeSnapshotHash: approval.beforeSnapshotHash,
      evidenceSnapshotHash: approval.evidenceSnapshotHash,
      requiresSignedSupplement: approval.requiresSignedSupplement,
      supplementContractId:
        typeof approval.supplementContractId === "string" ? approval.supplementContractId : null
    },
    request
  };
}

function normalizeOperationPayload(operation: ManagedOtherOperation, value: unknown) {
  const payload = requireNonEmptyRecord(
    value,
    "MANAGED_OTHER_OPERATION_PAYLOAD_REQUIRED",
    "A non-empty operation payload is required."
  );
  if (operation === MANAGED_OTHER_OPERATION.UPDATE_CONTACT_PREFERENCE) {
    const preferredChannel = payload.preferredChannel;
    if (!new Set(["PHONE", "SMS", "WECHAT"]).has(String(preferredChannel))) {
      throw badRequest(
        "MANAGED_OTHER_CONTACT_CHANNEL_INVALID",
        "preferredChannel must be PHONE, SMS, or WECHAT."
      );
    }
    assertOnlyKeys(payload, ["contactWindow", "preferredChannel"]);
    if (
      payload.contactWindow !== undefined &&
      (typeof payload.contactWindow !== "string" || !payload.contactWindow.trim())
    ) {
      throw badRequest(
        "MANAGED_OTHER_CONTACT_WINDOW_INVALID",
        "contactWindow must be a non-empty string when supplied."
      );
    }
    return {
      ...(typeof payload.contactWindow === "string"
        ? { contactWindow: payload.contactWindow.trim() }
        : {}),
      preferredChannel: String(preferredChannel)
    };
  }
  assertOnlyKeys(payload, ["description"]);
  if (typeof payload.description !== "string" || !payload.description.trim()) {
    throw badRequest(
      "MANAGED_OTHER_DESCRIPTION_REQUIRED",
      "A non-empty approved description is required."
    );
  }
  return { description: payload.description.trim() };
}

function normalizeEvidence(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest(
      "MANAGED_OTHER_EVIDENCE_REQUIRED",
      "At least one evidence reference is required."
    );
  }
  return value.map((item) => {
    const record = asRecord(item);
    if (
      !record ||
      ![record.fileId, record.reference].some(
        (candidate) => typeof candidate === "string" && candidate.trim()
      )
    ) {
      throw badRequest(
        "MANAGED_OTHER_EVIDENCE_INVALID",
        "Each evidence item requires a non-empty fileId or reference."
      );
    }
    return record;
  });
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]) {
  const rejected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (rejected.length > 0) {
    throw badRequest(
      "MANAGED_OTHER_OPERATION_PAYLOAD_INVALID",
      `Unsupported operation payload fields: ${rejected.sort().join(", ")}.`
    );
  }
}

function requireNonEmptyRecord(value: unknown, code: string, message: string) {
  const record = asRecord(value);
  if (!record || Object.keys(record).length === 0) throw badRequest(code, message);
  return record;
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

function assertCommand(input: { idempotencyKey?: string; version: number }) {
  if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 128) {
    throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header is required.");
  }
  if (!Number.isInteger(input.version) || input.version < 0) {
    throw badRequest("VERSION_INVALID", "A non-negative version is required.");
  }
}

function assertVersion(change: Pick<ManagedOtherChange, "version">, expected: number) {
  if (change.version !== expected) {
    throw conflict("VERSION_CONFLICT", "The subscription change was updated by another request.");
  }
}

function requireText(value: string, code: string, message: string) {
  if (typeof value !== "string" || !value.trim()) throw badRequest(code, message);
  return value.trim();
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

async function completeCommand(
  tx: Prisma.TransactionClient,
  id: string,
  resourceId: string,
  completedAt: Date
) {
  await tx.subscriptionChangeCommand.update({
    data: { completedAt, resourceId, resourceType: "CHANGE" },
    where: { id }
  });
}

function auditInput(
  action: AuditAction,
  before: ManagedOtherChange,
  after: ManagedOtherChange,
  actor: RequestUser,
  context: RequestContext
) {
  return {
    action,
    after: changeSnapshot(after),
    before: changeSnapshot(before),
    entityId: before.id,
    entityType: "subscription_managed_other_change",
    ipAddress: context.ipAddress,
    module: "subscription_change",
    operatorId: actor.id,
    userAgent: context.userAgent
  };
}

function changeSnapshot(change: ManagedOtherChange) {
  return {
    afterSnapshot: change.managedOtherDetail?.afterSnapshot ?? null,
    approvedOperationSnapshot: change.managedOtherDetail?.approvedOperationSnapshot ?? null,
    contractId: change.contractId,
    id: change.id,
    status: change.status,
    version: change.version
  };
}

function commandHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonical(record[key])])
  );
}

function shanghaiStartOfBusinessDate(value: Date) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) - 8 * 3_600_000
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonObject(value: unknown): Prisma.InputJsonObject {
  return jsonValue(value) as Prisma.InputJsonObject;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))
  ) as Prisma.InputJsonValue;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function badRequest(code: string, message: string) {
  return new SubscriptionChangeError(code, message, HttpStatus.BAD_REQUEST);
}

function conflict(code: string, message: string) {
  return new SubscriptionChangeError(code, message, HttpStatus.CONFLICT);
}

const readCommitted = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;
