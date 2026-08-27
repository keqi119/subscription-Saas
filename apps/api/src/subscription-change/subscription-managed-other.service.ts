import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  AuditAction,
  ContractStatus,
  ESignTaskStatus,
  Prisma,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { createHash } from "node:crypto";

import { AuditService } from "../audit/audit.service";
import type { RequestContext, RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { SUBSCRIPTION_CHANGE_CONFIG, SubscriptionChangeConfig } from "./subscription-change.config";
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
  order: { select: { contractId: true, customerId: true, id: true, orderNo: true } }
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
    private readonly config: SubscriptionChangeConfig
  ) {}

  async approve(
    changeOrderId: string,
    input: ApproveManagedOtherInput,
    actor: RequestUser,
    context: RequestContext
  ) {
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
        const supplement = normalized.requiresSignedSupplement
          ? await requireSignedSupplement(tx, change, input.supplementContractId)
          : null;
        if (!normalized.requiresSignedSupplement && input.supplementContractId) {
          throw badRequest(
            "MANAGED_OTHER_SUPPLEMENT_NOT_ALLOWED",
            "This record-only operation must not attach a customer-rights supplement."
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
            supplementContractId: supplement?.id ?? null
          },
          request: {
            operation: normalized.operation,
            operationPayload: normalized.operationPayload
          }
        });
        await tx.subscriptionManagedOtherChangeDetail.update({
          data: {
            approvedOperationSnapshot,
            supplementContractId: supplement?.id ?? null
          },
          where: { id: detail.id }
        });
        const updated = await tx.subscriptionChangeOrder.update({
          data: {
            contractId: supplement?.id ?? null,
            status: SubscriptionChangeStatus.SCHEDULED,
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

  async execute(
    changeOrderId: string,
    input: ExecuteManagedOtherInput,
    actor: RequestUser,
    context: RequestContext
  ) {
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
        if (this.config.now().getTime() < shanghaiStartOfBusinessDate(detail.effectiveDate).getTime()) {
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
        if (normalized.requiresSignedSupplement) assertLinkedSignedSupplement(change, approved);
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
          supplementContractId: approved.approval.supplementContractId
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
        await this.audit.write(
          auditInput(AuditAction.UPDATE, change, updated, actor, context),
          tx
        );
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

async function requireSignedSupplement(
  tx: Prisma.TransactionClient,
  change: ManagedOtherChange,
  supplementContractId: string | undefined
) {
  if (!supplementContractId || supplementContractId === change.order.contractId) {
    throw conflict(
      "MANAGED_OTHER_SIGNED_SUPPLEMENT_REQUIRED",
      "This approved operation requires a separate archived customer-signed supplement."
    );
  }
  const supplement = await tx.contract.findFirst({
    include: {
      esignTasks: {
        orderBy: [{ completedAt: "desc" }, { id: "desc" }],
        take: 1,
        where: {
          signedDocumentObjectKey: { not: null },
          taskStatus: ESignTaskStatus.COMPLETED
        }
      }
    },
    where: {
      archivedAt: { not: null },
      customerId: change.order.customerId,
      fileId: { not: null },
      id: supplementContractId,
      orderId: change.orderId,
      signedAt: { not: null },
      status: ContractStatus.ARCHIVED
    }
  });
  if (!supplement || supplement.esignTasks.length !== 1) {
    throw conflict(
      "MANAGED_OTHER_SIGNED_SUPPLEMENT_REQUIRED",
      "This approved operation requires a separate archived customer-signed supplement."
    );
  }
  return supplement;
}

function assertLinkedSignedSupplement(
  change: ManagedOtherChange,
  approved: ReturnType<typeof approvedOperation>
) {
  const contract = requireDetail(change).supplementContract;
  if (
    !contract ||
    contract.id !== approved.approval.supplementContractId ||
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
        typeof approval.supplementContractId === "string"
          ? approval.supplementContractId
          : null
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
  if (!input.idempotencyKey?.trim()) {
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
