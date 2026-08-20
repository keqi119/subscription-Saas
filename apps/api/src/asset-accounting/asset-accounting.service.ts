import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { AuditAction, Prisma } from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  canonicalAssetAccountingJson,
  hashBusinessExceptionSnapshot,
  isValidAssetAccountingSource,
  summarizeVehicleCostEntries
} from "./asset-accounting.domain";
import {
  AssetAccountingRepository,
  type AppendCostEntryCommand,
  type BusinessExceptionSubjectIdentity,
  type DecideExceptionApprovalCommand,
  type ExpireExceptionApprovalCommand,
  type RequestExceptionApprovalCommand,
  type RequireCurrentApprovedExceptionCommand,
  type ReverseCostEntryCommand
} from "./asset-accounting.repository";
import type {
  AssetAccountingSource,
  BusinessExceptionApprovalSnapshot,
  BusinessExceptionSnapshot,
  VehicleCostLedgerEntrySnapshot,
  VehicleCostLedgerSummary,
  VehicleCostSummaryBucket
} from "./asset-accounting.types";

export const ASSET_ACCOUNTING_PERMISSION = {
  COST_CONFIRM: "vehicle_cost_ledger:confirm",
  COST_REVERSE: "vehicle_cost_ledger:reverse",
  COST_VIEW: "vehicle_cost_ledger:view",
  EXCEPTION_APPROVE: "business_exception:approve",
  EXCEPTION_REQUEST: "business_exception:request"
} as const;

export const ASSET_ACCOUNTING_SERVICE_CODE = {
  AUTHENTICATION_REQUIRED: "ASSET_ACCOUNTING_AUTHENTICATION_REQUIRED",
  COST_ENTRY_NOT_FOUND: "ASSET_ACCOUNTING_COST_ENTRY_NOT_FOUND",
  IDEMPOTENCY_KEY_INVALID: "ASSET_ACCOUNTING_IDEMPOTENCY_KEY_INVALID",
  IDEMPOTENCY_KEY_MISMATCH: "ASSET_ACCOUNTING_IDEMPOTENCY_KEY_MISMATCH",
  INVALID_SOURCE: "ASSET_ACCOUNTING_INVALID_SOURCE",
  PERMISSION_REQUIRED: "ASSET_ACCOUNTING_PERMISSION_REQUIRED",
  SELF_APPROVAL_FORBIDDEN: "ASSET_ACCOUNTING_SELF_APPROVAL_FORBIDDEN",
  WORK_ORDER_COST_NOT_CONFIRMED: "ASSET_ACCOUNTING_WORK_ORDER_COST_NOT_CONFIRMED",
  WORK_ORDER_NOT_FOUND: "ASSET_ACCOUNTING_WORK_ORDER_NOT_FOUND"
} as const;

export interface AssetAccountingCommandContext {
  readonly actorId: string | null;
  readonly idempotencyKey?: string | readonly string[];
  readonly ipAddress?: string;
  readonly permissions: readonly string[];
  readonly requestId?: string;
  readonly userAgent?: string;
}

export type AppendCostServiceCommand = Omit<AppendCostEntryCommand, "actorId">;
export type ReverseCostServiceCommand = Omit<ReverseCostEntryCommand, "actorId">;
export type RequestApprovalServiceCommand = Omit<
  RequestExceptionApprovalCommand,
  "authoritySnapshot" | "requestedBy"
>;
export type DecideApprovalServiceCommand = Omit<
  DecideExceptionApprovalCommand,
  "authoritySnapshot" | "decidedBy"
>;
export type ExpireApprovalServiceCommand = Omit<ExpireExceptionApprovalCommand, "expiredBy">;
export type RequireApprovedExceptionServiceCommand = Omit<
  RequireCurrentApprovedExceptionCommand,
  "authoritySnapshot" | "expiredBy"
>;

export type BusinessExceptionAuthorityResolver = (
  tx: Prisma.TransactionClient
) => Promise<BusinessExceptionSnapshot>;

export type JsonSafeAssetAccountingValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonSafeAssetAccountingValue[]
  | Readonly<{ [key: string]: JsonSafeAssetAccountingValue }>;

export interface PublicVehicleCostLedgerEntry extends Omit<
  VehicleCostLedgerEntrySnapshot,
  | "amountCents"
  | "assetOwnerSnapshot"
  | "confirmedAt"
  | "evidenceSnapshot"
  | "occurredOn"
  | "responsibilitySnapshot"
