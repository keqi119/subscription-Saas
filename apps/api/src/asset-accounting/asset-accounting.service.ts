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
  bindSubscriptionClosureAuthorityConsumer,
  consumeSubscriptionClosureAuthorityAttestation,
  type ClosureAuthorityAttestation,
  type SubscriptionClosureAuthorityLock,
  type SubscriptionClosureAuthoritySession
} from "../subscription-closure/subscription-closure.repository";
import {
  canonicalAssetAccountingJson,
  hashBusinessExceptionSnapshot,
  summarizeVehicleCostEntries
} from "./asset-accounting.domain";
import {
  AssetAccountingRepository,
  canonicalAssetAccountingSource,
  canonicalDecideExceptionApprovalCommand,
  canonicalRequestExceptionApprovalCommand,
  canonicalRequireCurrentApprovedExceptionCommand,
  type AssetAccountingCallerOwnedCommandCapability,
  type AssetAccountingPreparedApprovalRepositoryCapability,
  type AppendCostEntryCommand,
  type BusinessExceptionApprovalFilters,
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
  EXCEPTION_REQUEST: "business_exception:request",
  EXCEPTION_VIEW: "business_exception:view"
} as const;

export const ASSET_ACCOUNTING_SERVICE_CODE = {
  AUTHENTICATION_REQUIRED: "ASSET_ACCOUNTING_AUTHENTICATION_REQUIRED",
  APPROVAL_NOT_STALE: "ASSET_ACCOUNTING_APPROVAL_NOT_STALE",
  APPROVAL_NOT_FOUND: "ASSET_ACCOUNTING_APPROVAL_NOT_FOUND",
  CALLER_CAPABILITY_INVALID: "ASSET_ACCOUNTING_CALLER_CAPABILITY_INVALID",
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
declare const assetAccountingTransactionCapabilityBrand: unique symbol;
export type AssetAccountingTransactionCapability = Readonly<{
  [assetAccountingTransactionCapabilityBrand]: true;
}>;
type AssetAccountingTransactionCapabilityState = Readonly<{
  repositoryCapability: AssetAccountingCallerOwnedCommandCapability;
  source: AssetAccountingSource;
  transaction: Prisma.TransactionClient;
}>;
declare const assetAccountingPreparedAppendCapabilityBrand: unique symbol;
export type AssetAccountingPreparedAppendCapability = Readonly<{
  [assetAccountingPreparedAppendCapabilityBrand]: true;
}>;
type AssetAccountingPreparedAppendCapabilityState = Readonly<{
  command: AppendCostServiceCommand;
  context: AssetAccountingCommandContext;
  repositoryCapability: AssetAccountingCallerOwnedCommandCapability;
  transaction: Prisma.TransactionClient;
}>;
declare const assetAccountingPreparedApprovalCapabilityBrand: unique symbol;
export type AssetAccountingPreparedApprovalCapability = Readonly<{
  [assetAccountingPreparedApprovalCapabilityBrand]: true;
}>;
type AssetAccountingPreparedApprovalCapabilityState = Readonly<{
  authorityLockFingerprint: string;
  command: RequireCurrentApprovedExceptionCommand;
  context: AssetAccountingCommandContext;
  repositoryCapability: AssetAccountingPreparedApprovalRepositoryCapability;
  transaction: Prisma.TransactionClient;
}>;
declare const assetAccountingPreparedApprovalRequestCapabilityBrand: unique symbol;
export type AssetAccountingPreparedApprovalRequestCapability = Readonly<{
  [assetAccountingPreparedApprovalRequestCapabilityBrand]: true;
}>;
type AssetAccountingPreparedApprovalRequestCapabilityState = Readonly<{
  authorityLockFingerprint: string;
  command: RequestExceptionApprovalCommand;
  context: AssetAccountingCommandContext;
  repositoryCapability: AssetAccountingPreparedApprovalRepositoryCapability;
  transaction: Prisma.TransactionClient;
}>;
declare const assetAccountingPreparedApprovalDecisionCapabilityBrand: unique symbol;
export type AssetAccountingPreparedApprovalDecisionCapability = Readonly<{
  [assetAccountingPreparedApprovalDecisionCapabilityBrand]: true;
}>;
type AssetAccountingPreparedApprovalDecisionCapabilityState = Readonly<{
  authorityLockFingerprint: string;
  command: DecideExceptionApprovalCommand;
  context: AssetAccountingCommandContext;
  repositoryCapability: AssetAccountingPreparedApprovalRepositoryCapability;
  requesterId: string;
  transaction: Prisma.TransactionClient;
}>;
export type AssetAccountingAppendAuthority = Readonly<{
  authoritativeOrderId: string | null;
}>;
export type RequestApprovalServiceCommand = Omit<
  RequestExceptionApprovalCommand,
  "authoritySnapshot" | "requestedBy"
>;
export type DecideApprovalServiceCommand = Omit<
  DecideExceptionApprovalCommand,
  "authoritySnapshot" | "decidedBy"
>;
export type ExpireApprovalServiceCommand = Omit<
  ExpireExceptionApprovalCommand,
  "authoritySnapshot" | "expiredBy"
>;
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
  private readonly closureAuthorityConsumer = Object.freeze({});
  private readonly callerOwnedCapabilities = new WeakMap<
    AssetAccountingTransactionCapability,
    AssetAccountingTransactionCapabilityState
  >();
  private readonly preparedAppendCapabilities = new WeakMap<
    AssetAccountingPreparedAppendCapability,
    AssetAccountingPreparedAppendCapabilityState
  >();
  private readonly preparedApprovalCapabilities = new WeakMap<
    AssetAccountingPreparedApprovalCapability,
    AssetAccountingPreparedApprovalCapabilityState
  >();
  private readonly preparedApprovalRequestCapabilities = new WeakMap<
    AssetAccountingPreparedApprovalRequestCapability,
    AssetAccountingPreparedApprovalRequestCapabilityState
  >();
  private readonly preparedApprovalDecisionCapabilities = new WeakMap<
    AssetAccountingPreparedApprovalDecisionCapability,
    AssetAccountingPreparedApprovalDecisionCapabilityState
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: AssetAccountingRepository,
    private readonly auditService: AuditService
  ) {}

  async prepareCallerOwnedTransaction(
    tx: Prisma.TransactionClient,
    source: AssetAccountingSource
  ): Promise<AssetAccountingTransactionCapability> {
    const normalizedSource = canonicalAssetAccountingSource(source);
    const repositoryCapability = await this.repository.prepareCallerOwnedCommand(
      tx,
      normalizedSource
    );
    const capability = Object.freeze({}) as AssetAccountingTransactionCapability;
    this.callerOwnedCapabilities.set(
      capability,
      Object.freeze({ repositoryCapability, source: normalizedSource, transaction: tx })
    );
    return capability;
  }

  async appendCostInTransaction(
    tx: Prisma.TransactionClient,
    command: AppendCostServiceCommand,
    context: AssetAccountingCommandContext,
    capability: AssetAccountingTransactionCapability
  ): Promise<PublicVehicleCostLedgerEntry> {
    const capabilityState = this.takeCallerOwnedCapability(capability);
    const source = canonicalAssetAccountingSource(command.source);
    const repositoryCapability = this.assertCallerOwnedCapability(capabilityState, tx, source);
    return this.appendCostCommand(tx, { ...command, source }, context, repositoryCapability);
  }

  approvedExceptionAuthorityRequirement(
    authoritySession: SubscriptionClosureAuthoritySession,
    command: RequireApprovedExceptionServiceCommand,
    context: AssetAccountingCommandContext,
    authoritySnapshot: BusinessExceptionSnapshot,
    key = "approved-exception"
  ) {
    const { actorId, source } = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST
    );
    const normalized = canonicalRequireCurrentApprovedExceptionCommand({
      ...command,
      authoritySnapshot,
      expiredBy: actorId,
      source
    });
    const subjectAuthority = approvalSubjectAuthority(normalized.subject);
    return bindSubscriptionClosureAuthorityConsumer(
      {
        command: normalized as never,
        key,
        locks: [
          subjectAuthority,
          {
            id: normalized.approvalId,
            mode: "UPDATE" as const,
            table: "business_exception_approval" as const
          },
          { id: normalized.expiredBy, mode: "SHARE" as const, table: "user" as const }
        ]
      },
      this.closureAuthorityConsumer,
      authoritySession
    );
  }

  requestApprovalAuthorityRequirement(
    authoritySession: SubscriptionClosureAuthoritySession,
    command: RequestApprovalServiceCommand,
    context: AssetAccountingCommandContext,
    authoritySnapshot: BusinessExceptionSnapshot,
    key = "approval-request"
  ) {
    const { actorId, source } = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST
    );
    const normalized = canonicalRequestExceptionApprovalCommand({
      ...command,
      authoritySnapshot,
      requestedBy: actorId,
      source
    });
    return bindSubscriptionClosureAuthorityConsumer(
      {
        command: normalized as never,
        key,
        locks: [
          approvalSubjectAuthority(normalized.subject),
          { id: normalized.requestedBy, mode: "SHARE" as const, table: "user" as const }
        ]
      },
      this.closureAuthorityConsumer,
      authoritySession
    );
  }

  decideApprovalAuthorityRequirement(
    authoritySession: SubscriptionClosureAuthoritySession,
    command: DecideApprovalServiceCommand,
    context: AssetAccountingCommandContext,
    authoritySnapshot: BusinessExceptionSnapshot,
    requesterId: string,
    key = "approval-decision"
  ) {
    const { actorId, source } = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE
    );
    const normalized = canonicalDecideExceptionApprovalCommand({
      ...command,
      authoritySnapshot,
      decidedBy: actorId,
      source
    });
    return bindSubscriptionClosureAuthorityConsumer(
      {
        command: { ...normalized, requesterId } as never,
        key,
        locks: [
          approvalSubjectAuthority(normalized.subject),
          {
            id: normalized.approvalId,
            mode: "UPDATE" as const,
            table: "business_exception_approval" as const
          },
          { id: requesterId, mode: "SHARE" as const, table: "user" as const },
          { id: normalized.decidedBy, mode: "SHARE" as const, table: "user" as const }
        ]
      },
      this.closureAuthorityConsumer,
      authoritySession
    );
  }

  async attestPreparedApprovalRequestInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    command: RequestApprovalServiceCommand,
    context: AssetAccountingCommandContext,
    authoritySnapshot: BusinessExceptionSnapshot,
    sourceCapability: AssetAccountingTransactionCapability,
    authorityAttestation: ClosureAuthorityAttestation,
    key = "approval-request"
  ): Promise<AssetAccountingPreparedApprovalRequestCapability> {
    try {
      consumeSubscriptionClosureAuthorityAttestation(
        tx,
        authoritySession,
        authorityAttestation,
        () =>
          this.requestApprovalAuthorityRequirement(
            authoritySession,
            command,
            context,
            authoritySnapshot,
            key
          ),
        null
      );
    } catch {
      throw callerCapabilityInvalid();
    }
    const state = this.takeCallerOwnedCapability(sourceCapability);
    const { actorId, source } = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST
    );
    const repositoryCapability = this.assertCallerOwnedCapability(state, tx, source);
    const normalized = canonicalRequestExceptionApprovalCommand({
      ...command,
      authoritySnapshot,
      requestedBy: actorId,
      source
    });
    const authorityLockFingerprint = approvalAuthorityLockFingerprint(
      this.requestApprovalAuthorityRequirement(
        authoritySession,
        command,
        context,
        authoritySnapshot,
        key
      ).locks
    );
    const preparedRepositoryCapability = await this.repository.prepareApprovalRequestInTransaction(
      tx,
      normalized,
      repositoryCapability,
      authorityLockFingerprint
    );
    const prepared = Object.freeze({}) as AssetAccountingPreparedApprovalRequestCapability;
    this.preparedApprovalRequestCapabilities.set(
      prepared,
      Object.freeze({
        authorityLockFingerprint,
        command: structuredClone(normalized),
        context: freezeCommandContext(context),
        repositoryCapability: preparedRepositoryCapability,
        transaction: tx
      })
    );
    return prepared;
  }

  async requestPreparedApprovalInTransaction(
    tx: Prisma.TransactionClient,
    capability: AssetAccountingPreparedApprovalRequestCapability
  ): Promise<PublicBusinessExceptionApproval> {
    const state = this.preparedApprovalRequestCapabilities.get(capability);
    this.preparedApprovalRequestCapabilities.delete(capability);
    if (!state || state.transaction !== tx) throw callerCapabilityInvalid();
    const result = await this.repository.requestPreparedApprovalInTransaction(
      tx,
      state.repositoryCapability,
      state.authorityLockFingerprint
    );
    const fact = projectApproval(result.outcome);
    if (result.wrote) {
      await this.writeAudit(tx, {
        action: AuditAction.CREATE,
        context: state.context,
        entityId: fact.id,
        entityType: "business_exception_approval",
        fact,
        permission: ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST,
        reason: state.command.requestReason,
        snapshotHash: hashBusinessExceptionSnapshot(state.command.authoritySnapshot),
        source: state.command.source
      });
    }
    return fact;
  }

  async attestPreparedApprovalDecisionInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    command: DecideApprovalServiceCommand,
    context: AssetAccountingCommandContext,
    authoritySnapshot: BusinessExceptionSnapshot,
    requesterId: string,
    sourceCapability: AssetAccountingTransactionCapability,
    authorityAttestation: ClosureAuthorityAttestation,
    key = "approval-decision"
  ): Promise<AssetAccountingPreparedApprovalDecisionCapability> {
    try {
      consumeSubscriptionClosureAuthorityAttestation(
        tx,
        authoritySession,
        authorityAttestation,
        () =>
          this.decideApprovalAuthorityRequirement(
            authoritySession,
            command,
            context,
            authoritySnapshot,
            requesterId,
            key
          ),
        null
      );
    } catch {
      throw callerCapabilityInvalid();
    }
    const state = this.takeCallerOwnedCapability(sourceCapability);
    const { actorId, source } = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE
    );
    const repositoryCapability = this.assertCallerOwnedCapability(state, tx, source);
    const normalized = canonicalDecideExceptionApprovalCommand({
      ...command,
      authoritySnapshot,
      decidedBy: actorId,
      source
    });
    const authorityLockFingerprint = approvalAuthorityLockFingerprint(
      this.decideApprovalAuthorityRequirement(
        authoritySession,
        command,
        context,
        authoritySnapshot,
        requesterId,
        key
      ).locks
    );
    const preparedRepositoryCapability = await this.repository.prepareApprovalDecisionInTransaction(
      tx,
      normalized,
      repositoryCapability,
      authorityLockFingerprint
    );
    const prepared = Object.freeze({}) as AssetAccountingPreparedApprovalDecisionCapability;
    this.preparedApprovalDecisionCapabilities.set(
      prepared,
      Object.freeze({
        authorityLockFingerprint,
        command: structuredClone(normalized),
        context: freezeCommandContext(context),
        repositoryCapability: preparedRepositoryCapability,
        requesterId,
        transaction: tx
      })
    );
    return prepared;
  }

  async decidePreparedApprovalInTransaction(
    tx: Prisma.TransactionClient,
    capability: AssetAccountingPreparedApprovalDecisionCapability
  ): Promise<PublicBusinessExceptionApproval> {
    const state = this.preparedApprovalDecisionCapabilities.get(capability);
    this.preparedApprovalDecisionCapabilities.delete(capability);
    if (!state || state.transaction !== tx) throw callerCapabilityInvalid();
    const before = await loadApprovalAuditRow(tx, state.command.approvalId);
    if (!before || before.requestedBy !== state.requesterId) throw callerCapabilityInvalid();
    const result = await this.repository.decidePreparedApprovalInTransaction(
      tx,
      state.repositoryCapability,
      state.authorityLockFingerprint
    );
    const fact = projectApproval(result.outcome);
    if (result.wrote) {
      await this.writeAudit(tx, {
        action: state.command.decision === "APPROVED" ? AuditAction.APPROVE : AuditAction.REJECT,
        before: projectApproval(before),
        context: state.context,
        entityId: fact.id,
        entityType: "business_exception_approval",
        fact,
        permission: ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE,
        reason: state.command.decisionComment,
        snapshotHash: hashBusinessExceptionSnapshot(state.command.authoritySnapshot),
        source: state.command.source
      });
    }
    return fact;
  }

  async attestPreparedApprovedExceptionInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    command: RequireApprovedExceptionServiceCommand,
    context: AssetAccountingCommandContext,
    authoritySnapshot: BusinessExceptionSnapshot,
    sourceCapability: AssetAccountingTransactionCapability,
    authorityAttestation: ClosureAuthorityAttestation,
    key = "approved-exception"
  ): Promise<AssetAccountingPreparedApprovalCapability> {
    try {
      consumeSubscriptionClosureAuthorityAttestation(
        tx,
        authoritySession,
        authorityAttestation,
        () =>
          this.approvedExceptionAuthorityRequirement(
            authoritySession,
            command,
            context,
            authoritySnapshot,
            key
          ),
        null
      );
    } catch {
      throw callerCapabilityInvalid();
    }
    const state = this.takeCallerOwnedCapability(sourceCapability);
    const { actorId, source } = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST
    );
    const repositoryCapability = this.assertCallerOwnedCapability(state, tx, source);
    const normalized = canonicalRequireCurrentApprovedExceptionCommand({
      ...command,
      authoritySnapshot,
      expiredBy: actorId,
      source
    });
    const authorityLockFingerprint = approvalAuthorityLockFingerprint(
      this.approvedExceptionAuthorityRequirement(
        authoritySession,
        command,
        context,
        authoritySnapshot,
        key
      ).locks
    );
    const preparedRepositoryCapability =
      await this.repository.prepareApprovedExceptionInTransaction(
        tx,
        normalized,
        repositoryCapability,
        authorityLockFingerprint
      );
    const prepared = Object.freeze({}) as AssetAccountingPreparedApprovalCapability;
    this.preparedApprovalCapabilities.set(
      prepared,
      Object.freeze({
        authorityLockFingerprint,
        command: structuredClone(normalized),
        context: Object.freeze({
          ...context,
          permissions: Object.freeze([...context.permissions])
        }),
        repositoryCapability: preparedRepositoryCapability,
        transaction: tx
      })
    );
    return prepared;
  }

  async requirePreparedApprovedExceptionInTransaction(
    tx: Prisma.TransactionClient,
    capability: AssetAccountingPreparedApprovalCapability
  ): Promise<boolean> {
    const state = this.preparedApprovalCapabilities.get(capability);
    this.preparedApprovalCapabilities.delete(capability);
    if (!state || state.transaction !== tx) throw callerCapabilityInvalid();
    const { authorityLockFingerprint, command, context, repositoryCapability } = state;
    const before = await loadApprovalAuditRow(tx, command.approvalId);
    const receipt = await tx.assetAccountingCommandReceipt.findUnique({
      select: { id: true },
      where: {
        sourceType_sourceId_sourceKey: {
          sourceId: command.source.id,
          sourceKey: command.source.key,
          sourceType: command.source.type
        }
      }
    });
    const result = await this.repository.requirePreparedApprovedExceptionInTransaction(
      tx,
      repositoryCapability,
      authorityLockFingerprint
    );
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
        snapshotHash: hashBusinessExceptionSnapshot(command.authoritySnapshot),
        source: command.source
      });
    }
    return false;
  }

  appendCostAuthorityRequirement(
    authoritySession: SubscriptionClosureAuthoritySession,
    command: AppendCostServiceCommand,
    context: AssetAccountingCommandContext,
    authority: AssetAccountingAppendAuthority,
    key = "inspection-cost"
  ) {
    const actorId = context.actorId;
    return bindSubscriptionClosureAuthorityConsumer(
      {
        command: { actorId, authority, command: command as never },
        key,
        locks: [
          ...(command.orderId
            ? [
                {
                  id: command.orderId,
                  mode: "SHARE" as const,
                  table: "subscription_order" as const
                }
              ]
            : []),
          ...(authority.authoritativeOrderId
            ? [
                {
                  id: authority.authoritativeOrderId,
                  mode: "SHARE" as const,
                  table: "subscription_order" as const
                }
              ]
            : []),
          { id: command.vehicleId, mode: "SHARE" as const, table: "vehicle" as const },
          ...(command.contractId
            ? [{ id: command.contractId, mode: "SHARE" as const, table: "contract" as const }]
            : []),
          ...(command.workOrderId
            ? [
                {
                  id: command.workOrderId,
                  mode: "SHARE" as const,
                  table: "asset_work_order" as const
                }
              ]
            : []),
          ...(command.assetOwnerId
            ? [{ id: command.assetOwnerId, mode: "SHARE" as const, table: "asset_owner" as const }]
            : []),
          ...(command.evidenceId
            ? [
                {
                  id: command.evidenceId,
                  mode: "SHARE" as const,
                  table: "asset_work_order_evidence" as const
                }
              ]
            : []),
          ...(command.customerId
            ? [{ id: command.customerId, mode: "SHARE" as const, table: "customer" as const }]
            : []),
          ...(actorId ? [{ id: actorId, mode: "SHARE" as const, table: "user" as const }] : [])
        ]
      },
      this.closureAuthorityConsumer,
      authoritySession
    );
  }

  async attestPreparedAppendCostInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    command: AppendCostServiceCommand,
    context: AssetAccountingCommandContext,
    sourceCapability: AssetAccountingTransactionCapability,
    authority: AssetAccountingAppendAuthority,
    authorityAttestation: ClosureAuthorityAttestation,
    key = "inspection-cost"
  ): Promise<AssetAccountingPreparedAppendCapability> {
    try {
      consumeSubscriptionClosureAuthorityAttestation(
        tx,
        authoritySession,
        authorityAttestation,
        () =>
          this.appendCostAuthorityRequirement(authoritySession, command, context, authority, key),
        null
      );
    } catch {
      throw callerCapabilityInvalid();
    }
    const state = this.takeCallerOwnedCapability(sourceCapability);
    const source = canonicalAssetAccountingSource(command.source);
    const repositoryCapability = this.assertCallerOwnedCapability(state, tx, source);
    assertWriteContext(source, context, ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM);
    const prepared = Object.freeze({}) as AssetAccountingPreparedAppendCapability;
    this.preparedAppendCapabilities.set(prepared, {
      command: structuredClone({ ...command, source }),
      context: Object.freeze({ ...context, permissions: Object.freeze([...context.permissions]) }),
      repositoryCapability,
      transaction: tx
    });
    return prepared;
  }

  async appendPreparedCostInTransaction(
    tx: Prisma.TransactionClient,
    capability: AssetAccountingPreparedAppendCapability
  ) {
    const state = this.preparedAppendCapabilities.get(capability);
    this.preparedAppendCapabilities.delete(capability);
    if (!state || state.transaction !== tx) throw callerCapabilityInvalid();
    return this.appendCostCommand(
      tx,
      state.command,
      state.context,
      state.repositoryCapability,
      undefined,
      true
    );
  }

  async appendCost(
    command: AppendCostServiceCommand,
    context: AssetAccountingCommandContext
  ): Promise<PublicVehicleCostLedgerEntry> {
    const writeContext = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM
    );
    return this.runReadCommitted((tx) =>
      this.appendCostCommand(tx, command, context, undefined, writeContext)
    );
  }

  private async appendCostCommand(
    tx: Prisma.TransactionClient,
    command: AppendCostServiceCommand,
    context: AssetAccountingCommandContext,
    repositoryCapability?: AssetAccountingCallerOwnedCommandCapability,
    preparedWriteContext?: Readonly<{ actorId: string; source: AssetAccountingSource }>,
    authorityAlreadyLocked = false
  ): Promise<PublicVehicleCostLedgerEntry> {
    const { actorId, source } =
      preparedWriteContext ??
      assertWriteContext(command.source, context, ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM);
    const result = await this.repository.appendCostEntry(
      tx,
      { ...command, actorId, source },
      repositoryCapability,
      authorityAlreadyLocked
    );
    const fact = projectCostEntry(result.outcome);
    if (result.wrote) {
      await this.writeAudit(tx, {
        action: AuditAction.CREATE,
        context,
        entityId: fact.id,
        entityType: "vehicle_cost_ledger_entry",
        fact,
        permission: ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM,
        reason: command.reason,
        snapshotHash: hashBusinessExceptionSnapshot(fact),
        source
      });
    }
    return fact;
  }

  private takeCallerOwnedCapability(
    capability: AssetAccountingTransactionCapability
  ): AssetAccountingTransactionCapabilityState {
    const state = this.callerOwnedCapabilities.get(capability);
    this.callerOwnedCapabilities.delete(capability);
    if (!state) {
      throw new ConflictException({
        code: ASSET_ACCOUNTING_SERVICE_CODE.CALLER_CAPABILITY_INVALID,
        message: "The caller-owned asset-accounting transaction capability is invalid."
      });
    }
    return state;
  }

  private assertCallerOwnedCapability(
    state: AssetAccountingTransactionCapabilityState,
    tx: Prisma.TransactionClient,
    source: AssetAccountingSource
  ): AssetAccountingCallerOwnedCommandCapability {
    if (
      state.transaction !== tx ||
      state.source.id !== source.id ||
      state.source.key !== source.key ||
      state.source.type !== source.type
    ) {
      throw new ConflictException({
        code: ASSET_ACCOUNTING_SERVICE_CODE.CALLER_CAPABILITY_INVALID,
        message: "The caller-owned asset-accounting transaction capability is invalid."
      });
    }
    return state.repositoryCapability;
  }

  async reverseCost(
    command: ReverseCostServiceCommand,
    context: AssetAccountingCommandContext
  ): Promise<PublicVehicleCostLedgerEntry> {
    const { actorId, source } = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.COST_REVERSE
    );
    return this.runReadCommitted(async (tx) => {
      const result = await this.repository.reverseCostEntry(tx, { ...command, actorId, source });
      const fact = projectCostEntry(result.outcome);
      if (result.wrote) {
        await this.writeAudit(tx, {
          action: AuditAction.CREATE,
          context,
          entityId: fact.id,
          entityType: "vehicle_cost_ledger_entry",
          fact,
          permission: ASSET_ACCOUNTING_PERMISSION.COST_REVERSE,
          reason: command.reason,
          snapshotHash: hashBusinessExceptionSnapshot(fact),
          source
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

  async getExceptionApproval(
    approvalId: string,
    context: AssetAccountingCommandContext
  ): Promise<PublicBusinessExceptionApproval> {
    assertReadContext(context, ASSET_ACCOUNTING_PERMISSION.EXCEPTION_VIEW);
    return this.runReadCommitted(async (tx) => {
      const approval = await this.repository.getExceptionApproval(tx, approvalId);
      if (!approval) {
        throw notFound(
          ASSET_ACCOUNTING_SERVICE_CODE.APPROVAL_NOT_FOUND,
          "The business exception approval was not found."
        );
      }
      return projectApproval(approval);
    });
  }

  async listExceptionApprovals(
    filters: BusinessExceptionApprovalFilters,
    context: AssetAccountingCommandContext
  ): Promise<PublicBusinessExceptionApproval[]> {
    assertReadContext(context, ASSET_ACCOUNTING_PERMISSION.EXCEPTION_VIEW);
    return this.runReadCommitted(async (tx) =>
      (await this.repository.listExceptionApprovals(tx, filters)).map(projectApproval)
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
    const { actorId, source } = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST
    );
    const normalizedCommand = { ...command, source };
    const authoritySnapshot = await this.resolveApprovalAuthority(
      tx,
      normalizedCommand,
      resolveAuthority
    );
    const result = await this.repository.requestExceptionApproval(tx, {
      ...normalizedCommand,
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
        source
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
    const { actorId, source } = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE
    );
    const normalizedCommand = { ...command, source };
    const authoritySnapshot = await this.resolveApprovalAuthority(
      tx,
      normalizedCommand,
      resolveAuthority
    );
    const before = await loadApprovalAuditRow(tx, command.approvalId);
    if (before && sameIdentity(before.requestedBy, actorId)) {
      throw conflict(
        ASSET_ACCOUNTING_SERVICE_CODE.SELF_APPROVAL_FORBIDDEN,
        "The requester cannot decide the same exception approval."
      );
    }
    const result = await this.repository.decideExceptionApproval(tx, {
      ...normalizedCommand,
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
        source
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
    const { actorId, source } = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST
    );
    const normalizedCommand = { ...command, source };
    const authoritySnapshot = await this.resolveApprovalAuthority(
      tx,
      normalizedCommand,
      resolveAuthority
    );
    const before = await this.repository.lockExceptionApproval(tx, command.approvalId);
    if (before && approvalHasAuthoritySnapshot(before, authoritySnapshot)) {
      throw conflict(
        ASSET_ACCOUNTING_SERVICE_CODE.APPROVAL_NOT_STALE,
        "The exception approval is still bound to the current authoritative snapshot."
      );
    }
    const result = await this.repository.expireExceptionApproval(tx, {
      ...normalizedCommand,
      authoritySnapshot,
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
        source
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
    const { actorId, source } = assertWriteContext(
      command.source,
      context,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST
    );
    const normalizedCommand = { ...command, source };
    const authoritySnapshot = await this.resolveApprovalAuthority(
      tx,
      normalizedCommand,
      resolveAuthority
    );
    const [before, receipt] = await Promise.all([
      loadApprovalAuditRow(tx, command.approvalId),
      tx.assetAccountingCommandReceipt.findUnique({
        select: { id: true },
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: source.id,
            sourceKey: source.key,
            sourceType: source.type
          }
        }
      })
    ]);
    const result = await this.repository.requireCurrentApprovedException(tx, {
      ...normalizedCommand,
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
        source
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

function callerCapabilityInvalid() {
  return new ConflictException({
    code: ASSET_ACCOUNTING_SERVICE_CODE.CALLER_CAPABILITY_INVALID,
    message: "The caller-owned asset-accounting transaction capability is invalid."
  });
}

function approvalSubjectAuthority(subject: BusinessExceptionSubjectIdentity) {
  const table = (() => {
    switch (subject.subjectType) {
      case "VEHICLE":
        return "vehicle" as const;
      case "ORDER":
        return "subscription_order" as const;
      case "CONTRACT":
        return "contract" as const;
      case "ASSET_WORK_ORDER":
        return "asset_work_order" as const;
      case "HANDOVER_WORK_ORDER":
        return "vehicle_handover_work_order" as const;
      case "SETTLEMENT_CASE":
        return "subscription_closure_case" as const;
      case "RECOVERY_CASE":
        return "subscription_closure_case" as const;
    }
  })();
  return { id: subject.subjectId, mode: "UPDATE" as const, table };
}

function approvalAuthorityLockFingerprint(locks: readonly SubscriptionClosureAuthorityLock[]) {
  return hashBusinessExceptionSnapshot({
    locks: locks
      .map(({ id, mode, table }) => ({ id: id.toLowerCase(), mode, table }))
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(`${left.table}\u0000${left.id}\u0000${left.mode}`, "utf8"),
          Buffer.from(`${right.table}\u0000${right.id}\u0000${right.mode}`, "utf8")
        )
      )
  });
}

function freezeCommandContext(
  context: AssetAccountingCommandContext
): AssetAccountingCommandContext {
  return Object.freeze({
    ...context,
    permissions: Object.freeze([...context.permissions])
  });
}

function assertReadContext(
  context: AssetAccountingCommandContext,
  permission: string = ASSET_ACCOUNTING_PERMISSION.COST_VIEW
): string {
  const actorId = requireActor(context);
  requirePermission(context, permission);
  return actorId;
}

function assertWriteContext(
  source: AssetAccountingSource,
  context: AssetAccountingCommandContext,
  permission: string
): Readonly<{ actorId: string; source: AssetAccountingSource }> {
  const actorId = requireActor(context);
  requirePermission(context, permission);
  let normalizedSource: AssetAccountingSource;
  try {
    normalizedSource = canonicalAssetAccountingSource(source);
  } catch {
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
  return { actorId, source: normalizedSource };
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

function approvalHasAuthoritySnapshot(
  approval: Readonly<{ subjectSnapshot: unknown; subjectSnapshotHash: string }>,
  authoritySnapshot: BusinessExceptionSnapshot
) {
  return (
    approval.subjectSnapshotHash === hashBusinessExceptionSnapshot(authoritySnapshot) &&
    canonicalAssetAccountingJson(approval.subjectSnapshot) ===
      canonicalAssetAccountingJson(authoritySnapshot)
  );
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