> {
  readonly amountCents: string;
  readonly assetOwnerSnapshot?: JsonSafeAssetAccountingValue;
  readonly confirmedAt: string;
  readonly evidenceSnapshot?: JsonSafeAssetAccountingValue;
  readonly occurredOn: string;
  readonly responsibilitySnapshot?: JsonSafeAssetAccountingValue;
}

export interface PublicVehicleCostSummaryBucket extends Omit<
  VehicleCostSummaryBucket,
  "amountCents"
> {
  readonly amountCents: string;
}

export interface PublicVehicleCostLedgerSummary extends Omit<
  VehicleCostLedgerSummary,
  "byActionType" | "byCategory" | "byResponsibility" | "byResponsibleParty" | "totalAmountCents"
> {
  readonly byActionType: Readonly<Record<string, PublicVehicleCostSummaryBucket>>;
  readonly byCategory: Readonly<Record<string, PublicVehicleCostSummaryBucket>>;
  readonly byResponsibility: Readonly<Record<string, PublicVehicleCostSummaryBucket>>;
  readonly byResponsibleParty: Readonly<Record<string, PublicVehicleCostSummaryBucket>>;
  readonly totalAmountCents: string;
}

export interface PublicBusinessExceptionApproval extends Omit<
  BusinessExceptionApprovalSnapshot,
  | "decidedAt"
  | "decisionComment"
  | "expiredAt"
  | "requestEvidenceSnapshot"
  | "requestedAt"
  | "subjectSnapshot"
> {
  readonly decidedAt?: string | null;
  readonly expiredAt?: string | null;
  readonly requestEvidenceSnapshot?: JsonSafeAssetAccountingValue;
  readonly requestedAt: string;
  readonly subjectSnapshot: Readonly<{ [key: string]: JsonSafeAssetAccountingValue }>;
}

const APPROVAL_SELECT = {
  approvalNo: true,
  decidedAt: true,
  decidedBy: true,
  decision: true,
  decisionComment: true,
  exceptionType: true,
  expiredAt: true,
  expiredBy: true,
  expiryReason: true,
  id: true,
  requestEvidenceSnapshot: true,
  requestReason: true,
  requestSourceId: true,
  requestSourceKey: true,
  requestSourceType: true,
  requestedAt: true,
  requestedBy: true,
  status: true,
  subjectField: true,
  subjectId: true,
  subjectSnapshot: true,
  subjectSnapshotHash: true,
  subjectType: true,
  version: true
} satisfies Prisma.BusinessExceptionApprovalSelect;

type ApprovalAuditRow = Prisma.BusinessExceptionApprovalGetPayload<{
  select: typeof APPROVAL_SELECT;
}>;

type ApprovalWriteCommand = {
  readonly source: AssetAccountingSource;
  readonly subject: BusinessExceptionSubjectIdentity;
};

@Injectable()
export class AssetAccountingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: AssetAccountingRepository,
    private readonly auditService: AuditService
  ) {}

  async appendCost(
    command: AppendCostServiceCommand,
    context: AssetAccountingCommandContext
  ): Promise<PublicVehicleCostLedgerEntry> {
    const actorId = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM
    );
    return this.runReadCommitted(async (tx) => {
      const result = await this.repository.appendCostEntry(tx, { ...command, actorId });
      const fact = projectCostEntry(result.outcome);
      if (result.wrote) {
        await this.writeAudit(tx, {
          action: AuditAction.CREATE,
          context,
          entityId: fact.id,
          entityType: "vehicle_cost_ledger_entry",
          fact,
          permission: ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM,
          reason: `Confirmed ${fact.actionType} vehicle cost fact.`,
          snapshotHash: hashBusinessExceptionSnapshot(fact),
          source: command.source
        });
      }
      return fact;
    });
  }

  async reverseCost(
    command: ReverseCostServiceCommand,
    context: AssetAccountingCommandContext
  ): Promise<PublicVehicleCostLedgerEntry> {
    const actorId = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.COST_REVERSE
    );
    return this.runReadCommitted(async (tx) => {
      const result = await this.repository.reverseCostEntry(tx, { ...command, actorId });
      const fact = projectCostEntry(result.outcome);
      if (result.wrote) {
        await this.writeAudit(tx, {
          action: AuditAction.CREATE,
          context,
          entityId: fact.id,
          entityType: "vehicle_cost_ledger_entry",
          fact,
          permission: ASSET_ACCOUNTING_PERMISSION.COST_REVERSE,
          reason: `Reversed vehicle cost fact ${command.originalEntryId}.`,
          snapshotHash: hashBusinessExceptionSnapshot(fact),
          source: command.source
        });
      }
      return fact;
    });
  }

  async getEntry(
    entryId: string,
    context: AssetAccountingCommandContext
  ): Promise<PublicVehicleCostLedgerEntry> {
    assertReadContext(context);
    return this.runReadCommitted(async (tx) => {
      const entry = await this.repository.getCostEntry(tx, entryId);
      if (!entry) {
        throw notFound(
          ASSET_ACCOUNTING_SERVICE_CODE.COST_ENTRY_NOT_FOUND,
          "The vehicle cost ledger entry was not found."
        );
      }
      return projectCostEntry(entry);
    });
  }

  async listVehicleEntries(
    vehicleId: string,
    context: AssetAccountingCommandContext
  ): Promise<PublicVehicleCostLedgerEntry[]> {
    assertReadContext(context);
    return this.runReadCommitted(async (tx) =>
      projectCostEntries(await this.repository.listVehicleEntries(tx, vehicleId))
    );
  }

  async listOrderEntries(
    orderId: string,
    context: AssetAccountingCommandContext
  ): Promise<PublicVehicleCostLedgerEntry[]> {
    assertReadContext(context);
    return this.runReadCommitted(async (tx) =>
      projectCostEntries(await this.repository.listOrderEntries(tx, orderId))
    );
  }

  async listWorkOrderEntries(
    workOrderId: string,
    context: AssetAccountingCommandContext
  ): Promise<PublicVehicleCostLedgerEntry[]> {
    assertReadContext(context);
    return this.runReadCommitted(async (tx) =>
      projectCostEntries(await this.repository.listWorkOrderEntries(tx, workOrderId))
    );
  }

  async summarizeOrderCostFacts(
    orderId: string,
    context: AssetAccountingCommandContext
  ): Promise<PublicVehicleCostLedgerSummary> {
    assertReadContext(context);
    return this.runReadCommitted(async (tx) => {
      const entries = await this.repository.listOrderEntries(tx, orderId);
      return projectSummary(summarizeVehicleCostEntries(entries));
    });
  }

  async assertWorkOrderCostConfirmed(
    tx: Prisma.TransactionClient,
    workOrderId: string
  ): Promise<true> {
    const workOrder = await tx.assetWorkOrder.findUnique({
      select: { costConfirmationRequired: true, id: true },
      where: { id: workOrderId }
    });
    if (!workOrder) {
      throw notFound(
        ASSET_ACCOUNTING_SERVICE_CODE.WORK_ORDER_NOT_FOUND,
        "The asset work order was not found."
      );
    }
    if (!workOrder.costConfirmationRequired) return true;

    const entries = await this.repository.listWorkOrderEntries(tx, workOrderId);
    const reversedEntryIds = new Set(
      entries
        .filter(({ entryKind }) => entryKind === "REVERSAL")
        .map(({ reversalOfEntryId }) => reversalOfEntryId)
        .filter((entryId): entryId is string => typeof entryId === "string")
    );
    const hasActiveActualCost = entries.some(
      ({ actionType, entryKind, id }) =>
        entryKind === "ORIGINAL" && actionType === "ACTUAL_COST" && !reversedEntryIds.has(id)
    );
    if (!hasActiveActualCost) {
      throw conflict(
        ASSET_ACCOUNTING_SERVICE_CODE.WORK_ORDER_COST_NOT_CONFIRMED,
        "The cost-required work order has no active confirmed actual-cost fact."
      );
    }
    return true;
  }

  async requestApprovalInTransaction(
    tx: Prisma.TransactionClient,
    command: RequestApprovalServiceCommand,
    context: AssetAccountingCommandContext,
    resolveAuthority: BusinessExceptionAuthorityResolver
  ): Promise<PublicBusinessExceptionApproval> {
    const actorId = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST
    );
    const authoritySnapshot = await this.resolveApprovalAuthority(tx, command, resolveAuthority);
    const result = await this.repository.requestExceptionApproval(tx, {
      ...command,
      authoritySnapshot,
      requestedBy: actorId
    });
    const fact = projectApproval(result.outcome);
    if (result.wrote) {
      await this.writeAudit(tx, {
        action: AuditAction.CREATE,
        context,
        entityId: fact.id,
        entityType: "business_exception_approval",
        fact,
        permission: ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST,
        reason: command.requestReason,
        snapshotHash: hashBusinessExceptionSnapshot(authoritySnapshot),
        source: command.source
      });
    }
    return fact;
  }

  async decideApprovalInTransaction(
    tx: Prisma.TransactionClient,
    command: DecideApprovalServiceCommand,
    context: AssetAccountingCommandContext,
    resolveAuthority: BusinessExceptionAuthorityResolver
  ): Promise<PublicBusinessExceptionApproval> {
    const actorId = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE
    );
    const authoritySnapshot = await this.resolveApprovalAuthority(tx, command, resolveAuthority);
    const before = await loadApprovalAuditRow(tx, command.approvalId);
    if (before && sameIdentity(before.requestedBy, actorId)) {
      throw conflict(
        ASSET_ACCOUNTING_SERVICE_CODE.SELF_APPROVAL_FORBIDDEN,
        "The requester cannot decide the same exception approval."
      );
    }
    const result = await this.repository.decideExceptionApproval(tx, {
      ...command,
      authoritySnapshot,
      decidedBy: actorId
    });
    const fact = projectApproval(result.outcome);
    if (result.wrote) {
      await this.writeAudit(tx, {
        action: command.decision === "APPROVED" ? AuditAction.APPROVE : AuditAction.REJECT,
        before: before ? projectApproval(before) : undefined,
        context,
        entityId: fact.id,
        entityType: "business_exception_approval",
        fact,
        permission: ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE,
        reason: command.decisionComment,
        snapshotHash: hashBusinessExceptionSnapshot(authoritySnapshot),
        source: command.source
      });
    }
    return fact;
  }

  async expireStaleApprovalsInTransaction(
    tx: Prisma.TransactionClient,
    command: ExpireApprovalServiceCommand,
    context: AssetAccountingCommandContext,
    resolveAuthority: BusinessExceptionAuthorityResolver
  ): Promise<PublicBusinessExceptionApproval> {
    const actorId = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST
    );
    const authoritySnapshot = await this.resolveApprovalAuthority(tx, command, resolveAuthority);
    const before = await loadApprovalAuditRow(tx, command.approvalId);
    const result = await this.repository.expireExceptionApproval(tx, {
      ...command,
      expiredBy: actorId
    });
    const fact = projectApproval(result.outcome);
    if (result.wrote) {
      await this.writeAudit(tx, {
        action: AuditAction.UPDATE,
        before: before ? projectApproval(before) : undefined,
        context,
        entityId: fact.id,
        entityType: "business_exception_approval",
        fact,
        permission: ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST,
        reason: command.expiryReason,
        snapshotHash: hashBusinessExceptionSnapshot(authoritySnapshot),
        source: command.source
      });
    }
    return fact;
  }

  async requireApprovedExceptionInTransaction(
    tx: Prisma.TransactionClient,
    command: RequireApprovedExceptionServiceCommand,
    context: AssetAccountingCommandContext,
    resolveAuthority: BusinessExceptionAuthorityResolver
  ): Promise<boolean> {
    const actorId = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST
    );
    const authoritySnapshot = await this.resolveApprovalAuthority(tx, command, resolveAuthority);
    const [before, receipt] = await Promise.all([
      loadApprovalAuditRow(tx, command.approvalId),
      tx.assetAccountingCommandReceipt.findUnique({
        select: { id: true },
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: command.source.id,
            sourceKey: command.source.key,
            sourceType: command.source.type
          }
        }
      })
    ]);
    const result = await this.repository.requireCurrentApprovedException(tx, {
      ...command,
      authoritySnapshot,
      expiredBy: actorId
    });
    if (result.valid) return true;

    if (!receipt) {
      const fact = projectApproval(result.expiredApproval);
      await this.writeAudit(tx, {
        action: AuditAction.UPDATE,
        before: before ? projectApproval(before) : undefined,
        context,
        entityId: fact.id,
        entityType: "business_exception_approval",
        fact,
        permission: ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST,
        reason: command.expiryReason,
        snapshotHash: hashBusinessExceptionSnapshot(authoritySnapshot),
        source: command.source
      });
    }
    return false;
  }

  private async resolveApprovalAuthority(
    tx: Prisma.TransactionClient,
    command: ApprovalWriteCommand,
    resolveAuthority: BusinessExceptionAuthorityResolver
  ) {
    await this.repository.lockBusinessExceptionSourceAndSubject(
      tx,
      command.source,
      command.subject
    );
    return resolveAuthority(tx);
  }

  private runReadCommitted<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
    });
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    input: {
      readonly action: AuditAction;
      readonly before?: PublicBusinessExceptionApproval;
      readonly context: AssetAccountingCommandContext;
      readonly entityId: string;
      readonly entityType: "business_exception_approval" | "vehicle_cost_ledger_entry";
      readonly fact: PublicBusinessExceptionApproval | PublicVehicleCostLedgerEntry;
      readonly permission: string;
      readonly reason: string;
      readonly snapshotHash: string;
      readonly source: AssetAccountingSource;
    }
  ) {
    const actorId = input.context.actorId;
    if (!actorId) {
      throw forbidden(
        ASSET_ACCOUNTING_SERVICE_CODE.AUTHENTICATION_REQUIRED,
        "An authenticated operator is required."
      );
    }
    return this.auditService.write(
      {
        action: input.action,
        after: {
          fact: input.fact,
          permission: input.permission,
          reason: input.reason,
          requestContext: {
            idempotencyKey: input.source.key,
            ipAddress: input.context.ipAddress ?? null,
            requestId: input.context.requestId ?? null,
            userAgent: input.context.userAgent ?? null
          },
          snapshotHash: input.snapshotHash,
          source: input.source
        },
        before: input.before,
        entityId: input.entityId,
        entityType: input.entityType,
        ipAddress: input.context.ipAddress,
        module: "asset_accounting",
        operatorId: actorId,
        userAgent: input.context.userAgent
      },
      tx
    );
  }
}

function assertReadContext(context: AssetAccountingCommandContext): string {
  const actorId = requireActor(context);
  requirePermission(context, ASSET_ACCOUNTING_PERMISSION.COST_VIEW);
  return actorId;
}

function assertWriteContext(
  source: AssetAccountingSource,
  context: AssetAccountingCommandContext,
  permission: string
): string {
  const actorId = requireActor(context);
  requirePermission(context, permission);
  if (!isValidAssetAccountingSource(source)) {
    throw badRequest(
      ASSET_ACCOUNTING_SERVICE_CODE.INVALID_SOURCE,
      "The asset-accounting source must contain nonblank type, UUID id, and key values."
    );
  }
  if (typeof context.idempotencyKey !== "string" || context.idempotencyKey.trim().length === 0) {
    throw badRequest(
      ASSET_ACCOUNTING_SERVICE_CODE.IDEMPOTENCY_KEY_INVALID,
      "One nonblank scalar Idempotency-Key is required."
    );
  }
  if (context.idempotencyKey !== source.key) {
    throw badRequest(
      ASSET_ACCOUNTING_SERVICE_CODE.IDEMPOTENCY_KEY_MISMATCH,
      "Idempotency-Key must exactly match source.key."
    );
  }
  return actorId;
}

function requireActor(context: AssetAccountingCommandContext): string {
  if (typeof context.actorId !== "string" || context.actorId.trim().length === 0) {
    throw forbidden(
      ASSET_ACCOUNTING_SERVICE_CODE.AUTHENTICATION_REQUIRED,
      "An authenticated operator is required."
    );
  }
  return context.actorId;
}

function requirePermission(context: AssetAccountingCommandContext, permission: string): void {
  if (!context.permissions.includes(permission)) {
    throw forbidden(
      ASSET_ACCOUNTING_SERVICE_CODE.PERMISSION_REQUIRED,
      `The authenticated operator requires ${permission}.`
    );
  }
}

function projectCostEntries(
  entries: readonly VehicleCostLedgerEntrySnapshot[]
): PublicVehicleCostLedgerEntry[] {
  return entries.map(projectCostEntry);
}

function projectCostEntry(entry: VehicleCostLedgerEntrySnapshot): PublicVehicleCostLedgerEntry {
  return jsonSafeObject(entry);
}

function projectSummary(summary: VehicleCostLedgerSummary): PublicVehicleCostLedgerSummary {
  return jsonSafeObject(summary);
}

function projectApproval(
  approval: BusinessExceptionApprovalSnapshot | ApprovalAuditRow
): PublicBusinessExceptionApproval {
  const publicApproval = Object.fromEntries(
    Object.entries(approval).filter(([key]) => key !== "decisionComment")
  );
  return jsonSafeObject(publicApproval);
}

function jsonSafeObject<T>(value: object): T {
  return JSON.parse(canonicalAssetAccountingJson(value)) as T;
}

function loadApprovalAuditRow(tx: Prisma.TransactionClient, approvalId: string) {
  return tx.businessExceptionApproval.findUnique({
    select: APPROVAL_SELECT,
    where: { id: approvalId }
  });
}

function sameIdentity(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function badRequest(code: string, message: string) {
  return new BadRequestException({ code, message });
}

function conflict(code: string, message: string) {
  return new ConflictException({ code, message });
}

function forbidden(code: string, message: string) {
  return new ForbiddenException({ code, message });
}

function notFound(code: string, message: string) {
  return new NotFoundException({ code, message });
}
