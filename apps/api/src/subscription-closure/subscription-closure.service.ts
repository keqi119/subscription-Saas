import { BadRequestException, ConflictException, Injectable, Optional } from "@nestjs/common";
import {
  AssetWorkOrderStatus,
  AuditAction,
  BillStatus,
  ContractSegmentStatus,
  ContractStatus,
  ESignDocumentType,
  ESignProviderType,
  ESignSigningStage,
  ESignTaskStatus,
  LeaseStatus,
  OrderStatus,
  Prisma,
  SubscriptionAutomationJobType,
  type SubscriptionClosureStatus,
  UserStatus,
  VehicleCostActionType,
  VehicleMileageReadingStatus,
  VehicleMileageSourceType,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionStatus,
  VehicleOperationalRestrictionType,
  VehicleReturnStatus,
  VehicleStatus,
  VehicleSubscriptionPeriodEndReason
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";

import {
  assetOperationsCreateAuthorityRequirement,
  AssetOperationsService,
  type AssetOperationsTransactionCapability
} from "../asset-operations/asset-operations.service";
import type {
  AppendEvidenceServiceCommand,
  CreateWorkOrderServiceCommand
} from "../asset-operations/asset-operations.service";
import { VehicleAvailabilityPurpose } from "../asset-operations/vehicle-availability";
import {
  ASSET_ACCOUNTING_PERMISSION,
  AssetAccountingService,
  type AssetAccountingPreparedApprovalCapability,
  type AssetAccountingTransactionCapability,
  type AppendCostServiceCommand
} from "../asset-accounting/asset-accounting.service";
import {
  canonicalAssetAccountingJson,
  hashBusinessExceptionSnapshot
} from "../asset-accounting/asset-accounting.domain";
import { AssetFactsService } from "../asset-facts/asset-facts.service";
import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import {
  subscriptionEffectiveBoundaryOwner,
  type EffectiveBoundaryTransactionCapability
} from "../subscription-change/subscription-effective-boundary";
import {
  VehicleMileageService,
  type VehicleMileageTransactionCapability
} from "../vehicle-mileage/vehicle-mileage.service";
import {
  HandoverWorkOrderService,
  type PreparedGovernedReturnInboundUpdateCapability,
  type PreparedReturnInboundCapability
} from "../handover-work-order/handover-work-order.service";
import {
  canonicalSubscriptionClosureJson,
  hashSubscriptionClosureSnapshot,
  recoveryAssessmentAvailableAt
} from "./subscription-closure.domain";
import {
  SubscriptionClosureRepository,
  SUBSCRIPTION_CLOSURE_ERROR_CODE,
  subscriptionClosureCaseAuthorityRequirement,
  subscriptionClosureCaseNo,
  subscriptionClosureDocumentAuthorityRequirement,
  subscriptionClosureEventAuthorityRequirement,
  subscriptionClosureSettlementAuthorityRequirement,
  type AppendSubscriptionClosureSettlementCommand,
  type AppendSubscriptionClosureDocumentCommand,
  type ClosureAuthorityAttestation,
  type PreparedClosureSourceCapability,
  type SubscriptionClosureAuthorityLock,
  type SubscriptionClosureAuthoritySession,
  type SubscriptionClosureMutationAuditHook
} from "./subscription-closure.repository";
import type {
  SubscriptionClosureSnapshotObject,
  SubscriptionClosureSettlementSnapshot,
  SubscriptionClosureSource
} from "./subscription-closure.types";
import {
  SubscriptionClosureSettlementResolver,
  type ResolvedSubscriptionClosureSettlement
} from "./subscription-closure.settlement-resolver";
import type {
  ArchiveEarlyTerminationAgreementInput,
  ArchivedEarlyTerminationAgreement,
  CancelEarlyTerminationInput,
  ExecuteEarlyTerminationInput,
  InitiateEarlyTerminationInput
} from "./subscription-closure.early-termination.dto";

export const SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE = {
  AUTHORITY_MISMATCH: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH",
  AUTHORITY_NOT_FOUND: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_NOT_FOUND",
  CAPABILITY_INVALID: "SUBSCRIPTION_CLOSURE_EXPIRY_CAPABILITY_INVALID",
  CLOCK_UNAVAILABLE: "SUBSCRIPTION_CLOSURE_DOCUMENT_CLOCK_UNAVAILABLE",
  MANAGED_RETURN_AUTHORITY_NOT_FOUND: "SUBSCRIPTION_CLOSURE_MANAGED_RETURN_AUTHORITY_NOT_FOUND",
  MANAGED_RETURN_CAPABILITY_INVALID: "SUBSCRIPTION_CLOSURE_MANAGED_RETURN_CAPABILITY_INVALID",
  SETTLEMENT_APPROVAL_REQUIRED: "SUBSCRIPTION_CLOSURE_SETTLEMENT_APPROVAL_REQUIRED",
  SETTLEMENT_APPROVAL_STALE: "SUBSCRIPTION_CLOSURE_SETTLEMENT_APPROVAL_STALE",
  SETTLEMENT_CLIENT_FACTS_FORBIDDEN: "SUBSCRIPTION_CLOSURE_SETTLEMENT_CLIENT_FACTS_FORBIDDEN",
  SETTLEMENT_CHRONOLOGY_INVALID: "SUBSCRIPTION_CLOSURE_SETTLEMENT_CHRONOLOGY_INVALID",
  SETTLEMENT_FACT_DRIFT: "SUBSCRIPTION_CLOSURE_SETTLEMENT_FACT_DRIFT",
  SETTLEMENT_NOT_RESOLVED: "SUBSCRIPTION_CLOSURE_SETTLEMENT_NOT_RESOLVED",
  SETTLEMENT_STATUS_CONFLICT: "SUBSCRIPTION_CLOSURE_SETTLEMENT_STATUS_CONFLICT",
  RECOVERY_CLIENT_AUTHORITY_FORBIDDEN: "SUBSCRIPTION_CLOSURE_RECOVERY_CLIENT_AUTHORITY_FORBIDDEN",
  RECOVERY_JOB_AUTHORITY_INVALID: "SUBSCRIPTION_CLOSURE_RECOVERY_JOB_AUTHORITY_INVALID",
  EARLY_TERMINATION_CLIENT_AUTHORITY_FORBIDDEN:
    "SUBSCRIPTION_CLOSURE_EARLY_TERMINATION_CLIENT_AUTHORITY_FORBIDDEN"
} as const;

export type PrepareNormalExpiryInput = Readonly<{
  decisionAt: Date;
  orderId: string;
  segmentId: string;
}>;

export type CompleteNormalExpiryInput = PrepareNormalExpiryInput &
  Readonly<{ vehicleReturnId: string }>;

export type NormalExpiryCompletion = Readonly<{
  closureCaseId: string;
  returnAssetWorkOrderId: string;
  returnHandoverWorkOrderId: string;
  returnManifestRevisionId: string;
}>;

export type ScheduleRecoveryAssessmentInput = Readonly<{
  closureCaseId: string;
  orderId: string;
  scheduledAt: Date;
}>;

export type AssessRecoveryJobInput = Readonly<{
  actorId: string;
  closureCaseId: string;
  governingBillId: string;
  governingDueDate: Date;
  jobId: string;
  jobKey: string;
  orderId: string;
}>;

const RECOVERY_ASSESSMENT_NO_OP_REASONS = [
  "VOLUNTARY_RETURNED",
  "OVERDUE_DEBT_SETTLED",
  "LIVE_DISPUTE",
  "APPROVED_EXTENSION"
] as const;

type RecoveryAssessmentNoOpReason = (typeof RECOVERY_ASSESSMENT_NO_OP_REASONS)[number];

export type RecoveryBusinessActionInput = Readonly<{
  action: "REJECT" | "PAUSE" | "RESUME" | "CANCEL" | "MANUAL_TAKEOVER";
  actorId: string;
  closureCaseId: string;
  idempotencyKey: string;
  occurredAt: Date;
  reason: string;
}>;

export type RequestRecoveryExecutionApprovalInput = Readonly<{
  actorId: string;
  closureCaseId: string;
  idempotencyKey: string;
  reason: string;
  requestedAt: Date;
}>;

export type DecideRecoveryExecutionApprovalInput = Readonly<{
  actorId: string;
  approvalId: string;
  closureCaseId: string;
  decision: "APPROVED" | "REJECTED";
  decisionComment: string;
  decidedAt: Date;
  expectedApprovalVersion: number;
  idempotencyKey: string;
}>;

export type ExecuteApprovedRecoveryInput = Readonly<{
  actorId: string;
  approvalId: string;
  closureCaseId: string;
  expectedApprovalVersion: number;
  idempotencyKey: string;
  occurredAt: Date;
}>;

export type RecordRecoveryExecutionInput = Readonly<{
  actorId: string;
  closureCaseId: string;
  costs: readonly Omit<
    AppendCostServiceCommand,
    "contractId" | "customerId" | "orderId" | "source" | "vehicleId" | "workOrderId"
  >[];
  evidence: readonly Omit<AppendEvidenceServiceCommand, "source" | "workOrderId">[];
  idempotencyKey: string;
  occurredAt: Date;
}>;

export type ArchiveRecoveryAuthorityInput = Readonly<{
  actorId: string;
  closureCaseId: string;
  idempotencyKey: string;
}>;

export type ArchivedRecoveryAuthority = Readonly<{
  archivedRevisionId: string;
  generatedRevisionId: string;
  signedFileHash: string;
  signedFileId: string;
  signedRevisionId: string;
  wrote: boolean;
}>;

export type PrepareManagedReturnInput = Readonly<{
  actorId: string;
  orderId: string;
  returnLocation: string | null;
  scheduledAt: Date | null;
}>;

export type CompleteManagedReturnInput = PrepareManagedReturnInput &
  Readonly<{ vehicleReturnId: string }>;

export type ConfirmManagedPhysicalReceiptInput = Readonly<{
  actorId: string;
  checklist: Readonly<Record<string, unknown>>;
  damages: readonly Readonly<{
    damageLevel: string;
    damageType: string;
    description: string;
    estimatedRepairAmount?: bigint | number | string;
    photoUrls?: readonly string[];
    responsibleParty?: string;
  }>[];
  orderId: string;
  physicalControlMode: "VOLUNTARY_RETURN" | "RECOVERY";
  remark: string | null;
  returnMileageKm: number;
  returnType: "NORMAL_RETURN" | "EARLY_TERMINATION";
  returnedAt: Date;
}>;

export type RecordManagedReturnInspectionInput = Readonly<{
  accepted: boolean;
  actorId: string;
  closureCaseId: string;
  costs: readonly Omit<
    AppendCostServiceCommand,
    "contractId" | "customerId" | "orderId" | "source" | "vehicleId" | "workOrderId"
  >[];
  evidence: readonly Omit<AppendEvidenceServiceCommand, "source" | "workOrderId">[];
  occurredAt: Date;
  reconditioningRequired: boolean;
}>;

export type ReleaseManagedInventoryInput = Readonly<{
  actorId: string;
  closureCaseId: string;
  occurredAt: Date;
  releaseReason: string;
}>;

export type ManagedSettlementInput = Readonly<{
  actorId: string;
  closureCaseId: string;
  idempotencyKey: string;
  occurredAt: Date;
  waiverApprovalId: string | null;
  writeOffApprovalId: string | null;
}>;

declare const managedReturnCapabilityBrand: unique symbol;
export type ManagedReturnTransactionCapability = Readonly<{
  [managedReturnCapabilityBrand]: true;
}>;

declare const normalExpiryCapabilityBrand: unique symbol;
export type NormalExpiryTransactionCapability = Readonly<{
  [normalExpiryCapabilityBrand]: true;
}>;

type NormalExpiryAuthority = Readonly<{
  actorId: string;
  contractId: string;
  customerId: string;
  leaseId: string;
  orderId: string;
  orderNo: string;
  segmentEndDate: Date;
  segmentId: string;
  vehicleId: string;
}>;

type NormalExpiryCapabilityState = Readonly<{
  assetCapability: AssetOperationsTransactionCapability;
  assetCommand: Parameters<typeof assetOperationsCreateAuthorityRequirement>[0];
  assetContext: Parameters<
    AssetOperationsService["attestCallerOwnedCreateAuthorityInTransaction"]
  >[3];
  assetWorkOrderId: string;
  assetSource: SubscriptionClosureSource;
  authorityAttestations: ReadonlyMap<string, ClosureAuthorityAttestation>;
  authoritySession: SubscriptionClosureAuthoritySession;
  authority: NormalExpiryAuthority;
  caseSource: SubscriptionClosureSource;
  caseSourceCapability: PreparedClosureSourceCapability;
  caseCommand: Parameters<SubscriptionClosureRepository["createPreparedCaseInTransaction"]>[2];
  closureCaseId: string;
  documentSource: SubscriptionClosureSource;
  documentSourceCapability: PreparedClosureSourceCapability;
  effectiveBoundaryCapability: EffectiveBoundaryTransactionCapability;
  handoverCapability: PreparedReturnInboundCapability;
  handoverWorkOrderId: string;
  handoverSource: SubscriptionClosureSource;
  input: PrepareNormalExpiryInput;
  occurredAt: Date;
  transaction: Prisma.TransactionClient;
  vehicleReturnId: string;
  manifestCommand: AppendSubscriptionClosureDocumentCommand;
}>;

type ManagedReturnCapabilityState = Readonly<{
  command: PrepareManagedReturnInput;
  handoverCapability: PreparedGovernedReturnInboundUpdateCapability;
  handoverWorkOrderId: string;
  transaction: Prisma.TransactionClient;
  vehicleReturnId: string;
}>;

@Injectable()
export class SubscriptionClosureService {
  private readonly normalExpiryCapabilities = new WeakMap<
    NormalExpiryTransactionCapability,
    NormalExpiryCapabilityState
  >();
  private readonly managedReturnCapabilities = new WeakMap<
    ManagedReturnTransactionCapability,
    ManagedReturnCapabilityState
  >();

  constructor(
    private readonly repository: SubscriptionClosureRepository,
    private readonly handoverWorkOrders: HandoverWorkOrderService,
    private readonly assetOperations: AssetOperationsService,
    private readonly auditService: AuditService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly assetFacts?: AssetFactsService,
    @Optional() private readonly assetAccounting?: AssetAccountingService,
    @Optional() private readonly vehicleMileage?: VehicleMileageService,
    @Optional() private readonly settlementResolver?: SubscriptionClosureSettlementResolver
  ) {}

  async prepareNormalExpiryInTransaction(
    tx: Prisma.TransactionClient,
    input: PrepareNormalExpiryInput
  ): Promise<NormalExpiryTransactionCapability> {
    const command = normalizePrepareInput(input);
    const handoverSource = source(command.segmentId, "return-inbound-handover");
    const assetSource = source(command.segmentId, "return-inbound-asset-work-order");
    const caseSource = source(command.segmentId, "normal-closure-case");
    const documentSource = source(command.segmentId, "return-manifest:1");
    const currentCase = await tx.subscriptionClosureCase.findFirst({
      select: {
        createSourceId: true,
        createSourceKey: true,
        createSourceType: true,
        createdBy: true,
        effectiveAt: true,
        id: true,
        returnAssetWorkOrderId: true,
        returnHandoverWorkOrderId: true,
        vehicleReturnId: true
      },
      where: { orderId: command.orderId, retiredAt: null }
    });
    if (
      currentCase &&
      (currentCase.createSourceType !== caseSource.type ||
        currentCase.createSourceId !== caseSource.id ||
        currentCase.createSourceKey !== caseSource.key)
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const authority = await this.loadNormalExpiryAuthority(tx, command, currentCase?.createdBy);
    let handoverSourceCapability: unknown;
    let assetCapability: AssetOperationsTransactionCapability | undefined;
    let caseSourceCapability: PreparedClosureSourceCapability | undefined;
    let documentSourceCapability: PreparedClosureSourceCapability | undefined;
    const sourcePreparations = [
      {
        prepare: async () => {
          caseSourceCapability = await this.repository.prepareSourceInTransaction(tx, caseSource);
        },
        source: caseSource
      },
      {
        prepare: async () => {
          assetCapability = await this.assetOperations.prepareCallerOwnedTransaction(
            tx,
            assetSource
          );
        },
        source: assetSource
      },
      {
        prepare: async () => {
          handoverSourceCapability =
            await this.handoverWorkOrders.prepareReturnInboundInTransaction(tx, {
              actorId: authority.actorId,
              orderId: authority.orderId,
              source: handoverSource
            });
        },
        source: handoverSource
      },
      {
        prepare: async () => {
          documentSourceCapability = await this.repository.prepareSourceInTransaction(
            tx,
            documentSource
          );
        },
        source: documentSource
      }
    ].sort((left, right) =>
      bytewiseCompare(sourceSortKey(left.source), sourceSortKey(right.source))
    );
    for (const preparation of sourcePreparations) await preparation.prepare();
    if (
      !handoverSourceCapability ||
      !assetCapability ||
      !caseSourceCapability ||
      !documentSourceCapability
    ) {
      throw serviceConflict("CAPABILITY_INVALID");
    }

    const currentReturn = await tx.vehicleReturn.findUnique({
      select: { id: true },
      where: { orderId: authority.orderId }
    });
    const vehicleReturnId = currentCase?.vehicleReturnId ?? currentReturn?.id ?? randomUUID();
    const handoverWorkOrderId = currentCase?.returnHandoverWorkOrderId ?? randomUUID();
    const assetWorkOrderId = currentCase?.returnAssetWorkOrderId ?? randomUUID();
    const closureCaseId = currentCase?.id ?? randomUUID();
    const occurredAt = currentCase ? new Date(currentCase.effectiveAt) : command.decisionAt;
    const handoverCommand = {
      actorId: authority.actorId,
      orderId: authority.orderId,
      source: handoverSource
    };
    const assetCommand = normalExpiryAssetCommand(
      authority,
      assetSource,
      occurredAt,
      vehicleReturnId
    );
    const assetContext = {
      actorId: authority.actorId,
      permissions: [],
      userAgent: "subscription-expiry"
    } as const;
    const caseCommand = normalExpiryCaseCommand(authority, caseSource, occurredAt, {
      assetWorkOrderId,
      handoverWorkOrderId,
      vehicleReturnId
    });
    const manifestDocumentSnapshot = returnManifestDocumentSnapshot({
      assetWorkOrderId,
      authority,
      caseNo: subscriptionClosureCaseNo(caseSource),
      closureCaseId,
      handoverWorkOrderId,
      vehicleReturnId
    });
    const currentManifest = currentCase
      ? await tx.subscriptionClosureCurrentDocument.findUnique({
          include: { documentRevision: true },
          where: {
            closureCaseId_documentType: {
              closureCaseId: currentCase.id,
              documentType: "RETURN_MANIFEST"
            }
          }
        })
      : null;
    const revisionOne = currentCase
      ? await tx.subscriptionClosureDocumentRevision.findFirst({
          where: {
            closureCaseId: currentCase.id,
            documentType: "RETURN_MANIFEST",
            revisionNumber: 1,
            sourceId: documentSource.id,
            sourceKey: documentSource.key,
            sourceType: documentSource.type
          }
        })
      : null;
    if (currentManifest && !revisionOne) throw serviceConflict("AUTHORITY_MISMATCH");
    const manifestPlan = revisionOne
      ? {
          command: replayManifestCommand(revisionOne, documentSource),
          creation: null,
          esignTask: null
        }
      : await planManifestAuthoritiesInTransaction(tx, {
          assetWorkOrderId,
          authority,
          caseNo: subscriptionClosureCaseNo(caseSource),
          closureCaseId,
          documentSnapshot: manifestDocumentSnapshot,
          documentSource,
          handoverWorkOrderId,
          vehicleReturnId
        });
    const manifestCommand = manifestPlan.command;
    if (revisionOne) {
      await assertReturnManifestEsignAuthority(
        tx,
        manifestCommand,
        authority,
        documentSource,
        manifestDocumentSnapshot,
        null
      );
    }
    const [changes, considerations] = await Promise.all([
      tx.subscriptionChangeOrder.findMany({
        select: { id: true },
        where: { sourceSegmentId: command.segmentId }
      }),
      tx.renewalConsideration.findMany({
        select: { id: true },
        where: { segmentId: command.segmentId }
      })
    ]);
    const locks: SubscriptionClosureAuthorityLock[] = [
      ...changes.map(({ id }) => ({
        id,
        mode: "UPDATE" as const,
        table: "subscription_change_order" as const
      })),
      ...considerations.map(({ id }) => ({
        id,
        mode: "UPDATE" as const,
        table: "renewal_consideration" as const
      })),
      ...(currentCase
        ? [
            {
              id: currentCase.id,
              mode: "UPDATE" as const,
              table: "subscription_closure_case" as const
            }
          ]
        : []),
      { id: authority.orderId, mode: "UPDATE", table: "subscription_order" },
      { id: authority.vehicleId, mode: "SHARE", table: "vehicle" },
      { id: authority.leaseId, mode: "UPDATE", table: "lease" },
      { id: authority.contractId, mode: "SHARE", table: "contract" },
      { id: authority.segmentId, mode: "UPDATE", table: "subscription_contract_segment" },
      ...(currentReturn
        ? [{ id: currentReturn.id, mode: "UPDATE" as const, table: "vehicle_return" as const }]
        : []),
      ...(currentCase?.returnHandoverWorkOrderId
        ? [
            {
              id: currentCase.returnHandoverWorkOrderId,
              mode: "UPDATE" as const,
              table: "vehicle_handover_work_order" as const
            }
          ]
        : []),
      ...(currentCase?.returnAssetWorkOrderId
        ? [
            {
              id: currentCase.returnAssetWorkOrderId,
              mode: "UPDATE" as const,
              table: "asset_work_order" as const
            }
          ]
        : []),
      ...(currentManifest
        ? [
            {
              id: currentManifest.documentRevision.id,
              mode: "UPDATE" as const,
              table: "subscription_closure_document_revision" as const
            },
            {
              id: currentManifest.documentRevision.sourceFileId,
              mode: "SHARE" as const,
              table: "file_object" as const
            },
            {
              id: currentManifest.documentRevision.contractESignTaskId,
              mode: "SHARE" as const,
              table: "contract_esign_task" as const
            }
          ]
        : []),
      { id: manifestCommand.sourceFileId, mode: "SHARE", table: "file_object" },
      {
        id: manifestCommand.contractESignTaskId,
        mode: "SHARE",
        table: "contract_esign_task"
      },
      { id: authority.customerId, mode: "SHARE", table: "customer" },
      { id: authority.actorId, mode: "SHARE", table: "user" }
    ];
    const authoritySession = this.repository.createAuthoritySessionInTransaction(tx);
    const effectiveBoundary = await subscriptionEffectiveBoundaryOwner.prepareInTransaction(
      tx,
      authoritySession,
      {
        boundaryAt: authority.segmentEndDate,
        occurredAt,
        orderId: authority.orderId
      }
    );
    const requirements = [
      this.assetOperations.createAuthorityRequirement(
        authoritySession,
        assetCommand,
        authority.actorId,
        assetWorkOrderId
      ),
      this.repository.bindAuthorityRequirement(
        authoritySession,
        subscriptionClosureCaseAuthorityRequirement(caseCommand, closureCaseId)
      ),
      this.handoverWorkOrders.createReturnInboundAuthorityRequirement(
        authoritySession,
        handoverCommand,
        handoverWorkOrderId
      ),
      this.repository.bindAuthorityRequirement(
        authoritySession,
        subscriptionClosureDocumentAuthorityRequirement(manifestCommand)
      ),
      effectiveBoundary.requirement
    ];
    const authorityAttestations = await this.repository.prepareAuthorityInTransaction(
      tx,
      authoritySession,
      [...locks, ...effectiveBoundary.requirement.locks],
      requirements
    );
    const lockedAuthority = await this.loadNormalExpiryAuthority(
      tx,
      command,
      currentCase?.createdBy
    );
    if (!sameAuthority(authority, lockedAuthority)) throw serviceConflict("AUTHORITY_MISMATCH");
    const lockedCase = await tx.subscriptionClosureCase.findFirst({
      select: { effectiveAt: true, id: true },
      where: { orderId: authority.orderId, retiredAt: null }
    });
    if (lockedCase?.id !== currentCase?.id) throw serviceConflict("AUTHORITY_MISMATCH");
    if (revisionOne) {
      await assertReturnManifestEsignAuthority(
        tx,
        manifestCommand,
        authority,
        documentSource,
        manifestDocumentSnapshot,
        null
      );
    }
    if (manifestPlan.creation) {
      const manifestAuthorities = await createManifestAuthoritiesInTransaction(
        tx,
        manifestPlan.command,
        manifestPlan.creation,
        authority
      );
      await assertReturnManifestEsignAuthority(
        tx,
        manifestCommand,
        authority,
        documentSource,
        manifestDocumentSnapshot,
        manifestAuthorities
      );
    }
    const handoverCapability =
      await this.handoverWorkOrders.attestReturnInboundAuthorityInTransaction(
        tx,
        authoritySession,
        handoverCommand,
        handoverSourceCapability as never,
        requiredAttestation(authorityAttestations, "handover-create"),
        handoverWorkOrderId
      );

    const capability = Object.freeze({}) as NormalExpiryTransactionCapability;
    this.normalExpiryCapabilities.set(
      capability,
      Object.freeze({
        assetCapability,
        assetCommand,
        assetContext,
        assetSource,
        assetWorkOrderId,
        authorityAttestations,
        authoritySession,
        authority: lockedAuthority,
        caseCommand,
        closureCaseId,
        caseSource,
        caseSourceCapability,
        documentSource,
        documentSourceCapability,
        effectiveBoundaryCapability: effectiveBoundary.capability,
        handoverCapability,
        handoverWorkOrderId,
        handoverSource,
        input: command,
        manifestCommand,
        occurredAt,
        transaction: tx,
        vehicleReturnId
      })
    );
    return capability;
  }

  async completeNormalExpiryInTransaction(
    tx: Prisma.TransactionClient,
    input: CompleteNormalExpiryInput,
    capability: NormalExpiryTransactionCapability
  ): Promise<NormalExpiryCompletion> {
    const state = this.takeNormalExpiryCapability(capability);
    const command = normalizeCompleteInput(input);
    if (
      state.transaction !== tx ||
      state.input.orderId !== command.orderId ||
      state.input.segmentId !== command.segmentId ||
      state.input.decisionAt.getTime() !== command.decisionAt.getTime() ||
      state.vehicleReturnId !== command.vehicleReturnId
    ) {
      throw serviceConflict("CAPABILITY_INVALID");
    }
    const vehicleReturn = await tx.vehicleReturn.findUnique({
      select: { customerId: true, deletedAt: true, id: true, orderId: true, vehicleId: true },
      where: { id: command.vehicleReturnId }
    });
    if (!vehicleReturn || vehicleReturn.deletedAt) throw serviceConflict("AUTHORITY_NOT_FOUND");
    if (
      vehicleReturn.orderId !== state.authority.orderId ||
      vehicleReturn.vehicleId !== state.authority.vehicleId ||
      vehicleReturn.customerId !== state.authority.customerId
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }

    const preparedAsset = await this.assetOperations.attestCallerOwnedCreateAuthorityInTransaction(
      tx,
      state.authoritySession,
      state.assetCommand,
      state.assetContext,
      state.assetCapability,
      requiredAttestation(state.authorityAttestations, "asset-create"),
      state.assetWorkOrderId
    );
    const specialist = await this.handoverWorkOrders.createPreparedReturnInboundInTransaction(
      tx,
      state.handoverCapability
    );
    const common = await this.assetOperations.createPreparedWorkOrderInTransaction(
      tx,
      preparedAsset
    );
    if (
      specialist.id !== state.handoverWorkOrderId ||
      common.workOrder.id !== state.assetWorkOrderId
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const createdCase = await this.repository.createPreparedCaseInTransaction(
      tx,
      state.authoritySession,
      state.caseCommand,
      state.caseSourceCapability,
      requiredAttestation(state.authorityAttestations, "case-create"),
      state.closureCaseId,
      this.closureAudit(state.authority.actorId)
    );
    if (createdCase.outcome.id !== state.closureCaseId) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const manifest = (
      await this.repository.appendPreparedDocumentRevisionInTransaction(
        tx,
        state.authoritySession,
        state.manifestCommand,
        state.documentSourceCapability,
        requiredAttestation(state.authorityAttestations, "manifest-create"),
        this.closureAudit(state.manifestCommand.actorId)
      )
    ).outcome;
    if (createdCase.wrote) {
      await subscriptionEffectiveBoundaryOwner.applyPreparedInTransaction(
        tx,
        state.authoritySession,
        state.effectiveBoundaryCapability,
        requiredAttestation(state.authorityAttestations, "effective-boundary-stop")
      );
    } else {
      await subscriptionEffectiveBoundaryOwner.validatePreparedInTransaction(
        tx,
        state.authoritySession,
        state.effectiveBoundaryCapability,
        requiredAttestation(state.authorityAttestations, "effective-boundary-stop")
      );
    }
    return Object.freeze({
      closureCaseId: createdCase.outcome.id,
      returnAssetWorkOrderId: common.workOrder.id,
      returnHandoverWorkOrderId: specialist.id,
      returnManifestRevisionId: manifest.id
    });
  }

  async scheduleRecoveryAssessmentInTransaction(
    tx: Prisma.TransactionClient,
    input: ScheduleRecoveryAssessmentInput
  ) {
    const closureCase = await tx.subscriptionClosureCase.findUnique({
      select: {
        closureType: true,
        createdBy: true,
        id: true,
        orderId: true,
        physicalControlMode: true,
        status: true
      },
      where: { id: input.closureCaseId }
    });
    if (
      !closureCase ||
      closureCase.orderId !== input.orderId ||
      closureCase.closureType !== "NORMAL_COMPLETION" ||
      closureCase.physicalControlMode !== "VOLUNTARY_RETURN" ||
      closureCase.status !== "PREPARING_RETURN"
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const boundary = await tx.receivableBill.findFirst({
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      select: { dueDate: true, id: true },
      where: {
        billStatus: { in: [BillStatus.PENDING, BillStatus.PARTIALLY_PAID, BillStatus.OVERDUE] },
        deletedAt: null,
        dueDate: { lt: input.scheduledAt },
        orderId: input.orderId,
        remainingAmount: { gt: 0n }
      }
    });
    if (!boundary) return Object.freeze({ scheduled: false as const });
    const dueDate = boundary.dueDate.toISOString();
    const job = await tx.subscriptionAutomationJob.upsert({
      create: {
        availableAt: recoveryAssessmentAvailableAt(boundary.dueDate),
        billId: boundary.id,
        idempotencyKey: `closure-recovery-assessment:${closureCase.id}:D7`,
        jobType: SubscriptionAutomationJobType.CLOSURE_RECOVERY_ASSESSMENT_D7,
        orderId: closureCase.orderId,
        payload: {
          actorId: closureCase.createdBy,
          billId: boundary.id,
          closureCaseId: closureCase.id,
          dueDate,
          snapshotVersion: 1
        }
      },
      update: {},
      where: { idempotencyKey: `closure-recovery-assessment:${closureCase.id}:D7` }
    });
    const immutablePayload = jsonObject(job.payload);
    const immutableBillId = immutablePayload.billId;
    const immutableDueDate = immutablePayload.dueDate;
    const immutableDueDateValue =
      typeof immutableDueDate === "string" ? new Date(immutableDueDate) : null;
    if (
      job.idempotencyKey !== `closure-recovery-assessment:${closureCase.id}:D7` ||
      job.jobType !== SubscriptionAutomationJobType.CLOSURE_RECOVERY_ASSESSMENT_D7 ||
      job.orderId !== closureCase.orderId ||
      typeof immutableBillId !== "string" ||
      immutableBillId !== job.billId ||
      typeof immutableDueDate !== "string" ||
      !(immutableDueDateValue instanceof Date) ||
      Number.isNaN(immutableDueDateValue.getTime()) ||
      job.availableAt.getTime() !==
        recoveryAssessmentAvailableAt(immutableDueDateValue).getTime() ||
      immutablePayload.actorId !== closureCase.createdBy ||
      immutablePayload.closureCaseId !== closureCase.id ||
      immutablePayload.snapshotVersion !== 1
    ) {
      throw serviceConflict("RECOVERY_JOB_AUTHORITY_INVALID");
    }
    return Object.freeze({
      availableAt: job.availableAt,
      billId: immutableBillId,
      dueDate: immutableDueDate,
      jobId: job.id,
      scheduled: true as const
    });
  }

  async assessRecoveryJob(input: AssessRecoveryJobInput) {
    if (
      Object.prototype.hasOwnProperty.call(input, "authoritySnapshot") ||
      Object.prototype.hasOwnProperty.call(input, "authoritySnapshotHash")
    ) {
      throw serviceConflict("RECOVERY_CLIENT_AUTHORITY_FORBIDDEN");
    }
    if (!this.prisma) throw serviceConflict("RECOVERY_JOB_AUTHORITY_INVALID");
    const command = normalizeRecoveryJobInput(input);
    return this.prisma.$transaction(
      async (tx) => this.assessRecoveryJobInTransaction(tx, command),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  private async assessRecoveryJobInTransaction(
    tx: Prisma.TransactionClient,
    command: AssessRecoveryJobInput
  ) {
    const now = await readDatabaseClock(tx);
    const job = await tx.subscriptionAutomationJob.findUnique({ where: { id: command.jobId } });
    const payload = jsonObject(job?.payload);
    if (
      !job ||
      job.jobType !== SubscriptionAutomationJobType.CLOSURE_RECOVERY_ASSESSMENT_D7 ||
      job.idempotencyKey !== command.jobKey ||
      job.orderId !== command.orderId ||
      job.billId !== command.governingBillId ||
      job.availableAt.getTime() > now.getTime() ||
      payload.actorId !== command.actorId ||
      payload.billId !== command.governingBillId ||
      payload.closureCaseId !== command.closureCaseId ||
      payload.dueDate !== command.governingDueDate.toISOString() ||
      payload.snapshotVersion !== 1
    ) {
      throw serviceConflict("RECOVERY_JOB_AUTHORITY_INVALID");
    }
    const source = {
      id: command.jobId,
      key: command.jobKey,
      type: "CLOSURE_RECOVERY_ASSESSMENT_D7"
    } as const;
    const sourceCapability = await this.repository.prepareSourceInTransaction(tx, source);
    const priorReceipt = await tx.subscriptionClosureCommandReceipt.findUnique({
      where: {
        sourceType_sourceId_sourceKey: {
          sourceId: source.id,
          sourceKey: source.key,
          sourceType: source.type
        }
      }
    });
    if (priorReceipt) {
      const priorPayload = jsonObject(priorReceipt.payloadSnapshot);
      const priorDetail = jsonObject(priorPayload.detailSnapshot);
      const priorReason = recoveryAssessmentNoOpReason(priorDetail.reason);
      if (
        priorPayload.eventType === "NOTE_ADDED" &&
        priorDetail.recoveryAction === "ASSESSMENT_NO_OP" &&
        priorReason
      ) {
        return Object.freeze({ action: "NO_OP" as const, reason: priorReason });
      }
      if (priorReceipt.commandType !== "ESCALATE_RECOVERY") throw closureSourceConflict();
      return Object.freeze({ action: "ASSESSED" as const, wrote: false });
    }
    const observedClosureCase = await tx.subscriptionClosureCase.findUnique({
      where: { id: command.closureCaseId }
    });
    if (
      !observedClosureCase ||
      observedClosureCase.orderId !== command.orderId ||
      observedClosureCase.createdBy !== command.actorId
    ) {
      throw serviceConflict("RECOVERY_JOB_AUTHORITY_INVALID");
    }
    const [
      observedVehicleReturn,
      observedOverdueBills,
      observedCollectionCases,
      observedExtension,
      observedLegalRestrictions
    ] = await Promise.all([
      observedClosureCase.vehicleReturnId
        ? tx.vehicleReturn.findUnique({ where: { id: observedClosureCase.vehicleReturnId } })
        : Promise.resolve(null),
      tx.receivableBill.findMany({
        orderBy: [{ dueDate: "asc" }, { id: "asc" }],
        where: {
          billStatus: {
            in: [BillStatus.PENDING, BillStatus.PARTIALLY_PAID, BillStatus.OVERDUE]
          },
          deletedAt: null,
          dueDate: { lt: now },
          orderId: observedClosureCase.orderId,
          remainingAmount: { gt: 0n }
        }
      }),
      tx.collectionCase.findMany({
        include: {
          actions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
          bills: { include: { bill: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: { deletedAt: null, orderId: observedClosureCase.orderId }
      }),
      tx.subscriptionContractSegment.findFirst({
        orderBy: [{ sequenceNo: "asc" }, { id: "asc" }],
        where: {
          orderId: observedClosureCase.orderId,
          status: { in: ["SCHEDULED", "ACTIVE"] }
        }
      }),
      tx.vehicleOperationalRestriction.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: {
          restrictionType: "LEGAL_HOLD",
          status: "ACTIVE",
          vehicleId: observedClosureCase.vehicleId
        }
      })
    ]);
    await this.repository.lockAuthorityRows(tx, [
      {
        id: observedClosureCase.id,
        mode: "UPDATE",
        table: "subscription_closure_case"
      },
      { id: observedClosureCase.orderId, mode: "UPDATE", table: "subscription_order" },
      { id: observedClosureCase.vehicleId, mode: "UPDATE", table: "vehicle" },
      ...(observedVehicleReturn
        ? [
            {
              id: observedVehicleReturn.id,
              mode: "UPDATE" as const,
              table: "vehicle_return" as const
            }
          ]
        : []),
      ...observedCollectionCases.map(({ id }) => ({
        id,
        mode: "UPDATE" as const,
        table: "collection_case" as const
      })),
      ...observedCollectionCases.flatMap(({ actions }) =>
        actions.map(({ id }) => ({
          id,
          mode: "UPDATE" as const,
          table: "collection_action" as const
        }))
      ),
      ...(observedExtension
        ? [
            {
              id: observedExtension.id,
              mode: "UPDATE" as const,
              table: "subscription_contract_segment" as const
            }
          ]
        : []),
      ...observedLegalRestrictions.map(({ id }) => ({
        id,
        mode: "UPDATE" as const,
        table: "vehicle_operational_restriction" as const
      })),
      ...observedOverdueBills.map(({ id }) => ({
        id,
        mode: "UPDATE" as const,
        table: "receivable_bill" as const
      })),
      { id: command.actorId, mode: "SHARE", table: "user" }
    ]);
    const closureCase = await tx.subscriptionClosureCase.findUnique({
      where: { id: command.closureCaseId }
    });
    if (
      !closureCase ||
      closureCase.orderId !== command.orderId ||
      closureCase.createdBy !== command.actorId
    ) {
      throw serviceConflict("RECOVERY_JOB_AUTHORITY_INVALID");
    }
    const [vehicleReturn, vehicle, overdueBills, collectionCases, extension, legalRestrictions] =
      await Promise.all([
        closureCase.vehicleReturnId
          ? tx.vehicleReturn.findUnique({ where: { id: closureCase.vehicleReturnId } })
          : Promise.resolve(null),
        tx.vehicle.findUnique({ where: { id: closureCase.vehicleId } }),
        tx.receivableBill.findMany({
          orderBy: [{ dueDate: "asc" }, { id: "asc" }],
          where: {
            billStatus: {
              in: [BillStatus.PENDING, BillStatus.PARTIALLY_PAID, BillStatus.OVERDUE]
            },
            deletedAt: null,
            dueDate: { lt: now },
            orderId: closureCase.orderId,
            remainingAmount: { gt: 0n }
          }
        }),
        tx.collectionCase.findMany({
          include: {
            actions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
            bills: { include: { bill: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          where: { deletedAt: null, orderId: closureCase.orderId }
        }),
        tx.subscriptionContractSegment.findFirst({
          orderBy: [{ sequenceNo: "asc" }, { id: "asc" }],
          where: {
            orderId: closureCase.orderId,
            status: { in: ["SCHEDULED", "ACTIVE"] }
          }
        }),
        tx.vehicleOperationalRestriction.findMany({
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          where: {
            restrictionType: "LEGAL_HOLD",
            status: "ACTIVE",
            vehicleId: closureCase.vehicleId
          }
        })
      ]);
    if (
      closureCase.physicalControlledAt ||
      vehicleReturn?.returnedAt ||
      vehicleReturn?.returnStatus === "CONFIRMED" ||
      (vehicle && !["LEASED", "RENTED"].includes(vehicle.status))
    ) {
      return this.persistRecoveryAssessmentNoOp(
        tx,
        command,
        closureCase,
        now,
        source,
        sourceCapability,
        "VOLUNTARY_RETURNED"
      );
    }
    if (overdueBills.length === 0) {
      return this.persistRecoveryAssessmentNoOp(
        tx,
        command,
        closureCase,
        now,
        source,
        sourceCapability,
        "OVERDUE_DEBT_SETTLED"
      );
    }
    const liveDisputes = collectionCases.flatMap((collectionCase) => {
      if (collectionCase.caseStatus !== "ACTIVE") return [];
      const latest = collectionCase.actions.at(-1);
      return latest?.actionType === "CUSTOMER_DISPUTE" || latest?.actionResult === "DISPUTED"
        ? [latest]
        : [];
    });
    if (liveDisputes.length > 0) {
      return this.persistRecoveryAssessmentNoOp(
        tx,
        command,
        closureCase,
        now,
        source,
        sourceCapability,
        "LIVE_DISPUTE"
      );
    }
    if (extension) {
      return this.persistRecoveryAssessmentNoOp(
        tx,
        command,
        closureCase,
        now,
        source,
        sourceCapability,
        "APPROVED_EXTENSION"
      );
    }
    if (
      closureCase.closureType !== "NORMAL_COMPLETION" ||
      closureCase.physicalControlMode !== "VOLUNTARY_RETURN" ||
      closureCase.finalDisposition !== "COMPLETE" ||
      closureCase.status !== "PREPARING_RETURN" ||
      !vehicle
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const detailSnapshot = {
      assessedAt: now,
      collectionCases: collectionCases.map((item) => ({
        actions: item.actions.map((action) => ({
          actionResult: action.actionResult,
          actionType: action.actionType,
          content: action.content,
          createdAt: action.createdAt,
          id: action.id,
          promisedAmount: action.promisedAmount,
          promisedPayAt: action.promisedPayAt
        })),
        caseNo: item.caseNo,
        caseStatus: item.caseStatus,
        id: item.id,
        totalOverdueAmount: item.totalOverdueAmount
      })),
      extension,
      governingBill: {
        billId: command.governingBillId,
        dueDate: command.governingDueDate
      },
      legalRestrictions: legalRestrictions.map((item) => ({
        conditionsSnapshot: item.conditionsSnapshot,
        id: item.id,
        restrictionType: item.restrictionType,
        status: item.status
      })),
      liveDisputes: liveDisputes.map((item) => ({
        actionResult: item.actionResult,
        actionType: item.actionType,
        createdAt: item.createdAt,
        id: item.id
      })),
      overdueBills: overdueBills.map((bill) => ({
        billNo: bill.billNo,
        billStatus: bill.billStatus,
        dueDate: bill.dueDate,
        id: bill.id,
        remainingAmount: bill.remainingAmount
      })),
      plannedRecoveryAssetWorkOrderId: stableRecoveryWorkOrderId(command.jobId),
      vehicle: {
        id: vehicle.id,
        status: vehicle.status,
        vehicleNo: vehicle.vehicleNo
      },
      vehicleReturn: vehicleReturn
        ? {
            id: vehicleReturn.id,
            returnStatus: vehicleReturn.returnStatus,
            returnedAt: vehicleReturn.returnedAt
          }
        : null
    };
    const outcome = await this.repository.escalatePreparedRecoveryInTransaction(
      tx,
      {
        actorId: command.actorId,
        closureCaseId: closureCase.id,
        detailSnapshot,
        expectedStatus: "PREPARING_RETURN",
        expectedVersion: closureCase.version,
        occurredAt: now,
        source
      },
      sourceCapability,
      this.closureAudit(command.actorId)
    );
    return Object.freeze({ action: "ASSESSED" as const, wrote: outcome.wrote });
  }

  private async persistRecoveryAssessmentNoOp(
    tx: Prisma.TransactionClient,
    command: AssessRecoveryJobInput,
    closureCase: Readonly<{ id: string; status: SubscriptionClosureStatus; version: number }>,
    occurredAt: Date,
    source: SubscriptionClosureSource,
    sourceCapability: PreparedClosureSourceCapability,
    reason: RecoveryAssessmentNoOpReason
  ) {
    await this.repository.appendSourcePreparedEventInTransaction(
      tx,
      {
        actorId: command.actorId,
        afterStatus: closureCase.status,
        closureCaseId: closureCase.id,
        detailSnapshot: {
          governingBill: {
            billId: command.governingBillId,
            dueDate: command.governingDueDate
          },
          reason,
          recoveryAction: "ASSESSMENT_NO_OP"
        },
        eventType: "NOTE_ADDED",
        expectedStatus: closureCase.status,
        expectedVersion: closureCase.version,
        occurredAt,
        source
      },
      sourceCapability,
      this.closureAudit(command.actorId)
    );
    return Object.freeze({ action: "NO_OP" as const, reason });
  }

  async archiveRecoveryAuthority(
    input: ArchiveRecoveryAuthorityInput
  ): Promise<ArchivedRecoveryAuthority> {
    if (!this.prisma) throw serviceConflict("RECOVERY_JOB_AUTHORITY_INVALID");
    const command = normalizeArchiveRecoveryAuthority(input);
    return this.prisma.$transaction(
      async (tx) => {
        const ids = recoveryAuthorityIds(command.closureCaseId, command.idempotencyKey);
        const sources = recoveryAuthoritySources(command.closureCaseId, command.idempotencyKey);
        const sourceCapabilities = new Map<string, PreparedClosureSourceCapability>();
        for (const lifecycleSource of [...sources].sort((left, right) =>
          bytewiseCompare(sourceSortKey(left), sourceSortKey(right))
        )) {
          sourceCapabilities.set(
            lifecycleSource.key,
            await this.repository.prepareSourceInTransaction(tx, lifecycleSource)
          );
        }

        const replayCandidateCount = await tx.subscriptionClosureDocumentRevision.count({
          where: {
            id: { in: [ids.generatedRevisionId, ids.signedRevisionId, ids.archivedRevisionId] }
          }
        });
        if (replayCandidateCount > 0) {
          await this.repository.lockAuthorityRows(tx, recoveryAuthorityReplayLocks(command, ids));
          const replay = await validateRecoveryAuthorityChainInTransaction(
            tx,
            command,
            ids,
            sources
          );
          if (!replay) throw serviceConflict("AUTHORITY_MISMATCH");
          return Object.freeze({ ...replay, wrote: false });
        }

        const databaseClock = await readDatabaseClock(tx);
        const observed = await resolveRecoveryAuthorityDraft(
          tx,
          command.closureCaseId,
          databaseClock
        );
        assertRecoveryAuthorityDraftActionable(observed);
        const documentSnapshot = recoveryAuthorityDocumentSnapshot(observed);
        const canonicalDocument = canonicalSubscriptionClosureJson(documentSnapshot);
        const sourceFileHash = createHash("sha256").update(canonicalDocument).digest("hex");
        const sourceObjectKey = `subscription-closure/${command.closureCaseId}/${ids.generatedRevisionId}-recovery-authority.json`;
        const signedObjectKey = `subscription-closure/${command.closureCaseId}/${ids.signedRevisionId}-recovery-authority.signed.json`;
        const sourceDocumentName = `${observed.closureCase.caseNo}-${ids.generatedRevisionId}-recovery-authority.json`;
        const signedDocumentName = `${observed.closureCase.caseNo}-${ids.signedRevisionId}-recovery-authority.signed.json`;
        const signedEnvelope = recoveryAuthoritySignedEnvelope({
          actorId: command.actorId,
          completedAt: databaseClock,
          documentSnapshotHash: sourceFileHash,
          signedFileId: ids.signedFileId,
          sourceFileHash,
          sourceFileId: ids.sourceFileId,
          sources
        });
        const canonicalSignedEnvelope = canonicalSubscriptionClosureJson(signedEnvelope);
        const signedFileHash = createHash("sha256").update(canonicalSignedEnvelope).digest("hex");
        const commands = recoveryAuthorityDocumentCommands({
          actorId: command.actorId,
          closureCaseId: command.closureCaseId,
          databaseClock,
          documentSnapshot,
          expectedVersion: observed.closureCase.version,
          ids,
          signedFileHash,
          sourceFileHash,
          sources
        });
        const commonLocks: readonly SubscriptionClosureAuthorityLock[] = [
          {
            id: observed.closureCase.id,
            mode: "UPDATE",
            table: "subscription_closure_case"
          },
          ...observed.contextLocks,
          { id: observed.closureCase.contractId, mode: "SHARE", table: "contract" },
          { id: observed.closureCase.customerId, mode: "SHARE", table: "customer" },
          { id: command.actorId, mode: "SHARE", table: "user" }
        ];
        const generatedLocks = commonLocks;
        const signedLocks: readonly SubscriptionClosureAuthorityLock[] = [
          ...commonLocks,
          {
            id: ids.generatedRevisionId,
            mode: "SHARE",
            table: "subscription_closure_document_revision"
          }
        ];
        const archivedLocks: readonly SubscriptionClosureAuthorityLock[] = [
          ...commonLocks,
          {
            id: ids.signedRevisionId,
            mode: "SHARE",
            table: "subscription_closure_document_revision"
          }
        ];
        const requirementPlans = [
          {
            command: commands.generated,
            extraLocks: generatedLocks,
            key: "recovery-authority-generated"
          },
          {
            command: commands.signed,
            extraLocks: signedLocks,
            key: "recovery-authority-signed"
          },
          {
            command: commands.archived,
            extraLocks: archivedLocks,
            key: "recovery-authority-archived"
          }
        ] as const;
        const session = this.repository.createAuthoritySessionInTransaction(tx);
        const requirements = requirementPlans.map(({ command: documentCommand, extraLocks, key }) =>
          this.repository.bindAuthorityRequirement(
            session,
            subscriptionClosureDocumentAuthorityRequirement(documentCommand, key, extraLocks)
          )
        );
        const attestations = await this.repository.prepareAuthorityInTransaction(
          tx,
          session,
          requirements.flatMap(({ locks }) => locks),
          requirements
        );
        const locked = await resolveRecoveryAuthorityDraft(
          tx,
          command.closureCaseId,
          databaseClock
        );
        assertRecoveryAuthorityDraftActionable(locked);
        if (recoveryAuthorityDraftIdentity(locked) !== recoveryAuthorityDraftIdentity(observed)) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        const collisions = await Promise.all([
          tx.fileObject.count({ where: { id: { in: [ids.sourceFileId, ids.signedFileId] } } }),
          tx.contractESignTask.count({ where: { id: ids.esignTaskId } }),
          tx.subscriptionClosureDocumentRevision.count({
            where: {
              id: {
                in: [ids.generatedRevisionId, ids.signedRevisionId, ids.archivedRevisionId]
              }
            }
          }),
          tx.subscriptionClosureCurrentDocument.count({
            where: {
              closureCaseId: command.closureCaseId,
              documentType: "RECOVERY_AUTHORITY"
            }
          })
        ]);
        if (collisions.some((count) => count !== 0)) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }

        await tx.fileObject.createMany({
          data: [
            {
              bucket: "subscription-closure",
              id: ids.sourceFileId,
              mimeType: "application/json",
              objectKey: sourceObjectKey,
              originalName: sourceDocumentName,
              sizeBytes: BigInt(Buffer.byteLength(canonicalDocument)),
              uploadedBy: command.actorId
            },
            {
              bucket: "subscription-closure",
              id: ids.signedFileId,
              mimeType: "application/json",
              objectKey: signedObjectKey,
              originalName: signedDocumentName,
              sizeBytes: BigInt(Buffer.byteLength(canonicalSignedEnvelope)),
              uploadedBy: command.actorId
            }
          ]
        });
        await tx.contractESignTask.create({
          data: {
            completedAt: databaseClock,
            contractId: locked.closureCase.contractId,
            createdBy: command.actorId,
            customerId: locked.closureCase.customerId,
            documentName: sourceDocumentName,
            documentObjectKey: sourceObjectKey,
            documentType: ESignDocumentType.RECOVERY_AUTHORITY,
            id: ids.esignTaskId,
            orderId: locked.closureCase.orderId,
            provider: ESignProviderType.OTHER,
            providerEnvelopeId: ids.esignEnvelopeId,
            providerTaskId: ids.esignProviderTaskId,
            requestSnapshot: recoveryAuthorityEsignRequest({
              documentSnapshotHash: sourceFileHash,
              ids,
              sourceFileHash,
              sources
            }),
            responseSnapshot: recoveryAuthorityEsignResponse({
              actorId: command.actorId,
              completedAt: databaseClock,
              ids,
              signedFileHash
            }),
            signedDocumentObjectKey: signedObjectKey,
            signingStage: ESignSigningStage.STAGE5_RECOVERY_AUTHORITY,
            sourceId: sources[2].id,
            sourceKey: sources[2].key,
            sourceType: sources[2].type,
            taskNo: `ESG-REC-${ids.esignTaskId}`,
            taskStatus: ESignTaskStatus.COMPLETED,
            updatedBy: command.actorId
          }
        });

        for (const plan of requirementPlans) {
          await this.repository.appendPreparedDocumentRevisionInTransaction(
            tx,
            session,
            plan.command,
            requiredPreparedSource(sourceCapabilities, plan.command.source.key),
            requiredAttestation(attestations, plan.key),
            this.closureAudit(command.actorId),
            plan.key,
            plan.extraLocks
          );
        }
        const created = await validateRecoveryAuthorityChainInTransaction(
          tx,
          command,
          ids,
          sources
        );
        if (!created) throw serviceConflict("AUTHORITY_MISMATCH");
        return Object.freeze({ ...created, wrote: true });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  async actOnRecovery(input: RecoveryBusinessActionInput) {
    if (!this.prisma) throw serviceConflict("RECOVERY_JOB_AUTHORITY_INVALID");
    const command = normalizeRecoveryBusinessAction(input);
    const commandFingerprint = createHash("sha256")
      .update(canonicalSubscriptionClosureJson(command as never))
      .digest("hex");
    return this.prisma.$transaction(
      async (tx) => {
        const source = {
          id: command.closureCaseId,
          key: `recovery-action:${command.idempotencyKey}`,
          type: "SUBSCRIPTION_CLOSURE_RECOVERY"
        } as const;
        const priorReceipt = await tx.subscriptionClosureCommandReceipt.findUnique({
          where: {
            sourceType_sourceId_sourceKey: {
              sourceId: source.id,
              sourceKey: source.key,
              sourceType: source.type
            }
          }
        });
        if (priorReceipt) {
          const priorPayload = jsonObject(priorReceipt.payloadSnapshot);
          const priorDetail = jsonObject(priorPayload.detailSnapshot);
          if (priorDetail.recoveryCommandFingerprint !== commandFingerprint) {
            throw closureSourceConflict();
          }
          return Object.freeze({ action: command.action, wrote: false });
        }
        const closureCase = await tx.subscriptionClosureCase.findUnique({
          where: { id: command.closureCaseId }
        });
        if (
          !closureCase ||
          closureCase.physicalControlMode !== "RECOVERY" ||
          closureCase.finalDisposition !== "TERMINATE"
        ) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        let afterStatus:
          | "REJECTED"
          | "PAUSED"
          | "CANCELLED"
          | "MANUAL_TAKEOVER"
          | typeof closureCase.status;
        let stageMemory: Readonly<Record<string, string>> = {};
        switch (command.action) {
          case "REJECT":
            afterStatus = "REJECTED";
            break;
          case "CANCEL":
            afterStatus = "CANCELLED";
            break;
          case "MANUAL_TAKEOVER":
            afterStatus = "MANUAL_TAKEOVER";
            break;
          case "PAUSE":
            afterStatus = "PAUSED";
            stageMemory = {
              pausedFromStatus: closureCase.status,
              recoveryAction: "PAUSE"
            };
            break;
          case "RESUME": {
            if (closureCase.status !== "PAUSED") throw serviceConflict("AUTHORITY_MISMATCH");
            const pauseEvent = await tx.subscriptionClosureEvent.findFirst({
              orderBy: [{ sequence: "desc" }, { id: "desc" }],
              select: { detailSnapshot: true },
              where: { afterStatus: "PAUSED", closureCaseId: closureCase.id }
            });
            const pauseDetail = jsonObject(pauseEvent?.detailSnapshot);
            const remembered = pauseDetail.pausedFromStatus;
            if (typeof remembered !== "string" || remembered === "PAUSED") {
              throw serviceConflict("AUTHORITY_MISMATCH");
            }
            afterStatus = remembered as typeof closureCase.status;
            stageMemory = { recoveryAction: "RESUME", resumedStage: remembered };
            break;
          }
        }
        const outcome = await this.repository.appendEvent(
          tx,
          {
            actorId: command.actorId,
            afterStatus,
            closureCaseId: closureCase.id,
            detailSnapshot: {
              ...stageMemory,
              reason: command.reason,
              recoveryAction: stageMemory.recoveryAction ?? command.action,
              recoveryCommandFingerprint: commandFingerprint
            },
            eventType: "STATUS_TRANSITIONED",
            expectedStatus: closureCase.status,
            expectedVersion: closureCase.version,
            occurredAt: command.occurredAt,
            source
          },
          this.closureAudit(command.actorId)
        );
        return Object.freeze({ action: command.action, wrote: outcome.wrote });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  async requestRecoveryExecutionApproval(input: RequestRecoveryExecutionApprovalInput) {
    if (!this.prisma || !this.assetAccounting) {
      throw serviceConflict("RECOVERY_JOB_AUTHORITY_INVALID");
    }
    const command = normalizeRequestRecoveryApproval(input);
    return this.prisma.$transaction(
      async (tx) => {
        const requestSource = physicalSource(
          command.closureCaseId,
          `recovery-approval-request:${command.idempotencyKey}`
        );
        const eventSource = physicalSource(
          command.closureCaseId,
          `recovery-approval-state:${command.idempotencyKey}`
        );
        let accountingSourceCapability: Awaited<
          ReturnType<AssetAccountingService["prepareCallerOwnedTransaction"]>
        > | null = null;
        let eventSourceCapability: PreparedClosureSourceCapability | null = null;
        const sourcePreparations = [
          {
            prepare: async () => {
              accountingSourceCapability =
                await this.assetAccounting!.prepareCallerOwnedTransaction(tx, requestSource);
            },
            source: requestSource
          },
          {
            prepare: async () => {
              eventSourceCapability = await this.repository.prepareSourceInTransaction(
                tx,
                eventSource
              );
            },
            source: eventSource
          }
        ].sort((left, right) =>
          bytewiseCompare(sourceSortKey(left.source), sourceSortKey(right.source))
        );
        for (const preparation of sourcePreparations) await preparation.prepare();
        const commandFingerprint = recoveryApprovalCommandFingerprint(command);
        const replay = await replayRecoveryApprovalOrchestration(tx, {
          accountingSource: requestSource,
          commandFingerprint,
          eventSource,
          kind: "REQUEST"
        });
        if (replay) {
          await this.lockAndValidateRecoveryAuthorityReplay(
            tx,
            command.closureCaseId,
            command.actorId
          );
          const lockedReplay = await replayRecoveryApprovalOrchestration(tx, {
            accountingSource: requestSource,
            commandFingerprint,
            eventSource,
            kind: "REQUEST"
          });
          if (!lockedReplay || lockedReplay.approvalId !== replay.approvalId) {
            throw serviceConflict("AUTHORITY_MISMATCH");
          }
          return Object.freeze({ approvalId: lockedReplay.approvalId, wrote: false });
        }
        const databaseClock = await readDatabaseClock(tx);
        const resolved = await resolveRecoveryApprovalAuthority(
          tx,
          command.closureCaseId,
          databaseClock
        );
        if (
          !resolved.contextActionable ||
          resolved.closureCase.status !== "RECOVERY_ASSESSMENT_PENDING"
        ) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        const approvalCommand = {
          exceptionType: "RECOVERY_EXECUTION_APPROVAL" as const,
          requestEvidenceSnapshot: {
            recoveryAuthorityRevisionId: resolved.authority.recoveryAuthorityRevisionId,
            recoveryContextSnapshotHash: resolved.authority.recoveryContextSnapshotHash
          },
          requestReason: command.reason,
          requestedAt: command.requestedAt,
          source: requestSource,
          subject: recoveryApprovalSubject(command.closureCaseId)
        };
        const accountingContext = {
          actorId: command.actorId,
          idempotencyKey: requestSource.key,
          permissions: [ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST]
        };
        const session = this.repository.createAuthoritySessionInTransaction(tx);
        const requirement = this.assetAccounting!.requestApprovalAuthorityRequirement(
          session,
          approvalCommand,
          accountingContext,
          resolved.authority,
          "recovery-approval-request"
        );
        const attestations = await this.repository.prepareAuthorityInTransaction(
          tx,
          session,
          [
            ...resolved.contextLocks,
            ...resolved.documentLocks,
            ...requirement.locks,
            { id: command.actorId, mode: "SHARE", table: "user" }
          ],
          [requirement]
        );
        const locked = await resolveRecoveryApprovalAuthority(
          tx,
          command.closureCaseId,
          databaseClock
        );
        if (
          !locked.contextActionable ||
          locked.closureCase.status !== "RECOVERY_ASSESSMENT_PENDING" ||
          canonicalSubscriptionClosureJson(locked.authority) !==
            canonicalSubscriptionClosureJson(resolved.authority)
        ) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        const preparedApproval =
          await this.assetAccounting!.attestPreparedApprovalRequestInTransaction(
            tx,
            session,
            approvalCommand,
            accountingContext,
            locked.authority,
            requiredValue<AssetAccountingTransactionCapability>(accountingSourceCapability),
            requiredAttestation(attestations, "recovery-approval-request"),
            "recovery-approval-request"
          );
        const approval = await this.assetAccounting!.requestPreparedApprovalInTransaction(
          tx,
          preparedApproval
        );
        const event = await this.repository.appendSourcePreparedEventInTransaction(
          tx,
          {
            actorId: command.actorId,
            afterStatus: "RECOVERY_APPROVAL_PENDING",
            closureCaseId: command.closureCaseId,
            detailSnapshot: {
              approvalId: approval.id,
              approvalSnapshotHash: approval.subjectSnapshotHash,
              recoveryApprovalCommandFingerprint: commandFingerprint,
              recoveryAction: "REQUEST_APPROVAL"
            },
            eventType: "STATUS_TRANSITIONED",
            expectedStatus: "RECOVERY_ASSESSMENT_PENDING",
            expectedVersion: resolved.closureCase.version,
            occurredAt: command.requestedAt,
            source: eventSource
          },
          requiredValue<PreparedClosureSourceCapability>(eventSourceCapability),
          this.closureAudit(command.actorId)
        );
        return Object.freeze({ approvalId: approval.id, wrote: event.wrote });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  async decideRecoveryExecutionApproval(input: DecideRecoveryExecutionApprovalInput) {
    if (!this.prisma || !this.assetAccounting) {
      throw serviceConflict("RECOVERY_JOB_AUTHORITY_INVALID");
    }
    const command = normalizeDecideRecoveryApproval(input);
    return this.prisma.$transaction(
      async (tx) => {
        const decisionSource = physicalSource(
          command.closureCaseId,
          `recovery-approval-decision:${command.idempotencyKey}`
        );
        const eventSource = physicalSource(
          command.closureCaseId,
          `recovery-approval-decision-state:${command.idempotencyKey}`
        );
        let accountingSourceCapability: Awaited<
          ReturnType<AssetAccountingService["prepareCallerOwnedTransaction"]>
        > | null = null;
        let eventSourceCapability: PreparedClosureSourceCapability | null = null;
        const sourcePreparations = [
          {
            prepare: async () => {
              accountingSourceCapability =
                await this.assetAccounting!.prepareCallerOwnedTransaction(tx, decisionSource);
            },
            source: decisionSource
          },
          {
            prepare: async () => {
              eventSourceCapability = await this.repository.prepareSourceInTransaction(
                tx,
                eventSource
              );
            },
            source: eventSource
          }
        ].sort((left, right) =>
          bytewiseCompare(sourceSortKey(left.source), sourceSortKey(right.source))
        );
        for (const preparation of sourcePreparations) await preparation.prepare();
        const commandFingerprint = recoveryApprovalCommandFingerprint(command);
        const replay = await replayRecoveryApprovalOrchestration(tx, {
          accountingSource: decisionSource,
          commandFingerprint,
          eventSource,
          kind: "DECISION"
        });
        if (replay) {
          await this.lockAndValidateRecoveryAuthorityReplay(
            tx,
            command.closureCaseId,
            command.actorId
          );
          const lockedReplay = await replayRecoveryApprovalOrchestration(tx, {
            accountingSource: decisionSource,
            commandFingerprint,
            eventSource,
            kind: "DECISION"
          });
          if (
            !lockedReplay ||
            lockedReplay.approvalId !== replay.approvalId ||
            lockedReplay.status !== replay.status
          ) {
            throw serviceConflict("AUTHORITY_MISMATCH");
          }
          return Object.freeze({
            approvalId: lockedReplay.approvalId,
            status: lockedReplay.status,
            wrote: false
          });
        }
        const databaseClock = await readDatabaseClock(tx);
        const resolved = await resolveRecoveryApprovalAuthority(
          tx,
          command.closureCaseId,
          databaseClock
        );
        const observedApproval = await tx.businessExceptionApproval.findUnique({
          where: { id: command.approvalId }
        });
        if (
          !observedApproval ||
          resolved.closureCase.status !== "RECOVERY_APPROVAL_PENDING" ||
          (command.decision === "APPROVED" && !resolved.contextActionable)
        ) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        const decisionCommand = {
          approvalId: command.approvalId,
          decidedAt: command.decidedAt,
          decision: command.decision,
          decisionComment: command.decisionComment,
          exceptionType: "RECOVERY_EXECUTION_APPROVAL" as const,
          expectedVersion: command.expectedApprovalVersion,
          source: decisionSource,
          subject: recoveryApprovalSubject(command.closureCaseId)
        };
        const accountingContext = {
          actorId: command.actorId,
          idempotencyKey: decisionSource.key,
          permissions: [ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE]
        };
        const session = this.repository.createAuthoritySessionInTransaction(tx);
        const requirement = this.assetAccounting!.decideApprovalAuthorityRequirement(
          session,
          decisionCommand,
          accountingContext,
          resolved.authority,
          observedApproval.requestedBy,
          "recovery-approval-decision"
        );
        const attestations = await this.repository.prepareAuthorityInTransaction(
          tx,
          session,
          [
            ...resolved.contextLocks,
            ...resolved.documentLocks,
            ...requirement.locks,
            { id: command.actorId, mode: "SHARE", table: "user" }
          ],
          [requirement]
        );
        const [locked, lockedApproval] = await Promise.all([
          resolveRecoveryApprovalAuthority(tx, command.closureCaseId, databaseClock),
          tx.businessExceptionApproval.findUnique({ where: { id: command.approvalId } })
        ]);
        if (
          !lockedApproval ||
          lockedApproval.requestedBy !== observedApproval.requestedBy ||
          lockedApproval.status !== "PENDING" ||
          lockedApproval.version !== command.expectedApprovalVersion ||
          locked.closureCase.status !== "RECOVERY_APPROVAL_PENDING" ||
          (command.decision === "APPROVED" && !locked.contextActionable) ||
          canonicalSubscriptionClosureJson(locked.authority) !==
            canonicalSubscriptionClosureJson(resolved.authority)
        ) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        const preparedDecision =
          await this.assetAccounting!.attestPreparedApprovalDecisionInTransaction(
            tx,
            session,
            decisionCommand,
            accountingContext,
            locked.authority,
            lockedApproval.requestedBy,
            requiredValue<AssetAccountingTransactionCapability>(accountingSourceCapability),
            requiredAttestation(attestations, "recovery-approval-decision"),
            "recovery-approval-decision"
          );
        const approval = await this.assetAccounting!.decidePreparedApprovalInTransaction(
          tx,
          preparedDecision
        );
        const afterStatus = command.decision === "APPROVED" ? "RECOVERY_APPROVED" : "REJECTED";
        const event = await this.repository.appendSourcePreparedEventInTransaction(
          tx,
          {
            actorId: command.actorId,
            afterStatus,
            closureCaseId: command.closureCaseId,
            detailSnapshot: {
              approvalId: approval.id,
              approvalVersion: approval.version,
              decision: command.decision,
              recoveryApprovalCommandFingerprint: commandFingerprint,
              recoveryAction: "DECIDE_APPROVAL"
            },
            eventType: "STATUS_TRANSITIONED",
            expectedStatus: "RECOVERY_APPROVAL_PENDING",
            expectedVersion: resolved.closureCase.version,
            occurredAt: command.decidedAt,
            source: eventSource
          },
          requiredValue<PreparedClosureSourceCapability>(eventSourceCapability),
          this.closureAudit(command.actorId)
        );
        return Object.freeze({ approvalId: approval.id, status: afterStatus, wrote: event.wrote });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  async executeApprovedRecovery(input: ExecuteApprovedRecoveryInput) {
    if (!this.prisma || !this.assetAccounting) {
      throw serviceConflict("RECOVERY_JOB_AUTHORITY_INVALID");
    }
    const command = normalizeExecuteRecovery(input);
    return this.prisma.$transaction(
      async (tx) => this.executeApprovedRecoveryInTransaction(tx, command),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  private async executeApprovedRecoveryInTransaction(
    tx: Prisma.TransactionClient,
    command: ExecuteApprovedRecoveryInput
  ) {
    const executionCommandFingerprint = createHash("sha256")
      .update(canonicalSubscriptionClosureJson(command as never))
      .digest("hex");
    const executionSource = physicalSource(
      command.closureCaseId,
      `recovery-execution-state:${command.idempotencyKey}`
    );
    const staleApprovalSource = physicalSource(
      command.closureCaseId,
      `recovery-approval-stale-state:${command.idempotencyKey}`
    );
    const priorReceipt = await tx.subscriptionClosureCommandReceipt.findUnique({
      where: {
        sourceType_sourceId_sourceKey: {
          sourceId: executionSource.id,
          sourceKey: executionSource.key,
          sourceType: executionSource.type
        }
      }
    });
    if (priorReceipt) {
      const receiptPayload = jsonObject(priorReceipt.payloadSnapshot);
      const receiptDetail = jsonObject(receiptPayload.detailSnapshot);
      if (receiptDetail.executionCommandFingerprint !== executionCommandFingerprint) {
        throw closureSourceConflict();
      }
      for (const source of [executionSource, staleApprovalSource].sort((left, right) =>
        bytewiseCompare(sourceSortKey(left), sourceSortKey(right))
      )) {
        await this.repository.lockSourceOwnership(tx, source);
      }
      const lockedReceipt = await tx.subscriptionClosureCommandReceipt.findUnique({
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: executionSource.id,
            sourceKey: executionSource.key,
            sourceType: executionSource.type
          }
        }
      });
      const lockedPayload = jsonObject(lockedReceipt?.payloadSnapshot);
      const lockedDetail = jsonObject(lockedPayload.detailSnapshot);
      if (
        !lockedReceipt ||
        lockedDetail.executionCommandFingerprint !== executionCommandFingerprint
      ) {
        throw serviceConflict("AUTHORITY_MISMATCH");
      }
      await this.lockAndValidateRecoveryAuthorityReplay(tx, command.closureCaseId, command.actorId);
      const existing = await tx.subscriptionClosureCase.findUnique({
        where: { id: command.closureCaseId }
      });
      return Object.freeze({
        action: "RECOVERY_STARTED" as const,
        recoveryAssetWorkOrderId: existing?.recoveryAssetWorkOrderId ?? null,
        wrote: false
      });
    }
    const staleReceipt = await tx.subscriptionClosureCommandReceipt.findUnique({
      where: {
        sourceType_sourceId_sourceKey: {
          sourceId: staleApprovalSource.id,
          sourceKey: staleApprovalSource.key,
          sourceType: staleApprovalSource.type
        }
      }
    });
    if (staleReceipt) {
      const receiptPayload = jsonObject(staleReceipt.payloadSnapshot);
      const receiptDetail = jsonObject(receiptPayload.detailSnapshot);
      if (receiptDetail.executionCommandFingerprint !== executionCommandFingerprint) {
        throw closureSourceConflict();
      }
      for (const source of [executionSource, staleApprovalSource].sort((left, right) =>
        bytewiseCompare(sourceSortKey(left), sourceSortKey(right))
      )) {
        await this.repository.lockSourceOwnership(tx, source);
      }
      const lockedReceipt = await tx.subscriptionClosureCommandReceipt.findUnique({
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: staleApprovalSource.id,
            sourceKey: staleApprovalSource.key,
            sourceType: staleApprovalSource.type
          }
        }
      });
      const lockedPayload = jsonObject(lockedReceipt?.payloadSnapshot);
      const lockedDetail = jsonObject(lockedPayload.detailSnapshot);
      if (
        !lockedReceipt ||
        lockedDetail.executionCommandFingerprint !== executionCommandFingerprint
      ) {
        throw serviceConflict("AUTHORITY_MISMATCH");
      }
      await this.lockAndValidateRecoveryAuthorityReplay(tx, command.closureCaseId, command.actorId);
      return Object.freeze({ action: "APPROVAL_EXPIRED" as const, wrote: false });
    }
    const resolved = await resolveRecoveryApprovalAuthority(tx, command.closureCaseId);
    const closureCase = resolved.closureCase;
    if (closureCase.status !== "RECOVERY_APPROVED" || closureCase.recoveryAssetWorkOrderId) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const plannedWorkOrderId = resolved.authority.recoveryAssetWorkOrderId;
    const workOrderSource = physicalSource(command.closureCaseId, "recovery-work-order");
    const restrictionSource = physicalSource(command.closureCaseId, "recovery-restriction");
    const approvalSource = physicalSource(
      command.closureCaseId,
      `recovery-approval-require:${command.approvalId}:${command.expectedApprovalVersion}`
    );
    const workOrderCommand: CreateWorkOrderServiceCommand = {
      assetOwnerId: null,
      contractId: closureCase.contractId,
      costConfirmationRequired: true,
      customerId: closureCase.customerId,
      description: `Approved recovery for closure ${closureCase.caseNo}`,
      metadata: {
        closureCaseId: closureCase.id,
        recoveryApprovalId: command.approvalId,
        recoveryAuthorityRevisionId: resolved.authority.recoveryAuthorityRevisionId
      },
      occurredAt: command.occurredAt,
      orderId: closureCase.orderId,
      priority: "HIGH",
      relatedWorkOrderId: closureCase.returnAssetWorkOrderId,
      source: workOrderSource,
      vehicleId: closureCase.vehicleId,
      workOrderType: "RECOVERY"
    };
    const workOrderAuthority = {
      assetOwnerId: null,
      contractId: closureCase.contractId,
      customerId: closureCase.customerId,
      orderId: closureCase.orderId,
      relatedWorkOrderId: closureCase.returnAssetWorkOrderId,
      vehicleId: closureCase.vehicleId,
      workOrderId: plannedWorkOrderId
    };
    const restrictionCommand = {
      conditionsSnapshot: {
        closureCaseId: closureCase.id,
        releaseCondition: "RECOVERY_PHYSICAL_CONTROL_CONFIRMED"
      },
      evidenceSnapshot: {
        recoveryApprovalId: command.approvalId,
        recoveryAuthorityRevisionId: resolved.authority.recoveryAuthorityRevisionId
      },
      occurredAt: command.occurredAt,
      restrictionType: VehicleOperationalRestrictionType.RECOVERY_IN_PROGRESS,
      scopes: [
        VehicleOperationalRestrictionScope.ALLOCATION,
        VehicleOperationalRestrictionScope.DELIVERY,
        VehicleOperationalRestrictionScope.CUSTOMER_USE,
        VehicleOperationalRestrictionScope.INVENTORY_RELEASE
      ],
      severity: VehicleOperationalRestrictionSeverity.BLOCKING,
      source: restrictionSource,
      startedAt: command.occurredAt,
      vehicleId: closureCase.vehicleId,
      workOrderId: plannedWorkOrderId
    };
    const approvalCommand = {
      approvalId: command.approvalId,
      exceptionType: "RECOVERY_EXECUTION_APPROVAL" as const,
      expectedVersion: command.expectedApprovalVersion,
      expiredAt: command.occurredAt,
      expiryReason: "Recovery authority facts changed before execution.",
      source: approvalSource,
      subject: recoveryApprovalSubject(command.closureCaseId)
    };
    const eventCommand = {
      actorId: command.actorId,
      afterStatus: "RECOVERY_IN_PROGRESS" as const,
      closureCaseId: closureCase.id,
      detailSnapshot: {
        executionCommandFingerprint,
        recoveryApprovalId: command.approvalId,
        recoveryAssetWorkOrderId: plannedWorkOrderId,
        recoveryAuthorityRevisionId: resolved.authority.recoveryAuthorityRevisionId
      },
      eventType: "STATUS_TRANSITIONED" as const,
      expectedStatus: "RECOVERY_APPROVED" as const,
      expectedVersion: closureCase.version,
      occurredAt: command.occurredAt,
      recoveryAssetWorkOrderId: plannedWorkOrderId,
      source: executionSource
    };
    const staleApprovalEventCommand = {
      actorId: command.actorId,
      afterStatus: "PAUSED" as const,
      closureCaseId: closureCase.id,
      detailSnapshot: {
        approvalId: command.approvalId,
        executionCommandFingerprint,
        pausedFromStatus: "RECOVERY_APPROVED",
        reason: "APPROVAL_STALE",
        recoveryAction: "PAUSE"
      },
      eventType: "STATUS_TRANSITIONED" as const,
      expectedStatus: "RECOVERY_APPROVED" as const,
      expectedVersion: closureCase.version,
      occurredAt: command.occurredAt,
      source: staleApprovalSource
    };
    const sourceCapabilities = new Map<string, unknown>();
    const preparations = [
      {
        prepare: async () =>
          sourceCapabilities.set(
            approvalSource.key,
            await this.assetAccounting!.prepareCallerOwnedTransaction(tx, approvalSource)
          ),
        source: approvalSource
      },
      {
        prepare: async () =>
          sourceCapabilities.set(
            workOrderSource.key,
            await this.assetOperations.prepareCallerOwnedTransaction(tx, workOrderSource)
          ),
        source: workOrderSource
      },
      {
        prepare: async () =>
          sourceCapabilities.set(
            restrictionSource.key,
            await this.assetOperations.prepareCallerOwnedTransaction(tx, restrictionSource)
          ),
        source: restrictionSource
      },
      {
        prepare: async () =>
          sourceCapabilities.set(
            staleApprovalSource.key,
            await this.repository.prepareSourceInTransaction(tx, staleApprovalSource)
          ),
        source: staleApprovalSource
      },
      {
        prepare: async () =>
          sourceCapabilities.set(
            executionSource.key,
            await this.repository.prepareSourceInTransaction(tx, executionSource)
          ),
        source: executionSource
      }
    ].sort((left, right) =>
      bytewiseCompare(sourceSortKey(left.source), sourceSortKey(right.source))
    );
    for (const preparation of preparations) await preparation.prepare();
    const operationContext = { actorId: command.actorId, permissions: [] };
    const accountingContext = {
      actorId: command.actorId,
      idempotencyKey: approvalSource.key,
      permissions: [ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST]
    };
    const session = this.repository.createAuthoritySessionInTransaction(tx);
    const requirements = [
      this.assetOperations.createAuthorityRequirement(
        session,
        workOrderCommand,
        command.actorId,
        plannedWorkOrderId
      ),
      this.assetAccounting!.approvedExceptionAuthorityRequirement(
        session,
        approvalCommand,
        accountingContext,
        resolved.authority,
        "recovery-approval"
      ),
      this.assetOperations.restrictionCreateAuthorityRequirement(
        session,
        restrictionCommand,
        command.actorId,
        workOrderAuthority
      ),
      this.repository.bindAuthorityRequirement(
        session,
        subscriptionClosureEventAuthorityRequirement(eventCommand, "recovery-execution")
      ),
      this.repository.bindAuthorityRequirement(
        session,
        subscriptionClosureEventAuthorityRequirement(
          staleApprovalEventCommand,
          "recovery-approval-stale"
        )
      )
    ];
    const attestations = await this.repository.prepareAuthorityInTransaction(
      tx,
      session,
      [
        ...resolved.contextLocks,
        ...resolved.documentLocks,
        ...requirements.flatMap(({ locks }) => locks)
      ],
      requirements
    );
    const lockedResolved = await resolveRecoveryApprovalAuthority(tx, command.closureCaseId);
    if (
      canonicalSubscriptionClosureJson(lockedResolved.authority) !==
        canonicalSubscriptionClosureJson(resolved.authority) ||
      lockedResolved.closureCase.status !== "RECOVERY_APPROVED"
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const preparedCreate = await this.assetOperations.attestCallerOwnedCreateAuthorityInTransaction(
      tx,
      session,
      workOrderCommand,
      operationContext,
      sourceCapabilities.get(workOrderSource.key) as never,
      requiredAttestation(attestations, "asset-create"),
      plannedWorkOrderId
    );
    const preparedApproval =
      await this.assetAccounting!.attestPreparedApprovedExceptionInTransaction(
        tx,
        session,
        approvalCommand,
        accountingContext,
        resolved.authority,
        sourceCapabilities.get(approvalSource.key) as never,
        requiredAttestation(attestations, "recovery-approval"),
        "recovery-approval"
      );
    const validApproval = await this.assetAccounting!.requirePreparedApprovedExceptionInTransaction(
      tx,
      preparedApproval
    );
    if (!validApproval) {
      const staleEvent = await this.repository.appendPreparedEventInTransaction(
        tx,
        session,
        staleApprovalEventCommand,
        sourceCapabilities.get(staleApprovalSource.key) as never,
        requiredAttestation(attestations, "recovery-approval-stale"),
        this.closureAudit(command.actorId),
        "recovery-approval-stale"
      );
      return Object.freeze({ action: "APPROVAL_EXPIRED" as const, wrote: staleEvent.wrote });
    }
    const created = await this.assetOperations.createPreparedWorkOrderInTransaction(
      tx,
      preparedCreate
    );
    if (created.workOrder.id !== plannedWorkOrderId) throw serviceConflict("AUTHORITY_MISMATCH");
    const preparedRestriction =
      await this.assetOperations.attestPreparedRestrictionCreateInTransaction(
        tx,
        session,
        restrictionCommand,
        operationContext,
        sourceCapabilities.get(restrictionSource.key) as never,
        workOrderAuthority,
        requiredAttestation(attestations, "return-inspection-restriction")
      );
    await this.assetOperations.createPreparedRestrictionInTransaction(tx, preparedRestriction);
    const event = await this.repository.appendPreparedEventInTransaction(
      tx,
      session,
      eventCommand,
      sourceCapabilities.get(executionSource.key) as never,
      requiredAttestation(attestations, "recovery-execution"),
      this.closureAudit(command.actorId),
      "recovery-execution"
    );
    return Object.freeze({
      action: "RECOVERY_STARTED" as const,
      recoveryAssetWorkOrderId: plannedWorkOrderId,
      wrote: event.wrote
    });
  }

  private async lockAndValidateRecoveryAuthorityReplay(
    tx: Prisma.TransactionClient,
    closureCaseId: string,
    actorId: string
  ) {
    const observed = await resolveRecoveryApprovalAuthority(tx, closureCaseId);
    await this.repository.lockAuthorityRows(tx, [
      ...observed.contextLocks,
      ...observed.documentLocks,
      { id: actorId, mode: "SHARE", table: "user" }
    ]);
    const locked = await resolveRecoveryApprovalAuthority(tx, closureCaseId);
    if (
      canonicalSubscriptionClosureJson(locked.authority) !==
      canonicalSubscriptionClosureJson(observed.authority)
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
  }

  async recordRecoveryExecution(input: RecordRecoveryExecutionInput) {
    if (!this.prisma || !this.assetAccounting) {
      throw serviceConflict("RECOVERY_JOB_AUTHORITY_INVALID");
    }
    const command = normalizeRecoveryExecutionRecord(input);
    return this.prisma.$transaction(
      async (tx) => this.recordRecoveryExecutionInTransaction(tx, command),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  private async recordRecoveryExecutionInTransaction(
    tx: Prisma.TransactionClient,
    command: RecordRecoveryExecutionInput
  ) {
    const resolved = await resolveRecoveryApprovalAuthority(tx, command.closureCaseId);
    const closureCase = resolved.closureCase;
    if (
      !closureCase ||
      closureCase.status !== "RECOVERY_IN_PROGRESS" ||
      closureCase.physicalControlMode !== "RECOVERY" ||
      closureCase.finalDisposition !== "TERMINATE" ||
      !closureCase.recoveryAssetWorkOrderId
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    if (!resolved.contextActionable) throw serviceConflict("AUTHORITY_MISMATCH");
    const approval = await tx.businessExceptionApproval.findFirst({
      orderBy: [{ decidedAt: "desc" }, { id: "asc" }],
      where: {
        exceptionType: "RECOVERY_EXECUTION_APPROVAL",
        status: "APPROVED",
        subjectField: "recoveryExecution",
        subjectId: closureCase.id,
        subjectType: "RECOVERY_CASE"
      }
    });
    const approvalSnapshotHash = createHash("sha256")
      .update(canonicalSubscriptionClosureJson(resolved.authority))
      .digest("hex");
    if (
      !approval ||
      !approval.decidedAt ||
      approval.requestedBy === approval.decidedBy ||
      approval.subjectSnapshotHash !== approvalSnapshotHash ||
      canonicalSubscriptionClosureJson(approval.subjectSnapshot as never) !==
        canonicalSubscriptionClosureJson(resolved.authority)
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const workOrder = await tx.assetWorkOrder.findUnique({
      where: { id: closureCase.recoveryAssetWorkOrderId }
    });
    if (
      !workOrder ||
      workOrder.workOrderType !== "RECOVERY" ||
      workOrder.orderId !== closureCase.orderId ||
      workOrder.vehicleId !== closureCase.vehicleId ||
      workOrder.contractId !== closureCase.contractId ||
      workOrder.customerId !== closureCase.customerId ||
      workOrder.status === AssetWorkOrderStatus.CANCELLED ||
      workOrder.status === AssetWorkOrderStatus.CLOSED
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const authority = workOrderAuthorityOf(workOrder);
    const operationContext = { actorId: command.actorId, permissions: [] };
    const accountingContext = {
      actorId: command.actorId,
      permissions: [ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM]
    };
    const evidenceCommands = command.evidence.map((item, index) => ({
      ...item,
      captureMetadata: {
        ...jsonObject(item.captureMetadata),
        closureCaseId: closureCase.id,
        recoveryApprovalId: approval.id,
        recoveryAssetWorkOrderId: workOrder.id,
        recoveryAuthorityRevisionId: resolved.authority.recoveryAuthorityRevisionId
      },
      source: physicalSource(
        closureCase.id,
        `recovery-execution-evidence:${command.idempotencyKey}:${index}`
      ),
      workOrderId: workOrder.id
    }));
    const costCommands = command.costs.map((item, index) => ({
      ...item,
      contractId: closureCase.contractId,
      customerId: closureCase.customerId,
      orderId: closureCase.orderId,
      source: physicalSource(
        closureCase.id,
        `recovery-execution-cost:${command.idempotencyKey}:${index}`
      ),
      vehicleId: closureCase.vehicleId,
      workOrderId: workOrder.id
    }));
    const recordSource = physicalSource(
      closureCase.id,
      `recovery-execution-record:${command.idempotencyKey}`
    );
    const priorRecordReceipt = await tx.subscriptionClosureCommandReceipt.findUnique({
      where: {
        sourceType_sourceId_sourceKey: {
          sourceId: recordSource.id,
          sourceKey: recordSource.key,
          sourceType: recordSource.type
        }
      }
    });
    const priorRecordPayload = jsonObject(priorRecordReceipt?.payloadSnapshot);
    const expectedVersion = priorRecordReceipt
      ? priorRecordPayload.expectedVersion
      : closureCase.version;
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0) {
      throw closureSourceConflict();
    }
    const eventCommand = {
      actorId: command.actorId,
      afterStatus: "RECOVERY_IN_PROGRESS" as const,
      closureCaseId: closureCase.id,
      detailSnapshot: {
        costCount: costCommands.length,
        evidenceCount: evidenceCommands.length,
        recoveryAction: "EXECUTION_RECORDED",
        recoveryAssetWorkOrderId: workOrder.id
      },
      eventType: "NOTE_ADDED" as const,
      expectedStatus: "RECOVERY_IN_PROGRESS" as const,
      expectedVersion: Number(expectedVersion),
      occurredAt: command.occurredAt,
      source: recordSource
    };
    const sourceCapabilities = new Map<string, unknown>();
    const preparations: Array<{
      prepare: () => Promise<void>;
      source: SubscriptionClosureSource;
    }> = [
      ...evidenceCommands.map((item) => ({
        prepare: async () => {
          sourceCapabilities.set(
            item.source.key,
            await this.assetOperations.prepareCallerOwnedTransaction(tx, item.source)
          );
        },
        source: item.source
      })),
      ...costCommands.map((item) => ({
        prepare: async () => {
          sourceCapabilities.set(
            item.source.key,
            await this.assetAccounting!.prepareCallerOwnedTransaction(tx, item.source)
          );
        },
        source: item.source
      })),
      {
        prepare: async () => {
          sourceCapabilities.set(
            recordSource.key,
            await this.repository.prepareSourceInTransaction(tx, recordSource)
          );
        },
        source: recordSource
      }
    ].sort((left, right) =>
      bytewiseCompare(sourceSortKey(left.source), sourceSortKey(right.source))
    );
    for (const preparation of preparations) await preparation.prepare();
    const session = this.repository.createAuthoritySessionInTransaction(tx);
    const requirements = [
      ...evidenceCommands.map((item, index) =>
        this.assetOperations.evidenceAuthorityRequirement(
          session,
          item,
          command.actorId,
          authority,
          `recovery-execution-evidence:${command.idempotencyKey}:${index}`
        )
      ),
      ...costCommands.map((item, index) =>
        this.assetAccounting!.appendCostAuthorityRequirement(
          session,
          item,
          accountingContext,
          { authoritativeOrderId: closureCase.orderId },
          `recovery-execution-cost:${command.idempotencyKey}:${index}`
        )
      ),
      this.repository.bindAuthorityRequirement(
        session,
        subscriptionClosureEventAuthorityRequirement(eventCommand, "recovery-execution-record")
      )
    ];
    const attestations = await this.repository.prepareAuthorityInTransaction(
      tx,
      session,
      [
        ...resolved.contextLocks,
        ...resolved.documentLocks,
        ...requirements.flatMap(({ locks }) => locks),
        { id: approval.id, mode: "UPDATE" as const, table: "business_exception_approval" as const },
        {
          id: resolved.authority.recoveryAuthorityRevisionId,
          mode: "SHARE" as const,
          table: "subscription_closure_document_revision" as const
        }
      ],
      requirements
    );
    const lockedCase = await tx.subscriptionClosureCase.findUnique({
      where: { id: closureCase.id }
    });
    const lockedWorkOrder = await tx.assetWorkOrder.findUnique({ where: { id: workOrder.id } });
    const lockedApproval = await tx.businessExceptionApproval.findUnique({
      where: { id: approval.id }
    });
    const lockedResolved = await resolveRecoveryApprovalAuthority(tx, closureCase.id);
    if (
      canonicalSubscriptionClosureJson(lockedCase as never) !==
        canonicalSubscriptionClosureJson(closureCase as never) ||
      canonicalSubscriptionClosureJson(lockedWorkOrder as never) !==
        canonicalSubscriptionClosureJson(workOrder as never) ||
      canonicalSubscriptionClosureJson(lockedApproval as never) !==
        canonicalSubscriptionClosureJson(approval as never) ||
      canonicalSubscriptionClosureJson(lockedResolved.authority) !==
        canonicalSubscriptionClosureJson(resolved.authority)
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const preparedEvidence = await Promise.all(
      evidenceCommands.map((item, index) => {
        const key = `recovery-execution-evidence:${command.idempotencyKey}:${index}`;
        return this.assetOperations.attestPreparedEvidenceInTransaction(
          tx,
          session,
          item,
          operationContext,
          requiredCapability(sourceCapabilities, item.source.key),
          authority,
          requiredAttestation(attestations, key),
          key
        );
      })
    );
    const preparedCosts = await Promise.all(
      costCommands.map((item, index) => {
        const key = `recovery-execution-cost:${command.idempotencyKey}:${index}`;
        return this.assetAccounting!.attestPreparedAppendCostInTransaction(
          tx,
          session,
          item,
          { ...accountingContext, idempotencyKey: item.source.key },
          requiredCapability(sourceCapabilities, item.source.key),
          { authoritativeOrderId: closureCase.orderId },
          requiredAttestation(attestations, key),
          key
        );
      })
    );
    for (const prepared of preparedEvidence) {
      await this.assetOperations.appendPreparedEvidenceInTransaction(tx, prepared);
    }
    for (const prepared of preparedCosts) {
      await this.assetAccounting!.appendPreparedCostInTransaction(tx, prepared);
    }
    const event = await this.repository.appendPreparedEventInTransaction(
      tx,
      session,
      eventCommand,
      requiredCapability(sourceCapabilities, recordSource.key),
      requiredAttestation(attestations, "recovery-execution-record"),
      this.closureAudit(command.actorId),
      "recovery-execution-record"
    );
    return Object.freeze({
      costCount: costCommands.length,
      evidenceCount: evidenceCommands.length,
      wrote: event.wrote
    });
  }

  preparedNormalExpiryVehicleReturnId(
    tx: Prisma.TransactionClient,
    capability: NormalExpiryTransactionCapability
  ) {
    const state = this.normalExpiryCapabilities.get(capability);
    if (!state || state.transaction !== tx) throw serviceConflict("CAPABILITY_INVALID");
    return state.vehicleReturnId;
  }

  async prepareManagedReturnInTransaction(
    tx: Prisma.TransactionClient,
    input: PrepareManagedReturnInput
  ): Promise<ManagedReturnTransactionCapability | null> {
    const command = normalizeManagedReturnInput(input);
    const observedCase = await tx.subscriptionClosureCase.findFirst({
      select: {
        closureType: true,
        id: true,
        physicalControlMode: true,
        returnHandoverWorkOrderId: true,
        vehicleReturnId: true
      },
      where: { orderId: command.orderId, retiredAt: null }
    });
    if (!observedCase) {
      const returnInbound = await tx.vehicleHandoverWorkOrder.findMany({
        select: { metadata: true },
        where: { handoverType: "RETURN_INBOUND", orderId: command.orderId }
      });
      if (returnInbound.some(({ metadata }) => isP0ManagedReturnMetadata(metadata))) {
        throw serviceConflict("MANAGED_RETURN_AUTHORITY_NOT_FOUND");
      }
      return null;
    }
    if (
      !["NORMAL_COMPLETION", "EARLY_TERMINATION"].includes(observedCase.closureType) ||
      observedCase.physicalControlMode !== "VOLUNTARY_RETURN" ||
      !observedCase.vehicleReturnId ||
      !observedCase.returnHandoverWorkOrderId
    ) {
      throw serviceConflict("MANAGED_RETURN_AUTHORITY_NOT_FOUND");
    }
    const handoverCommand = {
      actorId: command.actorId,
      deliveryLocation: command.returnLocation,
      orderId: command.orderId,
      scheduledAt: command.scheduledAt,
      source: {
        id: observedCase.id,
        key: "legacy-prepare-return",
        type: "SUBSCRIPTION_CLOSURE"
      },
      workOrderId: observedCase.returnHandoverWorkOrderId
    };
    const handoverSourceCapability =
      await this.handoverWorkOrders.prepareGovernedReturnInboundSourceInTransaction(
        tx,
        handoverCommand
      );
    const authoritySession = this.repository.createAuthoritySessionInTransaction(tx);
    const authority = await this.repository.prepareAuthorityInTransaction(
      tx,
      authoritySession,
      [
        {
          id: observedCase.id,
          mode: "UPDATE" as const,
          table: "subscription_closure_case" as const
        },
        { id: command.orderId, mode: "UPDATE", table: "subscription_order" },
        { id: observedCase.vehicleReturnId, mode: "UPDATE", table: "vehicle_return" },
        {
          id: observedCase.returnHandoverWorkOrderId,
          mode: "UPDATE",
          table: "vehicle_handover_work_order"
        },
        { id: command.actorId, mode: "SHARE", table: "user" }
      ],
      [
        this.handoverWorkOrders.createGovernedReturnInboundAuthorityRequirement(
          authoritySession,
          handoverCommand
        )
      ]
    );
    const closureCase = await tx.subscriptionClosureCase.findFirst({
      select: {
        closureType: true,
        id: true,
        physicalControlMode: true,
        returnHandoverWorkOrderId: true,
        vehicleReturnId: true
      },
      where: { orderId: command.orderId, retiredAt: null }
    });
    if (
      !closureCase ||
      closureCase.id !== observedCase?.id ||
      !["NORMAL_COMPLETION", "EARLY_TERMINATION"].includes(closureCase.closureType) ||
      closureCase.physicalControlMode !== "VOLUNTARY_RETURN" ||
      !closureCase.vehicleReturnId ||
      !closureCase.returnHandoverWorkOrderId
    ) {
      throw serviceConflict("MANAGED_RETURN_AUTHORITY_NOT_FOUND");
    }
    const [vehicleReturn, handoverWorkOrder] = await Promise.all([
      tx.vehicleReturn.findUnique({
        select: { deletedAt: true, id: true, orderId: true },
        where: { id: closureCase.vehicleReturnId }
      }),
      tx.vehicleHandoverWorkOrder.findUnique({
        select: { handoverType: true, id: true, orderId: true },
        where: { id: closureCase.returnHandoverWorkOrderId }
      })
    ]);
    if (
      !vehicleReturn ||
      vehicleReturn.deletedAt ||
      vehicleReturn.orderId !== command.orderId ||
      !handoverWorkOrder ||
      handoverWorkOrder.orderId !== command.orderId ||
      handoverWorkOrder.handoverType !== "RETURN_INBOUND"
    ) {
      throw serviceConflict("MANAGED_RETURN_AUTHORITY_NOT_FOUND");
    }
    const authorityAttestation = requiredAttestation(authority, "managed-return");
    const handoverCapability =
      await this.handoverWorkOrders.attestGovernedReturnInboundAuthorityInTransaction(
        tx,
        authoritySession,
        handoverCommand,
        handoverSourceCapability,
        authorityAttestation
      );
    const capability = Object.freeze({}) as ManagedReturnTransactionCapability;
    this.managedReturnCapabilities.set(
      capability,
      Object.freeze({
        command,
        handoverCapability,
        handoverWorkOrderId: handoverWorkOrder.id,
        transaction: tx,
        vehicleReturnId: vehicleReturn.id
      })
    );
    return capability;
  }

  async completeManagedReturnInTransaction(
    tx: Prisma.TransactionClient,
    input: CompleteManagedReturnInput,
    capability: ManagedReturnTransactionCapability
  ) {
    const state = this.managedReturnCapabilities.get(capability);
    this.managedReturnCapabilities.delete(capability);
    const command = normalizeCompleteManagedReturnInput(input);
    if (
      !state ||
      state.transaction !== tx ||
      state.vehicleReturnId !== command.vehicleReturnId ||
      canonicalSubscriptionClosureJson(state.command) !==
        canonicalSubscriptionClosureJson(normalizeManagedReturnInput(command))
    ) {
      throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
    }
    await this.handoverWorkOrders.updatePreparedGovernedReturnInboundInTransaction(
      tx,
      state.handoverCapability
    );
    return Object.freeze({ handoverWorkOrderId: state.handoverWorkOrderId });
  }

  async confirmManagedPhysicalReceipt(
    input: ConfirmManagedPhysicalReceiptInput,
    context: Readonly<{ ipAddress?: string; userAgent?: string }>
  ): Promise<Readonly<{ vehicleReturnId: string }> | null> {
    if (!this.prisma || !this.assetFacts || !this.vehicleMileage) {
      throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
    }
    const command = normalizePhysicalReceiptInput(input);
    return this.prisma.$transaction(
      async (tx) => this.confirmManagedPhysicalReceiptInTransaction(tx, command, context),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  private async confirmManagedPhysicalReceiptInTransaction(
    tx: Prisma.TransactionClient,
    command: ConfirmManagedPhysicalReceiptInput,
    context: Readonly<{ ipAddress?: string; userAgent?: string }>
  ) {
    const observed = await loadPhysicalReceiptAuthority(tx, command.orderId);
    if (!observed.closureCase) {
      if (observed.managedMarker) throw serviceConflict("MANAGED_RETURN_AUTHORITY_NOT_FOUND");
      return null;
    }
    const closureCase = observed.closureCase;
    const physicalCommandFingerprint = createHash("sha256")
      .update(canonicalSubscriptionClosureJson(command as never))
      .digest("hex");
    const receiptSource = physicalSource(
      closureCase.id,
      `physical-receipt:${command.physicalControlMode}`
    );
    const recoveryDriftSource = physicalSource(closureCase.id, "physical-receipt-drift:RECOVERY");
    if (command.physicalControlMode === "RECOVERY" && closureCase.status === "PAUSED") {
      const driftReceipt = await tx.subscriptionClosureCommandReceipt.findUnique({
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: recoveryDriftSource.id,
            sourceKey: recoveryDriftSource.key,
            sourceType: recoveryDriftSource.type
          }
        }
      });
      const driftDetail = jsonObject(jsonObject(driftReceipt?.payloadSnapshot).detailSnapshot);
      if (driftDetail.physicalCommandFingerprint !== physicalCommandFingerprint) {
        throw closureSourceConflict();
      }
      return null;
    }
    if (
      closureCase.physicalControlMode === command.physicalControlMode &&
      ["RECONDITIONING", "PENDING_SETTLEMENT", "COMPLETED", "TERMINATED"].includes(
        closureCase.status
      )
    ) {
      if (!observed.receiptEvent?.commandReceipt) throw closureSourceConflict();
      await this.repository.lockSourceOwnership(tx, receiptSource);
      await this.repository.lockAuthorityRows(tx, [
        ...physicalReceiptLocks(observed, command.actorId),
        ...(await physicalReceiptSuccessorLocks(tx, closureCase))
      ]);
      const locked = await loadPhysicalReceiptAuthority(tx, command.orderId);
      if (physicalReceiptAuthorityIdentity(observed) !== physicalReceiptAuthorityIdentity(locked)) {
        throw serviceConflict("AUTHORITY_MISMATCH");
      }
      await assertExactPhysicalReceiptReplay(tx, locked, command, receiptSource);
      return Object.freeze({ vehicleReturnId: locked.vehicleReturn!.id });
    }
    if (
      closureCase.physicalControlMode !== command.physicalControlMode ||
      (command.physicalControlMode === "VOLUNTARY_RETURN" &&
        closureCase.status !== "PREPARING_RETURN" &&
        closureCase.status !== "RETURN_INSPECTION") ||
      (command.physicalControlMode === "RECOVERY" &&
        closureCase.status !== "RECOVERY_IN_PROGRESS" &&
        closureCase.status !== "RETURN_INSPECTION")
    ) {
      throw serviceConflict("MANAGED_RETURN_AUTHORITY_NOT_FOUND");
    }
    if (closureCase.status === "RETURN_INSPECTION") {
      if (command.physicalControlMode === "RECOVERY") {
        if (!this.assetAccounting) {
          throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
        }
        assertPhysicalReceiptObservedAuthority(observed, command);
        const recoveryClock = await readDatabaseClock(tx);
        const observedRecovery = await resolveRecoveryApprovalAuthority(
          tx,
          closureCase.id,
          recoveryClock
        );
        const approval = observed.recoveryApprovals[0];
        if (!approval) throw serviceConflict("AUTHORITY_MISMATCH");
        const replaySources = [
          receiptSource,
          physicalSource(closureCase.id, "physical-mileage:RECOVERY"),
          physicalSource(closureCase.id, "physical-period-close:RECOVERY"),
          physicalSource(
            closureCase.id,
            `physical-recovery-approval:${approval.id}:${approval.version}`
          ),
          recoveryDriftSource,
          physicalSource(closureCase.id, "recovery-restriction-secured-release"),
          physicalSource(closureCase.id, "return-inspection-restriction"),
          physicalSource(closureCase.id, "physical-work-order:RECOVERY")
        ].sort((left, right) => bytewiseCompare(sourceSortKey(left), sourceSortKey(right)));
        for (const replaySource of replaySources) {
          await this.repository.lockSourceOwnership(tx, replaySource);
        }
        await this.repository.lockAuthorityRows(tx, [
          ...physicalReceiptLocks(observed, command.actorId),
          ...observedRecovery.contextLocks,
          ...observedRecovery.documentLocks
        ]);
        const locked = await loadPhysicalReceiptAuthority(tx, command.orderId);
        const lockedRecovery = await resolveRecoveryApprovalAuthority(
          tx,
          closureCase.id,
          recoveryClock
        );
        if (
          physicalReceiptAuthorityIdentity(observed) !== physicalReceiptAuthorityIdentity(locked) ||
          canonicalSubscriptionClosureJson(lockedRecovery.authority) !==
            canonicalSubscriptionClosureJson(observedRecovery.authority)
        ) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        assertPhysicalReceiptObservedAuthority(locked, command);
        assertArchivedRecoveryAuthority(locked, command);
        await assertExactPhysicalReceiptReplay(tx, locked, command, receiptSource);
        return Object.freeze({ vehicleReturnId: locked.vehicleReturn!.id });
      }
      assertPhysicalReceiptObservedAuthority(observed, command);
      await assertExactPhysicalReceiptReplay(tx, observed, command, receiptSource);
      return Object.freeze({ vehicleReturnId: observed.vehicleReturn!.id });
    }
    if (command.physicalControlMode === "RECOVERY" && !this.assetAccounting) {
      throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
    }
    const recoveryClock =
      command.physicalControlMode === "RECOVERY" ? await readDatabaseClock(tx) : null;
    const observedRecovery = recoveryClock
      ? await resolveRecoveryApprovalAuthority(tx, closureCase.id, recoveryClock)
      : null;
    const periodSource = physicalSource(
      closureCase.id,
      `physical-period-close:${command.physicalControlMode}`
    );
    const workOrderSource = physicalSource(
      closureCase.id,
      `physical-work-order:${command.physicalControlMode}`
    );
    const restrictionSource = physicalSource(closureCase.id, "return-inspection-restriction");
    const recoveryReleaseSource = physicalSource(
      closureCase.id,
      "recovery-restriction-secured-release"
    );
    const mileageSource = physicalSource(
      closureCase.id,
      `physical-mileage:${command.physicalControlMode}`
    );
    let receiptSourceCapability: PreparedClosureSourceCapability | undefined;
    let periodCapability:
      | Awaited<ReturnType<AssetFactsService["prepareCallerOwnedTransaction"]>>
      | undefined;
    let workOrderCapability: AssetOperationsTransactionCapability | undefined;
    let restrictionCapability: AssetOperationsTransactionCapability | undefined;
    let recoveryReleaseCapability: AssetOperationsTransactionCapability | undefined;
    let recoveryApprovalCapability: AssetAccountingTransactionCapability | undefined;
    let recoveryDriftSourceCapability: PreparedClosureSourceCapability | undefined;
    let mileageCapability: VehicleMileageTransactionCapability | undefined;
    const preparations = [
      {
        prepare: async () => {
          mileageCapability = await this.vehicleMileage!.prepareCallerOwnedTransaction(
            tx,
            mileageSource
          );
        },
        source: mileageSource
      },
      {
        prepare: async () => {
          receiptSourceCapability = await this.repository.prepareSourceInTransaction(
            tx,
            receiptSource
          );
        },
        source: receiptSource
      },
      {
        prepare: async () => {
          periodCapability = await this.assetFacts!.prepareCallerOwnedTransaction(
            tx,
            "subscription",
            "end",
            periodSource
          );
        },
        source: periodSource
      },
      {
        prepare: async () => {
          workOrderCapability = await this.assetOperations.prepareCallerOwnedTransaction(
            tx,
            workOrderSource
          );
        },
        source: workOrderSource
      },
      {
        prepare: async () => {
          restrictionCapability = await this.assetOperations.prepareCallerOwnedTransaction(
            tx,
            restrictionSource
          );
        },
        source: restrictionSource
      },
      ...(command.physicalControlMode === "RECOVERY"
        ? [
            {
              prepare: async () => {
                const approval = observed.recoveryApprovals[0];
                if (!approval) throw serviceConflict("AUTHORITY_MISMATCH");
                recoveryApprovalCapability =
                  await this.assetAccounting!.prepareCallerOwnedTransaction(
                    tx,
                    physicalSource(
                      closureCase.id,
                      `physical-recovery-approval:${approval.id}:${approval.version}`
                    )
                  );
              },
              source: physicalSource(
                closureCase.id,
                `physical-recovery-approval:${observed.recoveryApprovals[0]?.id ?? closureCase.id}:${observed.recoveryApprovals[0]?.version ?? 0}`
              )
            },
            {
              prepare: async () => {
                recoveryDriftSourceCapability = await this.repository.prepareSourceInTransaction(
                  tx,
                  recoveryDriftSource
                );
              },
              source: recoveryDriftSource
            },
            {
              prepare: async () => {
                recoveryReleaseCapability =
                  await this.assetOperations.prepareCallerOwnedTransaction(
                    tx,
                    recoveryReleaseSource
                  );
              },
              source: recoveryReleaseSource
            }
          ]
        : [])
    ].sort((left, right) =>
      bytewiseCompare(sourceSortKey(left.source), sourceSortKey(right.source))
    );
    for (const preparation of preparations) await preparation.prepare();
    if (
      !receiptSourceCapability ||
      !periodCapability ||
      !workOrderCapability ||
      !restrictionCapability ||
      !mileageCapability ||
      (command.physicalControlMode === "RECOVERY" && !recoveryReleaseCapability) ||
      (command.physicalControlMode === "RECOVERY" && !recoveryApprovalCapability) ||
      (command.physicalControlMode === "RECOVERY" && !recoveryDriftSourceCapability)
    ) {
      throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
    }

    assertPhysicalReceiptAuthorityShape(observed, command);
    const workOrder = observed.workOrder!;
    const period = observed.period!;
    const workOrderAuthority = {
      assetOwnerId: workOrder.assetOwnerId,
      contractId: workOrder.contractId,
      customerId: workOrder.customerId,
      orderId: workOrder.orderId,
      relatedWorkOrderId: workOrder.relatedWorkOrderId,
      vehicleId: workOrder.vehicleId,
      workOrderId: workOrder.id
    };
    const recoveryReleaseCommand =
      command.physicalControlMode === "RECOVERY"
        ? {
            occurredAt: command.returnedAt,
            releaseReason: "RECOVERY_PHYSICAL_CONTROL_CONFIRMED",
            releaseSnapshot: {
              closureCaseId: closureCase.id,
              vehicleReturnId: observed.vehicleReturn!.id
            },
            restrictionId: observed.recoveryRestriction!.id,
            source: recoveryReleaseSource,
            targetStatus: VehicleOperationalRestrictionStatus.RELEASED
          }
        : null;
    const periodCommand = {
      confirmedAt: command.returnedAt.toISOString(),
      endedAt: command.returnedAt.toISOString(),
      periodId: period.id,
      reason:
        command.physicalControlMode === "RECOVERY"
          ? VehicleSubscriptionPeriodEndReason.RECOVERY_CONFIRMED
          : VehicleSubscriptionPeriodEndReason.RETURN_CONFIRMED,
      snapshot: {
        closureCaseId: closureCase.id,
        physicalControlMode: command.physicalControlMode,
        vehicleReturnId: observed.vehicleReturn!.id
      },
      source: periodSource
    };
    const transitionCommand = {
      closeReason: null,
      detailSnapshot: {
        closureCaseId: closureCase.id,
        physicalControlMode: command.physicalControlMode,
        vehicleReturnId: observed.vehicleReturn!.id
      },
      expectedVersion:
        workOrder.status === AssetWorkOrderStatus.IN_PROGRESS
          ? workOrder.version - 1
          : workOrder.version,
      occurredAt: command.returnedAt,
      solution: null,
      source: workOrderSource,
      targetStatus: AssetWorkOrderStatus.IN_PROGRESS,
      workOrderId: workOrder.id
    };
    const restrictionCommand = {
      conditionsSnapshot: {
        closureCaseId: closureCase.id,
        releaseCondition: "RETURN_INSPECTION_ACCEPTED"
      },
      evidenceSnapshot: { vehicleReturnId: observed.vehicleReturn!.id },
      occurredAt: command.returnedAt,
      restrictionType: VehicleOperationalRestrictionType.RETURN_INSPECTION_PENDING,
      scopes: [
        VehicleOperationalRestrictionScope.ALLOCATION,
        VehicleOperationalRestrictionScope.DELIVERY,
        VehicleOperationalRestrictionScope.INVENTORY_RELEASE
      ],
      severity: VehicleOperationalRestrictionSeverity.BLOCKING,
      source: restrictionSource,
      startedAt: command.returnedAt,
      vehicleId: observed.order!.vehicleId!,
      workOrderId: workOrder.id
    };
    const mileageCommand = {
      confirmedBy: command.actorId,
      evidenceSnapshot: {
        closureCaseId: closureCase.id,
        physicalControlMode: command.physicalControlMode
      },
      mileageKm: command.returnMileageKm,
      orderId: command.orderId,
      receiptVehicleStatus:
        observed.vehicleReturn!.maintenanceRequired || command.damages.length > 0
          ? VehicleStatus.MAINTENANCE
          : VehicleStatus.RETURNED,
      recordedAt: command.returnedAt,
      source: mileageSource,
      sourceRecordId: observed.vehicleReturn!.id,
      sourceType: VehicleMileageSourceType.RETURN_CONFIRMATION,
      vehicleId: observed.order!.vehicleId!
    };
    const receiptPayload = physicalReceiptPayload(command);
    const eventCommand = {
      actorId: command.actorId,
      afterStatus: "RETURN_INSPECTION" as const,
      closureCaseId: closureCase.id,
      detailSnapshot: {
        physicalControlMode: command.physicalControlMode,
        receiptPayload: receiptPayload as never,
        receiptPayloadHash: hashPhysicalReceiptPayload(receiptPayload),
        vehicleReturnId: observed.vehicleReturn!.id
      },
      eventType: "PHYSICAL_CONTROL_CONFIRMED" as const,
      expectedStatus:
        command.physicalControlMode === "RECOVERY"
          ? ("RECOVERY_IN_PROGRESS" as const)
          : ("PREPARING_RETURN" as const),
      expectedVersion: closureCase.version,
      occurredAt: command.returnedAt,
      source: receiptSource
    };
    const recoveryApproval =
      command.physicalControlMode === "RECOVERY" ? observed.recoveryApprovals[0] : null;
    const recoveryApprovalSource = recoveryApproval
      ? physicalSource(
          closureCase.id,
          `physical-recovery-approval:${recoveryApproval.id}:${recoveryApproval.version}`
        )
      : null;
    const recoveryApprovalCommand =
      recoveryApproval && observedRecovery && recoveryApprovalSource
        ? {
            approvalId: recoveryApproval.id,
            exceptionType: "RECOVERY_EXECUTION_APPROVAL" as const,
            expectedVersion: recoveryApproval.version,
            expiredAt: command.returnedAt,
            expiryReason: "Recovery authority facts changed before physical receipt.",
            source: recoveryApprovalSource,
            subject: recoveryApprovalSubject(closureCase.id)
          }
        : null;
    const recoveryApprovalContext = recoveryApprovalSource
      ? {
          actorId: command.actorId,
          idempotencyKey: recoveryApprovalSource.key,
          permissions: [ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST]
        }
      : null;
    const recoveryDriftEventCommand = observedRecovery
      ? {
          actorId: command.actorId,
          afterStatus: "PAUSED" as const,
          closureCaseId: closureCase.id,
          detailSnapshot: {
            approvalId: recoveryApproval?.id ?? null,
            pausedFromStatus: "RECOVERY_IN_PROGRESS",
            physicalCommandFingerprint,
            reason: "RECOVERY_AUTHORITY_DRIFT",
            recoveryAction: "PAUSE"
          },
          eventType: "STATUS_TRANSITIONED" as const,
          expectedStatus: "RECOVERY_IN_PROGRESS" as const,
          expectedVersion: closureCase.version,
          occurredAt: command.returnedAt,
          source: recoveryDriftSource
        }
      : null;
    const periodAuthority = {
      contractId: period.contractId,
      contractSegmentId: period.contractSegmentId,
      customerId: period.customerId,
      orderId: period.orderId,
      periodId: period.id,
      vehicleId: period.vehicleId
    };
    const authoritySession = this.repository.createAuthoritySessionInTransaction(tx);
    const requirements = [
      this.assetFacts!.subscriptionCloseAuthorityRequirement(
        authoritySession,
        periodCommand,
        periodAuthority
      ),
      this.assetOperations.workOrderTransitionAuthorityRequirement(
        authoritySession,
        transitionCommand,
        command.actorId,
        workOrderAuthority
      ),
      ...(recoveryReleaseCommand
        ? [
            this.assetOperations.restrictionReleaseAuthorityRequirement(
              authoritySession,
              recoveryReleaseCommand,
              command.actorId,
              workOrderAuthority,
              recoveryReleaseCommand.restrictionId
            )
          ]
        : []),
      this.assetOperations.restrictionCreateAuthorityRequirement(
        authoritySession,
        restrictionCommand,
        command.actorId,
        workOrderAuthority
      ),
      this.vehicleMileage!.appendAuthorityRequirement(
        authoritySession,
        mileageCommand,
        "physical-mileage"
      ),
      this.repository.bindAuthorityRequirement(
        authoritySession,
        subscriptionClosureEventAuthorityRequirement(eventCommand)
      ),
      ...(recoveryApprovalCommand && recoveryApprovalContext && observedRecovery
        ? [
            this.assetAccounting!.approvedExceptionAuthorityRequirement(
              authoritySession,
              recoveryApprovalCommand,
              recoveryApprovalContext,
              observedRecovery.authority,
              "physical-recovery-approval"
            )
          ]
        : []),
      ...(recoveryDriftEventCommand
        ? [
            this.repository.bindAuthorityRequirement(
              authoritySession,
              subscriptionClosureEventAuthorityRequirement(
                recoveryDriftEventCommand,
                "physical-recovery-drift"
              )
            )
          ]
        : [])
    ];
    const attestations = await this.repository.prepareAuthorityInTransaction(
      tx,
      authoritySession,
      [
        ...physicalReceiptLocks(observed, command.actorId),
        ...(observedRecovery
          ? [...observedRecovery.contextLocks, ...observedRecovery.documentLocks]
          : []),
        ...requirements.flatMap(({ locks }) => locks)
      ],
      requirements
    );
    const locked = await loadPhysicalReceiptAuthority(tx, command.orderId);
    if (physicalReceiptAuthorityIdentity(observed) !== physicalReceiptAuthorityIdentity(locked)) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    if (
      observedRecovery &&
      recoveryClock &&
      recoveryApprovalCommand &&
      recoveryApprovalContext &&
      recoveryDriftEventCommand
    ) {
      const lockedRecovery = await resolveRecoveryApprovalAuthority(
        tx,
        closureCase.id,
        recoveryClock
      );
      if (
        canonicalSubscriptionClosureJson(lockedRecovery.authority) !==
        canonicalSubscriptionClosureJson(observedRecovery.authority)
      ) {
        throw serviceConflict("AUTHORITY_MISMATCH");
      }
      const preparedApproval =
        await this.assetAccounting!.attestPreparedApprovedExceptionInTransaction(
          tx,
          authoritySession,
          recoveryApprovalCommand,
          recoveryApprovalContext,
          lockedRecovery.authority,
          requiredValue<AssetAccountingTransactionCapability>(recoveryApprovalCapability),
          requiredAttestation(attestations, "physical-recovery-approval"),
          "physical-recovery-approval"
        );
      const currentApproval =
        await this.assetAccounting!.requirePreparedApprovedExceptionInTransaction(
          tx,
          preparedApproval
        );
      if (!currentApproval || !lockedRecovery.contextActionable) {
        await this.repository.appendPreparedEventInTransaction(
          tx,
          authoritySession,
          recoveryDriftEventCommand,
          requiredValue<PreparedClosureSourceCapability>(recoveryDriftSourceCapability),
          requiredAttestation(attestations, "physical-recovery-drift"),
          this.closureAudit(command.actorId),
          "physical-recovery-drift"
        );
        return null;
      }
    }
    assertPhysicalReceiptObservedAuthority(locked, command);
    if (command.physicalControlMode === "RECOVERY") {
      assertArchivedRecoveryAuthority(locked, command);
    } else {
      assertArchivedReturnManifestAuthority(locked, command);
    }

    const preparedPeriod = await this.assetFacts!.attestSubscriptionCloseAuthorityInTransaction(
      tx,
      authoritySession,
      periodCommand,
      { actorId: command.actorId, ...context },
      periodCapability,
      periodAuthority,
      requiredAttestation(attestations, "physical-period-close")
    );
    const preparedTransition = await this.assetOperations.attestPreparedTransitionInTransaction(
      tx,
      authoritySession,
      transitionCommand,
      { actorId: command.actorId, permissions: [], ...context },
      workOrderCapability,
      workOrderAuthority,
      requiredAttestation(attestations, "physical-work-order")
    );
    const preparedRestriction =
      await this.assetOperations.attestPreparedRestrictionCreateInTransaction(
        tx,
        authoritySession,
        restrictionCommand,
        { actorId: command.actorId, permissions: [], ...context },
        restrictionCapability,
        workOrderAuthority,
        requiredAttestation(attestations, "return-inspection-restriction")
      );
    const preparedMileage = await this.vehicleMileage!.attestPreparedAppendInTransaction(
      tx,
      authoritySession,
      mileageCommand,
      mileageCapability,
      requiredAttestation(attestations, "physical-mileage"),
      "physical-mileage"
    );

    await this.assetFacts!.closePreparedSubscriptionPeriodInTransaction(tx, preparedPeriod);
    const mileageReading = await this.vehicleMileage!.appendPreparedReadingInTransaction(
      tx,
      preparedMileage
    );
    await applyPhysicalReceiptFacts(
      tx,
      locked,
      command,
      context,
      this.auditService,
      mileageReading
    );
    await this.assetOperations.transitionPreparedWorkOrderInTransaction(tx, preparedTransition);
    if (recoveryReleaseCommand && recoveryReleaseCapability) {
      const preparedRecoveryRelease =
        await this.assetOperations.attestPreparedRestrictionReleaseInTransaction(
          tx,
          authoritySession,
          recoveryReleaseCommand,
          {
            actorId: command.actorId,
            permissions: ["vehicle_restriction:release"],
            ...context
          },
          recoveryReleaseCapability,
          workOrderAuthority,
          requiredAttestation(attestations, "inspection-restriction-release")
        );
      await this.assetOperations.releasePreparedRestrictionInTransaction(
        tx,
        preparedRecoveryRelease
      );
    }
    await this.assetOperations.createPreparedRestrictionInTransaction(tx, preparedRestriction);
    await this.repository.appendPreparedEventInTransaction(
      tx,
      authoritySession,
      eventCommand,
      receiptSourceCapability,
      requiredAttestation(attestations, "physical-receipt"),
      this.closureAudit(command.actorId)
    );
    return Object.freeze({ vehicleReturnId: locked.vehicleReturn!.id });
  }

  async recordManagedReturnInspection(
    input: RecordManagedReturnInspectionInput,
    context: Readonly<{ ipAddress?: string; userAgent?: string }>
  ) {
    if (!this.prisma || !this.assetAccounting) {
      throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
    }
    const command = normalizeInspectionInput(input);
    return this.prisma.$transaction(
      async (tx) => this.recordManagedReturnInspectionInTransaction(tx, command, context),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  private async recordManagedReturnInspectionInTransaction(
    tx: Prisma.TransactionClient,
    command: RecordManagedReturnInspectionInput,
    context: Readonly<{ ipAddress?: string; userAgent?: string }>
  ) {
    const closureCase = await tx.subscriptionClosureCase.findUnique({
      where: { id: command.closureCaseId }
    });
    if (
      !closureCase ||
      !["RETURN_INSPECTION", "RECONDITIONING"].includes(closureCase.status) ||
      !command.accepted ||
      (closureCase.status === "RECONDITIONING" && command.reconditioningRequired)
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const inspectionWorkOrderId =
      closureCase.status === "RECONDITIONING"
        ? closureCase.reconditioningAssetWorkOrderId
        : closureCase.physicalControlMode === "RECOVERY"
          ? closureCase.recoveryAssetWorkOrderId
          : closureCase.returnAssetWorkOrderId;
    if (!inspectionWorkOrderId) throw serviceConflict("AUTHORITY_MISMATCH");
    const inspectionWorkOrder = await tx.assetWorkOrder.findUnique({
      where: { id: inspectionWorkOrderId }
    });
    if (!inspectionWorkOrder || inspectionWorkOrder.status !== AssetWorkOrderStatus.CLOSED) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    if (
      closureCase.status === "RETURN_INSPECTION" &&
      !command.evidence.some(({ action }) => action !== "REMOVE")
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    if (command.costs.some(({ actionType }) => actionType !== VehicleCostActionType.ACTUAL_COST)) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const authority = workOrderAuthorityOf(inspectionWorkOrder);
    const operationContext = { actorId: command.actorId, permissions: [], ...context };
    const accountingContext = {
      actorId: command.actorId,
      permissions: [ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM],
      ...context
    };
    const evidenceCommands = command.evidence.map((item, index) => ({
      ...item,
      source: physicalSource(closureCase.id, `inspection-evidence:${index}`),
      workOrderId: inspectionWorkOrder.id
    }));
    const costCommands = command.costs.map((item, index) => ({
      ...item,
      contractId: closureCase.contractId,
      customerId: closureCase.customerId,
      orderId: closureCase.orderId,
      source: physicalSource(closureCase.id, `inspection-cost:${index}`),
      vehicleId: closureCase.vehicleId,
      workOrderId: inspectionWorkOrder.id
    }));
    const transitionKey = `inspection-transition:${closureCase.status}`;
    const transitionSource = physicalSource(closureCase.id, transitionKey);
    const reconditioningSource = physicalSource(closureCase.id, "reconditioning-work-order");
    const reconditioningWorkOrderId =
      closureCase.status === "RETURN_INSPECTION" && command.reconditioningRequired
        ? randomUUID()
        : null;
    const reconditioningCommand: CreateWorkOrderServiceCommand | null = reconditioningWorkOrderId
      ? {
          assetOwnerId: inspectionWorkOrder.assetOwnerId,
          contractId: closureCase.contractId,
          costConfirmationRequired: true,
          customerId: closureCase.customerId,
          description: `Return reconditioning for closure ${closureCase.caseNo}`,
          metadata: { closureCaseId: closureCase.id, inspectionWorkOrderId },
          occurredAt: command.occurredAt,
          orderId: closureCase.orderId,
          priority: "NORMAL",
          relatedWorkOrderId: inspectionWorkOrder.id,
          source: reconditioningSource,
          vehicleId: closureCase.vehicleId,
          workOrderType: "RECONDITIONING"
        }
      : null;
    const eventCommand = {
      actorId: command.actorId,
      afterStatus: reconditioningWorkOrderId
        ? ("RECONDITIONING" as const)
        : ("PENDING_SETTLEMENT" as const),
      closureCaseId: closureCase.id,
      detailSnapshot: {
        accepted: true,
        costCount: costCommands.length,
        evidenceCount: evidenceCommands.length,
        reconditioningAssetWorkOrderId: reconditioningWorkOrderId
      },
      eventType: "INSPECTION_RECORDED" as const,
      expectedStatus: closureCase.status,
      expectedVersion: closureCase.version,
      occurredAt: command.occurredAt,
      reconditioningAssetWorkOrderId: reconditioningWorkOrderId,
      source: transitionSource
    };
    const sourceCaps = new Map<string, unknown>();
    const preparations: Array<{
      prepare: () => Promise<void>;
      source: SubscriptionClosureSource;
    }> = [
      ...evidenceCommands.map((item) => ({
        prepare: async () => {
          sourceCaps.set(
            item.source.key,
            await this.assetOperations.prepareCallerOwnedTransaction(tx, item.source)
          );
        },
        source: item.source
      })),
      ...costCommands.map((item) => ({
        prepare: async () => {
          sourceCaps.set(
            item.source.key,
            await this.assetAccounting!.prepareCallerOwnedTransaction(tx, item.source)
          );
        },
        source: item.source
      })),
      ...(reconditioningCommand
        ? [
            {
              prepare: async () => {
                sourceCaps.set(
                  reconditioningSource.key,
                  await this.assetOperations.prepareCallerOwnedTransaction(tx, reconditioningSource)
                );
              },
              source: reconditioningSource
            }
          ]
        : []),
      {
        prepare: async () => {
          sourceCaps.set(
            transitionSource.key,
            await this.repository.prepareSourceInTransaction(tx, transitionSource)
          );
        },
        source: transitionSource
      }
    ].sort((left, right) =>
      bytewiseCompare(sourceSortKey(left.source), sourceSortKey(right.source))
    );
    for (const preparation of preparations) await preparation.prepare();
    const session = this.repository.createAuthoritySessionInTransaction(tx);
    const requirements = [
      ...evidenceCommands.map((item, index) =>
        this.assetOperations.evidenceAuthorityRequirement(
          session,
          item,
          command.actorId,
          authority,
          `inspection-evidence:${index}`
        )
      ),
      ...costCommands.map((item, index) =>
        this.assetAccounting!.appendCostAuthorityRequirement(
          session,
          item,
          accountingContext,
          { authoritativeOrderId: closureCase.orderId },
          `inspection-cost:${index}`
        )
      ),
      ...(reconditioningCommand && reconditioningWorkOrderId
        ? [
            this.assetOperations.createAuthorityRequirement(
              session,
              reconditioningCommand,
              command.actorId,
              reconditioningWorkOrderId
            )
          ]
        : []),
      this.repository.bindAuthorityRequirement(
        session,
        subscriptionClosureEventAuthorityRequirement(eventCommand, transitionKey)
      )
    ];
    const proofs = await this.repository.prepareAuthorityInTransaction(
      tx,
      session,
      requirements.flatMap(({ locks }) => locks),
      requirements
    );
    const lockedCase = await tx.subscriptionClosureCase.findUnique({
      where: { id: closureCase.id }
    });
    const lockedWorkOrder = await tx.assetWorkOrder.findUnique({
      where: { id: inspectionWorkOrder.id }
    });
    if (
      canonicalSubscriptionClosureJson(lockedCase as never) !==
        canonicalSubscriptionClosureJson(closureCase as never) ||
      canonicalSubscriptionClosureJson(lockedWorkOrder as never) !==
        canonicalSubscriptionClosureJson(inspectionWorkOrder as never)
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const preparedEvidence = await Promise.all(
      evidenceCommands.map((item, index) =>
        this.assetOperations.attestPreparedEvidenceInTransaction(
          tx,
          session,
          item,
          operationContext,
          requiredCapability(sourceCaps, item.source.key),
          authority,
          requiredAttestation(proofs, `inspection-evidence:${index}`),
          `inspection-evidence:${index}`
        )
      )
    );
    const preparedCosts = await Promise.all(
      costCommands.map((item, index) =>
        this.assetAccounting!.attestPreparedAppendCostInTransaction(
          tx,
          session,
          item,
          { ...accountingContext, idempotencyKey: item.source.key },
          requiredCapability(sourceCaps, item.source.key),
          { authoritativeOrderId: closureCase.orderId },
          requiredAttestation(proofs, `inspection-cost:${index}`),
          `inspection-cost:${index}`
        )
      )
    );
    const preparedReconditioning =
      reconditioningCommand && reconditioningWorkOrderId
        ? await this.assetOperations.attestCallerOwnedCreateAuthorityInTransaction(
            tx,
            session,
            reconditioningCommand,
            operationContext,
            requiredCapability(sourceCaps, reconditioningSource.key),
            requiredAttestation(proofs, "asset-create"),
            reconditioningWorkOrderId
          )
        : null;
    for (const prepared of preparedEvidence) {
      await this.assetOperations.appendPreparedEvidenceInTransaction(tx, prepared);
    }
    for (const prepared of preparedCosts) {
      await this.assetAccounting!.appendPreparedCostInTransaction(tx, prepared);
    }
    if (preparedReconditioning) {
      await this.assetOperations.createPreparedWorkOrderInTransaction(tx, preparedReconditioning);
    }
    const outcome = await this.repository.appendPreparedEventInTransaction(
      tx,
      session,
      eventCommand,
      requiredCapability(sourceCaps, transitionSource.key),
      requiredAttestation(proofs, transitionKey),
      this.closureAudit(command.actorId),
      transitionKey
    );
    return outcome.outcome;
  }

  async proposeManagedSettlement(
    input: ManagedSettlementInput
  ): Promise<SubscriptionClosureSettlementSnapshot> {
    const command = normalizeManagedSettlementInput(input);
    if (!this.prisma || !this.assetAccounting || !this.settlementResolver) {
      throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
    }
    const transactionResult = await this.prisma.$transaction(
      async (tx) => this.writeManagedSettlementInTransaction(tx, command, "PROPOSED"),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
    if (transactionResult.staleApproval) {
      throw serviceConflict("SETTLEMENT_APPROVAL_STALE");
    }
    return transactionResult.outcome;
  }

  async finalizeManagedSettlement(
    input: ManagedSettlementInput
  ): Promise<SubscriptionClosureSettlementSnapshot> {
    return this.runManagedSettlementWrite(input, "FINALIZED");
  }

  async settleManagedSettlement(
    input: ManagedSettlementInput
  ): Promise<SubscriptionClosureSettlementSnapshot> {
    return this.runManagedSettlementWrite(input, "SETTLED");
  }

  private async runManagedSettlementWrite(
    input: ManagedSettlementInput,
    targetStage: "FINALIZED" | "SETTLED"
  ): Promise<SubscriptionClosureSettlementSnapshot> {
    const command = normalizeManagedSettlementInput(input);
    if (!this.prisma || !this.assetAccounting || !this.settlementResolver) {
      throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
    }
    const transactionResult = await this.prisma.$transaction(
      async (tx) => this.writeManagedSettlementInTransaction(tx, command, targetStage),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
    if (transactionResult.staleApproval) {
      throw serviceConflict("SETTLEMENT_APPROVAL_STALE");
    }
    return transactionResult.outcome;
  }

  private async writeManagedSettlementInTransaction(
    tx: Prisma.TransactionClient,
    command: ManagedSettlementInput,
    targetStage: "PROPOSED" | "FINALIZED" | "SETTLED"
  ): Promise<
    | Readonly<{ outcome: null; staleApproval: true }>
    | Readonly<{ outcome: SubscriptionClosureSettlementSnapshot; staleApproval: false }>
  > {
    const settlementSource = physicalSource(command.closureCaseId, command.idempotencyKey);
    const replay = await replayManagedSettlement(tx, command, targetStage, settlementSource);
    if (replay) return Object.freeze({ outcome: replay, staleApproval: false });
    const observedResolution = await this.settlementResolver!.resolveInTransaction(
      tx,
      command.closureCaseId
    );
    const observedCase = await tx.subscriptionClosureCase.findUnique({
      include: { currentSettlementRevision: true },
      where: { id: command.closureCaseId }
    });
    assertSettlementCase(observedCase, observedResolution);
    assertSettlementPredecessor(targetStage, observedCase, observedResolution);
    if (targetStage === "SETTLED" && !observedResolution.obligationsResolved) {
      throw serviceConflict("SETTLEMENT_NOT_RESOLVED");
    }
    assertSettlementApprovalShape(command, observedResolution);
    const lifecycleClock = await readSettlementLifecycleClock(tx, command.closureCaseId);
    assertSettlementChronology(targetStage, command.occurredAt, observedCase, lifecycleClock);

    const terminalSource =
      targetStage === "SETTLED"
        ? physicalSource(command.closureCaseId, `${command.idempotencyKey}:closure`)
        : null;
    const approvalInputs = await this.settlementApprovalInputs(
      tx,
      command,
      observedResolution,
      settlementSource,
      lifecycleClock.clockTimestamp
    );
    let settlementSourceCapability: PreparedClosureSourceCapability | undefined;
    let terminalSourceCapability: PreparedClosureSourceCapability | undefined;
    const approvalSourceCapabilities = new Map<string, unknown>();
    const sourcePreparations: Array<{
      prepare: () => Promise<void>;
      source: SubscriptionClosureSource;
    }> = [
      {
        prepare: async () => {
          settlementSourceCapability = await this.repository.prepareSourceInTransaction(
            tx,
            settlementSource
          );
        },
        source: settlementSource
      },
      ...(terminalSource
        ? [
            {
              prepare: async () => {
                terminalSourceCapability = await this.repository.prepareSourceInTransaction(
                  tx,
                  terminalSource
                );
              },
              source: terminalSource
            }
          ]
        : []),
      ...approvalInputs.map((approval) => ({
        prepare: async () => {
          approvalSourceCapabilities.set(
            approval.source.key,
            await this.assetAccounting!.prepareCallerOwnedTransaction(tx, approval.source)
          );
        },
        source: approval.source
      }))
    ].sort((left, right) =>
      bytewiseCompare(sourceSortKey(left.source), sourceSortKey(right.source))
    );
    for (const preparation of sourcePreparations) await preparation.prepare();
    if (!settlementSourceCapability) throw serviceConflict("CAPABILITY_INVALID");
    const serializedReplay = await replayManagedSettlement(
      tx,
      command,
      targetStage,
      settlementSource
    );
    if (serializedReplay) {
      return Object.freeze({ outcome: serializedReplay, staleApproval: false });
    }

    const authorityKey = `settlement-${targetStage.toLowerCase()}`;
    const settlementCommand = settlementRevisionCommand(
      command,
      observedCase!,
      observedResolution,
      settlementSource,
      targetStage,
      lifecycleClock.clockTimestamp
    );
    const terminalStatus = settlementTerminalStatus(observedCase!);
    const terminalCommand =
      targetStage === "SETTLED" && terminalSource
        ? {
            actorId: command.actorId,
            afterStatus: terminalStatus,
            closureCaseId: command.closureCaseId,
            detailSnapshot: {
              inputSnapshotHash: observedResolution.inputSnapshotHash,
              resultHash: observedResolution.resultHash,
              settlementSource
            },
            eventType: "STATUS_TRANSITIONED" as const,
            expectedStatus: "PENDING_SETTLEMENT" as const,
            expectedVersion: observedCase!.version + 1,
            occurredAt: lifecycleClock.clockTimestamp,
            source: terminalSource
          }
        : null;
    const session = this.repository.createAuthoritySessionInTransaction(tx);
    const settlementRequirement = this.repository.bindAuthorityRequirement(
      session,
      subscriptionClosureSettlementAuthorityRequirement(
        settlementCommand,
        observedResolution.authorityLocks,
        authorityKey
      )
    );
    const accountingContext = {
      actorId: command.actorId,
      permissions: [ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST]
    };
    const approvalRequirements = approvalInputs.map((approval) =>
      this.assetAccounting!.approvedExceptionAuthorityRequirement(
        session,
        approval.command,
        { ...accountingContext, idempotencyKey: approval.source.key },
        approval.authoritySnapshot,
        approval.key
      )
    );
    const terminalRequirement = terminalCommand
      ? this.repository.bindAuthorityRequirement(
          session,
          subscriptionClosureEventAuthorityRequirement(terminalCommand, "closure-complete")
        )
      : null;
    const requirements = [
      settlementRequirement,
      ...approvalRequirements,
      ...(terminalRequirement ? [terminalRequirement] : [])
    ];
    const proofs = await this.repository.prepareAuthorityInTransaction(
      tx,
      session,
      requirements.flatMap(({ locks }) => locks),
      requirements
    );

    const lockedResolution = await this.settlementResolver!.resolveInTransaction(
      tx,
      command.closureCaseId
    );
    const lockedCase = await tx.subscriptionClosureCase.findUnique({
      include: { currentSettlementRevision: true },
      where: { id: command.closureCaseId }
    });
    if (
      lockedResolution.inputSnapshotHash !== observedResolution.inputSnapshotHash ||
      canonicalSubscriptionClosureJson({ locks: lockedResolution.authorityLocks }) !==
        canonicalSubscriptionClosureJson({ locks: observedResolution.authorityLocks }) ||
      canonicalSubscriptionClosureJson(settlementCaseIdentity(lockedCase)) !==
        canonicalSubscriptionClosureJson(settlementCaseIdentity(observedCase))
    ) {
      throw serviceConflict("SETTLEMENT_FACT_DRIFT");
    }

    const preparedApprovals: AssetAccountingPreparedApprovalCapability[] = [];
    for (const approval of approvalInputs) {
      preparedApprovals.push(
        await this.assetAccounting!.attestPreparedApprovedExceptionInTransaction(
          tx,
          session,
          approval.command,
          { ...accountingContext, idempotencyKey: approval.source.key },
          approval.authoritySnapshot,
          requiredCapability(approvalSourceCapabilities, approval.source.key),
          requiredAttestation(proofs, approval.key),
          approval.key
        )
      );
    }
    const approvalResults: boolean[] = [];
    for (const prepared of preparedApprovals) {
      approvalResults.push(
        await this.assetAccounting!.requirePreparedApprovedExceptionInTransaction(tx, prepared)
      );
    }
    if (approvalResults.some((valid) => !valid)) {
      return Object.freeze({ outcome: null, staleApproval: true });
    }
    const appended = await this.repository.appendPreparedSettlementRevisionInTransaction(
      tx,
      session,
      settlementCommand,
      settlementSourceCapability,
      requiredAttestation(proofs, authorityKey),
      observedResolution.authorityLocks,
      this.closureAudit(command.actorId),
      authorityKey
    );
    if (terminalCommand) {
      if (!terminalSourceCapability) throw serviceConflict("CAPABILITY_INVALID");
      const terminalPersistenceAt = new Date(appended.outcome.createdAt);
      if (
        Number.isNaN(terminalPersistenceAt.getTime()) ||
        terminalPersistenceAt.getTime() !== terminalCommand.occurredAt.getTime()
      ) {
        throw serviceConflict("SETTLEMENT_FACT_DRIFT");
      }
      const beforeOrder = await tx.subscriptionOrder.findUnique({
        where: { id: observedResolution.orderId }
      });
      const beforeContract = await tx.contract.findUnique({
        where: { id: observedResolution.contractId }
      });
      if (
        !beforeOrder ||
        beforeOrder.orderStatus !== OrderStatus.RETURNED_PENDING_SETTLEMENT ||
        !beforeContract ||
        beforeContract.status !== ContractStatus.ARCHIVED
      ) {
        throw serviceConflict("SETTLEMENT_STATUS_CONFLICT");
      }
      const afterOrder = await tx.subscriptionOrder.update({
        data: { orderStatus: terminalStatus, updatedBy: command.actorId },
        where: { id: observedResolution.orderId }
      });
      const afterContract = await tx.contract.update({
        data: { status: terminalStatus, updatedBy: command.actorId },
        where: { id: observedResolution.contractId }
      });
      await this.auditService.write(
        {
          action: AuditAction.UPDATE,
          after: physicalAuditSnapshot(afterOrder),
          before: physicalAuditSnapshot(beforeOrder),
          createdAt: terminalPersistenceAt,
          entityId: observedResolution.orderId,
          entityType: "subscription_order",
          module: "subscription_closure",
          operatorId: command.actorId
        },
        tx
      );
      await this.auditService.write(
        {
          action: AuditAction.UPDATE,
          after: physicalAuditSnapshot(afterContract),
          before: physicalAuditSnapshot(beforeContract),
          createdAt: terminalPersistenceAt,
          entityId: observedResolution.contractId,
          entityType: "contract",
          module: "subscription_closure",
          operatorId: command.actorId
        },
        tx
      );
      await this.repository.appendPreparedEventInTransaction(
        tx,
        session,
        terminalCommand,
        terminalSourceCapability,
        requiredAttestation(proofs, "closure-complete"),
        this.closureAudit(command.actorId),
        "closure-complete"
      );
    }
    return Object.freeze({ outcome: appended.outcome, staleApproval: false });
  }

  private async settlementApprovalInputs(
    tx: Prisma.TransactionClient,
    command: ManagedSettlementInput,
    resolution: ResolvedSubscriptionClosureSettlement,
    settlementSource: SubscriptionClosureSource,
    lifecycleClock: Date
  ) {
    const specifications = [
      {
        amountCents: resolution.waiverTotalCents,
        approvalId: command.waiverApprovalId,
        exceptionType: "SETTLEMENT_WAIVER" as const,
        key: "waiver-check",
        sourceKey: `${settlementSource.key}:waiver-current`,
        subjectField: "settlementWaiver"
      },
      {
        amountCents: resolution.writeOffTotalCents,
        approvalId: command.writeOffApprovalId,
        exceptionType: "SETTLEMENT_WRITE_OFF" as const,
        key: "write-off-check",
        sourceKey: `${settlementSource.key}:write-off-current`,
        subjectField: "settlementWriteOff"
      }
    ].filter(({ amountCents }) => amountCents > 0n);
    const approvals = [];
    for (const specification of specifications) {
      const approval = await tx.businessExceptionApproval.findUnique({
        select: { id: true, version: true },
        where: { id: specification.approvalId! }
      });
      if (!approval) throw serviceConflict("SETTLEMENT_APPROVAL_REQUIRED");
      const source = physicalSource(command.closureCaseId, specification.sourceKey);
      const authoritySnapshot = {
        amountCents: specification.amountCents.toString(),
        closureCaseId: resolution.closureCaseId,
        inputSnapshotHash: resolution.inputSnapshotHash,
        orderId: resolution.orderId,
        resolutionType: specification.exceptionType,
        resultHash: resolution.resultHash
      };
      approvals.push(
        Object.freeze({
          authoritySnapshot,
          command: {
            approvalId: approval.id,
            exceptionType: specification.exceptionType,
            expectedVersion: approval.version,
            expiredAt: lifecycleClock,
            expiryReason: "Authoritative settlement facts changed.",
            source,
            subject: {
              subjectField: specification.subjectField,
              subjectId: command.closureCaseId,
              subjectType: "SETTLEMENT_CASE" as const
            }
          },
          key: specification.key,
          source
        })
      );
    }
    return approvals;
  }

  async releaseManagedReturnInventory(
    input: ReleaseManagedInventoryInput,
    context: Readonly<{ ipAddress?: string; userAgent?: string }>
  ) {
    if (!this.prisma) throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
    const command = normalizeInventoryReleaseInput(input);
    return this.prisma.$transaction(
      async (tx) => this.releaseManagedReturnInventoryInTransaction(tx, command, context),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  private async releaseManagedReturnInventoryInTransaction(
    tx: Prisma.TransactionClient,
    command: ReleaseManagedInventoryInput,
    context: Readonly<{ ipAddress?: string; userAgent?: string }>
  ) {
    const closureCase = await tx.subscriptionClosureCase.findUnique({
      where: { id: command.closureCaseId }
    });
    if (!closureCase || closureCase.status !== "PENDING_SETTLEMENT") {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const restrictions = await tx.vehicleOperationalRestriction.findMany({
      where: {
        startSourceId: closureCase.id,
        startSourceKey: "return-inspection-restriction",
        startSourceType: "SUBSCRIPTION_CLOSURE",
        restrictionType: VehicleOperationalRestrictionType.RETURN_INSPECTION_PENDING,
        status: "ACTIVE"
      }
    });
    const restriction = restrictions.length === 1 ? restrictions[0] : null;
    const expectedInspectionWorkOrderId =
      closureCase.physicalControlMode === "RECOVERY"
        ? closureCase.recoveryAssetWorkOrderId
        : closureCase.returnAssetWorkOrderId;
    if (
      !restriction?.workOrderId ||
      restriction.vehicleId !== closureCase.vehicleId ||
      restriction.workOrderId !== expectedInspectionWorkOrderId
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const workOrder = await tx.assetWorkOrder.findUnique({
      where: { id: restriction.workOrderId }
    });
    const vehicle = await tx.vehicle.findUnique({ where: { id: closureCase.vehicleId } });
    if (
      !workOrder ||
      workOrder.status !== AssetWorkOrderStatus.CLOSED ||
      !vehicle ||
      vehicle.deletedAt ||
      (vehicle.status !== VehicleStatus.RETURNED && vehicle.status !== VehicleStatus.MAINTENANCE)
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const restrictionSource = physicalSource(closureCase.id, "inspection-restriction-release");
    const inventorySource = physicalSource(closureCase.id, "inventory-release");
    let restrictionCapability: AssetOperationsTransactionCapability | undefined;
    let inventoryCapability: PreparedClosureSourceCapability | undefined;
    const preparations = [
      {
        prepare: async () => {
          restrictionCapability = await this.assetOperations.prepareCallerOwnedTransaction(
            tx,
            restrictionSource
          );
        },
        source: restrictionSource
      },
      {
        prepare: async () => {
          inventoryCapability = await this.repository.prepareSourceInTransaction(
            tx,
            inventorySource
          );
        },
        source: inventorySource
      }
    ].sort((left, right) =>
      bytewiseCompare(sourceSortKey(left.source), sourceSortKey(right.source))
    );
    for (const preparation of preparations) await preparation.prepare();
    if (!restrictionCapability || !inventoryCapability) {
      throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
    }
    const authority = workOrderAuthorityOf(workOrder);
    const operationContext = {
      actorId: command.actorId,
      permissions: ["vehicle_restriction:release"],
      ...context
    };
    const releaseCommand = {
      occurredAt: command.occurredAt,
      releaseReason: command.releaseReason,
      releaseSnapshot: { closureCaseId: closureCase.id, inspectionAccepted: true },
      restrictionId: restriction.id,
      source: restrictionSource,
      targetStatus: "RELEASED" as const
    };
    const eventCommand = {
      actorId: command.actorId,
      afterStatus: "PENDING_SETTLEMENT" as const,
      closureCaseId: closureCase.id,
      detailSnapshot: { restrictionId: restriction.id, vehicleId: vehicle.id },
      eventType: "INVENTORY_RELEASED" as const,
      expectedStatus: "PENDING_SETTLEMENT" as const,
      expectedVersion: closureCase.version,
      occurredAt: command.occurredAt,
      source: inventorySource
    };
    const session = this.repository.createAuthoritySessionInTransaction(tx);
    const releaseRequirement = this.assetOperations.restrictionReleaseAuthorityRequirement(
      session,
      releaseCommand,
      command.actorId,
      authority,
      restriction.id
    );
    const eventRequirement = this.repository.bindAuthorityRequirement(
      session,
      subscriptionClosureEventAuthorityRequirement(eventCommand, "inventory-release")
    );
    const proofs = await this.repository.prepareAuthorityInTransaction(
      tx,
      session,
      [...releaseRequirement.locks, ...eventRequirement.locks],
      [releaseRequirement, eventRequirement]
    );
    const [lockedCase, lockedRestriction, lockedWorkOrder, lockedVehicle] = await Promise.all([
      tx.subscriptionClosureCase.findUnique({ where: { id: closureCase.id } }),
      tx.vehicleOperationalRestriction.findUnique({ where: { id: restriction.id } }),
      tx.assetWorkOrder.findUnique({ where: { id: workOrder.id } }),
      tx.vehicle.findUnique({ where: { id: vehicle.id } })
    ]);
    if (
      canonicalSubscriptionClosureJson(lockedCase as never) !==
        canonicalSubscriptionClosureJson(closureCase as never) ||
      canonicalSubscriptionClosureJson(lockedRestriction as never) !==
        canonicalSubscriptionClosureJson(restriction as never) ||
      canonicalSubscriptionClosureJson(lockedWorkOrder as never) !==
        canonicalSubscriptionClosureJson(workOrder as never) ||
      canonicalSubscriptionClosureJson(lockedVehicle as never) !==
        canonicalSubscriptionClosureJson(vehicle as never)
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    const preparedRelease =
      await this.assetOperations.attestPreparedRestrictionReleaseInTransaction(
        tx,
        session,
        releaseCommand,
        operationContext,
        restrictionCapability,
        authority,
        requiredAttestation(proofs, "inspection-restriction-release")
      );
    await this.assetOperations.releasePreparedRestrictionInTransaction(tx, preparedRelease);
    await this.assetOperations.assertVehicleAvailable(
      tx,
      vehicle.id,
      VehicleAvailabilityPurpose.MARK_AVAILABLE,
      command.occurredAt
    );
    const available = await tx.vehicle.update({
      data: { status: VehicleStatus.AVAILABLE, updatedBy: command.actorId },
      where: { id: vehicle.id }
    });
    await this.auditService.write(
      {
        action: AuditAction.UPDATE,
        after: physicalAuditSnapshot(available),
        before: physicalAuditSnapshot(vehicle),
        entityId: vehicle.id,
        entityType: "vehicle",
        ipAddress: context.ipAddress,
        module: "subscription_closure",
        operatorId: command.actorId,
        userAgent: context.userAgent
      },
      tx
    );
    await this.repository.appendPreparedEventInTransaction(
      tx,
      session,
      eventCommand,
      inventoryCapability,
      requiredAttestation(proofs, "inventory-release"),
      this.closureAudit(command.actorId),
      "inventory-release"
    );
    return Object.freeze({ closureCaseId: closureCase.id, vehicleId: vehicle.id });
  }

  async initiateEarlyTermination(input: InitiateEarlyTerminationInput) {
    const command = normalizeEarlyTerminationInitiation(input);
    if (!this.prisma) throw serviceConflict("CAPABILITY_INVALID");
    return this.prisma.$transaction(
      async (tx) => {
        const initiationSource = earlyTerminationSource(
          command.orderId,
          `initiate:${command.idempotencyKey}`
        );
        const sourceCapability = await this.repository.prepareSourceInTransaction(
          tx,
          initiationSource
        );
        const sourceCase = await tx.subscriptionClosureCase.findUnique({
          where: {
            createSourceType_createSourceId_createSourceKey: {
              createSourceId: initiationSource.id,
              createSourceKey: initiationSource.key,
              createSourceType: initiationSource.type
            }
          }
        });
        if (sourceCase) {
          if (
            sourceCase.orderId !== command.orderId ||
            sourceCase.closureType !== "EARLY_TERMINATION" ||
            sourceCase.physicalControlMode !== "VOLUNTARY_RETURN" ||
            sourceCase.finalDisposition !== "TERMINATE" ||
            !sameCanonicalReceiptValue(
              jsonObject(sourceCase.authoritySnapshot).agreement,
              earlyTerminationAgreementIntent(command)
            )
          ) {
            throw closureSourceConflict();
          }
          const replay = await this.repository.createCase(
            tx,
            earlyTerminationReplayCaseCommand(sourceCase, initiationSource),
            this.closureAudit(sourceCase.createdBy)
          );
          return Object.freeze({
            authoritySnapshotHash: replay.outcome.authoritySnapshotHash,
            closureCaseId: replay.outcome.id,
            wrote: replay.wrote
          });
        }
        if (
          await tx.subscriptionClosureCase.findFirst({
            where: { orderId: command.orderId, retiredAt: null }
          })
        ) {
          throw closureSourceConflict();
        }

        const databaseClock = await readDatabaseClock(tx);
        const observed = await resolveEarlyTerminationInitiationAuthority(
          tx,
          command,
          databaseClock
        );
        const caseId = stableEarlyTerminationId(
          `${command.orderId}\u0000${command.idempotencyKey}\u0000case`
        );
        const caseCommand = earlyTerminationCaseCommand(command, observed, initiationSource);
        const session = this.repository.createAuthoritySessionInTransaction(tx);
        const caseRequirement = this.repository.bindAuthorityRequirement(
          session,
          subscriptionClosureCaseAuthorityRequirement(caseCommand, caseId)
        );
        const attestations = await this.repository.prepareAuthorityInTransaction(
          tx,
          session,
          [
            ...caseRequirement.locks,
            { id: observed.lease.id, mode: "UPDATE", table: "lease" },
            {
              id: observed.segment.id,
              mode: "UPDATE",
              table: "subscription_contract_segment"
            }
          ],
          [caseRequirement]
        );
        const locked = await resolveEarlyTerminationInitiationAuthority(tx, command, databaseClock);
        if (
          earlyTerminationAuthorityIdentity(locked) !== earlyTerminationAuthorityIdentity(observed)
        ) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        const created = await this.repository.createPreparedCaseInTransaction(
          tx,
          session,
          caseCommand,
          sourceCapability,
          requiredAttestation(attestations, "case-create"),
          caseId,
          this.closureAudit(command.actorId)
        );
        return Object.freeze({
          authoritySnapshotHash: created.outcome.authoritySnapshotHash,
          closureCaseId: created.outcome.id,
          wrote: created.wrote
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  async archiveEarlyTerminationAgreement(
    input: ArchiveEarlyTerminationAgreementInput
  ): Promise<ArchivedEarlyTerminationAgreement> {
    if (!this.prisma) throw serviceConflict("CAPABILITY_INVALID");
    const command = normalizeArchiveEarlyTerminationAgreement(input);
    return this.prisma.$transaction(
      async (tx) => {
        const ids = earlyTerminationAgreementIds(command.closureCaseId, command.idempotencyKey);
        const sources = earlyTerminationAgreementSources(
          command.closureCaseId,
          command.idempotencyKey
        );
        const sourceCapabilities = new Map<string, PreparedClosureSourceCapability>();
        for (const lifecycleSource of [...sources].sort((left, right) =>
          bytewiseCompare(sourceSortKey(left), sourceSortKey(right))
        )) {
          sourceCapabilities.set(
            lifecycleSource.key,
            await this.repository.prepareSourceInTransaction(tx, lifecycleSource)
          );
        }
        const replayCandidateCount = await tx.subscriptionClosureDocumentRevision.count({
          where: {
            id: { in: [ids.generatedRevisionId, ids.signedRevisionId, ids.archivedRevisionId] }
          }
        });
        if (replayCandidateCount > 0) {
          await this.repository.lockAuthorityRows(
            tx,
            earlyTerminationAgreementReplayLocks(command, ids)
          );
          const replay = await validateEarlyTerminationAgreementChainInTransaction(
            tx,
            command,
            ids,
            sources
          );
          if (!replay) throw serviceConflict("AUTHORITY_MISMATCH");
          return Object.freeze({ ...replay, wrote: false });
        }

        const databaseClock = await readDatabaseClock(tx);
        const observed = await resolveEarlyTerminationAgreementDraft(tx, command.closureCaseId);
        assertEarlyTerminationAgreementDraftActionable(observed);
        const documentSnapshot = earlyTerminationAgreementDocumentSnapshot(observed);
        const canonicalDocument = canonicalSubscriptionClosureJson(documentSnapshot);
        const sourceFileHash = createHash("sha256").update(canonicalDocument).digest("hex");
        const signedEnvelope = earlyTerminationAgreementSignedEnvelope({
          actorId: command.actorId,
          completedAt: databaseClock,
          documentSnapshotHash: sourceFileHash,
          signedFileId: ids.signedFileId,
          sourceFileHash,
          sourceFileId: ids.sourceFileId,
          sources
        });
        const canonicalSignedEnvelope = canonicalSubscriptionClosureJson(signedEnvelope);
        const signedFileHash = createHash("sha256").update(canonicalSignedEnvelope).digest("hex");
        const commands = earlyTerminationAgreementDocumentCommands({
          actorId: command.actorId,
          closureCaseId: command.closureCaseId,
          databaseClock,
          documentSnapshot,
          expectedVersion: observed.closureCase.version,
          ids,
          signedFileHash,
          sourceFileHash,
          sources
        });
        const commonLocks: readonly SubscriptionClosureAuthorityLock[] = [
          { id: observed.closureCase.id, mode: "UPDATE", table: "subscription_closure_case" },
          { id: observed.order.id, mode: "UPDATE", table: "subscription_order" },
          { id: observed.vehicle.id, mode: "SHARE", table: "vehicle" },
          { id: observed.lease.id, mode: "UPDATE", table: "lease" },
          {
            id: observed.segment.id,
            mode: "UPDATE",
            table: "subscription_contract_segment"
          },
          { id: observed.contract.id, mode: "SHARE", table: "contract" },
          { id: observed.closureCase.customerId, mode: "SHARE", table: "customer" },
          { id: command.actorId, mode: "SHARE", table: "user" }
        ];
        const requirementPlans = [
          {
            command: commands.generated,
            extraLocks: commonLocks,
            key: "early-termination-agreement-generated"
          },
          {
            command: commands.signed,
            extraLocks: [
              ...commonLocks,
              {
                id: ids.generatedRevisionId,
                mode: "SHARE" as const,
                table: "subscription_closure_document_revision" as const
              }
            ],
            key: "early-termination-agreement-signed"
          },
          {
            command: commands.archived,
            extraLocks: [
              ...commonLocks,
              {
                id: ids.signedRevisionId,
                mode: "SHARE" as const,
                table: "subscription_closure_document_revision" as const
              }
            ],
            key: "early-termination-agreement-archived"
          }
        ] as const;
        const session = this.repository.createAuthoritySessionInTransaction(tx);
        const requirements = requirementPlans.map(({ command: documentCommand, extraLocks, key }) =>
          this.repository.bindAuthorityRequirement(
            session,
            subscriptionClosureDocumentAuthorityRequirement(documentCommand, key, extraLocks)
          )
        );
        const attestations = await this.repository.prepareAuthorityInTransaction(
          tx,
          session,
          requirements.flatMap(({ locks }) => locks),
          requirements
        );
        const locked = await resolveEarlyTerminationAgreementDraft(tx, command.closureCaseId);
        assertEarlyTerminationAgreementDraftActionable(locked);
        if (
          earlyTerminationAgreementDraftIdentity(locked) !==
          earlyTerminationAgreementDraftIdentity(observed)
        ) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        const collisions = await Promise.all([
          tx.fileObject.count({ where: { id: { in: [ids.sourceFileId, ids.signedFileId] } } }),
          tx.contractESignTask.count({ where: { id: ids.esignTaskId } }),
          tx.subscriptionClosureDocumentRevision.count({
            where: {
              id: {
                in: [ids.generatedRevisionId, ids.signedRevisionId, ids.archivedRevisionId]
              }
            }
          }),
          tx.subscriptionClosureCurrentDocument.count({
            where: {
              closureCaseId: command.closureCaseId,
              documentType: "EARLY_TERMINATION_AGREEMENT"
            }
          })
        ]);
        if (collisions.some((count) => count !== 0)) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        const sourceObjectKey = earlyTerminationAgreementSourceObjectKey(
          command.closureCaseId,
          ids.generatedRevisionId
        );
        const signedObjectKey = earlyTerminationAgreementSignedObjectKey(
          command.closureCaseId,
          ids.signedRevisionId
        );
        const sourceDocumentName = `${observed.closureCase.caseNo}-${ids.generatedRevisionId}-early-termination-agreement.json`;
        const signedDocumentName = `${observed.closureCase.caseNo}-${ids.signedRevisionId}-early-termination-agreement.signed.json`;
        await tx.fileObject.createMany({
          data: [
            {
              bucket: "subscription-closure",
              id: ids.sourceFileId,
              mimeType: "application/json",
              objectKey: sourceObjectKey,
              originalName: sourceDocumentName,
              sizeBytes: BigInt(Buffer.byteLength(canonicalDocument)),
              uploadedBy: command.actorId
            },
            {
              bucket: "subscription-closure",
              id: ids.signedFileId,
              mimeType: "application/json",
              objectKey: signedObjectKey,
              originalName: signedDocumentName,
              sizeBytes: BigInt(Buffer.byteLength(canonicalSignedEnvelope)),
              uploadedBy: command.actorId
            }
          ]
        });
        await tx.contractESignTask.create({
          data: {
            completedAt: databaseClock,
            contractId: locked.closureCase.contractId,
            createdBy: command.actorId,
            customerId: locked.closureCase.customerId,
            documentName: sourceDocumentName,
            documentObjectKey: sourceObjectKey,
            documentType: ESignDocumentType.EARLY_TERMINATION_AGREEMENT,
            id: ids.esignTaskId,
            orderId: locked.closureCase.orderId,
            provider: ESignProviderType.OTHER,
            providerEnvelopeId: ids.esignEnvelopeId,
            providerTaskId: ids.esignProviderTaskId,
            requestSnapshot: earlyTerminationAgreementEsignRequest({
              documentSnapshotHash: sourceFileHash,
              ids,
              sourceFileHash,
              sources
            }),
            responseSnapshot: earlyTerminationAgreementEsignResponse({
              actorId: command.actorId,
              completedAt: databaseClock,
              ids,
              signedFileHash
            }),
            signedDocumentObjectKey: signedObjectKey,
            signingStage: ESignSigningStage.STAGE4_EARLY_TERMINATION,
            sourceId: sources[2].id,
            sourceKey: sources[2].key,
            sourceType: sources[2].type,
            taskNo: `ESG-ET-${ids.esignTaskId}`,
            taskStatus: ESignTaskStatus.COMPLETED,
            updatedBy: command.actorId
          }
        });
        for (const plan of requirementPlans) {
          await this.repository.appendPreparedDocumentRevisionInTransaction(
            tx,
            session,
            plan.command,
            requiredPreparedSource(sourceCapabilities, plan.command.source.key),
            requiredAttestation(attestations, plan.key),
            this.closureAudit(command.actorId),
            plan.key,
            plan.extraLocks
          );
        }
        const created = await validateEarlyTerminationAgreementChainInTransaction(
          tx,
          command,
          ids,
          sources
        );
        if (!created) throw serviceConflict("AUTHORITY_MISMATCH");
        return Object.freeze({ ...created, wrote: true });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  async cancelEarlyTermination(input: CancelEarlyTerminationInput) {
    if (!this.prisma) throw serviceConflict("CAPABILITY_INVALID");
    const command = normalizeCancelEarlyTermination(input);
    return this.prisma.$transaction(
      async (tx) => {
        const cancellationSource = earlyTerminationSource(
          command.closureCaseId,
          `cancel:${command.idempotencyKey}`
        );
        const sourceCapability = await this.repository.prepareSourceInTransaction(
          tx,
          cancellationSource
        );
        const observedCase = await tx.subscriptionClosureCase.findUnique({
          where: { id: command.closureCaseId }
        });
        if (!observedCase) throw serviceConflict("AUTHORITY_NOT_FOUND");
        const priorReceipt = await tx.subscriptionClosureCommandReceipt.findUnique({
          where: {
            sourceType_sourceId_sourceKey: {
              sourceId: cancellationSource.id,
              sourceKey: cancellationSource.key,
              sourceType: cancellationSource.type
            }
          }
        });
        const commandFingerprint = hashSubscriptionClosureSnapshot(command);
        if (priorReceipt) {
          await this.repository.lockAuthorityRows(
            tx,
            await earlyTerminationCancellationReplayLocks(tx, command, observedCase)
          );
          await assertExactEarlyTerminationCancellationReplay(
            tx,
            command,
            cancellationSource,
            priorReceipt
          );
          return Object.freeze({ closureCaseId: observedCase.id, wrote: false });
        }
        assertEarlyTerminationCancellationCase(observedCase);
        const observedAgreement = await resolveEarlyTerminationCancellationAgreement(
          tx,
          observedCase
        );
        const baseLocks: SubscriptionClosureAuthorityLock[] = [
          { id: observedCase.id, mode: "UPDATE", table: "subscription_closure_case" },
          { id: observedCase.orderId, mode: "UPDATE", table: "subscription_order" },
          { id: command.actorId, mode: "SHARE", table: "user" },
          ...(observedAgreement?.locks ?? [])
        ];
        await this.repository.lockAuthorityRows(tx, baseLocks);
        const lockedCase = await tx.subscriptionClosureCase.findUnique({
          where: { id: observedCase.id }
        });
        if (
          !lockedCase ||
          canonicalSubscriptionClosureJson(lockedCase) !==
            canonicalSubscriptionClosureJson(observedCase)
        ) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        assertEarlyTerminationCancellationCase(lockedCase);
        const lockedAgreement = await resolveEarlyTerminationCancellationAgreement(tx, lockedCase);
        if (lockedAgreement?.identity !== observedAgreement?.identity) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        const occurredAt = await readDatabaseClock(tx);
        const eventCommand = {
          actorId: command.actorId,
          afterStatus: "CANCELLED" as const,
          closureCaseId: observedCase.id,
          detailSnapshot: {
            commandFingerprint,
            reason: command.reason,
            terminationAction: "CANCEL"
          },
          eventType: "STATUS_TRANSITIONED" as const,
          expectedStatus: lockedCase.status,
          expectedVersion: lockedCase.version,
          occurredAt,
          retireCase: true,
          source: cancellationSource
        };
        const session = this.repository.createAuthoritySessionInTransaction(tx);
        const requirement = this.repository.bindAuthorityRequirement(
          session,
          subscriptionClosureEventAuthorityRequirement(eventCommand, "early-cancel")
        );
        const attestations = await this.repository.prepareAuthorityInTransaction(
          tx,
          session,
          [
            ...requirement.locks,
            { id: lockedCase.orderId, mode: "UPDATE", table: "subscription_order" },
            ...(lockedAgreement?.locks ?? [])
          ],
          [requirement]
        );
        if (lockedAgreement?.task.taskStatus === ESignTaskStatus.COMPLETED) {
          const cancelled = await tx.contractESignTask.updateMany({
            data: {
              cancelledAt: occurredAt,
              taskStatus: ESignTaskStatus.CANCELLED,
              updatedBy: command.actorId
            },
            where: {
              cancelledAt: null,
              id: lockedAgreement.task.id,
              taskStatus: ESignTaskStatus.COMPLETED
            }
          });
          if (cancelled.count !== 1) throw serviceConflict("AUTHORITY_MISMATCH");
          await this.auditService.write(
            {
              action: AuditAction.UPDATE,
              after: {
                cancelledAt: occurredAt,
                taskStatus: ESignTaskStatus.CANCELLED
              },
              before: {
                cancelledAt: lockedAgreement.task.cancelledAt,
                taskStatus: lockedAgreement.task.taskStatus
              },
              entityId: lockedAgreement.task.id,
              entityType: "contract_esign_task",
              module: "subscription_closure",
              operatorId: command.actorId
            },
            tx
          );
        }
        const result = await this.repository.appendPreparedEventInTransaction(
          tx,
          session,
          eventCommand,
          sourceCapability,
          requiredAttestation(attestations, "early-cancel"),
          this.closureAudit(command.actorId),
          "early-cancel"
        );
        return Object.freeze({ closureCaseId: observedCase.id, wrote: result.wrote });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  async executeEarlyTermination(input: ExecuteEarlyTerminationInput) {
    if (!this.prisma) throw serviceConflict("CAPABILITY_INVALID");
    const command = normalizeExecuteEarlyTermination(input);
    return this.prisma.$transaction(
      async (tx) => {
        const executionSource = earlyTerminationSource(
          command.closureCaseId,
          `execute:${command.idempotencyKey}`
        );
        const handoverSource = earlyTerminationSource(
          command.closureCaseId,
          `execute:${command.idempotencyKey}:return-inbound-handover`
        );
        const assetSource = earlyTerminationSource(
          command.closureCaseId,
          `execute:${command.idempotencyKey}:return-inbound-asset-work-order`
        );
        const manifestSource = earlyTerminationSource(
          command.closureCaseId,
          `execute:${command.idempotencyKey}:return-manifest`
        );
        let executionSourceCapability: PreparedClosureSourceCapability | undefined;
        let manifestSourceCapability: PreparedClosureSourceCapability | undefined;
        let assetSourceCapability: AssetOperationsTransactionCapability | undefined;
        let handoverSourceCapability: unknown;
        const initialCase = await tx.subscriptionClosureCase.findUnique({
          where: { id: command.closureCaseId }
        });
        if (!initialCase) throw serviceConflict("AUTHORITY_NOT_FOUND");
        const sourcePreparations = [
          {
            prepare: async () => {
              executionSourceCapability = await this.repository.prepareSourceInTransaction(
                tx,
                executionSource
              );
            },
            source: executionSource
          },
          {
            prepare: async () => {
              manifestSourceCapability = await this.repository.prepareSourceInTransaction(
                tx,
                manifestSource
              );
            },
            source: manifestSource
          },
          {
            prepare: async () => {
              assetSourceCapability = await this.assetOperations.prepareCallerOwnedTransaction(
                tx,
                assetSource
              );
            },
            source: assetSource
          },
          {
            prepare: async () => {
              handoverSourceCapability =
                await this.handoverWorkOrders.prepareReturnInboundInTransaction(tx, {
                  actorId: command.actorId,
                  orderId: initialCase.orderId,
                  source: handoverSource
                });
            },
            source: handoverSource
          }
        ].sort((left, right) =>
          bytewiseCompare(sourceSortKey(left.source), sourceSortKey(right.source))
        );
        for (const preparation of sourcePreparations) await preparation.prepare();
        if (
          !executionSourceCapability ||
          !manifestSourceCapability ||
          !assetSourceCapability ||
          !handoverSourceCapability
        ) {
          throw serviceConflict("CAPABILITY_INVALID");
        }

        const priorReceipt = await tx.subscriptionClosureCommandReceipt.findUnique({
          where: {
            sourceType_sourceId_sourceKey: {
              sourceId: executionSource.id,
              sourceKey: executionSource.key,
              sourceType: executionSource.type
            }
          }
        });
        if (priorReceipt) {
          const priorEvent = await tx.subscriptionClosureEvent.findUnique({
            where: { id: priorReceipt.eventId }
          });
          const priorDetail = jsonObject(priorEvent?.detailSnapshot);
          if (priorDetail.terminationAction === "AGREEMENT_STALE") {
            const staleAuthority = await resolveStaleEarlyTerminationAgreementAuthority(
              tx,
              initialCase
            );
            await this.repository.lockAuthorityRows(tx, [
              { id: initialCase.id, mode: "UPDATE", table: "subscription_closure_case" },
              { id: initialCase.orderId, mode: "UPDATE", table: "subscription_order" },
              ...staleAuthority.locks,
              { id: command.actorId, mode: "SHARE", table: "user" }
            ]);
            const lockedCase = await tx.subscriptionClosureCase.findUnique({
              where: { id: initialCase.id }
            });
            if (!lockedCase) throw closureSourceConflict();
            await assertExactEarlyTerminationStaleReplay(
              tx,
              command,
              executionSource,
              priorReceipt,
              lockedCase
            );
            return Object.freeze({
              closureCaseId: initialCase.id,
              outcome: "AGREEMENT_STALE" as const,
              wrote: false
            });
          }
          await this.repository.lockAuthorityRows(
            tx,
            await earlyTerminationExecutionReplayLocks(tx, command, initialCase)
          );
          const replay = await assertExactEarlyTerminationExecutionReplay(
            tx,
            command,
            executionSource,
            priorReceipt
          );
          return Object.freeze({ ...replay, wrote: false });
        }

        const databaseClock = await readDatabaseClock(tx);
        if (databaseClock.getTime() < initialCase.effectiveAt.getTime()) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        if (await earlyTerminationAgreementHasCurrentFactDrift(tx, initialCase)) {
          const stale = await resolveStaleEarlyTerminationAgreementAuthority(tx, initialCase);
          const eventCommand = {
            actorId: command.actorId,
            afterStatus: "MANUAL_TAKEOVER" as const,
            closureCaseId: initialCase.id,
            detailSnapshot: {
              agreementRevisionId: stale.archived.id,
              commandFingerprint: hashSubscriptionClosureSnapshot(command),
              terminationAction: "AGREEMENT_STALE"
            },
            eventType: "STATUS_TRANSITIONED" as const,
            expectedStatus: "PREPARING_RETURN" as const,
            expectedVersion: initialCase.version,
            occurredAt: databaseClock,
            source: executionSource
          };
          const session = this.repository.createAuthoritySessionInTransaction(tx);
          const requirement = this.repository.bindAuthorityRequirement(
            session,
            subscriptionClosureEventAuthorityRequirement(eventCommand, "early-stale")
          );
          const attestations = await this.repository.prepareAuthorityInTransaction(
            tx,
            session,
            [
              ...requirement.locks,
              { id: initialCase.orderId, mode: "UPDATE", table: "subscription_order" },
              { id: initialCase.vehicleId, mode: "SHARE", table: "vehicle" },
              { id: stale.leaseId, mode: "UPDATE", table: "lease" },
              { id: initialCase.contractId, mode: "SHARE", table: "contract" },
              {
                id: stale.segmentId,
                mode: "UPDATE",
                table: "subscription_contract_segment"
              },
              ...stale.locks,
              { id: initialCase.customerId, mode: "SHARE", table: "customer" },
              { id: command.actorId, mode: "SHARE", table: "user" }
            ],
            [requirement]
          );
          const lockedCase = await tx.subscriptionClosureCase.findUnique({
            where: { id: initialCase.id }
          });
          if (
            !lockedCase ||
            lockedCase.version !== initialCase.version ||
            lockedCase.status !== "PREPARING_RETURN" ||
            !(await earlyTerminationAgreementHasCurrentFactDrift(tx, lockedCase))
          ) {
            throw serviceConflict("AUTHORITY_MISMATCH");
          }
          const lockedStale = await resolveStaleEarlyTerminationAgreementAuthority(tx, lockedCase);
          if (lockedStale.identity !== stale.identity) {
            throw serviceConflict("AUTHORITY_MISMATCH");
          }
          const cancelled = await tx.contractESignTask.updateMany({
            data: {
              cancelledAt: databaseClock,
              taskStatus: ESignTaskStatus.CANCELLED,
              updatedBy: command.actorId
            },
            where: { id: stale.esignTask.id, taskStatus: ESignTaskStatus.COMPLETED }
          });
          if (cancelled.count !== 1) throw serviceConflict("AUTHORITY_MISMATCH");
          await this.auditService.write(
            {
              action: AuditAction.UPDATE,
              after: {
                cancelledAt: databaseClock,
                reason: "EARLY_TERMINATION_CURRENT_FACT_DRIFT",
                taskStatus: ESignTaskStatus.CANCELLED
              },
              before: { taskStatus: stale.esignTask.taskStatus },
              entityId: stale.esignTask.id,
              entityType: "contract_esign_task",
              module: "subscription_closure",
              operatorId: command.actorId
            },
            tx
          );
          const result = await this.repository.appendPreparedEventInTransaction(
            tx,
            session,
            eventCommand,
            executionSourceCapability,
            requiredAttestation(attestations, "early-stale"),
            this.closureAudit(command.actorId),
            "early-stale"
          );
          return Object.freeze({
            closureCaseId: initialCase.id,
            outcome: "AGREEMENT_STALE" as const,
            wrote: result.wrote
          });
        }
        const observed = await resolveEarlyTerminationAgreementDraft(tx, command.closureCaseId);
        assertEarlyTerminationExecutionCase(observed.closureCase);
        const agreementCommand = await currentEarlyTerminationAgreementCommand(tx, observed);
        const agreementIds = earlyTerminationAgreementIds(
          command.closureCaseId,
          agreementCommand.idempotencyKey
        );
        const agreementSources = earlyTerminationAgreementSources(
          command.closureCaseId,
          agreementCommand.idempotencyKey
        );
        const agreement = await validateEarlyTerminationAgreementChainInTransaction(
          tx,
          agreementCommand,
          agreementIds,
          agreementSources
        );
        if (!agreement) throw serviceConflict("AUTHORITY_MISMATCH");
        const vehicleReturnId = stableEarlyTerminationId(
          `${command.closureCaseId}\u0000${command.idempotencyKey}\u0000vehicle-return`
        );
        const handoverWorkOrderId = stableEarlyTerminationId(
          `${command.closureCaseId}\u0000${command.idempotencyKey}\u0000handover`
        );
        const assetWorkOrderId = stableEarlyTerminationId(
          `${command.closureCaseId}\u0000${command.idempotencyKey}\u0000asset`
        );
        const authority = earlyTerminationReturnAuthority(observed, command.actorId);
        const handoverCommand = {
          actorId: command.actorId,
          orderId: observed.order.id,
          source: handoverSource
        };
        const assetCommand = earlyTerminationAssetCommand(
          authority,
          assetSource,
          observed.closureCase.effectiveAt,
          vehicleReturnId
        );
        const assetContext = {
          actorId: command.actorId,
          permissions: [],
          userAgent: "subscription-early-termination"
        } as const;
        const manifestSnapshot = returnManifestDocumentSnapshot({
          assetWorkOrderId,
          authority,
          caseNo: observed.closureCase.caseNo,
          closureCaseId: observed.closureCase.id,
          handoverWorkOrderId,
          vehicleReturnId
        });
        const manifestRevisionId = stableEarlyTerminationId(
          `${command.closureCaseId}\u0000${command.idempotencyKey}\u0000return-manifest`
        );
        const manifestPlan = await planManifestAuthoritiesInTransaction(tx, {
          assetWorkOrderId,
          authority,
          caseNo: observed.closureCase.caseNo,
          closureCaseId: observed.closureCase.id,
          documentSnapshot: manifestSnapshot,
          documentSource: manifestSource,
          documentRevisionId: manifestRevisionId,
          expectedVersion: observed.closureCase.version + 2,
          handoverWorkOrderId,
          vehicleReturnId
        });
        const executionFingerprint = hashSubscriptionClosureSnapshot(command);
        const eventCommand = {
          actorId: command.actorId,
          afterStatus: "PREPARING_RETURN" as const,
          closureCaseId: observed.closureCase.id,
          detailSnapshot: {
            agreementArchivedRevisionId: agreement.archivedRevisionId,
            assetWorkOrderId,
            effectiveAt: observed.closureCase.effectiveAt,
            executionFingerprint,
            handoverWorkOrderId,
            returnManifestRevisionId: manifestRevisionId,
            vehicleReturnId
          },
          eventType: "NOTE_ADDED" as const,
          expectedStatus: "PREPARING_RETURN" as const,
          expectedVersion: observed.closureCase.version + 1,
          occurredAt: databaseClock,
          source: executionSource
        };
        const changes = await tx.subscriptionChangeOrder.findMany({
          select: { id: true },
          where: { orderId: observed.order.id }
        });
        const considerations = await tx.renewalConsideration.findMany({
          select: { id: true },
          where: { orderId: observed.order.id }
        });
        const agreementLocks = await earlyTerminationAgreementAuthorityLocks(
          tx,
          observed.closureCase.id,
          agreementIds
        );
        const session = this.repository.createAuthoritySessionInTransaction(tx);
        const effectiveBoundary = await subscriptionEffectiveBoundaryOwner.prepareInTransaction(
          tx,
          session,
          {
            boundaryAt: observed.closureCase.effectiveAt,
            occurredAt: databaseClock,
            orderId: observed.order.id
          }
        );
        const requirements = [
          this.assetOperations.createAuthorityRequirement(
            session,
            assetCommand,
            command.actorId,
            assetWorkOrderId
          ),
          this.handoverWorkOrders.createReturnInboundAuthorityRequirement(
            session,
            handoverCommand,
            handoverWorkOrderId
          ),
          this.repository.bindAuthorityRequirement(
            session,
            subscriptionClosureDocumentAuthorityRequirement(manifestPlan.command)
          ),
          this.repository.bindAuthorityRequirement(
            session,
            subscriptionClosureEventAuthorityRequirement(eventCommand, "early-execution")
          ),
          effectiveBoundary.requirement
        ];
        const attestations = await this.repository.prepareAuthorityInTransaction(
          tx,
          session,
          [
            ...requirements.flatMap(({ locks }) => locks),
            ...changes.map(({ id }) => ({
              id,
              mode: "UPDATE" as const,
              table: "subscription_change_order" as const
            })),
            ...considerations.map(({ id }) => ({
              id,
              mode: "UPDATE" as const,
              table: "renewal_consideration" as const
            })),
            { id: observed.order.id, mode: "UPDATE", table: "subscription_order" },
            { id: observed.vehicle.id, mode: "SHARE", table: "vehicle" },
            { id: observed.lease.id, mode: "UPDATE", table: "lease" },
            { id: observed.contract.id, mode: "UPDATE", table: "contract" },
            {
              id: observed.segment.id,
              mode: "UPDATE",
              table: "subscription_contract_segment"
            },
            ...agreementLocks,
            { id: observed.closureCase.customerId, mode: "SHARE", table: "customer" },
            { id: command.actorId, mode: "SHARE", table: "user" }
          ],
          requirements
        );
        const locked = await resolveEarlyTerminationAgreementDraft(tx, command.closureCaseId);
        assertEarlyTerminationExecutionCase(locked.closureCase);
        if (
          earlyTerminationAgreementDraftIdentity(locked) !==
          earlyTerminationAgreementDraftIdentity(observed)
        ) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        if (
          !(await validateEarlyTerminationAgreementChainInTransaction(
            tx,
            agreementCommand,
            agreementIds,
            agreementSources
          ))
        ) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        const manifestAuthorities = manifestPlan.creation
          ? await createManifestAuthoritiesInTransaction(
              tx,
              manifestPlan.command,
              manifestPlan.creation,
              authority
            )
          : null;
        await assertReturnManifestEsignAuthority(
          tx,
          manifestPlan.command,
          authority,
          manifestSource,
          manifestSnapshot,
          manifestAuthorities
        );
        const handoverCapability =
          await this.handoverWorkOrders.attestReturnInboundAuthorityInTransaction(
            tx,
            session,
            handoverCommand,
            handoverSourceCapability as never,
            requiredAttestation(attestations, "handover-create"),
            handoverWorkOrderId
          );
        const preparedAsset =
          await this.assetOperations.attestCallerOwnedCreateAuthorityInTransaction(
            tx,
            session,
            assetCommand,
            assetContext,
            assetSourceCapability,
            requiredAttestation(attestations, "asset-create"),
            assetWorkOrderId
          );
        await tx.vehicleReturn.create({
          data: {
            customerId: locked.closureCase.customerId,
            id: vehicleReturnId,
            orderId: locked.closureCase.orderId,
            returnNo: createBusinessNo("RET"),
            returnStatus: VehicleReturnStatus.PENDING,
            returnType: "EARLY_TERMINATION",
            scheduledAt: locked.closureCase.effectiveAt,
            vehicleId: locked.closureCase.vehicleId
          }
        });
        const specialist = await this.handoverWorkOrders.createPreparedReturnInboundInTransaction(
          tx,
          handoverCapability
        );
        const common = await this.assetOperations.createPreparedWorkOrderInTransaction(
          tx,
          preparedAsset
        );
        if (specialist.id !== handoverWorkOrderId || common.workOrder.id !== assetWorkOrderId) {
          throw serviceConflict("AUTHORITY_MISMATCH");
        }
        const beforeContract = await tx.contract.findUniqueOrThrow({
          where: { id: locked.contract.id }
        });
        await applyEarlyTerminationCoreBoundary(tx, locked, command.actorId);
        const archivedContract = await tx.contract.findUniqueOrThrow({
          where: { id: locked.contract.id }
        });
        await this.auditService.write(
          {
            action: AuditAction.UPDATE,
            after: physicalAuditSnapshot(archivedContract),
            before: physicalAuditSnapshot(beforeContract),
            entityId: archivedContract.id,
            entityType: "contract",
            module: "subscription_closure",
            operatorId: command.actorId
          },
          tx
        );
        await subscriptionEffectiveBoundaryOwner.applyPreparedInTransaction(
          tx,
          session,
          effectiveBoundary.capability,
          requiredAttestation(attestations, "effective-boundary-stop")
        );
        await this.auditService.write(
          {
            action: AuditAction.UPDATE,
            after: {
              effectiveAt: locked.closureCase.effectiveAt,
              contractStatus: ContractStatus.ARCHIVED,
              leaseStatus: LeaseStatus.RETURN_DUE,
              orderStatus: OrderStatus.PENDING_RETURN,
              segmentStatus: ContractSegmentStatus.COMPLETED,
              vehicleReturnId
            },
            entityId: locked.closureCase.id,
            entityType: "subscription_closure_case",
            module: "subscription_closure",
            operatorId: command.actorId
          },
          tx
        );
        const linked = await tx.subscriptionClosureCase.updateMany({
          data: {
            returnAssetWorkOrderId: assetWorkOrderId,
            returnHandoverWorkOrderId: handoverWorkOrderId,
            updatedBy: command.actorId,
            vehicleReturnId,
            version: { increment: 1 }
          },
          where: {
            id: locked.closureCase.id,
            returnAssetWorkOrderId: null,
            returnHandoverWorkOrderId: null,
            vehicleReturnId: null,
            version: locked.closureCase.version
          }
        });
        if (linked.count !== 1) throw serviceConflict("AUTHORITY_MISMATCH");
        await this.repository.appendPreparedEventInTransaction(
          tx,
          session,
          eventCommand,
          executionSourceCapability,
          requiredAttestation(attestations, "early-execution"),
          this.closureAudit(command.actorId),
          "early-execution"
        );
        const manifest = (
          await this.repository.appendPreparedDocumentRevisionInTransaction(
            tx,
            session,
            manifestPlan.command,
            manifestSourceCapability,
            requiredAttestation(attestations, "manifest-create"),
            this.closureAudit(command.actorId)
          )
        ).outcome;
        return Object.freeze({
          closureCaseId: locked.closureCase.id,
          returnAssetWorkOrderId: common.workOrder.id,
          returnHandoverWorkOrderId: specialist.id,
          returnManifestRevisionId: manifest.id,
          vehicleReturnId,
          wrote: true
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  private closureAudit(actorId: string): SubscriptionClosureMutationAuditHook {
    return async (tx, mutation) => {
      await this.auditService.write(
        {
          action: AuditAction.CREATE,
          after: mutation,
          ...(mutation.persistenceAt ? { createdAt: mutation.persistenceAt } : {}),
          entityId: mutation.eventId,
          entityType: "subscription_closure_event",
          module: "subscription_closure",
          operatorId: actorId
        },
        tx
      );
    };
  }

  private async loadNormalExpiryAuthority(
    tx: Prisma.TransactionClient,
    input: PrepareNormalExpiryInput,
    persistedActorId?: string
  ): Promise<NormalExpiryAuthority> {
    const segment = await tx.subscriptionContractSegment.findUnique({
      select: { createdBy: true, endDate: true, id: true, orderId: true },
      where: { id: input.segmentId }
    });
    const order = await tx.subscriptionOrder.findUnique({
      select: {
        contractId: true,
        createdBy: true,
        customerId: true,
        id: true,
        orderNo: true,
        updatedBy: true,
        vehicleId: true
      },
      where: { id: input.orderId }
    });
    const lease = await tx.lease.findUnique({
      select: { id: true },
      where: { orderId: input.orderId }
    });
    if (!segment || !order || !lease || !order.contractId || !order.vehicleId) {
      throw serviceConflict("AUTHORITY_NOT_FOUND");
    }
    if (segment.orderId !== order.id) throw serviceConflict("AUTHORITY_MISMATCH");
    let actorId = persistedActorId;
    if (!actorId) {
      const actorCandidates = [
        ...new Set(
          [segment.createdBy, order.updatedBy, order.createdBy].filter((value): value is string =>
            Boolean(value)
          )
        )
      ];
      for (const candidateId of actorCandidates) {
        const actor = await tx.user.findFirst({
          select: { id: true },
          where: { deletedAt: null, id: candidateId, status: UserStatus.ACTIVE }
        });
        if (actor) {
          actorId = actor.id;
          break;
        }
      }
    }
    if (!actorId) throw serviceConflict("AUTHORITY_NOT_FOUND");
    return Object.freeze({
      actorId,
      contractId: order.contractId,
      customerId: order.customerId,
      leaseId: lease.id,
      orderId: order.id,
      orderNo: order.orderNo,
      segmentEndDate: new Date(segment.endDate),
      segmentId: segment.id,
      vehicleId: order.vehicleId
    });
  }

  private takeNormalExpiryCapability(capability: NormalExpiryTransactionCapability) {
    const state = this.normalExpiryCapabilities.get(capability);
    if (state) this.normalExpiryCapabilities.delete(capability);
    if (!state) throw serviceConflict("CAPABILITY_INVALID");
    return state;
  }
}

type RecoveryAuthorityIds = Readonly<{
  archivedRevisionId: string;
  esignEnvelopeId: string;
  esignProviderTaskId: string;
  esignTaskId: string;
  generatedRevisionId: string;
  signedFileId: string;
  signedRevisionId: string;
  sourceFileId: string;
}>;

type RecoveryAuthoritySources = readonly [
  SubscriptionClosureSource,
  SubscriptionClosureSource,
  SubscriptionClosureSource
];

async function resolveRecoveryAuthorityDraft(
  tx: Prisma.TransactionClient,
  closureCaseId: string,
  clockBoundary: Date
) {
  const [closureCase, assessment, currentDocument] = await Promise.all([
    tx.subscriptionClosureCase.findUnique({ where: { id: closureCaseId } }),
    tx.subscriptionClosureEvent.findFirst({
      orderBy: [{ sequence: "desc" }, { id: "desc" }],
      where: { closureCaseId, eventType: "RECOVERY_ESCALATED" }
    }),
    tx.subscriptionClosureCurrentDocument.findUnique({
      where: {
        closureCaseId_documentType: {
          closureCaseId,
          documentType: "RECOVERY_AUTHORITY"
        }
      }
    })
  ]);
  const assessmentDetail = jsonObject(assessment?.detailSnapshot);
  const plannedWorkOrderId = assessmentDetail.plannedRecoveryAssetWorkOrderId;
  if (
    !closureCase ||
    !assessment ||
    typeof plannedWorkOrderId !== "string" ||
    canonicalUuid(plannedWorkOrderId) !== plannedWorkOrderId
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const context = await resolveRecoveryContextSnapshot(
    tx,
    closureCase,
    assessmentDetail,
    clockBoundary
  );
  return Object.freeze({
    assessmentDetail,
    assessmentId: assessment.id,
    closureCase,
    contextActionable: context.actionable,
    contextLocks: context.locks,
    contextSnapshotHash: context.snapshotHash,
    currentDocumentId: currentDocument?.documentRevisionId ?? null,
    plannedWorkOrderId
  });
}

function assertRecoveryAuthorityDraftActionable(
  draft: Awaited<ReturnType<typeof resolveRecoveryAuthorityDraft>>
) {
  if (
    draft.closureCase.physicalControlMode !== "RECOVERY" ||
    draft.closureCase.finalDisposition !== "TERMINATE" ||
    draft.closureCase.status !== "RECOVERY_ASSESSMENT_PENDING" ||
    draft.closureCase.recoveryAssetWorkOrderId !== null ||
    draft.currentDocumentId !== null ||
    !draft.contextActionable
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
}

function recoveryAuthorityDraftIdentity(
  draft: Awaited<ReturnType<typeof resolveRecoveryAuthorityDraft>>
) {
  return canonicalSubscriptionClosureJson({
    assessmentDetail: draft.assessmentDetail,
    assessmentId: draft.assessmentId,
    closureCase: draft.closureCase,
    contextActionable: draft.contextActionable,
    contextSnapshotHash: draft.contextSnapshotHash,
    currentDocumentId: draft.currentDocumentId,
    plannedWorkOrderId: draft.plannedWorkOrderId
  } as never);
}

function recoveryAuthorityDocumentSnapshot(
  draft: Awaited<ReturnType<typeof resolveRecoveryAuthorityDraft>>
) {
  return Object.freeze({
    caseNo: draft.closureCase.caseNo,
    closureCaseId: draft.closureCase.id,
    contractId: draft.closureCase.contractId,
    customerId: draft.closureCase.customerId,
    documentType: "RECOVERY_AUTHORITY",
    finalDisposition: "TERMINATE",
    orderId: draft.closureCase.orderId,
    physicalControlMode: "RECOVERY",
    recoveryAssetWorkOrderId: draft.plannedWorkOrderId,
    recoveryWorkOrderType: "RECOVERY",
    vehicleId: draft.closureCase.vehicleId,
    vehicleReturnId: draft.closureCase.vehicleReturnId
  } as const);
}

function recoveryAuthorityIds(closureCaseId: string, idempotencyKey: string): RecoveryAuthorityIds {
  const id = (label: string) =>
    stableRecoveryAuthorityId(`${closureCaseId}\u0000${idempotencyKey}\u0000${label}`);
  return Object.freeze({
    archivedRevisionId: id("revision-archived"),
    esignEnvelopeId: id("esign-envelope"),
    esignProviderTaskId: id("esign-provider-task"),
    esignTaskId: id("esign-task"),
    generatedRevisionId: id("revision-generated"),
    signedFileId: id("file-signed"),
    signedRevisionId: id("revision-signed"),
    sourceFileId: id("file-source")
  });
}

function recoveryAuthoritySources(
  closureCaseId: string,
  idempotencyKey: string
): RecoveryAuthoritySources {
  return Object.freeze([
    physicalSource(closureCaseId, `recovery-authority:${idempotencyKey}:generated`),
    physicalSource(closureCaseId, `recovery-authority:${idempotencyKey}:signed`),
    physicalSource(closureCaseId, `recovery-authority:${idempotencyKey}:archived`)
  ]) as RecoveryAuthoritySources;
}

function recoveryAuthorityReplayLocks(
  command: ArchiveRecoveryAuthorityInput,
  ids: RecoveryAuthorityIds
): readonly SubscriptionClosureAuthorityLock[] {
  return Object.freeze([
    {
      id: command.closureCaseId,
      mode: "UPDATE",
      table: "subscription_closure_case"
    },
    {
      id: command.closureCaseId,
      mode: "SHARE",
      table: "subscription_closure_current_document"
    },
    ...[ids.generatedRevisionId, ids.signedRevisionId, ids.archivedRevisionId].map((id) => ({
      id,
      mode: "SHARE" as const,
      table: "subscription_closure_document_revision" as const
    })),
    { id: ids.sourceFileId, mode: "SHARE", table: "file_object" },
    { id: ids.signedFileId, mode: "SHARE", table: "file_object" },
    { id: ids.esignTaskId, mode: "SHARE", table: "contract_esign_task" },
    { id: command.actorId, mode: "SHARE", table: "user" }
  ] satisfies SubscriptionClosureAuthorityLock[]);
}

function recoveryAuthorityDocumentCommands(
  input: Readonly<{
    actorId: string;
    closureCaseId: string;
    databaseClock: Date;
    documentSnapshot: ReturnType<typeof recoveryAuthorityDocumentSnapshot>;
    expectedVersion: number;
    ids: RecoveryAuthorityIds;
    signedFileHash: string;
    sourceFileHash: string;
    sources: RecoveryAuthoritySources;
  }>
) {
  const common = {
    actorId: input.actorId,
    closureCaseId: input.closureCaseId,
    contractESignTaskId: input.ids.esignTaskId,
    documentSnapshot: input.documentSnapshot,
    documentType: "RECOVERY_AUTHORITY" as const,
    generatedAt: input.databaseClock,
    handoverWorkOrderId: null,
    sourceFileHash: input.sourceFileHash,
    sourceFileId: input.ids.sourceFileId,
    vehicleReturnId: null
  };
  return Object.freeze({
    archived: Object.freeze({
      ...common,
      archivedAt: input.databaseClock,
      archivedBy: input.actorId,
      documentRevisionId: input.ids.archivedRevisionId,
      expectedCurrentRevisionId: input.ids.signedRevisionId,
      expectedVersion: input.expectedVersion + 2,
      signedAt: input.databaseClock,
      signedBy: input.actorId,
      signedFileHash: input.signedFileHash,
      signedFileId: input.ids.signedFileId,
      source: input.sources[2],
      stage: "ARCHIVED" as const
    }),
    generated: Object.freeze({
      ...common,
      archivedAt: null,
      archivedBy: null,
      documentRevisionId: input.ids.generatedRevisionId,
      expectedCurrentRevisionId: null,
      expectedVersion: input.expectedVersion,
      signedAt: null,
      signedBy: null,
      signedFileHash: null,
      signedFileId: null,
      source: input.sources[0],
      stage: "GENERATED" as const
    }),
    signed: Object.freeze({
      ...common,
      archivedAt: null,
      archivedBy: null,
      documentRevisionId: input.ids.signedRevisionId,
      expectedCurrentRevisionId: input.ids.generatedRevisionId,
      expectedVersion: input.expectedVersion + 1,
      signedAt: input.databaseClock,
      signedBy: input.actorId,
      signedFileHash: input.signedFileHash,
      signedFileId: input.ids.signedFileId,
      source: input.sources[1],
      stage: "SIGNED" as const
    })
  });
}

function recoveryAuthorityEsignRequest(
  input: Readonly<{
    documentSnapshotHash: string;
    ids: RecoveryAuthorityIds;
    sourceFileHash: string;
    sources: RecoveryAuthoritySources;
  }>
) {
  return Object.freeze({
    archivedRevisionId: input.ids.archivedRevisionId,
    documentSnapshotHash: input.documentSnapshotHash,
    documentType: "RECOVERY_AUTHORITY",
    generatedRevisionId: input.ids.generatedRevisionId,
    lifecycleSources: input.sources,
    signedRevisionId: input.ids.signedRevisionId,
    sourceFileHash: input.sourceFileHash,
    sourceFileId: input.ids.sourceFileId
  });
}

function recoveryAuthorityEsignResponse(
  input: Readonly<{
    actorId: string;
    completedAt: Date;
    ids: RecoveryAuthorityIds;
    signedFileHash: string;
  }>
) {
  return Object.freeze({
    completedAt: input.completedAt,
    completedBy: input.actorId,
    providerEnvelopeId: input.ids.esignEnvelopeId,
    providerTaskId: input.ids.esignProviderTaskId,
    signedFileHash: input.signedFileHash,
    signedFileId: input.ids.signedFileId
  });
}

function recoveryAuthoritySignedEnvelope(
  input: Readonly<{
    actorId: string;
    completedAt: Date;
    documentSnapshotHash: string;
    signedFileId: string;
    sourceFileHash: string;
    sourceFileId: string;
    sources: RecoveryAuthoritySources;
  }>
) {
  return Object.freeze({
    completedAt: input.completedAt,
    documentSnapshotHash: input.documentSnapshotHash,
    documentType: "RECOVERY_AUTHORITY",
    lifecycleSources: input.sources,
    signedBy: input.actorId,
    signedFileId: input.signedFileId,
    sourceFileHash: input.sourceFileHash,
    sourceFileId: input.sourceFileId
  });
}

async function validateRecoveryAuthorityChainInTransaction(
  tx: Prisma.TransactionClient,
  command: ArchiveRecoveryAuthorityInput,
  ids: RecoveryAuthorityIds,
  sources: RecoveryAuthoritySources
): Promise<Omit<ArchivedRecoveryAuthority, "wrote"> | null> {
  const revisions = await tx.subscriptionClosureDocumentRevision.findMany({
    orderBy: { revisionNumber: "asc" },
    where: {
      closureCaseId: command.closureCaseId,
      documentType: "RECOVERY_AUTHORITY"
    }
  });
  if (revisions.length === 0) return null;
  if (revisions.length !== 3) throw serviceConflict("AUTHORITY_MISMATCH");
  const generated = revisions.find(({ id }) => id === ids.generatedRevisionId);
  const signed = revisions.find(({ id }) => id === ids.signedRevisionId);
  const archived = revisions.find(({ id }) => id === ids.archivedRevisionId);
  if (!generated || !signed || !archived) throw serviceConflict("AUTHORITY_MISMATCH");
  const draft = await resolveRecoveryAuthorityDraft(
    tx,
    command.closureCaseId,
    generated.generatedAt
  );
  const documentSnapshot = recoveryAuthorityDocumentSnapshot(draft);
  const canonicalDocument = canonicalSubscriptionClosureJson(documentSnapshot);
  const documentHash = createHash("sha256").update(canonicalDocument).digest("hex");
  const signedEnvelope = recoveryAuthoritySignedEnvelope({
    actorId: command.actorId,
    completedAt: signed.signedAt!,
    documentSnapshotHash: documentHash,
    signedFileId: ids.signedFileId,
    sourceFileHash: documentHash,
    sourceFileId: ids.sourceFileId,
    sources
  });
  const canonicalSignedEnvelope = canonicalSubscriptionClosureJson(signedEnvelope);
  const signedFileHash = createHash("sha256").update(canonicalSignedEnvelope).digest("hex");
  const [current, sourceFile, signedFile, esignTask, receipts, events] = await Promise.all([
    tx.subscriptionClosureCurrentDocument.findUnique({
      where: {
        closureCaseId_documentType: {
          closureCaseId: command.closureCaseId,
          documentType: "RECOVERY_AUTHORITY"
        }
      }
    }),
    tx.fileObject.findUnique({ where: { id: ids.sourceFileId } }),
    tx.fileObject.findUnique({ where: { id: ids.signedFileId } }),
    tx.contractESignTask.findUnique({ where: { id: ids.esignTaskId } }),
    tx.subscriptionClosureCommandReceipt.findMany({
      where: {
        closureCaseId: command.closureCaseId,
        commandType: "CREATE_DOCUMENT_REVISION",
        payloadSnapshot: { equals: "RECOVERY_AUTHORITY", path: ["documentType"] }
      }
    }),
    tx.subscriptionClosureEvent.findMany({
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
      where: {
        closureCaseId: command.closureCaseId,
        detailSnapshot: { equals: "RECOVERY_AUTHORITY", path: ["documentType"] },
        eventType: "DOCUMENT_REVISION_CREATED"
      }
    })
  ]);
  const audits = await tx.auditLog.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    where: {
      entityId: { in: events.map(({ id }) => id) },
      entityType: "subscription_closure_event",
      module: "subscription_closure"
    }
  });
  const expectedSourceObjectKey = `subscription-closure/${command.closureCaseId}/${ids.generatedRevisionId}-recovery-authority.json`;
  const expectedSignedObjectKey = `subscription-closure/${command.closureCaseId}/${ids.signedRevisionId}-recovery-authority.signed.json`;
  const expectedSourceName = `${draft.closureCase.caseNo}-${ids.generatedRevisionId}-recovery-authority.json`;
  const expectedSignedName = `${draft.closureCase.caseNo}-${ids.signedRevisionId}-recovery-authority.signed.json`;
  const expectedRequest = recoveryAuthorityEsignRequest({
    documentSnapshotHash: documentHash,
    ids,
    sourceFileHash: documentHash,
    sources
  });
  const expectedResponse = recoveryAuthorityEsignResponse({
    actorId: command.actorId,
    completedAt: signed.signedAt!,
    ids,
    signedFileHash
  });
  const sourceMatches = (revision: (typeof revisions)[number], sourceIndex: 0 | 1 | 2) =>
    revision.sourceType === sources[sourceIndex].type &&
    revision.sourceId === sources[sourceIndex].id &&
    revision.sourceKey === sources[sourceIndex].key;
  const commonRevisionMatches = (revision: (typeof revisions)[number]) =>
    revision.closureCaseId === command.closureCaseId &&
    revision.documentType === "RECOVERY_AUTHORITY" &&
    revision.documentSnapshotHash === documentHash &&
    canonicalSubscriptionClosureJson(revision.documentSnapshot as never) === canonicalDocument &&
    revision.contractESignTaskId === ids.esignTaskId &&
    revision.sourceFileId === ids.sourceFileId &&
    revision.sourceFileHash === documentHash &&
    revision.generatedBy === command.actorId &&
    revision.generatedAt.getTime() === generated.generatedAt.getTime() &&
    revision.vehicleReturnId === null &&
    revision.handoverWorkOrderId === null;
  const eventBySource = new Map(events.map((event) => [event.sourceKey, event]));
  const receiptBySource = new Map(receipts.map((receipt) => [receipt.sourceKey, receipt]));
  const auditByEvent = new Map(audits.map((audit) => [audit.entityId, audit]));
  const revisionTriples = [
    [generated, sources[0], ids.generatedRevisionId, "GENERATED", null],
    [signed, sources[1], ids.signedRevisionId, "SIGNED", ids.generatedRevisionId],
    [archived, sources[2], ids.archivedRevisionId, "ARCHIVED", ids.signedRevisionId]
  ] as const;
  const firstEvent = eventBySource.get(sources[0].key);
  const expectedVersion = firstEvent ? firstEvent.sequence - 2 : -1;
  const expectedCommands = recoveryAuthorityDocumentCommands({
    actorId: command.actorId,
    closureCaseId: command.closureCaseId,
    databaseClock: generated.generatedAt,
    documentSnapshot,
    expectedVersion,
    ids,
    signedFileHash,
    sourceFileHash: documentHash,
    sources
  });
  const commandsByStage = {
    ARCHIVED: expectedCommands.archived,
    GENERATED: expectedCommands.generated,
    SIGNED: expectedCommands.signed
  } as const;
  const lifecycleRecordsValid = revisionTriples.every(
    ([revision, lifecycleSource, revisionId, stage, supersedesRevisionId], index) => {
      const event = eventBySource.get(lifecycleSource.key);
      const receipt = receiptBySource.get(lifecycleSource.key);
      const audit = event ? auditByEvent.get(event.id) : null;
      const expectedCommand = commandsByStage[stage];
      const expectedOutcome = recoveryAuthorityDocumentOutcome(revision);
      const expectedDetail = {
        documentRevisionId: revisionId,
        documentType: "RECOVERY_AUTHORITY",
        revisionNumber: index + 1
      };
      const expectedAuditAfter = event
        ? {
            action: "CREATE_DOCUMENT_REVISION",
            closureCaseId: command.closureCaseId,
            eventId: event.id,
            outcome: expectedOutcome,
            source: lifecycleSource
          }
        : null;
      const priorEvent = index === 0 ? null : eventBySource.get(sources[index - 1]!.key);
      return (
        commonRevisionMatches(revision) &&
        sourceMatches(revision, index as 0 | 1 | 2) &&
        revision.id === revisionId &&
        revision.revisionNumber === index + 1 &&
        revision.stage === stage &&
        revision.supersedesRevisionId === supersedesRevisionId &&
        receipt?.actorId === command.actorId &&
        receipt.closureCaseId === command.closureCaseId &&
        receipt.commandType === "CREATE_DOCUMENT_REVISION" &&
        receipt.eventId === event?.id &&
        receipt.sourceType === lifecycleSource.type &&
        receipt.sourceId === lifecycleSource.id &&
        receipt.sourceKey === lifecycleSource.key &&
        receipt.payloadHash === hashSubscriptionClosureSnapshot(expectedCommand) &&
        canonicalSubscriptionClosureJson(receipt.payloadSnapshot as never) ===
          canonicalSubscriptionClosureJson(expectedCommand) &&
        canonicalSubscriptionClosureJson(receipt.outcomeSnapshot as never) ===
          canonicalSubscriptionClosureJson(expectedOutcome) &&
        event?.actorId === command.actorId &&
        event.closureCaseId === command.closureCaseId &&
        event.eventType === "DOCUMENT_REVISION_CREATED" &&
        event.beforeStatus === "RECOVERY_ASSESSMENT_PENDING" &&
        event.afterStatus === "RECOVERY_ASSESSMENT_PENDING" &&
        event.sequence === expectedVersion + index + 2 &&
        event.sourceType === lifecycleSource.type &&
        event.sourceId === lifecycleSource.id &&
        event.sourceKey === lifecycleSource.key &&
        event.recordedAt.getTime() >= revision.createdAt.getTime() &&
        event.occurredAt.getTime() >= revision.generatedAt.getTime() &&
        (!priorEvent || event.occurredAt.getTime() >= priorEvent.occurredAt.getTime()) &&
        (!priorEvent || event.recordedAt.getTime() >= priorEvent.recordedAt.getTime()) &&
        canonicalSubscriptionClosureJson(event.detailSnapshot as never) ===
          canonicalSubscriptionClosureJson(expectedDetail) &&
        audit?.action === AuditAction.CREATE &&
        audit.entityType === "subscription_closure_event" &&
        audit.entityId === event.id &&
        audit.module === "subscription_closure" &&
        audit.operatorId === command.actorId &&
        audit.beforeSnapshot === null &&
        audit.ipAddress === null &&
        audit.userAgent === null &&
        audit.createdAt.getTime() >= event.recordedAt.getTime() &&
        canonicalSubscriptionClosureJson(audit.afterSnapshot as never) ===
          canonicalSubscriptionClosureJson(expectedAuditAfter)
      );
    }
  );
  if (
    !lifecycleRecordsValid ||
    expectedVersion < 0 ||
    receipts.length !== 3 ||
    events.length !== 3 ||
    audits.length !== 3 ||
    current?.closureCaseId !== command.closureCaseId ||
    current?.documentType !== "RECOVERY_AUTHORITY" ||
    current?.documentRevisionId !== ids.archivedRevisionId ||
    current?.updatedBy !== command.actorId ||
    generated.stage !== "GENERATED" ||
    generated.signedAt !== null ||
    generated.signedBy !== null ||
    generated.signedFileId !== null ||
    generated.signedFileHash !== null ||
    generated.archivedAt !== null ||
    generated.archivedBy !== null ||
    signed.stage !== "SIGNED" ||
    signed.signedAt === null ||
    signed.signedBy !== command.actorId ||
    signed.signedFileId !== ids.signedFileId ||
    signed.signedFileHash !== signedFileHash ||
    signed.archivedAt !== null ||
    signed.archivedBy !== null ||
    archived.stage !== "ARCHIVED" ||
    archived.signedAt?.getTime() !== signed.signedAt.getTime() ||
    archived.signedBy !== command.actorId ||
    archived.signedFileId !== ids.signedFileId ||
    archived.signedFileHash !== signedFileHash ||
    archived.archivedAt?.getTime() !== signed.signedAt.getTime() ||
    archived.archivedBy !== command.actorId ||
    !sourceFile ||
    sourceFile.bucket !== "subscription-closure" ||
    sourceFile.objectKey !== expectedSourceObjectKey ||
    sourceFile.originalName !== expectedSourceName ||
    sourceFile.mimeType !== "application/json" ||
    sourceFile.sizeBytes !== BigInt(Buffer.byteLength(canonicalDocument)) ||
    sourceFile.uploadedBy !== command.actorId ||
    !signedFile ||
    signedFile.bucket !== "subscription-closure" ||
    signedFile.objectKey !== expectedSignedObjectKey ||
    signedFile.originalName !== expectedSignedName ||
    signedFile.mimeType !== "application/json" ||
    signedFile.sizeBytes !== BigInt(Buffer.byteLength(canonicalSignedEnvelope)) ||
    signedFile.uploadedBy !== command.actorId ||
    !esignTask ||
    esignTask.deletedAt !== null ||
    esignTask.taskStatus !== ESignTaskStatus.COMPLETED ||
    esignTask.completedAt?.getTime() !== signed.signedAt.getTime() ||
    esignTask.contractId !== draft.closureCase.contractId ||
    esignTask.orderId !== draft.closureCase.orderId ||
    esignTask.customerId !== draft.closureCase.customerId ||
    esignTask.documentType !== ESignDocumentType.RECOVERY_AUTHORITY ||
    esignTask.signingStage !== ESignSigningStage.STAGE5_RECOVERY_AUTHORITY ||
    esignTask.provider !== ESignProviderType.OTHER ||
    esignTask.providerEnvelopeId !== ids.esignEnvelopeId ||
    esignTask.providerTaskId !== ids.esignProviderTaskId ||
    esignTask.sourceType !== sources[2].type ||
    esignTask.sourceId !== sources[2].id ||
    esignTask.sourceKey !== sources[2].key ||
    esignTask.documentObjectKey !== expectedSourceObjectKey ||
    esignTask.signedDocumentObjectKey !== expectedSignedObjectKey ||
    canonicalSubscriptionClosureJson(esignTask.requestSnapshot as never) !==
      canonicalSubscriptionClosureJson(expectedRequest) ||
    canonicalSubscriptionClosureJson(esignTask.responseSnapshot as never) !==
      canonicalSubscriptionClosureJson(expectedResponse)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return Object.freeze({
    archivedRevisionId: ids.archivedRevisionId,
    generatedRevisionId: ids.generatedRevisionId,
    signedFileHash,
    signedFileId: ids.signedFileId,
    signedRevisionId: ids.signedRevisionId
  });
}

function recoveryAuthorityDocumentOutcome(
  revision: Prisma.SubscriptionClosureDocumentRevisionGetPayload<Record<string, never>>
) {
  return Object.freeze({
    archivedAt: revision.archivedAt?.toISOString() ?? null,
    archivedBy: revision.archivedBy,
    closureCaseId: revision.closureCaseId,
    contractESignTaskId: revision.contractESignTaskId,
    createdAt: revision.createdAt.toISOString(),
    documentSnapshot: revision.documentSnapshot,
    documentSnapshotHash: revision.documentSnapshotHash,
    documentType: revision.documentType,
    generatedAt: revision.generatedAt.toISOString(),
    generatedBy: revision.generatedBy,
    handoverWorkOrderId: revision.handoverWorkOrderId,
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    signedAt: revision.signedAt?.toISOString() ?? null,
    signedBy: revision.signedBy,
    signedFileHash: revision.signedFileHash,
    signedFileId: revision.signedFileId,
    source: {
      id: revision.sourceId,
      key: revision.sourceKey,
      type: revision.sourceType
    },
    sourceFileHash: revision.sourceFileHash,
    sourceFileId: revision.sourceFileId,
    stage: revision.stage,
    supersedesRevisionId: revision.supersedesRevisionId,
    vehicleReturnId: revision.vehicleReturnId
  });
}

function stableRecoveryAuthorityId(value: string): string {
  const hex = createHash("sha256").update(`recovery-authority\u0000${value}`).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function loadPhysicalReceiptAuthority(tx: Prisma.TransactionClient, orderId: string) {
  const [closureCase, order, vehicleReturn, lease, period] = await Promise.all([
    tx.subscriptionClosureCase.findFirst({ where: { orderId, retiredAt: null } }),
    tx.subscriptionOrder.findUnique({ where: { id: orderId } }),
    tx.vehicleReturn.findUnique({ where: { orderId } }),
    tx.lease.findUnique({ where: { orderId } }),
    tx.vehicleSubscriptionPeriod.findFirst({
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      where: { orderId }
    })
  ]);
  const workOrderId = closureCase
    ? closureCase.physicalControlMode === "RECOVERY"
      ? closureCase.recoveryAssetWorkOrderId
      : closureCase.returnAssetWorkOrderId
    : null;
  const recoveryRestrictionSource = closureCase
    ? physicalSource(closureCase.id, "recovery-restriction")
    : null;
  const [vehicle, workOrder, currentDocument, managedHandovers, recoveryRestrictions] =
    await Promise.all([
      order?.vehicleId ? tx.vehicle.findUnique({ where: { id: order.vehicleId } }) : null,
      workOrderId ? tx.assetWorkOrder.findUnique({ where: { id: workOrderId } }) : null,
      closureCase
        ? tx.subscriptionClosureCurrentDocument.findUnique({
            include: { documentRevision: true },
            where: {
              closureCaseId_documentType: {
                closureCaseId: closureCase.id,
                documentType:
                  closureCase.physicalControlMode === "RECOVERY"
                    ? "RECOVERY_AUTHORITY"
                    : "RETURN_MANIFEST"
              }
            }
          })
        : null,
      closureCase
        ? Promise.resolve([])
        : tx.vehicleHandoverWorkOrder.findMany({
            select: { metadata: true },
            where: { handoverType: "RETURN_INBOUND", orderId }
          }),
      closureCase?.physicalControlMode === "RECOVERY" && recoveryRestrictionSource
        ? tx.vehicleOperationalRestriction.findMany({
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            where: {
              OR: [
                {
                  startSourceId: recoveryRestrictionSource.id,
                  startSourceKey: recoveryRestrictionSource.key,
                  startSourceType: recoveryRestrictionSource.type
                },
                {
                  restrictionType: VehicleOperationalRestrictionType.RECOVERY_IN_PROGRESS,
                  vehicleId: closureCase.vehicleId,
                  workOrderId
                }
              ]
            }
          })
        : []
    ]);
  const revision = currentDocument?.documentRevision ?? null;
  const receiptSource = closureCase
    ? physicalSource(closureCase.id, `physical-receipt:${closureCase.physicalControlMode}`)
    : null;
  const [
    sourceFile,
    signedFile,
    esignTask,
    recoveryApprovals,
    recoveryEvidence,
    receiptEvent,
    returnDamages,
    receiptMileage
  ] = revision
    ? await Promise.all([
        tx.fileObject.findUnique({ where: { id: revision.sourceFileId } }),
        revision.signedFileId
          ? tx.fileObject.findUnique({ where: { id: revision.signedFileId } })
          : null,
        tx.contractESignTask.findUnique({ where: { id: revision.contractESignTaskId } }),
        closureCase?.physicalControlMode === "RECOVERY"
          ? tx.businessExceptionApproval.findMany({
              where: {
                exceptionType: "RECOVERY_EXECUTION_APPROVAL",
                status: "APPROVED",
                subjectId: closureCase.id,
                subjectType: "RECOVERY_CASE"
              }
            })
          : Promise.resolve([]),
        closureCase?.physicalControlMode === "RECOVERY" && workOrderId
          ? tx.assetWorkOrderEvidence.findMany({ where: { workOrderId } })
          : Promise.resolve([]),
        receiptSource
          ? tx.subscriptionClosureEvent.findFirst({
              include: { commandReceipt: true },
              where: {
                sourceId: receiptSource.id,
                sourceKey: receiptSource.key,
                sourceType: receiptSource.type
              }
            })
          : null,
        vehicleReturn
          ? tx.vehicleReturnDamage.findMany({
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              where: { returnId: vehicleReturn.id }
            })
          : Promise.resolve([]),
        vehicleReturn
          ? tx.vehicleMileageReading.findUnique({
              where: {
                sourceType_sourceRecordId: {
                  sourceRecordId: vehicleReturn.id,
                  sourceType: VehicleMileageSourceType.RETURN_CONFIRMATION
                }
              }
            })
          : null
      ])
    : [null, null, null, [], [], null, [], null];
  return {
    closureCase,
    currentDocument,
    esignTask,
    lease,
    managedMarker: managedHandovers.some(({ metadata }) => isP0ManagedReturnMetadata(metadata)),
    order,
    period,
    recoveryApprovals,
    recoveryEvidence,
    recoveryRestriction: recoveryRestrictions.length === 1 ? recoveryRestrictions[0]! : null,
    recoveryRestrictions,
    receiptEvent,
    receiptMileage,
    returnDamages,
    signedFile,
    sourceFile,
    vehicle,
    vehicleReturn,
    workOrder
  };
}

type PhysicalReceiptAuthority = Awaited<ReturnType<typeof loadPhysicalReceiptAuthority>>;

function assertPhysicalReceiptAuthorityShape(
  authority: PhysicalReceiptAuthority,
  command: ConfirmManagedPhysicalReceiptInput
) {
  const {
    closureCase,
    lease,
    order,
    period,
    recoveryRestriction,
    recoveryRestrictions,
    vehicle,
    vehicleReturn,
    workOrder
  } = authority;
  if (
    !closureCase ||
    !order ||
    order.deletedAt ||
    !order.vehicleId ||
    !order.contractId ||
    !vehicle ||
    vehicle.deletedAt ||
    !vehicleReturn ||
    vehicleReturn.deletedAt ||
    !lease ||
    lease.deletedAt ||
    !period ||
    !workOrder ||
    closureCase.orderId !== order.id ||
    closureCase.vehicleId !== order.vehicleId ||
    closureCase.contractId !== order.contractId ||
    closureCase.customerId !== order.customerId ||
    (closureCase.status !== "RETURN_INSPECTION" &&
      command.returnType !==
        (closureCase.closureType === "EARLY_TERMINATION" ||
        command.physicalControlMode === "RECOVERY"
          ? "EARLY_TERMINATION"
          : "NORMAL_RETURN")) ||
    vehicleReturn.id !== closureCase.vehicleReturnId ||
    (closureCase.status !== "RETURN_INSPECTION" &&
      command.physicalControlMode !== "RECOVERY" &&
      vehicleReturn.returnType !== command.returnType) ||
    vehicleReturn.orderId !== order.id ||
    vehicleReturn.vehicleId !== order.vehicleId ||
    vehicleReturn.customerId !== order.customerId ||
    workOrder.id !==
      (command.physicalControlMode === "RECOVERY"
        ? closureCase.recoveryAssetWorkOrderId
        : closureCase.returnAssetWorkOrderId) ||
    workOrder.orderId !== order.id ||
    workOrder.vehicleId !== order.vehicleId ||
    period.orderId !== order.id ||
    period.vehicleId !== order.vehicleId ||
    period.customerId !== order.customerId ||
    (command.physicalControlMode === "RECOVERY" && recoveryRestrictions.length !== 1) ||
    (command.physicalControlMode !== "RECOVERY" && recoveryRestrictions.length !== 0)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  if (recoveryRestriction) {
    const replay = closureCase.status === "RETURN_INSPECTION";
    const expectedSource = physicalSource(closureCase.id, "recovery-restriction");
    if (
      command.physicalControlMode !== "RECOVERY" ||
      recoveryRestriction.restrictionType !==
        VehicleOperationalRestrictionType.RECOVERY_IN_PROGRESS ||
      recoveryRestriction.vehicleId !== vehicle.id ||
      recoveryRestriction.workOrderId !== workOrder.id ||
      recoveryRestriction.startSourceId !== expectedSource.id ||
      recoveryRestriction.startSourceKey !== expectedSource.key ||
      recoveryRestriction.startSourceType !== expectedSource.type ||
      (!replay && recoveryRestriction.status !== VehicleOperationalRestrictionStatus.ACTIVE) ||
      (replay && recoveryRestriction.status !== VehicleOperationalRestrictionStatus.RELEASED)
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
  }
}

function assertPhysicalReceiptObservedAuthority(
  authority: PhysicalReceiptAuthority,
  command: ConfirmManagedPhysicalReceiptInput
) {
  const {
    closureCase,
    lease,
    order,
    period,
    recoveryRestriction,
    recoveryRestrictions,
    vehicle,
    vehicleReturn,
    workOrder
  } = authority;
  if (
    !closureCase ||
    !order ||
    order.deletedAt ||
    !order.vehicleId ||
    !order.contractId ||
    !vehicle ||
    vehicle.deletedAt ||
    !vehicleReturn ||
    vehicleReturn.deletedAt ||
    !lease ||
    lease.deletedAt ||
    !period ||
    !workOrder ||
    closureCase.orderId !== order.id ||
    closureCase.vehicleId !== order.vehicleId ||
    closureCase.contractId !== order.contractId ||
    closureCase.customerId !== order.customerId ||
    (closureCase.status !== "RETURN_INSPECTION" &&
      command.returnType !==
        (closureCase.closureType === "EARLY_TERMINATION" ||
        command.physicalControlMode === "RECOVERY"
          ? "EARLY_TERMINATION"
          : "NORMAL_RETURN")) ||
    vehicleReturn.id !== closureCase.vehicleReturnId ||
    (closureCase.status !== "RETURN_INSPECTION" &&
      command.physicalControlMode !== "RECOVERY" &&
      vehicleReturn.returnType !== command.returnType) ||
    vehicleReturn.orderId !== order.id ||
    vehicleReturn.vehicleId !== order.vehicleId ||
    vehicleReturn.customerId !== order.customerId ||
    workOrder.id !==
      (command.physicalControlMode === "RECOVERY"
        ? closureCase.recoveryAssetWorkOrderId
        : closureCase.returnAssetWorkOrderId) ||
    workOrder.orderId !== order.id ||
    workOrder.vehicleId !== order.vehicleId ||
    period.orderId !== order.id ||
    period.vehicleId !== order.vehicleId ||
    period.customerId !== order.customerId ||
    (command.physicalControlMode === "RECOVERY" && recoveryRestrictions.length !== 1) ||
    (command.physicalControlMode !== "RECOVERY" && recoveryRestrictions.length !== 0)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const replay = closureCase.status === "RETURN_INSPECTION";
  if (recoveryRestriction) {
    const expectedSource = physicalSource(closureCase.id, "recovery-restriction");
    if (
      command.physicalControlMode !== "RECOVERY" ||
      recoveryRestriction.restrictionType !==
        VehicleOperationalRestrictionType.RECOVERY_IN_PROGRESS ||
      recoveryRestriction.vehicleId !== vehicle.id ||
      recoveryRestriction.workOrderId !== workOrder.id ||
      recoveryRestriction.startSourceId !== expectedSource.id ||
      recoveryRestriction.startSourceKey !== expectedSource.key ||
      recoveryRestriction.startSourceType !== expectedSource.type ||
      (!replay && recoveryRestriction.status !== VehicleOperationalRestrictionStatus.ACTIVE) ||
      (replay && recoveryRestriction.status !== VehicleOperationalRestrictionStatus.RELEASED)
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
  }
  const initialStatus =
    command.physicalControlMode === "RECOVERY" ? "RECOVERY_IN_PROGRESS" : "PREPARING_RETURN";
  if (
    (!replay && closureCase.status !== initialStatus) ||
    (!replay && order.orderStatus !== OrderStatus.PENDING_RETURN) ||
    (replay && order.orderStatus !== OrderStatus.RETURNED_PENDING_SETTLEMENT) ||
    (!replay && vehicle.status !== VehicleStatus.LEASED) ||
    (replay &&
      vehicle.status !== VehicleStatus.RETURNED &&
      vehicle.status !== VehicleStatus.MAINTENANCE) ||
    (!replay && vehicleReturn.returnStatus !== VehicleReturnStatus.READY) ||
    (replay && vehicleReturn.returnStatus !== VehicleReturnStatus.CONFIRMED) ||
    (!replay && lease.status !== LeaseStatus.ACTIVE && lease.status !== LeaseStatus.RETURN_DUE) ||
    (replay && lease.status !== LeaseStatus.COMPLETED) ||
    (!replay && period.endedAt !== null) ||
    (replay && period.endedAt === null) ||
    (!replay && workOrder.status !== AssetWorkOrderStatus.PENDING) ||
    (replay && workOrder.status !== AssetWorkOrderStatus.IN_PROGRESS)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const checklist = vehicleReturn.checklistSnapshot;
  if (
    command.physicalControlMode === "VOLUNTARY_RETURN" &&
    (!vehicleReturn.keysReturnedConfirmed ||
      !vehicleReturn.chargingEquipmentReturnedConfirmed ||
      !vehicleReturn.vehicleDocumentsReturnedConfirmed ||
      !vehicleReturn.customerItemsClearedConfirmed ||
      !vehicleReturn.exteriorCheckedConfirmed ||
      !vehicleReturn.interiorCheckedConfirmed ||
      !vehicleReturn.batteryCheckedConfirmed ||
      !vehicleReturn.mileageConfirmed ||
      !vehicleReturn.violationCheckedConfirmed ||
      !checklist ||
      (!replay &&
        canonicalSubscriptionClosureJson(checklist as never) !==
          canonicalSubscriptionClosureJson(command.checklist as never)))
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
}

function assertArchivedReturnManifestAuthority(
  authority: PhysicalReceiptAuthority,
  command: ConfirmManagedPhysicalReceiptInput
) {
  const revision = authority.currentDocument?.documentRevision;
  const closureCase = authority.closureCase!;
  const vehicleReturn = authority.vehicleReturn!;
  if (
    !revision ||
    revision.documentType !== "RETURN_MANIFEST" ||
    revision.stage !== "ARCHIVED" ||
    !revision.archivedAt ||
    !revision.archivedBy ||
    !revision.signedAt ||
    !revision.signedBy ||
    !revision.signedFileId ||
    !revision.signedFileHash ||
    revision.vehicleReturnId !== vehicleReturn.id ||
    revision.handoverWorkOrderId !== closureCase.returnHandoverWorkOrderId
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const snapshot = revision.documentSnapshot;
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const checklistHash = createHash("sha256")
    .update(canonicalSubscriptionClosureJson(vehicleReturn.checklistSnapshot as never))
    .digest("hex");
  const documentHash = createHash("sha256")
    .update(canonicalSubscriptionClosureJson(snapshot as never))
    .digest("hex");
  const requestSnapshot = authority.esignTask?.requestSnapshot;
  const responseSnapshot = authority.esignTask?.responseSnapshot;
  if (
    revision.documentSnapshotHash !== documentHash ||
    revision.sourceFileHash !== documentHash ||
    snapshot.closureCaseId !== closureCase.id ||
    snapshot.orderId !== command.orderId ||
    snapshot.vehicleId !== authority.order!.vehicleId ||
    snapshot.vehicleReturnId !== vehicleReturn.id ||
    snapshot.returnChecklistSnapshotHash !== checklistHash ||
    !authority.sourceFile ||
    !authority.signedFile ||
    !authority.esignTask ||
    authority.esignTask.deletedAt ||
    authority.esignTask.taskStatus !== ESignTaskStatus.COMPLETED ||
    authority.esignTask.contractId !== authority.order!.contractId ||
    authority.esignTask.orderId !== command.orderId ||
    authority.esignTask.customerId !== authority.order!.customerId ||
    authority.esignTask.sourceType !== revision.sourceType ||
    authority.esignTask.sourceId !== revision.sourceId ||
    authority.esignTask.sourceKey !== revision.sourceKey ||
    authority.esignTask.documentObjectKey !== authority.sourceFile.objectKey ||
    authority.esignTask.signedDocumentObjectKey !== authority.signedFile.objectKey ||
    !requestSnapshot ||
    Array.isArray(requestSnapshot) ||
    typeof requestSnapshot !== "object" ||
    requestSnapshot.documentSnapshotHash !== documentHash ||
    !responseSnapshot ||
    Array.isArray(responseSnapshot) ||
    typeof responseSnapshot !== "object" ||
    responseSnapshot.signedFileId !== revision.signedFileId ||
    responseSnapshot.signedFileHash !== revision.signedFileHash
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
}

function assertArchivedRecoveryAuthority(
  authority: PhysicalReceiptAuthority,
  command: ConfirmManagedPhysicalReceiptInput
) {
  const revision = authority.currentDocument?.documentRevision;
  const closureCase = authority.closureCase!;
  const workOrder = authority.workOrder!;
  const sourceFile = authority.sourceFile;
  const signedFile = authority.signedFile;
  const esignTask = authority.esignTask;
  if (
    !revision ||
    revision.documentType !== "RECOVERY_AUTHORITY" ||
    revision.stage !== "ARCHIVED" ||
    !revision.archivedAt ||
    !revision.archivedBy ||
    !revision.signedAt ||
    !revision.signedBy ||
    !revision.signedFileId ||
    !revision.signedFileHash ||
    revision.generatedAt.getTime() > revision.signedAt.getTime() ||
    revision.signedAt.getTime() > revision.archivedAt.getTime() ||
    !sourceFile ||
    !signedFile ||
    !esignTask ||
    authority.recoveryApprovals.length !== 1
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const expectedDocumentSnapshot = {
    caseNo: closureCase.caseNo,
    closureCaseId: closureCase.id,
    contractId: closureCase.contractId,
    customerId: closureCase.customerId,
    documentType: "RECOVERY_AUTHORITY",
    finalDisposition: closureCase.finalDisposition,
    orderId: closureCase.orderId,
    physicalControlMode: "RECOVERY",
    recoveryAssetWorkOrderId: workOrder.id,
    recoveryWorkOrderType: workOrder.workOrderType,
    vehicleId: closureCase.vehicleId,
    vehicleReturnId: closureCase.vehicleReturnId
  };
  const documentHash = createHash("sha256")
    .update(canonicalSubscriptionClosureJson(expectedDocumentSnapshot))
    .digest("hex");
  const requestSnapshot = esignTask.requestSnapshot;
  const responseSnapshot = esignTask.responseSnapshot;
  if (
    canonicalSubscriptionClosureJson(revision.documentSnapshot as never) !==
      canonicalSubscriptionClosureJson(expectedDocumentSnapshot) ||
    revision.documentSnapshotHash !== documentHash ||
    revision.sourceFileHash !== documentHash ||
    revision.closureCaseId !== closureCase.id ||
    sourceFile.id !== revision.sourceFileId ||
    sourceFile.uploadedBy !== revision.generatedBy ||
    signedFile.id !== revision.signedFileId ||
    signedFile.uploadedBy !== revision.signedBy ||
    esignTask.id !== revision.contractESignTaskId ||
    esignTask.deletedAt !== null ||
    esignTask.taskStatus !== ESignTaskStatus.COMPLETED ||
    esignTask.completedAt?.getTime() !== revision.signedAt.getTime() ||
    esignTask.contractId !== closureCase.contractId ||
    esignTask.orderId !== command.orderId ||
    esignTask.customerId !== closureCase.customerId ||
    esignTask.documentType !== ESignDocumentType.RECOVERY_AUTHORITY ||
    esignTask.signingStage !== ESignSigningStage.STAGE5_RECOVERY_AUTHORITY ||
    esignTask.sourceType !== revision.sourceType ||
    esignTask.sourceId !== revision.sourceId ||
    esignTask.sourceKey !== revision.sourceKey ||
    esignTask.documentObjectKey !== sourceFile.objectKey ||
    esignTask.signedDocumentObjectKey !== signedFile.objectKey ||
    !requestSnapshot ||
    Array.isArray(requestSnapshot) ||
    typeof requestSnapshot !== "object" ||
    requestSnapshot.documentSnapshotHash !== documentHash ||
    requestSnapshot.sourceFileId !== revision.sourceFileId ||
    requestSnapshot.sourceFileHash !== revision.sourceFileHash ||
    !responseSnapshot ||
    Array.isArray(responseSnapshot) ||
    typeof responseSnapshot !== "object" ||
    responseSnapshot.signedFileId !== revision.signedFileId ||
    responseSnapshot.signedFileHash !== revision.signedFileHash
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const serverSnapshot = {
    closureCaseId: closureCase.id,
    orderId: command.orderId,
    recoveryAssetWorkOrderId: workOrder.id,
    recoveryAuthorityRevisionId: revision.id,
    recoveryAuthoritySnapshotHash: revision.documentSnapshotHash,
    vehicleId: closureCase.vehicleId
  };
  const approval = authority.recoveryApprovals[0];
  const storedApprovalSnapshot = jsonObject(approval?.subjectSnapshot);
  const recoveryContextSnapshotHash = storedApprovalSnapshot.recoveryContextSnapshotHash;
  const approvalServerSnapshot =
    typeof recoveryContextSnapshotHash === "string" &&
    /^[0-9a-f]{64}$/.test(recoveryContextSnapshotHash)
      ? { ...serverSnapshot, recoveryContextSnapshotHash }
      : serverSnapshot;
  const snapshotHash = createHash("sha256")
    .update(canonicalSubscriptionClosureJson(approvalServerSnapshot))
    .digest("hex");
  if (
    !approval ||
    approval.requestedBy === approval.decidedBy ||
    approval.decision !== "APPROVED" ||
    !approval.decidedAt ||
    approval.subjectSnapshotHash !== snapshotHash ||
    canonicalSubscriptionClosureJson(approval.subjectSnapshot as never) !==
      canonicalSubscriptionClosureJson(approvalServerSnapshot)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const supersededEvidenceIds = new Set(
    authority.recoveryEvidence
      .map(({ supersedesEvidenceId }) => supersedesEvidenceId)
      .filter((id): id is string => Boolean(id))
  );
  const executionEvidence = authority.recoveryEvidence.filter((item) => {
    if (
      item.action === "REMOVE" ||
      supersededEvidenceIds.has(item.id) ||
      !item.capturedAt ||
      item.capturedAt.getTime() < approval.decidedAt!.getTime() ||
      item.recordedAt.getTime() < approval.decidedAt!.getTime()
    ) {
      return false;
    }
    const metadata = item.captureMetadata;
    return (
      metadata !== null &&
      !Array.isArray(metadata) &&
      typeof metadata === "object" &&
      metadata.recoveryApprovalId === approval.id &&
      metadata.recoveryAuthorityRevisionId === revision.id
    );
  });
  if (executionEvidence.length === 0) throw serviceConflict("AUTHORITY_MISMATCH");
}

function physicalReceiptLocks(
  authority: PhysicalReceiptAuthority,
  actorId: string
): SubscriptionClosureAuthorityLock[] {
  const revision = authority.currentDocument!.documentRevision;
  const actorIds = new Set(
    [
      actorId,
      revision.generatedBy,
      revision.signedBy,
      revision.archivedBy,
      ...authority.recoveryApprovals.flatMap(({ decidedBy, requestedBy }) => [
        decidedBy,
        requestedBy
      ]),
      ...authority.recoveryEvidence.map(({ actorId: evidenceActorId }) => evidenceActorId)
    ].filter((value): value is string => Boolean(value))
  );
  return [
    { id: authority.closureCase!.id, mode: "UPDATE", table: "subscription_closure_case" },
    { id: authority.order!.id, mode: "UPDATE", table: "subscription_order" },
    { id: authority.vehicle!.id, mode: "UPDATE", table: "vehicle" },
    { id: authority.lease!.id, mode: "UPDATE", table: "lease" },
    { id: authority.order!.contractId!, mode: "SHARE", table: "contract" },
    ...(authority.period!.contractSegmentId
      ? [
          {
            id: authority.period!.contractSegmentId,
            mode: "SHARE" as const,
            table: "subscription_contract_segment" as const
          }
        ]
      : []),
    { id: authority.vehicleReturn!.id, mode: "UPDATE", table: "vehicle_return" },
    { id: authority.period!.id, mode: "UPDATE", table: "vehicle_subscription_period" },
    { id: authority.workOrder!.id, mode: "UPDATE", table: "asset_work_order" },
    ...authority.recoveryRestrictions.map(({ id }) => ({
      id,
      mode: "UPDATE" as const,
      table: "vehicle_operational_restriction" as const
    })),
    ...(authority.workOrder!.relatedWorkOrderId
      ? [
          {
            id: authority.workOrder!.relatedWorkOrderId,
            mode: "SHARE" as const,
            table: "asset_work_order" as const
          }
        ]
      : []),
    ...authority.recoveryApprovals.map(({ id }) => ({
      id,
      mode: "SHARE" as const,
      table: "business_exception_approval" as const
    })),
    ...(authority.workOrder!.assetOwnerId
      ? [
          {
            id: authority.workOrder!.assetOwnerId,
            mode: "SHARE" as const,
            table: "asset_owner" as const
          }
        ]
      : []),
    ...authority.recoveryEvidence.map(({ id }) => ({
      id,
      mode: "SHARE" as const,
      table: "asset_work_order_evidence" as const
    })),
    { id: revision.id, mode: "SHARE", table: "subscription_closure_document_revision" },
    { id: revision.sourceFileId, mode: "SHARE", table: "file_object" },
    ...(revision.signedFileId
      ? [{ id: revision.signedFileId, mode: "SHARE" as const, table: "file_object" as const }]
      : []),
    { id: revision.contractESignTaskId, mode: "SHARE", table: "contract_esign_task" },
    { id: authority.order!.customerId, mode: "SHARE", table: "customer" },
    ...[...actorIds].map((id) => ({ id, mode: "SHARE" as const, table: "user" as const }))
  ];
}

async function physicalReceiptSuccessorLocks(
  tx: Prisma.TransactionClient,
  closureCase: Readonly<{
    id: string;
    orderId: string;
    reconditioningAssetWorkOrderId: string | null;
    returnAssetWorkOrderId: string | null;
    recoveryAssetWorkOrderId: string | null;
  }>
): Promise<readonly SubscriptionClosureAuthorityLock[]> {
  const workOrderIds = [
    closureCase.returnAssetWorkOrderId,
    closureCase.recoveryAssetWorkOrderId,
    closureCase.reconditioningAssetWorkOrderId
  ].filter((id): id is string => Boolean(id));
  const [settlements, evidence, costs] = await Promise.all([
    tx.subscriptionClosureSettlementRevision.findMany({
      select: { id: true },
      where: { closureCaseId: closureCase.id }
    }),
    workOrderIds.length > 0
      ? tx.assetWorkOrderEvidence.findMany({
          select: { id: true },
          where: { workOrderId: { in: workOrderIds } }
        })
      : [],
    tx.vehicleCostLedgerEntry.findMany({
      select: { id: true },
      where: { orderId: closureCase.orderId }
    })
  ]);
  return [
    ...(closureCase.reconditioningAssetWorkOrderId
      ? [
          {
            id: closureCase.reconditioningAssetWorkOrderId,
            mode: "SHARE" as const,
            table: "asset_work_order" as const
          }
        ]
      : []),
    ...settlements.map(({ id }) => ({
      id,
      mode: "SHARE" as const,
      table: "subscription_closure_settlement_revision" as const
    })),
    ...evidence.map(({ id }) => ({
      id,
      mode: "SHARE" as const,
      table: "asset_work_order_evidence" as const
    })),
    ...costs.map(({ id }) => ({
      id,
      mode: "SHARE" as const,
      table: "vehicle_cost_ledger_entry" as const
    }))
  ];
}

function physicalReceiptAuthorityIdentity(authority: PhysicalReceiptAuthority) {
  return canonicalSubscriptionClosureJson({
    case: authority.closureCase,
    currentDocumentId: authority.currentDocument?.documentRevisionId ?? null,
    esignTask: authority.esignTask,
    lease: authority.lease,
    order: authority.order,
    period: authority.period,
    recoveryApprovals: authority.recoveryApprovals,
    recoveryEvidence: authority.recoveryEvidence,
    recoveryRestriction: authority.recoveryRestriction,
    recoveryRestrictions: authority.recoveryRestrictions,
    receiptEvent: authority.receiptEvent,
    receiptMileage: authority.receiptMileage,
    returnDamages: authority.returnDamages,
    signedFile: authority.signedFile,
    sourceFile: authority.sourceFile,
    vehicle: authority.vehicle,
    vehicleReturn: authority.vehicleReturn,
    workOrder: authority.workOrder
  } as never);
}

function physicalReceiptPayload(command: ConfirmManagedPhysicalReceiptInput) {
  const checklistSnapshot = structuredClone(command.checklist);
  return {
    checklistSnapshot,
    checklistSnapshotHash: createHash("sha256")
      .update(canonicalSubscriptionClosureJson(checklistSnapshot))
      .digest("hex"),
    damages: command.damages.map((damage) => ({
      damageLevel: damage.damageLevel,
      damageType: damage.damageType,
      description: damage.description,
      estimatedRepairAmount:
        damage.estimatedRepairAmount === undefined
          ? null
          : BigInt(damage.estimatedRepairAmount).toString(),
      photoUrls: [...(damage.photoUrls ?? [])],
      responsibleParty: damage.responsibleParty ?? "UNKNOWN"
    })),
    physicalControlMode: command.physicalControlMode,
    remark: command.remark,
    returnMileageKm: command.returnMileageKm,
    returnedAt: command.returnedAt.toISOString(),
    returnType: command.returnType
  };
}

function hashPhysicalReceiptPayload(payload: ReturnType<typeof physicalReceiptPayload>) {
  return createHash("sha256").update(canonicalSubscriptionClosureJson(payload)).digest("hex");
}

async function assertExactPhysicalReceiptReplay(
  tx: Prisma.TransactionClient,
  authority: PhysicalReceiptAuthority,
  command: ConfirmManagedPhysicalReceiptInput,
  source: SubscriptionClosureSource
) {
  const expectedPayload = physicalReceiptPayload(command);
  const expectedPayloadHash = hashPhysicalReceiptPayload(expectedPayload);
  const event = authority.receiptEvent;
  const receipt = event?.commandReceipt;
  const detail = event?.detailSnapshot;
  const [eventAudits, inspectionEvents, settlements, contract] = await Promise.all([
    event
      ? tx.auditLog.findMany({
          where: {
            entityId: event.id,
            entityType: "subscription_closure_event",
            module: "subscription_closure"
          }
        })
      : [],
    tx.subscriptionClosureEvent.findMany({
      include: { commandReceipt: true },
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
      where: {
        closureCaseId: authority.closureCase!.id,
        eventType: "INSPECTION_RECORDED"
      }
    }),
    tx.subscriptionClosureSettlementRevision.findMany({
      orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
      where: { closureCaseId: authority.closureCase!.id }
    }),
    tx.contract.findUnique({ where: { id: authority.closureCase!.contractId } })
  ]);
  const persistedDamagePayloads = authority.returnDamages
    .map((damage) => ({
      createdBy: damage.createdBy,
      damageLevel: damage.damageLevel,
      damageType: damage.damageType,
      deletedAt: damage.deletedAt,
      description: damage.description,
      estimatedRepairAmount: damage.estimatedRepairAmount?.toString() ?? null,
      orderId: damage.orderId,
      photoUrls: Array.isArray(damage.photoUrls) ? damage.photoUrls : [],
      responsibleParty: damage.responsibleParty,
      returnId: damage.returnId,
      status: damage.status,
      updatedBy: damage.updatedBy,
      vehicleId: damage.vehicleId
    }))
    .sort((left, right) =>
      bytewiseCompare(
        canonicalSubscriptionClosureJson(left),
        canonicalSubscriptionClosureJson(right)
      )
    );
  const expectedDamagePayloads = expectedPayload.damages
    .map((damage) => ({
      createdBy: command.actorId,
      ...damage,
      deletedAt: null,
      orderId: authority.order!.id,
      returnId: authority.vehicleReturn!.id,
      status: "RECORDED",
      updatedBy: command.actorId,
      vehicleId: authority.vehicle!.id
    }))
    .sort((left, right) =>
      bytewiseCompare(
        canonicalSubscriptionClosureJson(left),
        canonicalSubscriptionClosureJson(right)
      )
    );
  const mileage = authority.receiptMileage;
  const vehicleReturn = authority.vehicleReturn!;
  const receiptOutcome = jsonObject(receipt?.outcomeSnapshot);
  const outcomeCase = jsonObject(receiptOutcome.case);
  const outcomeEvent = jsonObject(receiptOutcome.event);
  const originalOutcomeVersion =
    typeof outcomeCase.version === "number" ? outcomeCase.version : Number.NaN;
  const expectedEventCommand = event
    ? {
        actorId: command.actorId,
        afterStatus: "RETURN_INSPECTION" as const,
        closureCaseId: authority.closureCase!.id,
        detailSnapshot: event.detailSnapshot,
        eventType: "PHYSICAL_CONTROL_CONFIRMED" as const,
        expectedStatus:
          command.physicalControlMode === "RECOVERY"
            ? ("RECOVERY_IN_PROGRESS" as const)
            : ("PREPARING_RETURN" as const),
        expectedVersion: originalOutcomeVersion - 1,
        occurredAt: event.occurredAt,
        reconditioningAssetWorkOrderId: null,
        recoveryAssetWorkOrderId: null,
        source
      }
    : null;
  const inspectionEvent = inspectionEvents.at(-1);
  const terminalStatus = settlementTerminalStatus(authority.closureCase!);
  const successorStatusValid =
    authority.closureCase!.status === "RETURN_INSPECTION" ||
    (authority.closureCase!.status === "RECONDITIONING" &&
      inspectionEvent?.beforeStatus === "RETURN_INSPECTION" &&
      inspectionEvent.afterStatus === "RECONDITIONING") ||
    (["PENDING_SETTLEMENT", terminalStatus].includes(authority.closureCase!.status) &&
      inspectionEvent?.afterStatus === "PENDING_SETTLEMENT" &&
      ["RETURN_INSPECTION", "RECONDITIONING"].includes(inspectionEvent.beforeStatus ?? ""));
  const expectedSettlementStages = ["PROPOSED", "FINALIZED", "SETTLED"] as const;
  const settlementChainValid = settlements.every((revision, index) => {
    const predecessor = index === 0 ? null : settlements[index - 1]!;
    return (
      revision.revisionNumber === index + 1 &&
      revision.stage === expectedSettlementStages[index] &&
      revision.supersedesRevisionId === (predecessor?.id ?? null) &&
      revision.inputSnapshotHash ===
        hashSubscriptionClosureSnapshot({
          bill: revision.billInputSnapshot,
          deposit: revision.depositInputSnapshot,
          ledger: revision.ledgerInputSnapshot,
          responsibility: revision.responsibilitySnapshot
        }) &&
      revision.resultHash === hashSubscriptionClosureSnapshot(revision.resultSnapshot) &&
      (index === 0 ||
        (revision.inputSnapshotHash === predecessor!.inputSnapshotHash &&
          revision.resultHash === predecessor!.resultHash))
    );
  });
  const exactSettlementChainValid = await validateExactSettlementSuccessorChain(
    tx,
    authority.closureCase!.id,
    settlements
  );
  const settlementSuccessorValid =
    authority.closureCase!.status === terminalStatus
      ? settlements.length === 3 &&
        authority.closureCase!.currentSettlementRevisionId === settlements[2]!.id &&
        Boolean(authority.closureCase!.settledAt)
      : settlements.length <= 2 &&
        authority.closureCase!.currentSettlementRevisionId === (settlements.at(-1)?.id ?? null) &&
        authority.closureCase!.settledAt === null;
  const inspectionSuccessorsValid = await validateExactInspectionSuccessorChain(
    tx,
    authority.closureCase!.id,
    inspectionEvents
  );
  const terminalSuccessorValid = await validateExactTerminalSuccessor(
    tx,
    authority.closureCase!,
    terminalStatus
  );
  const preterminalContractStatus =
    authority.closureCase!.closureType === "EARLY_TERMINATION"
      ? ContractStatus.ARCHIVED
      : ContractStatus.SIGNED;
  const currentAggregateValid =
    authority.closureCase!.status === "RETURN_INSPECTION" ||
    authority.closureCase!.status === "RECONDITIONING" ||
    authority.closureCase!.status === "PENDING_SETTLEMENT"
      ? authority.order!.orderStatus === OrderStatus.RETURNED_PENDING_SETTLEMENT &&
        authority.lease!.status === LeaseStatus.COMPLETED &&
        contract?.status === preterminalContractStatus
      : authority.closureCase!.status === terminalStatus &&
        authority.order!.orderStatus === terminalStatus &&
        authority.lease!.status === LeaseStatus.COMPLETED &&
        contract?.status === terminalStatus;
  const eventAudit = eventAudits[0];
  if (
    !event ||
    !receipt ||
    event.sourceType !== source.type ||
    event.sourceId !== source.id ||
    event.sourceKey !== source.key ||
    receipt.sourceType !== source.type ||
    receipt.sourceId !== source.id ||
    receipt.sourceKey !== source.key ||
    receipt.actorId !== command.actorId ||
    receipt.closureCaseId !== authority.closureCase!.id ||
    receipt.commandType !== "TRANSITION_CASE" ||
    receipt.eventId !== event.id ||
    !detail ||
    Array.isArray(detail) ||
    typeof detail !== "object" ||
    !sameCanonicalReceiptValue(detail.receiptPayload, expectedPayload) ||
    detail.receiptPayloadHash !== expectedPayloadHash ||
    !expectedEventCommand ||
    receipt.payloadHash !== hashSubscriptionClosureSnapshot(expectedEventCommand) ||
    !sameCanonicalReceiptValue(receipt.payloadSnapshot, expectedEventCommand) ||
    outcomeCase.id !== authority.closureCase!.id ||
    outcomeCase.status !== "RETURN_INSPECTION" ||
    !Number.isInteger(originalOutcomeVersion) ||
    outcomeCase.version !== expectedEventCommand.expectedVersion + 1 ||
    outcomeCase.physicalControlMode !== command.physicalControlMode ||
    outcomeCase.physicalControlledAt !== command.returnedAt.toISOString() ||
    outcomeCase.currentSettlementRevisionId !== null ||
    outcomeCase.reconditioningAssetWorkOrderId !== null ||
    outcomeCase.settledAt !== null ||
    !sameCanonicalReceiptValue(outcomeEvent, {
      actorId: event.actorId,
      afterStatus: event.afterStatus,
      beforeStatus: event.beforeStatus,
      closureCaseId: event.closureCaseId,
      detailSnapshot: event.detailSnapshot,
      eventType: event.eventType,
      id: event.id,
      occurredAt: event.occurredAt.toISOString(),
      recordedAt: event.recordedAt.toISOString(),
      sequence: event.sequence,
      source: { id: event.sourceId, key: event.sourceKey, type: event.sourceType }
    }) ||
    eventAudits.length !== 1 ||
    !eventAudit ||
    eventAudit.action !== AuditAction.CREATE ||
    eventAudit.operatorId !== command.actorId ||
    !sameCanonicalReceiptValue(eventAudit.afterSnapshot, {
      action: "TRANSITION_CASE",
      closureCaseId: authority.closureCase!.id,
      eventId: event.id,
      outcome: receipt.outcomeSnapshot,
      source
    }) ||
    !successorStatusValid ||
    !inspectionSuccessorsValid ||
    !settlementChainValid ||
    !exactSettlementChainValid ||
    !settlementSuccessorValid ||
    !terminalSuccessorValid ||
    !currentAggregateValid ||
    vehicleReturn.returnedAt?.getTime() !== command.returnedAt.getTime() ||
    vehicleReturn.returnMileageKm !== command.returnMileageKm ||
    vehicleReturn.returnType !== command.returnType ||
    vehicleReturn.remark !== command.remark ||
    vehicleReturn.damageFound !== expectedPayload.damages.length > 0 ||
    (command.physicalControlMode === "VOLUNTARY_RETURN" &&
      !sameCanonicalReceiptValue(
        vehicleReturn.checklistSnapshot,
        expectedPayload.checklistSnapshot
      )) ||
    !sameCanonicalReceiptValue(
      { damages: persistedDamagePayloads },
      { damages: expectedDamagePayloads }
    ) ||
    !mileage ||
    mileage.vehicleId !== authority.vehicle!.id ||
    mileage.orderId !== authority.order!.id ||
    mileage.sourceRecordId !== vehicleReturn.id ||
    mileage.sourceType !== VehicleMileageSourceType.RETURN_CONFIRMATION ||
    mileage.status !== VehicleMileageReadingStatus.ACTIVE ||
    mileage.confirmedBy !== command.actorId ||
    mileage.createdBy !== command.actorId ||
    mileage.updatedBy !== command.actorId ||
    mileage.voidedAt !== null ||
    mileage.voidedBy !== null ||
    mileage.voidReason !== null ||
    !sameCanonicalReceiptValue(mileage.evidenceSnapshot, {
      closureCaseId: authority.closureCase!.id,
      physicalControlMode: command.physicalControlMode
    }) ||
    mileage.recordedAt.getTime() !== command.returnedAt.getTime() ||
    mileage.mileageKm !== command.returnMileageKm ||
    authority.vehicle!.currentMileageKm !== command.returnMileageKm ||
    !authority.vehicle!.salePriceReinitRequiredAt
  ) {
    throw closureSourceConflict();
  }
}

async function assertExactPhysicalReceiptSuccessorReplay(
  tx: Prisma.TransactionClient,
  closureCase: Readonly<{
    id: string;
    orderId: string;
    physicalControlMode: string;
    status: string;
  }>
) {
  if (closureCase.status === "PREPARING_RETURN") return;
  if (
    closureCase.physicalControlMode !== "VOLUNTARY_RETURN" &&
    closureCase.physicalControlMode !== "RECOVERY"
  ) {
    throw closureSourceConflict();
  }
  const authority = await loadPhysicalReceiptAuthority(tx, closureCase.orderId);
  const event = authority.receiptEvent;
  const receipt = event?.commandReceipt;
  const detail = jsonObject(event?.detailSnapshot);
  const payload = jsonObject(detail.receiptPayload);
  const checklist = jsonObject(payload.checklistSnapshot);
  const damagePayloads = payload.damages;
  if (
    authority.closureCase?.id !== closureCase.id ||
    !event ||
    !receipt ||
    !Array.isArray(damagePayloads) ||
    payload.physicalControlMode !== closureCase.physicalControlMode ||
    (payload.remark !== null && typeof payload.remark !== "string") ||
    !Number.isSafeInteger(payload.returnMileageKm) ||
    typeof payload.returnedAt !== "string" ||
    (payload.returnType !== "NORMAL_RETURN" && payload.returnType !== "EARLY_TERMINATION")
  ) {
    throw closureSourceConflict();
  }
  const damages = damagePayloads.map((candidate) => {
    const damage = jsonObject(candidate);
    const estimatedRepairAmount = damage.estimatedRepairAmount;
    const photoUrls = damage.photoUrls;
    if (
      typeof damage.damageLevel !== "string" ||
      typeof damage.damageType !== "string" ||
      typeof damage.description !== "string" ||
      (estimatedRepairAmount !== null && typeof estimatedRepairAmount !== "string") ||
      !Array.isArray(photoUrls) ||
      !photoUrls.every((photoUrl) => typeof photoUrl === "string") ||
      typeof damage.responsibleParty !== "string"
    ) {
      throw closureSourceConflict();
    }
    return {
      damageLevel: damage.damageLevel,
      damageType: damage.damageType,
      description: damage.description,
      ...(estimatedRepairAmount === null ? {} : { estimatedRepairAmount }),
      photoUrls,
      responsibleParty: damage.responsibleParty
    };
  });
  const returnedAt = new Date(payload.returnedAt);
  if (Number.isNaN(returnedAt.getTime())) throw closureSourceConflict();
  const command: ConfirmManagedPhysicalReceiptInput = {
    actorId: receipt.actorId,
    checklist,
    damages,
    orderId: closureCase.orderId,
    physicalControlMode: closureCase.physicalControlMode,
    remark: payload.remark,
    returnMileageKm: payload.returnMileageKm as number,
    returnType: payload.returnType,
    returnedAt
  };
  await assertExactPhysicalReceiptReplay(
    tx,
    authority,
    command,
    physicalSource(closureCase.id, `physical-receipt:${closureCase.physicalControlMode}`)
  );
}

function settlementRevisionOutcome(
  revision: Prisma.SubscriptionClosureSettlementRevisionGetPayload<Record<string, never>>
) {
  return Object.freeze({
    amountDueCents: revision.amountDueCents,
    amountRefundableCents: revision.amountRefundableCents,
    billInputSnapshot: revision.billInputSnapshot,
    closureCaseId: revision.closureCaseId,
    costTotalCents: revision.costTotalCents,
    createdAt: revision.createdAt.toISOString(),
    createdBy: revision.createdBy,
    depositAppliedCents: revision.depositAppliedCents,
    depositInputSnapshot: revision.depositInputSnapshot,
    depositRefundCents: revision.depositRefundCents,
    finalizedAt: revision.finalizedAt?.toISOString() ?? null,
    finalizedBy: revision.finalizedBy,
    id: revision.id,
    inputSnapshotHash: revision.inputSnapshotHash,
    ledgerInputSnapshot: revision.ledgerInputSnapshot,
    paidTotalCents: revision.paidTotalCents,
    receivableTotalCents: revision.receivableTotalCents,
    responsibilitySnapshot: revision.responsibilitySnapshot,
    resultHash: revision.resultHash,
    resultSnapshot: revision.resultSnapshot,
    revisionNumber: revision.revisionNumber,
    settledAt: revision.settledAt?.toISOString() ?? null,
    settledBy: revision.settledBy,
    settlementType: revision.settlementType,
    source: { id: revision.sourceId, key: revision.sourceKey, type: revision.sourceType },
    stage: revision.stage,
    supersedesRevisionId: revision.supersedesRevisionId,
    waiverApprovalId: revision.waiverApprovalId,
    waiverTotalCents: revision.waiverTotalCents,
    writeOffApprovalId: revision.writeOffApprovalId,
    writeOffTotalCents: revision.writeOffTotalCents
  });
}

async function validateExactSettlementSuccessorChain(
  tx: Prisma.TransactionClient,
  closureCaseId: string,
  revisions: readonly Prisma.SubscriptionClosureSettlementRevisionGetPayload<
    Record<string, never>
  >[]
) {
  if (revisions.length === 0) return true;
  const events = await tx.subscriptionClosureEvent.findMany({
    orderBy: [{ sequence: "asc" }, { id: "asc" }],
    where: { closureCaseId, eventType: "SETTLEMENT_REVISION_CREATED" }
  });
  const receipts = await tx.subscriptionClosureCommandReceipt.findMany({
    where: { closureCaseId, commandType: "CREATE_SETTLEMENT_REVISION" }
  });
  const audits = await tx.auditLog.findMany({
    where: {
      entityId: { in: events.map(({ id }) => id) },
      entityType: "subscription_closure_event",
      module: "subscription_closure"
    }
  });
  if (
    events.length !== revisions.length ||
    receipts.length !== revisions.length ||
    audits.length !== revisions.length
  ) {
    return false;
  }
  return revisions.every((revision, index) => {
    const predecessor = index === 0 ? null : revisions[index - 1]!;
    const event = events.find(({ sourceKey }) => sourceKey === revision.sourceKey);
    const receipt = receipts.find(({ sourceKey }) => sourceKey === revision.sourceKey);
    const audit = audits.find(({ entityId }) => entityId === event?.id);
    if (!event || !receipt || !audit) return false;
    const payload = jsonObject(receipt.payloadSnapshot);
    const source = { id: revision.sourceId, key: revision.sourceKey, type: revision.sourceType };
    const managedOccurredAt =
      revision.stage === "FINALIZED"
        ? revision.finalizedAt
        : revision.stage === "SETTLED"
          ? revision.settledAt
          : typeof payload.managedOccurredAt === "string"
            ? new Date(payload.managedOccurredAt)
            : null;
    const expectedCommand = {
      actorId: revision.createdBy,
      amountDueCents: revision.amountDueCents,
      amountRefundableCents: revision.amountRefundableCents,
      billInputSnapshot: revision.billInputSnapshot,
      closureCaseId,
      costTotalCents: revision.costTotalCents,
      depositAppliedCents: revision.depositAppliedCents,
      depositInputSnapshot: revision.depositInputSnapshot,
      depositRefundCents: revision.depositRefundCents,
      expectedCurrentRevisionId: predecessor?.id ?? null,
      expectedVersion: event.sequence - 2,
      finalizedAt: revision.finalizedAt,
      finalizedBy: revision.finalizedBy,
      ledgerInputSnapshot: revision.ledgerInputSnapshot,
      ...(managedOccurredAt ? { managedOccurredAt } : {}),
      paidTotalCents: revision.paidTotalCents,
      receivableTotalCents: revision.receivableTotalCents,
      ...(typeof payload.recordedAt === "string" ? { recordedAt: revision.createdAt } : {}),
      responsibilitySnapshot: revision.responsibilitySnapshot,
      resultSnapshot: revision.resultSnapshot,
      settledAt: revision.settledAt,
      settledBy: revision.settledBy,
      settlementType: revision.settlementType,
      source,
      stage: revision.stage,
      waiverApprovalId: revision.waiverApprovalId,
      waiverTotalCents: revision.waiverTotalCents,
      writeOffApprovalId: revision.writeOffApprovalId,
      writeOffTotalCents: revision.writeOffTotalCents
    };
    const expectedOutcome = settlementRevisionOutcome(revision);
    return (
      revision.revisionNumber === index + 1 &&
      revision.supersedesRevisionId === (predecessor?.id ?? null) &&
      managedOccurredAt !== null &&
      !Number.isNaN(managedOccurredAt.getTime()) &&
      managedOccurredAt.getTime() <= revision.createdAt.getTime() &&
      (revision.stage === "PROPOSED"
        ? revision.finalizedAt === null &&
          revision.finalizedBy === null &&
          revision.settledAt === null &&
          revision.settledBy === null
        : revision.stage === "FINALIZED"
          ? revision.finalizedAt?.getTime() === managedOccurredAt.getTime() &&
            revision.finalizedBy === revision.createdBy &&
            revision.settledAt === null &&
            revision.settledBy === null
          : revision.stage === "SETTLED" &&
            revision.finalizedAt?.getTime() === predecessor?.finalizedAt?.getTime() &&
            revision.finalizedBy === predecessor?.finalizedBy &&
            revision.settledAt?.getTime() === managedOccurredAt.getTime() &&
            revision.settledBy === revision.createdBy) &&
      event.actorId === revision.createdBy &&
      event.beforeStatus === "PENDING_SETTLEMENT" &&
      event.beforeStatus === event.afterStatus &&
      event.sourceType === revision.sourceType &&
      event.sourceId === revision.sourceId &&
      event.sourceKey === revision.sourceKey &&
      event.occurredAt.getTime() === revision.createdAt.getTime() &&
      event.recordedAt.getTime() === revision.createdAt.getTime() &&
      sameCanonicalReceiptValue(event.detailSnapshot, {
        revisionNumber: revision.revisionNumber,
        settlementRevisionId: revision.id,
        settlementType: revision.settlementType,
        stage: revision.stage
      }) &&
      receipt.actorId === revision.createdBy &&
      receipt.closureCaseId === closureCaseId &&
      receipt.commandType === "CREATE_SETTLEMENT_REVISION" &&
      receipt.eventId === event.id &&
      receipt.sourceType === revision.sourceType &&
      receipt.sourceId === revision.sourceId &&
      receipt.sourceKey === revision.sourceKey &&
      receipt.payloadHash === hashSubscriptionClosureSnapshot(expectedCommand) &&
      sameCanonicalReceiptValue(receipt.payloadSnapshot, expectedCommand) &&
      sameCanonicalReceiptValue(receipt.outcomeSnapshot, expectedOutcome) &&
      receipt.createdAt.getTime() === event.recordedAt.getTime() &&
      receipt.createdAt.getTime() === audit.createdAt.getTime() &&
      audit.action === AuditAction.CREATE &&
      audit.operatorId === revision.createdBy &&
      audit.beforeSnapshot === null &&
      audit.ipAddress === null &&
      audit.userAgent === null &&
      audit.createdAt.getTime() === event.recordedAt.getTime() &&
      sameCanonicalReceiptValue(audit.afterSnapshot, {
        action: "CREATE_SETTLEMENT_REVISION",
        closureCaseId,
        eventId: event.id,
        outcome: expectedOutcome,
        persistenceAt: revision.createdAt.toISOString(),
        source
      })
    );
  });
}

async function validateExactTerminalSuccessor(
  tx: Prisma.TransactionClient,
  closureCase: Readonly<{
    contractId: string;
    currentSettlementRevisionId: string | null;
    id: string;
    orderId: string;
    status: string;
  }>,
  terminalStatus: string
) {
  if (closureCase.status !== terminalStatus) return true;
  const events = await tx.subscriptionClosureEvent.findMany({
    include: { commandReceipt: true },
    where: {
      afterStatus: terminalStatus as never,
      beforeStatus: "PENDING_SETTLEMENT",
      closureCaseId: closureCase.id,
      eventType: "STATUS_TRANSITIONED"
    }
  });
  if (events.length !== 1) return false;
  const event = events[0]!;
  const receipt = event.commandReceipt;
  const [audits, aggregateAudits, order, contract, settledRevision] = await Promise.all([
    tx.auditLog.findMany({
      where: {
        entityId: event.id,
        entityType: "subscription_closure_event",
        module: "subscription_closure"
      }
    }),
    tx.auditLog.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: {
        createdAt: event.recordedAt,
        entityId: { in: [closureCase.orderId, closureCase.contractId] },
        entityType: { in: ["subscription_order", "contract"] },
        module: "subscription_closure",
        operatorId: event.actorId
      }
    }),
    tx.subscriptionOrder.findUnique({ where: { id: closureCase.orderId } }),
    tx.contract.findUnique({ where: { id: closureCase.contractId } }),
    closureCase.currentSettlementRevisionId
      ? tx.subscriptionClosureSettlementRevision.findUnique({
          where: { id: closureCase.currentSettlementRevisionId }
        })
      : null
  ]);
  const settlementReceipt = settledRevision
    ? await tx.subscriptionClosureCommandReceipt.findUnique({
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: settledRevision.sourceId,
            sourceKey: settledRevision.sourceKey,
            sourceType: settledRevision.sourceType
          }
        }
      })
    : null;
  const audit = audits[0];
  if (!receipt || audits.length !== 1 || !audit) return false;
  const settlementSource = settledRevision
    ? {
        id: settledRevision.sourceId,
        key: settledRevision.sourceKey,
        type: settledRevision.sourceType
      }
    : null;
  const source = settledRevision
    ? physicalSource(closureCase.id, `${settledRevision.sourceKey}:closure`)
    : { id: "", key: "", type: "" };
  const expectedCommand = {
    actorId: event.actorId,
    afterStatus: event.afterStatus,
    closureCaseId: closureCase.id,
    detailSnapshot: event.detailSnapshot,
    eventType: "STATUS_TRANSITIONED" as const,
    expectedStatus: "PENDING_SETTLEMENT" as const,
    expectedVersion: event.sequence - 2,
    occurredAt: event.occurredAt,
    reconditioningAssetWorkOrderId: null,
    recoveryAssetWorkOrderId: null,
    source
  };
  const outcome = jsonObject(receipt.outcomeSnapshot);
  const outcomeCase = jsonObject(outcome.case);
  const outcomeEvent = jsonObject(outcome.event);
  const terminalOrderAudits = aggregateAudits.filter((candidate) => {
    const before = jsonObject(candidate.beforeSnapshot);
    const after = jsonObject(candidate.afterSnapshot);
    return (
      candidate.entityId === closureCase.orderId &&
      candidate.entityType === "subscription_order" &&
      before.orderStatus === OrderStatus.RETURNED_PENDING_SETTLEMENT &&
      after.orderStatus === terminalStatus
    );
  });
  const terminalContractAudits = aggregateAudits.filter((candidate) => {
    const before = jsonObject(candidate.beforeSnapshot);
    const after = jsonObject(candidate.afterSnapshot);
    return (
      candidate.entityId === closureCase.contractId &&
      candidate.entityType === "contract" &&
      before.status === ContractStatus.ARCHIVED &&
      after.status === terminalStatus
    );
  });
  const terminalOrderAudit = terminalOrderAudits[0];
  const terminalContractAudit = terminalContractAudits[0];
  const valid = Boolean(
    settledRevision?.id === closureCase.currentSettlementRevisionId &&
    settledRevision.closureCaseId === closureCase.id &&
    settledRevision.stage === "SETTLED" &&
    settledRevision.createdBy === event.actorId &&
    settledRevision.settledBy === event.actorId &&
    settledRevision.settledAt !== null &&
    settlementReceipt !== null &&
    settlementSource !== null &&
    event.sourceType === source.type &&
    event.sourceId === source.id &&
    event.sourceKey === source.key &&
    event.occurredAt.getTime() === settledRevision.createdAt.getTime() &&
    event.recordedAt.getTime() === settledRevision.createdAt.getTime() &&
    settlementReceipt.createdAt.getTime() === settledRevision.createdAt.getTime() &&
    sameCanonicalReceiptValue(event.detailSnapshot, {
      inputSnapshotHash: settledRevision.inputSnapshotHash,
      resultHash: settledRevision.resultHash,
      settlementSource
    }) &&
    receipt.actorId === event.actorId &&
    receipt.closureCaseId === closureCase.id &&
    receipt.commandType === "TRANSITION_CASE" &&
    receipt.eventId === event.id &&
    receipt.sourceType === event.sourceType &&
    receipt.sourceId === event.sourceId &&
    receipt.sourceKey === event.sourceKey &&
    receipt.createdAt.getTime() === settlementReceipt.createdAt.getTime() &&
    receipt.createdAt.getTime() === event.recordedAt.getTime() &&
    receipt.payloadHash === hashSubscriptionClosureSnapshot(expectedCommand) &&
    sameCanonicalReceiptValue(receipt.payloadSnapshot, expectedCommand) &&
    outcomeCase.id === closureCase.id &&
    outcomeCase.status === terminalStatus &&
    outcomeCase.version === event.sequence - 1 &&
    sameCanonicalReceiptValue(outcomeEvent, {
      actorId: event.actorId,
      afterStatus: event.afterStatus,
      beforeStatus: event.beforeStatus,
      closureCaseId: event.closureCaseId,
      detailSnapshot: event.detailSnapshot,
      eventType: event.eventType,
      id: event.id,
      occurredAt: event.occurredAt.toISOString(),
      recordedAt: event.recordedAt.toISOString(),
      sequence: event.sequence,
      source
    }) &&
    audit.action === AuditAction.CREATE &&
    audit.operatorId === event.actorId &&
    audit.beforeSnapshot === null &&
    audit.ipAddress === null &&
    audit.userAgent === null &&
    audit.createdAt.getTime() === event.recordedAt.getTime() &&
    sameCanonicalReceiptValue(audit.afterSnapshot, {
      action: "TRANSITION_CASE",
      closureCaseId: closureCase.id,
      eventId: event.id,
      outcome: receipt.outcomeSnapshot,
      persistenceAt: event.recordedAt.toISOString(),
      source
    }) &&
    order?.orderStatus === terminalStatus &&
    contract?.status === terminalStatus &&
    aggregateAudits.length === 2 &&
    terminalOrderAudits.length === 1 &&
    terminalContractAudits.length === 1 &&
    terminalOrderAudit?.action === AuditAction.UPDATE &&
    terminalOrderAudit.entityId === closureCase.orderId &&
    terminalOrderAudit.entityType === "subscription_order" &&
    terminalOrderAudit.module === "subscription_closure" &&
    terminalOrderAudit.operatorId === event.actorId &&
    terminalOrderAudit.ipAddress === null &&
    terminalOrderAudit.userAgent === null &&
    terminalOrderAudit.createdAt.getTime() === event.recordedAt.getTime() &&
    terminalOrderAudit.createdAt.getTime() === audit.createdAt.getTime() &&
    terminalAggregateAuditTransitionMatches(
      terminalOrderAudit.beforeSnapshot,
      terminalOrderAudit.afterSnapshot,
      "orderStatus",
      OrderStatus.RETURNED_PENDING_SETTLEMENT,
      terminalStatus,
      event.actorId
    ) &&
    sameCanonicalReceiptValue(terminalOrderAudit.afterSnapshot, physicalAuditSnapshot(order)) &&
    terminalContractAudit?.action === AuditAction.UPDATE &&
    terminalContractAudit.entityId === closureCase.contractId &&
    terminalContractAudit.entityType === "contract" &&
    terminalContractAudit.module === "subscription_closure" &&
    terminalContractAudit.operatorId === event.actorId &&
    terminalContractAudit.ipAddress === null &&
    terminalContractAudit.userAgent === null &&
    terminalContractAudit.createdAt.getTime() === event.recordedAt.getTime() &&
    terminalContractAudit.createdAt.getTime() === audit.createdAt.getTime() &&
    terminalAggregateAuditTransitionMatches(
      terminalContractAudit.beforeSnapshot,
      terminalContractAudit.afterSnapshot,
      "status",
      ContractStatus.ARCHIVED,
      terminalStatus,
      event.actorId
    ) &&
    sameCanonicalReceiptValue(terminalContractAudit.afterSnapshot, physicalAuditSnapshot(contract))
  );
  return valid;
}

async function validateExactInspectionSuccessorChain(
  tx: Prisma.TransactionClient,
  closureCaseId: string,
  events: readonly Prisma.SubscriptionClosureEventGetPayload<{
    include: { commandReceipt: true };
  }>[]
) {
  if (events.length === 0) return true;
  const audits = await tx.auditLog.findMany({
    where: {
      entityId: { in: events.map(({ id }) => id) },
      entityType: "subscription_closure_event",
      module: "subscription_closure"
    }
  });
  const closureCase = await tx.subscriptionClosureCase.findUnique({ where: { id: closureCaseId } });
  const evidence = await tx.assetWorkOrderEvidence.findMany({
    orderBy: [{ sourceKey: "asc" }, { id: "asc" }],
    where: {
      sourceId: closureCaseId,
      sourceKey: { startsWith: "inspection-evidence:" },
      sourceType: "SUBSCRIPTION_CLOSURE"
    }
  });
  const costs = await tx.vehicleCostLedgerEntry.findMany({
    orderBy: [{ sourceKey: "asc" }, { id: "asc" }],
    where: {
      sourceId: closureCaseId,
      sourceKey: { startsWith: "inspection-cost:" },
      sourceType: "SUBSCRIPTION_CLOSURE"
    }
  });
  const costReceipts = await tx.assetAccountingCommandReceipt.findMany({
    where: {
      sourceId: closureCaseId,
      sourceKey: { startsWith: "inspection-cost:" },
      sourceType: "SUBSCRIPTION_CLOSURE"
    }
  });
  if (audits.length !== events.length) return false;
  const expectedEvidenceCount = events.reduce(
    (total, event) => total + Number(jsonObject(event.detailSnapshot).evidenceCount ?? 0),
    0
  );
  const expectedCostCount = events.reduce(
    (total, event) => total + Number(jsonObject(event.detailSnapshot).costCount ?? 0),
    0
  );
  if (
    !closureCase ||
    evidence.length !== expectedEvidenceCount ||
    costs.length !== expectedCostCount ||
    costReceipts.length !== expectedCostCount
  ) {
    return false;
  }
  const evidenceEvents = await tx.assetWorkOrderEvent.findMany({
    where: {
      sourceId: closureCaseId,
      sourceKey: { startsWith: "inspection-evidence:" },
      sourceType: "SUBSCRIPTION_CLOSURE"
    }
  });
  const successorAudits = await tx.auditLog.findMany({
    where: {
      entityId: {
        in: [
          ...evidence.map(({ id }) => id),
          ...evidenceEvents.map(({ id }) => id),
          ...costs.map(({ id }) => id)
        ]
      },
      entityType: {
        in: ["asset_work_order_evidence", "asset_work_order_event", "vehicle_cost_ledger_entry"]
      }
    }
  });
  if (
    evidenceEvents.length !== expectedEvidenceCount ||
    successorAudits.length !== expectedEvidenceCount * 2 + expectedCostCount
  ) {
    return false;
  }
  const successorEventsValid = events.every((event) => {
    const receipt = event.commandReceipt;
    const audit = audits.find(({ entityId }) => entityId === event.id);
    if (!receipt || !audit) return false;
    const detail = jsonObject(event.detailSnapshot);
    const source = { id: event.sourceId, key: event.sourceKey, type: event.sourceType };
    const expectedCommand = {
      actorId: event.actorId,
      afterStatus: event.afterStatus,
      closureCaseId,
      detailSnapshot: event.detailSnapshot,
      eventType: "INSPECTION_RECORDED" as const,
      expectedStatus: event.beforeStatus,
      expectedVersion: event.sequence - 2,
      occurredAt: event.occurredAt,
      reconditioningAssetWorkOrderId:
        typeof detail.reconditioningAssetWorkOrderId === "string"
          ? detail.reconditioningAssetWorkOrderId
          : null,
      recoveryAssetWorkOrderId: null,
      source
    };
    const outcome = jsonObject(receipt.outcomeSnapshot);
    const outcomeCase = jsonObject(outcome.case);
    const outcomeEvent = jsonObject(outcome.event);
    return (
      event.closureCaseId === closureCaseId &&
      event.eventType === "INSPECTION_RECORDED" &&
      event.afterStatus ===
        (expectedCommand.reconditioningAssetWorkOrderId
          ? "RECONDITIONING"
          : "PENDING_SETTLEMENT") &&
      detail.accepted === true &&
      Number.isInteger(detail.costCount) &&
      Number.isInteger(detail.evidenceCount) &&
      receipt.actorId === event.actorId &&
      receipt.closureCaseId === closureCaseId &&
      receipt.commandType === "TRANSITION_CASE" &&
      receipt.eventId === event.id &&
      receipt.sourceType === event.sourceType &&
      receipt.sourceId === event.sourceId &&
      receipt.sourceKey === event.sourceKey &&
      receipt.payloadHash === hashSubscriptionClosureSnapshot(expectedCommand) &&
      sameCanonicalReceiptValue(receipt.payloadSnapshot, expectedCommand) &&
      outcomeCase.id === closureCaseId &&
      outcomeCase.status === event.afterStatus &&
      outcomeCase.version === event.sequence - 1 &&
      outcomeCase.reconditioningAssetWorkOrderId ===
        expectedCommand.reconditioningAssetWorkOrderId &&
      sameCanonicalReceiptValue(outcomeEvent, {
        actorId: event.actorId,
        afterStatus: event.afterStatus,
        beforeStatus: event.beforeStatus,
        closureCaseId: event.closureCaseId,
        detailSnapshot: event.detailSnapshot,
        eventType: event.eventType,
        id: event.id,
        occurredAt: event.occurredAt.toISOString(),
        recordedAt: event.recordedAt.toISOString(),
        sequence: event.sequence,
        source
      }) &&
      audit.action === AuditAction.CREATE &&
      audit.operatorId === event.actorId &&
      audit.beforeSnapshot === null &&
      audit.ipAddress === null &&
      audit.userAgent === null &&
      audit.createdAt.getTime() >= event.recordedAt.getTime() &&
      sameCanonicalReceiptValue(audit.afterSnapshot, {
        action: "TRANSITION_CASE",
        closureCaseId,
        eventId: event.id,
        outcome: receipt.outcomeSnapshot,
        source
      })
    );
  });
  const firstActorId = events[0]!.actorId;
  const evidenceValid = evidence.every((item, index) => {
    const event = evidenceEvents.find(
      ({ sourceId, sourceKey, sourceType }) =>
        sourceType === item.sourceType && sourceId === item.sourceId && sourceKey === item.sourceKey
    );
    const evidenceAudit = successorAudits.find(
      ({ entityId, entityType }) =>
        entityId === item.id && entityType === "asset_work_order_evidence"
    );
    const eventAudit = successorAudits.find(
      ({ entityId, entityType }) =>
        entityId === event?.id && entityType === "asset_work_order_event"
    );
    const eventDetail = jsonObject(event?.detailSnapshot);
    const eventEnvelope = jsonObject(eventDetail.__assetOperationCommandV1);
    const envelopeResult = jsonObject(eventEnvelope.result);
    const envelopeWorkOrder = jsonObject(envelopeResult.workOrder);
    const source = { id: item.sourceId, key: item.sourceKey, type: item.sourceType };
    return (
      item.sourceType === "SUBSCRIPTION_CLOSURE" &&
      item.sourceId === closureCaseId &&
      item.sourceKey === `inspection-evidence:${index}` &&
      item.actorId === firstActorId &&
      item.workOrderId ===
        (closureCase.physicalControlMode === "RECOVERY"
          ? closureCase.recoveryAssetWorkOrderId
          : closureCase.returnAssetWorkOrderId) &&
      event?.eventType === "EVIDENCE_ATTACHED" &&
      event.actorId === item.actorId &&
      event.workOrderId === item.workOrderId &&
      event.beforeStatus === null &&
      event.afterStatus === null &&
      eventDetail.action === item.action &&
      eventDetail.evidenceId === item.id &&
      eventDetail.evidenceType === item.evidenceType &&
      eventDetail.supersedesEvidenceId === item.supersedesEvidenceId &&
      eventEnvelope.kind === "evidence" &&
      eventEnvelope.version === 1 &&
      envelopeWorkOrder.id === item.workOrderId &&
      sameCanonicalReceiptValue(eventEnvelope.command, {
        action: item.action,
        actorId: item.actorId,
        capturedAt: item.capturedAt,
        captureMetadata: item.captureMetadata,
        contentSha256: item.contentSha256,
        evidenceType: item.evidenceType,
        eventId: item.eventId,
        fileId: item.fileId,
        occurredAt: event.occurredAt,
        source,
        supersedesEvidenceId: item.supersedesEvidenceId,
        workOrderId: item.workOrderId
      }) &&
      evidenceAudit?.action === AuditAction.CREATE &&
      evidenceAudit.operatorId === item.actorId &&
      evidenceAudit.module === "asset_operations" &&
      evidenceAudit.beforeSnapshot === null &&
      evidenceAudit.ipAddress === null &&
      evidenceAudit.userAgent === null &&
      sameCanonicalReceiptValue(evidenceAudit.afterSnapshot, physicalAuditSnapshot(item)) &&
      eventAudit?.action === AuditAction.CREATE &&
      eventAudit.operatorId === item.actorId &&
      eventAudit.module === "asset_operations" &&
      eventAudit.beforeSnapshot === null &&
      eventAudit.ipAddress === null &&
      eventAudit.userAgent === null &&
      sameCanonicalReceiptValue(eventAudit.afterSnapshot, physicalAuditSnapshot(event))
    );
  });
  const costsValid = costs.every((item, index) => {
    const receipt = costReceipts.find(({ costEntryId }) => costEntryId === item.id);
    const audit = successorAudits.find(
      ({ entityId, entityType }) =>
        entityId === item.id && entityType === "vehicle_cost_ledger_entry"
    );
    const receiptPayload = jsonObject(receipt?.payloadSnapshot);
    const receiptOutcome = jsonObject(receipt?.outcomeSnapshot);
    const source = { id: item.sourceId, key: item.sourceKey, type: item.sourceType };
    const expectedPayload = {
      actionType: item.actionType,
      accountingPeriod: item.accountingPeriod,
      actorId: item.confirmedBy,
      amountCents: item.amountCents,
      assetOwnerId: item.assetOwnerId,
      assetOwnerSnapshot: item.assetOwnerSnapshot,
      confirmedAt: item.confirmedAt,
      contractId: item.contractId,
      costCategory: item.costCategory,
      customerId: item.customerId,
      evidenceId: item.evidenceId,
      evidenceSnapshot: item.evidenceSnapshot,
      occurredOn: item.occurredOn,
      orderId: item.orderId,
      reason: receiptPayload.reason,
      responsiblePartyId: item.responsiblePartyId,
      responsiblePartyType: item.responsiblePartyType,
      responsibilitySnapshot: item.responsibilitySnapshot,
      vehicleId: item.vehicleId,
      workOrderId: item.workOrderId
    };
    return Boolean(
      receipt &&
      item.sourceType === "SUBSCRIPTION_CLOSURE" &&
      item.sourceId === closureCaseId &&
      item.sourceKey === `inspection-cost:${index}` &&
      item.confirmedBy === firstActorId &&
      item.actionType === VehicleCostActionType.ACTUAL_COST &&
      item.orderId === closureCase.orderId &&
      item.contractId === closureCase.contractId &&
      item.customerId === closureCase.customerId &&
      item.vehicleId === closureCase.vehicleId &&
      item.workOrderId ===
        (closureCase.physicalControlMode === "RECOVERY"
          ? closureCase.recoveryAssetWorkOrderId
          : closureCase.returnAssetWorkOrderId) &&
      receipt.actorId === firstActorId &&
      receipt.commandType === "COST_APPEND" &&
      receipt.costEntryId === item.id &&
      receipt.approvalId === null &&
      receipt.sourceType === item.sourceType &&
      receipt.sourceId === item.sourceId &&
      receipt.sourceKey === item.sourceKey &&
      typeof receiptPayload.reason === "string" &&
      receiptPayload.reason.trim().length > 0 &&
      receipt.payloadHash === hashBusinessExceptionSnapshot(expectedPayload) &&
      canonicalAssetAccountingJson(receipt.payloadSnapshot) ===
        canonicalAssetAccountingJson(expectedPayload) &&
      receipt.createdAt.getTime() >= item.createdAt.getTime() &&
      receipt.createdAt.getTime() >= item.confirmedAt.getTime() &&
      receipt.createdAt.getTime() <= events.at(-1)!.recordedAt.getTime() &&
      sameCanonicalReceiptValue(receiptOutcome, {
        actionType: item.actionType,
        accountingPeriod: item.accountingPeriod,
        amountCents: item.amountCents,
        assetOwnerId: item.assetOwnerId,
        assetOwnerSnapshot: item.assetOwnerSnapshot,
        confirmedAt: item.confirmedAt,
        confirmedBy: item.confirmedBy,
        contractId: item.contractId,
        costCategory: item.costCategory,
        customerId: item.customerId,
        entryKind: item.entryKind,
        evidenceId: item.evidenceId,
        evidenceSnapshot: item.evidenceSnapshot,
        id: item.id,
        occurredOn: item.occurredOn,
        orderId: item.orderId,
        responsiblePartyId: item.responsiblePartyId,
        responsiblePartyType: item.responsiblePartyType,
        responsibilitySnapshot: item.responsibilitySnapshot,
        reversalOfEntryId: item.reversalOfEntryId,
        sourceId: item.sourceId,
        sourceKey: item.sourceKey,
        sourceType: item.sourceType,
        vehicleId: item.vehicleId,
        workOrderId: item.workOrderId
      }) &&
      audit?.action === AuditAction.CREATE &&
      audit.entityId === item.id &&
      audit.entityType === "vehicle_cost_ledger_entry" &&
      audit.operatorId === item.confirmedBy &&
      audit.module === "asset_accounting" &&
      audit.beforeSnapshot === null &&
      audit.ipAddress === null &&
      audit.userAgent === null &&
      audit.createdAt.getTime() >= receipt.createdAt.getTime() &&
      sameCanonicalReceiptValue(audit.afterSnapshot, {
        fact: receipt.outcomeSnapshot,
        permission: ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM,
        reason: receiptPayload.reason,
        requestContext: {
          idempotencyKey: item.sourceKey,
          ipAddress: null,
          requestId: null,
          userAgent: null
        },
        snapshotHash: hashBusinessExceptionSnapshot(receipt.outcomeSnapshot),
        source
      })
    );
  });
  const reconditioningEvent = events.find(({ afterStatus }) => afterStatus === "RECONDITIONING");
  const reconditioningWorkOrderValid = reconditioningEvent
    ? await validateExactReconditioningWorkOrderSuccessor(tx, closureCase, reconditioningEvent)
    : closureCase.reconditioningAssetWorkOrderId === null;
  return successorEventsValid && evidenceValid && costsValid && reconditioningWorkOrderValid;
}

async function validateExactReconditioningWorkOrderSuccessor(
  tx: Prisma.TransactionClient,
  closureCase: Readonly<{
    caseNo: string;
    contractId: string;
    customerId: string;
    id: string;
    orderId: string;
    physicalControlMode: string;
    reconditioningAssetWorkOrderId: string | null;
    recoveryAssetWorkOrderId: string | null;
    returnAssetWorkOrderId: string | null;
    vehicleId: string;
  }>,
  transition: Readonly<{ actorId: string; occurredAt: Date }>
) {
  if (!closureCase.reconditioningAssetWorkOrderId) return false;
  const workOrder = await tx.assetWorkOrder.findFirst({
    where: {
      contractId: closureCase.contractId,
      createSourceId: closureCase.id,
      createSourceKey: "reconditioning-work-order",
      createSourceType: "SUBSCRIPTION_CLOSURE",
      customerId: closureCase.customerId,
      id: closureCase.reconditioningAssetWorkOrderId,
      orderId: closureCase.orderId,
      relatedWorkOrderId:
        closureCase.physicalControlMode === "RECOVERY"
          ? closureCase.recoveryAssetWorkOrderId
          : closureCase.returnAssetWorkOrderId,
      vehicleId: closureCase.vehicleId,
      workOrderType: "RECONDITIONING"
    }
  });
  if (!workOrder || workOrder.createdBy !== transition.actorId) return false;
  const events = await tx.assetWorkOrderEvent.findMany({
    orderBy: [{ sequence: "asc" }, { id: "asc" }],
    where: { workOrderId: workOrder.id }
  });
  if (events.length === 0) return false;
  const event = events[0]!;
  const [audits, restrictions] = await Promise.all([
    tx.auditLog.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: {
        entityId: { in: [workOrder.id, ...events.map(({ id }) => id)] },
        entityType: { in: ["asset_work_order", "asset_work_order_event"] },
        module: "asset_operations"
      }
    }),
    tx.vehicleOperationalRestriction.findMany({ where: { workOrderId: workOrder.id } })
  ]);
  const workOrderAudits = audits.filter(
    ({ entityId, entityType }) => entityId === workOrder.id && entityType === "asset_work_order"
  );
  const eventAudits = audits.filter(({ entityType }) => entityType === "asset_work_order_event");
  const workOrderAudit = workOrderAudits.find(({ action }) => action === AuditAction.CREATE);
  const eventAudit = eventAudits.find(({ entityId }) => entityId === event.id);
  const eventDetail = jsonObject(event.detailSnapshot);
  const envelope = jsonObject(eventDetail.__assetOperationCommandV1);
  const envelopeCommand = jsonObject(envelope.command);
  const envelopeResult = jsonObject(envelope.result);
  const envelopeWorkOrder = jsonObject(envelopeResult.workOrder);
  const workOrderAfter = jsonObject(workOrderAudit?.afterSnapshot);
  const source = {
    id: closureCase.id,
    key: "reconditioning-work-order",
    type: "SUBSCRIPTION_CLOSURE"
  };
  const expectedCreateCommand = {
    actorId: transition.actorId,
    assetOwnerId: workOrder.assetOwnerId,
    authoritySnapshot: workOrder.authoritySnapshot,
    contractId: closureCase.contractId,
    costConfirmationRequired: true,
    customerId: closureCase.customerId,
    description: `Return reconditioning for closure ${closureCase.caseNo}`,
    metadata: {
      closureCaseId: closureCase.id,
      inspectionWorkOrderId: workOrder.relatedWorkOrderId
    },
    occurredAt: transition.occurredAt,
    orderId: closureCase.orderId,
    priority: "NORMAL",
    relatedWorkOrderId: workOrder.relatedWorkOrderId,
    source,
    vehicleId: closureCase.vehicleId,
    workOrderType: "RECONDITIONING"
  };
  const immutableHeaderValid =
    workOrder.workOrderNo.startsWith("AWO") &&
    workOrder.assetOwnerId === workOrderAfter.assetOwnerId &&
    workOrder.contractId === workOrderAfter.contractId &&
    workOrder.costConfirmationRequired === workOrderAfter.costConfirmationRequired &&
    workOrder.customerId === workOrderAfter.customerId &&
    workOrder.description === workOrderAfter.description &&
    sameCanonicalReceiptValue(workOrder.authoritySnapshot, workOrderAfter.authoritySnapshot) &&
    sameCanonicalReceiptValue(workOrder.metadata, workOrderAfter.metadata) &&
    workOrder.orderId === workOrderAfter.orderId &&
    workOrder.priority === workOrderAfter.priority &&
    workOrder.relatedWorkOrderId === workOrderAfter.relatedWorkOrderId &&
    workOrder.vehicleId === workOrderAfter.vehicleId &&
    workOrder.workOrderType === workOrderAfter.workOrderType &&
    workOrder.createdBy === transition.actorId;
  const allowedTransitions: Readonly<Record<string, readonly string[]>> = {
    IN_PROGRESS: ["WAITING_EXTERNAL", "PENDING_ACCEPTANCE", "CANCELLED"],
    PENDING: ["IN_PROGRESS", "CANCELLED"],
    PENDING_ACCEPTANCE: ["IN_PROGRESS", "PENDING_COST_CONFIRMATION", "CLOSED", "CANCELLED"],
    PENDING_COST_CONFIRMATION: ["IN_PROGRESS", "CLOSED", "CANCELLED"],
    WAITING_EXTERNAL: ["IN_PROGRESS", "CANCELLED"]
  };
  const transitionChainValid = events.slice(1).every((successor, index) => {
    const predecessor = events[index]!;
    const detail = jsonObject(successor.detailSnapshot);
    const successorEnvelope = jsonObject(detail.__assetOperationCommandV1);
    const successorCommand = jsonObject(successorEnvelope.command);
    const successorResult = jsonObject(successorEnvelope.result);
    const successorWorkOrder = jsonObject(successorResult.workOrder);
    const successorSource = {
      id: successor.sourceId,
      key: successor.sourceKey,
      type: successor.sourceType
    };
    const successorEventAudit = eventAudits.find(({ entityId }) => entityId === successor.id);
    const successorWorkOrderAudits = workOrderAudits.filter((candidate) => {
      const before = jsonObject(candidate.beforeSnapshot);
      const after = jsonObject(candidate.afterSnapshot);
      return (
        candidate.action === AuditAction.UPDATE &&
        before.version === successor.sequence - 2 &&
        after.version === successor.sequence - 1
      );
    });
    const successorWorkOrderAudit = successorWorkOrderAudits[0];
    const predecessorDetail = jsonObject(predecessor.detailSnapshot);
    const predecessorEnvelope = jsonObject(predecessorDetail.__assetOperationCommandV1);
    const predecessorResult = jsonObject(predecessorEnvelope.result);
    const predecessorWorkOrder = jsonObject(predecessorResult.workOrder);
    const publicDetail = { ...detail };
    delete publicDetail.__assetOperationCommandV1;
    return Boolean(
      successor.sequence === index + 2 &&
      successor.beforeStatus === predecessor.afterStatus &&
      successor.afterStatus &&
      allowedTransitions[successor.beforeStatus ?? ""]?.includes(successor.afterStatus) &&
      successorEnvelope.kind === "transition" &&
      successorEnvelope.version === 1 &&
      successorCommand.actorId === successor.actorId &&
      successorCommand.expectedVersion === successor.sequence - 2 &&
      successorCommand.workOrderId === workOrder.id &&
      successorCommand.targetStatus === successor.afterStatus &&
      successorCommand.occurredAt === successor.occurredAt.toISOString() &&
      sameCanonicalReceiptValue(successorCommand.source, successorSource) &&
      sameCanonicalReceiptValue(successorCommand.detailSnapshot, publicDetail.detailSnapshot) &&
      successorWorkOrderAudits.length === 1 &&
      successorWorkOrderAudit?.operatorId === successor.actorId &&
      successorWorkOrderAudit.action === AuditAction.UPDATE &&
      successorWorkOrderAudit.entityId === workOrder.id &&
      successorWorkOrderAudit.entityType === "asset_work_order" &&
      successorWorkOrderAudit.module === "asset_operations" &&
      successorWorkOrderAudit.ipAddress === null &&
      successorWorkOrderAudit.userAgent === null &&
      sameCanonicalReceiptValue(successorWorkOrderAudit.beforeSnapshot, predecessorWorkOrder) &&
      sameCanonicalReceiptValue(successorWorkOrderAudit.afterSnapshot, successorWorkOrder) &&
      successorEventAudit?.action === AuditAction.CREATE &&
      successorEventAudit.operatorId === successor.actorId &&
      successorEventAudit.beforeSnapshot === null &&
      successorEventAudit.ipAddress === null &&
      successorEventAudit.userAgent === null &&
      sameCanonicalReceiptValue(successorEventAudit.afterSnapshot, physicalAuditSnapshot(successor))
    );
  });
  const finalWorkOrderAudit = workOrderAudits.find((candidate) => {
    const after = jsonObject(candidate.afterSnapshot);
    return after.version === workOrder.version;
  });
  return Boolean(
    restrictions.length === 0 &&
    workOrderAudits.length === events.length &&
    eventAudits.length === events.length &&
    audits.length === events.length * 2 &&
    event.sequence === 1 &&
    event.eventType === "CREATED" &&
    event.actorId === transition.actorId &&
    event.beforeStatus === null &&
    event.afterStatus === "PENDING" &&
    event.occurredAt.getTime() === transition.occurredAt.getTime() &&
    event.sourceType === source.type &&
    event.sourceId === source.id &&
    event.sourceKey === source.key &&
    envelope.kind === "create" &&
    envelope.version === 1 &&
    sameCanonicalReceiptValue(envelopeCommand, expectedCreateCommand) &&
    sameCanonicalReceiptValue(envelopeWorkOrder, workOrderAfter) &&
    immutableHeaderValid &&
    workOrderAudit?.action === AuditAction.CREATE &&
    workOrderAudit.operatorId === transition.actorId &&
    workOrderAudit.entityId === workOrder.id &&
    workOrderAudit.entityType === "asset_work_order" &&
    workOrderAudit.module === "asset_operations" &&
    workOrderAudit.beforeSnapshot === null &&
    workOrderAudit.ipAddress === null &&
    workOrderAudit.userAgent === null &&
    eventAudit?.action === AuditAction.CREATE &&
    eventAudit.operatorId === transition.actorId &&
    eventAudit.beforeSnapshot === null &&
    eventAudit.ipAddress === null &&
    eventAudit.userAgent === null &&
    sameCanonicalReceiptValue(eventAudit.afterSnapshot, physicalAuditSnapshot(event)) &&
    transitionChainValid &&
    finalWorkOrderAudit &&
    sameCanonicalReceiptValue(finalWorkOrderAudit.afterSnapshot, physicalAuditSnapshot(workOrder))
  );
}

function terminalAggregateAuditTransitionMatches(
  beforeValue: unknown,
  afterValue: unknown,
  statusField: "orderStatus" | "status",
  beforeStatus: string,
  afterStatus: string,
  actorId: string
) {
  const before = jsonObject(beforeValue);
  const after = jsonObject(afterValue);
  if (
    before[statusField] !== beforeStatus ||
    after[statusField] !== afterStatus ||
    after.updatedBy !== actorId
  ) {
    return false;
  }
  const stableBefore = { ...before };
  const stableAfter = { ...after };
  for (const key of [statusField, "updatedAt", "updatedBy"]) {
    delete stableBefore[key];
    delete stableAfter[key];
  }
  return sameCanonicalReceiptValue(stableBefore, stableAfter);
}

function sameCanonicalReceiptValue(left: unknown, right: unknown) {
  try {
    return (
      canonicalSubscriptionClosureJson(left as never) ===
      canonicalSubscriptionClosureJson(right as never)
    );
  } catch {
    return false;
  }
}

async function applyPhysicalReceiptFacts(
  tx: Prisma.TransactionClient,
  authority: PhysicalReceiptAuthority,
  command: ConfirmManagedPhysicalReceiptInput,
  context: Readonly<{ ipAddress?: string; userAgent?: string }>,
  auditService: AuditService,
  mileageReading: Awaited<ReturnType<VehicleMileageService["appendPreparedReadingInTransaction"]>>
) {
  const vehicleReturn = authority.vehicleReturn!;
  if (authority.closureCase!.status === "RETURN_INSPECTION") {
    if (
      authority.order!.orderStatus !== OrderStatus.RETURNED_PENDING_SETTLEMENT ||
      authority.order!.actualReturnAt?.getTime() !== command.returnedAt.getTime() ||
      vehicleReturn.returnedAt?.getTime() !== command.returnedAt.getTime() ||
      vehicleReturn.returnMileageKm !== command.returnMileageKm ||
      vehicleReturn.returnType !== command.returnType
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    return;
  }
  const returned = await tx.vehicleReturn.update({
    data: {
      damageFound: command.damages.length > 0,
      remark: command.remark,
      returnMileageKm: command.returnMileageKm,
      returnStatus: VehicleReturnStatus.CONFIRMED,
      returnType: command.returnType,
      returnedAt: command.returnedAt,
      updatedBy: command.actorId
    },
    where: { id: vehicleReturn.id }
  });
  for (const damage of command.damages) {
    const createdDamage = await tx.vehicleReturnDamage.create({
      data: {
        createdBy: command.actorId,
        damageLevel: damage.damageLevel as never,
        damageType: damage.damageType as never,
        description: String(damage.description ?? ""),
        estimatedRepairAmount:
          damage.estimatedRepairAmount === undefined
            ? null
            : BigInt(damage.estimatedRepairAmount as string | number | bigint),
        orderId: authority.order!.id,
        photoUrls: (damage.photoUrls ?? Prisma.JsonNull) as never,
        responsibleParty: (damage.responsibleParty ?? "UNKNOWN") as never,
        returnId: vehicleReturn.id,
        status: "RECORDED",
        updatedBy: command.actorId,
        vehicleId: authority.vehicle!.id
      }
    });
    await auditService.write(
      {
        action: AuditAction.CREATE,
        after: physicalAuditSnapshot(createdDamage),
        entityId: createdDamage.id,
        entityType: "vehicle_return_damage",
        ipAddress: context.ipAddress,
        module: "subscription_closure",
        operatorId: command.actorId,
        userAgent: context.userAgent
      },
      tx
    );
  }
  await auditService.write(
    {
      action: AuditAction.CREATE,
      after: physicalAuditSnapshot(mileageReading),
      entityId: mileageReading.id,
      entityType: "vehicle_mileage_reading",
      ipAddress: context.ipAddress,
      module: "subscription_closure",
      operatorId: command.actorId,
      userAgent: context.userAgent
    },
    tx
  );
  const orderUpdate = await tx.subscriptionOrder.updateMany({
    data: {
      actualReturnAt: command.returnedAt,
      orderStatus: OrderStatus.RETURNED_PENDING_SETTLEMENT,
      updatedBy: command.actorId
    },
    where: { id: authority.order!.id, orderStatus: OrderStatus.PENDING_RETURN }
  });
  if (orderUpdate.count !== 1) throw serviceConflict("AUTHORITY_MISMATCH");
  const order = await tx.subscriptionOrder.findUniqueOrThrow({
    where: { id: authority.order!.id }
  });
  const lease = await tx.lease.update({
    data: { status: LeaseStatus.COMPLETED, updatedBy: command.actorId },
    where: { id: authority.lease!.id }
  });
  const vehicle = await tx.vehicle.findUnique({ where: { id: authority.vehicle!.id } });
  if (!vehicle) throw serviceConflict("AUTHORITY_MISMATCH");
  for (const [entityType, before, after] of [
    ["vehicle_return", vehicleReturn, returned],
    ["subscription_order", authority.order, order],
    ["lease", authority.lease, lease],
    ["vehicle", authority.vehicle, vehicle]
  ] as const) {
    await auditService.write(
      {
        action: AuditAction.UPDATE,
        after: physicalAuditSnapshot(after),
        before: physicalAuditSnapshot(before),
        entityId: after!.id,
        entityType,
        ipAddress: context.ipAddress,
        module: "subscription_closure",
        operatorId: command.actorId,
        userAgent: context.userAgent
      },
      tx
    );
  }
}

function physicalAuditSnapshot(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(physicalAuditSnapshot);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      physicalAuditSnapshot(item)
    ])
  );
}

function normalizePhysicalReceiptInput(
  input: ConfirmManagedPhysicalReceiptInput
): ConfirmManagedPhysicalReceiptInput {
  if (!Number.isSafeInteger(input.returnMileageKm) || input.returnMileageKm < 0) {
    throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
  }
  return deepFreezeReceipt({
    actorId: canonicalUuid(input.actorId),
    checklist: structuredClone(input.checklist),
    damages: structuredClone(input.damages),
    orderId: canonicalUuid(input.orderId),
    physicalControlMode: input.physicalControlMode,
    remark: input.remark?.trim() || null,
    returnMileageKm: input.returnMileageKm,
    returnType: input.returnType,
    returnedAt: validDate(input.returnedAt)
  });
}

function normalizeInspectionInput(
  input: RecordManagedReturnInspectionInput
): RecordManagedReturnInspectionInput {
  return deepFreezeReceipt({
    accepted: input.accepted,
    actorId: canonicalUuid(input.actorId),
    closureCaseId: canonicalUuid(input.closureCaseId),
    costs: structuredClone(input.costs),
    evidence: structuredClone(input.evidence),
    occurredAt: validDate(input.occurredAt),
    reconditioningRequired: input.reconditioningRequired
  });
}

function normalizeInventoryReleaseInput(
  input: ReleaseManagedInventoryInput
): ReleaseManagedInventoryInput {
  const releaseReason = input.releaseReason.trim();
  if (!releaseReason || releaseReason.length > 2000) {
    throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
  }
  return Object.freeze({
    actorId: canonicalUuid(input.actorId),
    closureCaseId: canonicalUuid(input.closureCaseId),
    occurredAt: validDate(input.occurredAt),
    releaseReason
  });
}

function workOrderAuthorityOf(
  workOrder: Readonly<{
    assetOwnerId: string | null;
    contractId: string | null;
    customerId: string | null;
    id: string;
    orderId: string | null;
    relatedWorkOrderId: string | null;
    vehicleId: string;
  }>
) {
  return {
    assetOwnerId: workOrder.assetOwnerId,
    contractId: workOrder.contractId,
    customerId: workOrder.customerId,
    orderId: workOrder.orderId,
    relatedWorkOrderId: workOrder.relatedWorkOrderId,
    vehicleId: workOrder.vehicleId,
    workOrderId: workOrder.id
  };
}

function requiredCapability<T>(capabilities: ReadonlyMap<string, unknown>, key: string): T {
  const capability = capabilities.get(key);
  if (!capability) throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
  return capability as T;
}

function physicalSource(closureCaseId: string, key: string): SubscriptionClosureSource {
  return Object.freeze({ id: closureCaseId, key, type: "SUBSCRIPTION_CLOSURE" });
}

function deepFreezeReceipt<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreezeReceipt(Reflect.get(value, key));
  return Object.freeze(value);
}

function source(segmentId: string, key: string): SubscriptionClosureSource {
  return Object.freeze({ id: segmentId, key, type: "SUBSCRIPTION_EXPIRY" });
}

function normalExpiryAssetCommand(
  authority: NormalExpiryAuthority,
  assetSource: SubscriptionClosureSource,
  occurredAt: Date,
  vehicleReturnId: string
) {
  return {
    assetOwnerId: null,
    contractId: authority.contractId,
    costConfirmationRequired: false,
    customerId: authority.customerId,
    description: `Normal-expiry return inbound for ${authority.orderNo}`,
    metadata: {
      closureIntent: "NORMAL_COMPLETION",
      segmentId: authority.segmentId,
      vehicleReturnId
    },
    occurredAt,
    orderId: authority.orderId,
    priority: "NORMAL" as const,
    relatedWorkOrderId: null,
    source: assetSource,
    vehicleId: authority.vehicleId,
    workOrderType: "RETURN_INBOUND" as const
  };
}

function normalExpiryCaseCommand(
  authority: NormalExpiryAuthority,
  caseSource: SubscriptionClosureSource,
  occurredAt: Date,
  links: Readonly<{
    assetWorkOrderId: string;
    handoverWorkOrderId: string;
    vehicleReturnId: string;
  }>
) {
  return {
    actorId: authority.actorId,
    authoritySnapshot: {
      actorAuthority: "CONTRACT_SEGMENT_OR_ORDER",
      contractId: authority.contractId,
      customerId: authority.customerId,
      decisionAt: occurredAt,
      orderId: authority.orderId,
      segmentEndDate: authority.segmentEndDate,
      segmentId: authority.segmentId,
      vehicleId: authority.vehicleId,
      vehicleReturnId: links.vehicleReturnId
    },
    closureType: "NORMAL_COMPLETION" as const,
    contractId: authority.contractId,
    customerId: authority.customerId,
    effectiveAt: occurredAt,
    finalDisposition: "COMPLETE" as const,
    orderId: authority.orderId,
    physicalControlMode: "VOLUNTARY_RETURN" as const,
    returnAssetWorkOrderId: links.assetWorkOrderId,
    returnHandoverWorkOrderId: links.handoverWorkOrderId,
    source: caseSource,
    vehicleId: authority.vehicleId,
    vehicleReturnId: links.vehicleReturnId
  };
}

type ManifestAuthorityPlanInput = Readonly<{
  assetWorkOrderId: string;
  authority: NormalExpiryAuthority;
  caseNo: string;
  closureCaseId: string;
  documentSource: SubscriptionClosureSource;
  documentSnapshot: ReturnType<typeof returnManifestDocumentSnapshot>;
  documentRevisionId?: string;
  expectedVersion?: number;
  handoverWorkOrderId: string;
  vehicleReturnId: string;
}>;

async function planManifestAuthoritiesInTransaction(
  tx: Prisma.TransactionClient,
  input: ManifestAuthorityPlanInput
) {
  const generatedAt = await readDatabaseClock(tx);
  const documentSnapshot = input.documentSnapshot;
  const canonicalManifest = canonicalSubscriptionClosureJson(documentSnapshot);
  const sourceFileHash = createHash("sha256").update(canonicalManifest).digest("hex");
  const objectKey = `subscription-closure/${input.closureCaseId}/return-manifest-r1.json`;
  const sourceFileId = randomUUID();
  const candidates = await findReturnManifestEsignAuthorities(tx, input.documentSource);
  if (candidates.length !== 0) throw serviceConflict("AUTHORITY_MISMATCH");
  const contractESignTaskId = randomUUID();
  return {
    command: {
      actorId: input.authority.actorId,
      archivedAt: null,
      archivedBy: null,
      closureCaseId: input.closureCaseId,
      contractESignTaskId,
      documentSnapshot,
      documentType: "RETURN_MANIFEST" as const,
      documentRevisionId: input.documentRevisionId,
      expectedCurrentRevisionId: null,
      expectedVersion: input.expectedVersion ?? 0,
      generatedAt,
      handoverWorkOrderId: input.handoverWorkOrderId,
      signedAt: null,
      signedBy: null,
      signedFileHash: null,
      signedFileId: null,
      source: input.documentSource,
      sourceFileHash,
      sourceFileId,
      stage: "GENERATED" as const,
      vehicleReturnId: input.vehicleReturnId
    },
    creation: {
      canonicalManifest,
      documentName: `${input.caseNo}-return-manifest-r1.json`,
      objectKey
    },
    esignTask: null
  };
}

async function createManifestAuthoritiesInTransaction(
  tx: Prisma.TransactionClient,
  command: AppendSubscriptionClosureDocumentCommand,
  creation: Readonly<{
    canonicalManifest: string;
    documentName: string;
    objectKey: string;
  }>,
  authority: NormalExpiryAuthority
) {
  const file = await tx.fileObject.create({
    data: {
      bucket: "subscription-closure",
      createdAt: command.generatedAt,
      id: command.sourceFileId,
      mimeType: "application/json",
      objectKey: creation.objectKey,
      originalName: creation.documentName,
      sizeBytes: BigInt(Buffer.byteLength(creation.canonicalManifest)),
      uploadedBy: authority.actorId
    }
  });
  const task = await tx.contractESignTask.create({
    data: {
      contractId: authority.contractId,
      createdAt: command.generatedAt,
      createdBy: authority.actorId,
      customerId: authority.customerId,
      documentName: creation.documentName,
      documentObjectKey: creation.objectKey,
      documentType: ESignDocumentType.DELIVERY_HANDOVER,
      id: command.contractESignTaskId,
      orderId: authority.orderId,
      provider: ESignProviderType.OTHER,
      requestSnapshot: returnManifestEsignSnapshot(
        command.source,
        command.closureCaseId,
        command.sourceFileHash,
        command.sourceFileHash,
        command.sourceFileId,
        1
      ),
      signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
      sourceId: command.source.id,
      sourceKey: command.source.key,
      sourceType: command.source.type,
      taskNo: createBusinessNo("ESG"),
      taskStatus: ESignTaskStatus.CREATED,
      updatedAt: command.generatedAt,
      updatedBy: authority.actorId
    }
  });
  return { file, task };
}

function replayManifestCommand(
  revision: Readonly<{
    archivedAt: Date | null;
    archivedBy: string | null;
    closureCaseId: string;
    contractESignTaskId: string;
    documentSnapshot: Prisma.JsonValue;
    documentType: "RETURN_MANIFEST" | "EARLY_TERMINATION_AGREEMENT" | "RECOVERY_AUTHORITY";
    generatedAt: Date;
    generatedBy: string;
    handoverWorkOrderId: string | null;
    signedAt: Date | null;
    signedBy: string | null;
    signedFileHash: string | null;
    signedFileId: string | null;
    sourceFileHash: string;
    sourceFileId: string;
    stage: "GENERATED" | "SIGNED" | "ARCHIVED";
    vehicleReturnId: string | null;
  }>,
  documentSource: SubscriptionClosureSource
): AppendSubscriptionClosureDocumentCommand {
  if (
    revision.documentType !== "RETURN_MANIFEST" ||
    !revision.vehicleReturnId ||
    !revision.handoverWorkOrderId
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return {
    actorId: revision.generatedBy,
    archivedAt: revision.archivedAt,
    archivedBy: revision.archivedBy,
    closureCaseId: revision.closureCaseId,
    contractESignTaskId: revision.contractESignTaskId,
    documentSnapshot: revision.documentSnapshot as never,
    documentType: revision.documentType,
    expectedCurrentRevisionId: null,
    expectedVersion: 0,
    generatedAt: revision.generatedAt,
    handoverWorkOrderId: revision.handoverWorkOrderId,
    signedAt: revision.signedAt,
    signedBy: revision.signedBy,
    signedFileHash: revision.signedFileHash,
    signedFileId: revision.signedFileId,
    source: documentSource,
    sourceFileHash: revision.sourceFileHash,
    sourceFileId: revision.sourceFileId,
    stage: revision.stage,
    vehicleReturnId: revision.vehicleReturnId
  };
}

async function assertReturnManifestEsignAuthority(
  tx: Prisma.TransactionClient,
  command: ReturnType<typeof replayManifestCommand>,
  authority: NormalExpiryAuthority,
  documentSource: SubscriptionClosureSource,
  expectedDocumentSnapshot: ReturnType<typeof returnManifestDocumentSnapshot>,
  txOwnedAuthorities: Awaited<ReturnType<typeof createManifestAuthoritiesInTransaction>> | null
) {
  const candidates = txOwnedAuthorities
    ? [txOwnedAuthorities.task]
    : await findReturnManifestEsignAuthorities(tx, documentSource);
  const task = candidates[0];
  if (candidates.length !== 1 || !task || task.id !== command.contractESignTaskId) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const snapshotHash = createHash("sha256")
    .update(canonicalSubscriptionClosureJson(command.documentSnapshot))
    .digest("hex");
  if (
    canonicalSubscriptionClosureJson(command.documentSnapshot) !==
    canonicalSubscriptionClosureJson(expectedDocumentSnapshot)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const documentSnapshot = manifestSnapshot(command.documentSnapshot as Prisma.JsonValue);
  const expectedObjectKey = `subscription-closure/${command.closureCaseId}/return-manifest-r1.json`;
  const expectedDocumentName = `${documentSnapshot.caseNo}-return-manifest-r1.json`;
  const file = txOwnedAuthorities
    ? txOwnedAuthorities.file
    : await tx.fileObject.findUnique({ where: { id: command.sourceFileId } });
  const expectedSnapshot = returnManifestEsignSnapshot(
    documentSource,
    command.closureCaseId,
    snapshotHash,
    command.sourceFileHash,
    command.sourceFileId,
    1
  );
  if (
    task.contractId !== authority.contractId ||
    task.customerId !== authority.customerId ||
    task.orderId !== authority.orderId ||
    task.documentType !== ESignDocumentType.DELIVERY_HANDOVER ||
    task.signingStage !== ESignSigningStage.STAGE2_DELIVERY_HANDOVER ||
    task.deletedAt !== null ||
    task.documentObjectKey !== expectedObjectKey ||
    task.documentName !== expectedDocumentName ||
    task.sourceId !== documentSource.id ||
    task.sourceKey !== documentSource.key ||
    task.sourceType !== documentSource.type ||
    canonicalSubscriptionClosureJson(task.requestSnapshot) !==
      canonicalSubscriptionClosureJson(expectedSnapshot) ||
    !file ||
    file.id !== command.sourceFileId ||
    file.bucket !== "subscription-closure" ||
    file.mimeType !== "application/json" ||
    file.objectKey !== expectedObjectKey ||
    file.originalName !== expectedDocumentName ||
    file.sizeBytes !==
      BigInt(Buffer.byteLength(canonicalSubscriptionClosureJson(command.documentSnapshot))) ||
    file.uploadedBy !== command.actorId ||
    command.sourceFileHash !== snapshotHash
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
}

function returnManifestDocumentSnapshot(
  input: Readonly<{
    assetWorkOrderId: string;
    authority: NormalExpiryAuthority;
    caseNo: string;
    closureCaseId: string;
    handoverWorkOrderId: string;
    vehicleReturnId: string;
  }>
) {
  return {
    assetWorkOrderId: input.assetWorkOrderId,
    caseNo: input.caseNo,
    closureCaseId: input.closureCaseId,
    contractId: input.authority.contractId,
    customerId: input.authority.customerId,
    documentType: "RETURN_MANIFEST",
    handoverWorkOrderId: input.handoverWorkOrderId,
    orderId: input.authority.orderId,
    segmentId: input.authority.segmentId,
    vehicleId: input.authority.vehicleId,
    vehicleReturnId: input.vehicleReturnId
  } as const;
}

function manifestSnapshot(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const caseNo = value.caseNo;
  if (typeof caseNo !== "string" || !caseNo.trim()) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return { caseNo };
}

function findReturnManifestEsignAuthorities(
  tx: Prisma.TransactionClient,
  documentSource: SubscriptionClosureSource
) {
  return tx.contractESignTask.findMany({
    where: {
      sourceId: documentSource.id,
      sourceKey: documentSource.key,
      sourceType: documentSource.type
    }
  });
}

function returnManifestEsignSnapshot(
  documentSource: SubscriptionClosureSource,
  closureCaseId: string,
  documentSnapshotHash: string,
  sourceFileHash: string,
  sourceFileId: string,
  revisionNumber: number
) {
  return {
    closureCaseId,
    documentSnapshotHash,
    documentType: "RETURN_MANIFEST",
    returnManifestSource: documentSource,
    revisionNumber,
    sourceFileHash,
    sourceFileId
  } as const;
}

function sourceSortKey(value: SubscriptionClosureSource) {
  return `${value.type.trim()}\u0000${value.id.trim().toLowerCase()}\u0000${value.key.trim()}`;
}

function bytewiseCompare(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function requiredAttestation(
  attestations: ReadonlyMap<string, ClosureAuthorityAttestation>,
  key: string
) {
  const attestation = attestations.get(key);
  if (!attestation) throw serviceConflict("CAPABILITY_INVALID");
  return attestation;
}

function requiredPreparedSource(
  capabilities: ReadonlyMap<string, PreparedClosureSourceCapability>,
  key: string
) {
  const capability = capabilities.get(key);
  if (!capability) throw serviceConflict("CAPABILITY_INVALID");
  return capability;
}

function requiredValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw serviceConflict("CAPABILITY_INVALID");
  return value;
}

const MANAGED_SETTLEMENT_INPUT_KEYS = new Set([
  "actorId",
  "closureCaseId",
  "idempotencyKey",
  "occurredAt",
  "waiverApprovalId",
  "writeOffApprovalId"
]);

function normalizeManagedSettlementInput(input: ManagedSettlementInput): ManagedSettlementInput {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !MANAGED_SETTLEMENT_INPUT_KEYS.has(key))
  ) {
    throw settlementBadRequest("SETTLEMENT_CLIENT_FACTS_FORBIDDEN");
  }
  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey || idempotencyKey.length > 220) {
    throw settlementBadRequest("SETTLEMENT_CLIENT_FACTS_FORBIDDEN");
  }
  return Object.freeze({
    actorId: settlementUuid(input.actorId),
    closureCaseId: settlementUuid(input.closureCaseId),
    idempotencyKey,
    occurredAt: validSettlementDate(input.occurredAt),
    waiverApprovalId: nullableSettlementUuid(input.waiverApprovalId),
    writeOffApprovalId: nullableSettlementUuid(input.writeOffApprovalId)
  });
}

function settlementRevisionCommand(
  command: ManagedSettlementInput,
  closureCase: Readonly<{
    currentSettlementRevision: Readonly<{
      createdAt?: Date | string;
      finalizedAt?: Date | string | null;
      finalizedBy?: string | null;
    }> | null;
    currentSettlementRevisionId: string | null;
    version: number;
  }>,
  resolution: ResolvedSubscriptionClosureSettlement,
  source: SubscriptionClosureSource,
  targetStage: "PROPOSED" | "FINALIZED" | "SETTLED",
  recordedAt: Date
): AppendSubscriptionClosureSettlementCommand {
  const predecessor = closureCase.currentSettlementRevision;
  const finalizedAt =
    targetStage === "PROPOSED"
      ? null
      : targetStage === "FINALIZED"
        ? command.occurredAt
        : predecessor?.finalizedAt
          ? new Date(predecessor.finalizedAt)
          : null;
  const finalizedBy =
    targetStage === "PROPOSED"
      ? null
      : targetStage === "FINALIZED"
        ? command.actorId
        : (predecessor?.finalizedBy ?? null);
  return Object.freeze({
    actorId: command.actorId,
    amountDueCents: resolution.amountDueCents,
    amountRefundableCents: resolution.amountRefundableCents,
    billInputSnapshot: resolution.billInputSnapshot,
    closureCaseId: command.closureCaseId,
    costTotalCents: resolution.costTotalCents,
    depositAppliedCents: resolution.depositAppliedCents,
    depositInputSnapshot: resolution.depositInputSnapshot,
    depositRefundCents: resolution.depositRefundCents,
    expectedCurrentRevisionId: closureCase.currentSettlementRevisionId,
    expectedVersion: closureCase.version,
    finalizedAt,
    finalizedBy,
    ledgerInputSnapshot: resolution.ledgerInputSnapshot,
    managedOccurredAt: command.occurredAt,
    paidTotalCents: resolution.paidTotalCents,
    recordedAt,
    receivableTotalCents: resolution.receivableTotalCents,
    responsibilitySnapshot: resolution.responsibilitySnapshot,
    resultSnapshot: resolution.resultSnapshot,
    settledAt: targetStage === "SETTLED" ? command.occurredAt : null,
    settledBy: targetStage === "SETTLED" ? command.actorId : null,
    settlementType: "FINAL",
    source,
    stage: targetStage,
    waiverApprovalId: command.waiverApprovalId,
    waiverTotalCents: resolution.waiverTotalCents,
    writeOffApprovalId: command.writeOffApprovalId,
    writeOffTotalCents: resolution.writeOffTotalCents
  });
}

function assertSettlementCase(
  closureCase: unknown,
  resolution: ResolvedSubscriptionClosureSettlement
): asserts closureCase is Readonly<{
  closureType: string;
  contractId: string;
  currentSettlementRevision: Readonly<{
    createdAt?: Date | string;
    finalizedAt?: Date | string | null;
    finalizedBy?: string | null;
    inputSnapshotHash?: string;
    resultHash?: string;
    stage: string;
  }> | null;
  currentSettlementRevisionId: string | null;
  customerId: string;
  finalDisposition: string;
  id: string;
  orderId: string;
  physicalControlMode: string;
  status: string;
  vehicleId: string;
  version: number;
}> {
  if (!closureCase || typeof closureCase !== "object") {
    throw serviceConflict("SETTLEMENT_STATUS_CONFLICT");
  }
  const candidate = closureCase as Record<string, unknown>;
  if (
    candidate.id !== resolution.closureCaseId ||
    candidate.orderId !== resolution.orderId ||
    candidate.contractId !== resolution.contractId ||
    candidate.customerId !== resolution.customerId ||
    candidate.vehicleId !== resolution.vehicleId ||
    candidate.status !== "PENDING_SETTLEMENT" ||
    (candidate.currentSettlementRevision as { stage?: string } | null)?.stage === "SETTLED" ||
    !Number.isInteger(candidate.version)
  ) {
    throw serviceConflict("SETTLEMENT_STATUS_CONFLICT");
  }
}

function assertSettlementPredecessor(
  targetStage: "PROPOSED" | "FINALIZED" | "SETTLED",
  closureCase: Readonly<{
    currentSettlementRevision: Readonly<{
      createdAt?: Date | string;
      finalizedAt?: Date | string | null;
      finalizedBy?: string | null;
      inputSnapshotHash?: string;
      resultHash?: string;
      stage: string;
    }> | null;
  }>,
  resolution: ResolvedSubscriptionClosureSettlement
) {
  const predecessor = closureCase.currentSettlementRevision;
  if (targetStage === "PROPOSED") return;
  const requiredStage = targetStage === "FINALIZED" ? "PROPOSED" : "FINALIZED";
  if (
    predecessor?.stage !== requiredStage ||
    predecessor.inputSnapshotHash !== resolution.inputSnapshotHash ||
    predecessor.resultHash !== resolution.resultHash ||
    (targetStage === "SETTLED" && (!predecessor.finalizedBy || !predecessor.finalizedAt))
  ) {
    throw serviceConflict("SETTLEMENT_FACT_DRIFT");
  }
}

function assertSettlementChronology(
  targetStage: "PROPOSED" | "FINALIZED" | "SETTLED",
  occurredAt: Date,
  closureCase: Readonly<{
    currentSettlementRevision: Readonly<{
      createdAt?: Date | string;
      finalizedAt?: Date | string | null;
    }> | null;
  }>,
  boundary: Readonly<{ clockTimestamp: Date; latestOccurredAt: Date | null }>
) {
  const occurredTime = occurredAt.getTime();
  const latestEventTime = boundary.latestOccurredAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const predecessor = closureCase.currentSettlementRevision;
  const predecessorCreatedTime = predecessor?.createdAt
    ? new Date(predecessor.createdAt).getTime()
    : Number.NaN;
  const predecessorFinalizedTime = predecessor?.finalizedAt
    ? new Date(predecessor.finalizedAt).getTime()
    : Number.NaN;
  if (
    occurredTime > boundary.clockTimestamp.getTime() ||
    latestEventTime > boundary.clockTimestamp.getTime() ||
    (targetStage === "FINALIZED" &&
      (!Number.isFinite(predecessorCreatedTime) || occurredTime < predecessorCreatedTime)) ||
    (targetStage === "SETTLED" &&
      (!Number.isFinite(predecessorFinalizedTime) || occurredTime < predecessorFinalizedTime))
  ) {
    throw serviceConflict("SETTLEMENT_CHRONOLOGY_INVALID");
  }
}

function assertSettlementApprovalShape(
  command: ManagedSettlementInput,
  resolution: ResolvedSubscriptionClosureSettlement
) {
  if (
    resolution.waiverTotalCents > 0n !== Boolean(command.waiverApprovalId) ||
    resolution.writeOffTotalCents > 0n !== Boolean(command.writeOffApprovalId)
  ) {
    throw serviceConflict("SETTLEMENT_APPROVAL_REQUIRED");
  }
}

function settlementTerminalStatus(closureCase: Readonly<{ finalDisposition: string }>) {
  return closureCase.finalDisposition === "COMPLETE"
    ? ("COMPLETED" as const)
    : ("TERMINATED" as const);
}

async function replayManagedSettlement(
  tx: Prisma.TransactionClient,
  command: ManagedSettlementInput,
  targetStage: "PROPOSED" | "FINALIZED" | "SETTLED",
  source: SubscriptionClosureSource
) {
  const receipt = await tx.subscriptionClosureCommandReceipt.findUnique({
    select: { commandType: true, outcomeSnapshot: true, payloadSnapshot: true },
    where: {
      sourceType_sourceId_sourceKey: {
        sourceId: source.id,
        sourceKey: source.key,
        sourceType: source.type
      }
    }
  });
  if (!receipt) return null;
  const payload = receipt.payloadSnapshot as Record<string, unknown>;
  if (
    receipt.commandType !== "CREATE_SETTLEMENT_REVISION" ||
    payload.actorId !== command.actorId ||
    payload.closureCaseId !== command.closureCaseId ||
    payload.managedOccurredAt !== command.occurredAt.toISOString() ||
    payload.stage !== targetStage ||
    (payload.waiverApprovalId ?? null) !== command.waiverApprovalId ||
    (payload.writeOffApprovalId ?? null) !== command.writeOffApprovalId ||
    (targetStage === "FINALIZED" && payload.finalizedAt !== command.occurredAt.toISOString()) ||
    (targetStage === "SETTLED" && payload.settledAt !== command.occurredAt.toISOString())
  ) {
    throw closureSourceConflict();
  }
  if (targetStage === "SETTLED") {
    const terminalSource = physicalSource(
      command.closureCaseId,
      `${command.idempotencyKey}:closure`
    );
    const terminalReceipt = await tx.subscriptionClosureCommandReceipt.findUnique({
      select: { commandType: true },
      where: {
        sourceType_sourceId_sourceKey: {
          sourceId: terminalSource.id,
          sourceKey: terminalSource.key,
          sourceType: terminalSource.type
        }
      }
    });
    if (terminalReceipt?.commandType !== "TRANSITION_CASE") throw closureSourceConflict();
  }
  return deepFreezeReceipt(
    receipt.outcomeSnapshot
  ) as unknown as SubscriptionClosureSettlementSnapshot;
}

function settlementCaseIdentity(value: unknown) {
  if (!value || typeof value !== "object") return { missing: true };
  const candidate = value as Record<string, unknown>;
  return {
    contractId: candidate.contractId,
    currentSettlementRevisionId: candidate.currentSettlementRevisionId,
    customerId: candidate.customerId,
    id: candidate.id,
    orderId: candidate.orderId,
    status: candidate.status,
    vehicleId: candidate.vehicleId,
    version: candidate.version
  };
}

function settlementUuid(value: unknown) {
  if (typeof value !== "string") throw settlementBadRequest("SETTLEMENT_CLIENT_FACTS_FORBIDDEN");
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
  ) {
    throw settlementBadRequest("SETTLEMENT_CLIENT_FACTS_FORBIDDEN");
  }
  return normalized;
}

function nullableSettlementUuid(value: unknown): string | null {
  return value === null || value === undefined ? null : settlementUuid(value);
}

function validSettlementDate(value: unknown) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw settlementBadRequest("SETTLEMENT_CLIENT_FACTS_FORBIDDEN");
  }
  return new Date(value);
}

function settlementBadRequest(code: "SETTLEMENT_CLIENT_FACTS_FORBIDDEN") {
  return new BadRequestException({
    code: SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE[code],
    message: "Settlement totals, hashes, and snapshots are server-resolved facts."
  });
}

function isP0ManagedReturnMetadata(value: Prisma.JsonValue | null) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const marker = value.p0ReturnInbound;
  if (!marker || Array.isArray(marker) || typeof marker !== "object") return false;
  const markerSource = marker.source;
  return (
    markerSource !== null &&
    !Array.isArray(markerSource) &&
    typeof markerSource === "object" &&
    markerSource.type === "SUBSCRIPTION_EXPIRY"
  );
}

function normalizePrepareInput(input: PrepareNormalExpiryInput): PrepareNormalExpiryInput {
  return Object.freeze({
    decisionAt: validDate(input.decisionAt),
    orderId: canonicalUuid(input.orderId),
    segmentId: canonicalUuid(input.segmentId)
  });
}

function normalizeCompleteInput(input: CompleteNormalExpiryInput): CompleteNormalExpiryInput {
  return Object.freeze({
    ...normalizePrepareInput(input),
    vehicleReturnId: canonicalUuid(input.vehicleReturnId)
  });
}

function normalizeManagedReturnInput(input: PrepareManagedReturnInput): PrepareManagedReturnInput {
  const returnLocation = input.returnLocation?.trim() || null;
  if (returnLocation && returnLocation.length > 255) {
    throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
  }
  return Object.freeze({
    actorId: canonicalUuid(input.actorId),
    orderId: canonicalUuid(input.orderId),
    returnLocation,
    scheduledAt: input.scheduledAt === null ? null : validDate(input.scheduledAt)
  });
}

function normalizeCompleteManagedReturnInput(
  input: CompleteManagedReturnInput
): CompleteManagedReturnInput {
  return Object.freeze({
    ...normalizeManagedReturnInput(input),
    vehicleReturnId: canonicalUuid(input.vehicleReturnId)
  });
}

function canonicalUuid(value: string) {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return normalized;
}

function validDate(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return new Date(value);
}

function normalizeRecoveryJobInput(input: AssessRecoveryJobInput): AssessRecoveryJobInput {
  if (typeof input.jobKey !== "string" || input.jobKey.trim().length === 0) {
    throw serviceConflict("RECOVERY_JOB_AUTHORITY_INVALID");
  }
  return Object.freeze({
    actorId: canonicalUuid(input.actorId),
    closureCaseId: canonicalUuid(input.closureCaseId),
    governingBillId: canonicalUuid(input.governingBillId),
    governingDueDate: validDate(input.governingDueDate),
    jobId: canonicalUuid(input.jobId),
    jobKey: input.jobKey.trim(),
    orderId: canonicalUuid(input.orderId)
  });
}

function normalizeArchiveRecoveryAuthority(
  input: ArchiveRecoveryAuthorityInput
): ArchiveRecoveryAuthorityInput {
  const idempotencyKey = normalizeRecoveryTextInput(
    input.idempotencyKey,
    input.idempotencyKey
  ).idempotencyKey;
  return Object.freeze({
    actorId: canonicalUuid(input.actorId),
    closureCaseId: canonicalUuid(input.closureCaseId),
    idempotencyKey
  });
}

function normalizeArchiveEarlyTerminationAgreement(
  input: ArchiveEarlyTerminationAgreementInput
): ArchiveEarlyTerminationAgreementInput {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => key !== "actorId" && key !== "closureCaseId" && key !== "idempotencyKey"
    ) ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.trim().length > 120
  ) {
    throw serviceConflict("EARLY_TERMINATION_CLIENT_AUTHORITY_FORBIDDEN");
  }
  return Object.freeze({
    actorId: canonicalUuid(input.actorId),
    closureCaseId: canonicalUuid(input.closureCaseId),
    idempotencyKey: input.idempotencyKey.trim()
  });
}

function normalizeExecuteEarlyTermination(
  input: ExecuteEarlyTerminationInput
): ExecuteEarlyTerminationInput {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => key !== "actorId" && key !== "closureCaseId" && key !== "idempotencyKey"
    ) ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.trim().length > 120
  ) {
    throw serviceConflict("EARLY_TERMINATION_CLIENT_AUTHORITY_FORBIDDEN");
  }
  return Object.freeze({
    actorId: canonicalUuid(input.actorId),
    closureCaseId: canonicalUuid(input.closureCaseId),
    idempotencyKey: input.idempotencyKey.trim()
  });
}

function normalizeCancelEarlyTermination(
  input: CancelEarlyTerminationInput
): CancelEarlyTerminationInput {
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        key !== "actorId" && key !== "closureCaseId" && key !== "idempotencyKey" && key !== "reason"
    ) ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.trim().length > 120 ||
    !reason ||
    reason.length > 2_000
  ) {
    throw serviceConflict("EARLY_TERMINATION_CLIENT_AUTHORITY_FORBIDDEN");
  }
  return Object.freeze({
    actorId: canonicalUuid(input.actorId),
    closureCaseId: canonicalUuid(input.closureCaseId),
    idempotencyKey: input.idempotencyKey.trim(),
    reason
  });
}

function normalizeRecoveryBusinessAction(
  input: RecoveryBusinessActionInput
): RecoveryBusinessActionInput {
  if (
    !["REJECT", "PAUSE", "RESUME", "CANCEL", "MANUAL_TAKEOVER"].includes(input.action) ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.trim().length === 0 ||
    input.idempotencyKey.trim().length > 180 ||
    typeof input.reason !== "string" ||
    input.reason.trim().length === 0 ||
    input.reason.trim().length > 2000
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return Object.freeze({
    action: input.action,
    actorId: canonicalUuid(input.actorId),
    closureCaseId: canonicalUuid(input.closureCaseId),
    idempotencyKey: input.idempotencyKey.trim(),
    occurredAt: validDate(input.occurredAt),
    reason: input.reason.trim()
  });
}

function normalizeRequestRecoveryApproval(
  input: RequestRecoveryExecutionApprovalInput
): RequestRecoveryExecutionApprovalInput {
  const normalized = normalizeRecoveryTextInput(input.idempotencyKey, input.reason);
  return Object.freeze({
    actorId: canonicalUuid(input.actorId),
    closureCaseId: canonicalUuid(input.closureCaseId),
    idempotencyKey: normalized.idempotencyKey,
    reason: normalized.text,
    requestedAt: validDate(input.requestedAt)
  });
}

function normalizeDecideRecoveryApproval(
  input: DecideRecoveryExecutionApprovalInput
): DecideRecoveryExecutionApprovalInput {
  const normalized = normalizeRecoveryTextInput(input.idempotencyKey, input.decisionComment);
  if (
    !["APPROVED", "REJECTED"].includes(input.decision) ||
    !Number.isSafeInteger(input.expectedApprovalVersion) ||
    input.expectedApprovalVersion < 0
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return Object.freeze({
    actorId: canonicalUuid(input.actorId),
    approvalId: canonicalUuid(input.approvalId),
    closureCaseId: canonicalUuid(input.closureCaseId),
    decidedAt: validDate(input.decidedAt),
    decision: input.decision,
    decisionComment: normalized.text,
    expectedApprovalVersion: input.expectedApprovalVersion,
    idempotencyKey: normalized.idempotencyKey
  });
}

function normalizeExecuteRecovery(
  input: ExecuteApprovedRecoveryInput
): ExecuteApprovedRecoveryInput {
  const normalized = normalizeRecoveryTextInput(input.idempotencyKey, input.idempotencyKey);
  if (!Number.isSafeInteger(input.expectedApprovalVersion) || input.expectedApprovalVersion < 0) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return Object.freeze({
    actorId: canonicalUuid(input.actorId),
    approvalId: canonicalUuid(input.approvalId),
    closureCaseId: canonicalUuid(input.closureCaseId),
    expectedApprovalVersion: input.expectedApprovalVersion,
    idempotencyKey: normalized.idempotencyKey,
    occurredAt: validDate(input.occurredAt)
  });
}

function normalizeRecoveryExecutionRecord(
  input: RecordRecoveryExecutionInput
): RecordRecoveryExecutionInput {
  const normalized = normalizeRecoveryTextInput(input.idempotencyKey, input.idempotencyKey);
  if (
    !Array.isArray(input.evidence) ||
    input.evidence.length === 0 ||
    !Array.isArray(input.costs) ||
    input.evidence.some(({ action }) => action === "REMOVE") ||
    input.costs.some(({ actionType }) => actionType !== VehicleCostActionType.ACTUAL_COST)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return deepFreezeReceipt({
    actorId: canonicalUuid(input.actorId),
    closureCaseId: canonicalUuid(input.closureCaseId),
    costs: structuredClone(input.costs),
    evidence: structuredClone(input.evidence),
    idempotencyKey: normalized.idempotencyKey,
    occurredAt: validDate(input.occurredAt)
  });
}

function normalizeRecoveryTextInput(idempotencyKey: unknown, text: unknown) {
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length === 0 ||
    idempotencyKey.trim().length > 180 ||
    typeof text !== "string" ||
    text.trim().length === 0 ||
    text.trim().length > 2000
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return { idempotencyKey: idempotencyKey.trim(), text: text.trim() };
}

function recoveryApprovalSubject(closureCaseId: string) {
  return {
    subjectField: "recoveryExecution",
    subjectId: closureCaseId,
    subjectType: "RECOVERY_CASE" as const
  };
}

function recoveryApprovalCommandFingerprint(
  command: RequestRecoveryExecutionApprovalInput | DecideRecoveryExecutionApprovalInput
) {
  return createHash("sha256")
    .update(canonicalSubscriptionClosureJson(command as never))
    .digest("hex");
}

async function replayRecoveryApprovalOrchestration(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    accountingSource: SubscriptionClosureSource;
    commandFingerprint: string;
    eventSource: SubscriptionClosureSource;
    kind: "REQUEST" | "DECISION";
  }>
) {
  const [accountingReceipt, eventReceipt] = await Promise.all([
    tx.assetAccountingCommandReceipt.findUnique({
      where: {
        sourceType_sourceId_sourceKey: {
          sourceId: input.accountingSource.id,
          sourceKey: input.accountingSource.key,
          sourceType: input.accountingSource.type
        }
      }
    }),
    tx.subscriptionClosureCommandReceipt.findUnique({
      where: {
        sourceType_sourceId_sourceKey: {
          sourceId: input.eventSource.id,
          sourceKey: input.eventSource.key,
          sourceType: input.eventSource.type
        }
      }
    })
  ]);
  if (!accountingReceipt && !eventReceipt) return null;
  const payload = jsonObject(eventReceipt?.payloadSnapshot);
  const detail = jsonObject(payload.detailSnapshot);
  const storedEventSource = jsonObject(payload.source);
  const approvalId = detail.approvalId;
  const expectedAccountingCommand =
    input.kind === "REQUEST" ? "EXCEPTION_REQUEST" : "EXCEPTION_DECIDE";
  const expectedAction = input.kind === "REQUEST" ? "REQUEST_APPROVAL" : "DECIDE_APPROVAL";
  const expectedStatus =
    input.kind === "REQUEST"
      ? "RECOVERY_APPROVAL_PENDING"
      : payload.afterStatus === "RECOVERY_APPROVED"
        ? "RECOVERY_APPROVED"
        : payload.afterStatus === "REJECTED"
          ? "REJECTED"
          : null;
  if (
    !accountingReceipt ||
    !eventReceipt ||
    accountingReceipt.commandType !== expectedAccountingCommand ||
    accountingReceipt.approvalId !== approvalId ||
    accountingReceipt.actorId !== payload.actorId ||
    eventReceipt.commandType !== "TRANSITION_CASE" ||
    eventReceipt.actorId !== payload.actorId ||
    storedEventSource.type !== input.eventSource.type ||
    storedEventSource.id !== input.eventSource.id ||
    storedEventSource.key !== input.eventSource.key ||
    detail.recoveryAction !== expectedAction ||
    detail.recoveryApprovalCommandFingerprint !== input.commandFingerprint ||
    typeof approvalId !== "string" ||
    !expectedStatus
  ) {
    throw closureSourceConflict();
  }
  return Object.freeze({ approvalId, status: expectedStatus });
}

async function resolveRecoveryApprovalAuthority(
  tx: Prisma.TransactionClient,
  closureCaseId: string,
  clockBoundary?: Date
) {
  const now = clockBoundary ?? (await readDatabaseClock(tx));
  const [closureCase, assessment, currentDocument] = await Promise.all([
    tx.subscriptionClosureCase.findUnique({ where: { id: closureCaseId } }),
    tx.subscriptionClosureEvent.findFirst({
      orderBy: [{ sequence: "desc" }, { id: "desc" }],
      where: { closureCaseId, eventType: "RECOVERY_ESCALATED" }
    }),
    tx.subscriptionClosureCurrentDocument.findUnique({
      include: { documentRevision: true },
      where: {
        closureCaseId_documentType: {
          closureCaseId,
          documentType: "RECOVERY_AUTHORITY"
        }
      }
    })
  ]);
  const assessmentDetail = jsonObject(assessment?.detailSnapshot);
  const plannedWorkOrderId = assessmentDetail.plannedRecoveryAssetWorkOrderId;
  const revision = currentDocument?.documentRevision;
  const documentSnapshot = jsonObject(revision?.documentSnapshot);
  if (
    !closureCase ||
    closureCase.physicalControlMode !== "RECOVERY" ||
    closureCase.finalDisposition !== "TERMINATE" ||
    typeof plannedWorkOrderId !== "string" ||
    canonicalUuid(plannedWorkOrderId) !== plannedWorkOrderId ||
    !revision ||
    revision.documentType !== "RECOVERY_AUTHORITY" ||
    revision.stage !== "ARCHIVED" ||
    !revision.archivedAt ||
    documentSnapshot.closureCaseId !== closureCase.id ||
    documentSnapshot.orderId !== closureCase.orderId ||
    documentSnapshot.vehicleId !== closureCase.vehicleId ||
    documentSnapshot.recoveryAssetWorkOrderId !== plannedWorkOrderId ||
    documentSnapshot.recoveryWorkOrderType !== "RECOVERY"
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const productionChain = await validateCurrentRecoveryAuthorityChainInTransaction(
    tx,
    closureCase.id,
    revision
  );
  const recoveryContext = await resolveRecoveryContextSnapshot(
    tx,
    closureCase,
    assessmentDetail,
    now
  );
  const documentActorIds = [
    ...new Set([revision.generatedBy, revision.signedBy, revision.archivedBy])
  ].filter((id): id is string => Boolean(id));
  return Object.freeze({
    authority: Object.freeze({
      closureCaseId: closureCase.id,
      orderId: closureCase.orderId,
      recoveryAssetWorkOrderId: plannedWorkOrderId,
      recoveryAuthorityRevisionId: revision.id,
      recoveryAuthoritySnapshotHash: revision.documentSnapshotHash,
      recoveryContextSnapshotHash: recoveryContext.snapshotHash,
      vehicleId: closureCase.vehicleId
    }),
    closureCase,
    contextActionable: recoveryContext.actionable,
    contextLocks: recoveryContext.locks,
    documentLocks: Object.freeze([
      {
        id: closureCase.id,
        mode: "SHARE" as const,
        table: "subscription_closure_current_document" as const
      },
      ...[
        productionChain.ids.generatedRevisionId,
        productionChain.ids.signedRevisionId,
        productionChain.ids.archivedRevisionId
      ].map((id) => ({
        id,
        mode: "SHARE" as const,
        table: "subscription_closure_document_revision" as const
      })),
      { id: revision.sourceFileId, mode: "SHARE" as const, table: "file_object" as const },
      ...(revision.signedFileId
        ? [
            {
              id: revision.signedFileId,
              mode: "SHARE" as const,
              table: "file_object" as const
            }
          ]
        : []),
      {
        id: revision.contractESignTaskId,
        mode: "SHARE" as const,
        table: "contract_esign_task" as const
      },
      ...documentActorIds.map((id) => ({ id, mode: "SHARE" as const, table: "user" as const }))
    ] satisfies SubscriptionClosureAuthorityLock[])
  });
}

async function validateCurrentRecoveryAuthorityChainInTransaction(
  tx: Prisma.TransactionClient,
  closureCaseId: string,
  revision: Readonly<{
    archivedBy: string | null;
    id: string;
    sourceId: string;
    sourceKey: string;
    sourceType: string;
  }>
) {
  const prefix = "recovery-authority:";
  const suffix = ":archived";
  if (
    typeof revision.sourceType !== "string" ||
    typeof revision.sourceId !== "string" ||
    typeof revision.sourceKey !== "string"
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const productionSource = physicalSource(closureCaseId, revision.sourceKey);
  if (
    revision.sourceType !== productionSource.type ||
    revision.sourceId !== closureCaseId ||
    !revision.sourceKey.startsWith(prefix) ||
    !revision.sourceKey.endsWith(suffix) ||
    !revision.archivedBy
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const idempotencyKey = revision.sourceKey.slice(prefix.length, -suffix.length);
  if (!idempotencyKey) throw serviceConflict("AUTHORITY_MISMATCH");
  const command = normalizeArchiveRecoveryAuthority({
    actorId: revision.archivedBy,
    closureCaseId,
    idempotencyKey
  });
  const ids = recoveryAuthorityIds(closureCaseId, command.idempotencyKey);
  if (revision.id !== ids.archivedRevisionId) throw serviceConflict("AUTHORITY_MISMATCH");
  const sources = recoveryAuthoritySources(closureCaseId, command.idempotencyKey);
  const validated = await validateRecoveryAuthorityChainInTransaction(tx, command, ids, sources);
  if (!validated || validated.archivedRevisionId !== revision.id) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return Object.freeze({ ids });
}

async function resolveRecoveryContextSnapshot(
  tx: Prisma.TransactionClient,
  closureCase: Readonly<{
    id: string;
    orderId: string;
    vehicleId: string;
    vehicleReturnId: string | null;
  }>,
  assessmentDetail: Readonly<Record<string, unknown>>,
  clockBoundary: Date
) {
  const [bills, collectionCases, extension, legalRestrictions, vehicle, vehicleReturn] =
    await Promise.all([
      tx.receivableBill.findMany({
        orderBy: [{ dueDate: "asc" }, { id: "asc" }],
        select: {
          billStatus: true,
          dueDate: true,
          id: true,
          remainingAmount: true
        },
        where: {
          billStatus: {
            in: [BillStatus.PENDING, BillStatus.PARTIALLY_PAID, BillStatus.OVERDUE]
          },
          deletedAt: null,
          dueDate: { lt: clockBoundary },
          orderId: closureCase.orderId,
          remainingAmount: { gt: 0n }
        }
      }),
      tx.collectionCase.findMany({
        include: {
          actions: {
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: {
              actionResult: true,
              actionType: true,
              createdAt: true,
              id: true,
              promisedAmount: true,
              promisedPayAt: true
            },
            where: { deletedAt: null }
          }
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: { deletedAt: null, orderId: closureCase.orderId }
      }),
      tx.subscriptionContractSegment.findFirst({
        orderBy: [{ sequenceNo: "asc" }, { id: "asc" }],
        select: { endDate: true, id: true, startDate: true, status: true },
        where: { orderId: closureCase.orderId, status: { in: ["SCHEDULED", "ACTIVE"] } }
      }),
      tx.vehicleOperationalRestriction.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { conditionsSnapshot: true, id: true, restrictionType: true, status: true },
        where: {
          restrictionType: "LEGAL_HOLD",
          status: "ACTIVE",
          vehicleId: closureCase.vehicleId
        }
      }),
      tx.vehicle.findUnique({
        select: { id: true, status: true, vehicleNo: true },
        where: { id: closureCase.vehicleId }
      }),
      closureCase.vehicleReturnId
        ? tx.vehicleReturn.findUnique({
            select: { id: true, returnStatus: true, returnedAt: true },
            where: { id: closureCase.vehicleReturnId }
          })
        : Promise.resolve(null)
    ]);
  const liveDispute = collectionCases.some((item) => {
    if (item.caseStatus !== "ACTIVE") return false;
    const latestAction = item.actions.at(-1);
    return (
      latestAction?.actionType === "CUSTOMER_DISPUTE" || latestAction?.actionResult === "DISPUTED"
    );
  });
  const actionable = !(
    bills.length === 0 ||
    extension ||
    !vehicle ||
    !["LEASED", "RENTED"].includes(vehicle.status) ||
    vehicleReturn?.returnedAt ||
    vehicleReturn?.returnStatus === "CONFIRMED" ||
    liveDispute
  );
  const snapshot = {
    assessmentSnapshotHash: createHash("sha256")
      .update(canonicalSubscriptionClosureJson(assessmentDetail))
      .digest("hex"),
    bills,
    collectionCases: collectionCases.map((item) => ({
      actions: item.actions,
      caseStatus: item.caseStatus,
      id: item.id,
      totalOverdueAmount: item.totalOverdueAmount
    })),
    extension,
    legalRestrictions,
    vehicle,
    vehicleReturn
  };
  return Object.freeze({
    actionable,
    locks: Object.freeze([
      {
        id: closureCase.orderId,
        mode: "UPDATE" as const,
        table: "subscription_order" as const
      },
      ...bills.map(({ id }) => ({
        id,
        mode: "UPDATE" as const,
        table: "receivable_bill" as const
      })),
      ...collectionCases.map(({ id }) => ({
        id,
        mode: "UPDATE" as const,
        table: "collection_case" as const
      })),
      ...collectionCases.flatMap(({ actions }) =>
        actions.map(({ id }) => ({
          id,
          mode: "UPDATE" as const,
          table: "collection_action" as const
        }))
      ),
      {
        id: closureCase.vehicleId,
        mode: "UPDATE" as const,
        table: "vehicle" as const
      },
      ...(extension
        ? [
            {
              id: extension.id,
              mode: "UPDATE" as const,
              table: "subscription_contract_segment" as const
            }
          ]
        : []),
      ...(vehicleReturn
        ? [
            {
              id: vehicleReturn.id,
              mode: "UPDATE" as const,
              table: "vehicle_return" as const
            }
          ]
        : []),
      ...legalRestrictions.map(({ id }) => ({
        id,
        mode: "UPDATE" as const,
        table: "vehicle_operational_restriction" as const
      }))
    ] satisfies SubscriptionClosureAuthorityLock[]),
    snapshotHash: createHash("sha256")
      .update(canonicalSubscriptionClosureJson(snapshot))
      .digest("hex")
  });
}

function jsonObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function recoveryAssessmentNoOpReason(value: unknown): RecoveryAssessmentNoOpReason | null {
  return typeof value === "string" &&
    (RECOVERY_ASSESSMENT_NO_OP_REASONS as readonly string[]).includes(value)
    ? (value as RecoveryAssessmentNoOpReason)
    : null;
}

function stableRecoveryWorkOrderId(jobId: string): string {
  const hex = createHash("sha256").update(`recovery-work-order\u0000${jobId}`).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sameAuthority(left: NormalExpiryAuthority, right: NormalExpiryAuthority) {
  return canonicalSubscriptionClosureJson(left) === canonicalSubscriptionClosureJson(right);
}

type NormalizedEarlyTerminationInitiation = Readonly<{
  actorId: string;
  effectiveAt: Date;
  evidence: readonly Readonly<{ reference: string; type: string }>[];
  idempotencyKey: string;
  orderId: string;
  reason: string;
}>;

async function resolveEarlyTerminationInitiationAuthority(
  tx: Prisma.TransactionClient,
  command: NormalizedEarlyTerminationInitiation,
  databaseClock: Date
) {
  const [actor, order, lease, segments, vehicleReturn] = await Promise.all([
    tx.user.findFirst({
      select: { id: true, status: true },
      where: { deletedAt: null, id: command.actorId, status: UserStatus.ACTIVE }
    }),
    tx.subscriptionOrder.findUnique({
      select: {
        contractId: true,
        customerId: true,
        deletedAt: true,
        id: true,
        orderNo: true,
        orderStatus: true,
        vehicleId: true
      },
      where: { id: command.orderId }
    }),
    tx.lease.findUnique({
      select: { id: true, orderId: true, status: true },
      where: { orderId: command.orderId }
    }),
    tx.subscriptionContractSegment.findMany({
      orderBy: [{ sequenceNo: "asc" }, { id: "asc" }],
      select: {
        endDate: true,
        id: true,
        orderId: true,
        sequenceNo: true,
        startDate: true,
        status: true
      },
      where: { orderId: command.orderId, status: "ACTIVE" }
    }),
    tx.vehicleReturn.findUnique({ select: { id: true }, where: { orderId: command.orderId } })
  ]);
  const segment = segments[0];
  const [contract, vehicle] = await Promise.all([
    order?.contractId
      ? tx.contract.findUnique({
          select: { customerId: true, id: true, orderId: true, status: true },
          where: { id: order.contractId }
        })
      : null,
    order?.vehicleId
      ? tx.vehicle.findUnique({
          select: { deletedAt: true, id: true, status: true },
          where: { id: order.vehicleId }
        })
      : null
  ]);
  if (
    !actor ||
    !order ||
    order.deletedAt ||
    order.orderStatus !== OrderStatus.ACTIVE ||
    !order.contractId ||
    !order.vehicleId ||
    !contract ||
    contract.orderId !== order.id ||
    contract.customerId !== order.customerId ||
    (contract.status !== ContractStatus.SIGNED && contract.status !== ContractStatus.ARCHIVED) ||
    !lease ||
    lease.orderId !== order.id ||
    lease.status !== LeaseStatus.ACTIVE ||
    segments.length !== 1 ||
    !segment ||
    segment.orderId !== order.id ||
    !vehicle ||
    vehicle.deletedAt ||
    vehicle.id !== order.vehicleId ||
    vehicle.status !== VehicleStatus.LEASED ||
    vehicleReturn
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const segmentBoundaryExclusive = new Date(segment.endDate.getTime() + 86_400_000);
  if (
    command.effectiveAt.getTime() < databaseClock.getTime() ||
    command.effectiveAt.getTime() >= segmentBoundaryExclusive.getTime()
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return Object.freeze({ actor, contract, lease, order, segment, vehicle });
}

type EarlyTerminationInitiationAuthority = Awaited<
  ReturnType<typeof resolveEarlyTerminationInitiationAuthority>
>;

function earlyTerminationAgreementIntent(command: NormalizedEarlyTerminationInitiation) {
  return Object.freeze({
    effectiveAt: command.effectiveAt,
    evidence: command.evidence,
    reason: command.reason,
    requestedBy: command.actorId
  });
}

function earlyTerminationAuthoritySnapshot(
  command: NormalizedEarlyTerminationInitiation,
  authority: EarlyTerminationInitiationAuthority
) {
  return Object.freeze({
    agreement: earlyTerminationAgreementIntent(command),
    contract: {
      customerId: authority.contract.customerId,
      id: authority.contract.id,
      orderId: authority.contract.orderId,
      status: authority.contract.status
    },
    lease: {
      id: authority.lease.id,
      orderId: authority.lease.orderId,
      status: authority.lease.status
    },
    order: {
      contractId: authority.order.contractId,
      customerId: authority.order.customerId,
      id: authority.order.id,
      orderNo: authority.order.orderNo,
      status: authority.order.orderStatus,
      vehicleId: authority.order.vehicleId
    },
    segment: {
      endDate: authority.segment.endDate,
      id: authority.segment.id,
      orderId: authority.segment.orderId,
      sequenceNo: authority.segment.sequenceNo,
      startDate: authority.segment.startDate,
      status: authority.segment.status
    },
    vehicle: { id: authority.vehicle.id, status: authority.vehicle.status }
  });
}

function earlyTerminationAuthorityIdentity(authority: EarlyTerminationInitiationAuthority) {
  return canonicalSubscriptionClosureJson({
    actor: authority.actor,
    contract: authority.contract,
    lease: authority.lease,
    order: authority.order,
    segment: authority.segment,
    vehicle: authority.vehicle
  });
}

function earlyTerminationCaseCommand(
  command: NormalizedEarlyTerminationInitiation,
  authority: EarlyTerminationInitiationAuthority,
  initiationSource: SubscriptionClosureSource
) {
  return Object.freeze({
    actorId: command.actorId,
    authoritySnapshot: earlyTerminationAuthoritySnapshot(command, authority),
    closureType: "EARLY_TERMINATION" as const,
    contractId: authority.contract.id,
    customerId: authority.order.customerId,
    effectiveAt: command.effectiveAt,
    finalDisposition: "TERMINATE" as const,
    orderId: authority.order.id,
    physicalControlMode: "VOLUNTARY_RETURN" as const,
    source: initiationSource,
    vehicleId: authority.vehicle.id
  });
}

function earlyTerminationReplayCaseCommand(
  existing: Readonly<{
    authoritySnapshot: Prisma.JsonValue;
    contractId: string;
    createdBy: string;
    customerId: string;
    effectiveAt: Date;
    orderId: string;
    reconditioningAssetWorkOrderId: string | null;
    recoveryAssetWorkOrderId: string | null;
    returnAssetWorkOrderId: string | null;
    returnHandoverWorkOrderId: string | null;
    vehicleId: string;
    vehicleReturnId: string | null;
  }>,
  initiationSource: SubscriptionClosureSource
) {
  return Object.freeze({
    actorId: existing.createdBy,
    authoritySnapshot: existing.authoritySnapshot as never,
    closureType: "EARLY_TERMINATION" as const,
    contractId: existing.contractId,
    customerId: existing.customerId,
    effectiveAt: existing.effectiveAt,
    finalDisposition: "TERMINATE" as const,
    orderId: existing.orderId,
    physicalControlMode: "VOLUNTARY_RETURN" as const,
    reconditioningAssetWorkOrderId: null,
    recoveryAssetWorkOrderId: null,
    returnAssetWorkOrderId: null,
    returnHandoverWorkOrderId: null,
    source: initiationSource,
    vehicleId: existing.vehicleId,
    vehicleReturnId: null
  });
}

function earlyTerminationSource(orderId: string, key: string): SubscriptionClosureSource {
  return Object.freeze({ id: orderId, key, type: "SUBSCRIPTION_EARLY_TERMINATION" });
}

function stableEarlyTerminationId(value: string): string {
  const hex = createHash("sha256").update(`early-termination\u0000${value}`).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type EarlyTerminationAgreementIds = Readonly<{
  archivedRevisionId: string;
  esignEnvelopeId: string;
  esignProviderTaskId: string;
  esignTaskId: string;
  generatedRevisionId: string;
  signedFileId: string;
  signedRevisionId: string;
  sourceFileId: string;
}>;

type EarlyTerminationAgreementSources = readonly [
  SubscriptionClosureSource,
  SubscriptionClosureSource,
  SubscriptionClosureSource
];

function earlyTerminationAgreementIds(
  closureCaseId: string,
  idempotencyKey: string
): EarlyTerminationAgreementIds {
  const id = (label: string) =>
    stableEarlyTerminationId(
      `${closureCaseId}\u0000${idempotencyKey}\u0000agreement\u0000${label}`
    );
  return Object.freeze({
    archivedRevisionId: id("revision-archived"),
    esignEnvelopeId: id("esign-envelope"),
    esignProviderTaskId: id("esign-provider-task"),
    esignTaskId: id("esign-task"),
    generatedRevisionId: id("revision-generated"),
    signedFileId: id("file-signed"),
    signedRevisionId: id("revision-signed"),
    sourceFileId: id("file-source")
  });
}

function earlyTerminationAgreementSources(
  closureCaseId: string,
  idempotencyKey: string
): EarlyTerminationAgreementSources {
  return Object.freeze([
    earlyTerminationSource(
      closureCaseId,
      `early-termination-agreement:${idempotencyKey}:generated`
    ),
    earlyTerminationSource(closureCaseId, `early-termination-agreement:${idempotencyKey}:signed`),
    earlyTerminationSource(closureCaseId, `early-termination-agreement:${idempotencyKey}:archived`)
  ]) as EarlyTerminationAgreementSources;
}

async function resolveEarlyTerminationAgreementDraft(
  tx: Prisma.TransactionClient,
  closureCaseId: string
) {
  const closureCase = await tx.subscriptionClosureCase.findUnique({ where: { id: closureCaseId } });
  if (!closureCase) throw serviceConflict("AUTHORITY_NOT_FOUND");
  const [order, contract, lease, segments, vehicle, currentDocument] = await Promise.all([
    tx.subscriptionOrder.findUnique({
      select: {
        contractId: true,
        customerId: true,
        deletedAt: true,
        id: true,
        orderNo: true,
        orderStatus: true,
        vehicleId: true
      },
      where: { id: closureCase.orderId }
    }),
    tx.contract.findUnique({
      select: { customerId: true, id: true, orderId: true, status: true },
      where: { id: closureCase.contractId }
    }),
    tx.lease.findUnique({
      select: { id: true, orderId: true, status: true },
      where: { orderId: closureCase.orderId }
    }),
    tx.subscriptionContractSegment.findMany({
      orderBy: [{ sequenceNo: "asc" }, { id: "asc" }],
      select: {
        endDate: true,
        id: true,
        orderId: true,
        sequenceNo: true,
        startDate: true,
        status: true
      },
      where: { orderId: closureCase.orderId }
    }),
    tx.vehicle.findUnique({
      select: { deletedAt: true, id: true, status: true },
      where: { id: closureCase.vehicleId }
    }),
    tx.subscriptionClosureCurrentDocument.findUnique({
      where: {
        closureCaseId_documentType: {
          closureCaseId,
          documentType: "EARLY_TERMINATION_AGREEMENT"
        }
      }
    })
  ]);
  const authority = jsonObject(closureCase.authoritySnapshot);
  const initiatedSegment = jsonObject(authority.segment);
  const segment = segments.find(({ id }) => id === initiatedSegment.id);
  const executed = Boolean(
    closureCase.vehicleReturnId &&
    closureCase.returnAssetWorkOrderId &&
    closureCase.returnHandoverWorkOrderId
  );
  const activeShape =
    !executed &&
    order?.orderStatus === OrderStatus.ACTIVE &&
    lease?.status === LeaseStatus.ACTIVE &&
    segment?.status === ContractSegmentStatus.ACTIVE;
  const executedShape =
    executed &&
    order?.orderStatus === OrderStatus.PENDING_RETURN &&
    lease?.status === LeaseStatus.RETURN_DUE &&
    segment?.status === ContractSegmentStatus.COMPLETED;
  if (
    !order ||
    order.deletedAt ||
    (!activeShape && !executedShape) ||
    order.id !== closureCase.orderId ||
    order.contractId !== closureCase.contractId ||
    order.customerId !== closureCase.customerId ||
    order.vehicleId !== closureCase.vehicleId ||
    !contract ||
    contract.orderId !== order.id ||
    contract.customerId !== order.customerId ||
    (contract.status !== ContractStatus.SIGNED && contract.status !== ContractStatus.ARCHIVED) ||
    !lease ||
    lease.orderId !== order.id ||
    !segment ||
    !vehicle ||
    vehicle.deletedAt ||
    vehicle.status !== VehicleStatus.LEASED
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const initiatedFacts: SubscriptionClosureSnapshotObject = {
    contract: authority.contract as Prisma.JsonValue,
    lease: authority.lease as Prisma.JsonValue,
    order: authority.order as Prisma.JsonValue,
    segment: authority.segment as Prisma.JsonValue,
    vehicle: authority.vehicle as Prisma.JsonValue
  };
  const currentFacts = executed
    ? Object.freeze(initiatedFacts)
    : earlyTerminationCurrentFacts({ contract, lease, order, segment, vehicle });
  if (!sameCanonicalReceiptValue(currentFacts, initiatedFacts)) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return Object.freeze({
    closureCase,
    contract,
    currentDocumentId: currentDocument?.documentRevisionId ?? null,
    currentFacts,
    lease,
    order,
    segment,
    vehicle
  });
}

type EarlyTerminationAgreementDraft = Awaited<
  ReturnType<typeof resolveEarlyTerminationAgreementDraft>
>;

function earlyTerminationCurrentFacts(
  authority: Readonly<{
    contract: Readonly<{ customerId: string; id: string; orderId: string; status: string }>;
    lease: Readonly<{ id: string; orderId: string; status: string }>;
    order: Readonly<{
      contractId: string | null;
      customerId: string;
      id: string;
      orderNo: string;
      orderStatus: string;
      vehicleId: string | null;
    }>;
    segment: Readonly<{
      endDate: Date;
      id: string;
      orderId: string;
      sequenceNo: number;
      startDate: Date;
      status: string;
    }>;
    vehicle: Readonly<{ id: string; status: string }>;
  }>
) {
  return Object.freeze({
    contract: { ...authority.contract },
    lease: { ...authority.lease },
    order: {
      contractId: authority.order.contractId,
      customerId: authority.order.customerId,
      id: authority.order.id,
      orderNo: authority.order.orderNo,
      status: authority.order.orderStatus,
      vehicleId: authority.order.vehicleId
    },
    segment: { ...authority.segment },
    vehicle: { id: authority.vehicle.id, status: authority.vehicle.status }
  });
}

function assertEarlyTerminationAgreementDraftActionable(draft: EarlyTerminationAgreementDraft) {
  if (
    draft.closureCase.closureType !== "EARLY_TERMINATION" ||
    draft.closureCase.physicalControlMode !== "VOLUNTARY_RETURN" ||
    draft.closureCase.finalDisposition !== "TERMINATE" ||
    draft.closureCase.status !== "PREPARING_RETURN" ||
    draft.closureCase.vehicleReturnId !== null ||
    draft.closureCase.returnAssetWorkOrderId !== null ||
    draft.closureCase.returnHandoverWorkOrderId !== null ||
    draft.currentDocumentId !== null
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
}

function earlyTerminationAgreementDraftIdentity(draft: EarlyTerminationAgreementDraft) {
  return canonicalSubscriptionClosureJson({
    closureCase: draft.closureCase,
    contract: draft.contract,
    currentDocumentId: draft.currentDocumentId,
    currentFacts: draft.currentFacts,
    lease: draft.lease,
    order: draft.order,
    segment: draft.segment,
    vehicle: draft.vehicle
  });
}

function earlyTerminationAgreementDocumentSnapshot(draft: EarlyTerminationAgreementDraft) {
  return earlyTerminationAgreementDocumentSnapshotFromAuthority(draft.closureCase);
}

function earlyTerminationAgreementDocumentSnapshotFromAuthority(
  closureCase: Readonly<{
    authoritySnapshot: Prisma.JsonValue;
    authoritySnapshotHash: string;
    caseNo: string;
    contractId: string;
    customerId: string;
    effectiveAt: Date;
    id: string;
    orderId: string;
    vehicleId: string;
  }>
) {
  const authority = jsonObject(closureCase.authoritySnapshot);
  const currentFacts = Object.freeze({
    contract: authority.contract as Prisma.JsonValue,
    lease: authority.lease as Prisma.JsonValue,
    order: authority.order as Prisma.JsonValue,
    segment: authority.segment as Prisma.JsonValue,
    vehicle: authority.vehicle as Prisma.JsonValue
  });
  return Object.freeze({
    agreement: authority.agreement as Prisma.JsonValue,
    authoritySnapshotHash: closureCase.authoritySnapshotHash,
    caseNo: closureCase.caseNo,
    closureCaseId: closureCase.id,
    contractId: closureCase.contractId,
    currentFacts,
    currentFactsSnapshotHash: hashSubscriptionClosureSnapshot(currentFacts),
    customerId: closureCase.customerId,
    documentType: "EARLY_TERMINATION_AGREEMENT",
    effectiveAt: closureCase.effectiveAt,
    finalDisposition: "TERMINATE",
    orderId: closureCase.orderId,
    physicalControlMode: "VOLUNTARY_RETURN",
    vehicleId: closureCase.vehicleId
  } as const);
}

function earlyTerminationAgreementDocumentCommands(
  input: Readonly<{
    actorId: string;
    closureCaseId: string;
    databaseClock: Date;
    documentSnapshot: ReturnType<typeof earlyTerminationAgreementDocumentSnapshot>;
    expectedVersion: number;
    ids: EarlyTerminationAgreementIds;
    signedFileHash: string;
    sourceFileHash: string;
    sources: EarlyTerminationAgreementSources;
  }>
) {
  const common = {
    actorId: input.actorId,
    closureCaseId: input.closureCaseId,
    contractESignTaskId: input.ids.esignTaskId,
    documentSnapshot: input.documentSnapshot,
    documentType: "EARLY_TERMINATION_AGREEMENT" as const,
    generatedAt: input.databaseClock,
    handoverWorkOrderId: null,
    sourceFileHash: input.sourceFileHash,
    sourceFileId: input.ids.sourceFileId,
    vehicleReturnId: null
  };
  return Object.freeze({
    archived: Object.freeze({
      ...common,
      archivedAt: input.databaseClock,
      archivedBy: input.actorId,
      documentRevisionId: input.ids.archivedRevisionId,
      expectedCurrentRevisionId: input.ids.signedRevisionId,
      expectedVersion: input.expectedVersion + 2,
      signedAt: input.databaseClock,
      signedBy: input.actorId,
      signedFileHash: input.signedFileHash,
      signedFileId: input.ids.signedFileId,
      source: input.sources[2],
      stage: "ARCHIVED" as const
    }),
    generated: Object.freeze({
      ...common,
      archivedAt: null,
      archivedBy: null,
      documentRevisionId: input.ids.generatedRevisionId,
      expectedCurrentRevisionId: null,
      expectedVersion: input.expectedVersion,
      signedAt: null,
      signedBy: null,
      signedFileHash: null,
      signedFileId: null,
      source: input.sources[0],
      stage: "GENERATED" as const
    }),
    signed: Object.freeze({
      ...common,
      archivedAt: null,
      archivedBy: null,
      documentRevisionId: input.ids.signedRevisionId,
      expectedCurrentRevisionId: input.ids.generatedRevisionId,
      expectedVersion: input.expectedVersion + 1,
      signedAt: input.databaseClock,
      signedBy: input.actorId,
      signedFileHash: input.signedFileHash,
      signedFileId: input.ids.signedFileId,
      source: input.sources[1],
      stage: "SIGNED" as const
    })
  });
}

function earlyTerminationAgreementSignedEnvelope(
  input: Readonly<{
    actorId: string;
    completedAt: Date;
    documentSnapshotHash: string;
    signedFileId: string;
    sourceFileHash: string;
    sourceFileId: string;
    sources: EarlyTerminationAgreementSources;
  }>
) {
  return Object.freeze({
    completedAt: input.completedAt,
    documentSnapshotHash: input.documentSnapshotHash,
    documentType: "EARLY_TERMINATION_AGREEMENT",
    lifecycleSources: input.sources,
    signedBy: input.actorId,
    signedFileId: input.signedFileId,
    sourceFileHash: input.sourceFileHash,
    sourceFileId: input.sourceFileId
  });
}

function earlyTerminationAgreementEsignRequest(
  input: Readonly<{
    documentSnapshotHash: string;
    ids: EarlyTerminationAgreementIds;
    sourceFileHash: string;
    sources: EarlyTerminationAgreementSources;
  }>
) {
  return Object.freeze({
    archivedRevisionId: input.ids.archivedRevisionId,
    documentSnapshotHash: input.documentSnapshotHash,
    documentType: "EARLY_TERMINATION_AGREEMENT",
    generatedRevisionId: input.ids.generatedRevisionId,
    lifecycleSources: input.sources,
    signedRevisionId: input.ids.signedRevisionId,
    sourceFileHash: input.sourceFileHash,
    sourceFileId: input.ids.sourceFileId
  });
}

function earlyTerminationAgreementEsignResponse(
  input: Readonly<{
    actorId: string;
    completedAt: Date;
    ids: EarlyTerminationAgreementIds;
    signedFileHash: string;
  }>
) {
  return Object.freeze({
    completedAt: input.completedAt,
    completedBy: input.actorId,
    providerEnvelopeId: input.ids.esignEnvelopeId,
    providerTaskId: input.ids.esignProviderTaskId,
    signedFileHash: input.signedFileHash,
    signedFileId: input.ids.signedFileId
  });
}

function earlyTerminationAgreementReplayLocks(
  command: ArchiveEarlyTerminationAgreementInput,
  ids: EarlyTerminationAgreementIds
): readonly SubscriptionClosureAuthorityLock[] {
  return Object.freeze([
    { id: command.closureCaseId, mode: "UPDATE", table: "subscription_closure_case" },
    {
      id: command.closureCaseId,
      mode: "SHARE",
      table: "subscription_closure_current_document"
    },
    ...[ids.generatedRevisionId, ids.signedRevisionId, ids.archivedRevisionId].map((id) => ({
      id,
      mode: "SHARE" as const,
      table: "subscription_closure_document_revision" as const
    })),
    { id: ids.sourceFileId, mode: "SHARE", table: "file_object" },
    { id: ids.signedFileId, mode: "SHARE", table: "file_object" },
    { id: ids.esignTaskId, mode: "SHARE", table: "contract_esign_task" },
    { id: command.actorId, mode: "SHARE", table: "user" }
  ]);
}

function earlyTerminationAgreementSourceObjectKey(closureCaseId: string, revisionId: string) {
  return `subscription-closure/${closureCaseId}/${revisionId}-early-termination-agreement.json`;
}

function earlyTerminationAgreementSignedObjectKey(closureCaseId: string, revisionId: string) {
  return `subscription-closure/${closureCaseId}/${revisionId}-early-termination-agreement.signed.json`;
}

function assertEarlyTerminationExecutionCase(
  closureCase: EarlyTerminationAgreementDraft["closureCase"]
) {
  if (
    closureCase.closureType !== "EARLY_TERMINATION" ||
    closureCase.physicalControlMode !== "VOLUNTARY_RETURN" ||
    closureCase.finalDisposition !== "TERMINATE" ||
    closureCase.status !== "PREPARING_RETURN" ||
    closureCase.vehicleReturnId !== null ||
    closureCase.returnAssetWorkOrderId !== null ||
    closureCase.returnHandoverWorkOrderId !== null
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
}

async function currentEarlyTerminationAgreementCommand(
  tx: Prisma.TransactionClient,
  draft: EarlyTerminationAgreementDraft
): Promise<ArchiveEarlyTerminationAgreementInput> {
  const current = await tx.subscriptionClosureDocumentRevision.findUnique({
    where: { id: draft.currentDocumentId ?? "00000000-0000-4000-8000-000000000000" }
  });
  const prefix = "early-termination-agreement:";
  const suffix = ":archived";
  if (
    !current ||
    current.documentType !== "EARLY_TERMINATION_AGREEMENT" ||
    current.stage !== "ARCHIVED" ||
    !current.sourceKey.startsWith(prefix) ||
    !current.sourceKey.endsWith(suffix)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const idempotencyKey = current.sourceKey.slice(prefix.length, -suffix.length);
  if (!idempotencyKey) throw serviceConflict("AUTHORITY_MISMATCH");
  return Object.freeze({
    actorId: current.generatedBy,
    closureCaseId: draft.closureCase.id,
    idempotencyKey
  });
}

function earlyTerminationReturnAuthority(
  draft: EarlyTerminationAgreementDraft,
  actorId: string
): NormalExpiryAuthority {
  return Object.freeze({
    actorId,
    contractId: draft.contract.id,
    customerId: draft.closureCase.customerId,
    leaseId: draft.lease.id,
    orderId: draft.order.id,
    orderNo: draft.order.orderNo,
    segmentEndDate: new Date(draft.segment.endDate),
    segmentId: draft.segment.id,
    vehicleId: draft.vehicle.id
  });
}

function earlyTerminationAssetCommand(
  authority: NormalExpiryAuthority,
  assetSource: SubscriptionClosureSource,
  occurredAt: Date,
  vehicleReturnId: string
) {
  return {
    assetOwnerId: null,
    contractId: authority.contractId,
    costConfirmationRequired: false,
    customerId: authority.customerId,
    description: `Early-termination return inbound for ${authority.orderNo}`,
    metadata: {
      closureIntent: "EARLY_TERMINATION",
      segmentId: authority.segmentId,
      vehicleReturnId
    },
    occurredAt,
    orderId: authority.orderId,
    priority: "NORMAL" as const,
    relatedWorkOrderId: null,
    source: assetSource,
    vehicleId: authority.vehicleId,
    workOrderType: "RETURN_INBOUND" as const
  };
}

async function earlyTerminationAgreementAuthorityLocks(
  tx: Prisma.TransactionClient,
  closureCaseId: string,
  ids: EarlyTerminationAgreementIds
): Promise<readonly SubscriptionClosureAuthorityLock[]> {
  const revisions = await tx.subscriptionClosureDocumentRevision.findMany({
    select: { archivedBy: true, generatedBy: true, signedBy: true },
    where: {
      id: { in: [ids.generatedRevisionId, ids.signedRevisionId, ids.archivedRevisionId] }
    }
  });
  const actors = new Set(
    revisions
      .flatMap(({ archivedBy, generatedBy, signedBy }) => [archivedBy, generatedBy, signedBy])
      .filter((value): value is string => Boolean(value))
  );
  return Object.freeze([
    {
      id: closureCaseId,
      mode: "SHARE",
      table: "subscription_closure_current_document"
    },
    ...[ids.generatedRevisionId, ids.signedRevisionId, ids.archivedRevisionId].map((id) => ({
      id,
      mode: "SHARE" as const,
      table: "subscription_closure_document_revision" as const
    })),
    { id: ids.sourceFileId, mode: "SHARE", table: "file_object" },
    { id: ids.signedFileId, mode: "SHARE", table: "file_object" },
    { id: ids.esignTaskId, mode: "SHARE", table: "contract_esign_task" },
    ...[...actors].map((id) => ({ id, mode: "SHARE" as const, table: "user" as const }))
  ]);
}

async function earlyTerminationAgreementHasCurrentFactDrift(
  tx: Prisma.TransactionClient,
  closureCase: Readonly<{
    authoritySnapshot: Prisma.JsonValue;
    contractId: string;
    customerId: string;
    orderId: string;
    vehicleId: string;
  }>
) {
  const authority = jsonObject(closureCase.authoritySnapshot);
  const initiatedSegment = jsonObject(authority.segment);
  const segmentId = typeof initiatedSegment.id === "string" ? initiatedSegment.id : "";
  const [order, contract, lease, segment, vehicle] = await Promise.all([
    tx.subscriptionOrder.findUnique({
      select: {
        contractId: true,
        customerId: true,
        id: true,
        orderNo: true,
        orderStatus: true,
        vehicleId: true
      },
      where: { id: closureCase.orderId }
    }),
    tx.contract.findUnique({
      select: { customerId: true, id: true, orderId: true, status: true },
      where: { id: closureCase.contractId }
    }),
    tx.lease.findUnique({
      select: { id: true, orderId: true, status: true },
      where: { orderId: closureCase.orderId }
    }),
    segmentId
      ? tx.subscriptionContractSegment.findUnique({
          select: {
            endDate: true,
            id: true,
            orderId: true,
            sequenceNo: true,
            startDate: true,
            status: true
          },
          where: { id: segmentId }
        })
      : null,
    tx.vehicle.findUnique({
      select: { id: true, status: true },
      where: { id: closureCase.vehicleId }
    })
  ]);
  if (!order || !contract || !lease || !segment || !vehicle) return true;
  const currentFacts = earlyTerminationCurrentFacts({ contract, lease, order, segment, vehicle });
  return !sameCanonicalReceiptValue(currentFacts, {
    contract: authority.contract,
    lease: authority.lease,
    order: authority.order,
    segment: authority.segment,
    vehicle: authority.vehicle
  });
}

async function resolveStaleEarlyTerminationAgreementAuthority(
  tx: Prisma.TransactionClient,
  closureCase: Readonly<{
    authoritySnapshot: Prisma.JsonValue;
    authoritySnapshotHash: string;
    caseNo: string;
    contractId: string;
    customerId: string;
    id: string;
    orderId: string;
    vehicleId: string;
  }>
) {
  const current = await tx.subscriptionClosureCurrentDocument.findUnique({
    include: { documentRevision: true },
    where: {
      closureCaseId_documentType: {
        closureCaseId: closureCase.id,
        documentType: "EARLY_TERMINATION_AGREEMENT"
      }
    }
  });
  const archived = current?.documentRevision;
  const prefix = "early-termination-agreement:";
  const suffix = ":archived";
  if (
    !archived ||
    archived.stage !== "ARCHIVED" ||
    !archived.sourceKey.startsWith(prefix) ||
    !archived.sourceKey.endsWith(suffix)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const idempotencyKey = archived.sourceKey.slice(prefix.length, -suffix.length);
  const ids = earlyTerminationAgreementIds(closureCase.id, idempotencyKey);
  const sources = earlyTerminationAgreementSources(closureCase.id, idempotencyKey);
  const [revisions, sourceFile, signedFile, esignTask, lease, receipts, events] = await Promise.all(
    [
      tx.subscriptionClosureDocumentRevision.findMany({
        orderBy: { revisionNumber: "asc" },
        where: {
          closureCaseId: closureCase.id,
          documentType: "EARLY_TERMINATION_AGREEMENT"
        }
      }),
      tx.fileObject.findUnique({ where: { id: ids.sourceFileId } }),
      tx.fileObject.findUnique({ where: { id: ids.signedFileId } }),
      tx.contractESignTask.findUnique({ where: { id: ids.esignTaskId } }),
      tx.lease.findUnique({ select: { id: true }, where: { orderId: closureCase.orderId } }),
      tx.subscriptionClosureCommandReceipt.findMany({
        where: {
          closureCaseId: closureCase.id,
          commandType: "CREATE_DOCUMENT_REVISION",
          payloadSnapshot: { equals: "EARLY_TERMINATION_AGREEMENT", path: ["documentType"] }
        }
      }),
      tx.subscriptionClosureEvent.findMany({
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
        where: {
          closureCaseId: closureCase.id,
          detailSnapshot: { equals: "EARLY_TERMINATION_AGREEMENT", path: ["documentType"] },
          eventType: "DOCUMENT_REVISION_CREATED"
        }
      })
    ]
  );
  const generated = revisions.find(({ id }) => id === ids.generatedRevisionId);
  const signed = revisions.find(({ id }) => id === ids.signedRevisionId);
  const authority = jsonObject(closureCase.authoritySnapshot);
  const segmentId = jsonObject(authority.segment).id;
  if (
    revisions.length !== 3 ||
    !generated ||
    !signed ||
    archived.id !== ids.archivedRevisionId ||
    !signed.signedAt ||
    !sourceFile ||
    !signedFile ||
    !esignTask ||
    !lease ||
    typeof segmentId !== "string"
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const canonicalDocument = canonicalSubscriptionClosureJson(generated.documentSnapshot as never);
  const documentHash = createHash("sha256").update(canonicalDocument).digest("hex");
  const signedEnvelope = earlyTerminationAgreementSignedEnvelope({
    actorId: generated.generatedBy,
    completedAt: signed.signedAt,
    documentSnapshotHash: documentHash,
    signedFileId: ids.signedFileId,
    sourceFileHash: documentHash,
    sourceFileId: ids.sourceFileId,
    sources
  });
  const canonicalSignedEnvelope = canonicalSubscriptionClosureJson(signedEnvelope);
  const signedFileHash = createHash("sha256").update(canonicalSignedEnvelope).digest("hex");
  const documentAuthority = jsonObject(generated.documentSnapshot);
  const sourceObjectKey = earlyTerminationAgreementSourceObjectKey(
    closureCase.id,
    ids.generatedRevisionId
  );
  const signedObjectKey = earlyTerminationAgreementSignedObjectKey(
    closureCase.id,
    ids.signedRevisionId
  );
  const sourceDocumentName = `${closureCase.caseNo}-${ids.generatedRevisionId}-early-termination-agreement.json`;
  const signedDocumentName = `${closureCase.caseNo}-${ids.signedRevisionId}-early-termination-agreement.signed.json`;
  const expectedRequest = earlyTerminationAgreementEsignRequest({
    documentSnapshotHash: documentHash,
    ids,
    sourceFileHash: documentHash,
    sources
  });
  const expectedResponse = earlyTerminationAgreementEsignResponse({
    actorId: generated.generatedBy,
    completedAt: signed.signedAt,
    ids,
    signedFileHash
  });
  const audits = await tx.auditLog.findMany({
    where: {
      entityId: { in: events.map(({ id }) => id) },
      entityType: "subscription_closure_event",
      module: "subscription_closure"
    }
  });
  const eventBySource = new Map(events.map((event) => [event.sourceKey, event]));
  const receiptBySource = new Map(receipts.map((receipt) => [receipt.sourceKey, receipt]));
  const auditByEvent = new Map(audits.map((audit) => [audit.entityId, audit]));
  const firstEvent = eventBySource.get(sources[0].key);
  const expectedVersion = firstEvent ? firstEvent.sequence - 2 : -1;
  const expectedCommands = earlyTerminationAgreementDocumentCommands({
    actorId: generated.generatedBy,
    closureCaseId: closureCase.id,
    databaseClock: generated.generatedAt,
    documentSnapshot: generated.documentSnapshot as unknown as ReturnType<
      typeof earlyTerminationAgreementDocumentSnapshot
    >,
    expectedVersion,
    ids,
    signedFileHash,
    sourceFileHash: documentHash,
    sources
  });
  const commands = [
    expectedCommands.generated,
    expectedCommands.signed,
    expectedCommands.archived
  ] as const;
  const lifecycleTriples = [
    [generated, sources[0], ids.generatedRevisionId, "GENERATED", null],
    [signed, sources[1], ids.signedRevisionId, "SIGNED", ids.generatedRevisionId],
    [archived, sources[2], ids.archivedRevisionId, "ARCHIVED", ids.signedRevisionId]
  ] as const;
  const lifecycleValid = lifecycleTriples.every(
    ([revision, lifecycleSource, revisionId, stage, supersedesRevisionId], index) => {
      const receipt = receiptBySource.get(lifecycleSource.key);
      const event = eventBySource.get(lifecycleSource.key);
      const audit = event ? auditByEvent.get(event.id) : null;
      const priorEvent = index === 0 ? null : eventBySource.get(sources[index - 1]!.key);
      const expectedOutcome = recoveryAuthorityDocumentOutcome(revision);
      const expectedDetail = {
        documentRevisionId: revisionId,
        documentType: "EARLY_TERMINATION_AGREEMENT",
        revisionNumber: index + 1
      };
      const expectedAuditAfter = event
        ? {
            action: "CREATE_DOCUMENT_REVISION",
            closureCaseId: closureCase.id,
            eventId: event.id,
            outcome: expectedOutcome,
            source: lifecycleSource
          }
        : null;
      return (
        revision.id === revisionId &&
        revision.stage === stage &&
        revision.supersedesRevisionId === supersedesRevisionId &&
        receipt?.actorId === generated.generatedBy &&
        receipt.closureCaseId === closureCase.id &&
        receipt.commandType === "CREATE_DOCUMENT_REVISION" &&
        receipt.eventId === event?.id &&
        receipt.sourceType === lifecycleSource.type &&
        receipt.sourceId === lifecycleSource.id &&
        receipt.sourceKey === lifecycleSource.key &&
        receipt.payloadHash === hashSubscriptionClosureSnapshot(commands[index]) &&
        sameCanonicalReceiptValue(receipt.payloadSnapshot, commands[index]) &&
        sameCanonicalReceiptValue(receipt.outcomeSnapshot, expectedOutcome) &&
        event?.actorId === generated.generatedBy &&
        event.closureCaseId === closureCase.id &&
        event.eventType === "DOCUMENT_REVISION_CREATED" &&
        event.beforeStatus === "PREPARING_RETURN" &&
        event.afterStatus === "PREPARING_RETURN" &&
        event.sequence === expectedVersion + index + 2 &&
        event.sourceType === lifecycleSource.type &&
        event.sourceId === lifecycleSource.id &&
        event.sourceKey === lifecycleSource.key &&
        event.recordedAt.getTime() >= revision.createdAt.getTime() &&
        event.occurredAt.getTime() >= revision.generatedAt.getTime() &&
        (!priorEvent || event.occurredAt.getTime() >= priorEvent.occurredAt.getTime()) &&
        (!priorEvent || event.recordedAt.getTime() >= priorEvent.recordedAt.getTime()) &&
        sameCanonicalReceiptValue(event.detailSnapshot, expectedDetail) &&
        audit?.action === AuditAction.CREATE &&
        audit.entityType === "subscription_closure_event" &&
        audit.entityId === event.id &&
        audit.module === "subscription_closure" &&
        audit.operatorId === generated.generatedBy &&
        audit.beforeSnapshot === null &&
        audit.ipAddress === null &&
        audit.userAgent === null &&
        audit.createdAt.getTime() >= event.recordedAt.getTime() &&
        sameCanonicalReceiptValue(audit.afterSnapshot, expectedAuditAfter)
      );
    }
  );
  if (
    !lifecycleValid ||
    expectedVersion < 0 ||
    receipts.length !== 3 ||
    events.length !== 3 ||
    audits.length !== 3 ||
    documentAuthority.authoritySnapshotHash !== closureCase.authoritySnapshotHash ||
    current?.documentRevisionId !== ids.archivedRevisionId ||
    current.updatedBy !== generated.generatedBy ||
    generated.revisionNumber !== 1 ||
    generated.documentType !== "EARLY_TERMINATION_AGREEMENT" ||
    generated.stage !== "GENERATED" ||
    generated.supersedesRevisionId !== null ||
    generated.sourceType !== sources[0].type ||
    generated.sourceId !== sources[0].id ||
    generated.sourceKey !== sources[0].key ||
    generated.signedAt !== null ||
    generated.signedBy !== null ||
    generated.signedFileId !== null ||
    generated.signedFileHash !== null ||
    generated.archivedAt !== null ||
    generated.archivedBy !== null ||
    signed.revisionNumber !== 2 ||
    signed.documentType !== "EARLY_TERMINATION_AGREEMENT" ||
    signed.stage !== "SIGNED" ||
    signed.supersedesRevisionId !== generated.id ||
    signed.generatedAt.getTime() !== generated.generatedAt.getTime() ||
    signed.generatedBy !== generated.generatedBy ||
    signed.signedBy !== generated.generatedBy ||
    signed.sourceType !== sources[1].type ||
    signed.sourceId !== sources[1].id ||
    signed.sourceKey !== sources[1].key ||
    signed.archivedAt !== null ||
    signed.archivedBy !== null ||
    archived.revisionNumber !== 3 ||
    archived.documentType !== "EARLY_TERMINATION_AGREEMENT" ||
    archived.stage !== "ARCHIVED" ||
    archived.supersedesRevisionId !== signed.id ||
    archived.generatedAt.getTime() !== generated.generatedAt.getTime() ||
    archived.generatedBy !== generated.generatedBy ||
    archived.signedAt?.getTime() !== signed.signedAt.getTime() ||
    archived.signedBy !== generated.generatedBy ||
    archived.archivedAt?.getTime() !== signed.signedAt.getTime() ||
    archived.archivedBy !== generated.generatedBy ||
    archived.sourceType !== sources[2].type ||
    archived.sourceId !== sources[2].id ||
    archived.sourceKey !== sources[2].key ||
    revisions.some(
      (revision) =>
        revision.documentSnapshotHash !== documentHash ||
        revision.sourceFileHash !== documentHash ||
        revision.sourceFileId !== ids.sourceFileId ||
        revision.contractESignTaskId !== ids.esignTaskId ||
        canonicalSubscriptionClosureJson(revision.documentSnapshot as never) !== canonicalDocument
    ) ||
    signed.signedFileId !== ids.signedFileId ||
    signed.signedFileHash !== signedFileHash ||
    archived.signedFileId !== ids.signedFileId ||
    archived.signedFileHash !== signedFileHash ||
    sourceFile.bucket !== "subscription-closure" ||
    sourceFile.objectKey !== sourceObjectKey ||
    sourceFile.originalName !== sourceDocumentName ||
    sourceFile.mimeType !== "application/json" ||
    sourceFile.sizeBytes !== BigInt(Buffer.byteLength(canonicalDocument)) ||
    sourceFile.uploadedBy !== generated.generatedBy ||
    signedFile.bucket !== "subscription-closure" ||
    signedFile.objectKey !== signedObjectKey ||
    signedFile.originalName !== signedDocumentName ||
    signedFile.mimeType !== "application/json" ||
    signedFile.sizeBytes !== BigInt(Buffer.byteLength(canonicalSignedEnvelope)) ||
    signedFile.uploadedBy !== generated.generatedBy ||
    esignTask.deletedAt !== null ||
    esignTask.contractId !== closureCase.contractId ||
    esignTask.customerId !== closureCase.customerId ||
    esignTask.orderId !== closureCase.orderId ||
    esignTask.createdBy !== generated.generatedBy ||
    esignTask.completedAt?.getTime() !== signed.signedAt.getTime() ||
    esignTask.documentType !== ESignDocumentType.EARLY_TERMINATION_AGREEMENT ||
    esignTask.signingStage !== ESignSigningStage.STAGE4_EARLY_TERMINATION ||
    esignTask.provider !== ESignProviderType.OTHER ||
    esignTask.providerTaskId !== ids.esignProviderTaskId ||
    esignTask.providerEnvelopeId !== ids.esignEnvelopeId ||
    esignTask.documentObjectKey !== sourceObjectKey ||
    esignTask.signedDocumentObjectKey !== signedObjectKey ||
    esignTask.sourceType !== sources[2].type ||
    esignTask.sourceId !== sources[2].id ||
    esignTask.sourceKey !== sources[2].key ||
    !sameCanonicalReceiptValue(esignTask.requestSnapshot, expectedRequest) ||
    !sameCanonicalReceiptValue(esignTask.responseSnapshot, expectedResponse) ||
    (esignTask.taskStatus === ESignTaskStatus.COMPLETED &&
      esignTask.updatedBy !== generated.generatedBy) ||
    (esignTask.taskStatus === ESignTaskStatus.COMPLETED && esignTask.cancelledAt !== null) ||
    (esignTask.taskStatus === ESignTaskStatus.CANCELLED && esignTask.cancelledAt === null) ||
    (esignTask.taskStatus !== ESignTaskStatus.COMPLETED &&
      esignTask.taskStatus !== ESignTaskStatus.CANCELLED)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const actorIds = new Set(
    revisions
      .flatMap(({ archivedBy, generatedBy, signedBy }) => [archivedBy, generatedBy, signedBy])
      .filter((value): value is string => Boolean(value))
  );
  if (esignTask.updatedBy) actorIds.add(esignTask.updatedBy);
  const locks = Object.freeze([
    {
      id: closureCase.id,
      mode: "SHARE" as const,
      table: "subscription_closure_current_document" as const
    },
    ...revisions.map(({ id }) => ({
      id,
      mode: "SHARE" as const,
      table: "subscription_closure_document_revision" as const
    })),
    { id: ids.sourceFileId, mode: "SHARE" as const, table: "file_object" as const },
    { id: ids.signedFileId, mode: "SHARE" as const, table: "file_object" as const },
    { id: ids.esignTaskId, mode: "UPDATE" as const, table: "contract_esign_task" as const },
    ...[...actorIds].map((id) => ({ id, mode: "SHARE" as const, table: "user" as const }))
  ]);
  return Object.freeze({
    archived,
    esignTask,
    identity: canonicalSubscriptionClosureJson({
      archived,
      currentRevisionId: current.documentRevisionId,
      esignTask,
      revisions,
      signedFile,
      sourceFile
    }),
    leaseId: lease.id,
    locks,
    segmentId
  });
}

async function assertExactEarlyTerminationStaleReplay(
  tx: Prisma.TransactionClient,
  command: ExecuteEarlyTerminationInput,
  source: SubscriptionClosureSource,
  receipt: Readonly<{
    actorId: string;
    closureCaseId: string;
    commandType: string;
    createdAt: Date;
    eventId: string;
    outcomeSnapshot: Prisma.JsonValue;
    payloadHash: string;
    payloadSnapshot: Prisma.JsonValue;
    sourceId: string;
    sourceKey: string;
    sourceType: string;
  }>,
  closureCase: Readonly<{
    id: string;
    orderId: string;
    retiredAt: Date | null;
    retiredBy: string | null;
    status: string;
  }>
) {
  const event = await tx.subscriptionClosureEvent.findUnique({ where: { id: receipt.eventId } });
  if (
    !event ||
    receipt.actorId !== command.actorId ||
    receipt.closureCaseId !== closureCase.id ||
    receipt.commandType !== "TRANSITION_CASE" ||
    receipt.sourceType !== source.type ||
    receipt.sourceId !== source.id ||
    receipt.sourceKey !== source.key ||
    event.actorId !== command.actorId ||
    event.closureCaseId !== closureCase.id ||
    event.eventType !== "STATUS_TRANSITIONED" ||
    event.beforeStatus !== "PREPARING_RETURN" ||
    event.afterStatus !== "MANUAL_TAKEOVER" ||
    event.sourceType !== source.type ||
    event.sourceId !== source.id ||
    event.sourceKey !== source.key
  ) {
    throw closureSourceConflict();
  }
  const detail = jsonObject(event.detailSnapshot);
  if (
    detail.terminationAction !== "AGREEMENT_STALE" ||
    detail.commandFingerprint !== hashSubscriptionClosureSnapshot(command)
  ) {
    throw closureSourceConflict();
  }
  const expectedCommand = {
    actorId: command.actorId,
    afterStatus: "MANUAL_TAKEOVER" as const,
    closureCaseId: closureCase.id,
    detailSnapshot: event.detailSnapshot,
    eventType: "STATUS_TRANSITIONED" as const,
    expectedStatus: "PREPARING_RETURN" as const,
    expectedVersion: event.sequence - 2,
    occurredAt: event.occurredAt,
    reconditioningAssetWorkOrderId: null,
    recoveryAssetWorkOrderId: null,
    source
  };
  const outcome = jsonObject(receipt.outcomeSnapshot);
  const storedCase = jsonObject(outcome.case);
  const storedUpdatedAt =
    typeof storedCase.updatedAt === "string" ? new Date(storedCase.updatedAt) : null;
  const [currentSnapshot, audits, staleAuthority] = await Promise.all([
    new SubscriptionClosureRepository().getCase(tx, closureCase.id),
    tx.auditLog.findMany({
      where: {
        entityId: event.id,
        entityType: "subscription_closure_event",
        module: "subscription_closure"
      }
    }),
    resolveStaleEarlyTerminationAgreementAuthority(tx, closureCase as never)
  ]);
  if (
    !currentSnapshot ||
    !storedUpdatedAt ||
    Number.isNaN(storedUpdatedAt.getTime()) ||
    storedUpdatedAt.getTime() > event.recordedAt.getTime()
  ) {
    throw closureSourceConflict();
  }
  if (
    staleAuthority.esignTask.taskStatus !== ESignTaskStatus.CANCELLED ||
    staleAuthority.esignTask.updatedBy !== command.actorId ||
    staleAuthority.esignTask.cancelledAt?.getTime() !== event.occurredAt.getTime()
  ) {
    throw closureSourceConflict();
  }
  if (
    !(await validateEarlyTerminationAgreementTaskSuccessor(
      tx,
      closureCase.id,
      staleAuthority.esignTask,
      command.actorId
    ))
  ) {
    throw closureSourceConflict();
  }
  const eventSnapshot = {
    actorId: event.actorId,
    afterStatus: event.afterStatus,
    beforeStatus: event.beforeStatus,
    closureCaseId: event.closureCaseId,
    detailSnapshot: event.detailSnapshot,
    eventType: event.eventType,
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    recordedAt: event.recordedAt.toISOString(),
    sequence: event.sequence,
    source: { id: event.sourceId, key: event.sourceKey, type: event.sourceType }
  };
  const expectedCase = {
    ...currentSnapshot,
    closedAt: null,
    status: "MANUAL_TAKEOVER",
    updatedAt: storedUpdatedAt.toISOString(),
    updatedBy: command.actorId,
    version: event.sequence - 1
  };
  const expectedOutcome = { case: expectedCase, event: eventSnapshot };
  const audit = audits[0];
  if (
    receipt.eventId !== event.id ||
    receipt.createdAt.getTime() < event.recordedAt.getTime() ||
    receipt.payloadHash !== hashSubscriptionClosureSnapshot(expectedCommand) ||
    !sameCanonicalReceiptValue(receipt.payloadSnapshot, expectedCommand) ||
    !sameCanonicalReceiptValue(receipt.outcomeSnapshot, expectedOutcome) ||
    audits.length !== 1 ||
    !audit ||
    audit.operatorId !== command.actorId ||
    audit.action !== AuditAction.CREATE ||
    audit.beforeSnapshot !== null ||
    audit.ipAddress !== null ||
    audit.userAgent !== null ||
    audit.createdAt.getTime() < event.recordedAt.getTime() ||
    !sameCanonicalReceiptValue(audit.afterSnapshot, {
      action: "TRANSITION_CASE",
      closureCaseId: closureCase.id,
      eventId: event.id,
      outcome: expectedOutcome,
      source
    })
  ) {
    throw closureSourceConflict();
  }
  if (closureCase.status === "MANUAL_TAKEOVER") {
    if (closureCase.retiredAt !== null || closureCase.retiredBy !== null) {
      throw closureSourceConflict();
    }
    return;
  }
  if (closureCase.status !== "CANCELLED" || !closureCase.retiredAt || !closureCase.retiredBy) {
    throw closureSourceConflict();
  }
  const cancellationEvent = await tx.subscriptionClosureEvent.findFirst({
    orderBy: [{ sequence: "desc" }, { id: "desc" }],
    where: {
      afterStatus: "CANCELLED",
      beforeStatus: "MANUAL_TAKEOVER",
      closureCaseId: closureCase.id,
      eventType: "STATUS_TRANSITIONED"
    }
  });
  const cancellationDetail = jsonObject(cancellationEvent?.detailSnapshot);
  const prefix = "cancel:";
  if (
    !cancellationEvent ||
    !cancellationEvent.sourceKey.startsWith(prefix) ||
    typeof cancellationDetail.reason !== "string"
  ) {
    throw closureSourceConflict();
  }
  const cancellationSource = {
    id: cancellationEvent.sourceId,
    key: cancellationEvent.sourceKey,
    type: cancellationEvent.sourceType
  };
  const cancellationReceipt = await tx.subscriptionClosureCommandReceipt.findUnique({
    where: {
      sourceType_sourceId_sourceKey: {
        sourceId: cancellationSource.id,
        sourceKey: cancellationSource.key,
        sourceType: cancellationSource.type
      }
    }
  });
  if (!cancellationReceipt) throw closureSourceConflict();
  await assertExactEarlyTerminationCancellationReplay(
    tx,
    {
      actorId: cancellationEvent.actorId,
      closureCaseId: closureCase.id,
      idempotencyKey: cancellationEvent.sourceKey.slice(prefix.length),
      reason: cancellationDetail.reason
    },
    cancellationSource,
    cancellationReceipt
  );
}

async function applyEarlyTerminationCoreBoundary(
  tx: Prisma.TransactionClient,
  authority: EarlyTerminationAgreementDraft,
  actorId: string
) {
  const segment = await tx.subscriptionContractSegment.updateMany({
    data: {
      completedAt: authority.closureCase.effectiveAt,
      status: ContractSegmentStatus.COMPLETED
    },
    where: { id: authority.segment.id, status: ContractSegmentStatus.ACTIVE }
  });
  const order = await tx.subscriptionOrder.updateMany({
    data: { orderStatus: OrderStatus.PENDING_RETURN, updatedBy: actorId },
    where: { id: authority.order.id, orderStatus: OrderStatus.ACTIVE }
  });
  const lease = await tx.lease.updateMany({
    data: { status: LeaseStatus.RETURN_DUE, updatedBy: actorId },
    where: { id: authority.lease.id, status: LeaseStatus.ACTIVE }
  });
  const contract = await tx.contract.updateMany({
    data: { status: ContractStatus.ARCHIVED, updatedBy: actorId },
    where: { id: authority.contract.id, status: ContractStatus.SIGNED }
  });
  if (segment.count !== 1 || order.count !== 1 || lease.count !== 1 || contract.count !== 1) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  await tx.renewalConsideration.updateMany({
    data: { status: "CANCELLED", version: { increment: 1 } },
    where: {
      orderId: authority.order.id,
      status: { notIn: ["EXTENDED", "EXPIRED", "CANCELLED"] }
    }
  });
  await tx.subscriptionChangeOrder.updateMany({
    data: {
      failureCode: "EARLY_TERMINATION_EFFECTIVE",
      failureMessage: "The order reached its governed early-termination effective boundary.",
      status: "FAILED",
      version: { increment: 1 }
    },
    where: {
      orderId: authority.order.id,
      status: {
        in: [
          "DRAFT",
          "QUOTED",
          "CUSTOMER_CONFIRMED",
          "SIGNING_OR_PAYMENT",
          "SCHEDULED",
          "EXECUTING",
          "MANUAL_TAKEOVER"
        ]
      }
    }
  });
}

async function earlyTerminationExecutionReplayLocks(
  tx: Prisma.TransactionClient,
  command: ExecuteEarlyTerminationInput,
  closureCase: Readonly<{
    contractId: string;
    customerId: string;
    id: string;
    orderId: string;
    reconditioningAssetWorkOrderId: string | null;
    recoveryAssetWorkOrderId: string | null;
    returnAssetWorkOrderId: string | null;
    returnHandoverWorkOrderId: string | null;
    vehicleId: string;
    vehicleReturnId: string | null;
  }>
): Promise<readonly SubscriptionClosureAuthorityLock[]> {
  if (
    !closureCase.vehicleReturnId ||
    !closureCase.returnAssetWorkOrderId ||
    !closureCase.returnHandoverWorkOrderId
  ) {
    throw closureSourceConflict();
  }
  const [lease, segment, agreementCurrent, manifestCurrent, manifestRevisions] = await Promise.all([
    tx.lease.findUnique({ select: { id: true }, where: { orderId: closureCase.orderId } }),
    tx.subscriptionContractSegment.findFirst({
      orderBy: [{ sequenceNo: "desc" }, { id: "desc" }],
      select: { id: true },
      where: { orderId: closureCase.orderId }
    }),
    tx.subscriptionClosureCurrentDocument.findUnique({
      include: { documentRevision: true },
      where: {
        closureCaseId_documentType: {
          closureCaseId: closureCase.id,
          documentType: "EARLY_TERMINATION_AGREEMENT"
        }
      }
    }),
    tx.subscriptionClosureCurrentDocument.findUnique({
      include: { documentRevision: true },
      where: {
        closureCaseId_documentType: {
          closureCaseId: closureCase.id,
          documentType: "RETURN_MANIFEST"
        }
      }
    }),
    tx.subscriptionClosureDocumentRevision.findMany({
      orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
      where: { closureCaseId: closureCase.id, documentType: "RETURN_MANIFEST" }
    })
  ]);
  if (!lease || !segment || !agreementCurrent || !manifestCurrent) {
    throw closureSourceConflict();
  }
  const agreementCommand = await currentEarlyTerminationAgreementCommand(
    tx,
    (await resolveEarlyTerminationReplayAgreementDraft(tx, closureCase.id)) as never
  );
  const agreementIds = earlyTerminationAgreementIds(
    closureCase.id,
    agreementCommand.idempotencyKey
  );
  const successorLocks = await physicalReceiptSuccessorLocks(tx, closureCase);
  return Object.freeze([
    { id: closureCase.id, mode: "UPDATE", table: "subscription_closure_case" },
    { id: closureCase.orderId, mode: "UPDATE", table: "subscription_order" },
    { id: closureCase.vehicleId, mode: "SHARE", table: "vehicle" },
    { id: lease.id, mode: "UPDATE", table: "lease" },
    { id: closureCase.contractId, mode: "SHARE", table: "contract" },
    { id: segment.id, mode: "UPDATE", table: "subscription_contract_segment" },
    { id: closureCase.vehicleReturnId, mode: "UPDATE", table: "vehicle_return" },
    {
      id: closureCase.returnHandoverWorkOrderId,
      mode: "UPDATE",
      table: "vehicle_handover_work_order"
    },
    { id: closureCase.returnAssetWorkOrderId, mode: "UPDATE", table: "asset_work_order" },
    {
      id: closureCase.id,
      mode: "SHARE",
      table: "subscription_closure_current_document"
    },
    ...[
      agreementIds.generatedRevisionId,
      agreementIds.signedRevisionId,
      agreementIds.archivedRevisionId
    ].map((id) => ({
      id,
      mode: "SHARE" as const,
      table: "subscription_closure_document_revision" as const
    })),
    ...manifestRevisions.map(({ id }) => ({
      id,
      mode: "SHARE" as const,
      table: "subscription_closure_document_revision" as const
    })),
    { id: agreementIds.sourceFileId, mode: "SHARE", table: "file_object" },
    { id: agreementIds.signedFileId, mode: "SHARE", table: "file_object" },
    ...manifestRevisions.flatMap((revision) => [
      {
        id: revision.sourceFileId,
        mode: "SHARE" as const,
        table: "file_object" as const
      },
      ...(revision.signedFileId
        ? [{ id: revision.signedFileId, mode: "SHARE" as const, table: "file_object" as const }]
        : [])
    ]),
    { id: agreementIds.esignTaskId, mode: "SHARE", table: "contract_esign_task" },
    ...manifestRevisions.map(({ contractESignTaskId }) => ({
      id: contractESignTaskId,
      mode: "SHARE" as const,
      table: "contract_esign_task" as const
    })),
    ...successorLocks,
    { id: closureCase.customerId, mode: "SHARE", table: "customer" },
    { id: agreementCommand.actorId, mode: "SHARE", table: "user" },
    ...manifestRevisions
      .flatMap(({ archivedBy, generatedBy, signedBy }) => [archivedBy, generatedBy, signedBy])
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id, mode: "SHARE" as const, table: "user" as const })),
    { id: command.actorId, mode: "SHARE", table: "user" }
  ]);
}

async function resolveEarlyTerminationReplayAgreementDraft(
  tx: Prisma.TransactionClient,
  closureCaseId: string
) {
  const closureCase = await tx.subscriptionClosureCase.findUnique({ where: { id: closureCaseId } });
  if (!closureCase) throw serviceConflict("AUTHORITY_NOT_FOUND");
  const authority = jsonObject(closureCase.authoritySnapshot);
  const currentDocument = await tx.subscriptionClosureCurrentDocument.findUnique({
    where: {
      closureCaseId_documentType: {
        closureCaseId,
        documentType: "EARLY_TERMINATION_AGREEMENT"
      }
    }
  });
  return { closureCase, currentDocumentId: currentDocument?.documentRevisionId ?? null, authority };
}

function assertEarlyTerminationCancellationCase(
  closureCase: Readonly<{
    closureType: string;
    currentSettlementRevisionId: string | null;
    finalDisposition: string;
    physicalControlledAt: Date | null;
    physicalControlMode: string;
    reconditioningAssetWorkOrderId: string | null;
    recoveryAssetWorkOrderId: string | null;
    retiredAt: Date | null;
    retiredBy: string | null;
    returnAssetWorkOrderId: string | null;
    returnHandoverWorkOrderId: string | null;
    settledAt: Date | null;
    status: string;
    vehicleReturnId: string | null;
  }>
) {
  if (
    closureCase.closureType !== "EARLY_TERMINATION" ||
    closureCase.physicalControlMode !== "VOLUNTARY_RETURN" ||
    closureCase.finalDisposition !== "TERMINATE" ||
    (closureCase.status !== "PREPARING_RETURN" && closureCase.status !== "MANUAL_TAKEOVER") ||
    closureCase.retiredAt !== null ||
    closureCase.retiredBy !== null ||
    closureCase.vehicleReturnId !== null ||
    closureCase.returnAssetWorkOrderId !== null ||
    closureCase.returnHandoverWorkOrderId !== null ||
    closureCase.recoveryAssetWorkOrderId !== null ||
    closureCase.reconditioningAssetWorkOrderId !== null ||
    closureCase.physicalControlledAt !== null ||
    closureCase.settledAt !== null ||
    closureCase.currentSettlementRevisionId !== null
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
}

type EarlyTerminationCancellationAgreement = Readonly<{
  identity: string;
  locks: readonly SubscriptionClosureAuthorityLock[];
  task: Readonly<{
    cancelledAt: Date | null;
    id: string;
    taskStatus: ESignTaskStatus;
    updatedBy: string | null;
  }>;
}>;

async function assertNoEarlyTerminationAgreementGraph(
  tx: Prisma.TransactionClient,
  closureCaseId: string
) {
  const [revisions, current, tasks] = await Promise.all([
    tx.subscriptionClosureDocumentRevision.count({
      where: { closureCaseId, documentType: "EARLY_TERMINATION_AGREEMENT" }
    }),
    tx.subscriptionClosureCurrentDocument.count({
      where: { closureCaseId, documentType: "EARLY_TERMINATION_AGREEMENT" }
    }),
    tx.contractESignTask.count({
      where: {
        documentType: ESignDocumentType.EARLY_TERMINATION_AGREEMENT,
        sourceId: closureCaseId,
        sourceType: "SUBSCRIPTION_EARLY_TERMINATION"
      }
    })
  ]);
  if (revisions !== 0 || current !== 0 || tasks !== 0) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
}

async function resolveEarlyTerminationCancellationAgreement(
  tx: Prisma.TransactionClient,
  closureCase: Readonly<{
    id: string;
    status: string;
  }>
): Promise<EarlyTerminationCancellationAgreement | null> {
  const replayDraft = await resolveEarlyTerminationReplayAgreementDraft(tx, closureCase.id);
  if (!replayDraft.currentDocumentId) {
    await assertNoEarlyTerminationAgreementGraph(tx, closureCase.id);
    if (closureCase.status === "MANUAL_TAKEOVER") {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    return null;
  }
  const agreementCommand = await currentEarlyTerminationAgreementCommand(tx, replayDraft as never);
  const ids = earlyTerminationAgreementIds(closureCase.id, agreementCommand.idempotencyKey);
  const agreement = await validateEarlyTerminationAgreementChainInTransaction(
    tx,
    agreementCommand,
    ids,
    earlyTerminationAgreementSources(closureCase.id, agreementCommand.idempotencyKey)
  );
  const task = await tx.contractESignTask.findUnique({ where: { id: ids.esignTaskId } });
  if (
    !agreement ||
    !task ||
    (closureCase.status === "PREPARING_RETURN" && task.taskStatus !== ESignTaskStatus.COMPLETED) ||
    (closureCase.status === "MANUAL_TAKEOVER" && task.taskStatus !== ESignTaskStatus.CANCELLED)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  if (closureCase.status === "MANUAL_TAKEOVER") {
    const stale = await tx.subscriptionClosureEvent.findFirst({
      orderBy: [{ sequence: "desc" }, { id: "desc" }],
      where: { closureCaseId: closureCase.id, afterStatus: "MANUAL_TAKEOVER" }
    });
    if (
      !stale ||
      jsonObject(stale.detailSnapshot).terminationAction !== "AGREEMENT_STALE" ||
      task.cancelledAt?.getTime() !== stale.occurredAt.getTime() ||
      !(await validateEarlyTerminationAgreementTaskSuccessor(
        tx,
        closureCase.id,
        task,
        agreementCommand.actorId
      ))
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
  }
  const locks = [
    ...(await earlyTerminationAgreementAuthorityLocks(tx, closureCase.id, ids)),
    { id: ids.esignTaskId, mode: "UPDATE", table: "contract_esign_task" }
  ] as const;
  return Object.freeze({
    identity: canonicalSubscriptionClosureJson({ agreement, task }),
    locks,
    task
  });
}

async function earlyTerminationCancellationReplayLocks(
  tx: Prisma.TransactionClient,
  command: CancelEarlyTerminationInput,
  closureCase: Readonly<{ id: string; orderId: string }>
): Promise<readonly SubscriptionClosureAuthorityLock[]> {
  const agreement = await resolveEarlyTerminationCancellationAgreement(tx, {
    id: closureCase.id,
    status: "CANCELLED"
  });
  return Object.freeze([
    { id: closureCase.id, mode: "UPDATE", table: "subscription_closure_case" },
    { id: closureCase.orderId, mode: "UPDATE", table: "subscription_order" },
    ...(agreement?.locks ?? []),
    { id: command.actorId, mode: "SHARE", table: "user" }
  ]);
}

async function assertExactEarlyTerminationCancellationReplay(
  tx: Prisma.TransactionClient,
  command: CancelEarlyTerminationInput,
  source: SubscriptionClosureSource,
  receipt: Readonly<{
    actorId: string;
    closureCaseId: string;
    commandType: string;
    eventId: string;
    outcomeSnapshot: Prisma.JsonValue;
    payloadHash: string;
    payloadSnapshot: Prisma.JsonValue;
    sourceId: string;
    sourceKey: string;
    sourceType: string;
  }>
) {
  const [closureCase, event] = await Promise.all([
    tx.subscriptionClosureCase.findUnique({ where: { id: command.closureCaseId } }),
    tx.subscriptionClosureEvent.findUnique({ where: { id: receipt.eventId } })
  ]);
  if (
    !closureCase ||
    !event ||
    closureCase.closureType !== "EARLY_TERMINATION" ||
    closureCase.physicalControlMode !== "VOLUNTARY_RETURN" ||
    closureCase.finalDisposition !== "TERMINATE" ||
    closureCase.status !== "CANCELLED" ||
    closureCase.retiredBy !== command.actorId ||
    closureCase.retiredAt?.getTime() !== event.occurredAt.getTime() ||
    closureCase.version !== event.sequence - 1 ||
    closureCase.vehicleReturnId !== null ||
    closureCase.returnAssetWorkOrderId !== null ||
    closureCase.returnHandoverWorkOrderId !== null ||
    closureCase.recoveryAssetWorkOrderId !== null ||
    closureCase.reconditioningAssetWorkOrderId !== null ||
    closureCase.physicalControlledAt !== null ||
    closureCase.settledAt !== null ||
    closureCase.currentSettlementRevisionId !== null ||
    receipt.actorId !== command.actorId ||
    receipt.closureCaseId !== closureCase.id ||
    receipt.commandType !== "TRANSITION_CASE" ||
    receipt.sourceType !== source.type ||
    receipt.sourceId !== source.id ||
    receipt.sourceKey !== source.key ||
    event.actorId !== command.actorId ||
    event.closureCaseId !== closureCase.id ||
    event.eventType !== "STATUS_TRANSITIONED" ||
    (event.beforeStatus !== "PREPARING_RETURN" && event.beforeStatus !== "MANUAL_TAKEOVER") ||
    event.afterStatus !== "CANCELLED" ||
    event.sourceType !== source.type ||
    event.sourceId !== source.id ||
    event.sourceKey !== source.key
  ) {
    throw closureSourceConflict();
  }
  const detail = jsonObject(event.detailSnapshot);
  if (
    detail.commandFingerprint !== hashSubscriptionClosureSnapshot(command) ||
    detail.reason !== command.reason ||
    detail.terminationAction !== "CANCEL"
  ) {
    throw closureSourceConflict();
  }
  const expectedCommand = {
    actorId: command.actorId,
    afterStatus: "CANCELLED" as const,
    closureCaseId: closureCase.id,
    detailSnapshot: event.detailSnapshot,
    eventType: "STATUS_TRANSITIONED" as const,
    expectedStatus: event.beforeStatus,
    expectedVersion: event.sequence - 2,
    occurredAt: event.occurredAt,
    reconditioningAssetWorkOrderId: null,
    recoveryAssetWorkOrderId: null,
    retireCase: true,
    source
  };
  const [caseSnapshot, audits] = await Promise.all([
    new SubscriptionClosureRepository().getCase(tx, closureCase.id),
    tx.auditLog.findMany({
      where: {
        entityId: event.id,
        entityType: "subscription_closure_event",
        module: "subscription_closure"
      }
    })
  ]);
  const eventSnapshot = {
    actorId: event.actorId,
    afterStatus: event.afterStatus,
    beforeStatus: event.beforeStatus,
    closureCaseId: event.closureCaseId,
    detailSnapshot: event.detailSnapshot,
    eventType: event.eventType,
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    recordedAt: event.recordedAt.toISOString(),
    sequence: event.sequence,
    source: { id: event.sourceId, key: event.sourceKey, type: event.sourceType }
  };
  const expectedOutcome = { case: caseSnapshot, event: eventSnapshot };
  const audit = audits[0];
  if (
    !caseSnapshot ||
    receipt.eventId !== event.id ||
    receipt.payloadHash !== hashSubscriptionClosureSnapshot(expectedCommand) ||
    !sameCanonicalReceiptValue(receipt.payloadSnapshot, expectedCommand) ||
    !sameCanonicalReceiptValue(receipt.outcomeSnapshot, expectedOutcome) ||
    audits.length !== 1 ||
    !audit ||
    audit.operatorId !== command.actorId ||
    audit.action !== AuditAction.CREATE ||
    audit.beforeSnapshot !== null ||
    audit.ipAddress !== null ||
    audit.userAgent !== null ||
    audit.createdAt.getTime() < event.recordedAt.getTime() ||
    !sameCanonicalReceiptValue(audit.afterSnapshot, {
      action: "TRANSITION_CASE",
      closureCaseId: closureCase.id,
      eventId: event.id,
      outcome: expectedOutcome,
      source
    })
  ) {
    throw closureSourceConflict();
  }
  await resolveEarlyTerminationCancellationAgreement(tx, {
    id: closureCase.id,
    status: "CANCELLED"
  });
}

async function validateEarlyTerminationAgreementTaskSuccessor(
  tx: Prisma.TransactionClient,
  closureCaseId: string,
  task: Readonly<{
    cancelledAt: Date | null;
    id: string;
    taskStatus: ESignTaskStatus;
    updatedBy: string | null;
  }>,
  agreementActorId: string
) {
  if (task.taskStatus === ESignTaskStatus.COMPLETED) {
    return task.cancelledAt === null && task.updatedBy === agreementActorId;
  }
  if (task.taskStatus !== ESignTaskStatus.CANCELLED || !task.cancelledAt || !task.updatedBy) {
    return false;
  }
  const successorEvents = await tx.subscriptionClosureEvent.findMany({
    orderBy: [{ sequence: "asc" }, { id: "asc" }],
    where: {
      actorId: task.updatedBy,
      afterStatus: { in: ["MANUAL_TAKEOVER", "CANCELLED"] },
      closureCaseId,
      occurredAt: task.cancelledAt,
      eventType: "STATUS_TRANSITIONED"
    }
  });
  if (successorEvents.length !== 1) return false;
  const successor = successorEvents[0]!;
  const detail = jsonObject(successor.detailSnapshot);
  const manual =
    successor.afterStatus === "MANUAL_TAKEOVER" && detail.terminationAction === "AGREEMENT_STALE";
  const cancelled = successor.afterStatus === "CANCELLED" && detail.terminationAction === "CANCEL";
  if (!manual && !cancelled) return false;
  const receipt = await tx.subscriptionClosureCommandReceipt.findUnique({
    where: {
      sourceType_sourceId_sourceKey: {
        sourceId: successor.sourceId,
        sourceKey: successor.sourceKey,
        sourceType: successor.sourceType
      }
    }
  });
  const taskAudits = await tx.auditLog.findMany({
    where: {
      entityId: task.id,
      entityType: "contract_esign_task",
      module: "subscription_closure"
    }
  });
  const eventAudits = await tx.auditLog.findMany({
    where: {
      entityId: successor.id,
      entityType: "subscription_closure_event",
      module: "subscription_closure"
    }
  });
  const expectedCommand = {
    actorId: successor.actorId,
    afterStatus: successor.afterStatus,
    closureCaseId,
    detailSnapshot: successor.detailSnapshot,
    eventType: successor.eventType,
    expectedStatus: successor.beforeStatus,
    expectedVersion: successor.sequence - 2,
    occurredAt: successor.occurredAt,
    reconditioningAssetWorkOrderId: null,
    recoveryAssetWorkOrderId: null,
    ...(cancelled ? { retireCase: true } : {}),
    source: {
      id: successor.sourceId,
      key: successor.sourceKey,
      type: successor.sourceType
    }
  };
  const taskAudit = taskAudits[0];
  const eventAudit = eventAudits[0];
  const outcome = jsonObject(receipt?.outcomeSnapshot);
  const outcomeCase = jsonObject(outcome.case);
  const outcomeEvent = jsonObject(outcome.event);
  const expectedEventOutcome = {
    actorId: successor.actorId,
    afterStatus: successor.afterStatus,
    beforeStatus: successor.beforeStatus,
    closureCaseId: successor.closureCaseId,
    detailSnapshot: successor.detailSnapshot,
    eventType: successor.eventType,
    id: successor.id,
    occurredAt: successor.occurredAt.toISOString(),
    recordedAt: successor.recordedAt.toISOString(),
    sequence: successor.sequence,
    source: {
      id: successor.sourceId,
      key: successor.sourceKey,
      type: successor.sourceType
    }
  };
  const expectedTaskAfter = {
    cancelledAt: task.cancelledAt,
    ...(manual ? { reason: "EARLY_TERMINATION_CURRENT_FACT_DRIFT" } : {}),
    taskStatus: ESignTaskStatus.CANCELLED
  };
  const expectedTaskBefore = manual
    ? { taskStatus: ESignTaskStatus.COMPLETED }
    : { cancelledAt: null, taskStatus: ESignTaskStatus.COMPLETED };
  const successorSource = {
    id: successor.sourceId,
    key: successor.sourceKey,
    type: successor.sourceType
  };
  const valid = Boolean(
    receipt &&
    receipt.actorId === successor.actorId &&
    receipt.closureCaseId === closureCaseId &&
    receipt.commandType === "TRANSITION_CASE" &&
    receipt.eventId === successor.id &&
    receipt.sourceType === successor.sourceType &&
    receipt.sourceId === successor.sourceId &&
    receipt.sourceKey === successor.sourceKey &&
    receipt.payloadHash === hashSubscriptionClosureSnapshot(expectedCommand) &&
    sameCanonicalReceiptValue(receipt.payloadSnapshot, expectedCommand) &&
    outcomeCase.id === closureCaseId &&
    outcomeCase.status === successor.afterStatus &&
    outcomeCase.version === successor.sequence - 1 &&
    sameCanonicalReceiptValue(outcomeEvent, expectedEventOutcome) &&
    taskAudits.length === 1 &&
    taskAudit &&
    taskAudit.operatorId === task.updatedBy &&
    taskAudit.action === AuditAction.UPDATE &&
    taskAudit.ipAddress === null &&
    taskAudit.userAgent === null &&
    taskAudit.createdAt.getTime() <= successor.recordedAt.getTime() &&
    sameCanonicalReceiptValue(taskAudit.afterSnapshot, expectedTaskAfter) &&
    sameCanonicalReceiptValue(taskAudit.beforeSnapshot, expectedTaskBefore) &&
    eventAudits.length === 1 &&
    eventAudit &&
    eventAudit.operatorId === successor.actorId &&
    eventAudit.action === AuditAction.CREATE &&
    eventAudit.beforeSnapshot === null &&
    eventAudit.ipAddress === null &&
    eventAudit.userAgent === null &&
    eventAudit.createdAt.getTime() >= successor.recordedAt.getTime() &&
    sameCanonicalReceiptValue(eventAudit.afterSnapshot, {
      action: "TRANSITION_CASE",
      closureCaseId,
      eventId: successor.id,
      outcome: receipt.outcomeSnapshot,
      source: successorSource
    })
  );
  return valid;
}

async function assertExactEarlyTerminationExecutionReplay(
  tx: Prisma.TransactionClient,
  command: ExecuteEarlyTerminationInput,
  source: SubscriptionClosureSource,
  receipt: Readonly<{
    actorId: string;
    closureCaseId: string;
    commandType: string;
    eventId: string;
    outcomeSnapshot: Prisma.JsonValue;
    payloadHash: string;
    payloadSnapshot: Prisma.JsonValue;
    sourceId: string;
    sourceKey: string;
    sourceType: string;
  }>
) {
  const closureCase = await tx.subscriptionClosureCase.findUnique({
    where: { id: command.closureCaseId }
  });
  if (
    !closureCase ||
    !closureCase.vehicleReturnId ||
    !closureCase.returnAssetWorkOrderId ||
    !closureCase.returnHandoverWorkOrderId ||
    closureCase.closureType !== "EARLY_TERMINATION" ||
    ![
      "PREPARING_RETURN",
      "RETURN_INSPECTION",
      "RECONDITIONING",
      "PENDING_SETTLEMENT",
      "TERMINATED"
    ].includes(closureCase.status) ||
    closureCase.retiredAt !== null ||
    closureCase.retiredBy !== null ||
    receipt.actorId !== command.actorId ||
    receipt.closureCaseId !== closureCase.id ||
    receipt.commandType !== "TRANSITION_CASE" ||
    receipt.sourceType !== source.type ||
    receipt.sourceId !== source.id ||
    receipt.sourceKey !== source.key
  ) {
    throw closureSourceConflict();
  }
  const [event, order, contract, lease, segment, vehicleReturn, asset, handover] =
    await Promise.all([
      tx.subscriptionClosureEvent.findUnique({ where: { id: receipt.eventId } }),
      tx.subscriptionOrder.findUnique({ where: { id: closureCase.orderId } }),
      tx.contract.findUnique({ where: { id: closureCase.contractId } }),
      tx.lease.findUnique({ where: { orderId: closureCase.orderId } }),
      tx.subscriptionContractSegment.findFirst({
        orderBy: [{ sequenceNo: "desc" }, { id: "desc" }],
        where: { orderId: closureCase.orderId }
      }),
      tx.vehicleReturn.findUnique({ where: { id: closureCase.vehicleReturnId } }),
      tx.assetWorkOrder.findUnique({ where: { id: closureCase.returnAssetWorkOrderId } }),
      tx.vehicleHandoverWorkOrder.findUnique({
        where: { id: closureCase.returnHandoverWorkOrderId }
      })
    ]);
  const detail = jsonObject(event?.detailSnapshot);
  const originalManifestRevisionId =
    typeof detail.returnManifestRevisionId === "string" ? detail.returnManifestRevisionId : "";
  const [originalManifest, manifestRevisions, manifestCurrent, eventAudits, contractAudits] =
    await Promise.all([
      tx.subscriptionClosureDocumentRevision.findUnique({
        where: { id: originalManifestRevisionId || "00000000-0000-4000-8000-000000000000" }
      }),
      tx.subscriptionClosureDocumentRevision.findMany({
        orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
        where: { closureCaseId: closureCase.id, documentType: "RETURN_MANIFEST" }
      }),
      tx.subscriptionClosureCurrentDocument.findUnique({
        where: {
          closureCaseId_documentType: {
            closureCaseId: closureCase.id,
            documentType: "RETURN_MANIFEST"
          }
        }
      }),
      event
        ? tx.auditLog.findMany({
            where: {
              entityId: event.id,
              entityType: "subscription_closure_event",
              module: "subscription_closure"
            }
          })
        : [],
      tx.auditLog.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: {
          entityId: closureCase.contractId,
          entityType: "contract",
          module: "subscription_closure",
          operatorId: command.actorId
        }
      })
    ]);
  const contractArchiveAudit = contractAudits.find((candidate) => {
    const before = jsonObject(candidate.beforeSnapshot);
    const after = jsonObject(candidate.afterSnapshot);
    return before.status === ContractStatus.SIGNED && after.status === ContractStatus.ARCHIVED;
  });
  const contractAuditBefore = jsonObject(contractArchiveAudit?.beforeSnapshot);
  const contractAuditAfter = jsonObject(contractArchiveAudit?.afterSnapshot);
  const contractAuditBeforeStable = { ...contractAuditBefore };
  delete contractAuditBeforeStable.status;
  delete contractAuditBeforeStable.updatedAt;
  delete contractAuditBeforeStable.updatedBy;
  const contractAuditAfterStable = { ...contractAuditAfter };
  delete contractAuditAfterStable.status;
  delete contractAuditAfterStable.updatedAt;
  delete contractAuditAfterStable.updatedBy;
  const currentStateValid =
    (closureCase.status === "PREPARING_RETURN" &&
      order?.orderStatus === OrderStatus.PENDING_RETURN &&
      lease?.status === LeaseStatus.RETURN_DUE) ||
    (["RETURN_INSPECTION", "RECONDITIONING", "PENDING_SETTLEMENT"].includes(closureCase.status) &&
      order?.orderStatus === OrderStatus.RETURNED_PENDING_SETTLEMENT &&
      lease?.status === LeaseStatus.COMPLETED) ||
    (closureCase.status === "TERMINATED" &&
      order?.orderStatus === OrderStatus.TERMINATED &&
      lease?.status === LeaseStatus.COMPLETED);
  const manifestChainValid = manifestRevisions.every((revision, index) => {
    const predecessor = index === 0 ? null : manifestRevisions[index - 1]!;
    return (
      revision.revisionNumber === index + 1 &&
      revision.vehicleReturnId === closureCase.vehicleReturnId &&
      revision.handoverWorkOrderId === closureCase.returnHandoverWorkOrderId &&
      revision.documentSnapshotHash ===
        hashSubscriptionClosureSnapshot(revision.documentSnapshot) &&
      revision.sourceFileHash === revision.documentSnapshotHash &&
      revision.supersedesRevisionId === (predecessor?.id ?? null)
    );
  });
  const manifestSuccessorsValid = await validateExactReturnManifestSuccessorChain(
    tx,
    closureCase,
    manifestRevisions,
    manifestCurrent
  );
  if (
    !event ||
    event.sourceType !== source.type ||
    event.sourceId !== source.id ||
    event.sourceKey !== source.key ||
    event.eventType !== "NOTE_ADDED" ||
    event.beforeStatus !== "PREPARING_RETURN" ||
    event.afterStatus !== "PREPARING_RETURN" ||
    detail.executionFingerprint !== hashSubscriptionClosureSnapshot(command) ||
    detail.vehicleReturnId !== closureCase.vehicleReturnId ||
    detail.assetWorkOrderId !== closureCase.returnAssetWorkOrderId ||
    detail.handoverWorkOrderId !== closureCase.returnHandoverWorkOrderId ||
    !currentStateValid ||
    !contract ||
    contract.orderId !== closureCase.orderId ||
    contract.customerId !== closureCase.customerId ||
    (contract.status !== ContractStatus.ARCHIVED &&
      contract.status !== ContractStatus.TERMINATED) ||
    !contractArchiveAudit ||
    contractArchiveAudit.action !== AuditAction.UPDATE ||
    contractAuditAfter.updatedBy !== command.actorId ||
    !sameCanonicalReceiptValue(contractAuditBeforeStable, contractAuditAfterStable) ||
    !segment ||
    segment.status !== ContractSegmentStatus.COMPLETED ||
    segment.completedAt?.getTime() !== closureCase.effectiveAt.getTime() ||
    !vehicleReturn ||
    vehicleReturn.orderId !== closureCase.orderId ||
    vehicleReturn.returnType !== "EARLY_TERMINATION" ||
    (vehicleReturn.returnStatus !== VehicleReturnStatus.PENDING &&
      vehicleReturn.returnStatus !== VehicleReturnStatus.READY &&
      vehicleReturn.returnStatus !== VehicleReturnStatus.CONFIRMED) ||
    !asset ||
    asset.workOrderType !== "RETURN_INBOUND" ||
    asset.orderId !== closureCase.orderId ||
    !handover ||
    handover.handoverType !== "RETURN_INBOUND" ||
    handover.orderId !== closureCase.orderId ||
    !originalManifest ||
    originalManifest.id !== originalManifestRevisionId ||
    originalManifest.documentType !== "RETURN_MANIFEST" ||
    originalManifest.stage !== "GENERATED" ||
    originalManifest.revisionNumber !== 1 ||
    originalManifest.supersedesRevisionId !== null ||
    originalManifest.vehicleReturnId !== closureCase.vehicleReturnId ||
    originalManifest.handoverWorkOrderId !== closureCase.returnHandoverWorkOrderId ||
    manifestRevisions[0]?.id !== originalManifest.id ||
    !manifestChainValid ||
    !manifestSuccessorsValid ||
    manifestCurrent?.documentRevisionId !== manifestRevisions.at(-1)?.id
  ) {
    throw closureSourceConflict();
  }
  const expectedCommand = {
    actorId: command.actorId,
    afterStatus: "PREPARING_RETURN" as const,
    closureCaseId: closureCase.id,
    detailSnapshot: event.detailSnapshot,
    eventType: "NOTE_ADDED" as const,
    expectedStatus: "PREPARING_RETURN" as const,
    expectedVersion: event.sequence - 2,
    occurredAt: event.occurredAt,
    reconditioningAssetWorkOrderId: null,
    recoveryAssetWorkOrderId: null,
    source
  };
  const outcome = jsonObject(receipt.outcomeSnapshot);
  const outcomeCase = jsonObject(outcome.case);
  const outcomeEvent = jsonObject(outcome.event);
  const audit = eventAudits[0];
  if (
    receipt.eventId !== event.id ||
    receipt.payloadHash !== hashSubscriptionClosureSnapshot(expectedCommand) ||
    !sameCanonicalReceiptValue(receipt.payloadSnapshot, expectedCommand) ||
    outcomeCase.id !== closureCase.id ||
    outcomeCase.status !== "PREPARING_RETURN" ||
    outcomeCase.version !== event.sequence - 1 ||
    outcomeCase.vehicleReturnId !== closureCase.vehicleReturnId ||
    outcomeCase.returnAssetWorkOrderId !== closureCase.returnAssetWorkOrderId ||
    outcomeCase.returnHandoverWorkOrderId !== closureCase.returnHandoverWorkOrderId ||
    outcomeCase.physicalControlledAt !== null ||
    outcomeCase.settledAt !== null ||
    outcomeCase.currentSettlementRevisionId !== null ||
    !sameCanonicalReceiptValue(outcomeEvent, {
      actorId: event.actorId,
      afterStatus: event.afterStatus,
      beforeStatus: event.beforeStatus,
      closureCaseId: event.closureCaseId,
      detailSnapshot: event.detailSnapshot,
      eventType: event.eventType,
      id: event.id,
      occurredAt: event.occurredAt.toISOString(),
      recordedAt: event.recordedAt.toISOString(),
      sequence: event.sequence,
      source: { id: event.sourceId, key: event.sourceKey, type: event.sourceType }
    }) ||
    eventAudits.length !== 1 ||
    !audit ||
    audit.operatorId !== command.actorId ||
    audit.action !== AuditAction.CREATE ||
    audit.beforeSnapshot !== null ||
    audit.ipAddress !== null ||
    audit.userAgent !== null ||
    !sameCanonicalReceiptValue(audit.afterSnapshot, {
      action: "TRANSITION_CASE",
      closureCaseId: closureCase.id,
      eventId: event.id,
      outcome: receipt.outcomeSnapshot,
      source
    })
  ) {
    throw closureSourceConflict();
  }
  await assertExactPhysicalReceiptSuccessorReplay(tx, closureCase);
  const agreementDraft = await resolveEarlyTerminationReplayAgreementDraft(tx, closureCase.id);
  const agreementCommand = await currentEarlyTerminationAgreementCommand(
    tx,
    agreementDraft as never
  );
  const agreementIds = earlyTerminationAgreementIds(
    closureCase.id,
    agreementCommand.idempotencyKey
  );
  if (
    !(await validateEarlyTerminationAgreementChainInTransaction(
      tx,
      agreementCommand,
      agreementIds,
      earlyTerminationAgreementSources(closureCase.id, agreementCommand.idempotencyKey)
    ))
  ) {
    throw closureSourceConflict();
  }
  return Object.freeze({
    closureCaseId: closureCase.id,
    returnAssetWorkOrderId: closureCase.returnAssetWorkOrderId,
    returnHandoverWorkOrderId: closureCase.returnHandoverWorkOrderId,
    returnManifestRevisionId: originalManifest.id,
    vehicleReturnId: closureCase.vehicleReturnId
  });
}

async function validateExactReturnManifestSuccessorChain(
  tx: Prisma.TransactionClient,
  closureCase: Readonly<{
    caseNo: string;
    contractId: string;
    customerId: string;
    id: string;
    orderId: string;
    returnAssetWorkOrderId: string | null;
    returnHandoverWorkOrderId: string | null;
    vehicleId: string;
    vehicleReturnId: string | null;
  }>,
  revisions: readonly Prisma.SubscriptionClosureDocumentRevisionGetPayload<Record<string, never>>[],
  current: Readonly<{
    closureCaseId: string;
    documentRevisionId: string;
    documentType: string;
    updatedBy: string;
  }> | null
) {
  const closureCaseId = closureCase.id;
  if (
    revisions.length < 1 ||
    revisions.length > 3 ||
    revisions[0]?.stage !== "GENERATED" ||
    (revisions.length >= 2 && revisions[1]?.stage !== "SIGNED") ||
    (revisions.length === 3 && revisions[2]?.stage !== "ARCHIVED")
  ) {
    return false;
  }
  const revisionIds = revisions.map(({ id }) => id);
  const taskIds = revisions.map(({ contractESignTaskId }) => contractESignTaskId);
  const fileIds = Array.from(
    new Set(
      revisions.flatMap(({ signedFileId, sourceFileId }) =>
        signedFileId ? [sourceFileId, signedFileId] : [sourceFileId]
      )
    )
  );
  const events = await tx.subscriptionClosureEvent.findMany({
    orderBy: [{ sequence: "asc" }, { id: "asc" }],
    where: {
      closureCaseId,
      detailSnapshot: { equals: "RETURN_MANIFEST", path: ["documentType"] },
      eventType: "DOCUMENT_REVISION_CREATED"
    }
  });
  const receipts = await tx.subscriptionClosureCommandReceipt.findMany({
    where: {
      closureCaseId,
      commandType: "CREATE_DOCUMENT_REVISION",
      payloadSnapshot: { equals: "RETURN_MANIFEST", path: ["documentType"] }
    }
  });
  const tasks = await tx.contractESignTask.findMany({
    where: {
      OR: [
        { id: { in: taskIds } },
        {
          sourceId: closureCaseId,
          sourceKey: { in: revisions.map(({ sourceKey }) => sourceKey) },
          sourceType: "SUBSCRIPTION_CLOSURE"
        }
      ]
    }
  });
  const files = await tx.fileObject.findMany({ where: { id: { in: fileIds } } });
  const eventAudits = await tx.auditLog.findMany({
    where: {
      entityId: { in: events.map(({ id }) => id) },
      entityType: "subscription_closure_event",
      module: "subscription_closure"
    }
  });
  if (
    events.length !== revisions.length ||
    receipts.length !== revisions.length ||
    eventAudits.length !== revisions.length ||
    tasks.length !== revisions.length ||
    files.length !== fileIds.length ||
    current?.closureCaseId !== closureCaseId ||
    current.documentType !== "RETURN_MANIFEST" ||
    current.documentRevisionId !== revisions.at(-1)?.id ||
    current.updatedBy !== revisions.at(-1)?.generatedBy
  ) {
    return false;
  }
  return revisions.every((revision, index) => {
    const predecessor = index === 0 ? null : revisions[index - 1]!;
    const event = events.find(({ sourceKey }) => sourceKey === revision.sourceKey);
    const receipt = receipts.find(({ sourceKey }) => sourceKey === revision.sourceKey);
    const audit = eventAudits.find(({ entityId }) => entityId === event?.id);
    const task = tasks.find(({ id }) => id === revision.contractESignTaskId);
    const sourceFile = files.find(({ id }) => id === revision.sourceFileId);
    const signedFile = revision.signedFileId
      ? files.find(({ id }) => id === revision.signedFileId)
      : null;
    if (!event || !receipt || !audit || !task || !sourceFile) return false;
    const source = {
      id: revision.sourceId,
      key: revision.sourceKey,
      type: revision.sourceType
    };
    const expectedCommand = {
      actorId: revision.generatedBy,
      archivedAt: revision.archivedAt,
      archivedBy: revision.archivedBy,
      closureCaseId,
      contractESignTaskId: revision.contractESignTaskId,
      documentRevisionId: revision.id,
      documentSnapshot: revision.documentSnapshot,
      documentType: "RETURN_MANIFEST" as const,
      expectedCurrentRevisionId: predecessor?.id ?? null,
      expectedVersion: event.sequence - 2,
      generatedAt: revision.generatedAt,
      handoverWorkOrderId: revision.handoverWorkOrderId,
      signedAt: revision.signedAt,
      signedBy: revision.signedBy,
      signedFileHash: revision.signedFileHash,
      signedFileId: revision.signedFileId,
      source,
      sourceFileHash: revision.sourceFileHash,
      sourceFileId: revision.sourceFileId,
      stage: revision.stage,
      vehicleReturnId: revision.vehicleReturnId
    };
    const expectedOutcome = recoveryAuthorityDocumentOutcome(revision);
    const expectedRequest = returnManifestEsignSnapshot(
      source,
      closureCaseId,
      revision.documentSnapshotHash,
      revision.sourceFileHash,
      revision.sourceFileId,
      revision.revisionNumber
    );
    const documentSnapshot = jsonObject(revision.documentSnapshot);
    const sourceIntroductionIndex = revisions.findIndex(
      ({ sourceFileId }) => sourceFileId === revision.sourceFileId
    );
    const sourceIntroduction = revisions[sourceIntroductionIndex];
    const signedIntroductionIndex = revision.signedFileId
      ? revisions.findIndex(({ signedFileId }) => signedFileId === revision.signedFileId)
      : -1;
    const signedIntroduction =
      signedIntroductionIndex >= 0 ? revisions[signedIntroductionIndex] : null;
    if (!sourceIntroduction || (revision.signedFileId && !signedIntroduction)) return false;
    const expectedSourceObjectKey = `subscription-closure/${closureCaseId}/return-manifest-r${sourceIntroduction.revisionNumber}.json`;
    const expectedSourceName = `${closureCase.caseNo}-return-manifest-r${sourceIntroduction.revisionNumber}.json`;
    const expectedSourceSize = BigInt(
      Buffer.byteLength(canonicalSubscriptionClosureJson(revision.documentSnapshot))
    );
    const expectedResponse = signedFile
      ? {
          signedFile: {
            bucket: signedFile.bucket,
            createdAt: signedFile.createdAt.toISOString(),
            mimeType: signedFile.mimeType,
            objectKey: signedFile.objectKey,
            originalName: signedFile.originalName,
            sizeBytes: signedFile.sizeBytes.toString(),
            uploadedBy: signedFile.uploadedBy
          },
          signedFileHash: revision.signedFileHash,
          signedFileId: revision.signedFileId
        }
      : null;
    const sameSourceAsPredecessor = predecessor?.sourceFileId === revision.sourceFileId;
    const sameSnapshotAsPredecessor =
      predecessor?.documentSnapshotHash === revision.documentSnapshotHash &&
      predecessor?.sourceFileHash === revision.sourceFileHash;
    return (
      revisionIds.includes(revision.id) &&
      revision.revisionNumber === index + 1 &&
      revision.supersedesRevisionId === (predecessor?.id ?? null) &&
      revision.documentSnapshotHash ===
        hashSubscriptionClosureSnapshot(revision.documentSnapshot) &&
      revision.sourceFileHash === revision.documentSnapshotHash &&
      (predecessor === null || sameSourceAsPredecessor === sameSnapshotAsPredecessor) &&
      (revision.stage !== "ARCHIVED" ||
        (sameSourceAsPredecessor &&
          revision.signedFileId === predecessor?.signedFileId &&
          revision.signedFileHash === predecessor?.signedFileHash)) &&
      documentSnapshot.assetWorkOrderId === closureCase.returnAssetWorkOrderId &&
      documentSnapshot.caseNo === closureCase.caseNo &&
      documentSnapshot.closureCaseId === closureCaseId &&
      documentSnapshot.contractId === closureCase.contractId &&
      documentSnapshot.customerId === closureCase.customerId &&
      documentSnapshot.handoverWorkOrderId === closureCase.returnHandoverWorkOrderId &&
      documentSnapshot.orderId === closureCase.orderId &&
      documentSnapshot.vehicleId === closureCase.vehicleId &&
      documentSnapshot.vehicleReturnId === closureCase.vehicleReturnId &&
      event.actorId === revision.generatedBy &&
      event.closureCaseId === closureCaseId &&
      event.beforeStatus === "PREPARING_RETURN" &&
      event.afterStatus === "PREPARING_RETURN" &&
      event.sequence === expectedCommand.expectedVersion + 2 &&
      event.sourceType === revision.sourceType &&
      event.sourceId === revision.sourceId &&
      event.sourceKey === revision.sourceKey &&
      event.occurredAt.getTime() >= revision.generatedAt.getTime() &&
      event.recordedAt.getTime() >= revision.createdAt.getTime() &&
      sameCanonicalReceiptValue(event.detailSnapshot, {
        documentRevisionId: revision.id,
        documentType: "RETURN_MANIFEST",
        revisionNumber: index + 1
      }) &&
      receipt.actorId === revision.generatedBy &&
      receipt.eventId === event.id &&
      receipt.sourceType === revision.sourceType &&
      receipt.sourceId === revision.sourceId &&
      receipt.sourceKey === revision.sourceKey &&
      receipt.payloadHash === hashSubscriptionClosureSnapshot(expectedCommand) &&
      sameCanonicalReceiptValue(receipt.payloadSnapshot, expectedCommand) &&
      sameCanonicalReceiptValue(receipt.outcomeSnapshot, expectedOutcome) &&
      receipt.createdAt.getTime() >= event.recordedAt.getTime() &&
      audit.action === AuditAction.CREATE &&
      audit.entityId === event.id &&
      audit.entityType === "subscription_closure_event" &&
      audit.module === "subscription_closure" &&
      audit.operatorId === revision.generatedBy &&
      audit.beforeSnapshot === null &&
      audit.ipAddress === null &&
      audit.userAgent === null &&
      audit.createdAt.getTime() >= event.recordedAt.getTime() &&
      sameCanonicalReceiptValue(audit.afterSnapshot, {
        action: "CREATE_DOCUMENT_REVISION",
        closureCaseId,
        eventId: event.id,
        outcome: expectedOutcome,
        source
      }) &&
      task.deletedAt === null &&
      task.contractId === closureCase.contractId &&
      task.orderId === closureCase.orderId &&
      task.customerId === closureCase.customerId &&
      task.createdBy === revision.generatedBy &&
      task.updatedBy === revision.generatedBy &&
      task.documentType === ESignDocumentType.DELIVERY_HANDOVER &&
      task.signingStage === ESignSigningStage.STAGE2_DELIVERY_HANDOVER &&
      task.provider === ESignProviderType.OTHER &&
      task.sourceType === revision.sourceType &&
      task.sourceId === revision.sourceId &&
      task.sourceKey === revision.sourceKey &&
      task.id === revision.contractESignTaskId &&
      /^ESG\d{14}[A-HJ-NP-Z2-9]{4}$/.test(task.taskNo) &&
      task.documentName === expectedSourceName &&
      task.documentObjectKey === sourceFile.objectKey &&
      task.providerTaskId === null &&
      task.providerEnvelopeId === null &&
      task.signUrl === null &&
      task.signUrlExpiresAt === null &&
      task.evidenceObjectKey === null &&
      task.callbackSnapshot === null &&
      task.errorSnapshot === null &&
      task.startedAt === null &&
      task.cancelledAt === null &&
      task.failedAt === null &&
      task.createdAt.getTime() === task.updatedAt.getTime() &&
      task.createdAt.getTime() === revision.generatedAt.getTime() &&
      sameCanonicalReceiptValue(task.requestSnapshot, expectedRequest) &&
      (revision.stage === "GENERATED"
        ? task.taskStatus === ESignTaskStatus.CREATED &&
          task.completedAt === null &&
          task.responseSnapshot === null &&
          task.signedDocumentObjectKey === null &&
          signedFile === null
        : task.taskStatus === ESignTaskStatus.COMPLETED &&
          task.completedAt?.getTime() === revision.signedAt?.getTime() &&
          task.signedDocumentObjectKey === signedFile?.objectKey &&
          sameCanonicalReceiptValue(task.responseSnapshot, expectedResponse) &&
          signedFile?.uploadedBy === signedIntroduction?.signedBy) &&
      sourceFile.uploadedBy === sourceIntroduction.generatedBy &&
      sourceFile.bucket === "subscription-closure" &&
      sourceFile.objectKey === expectedSourceObjectKey &&
      sourceFile.originalName === expectedSourceName &&
      sourceFile.mimeType === "application/json" &&
      sourceFile.sizeBytes === expectedSourceSize &&
      sourceFile.createdAt.getTime() === sourceIntroduction.generatedAt.getTime() &&
      (signedFile == null ||
        (signedFile.bucket === "subscription-closure" &&
          signedFile.mimeType === "application/pdf" &&
          signedFile.sizeBytes > 0n &&
          signedFile.objectKey ===
            `subscription-closure/${closureCaseId}/return-manifest-r${signedIntroduction!.revisionNumber}-signed.pdf` &&
          signedFile.originalName ===
            `${closureCase.caseNo}-return-manifest-r${signedIntroduction!.revisionNumber}-signed.pdf` &&
          signedFile.createdAt.getTime() === signedIntroduction!.signedAt?.getTime() &&
          signedFile.uploadedBy === signedIntroduction!.signedBy))
    );
  });
}

async function validateEarlyTerminationAgreementChainInTransaction(
  tx: Prisma.TransactionClient,
  command: ArchiveEarlyTerminationAgreementInput,
  ids: EarlyTerminationAgreementIds,
  sources: EarlyTerminationAgreementSources
): Promise<Omit<ArchivedEarlyTerminationAgreement, "wrote"> | null> {
  const revisions = await tx.subscriptionClosureDocumentRevision.findMany({
    orderBy: { revisionNumber: "asc" },
    where: {
      closureCaseId: command.closureCaseId,
      documentType: "EARLY_TERMINATION_AGREEMENT"
    }
  });
  if (revisions.length === 0) return null;
  if (revisions.length !== 3) throw serviceConflict("AUTHORITY_MISMATCH");
  const generated = revisions.find(({ id }) => id === ids.generatedRevisionId);
  const signed = revisions.find(({ id }) => id === ids.signedRevisionId);
  const archived = revisions.find(({ id }) => id === ids.archivedRevisionId);
  if (!generated || !signed || !archived || !signed.signedAt) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const draft = await resolveEarlyTerminationReplayAgreementDraft(tx, command.closureCaseId);
  const documentSnapshot = earlyTerminationAgreementDocumentSnapshotFromAuthority(
    draft.closureCase
  );
  const canonicalDocument = canonicalSubscriptionClosureJson(documentSnapshot);
  const documentHash = createHash("sha256").update(canonicalDocument).digest("hex");
  const signedEnvelope = earlyTerminationAgreementSignedEnvelope({
    actorId: command.actorId,
    completedAt: signed.signedAt,
    documentSnapshotHash: documentHash,
    signedFileId: ids.signedFileId,
    sourceFileHash: documentHash,
    sourceFileId: ids.sourceFileId,
    sources
  });
  const canonicalSignedEnvelope = canonicalSubscriptionClosureJson(signedEnvelope);
  const signedFileHash = createHash("sha256").update(canonicalSignedEnvelope).digest("hex");
  const [current, sourceFile, signedFile, esignTask, receipts, events] = await Promise.all([
    tx.subscriptionClosureCurrentDocument.findUnique({
      where: {
        closureCaseId_documentType: {
          closureCaseId: command.closureCaseId,
          documentType: "EARLY_TERMINATION_AGREEMENT"
        }
      }
    }),
    tx.fileObject.findUnique({ where: { id: ids.sourceFileId } }),
    tx.fileObject.findUnique({ where: { id: ids.signedFileId } }),
    tx.contractESignTask.findUnique({ where: { id: ids.esignTaskId } }),
    tx.subscriptionClosureCommandReceipt.findMany({
      where: {
        closureCaseId: command.closureCaseId,
        commandType: "CREATE_DOCUMENT_REVISION",
        payloadSnapshot: { equals: "EARLY_TERMINATION_AGREEMENT", path: ["documentType"] }
      }
    }),
    tx.subscriptionClosureEvent.findMany({
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
      where: {
        closureCaseId: command.closureCaseId,
        detailSnapshot: { equals: "EARLY_TERMINATION_AGREEMENT", path: ["documentType"] },
        eventType: "DOCUMENT_REVISION_CREATED"
      }
    })
  ]);
  const audits = await tx.auditLog.findMany({
    where: {
      entityId: { in: events.map(({ id }) => id) },
      entityType: "subscription_closure_event",
      module: "subscription_closure"
    }
  });
  const sourceObjectKey = earlyTerminationAgreementSourceObjectKey(
    command.closureCaseId,
    ids.generatedRevisionId
  );
  const signedObjectKey = earlyTerminationAgreementSignedObjectKey(
    command.closureCaseId,
    ids.signedRevisionId
  );
  const sourceDocumentName = `${draft.closureCase.caseNo}-${ids.generatedRevisionId}-early-termination-agreement.json`;
  const signedDocumentName = `${draft.closureCase.caseNo}-${ids.signedRevisionId}-early-termination-agreement.signed.json`;
  const expectedRequest = earlyTerminationAgreementEsignRequest({
    documentSnapshotHash: documentHash,
    ids,
    sourceFileHash: documentHash,
    sources
  });
  const expectedResponse = earlyTerminationAgreementEsignResponse({
    actorId: command.actorId,
    completedAt: signed.signedAt,
    ids,
    signedFileHash
  });
  const firstEvent = events.find(({ sourceKey }) => sourceKey === sources[0].key);
  const expectedVersion = firstEvent ? firstEvent.sequence - 2 : -1;
  const expectedCommands = earlyTerminationAgreementDocumentCommands({
    actorId: command.actorId,
    closureCaseId: command.closureCaseId,
    databaseClock: generated.generatedAt,
    documentSnapshot,
    expectedVersion,
    ids,
    signedFileHash,
    sourceFileHash: documentHash,
    sources
  });
  const commands = [
    expectedCommands.generated,
    expectedCommands.signed,
    expectedCommands.archived
  ] as const;
  const triples = [
    [generated, sources[0], ids.generatedRevisionId, "GENERATED", null],
    [signed, sources[1], ids.signedRevisionId, "SIGNED", ids.generatedRevisionId],
    [archived, sources[2], ids.archivedRevisionId, "ARCHIVED", ids.signedRevisionId]
  ] as const;
  const lifecycleValid = triples.every(
    ([revision, lifecycleSource, revisionId, stage, supersedesRevisionId], index) => {
      const receipt = receipts.find(({ sourceKey }) => sourceKey === lifecycleSource.key);
      const event = events.find(({ sourceKey }) => sourceKey === lifecycleSource.key);
      const audit = event ? audits.find(({ entityId }) => entityId === event.id) : null;
      const priorEvent =
        index === 0 ? null : events.find(({ sourceKey }) => sourceKey === sources[index - 1]!.key);
      const expectedOutcome = recoveryAuthorityDocumentOutcome(revision);
      const expectedDetail = {
        documentRevisionId: revisionId,
        documentType: "EARLY_TERMINATION_AGREEMENT",
        revisionNumber: index + 1
      };
      const expectedAuditAfter = event
        ? {
            action: "CREATE_DOCUMENT_REVISION",
            closureCaseId: command.closureCaseId,
            eventId: event.id,
            outcome: expectedOutcome,
            source: lifecycleSource
          }
        : null;
      return (
        revision.closureCaseId === command.closureCaseId &&
        revision.id === revisionId &&
        revision.revisionNumber === index + 1 &&
        revision.documentType === "EARLY_TERMINATION_AGREEMENT" &&
        revision.stage === stage &&
        revision.supersedesRevisionId === supersedesRevisionId &&
        revision.contractESignTaskId === ids.esignTaskId &&
        revision.sourceFileId === ids.sourceFileId &&
        revision.sourceFileHash === documentHash &&
        revision.documentSnapshotHash === documentHash &&
        canonicalSubscriptionClosureJson(revision.documentSnapshot as never) ===
          canonicalDocument &&
        revision.generatedBy === command.actorId &&
        revision.generatedAt.getTime() === generated.generatedAt.getTime() &&
        revision.vehicleReturnId === null &&
        revision.handoverWorkOrderId === null &&
        revision.sourceType === lifecycleSource.type &&
        revision.sourceId === lifecycleSource.id &&
        revision.sourceKey === lifecycleSource.key &&
        (index === 0
          ? revision.signedAt === null &&
            revision.signedBy === null &&
            revision.signedFileId === null &&
            revision.signedFileHash === null &&
            revision.archivedAt === null &&
            revision.archivedBy === null
          : revision.signedAt?.getTime() === signed.signedAt!.getTime() &&
            revision.signedBy === command.actorId &&
            revision.signedFileId === ids.signedFileId &&
            revision.signedFileHash === signedFileHash &&
            (index === 1
              ? revision.archivedAt === null && revision.archivedBy === null
              : revision.archivedAt?.getTime() === signed.signedAt!.getTime() &&
                revision.archivedBy === command.actorId)) &&
        receipt?.actorId === command.actorId &&
        receipt.closureCaseId === command.closureCaseId &&
        receipt.commandType === "CREATE_DOCUMENT_REVISION" &&
        receipt.eventId === event?.id &&
        receipt.sourceType === lifecycleSource.type &&
        receipt.sourceId === lifecycleSource.id &&
        receipt.sourceKey === lifecycleSource.key &&
        receipt.payloadHash === hashSubscriptionClosureSnapshot(commands[index]) &&
        sameCanonicalReceiptValue(receipt.payloadSnapshot, commands[index]) &&
        sameCanonicalReceiptValue(receipt.outcomeSnapshot, expectedOutcome) &&
        event?.actorId === command.actorId &&
        event.closureCaseId === command.closureCaseId &&
        event.eventType === "DOCUMENT_REVISION_CREATED" &&
        event.beforeStatus === "PREPARING_RETURN" &&
        event.afterStatus === "PREPARING_RETURN" &&
        event.sequence === expectedVersion + index + 2 &&
        event.sourceType === lifecycleSource.type &&
        event.sourceId === lifecycleSource.id &&
        event.sourceKey === lifecycleSource.key &&
        event.recordedAt.getTime() >= revision.createdAt.getTime() &&
        event.occurredAt.getTime() >= revision.generatedAt.getTime() &&
        (!priorEvent || event.occurredAt.getTime() >= priorEvent.occurredAt.getTime()) &&
        (!priorEvent || event.recordedAt.getTime() >= priorEvent.recordedAt.getTime()) &&
        sameCanonicalReceiptValue(event.detailSnapshot, expectedDetail) &&
        audit?.operatorId === command.actorId &&
        audit.action === AuditAction.CREATE &&
        audit.entityType === "subscription_closure_event" &&
        audit.entityId === event.id &&
        audit.module === "subscription_closure" &&
        audit.beforeSnapshot === null &&
        audit.ipAddress === null &&
        audit.userAgent === null &&
        audit.createdAt.getTime() >= event.recordedAt.getTime() &&
        sameCanonicalReceiptValue(audit.afterSnapshot, expectedAuditAfter)
      );
    }
  );
  if (
    !lifecycleValid ||
    expectedVersion < 0 ||
    events.length !== 3 ||
    receipts.length !== 3 ||
    audits.length !== 3 ||
    current?.closureCaseId !== command.closureCaseId ||
    current.documentType !== "EARLY_TERMINATION_AGREEMENT" ||
    current?.documentRevisionId !== ids.archivedRevisionId ||
    current.updatedBy !== command.actorId ||
    !sourceFile ||
    sourceFile.bucket !== "subscription-closure" ||
    sourceFile.objectKey !== sourceObjectKey ||
    sourceFile.originalName !== sourceDocumentName ||
    sourceFile.mimeType !== "application/json" ||
    sourceFile.sizeBytes !== BigInt(Buffer.byteLength(canonicalDocument)) ||
    sourceFile.uploadedBy !== command.actorId ||
    !signedFile ||
    signedFile.bucket !== "subscription-closure" ||
    signedFile.objectKey !== signedObjectKey ||
    signedFile.originalName !== signedDocumentName ||
    signedFile.mimeType !== "application/json" ||
    signedFile.sizeBytes !== BigInt(Buffer.byteLength(canonicalSignedEnvelope)) ||
    signedFile.uploadedBy !== command.actorId ||
    !esignTask ||
    esignTask.deletedAt !== null ||
    (esignTask.taskStatus !== ESignTaskStatus.COMPLETED &&
      esignTask.taskStatus !== ESignTaskStatus.CANCELLED) ||
    esignTask.contractId !== draft.closureCase.contractId ||
    esignTask.orderId !== draft.closureCase.orderId ||
    esignTask.customerId !== draft.closureCase.customerId ||
    esignTask.createdBy !== command.actorId ||
    esignTask.updatedBy !== command.actorId ||
    esignTask.completedAt?.getTime() !== signed.signedAt.getTime() ||
    esignTask.documentType !== ESignDocumentType.EARLY_TERMINATION_AGREEMENT ||
    esignTask.signingStage !== ESignSigningStage.STAGE4_EARLY_TERMINATION ||
    esignTask.provider !== ESignProviderType.OTHER ||
    esignTask.providerTaskId !== ids.esignProviderTaskId ||
    esignTask.providerEnvelopeId !== ids.esignEnvelopeId ||
    esignTask.documentObjectKey !== sourceObjectKey ||
    esignTask.signedDocumentObjectKey !== signedObjectKey ||
    esignTask.sourceType !== sources[2].type ||
    esignTask.sourceId !== sources[2].id ||
    esignTask.sourceKey !== sources[2].key ||
    !sameCanonicalReceiptValue(esignTask.requestSnapshot, expectedRequest) ||
    !sameCanonicalReceiptValue(esignTask.responseSnapshot, expectedResponse) ||
    !(await validateEarlyTerminationAgreementTaskSuccessor(
      tx,
      draft.closureCase.id,
      esignTask,
      command.actorId
    ))
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  return Object.freeze({
    archivedRevisionId: ids.archivedRevisionId,
    generatedRevisionId: ids.generatedRevisionId,
    signedFileHash,
    signedFileId: ids.signedFileId,
    signedRevisionId: ids.signedRevisionId
  });
}

async function readDatabaseClock(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "now"
  `);
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw serviceConflict("CLOCK_UNAVAILABLE");
  }
  return now;
}

async function readSettlementLifecycleClock(
  tx: Prisma.TransactionClient,
  closureCaseId: string
): Promise<{ clockTimestamp: Date; latestOccurredAt: Date | null }> {
  const rows = await tx.$queryRaw<
    Array<{ clockTimestamp: Date; latestOccurredAt: Date | null }>
  >(Prisma.sql`
    SELECT clock_timestamp() AS "clockTimestamp",
           (
             SELECT MAX("occurred_at")
             FROM "subscription_closure_event"
             WHERE "closure_case_id" = ${closureCaseId}::uuid
           ) AS "latestOccurredAt"
  `);
  const boundary = rows[0];
  if (
    !(boundary?.clockTimestamp instanceof Date) ||
    Number.isNaN(boundary.clockTimestamp.getTime()) ||
    (boundary.latestOccurredAt !== null &&
      (!(boundary.latestOccurredAt instanceof Date) ||
        Number.isNaN(boundary.latestOccurredAt.getTime())))
  ) {
    throw serviceConflict("CLOCK_UNAVAILABLE");
  }
  return boundary;
}

function serviceConflict(code: keyof typeof SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE) {
  return new ConflictException({
    code: SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE[code],
    message: "The governed normal-expiry authority is unavailable or changed."
  });
}

function assertEarlyTerminationInitiationSurface(input: InitiateEarlyTerminationInput): void {
  const allowed = new Set([
    "actorId",
    "effectiveAt",
    "evidence",
    "idempotencyKey",
    "orderId",
    "reason"
  ]);
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.has(key))
  ) {
    throw serviceConflict("EARLY_TERMINATION_CLIENT_AUTHORITY_FORBIDDEN");
  }
}

function normalizeEarlyTerminationInitiation(
  input: InitiateEarlyTerminationInput
): NormalizedEarlyTerminationInitiation {
  assertEarlyTerminationInitiationSurface(input);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const idempotencyKey =
    typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (
    !reason ||
    reason.length > 2_000 ||
    !idempotencyKey ||
    idempotencyKey.length > 120 ||
    !Array.isArray(input.evidence) ||
    input.evidence.length > 20
  ) {
    throw serviceConflict("CAPABILITY_INVALID");
  }
  const evidence = input.evidence.map((item) => {
    const keys = item && typeof item === "object" && !Array.isArray(item) ? Object.keys(item) : [];
    const type = typeof item?.type === "string" ? item.type.trim() : "";
    const reference = typeof item?.reference === "string" ? item.reference.trim() : "";
    if (
      keys.some((key) => key !== "type" && key !== "reference") ||
      !type ||
      type.length > 64 ||
      !reference ||
      reference.length > 512
    ) {
      throw serviceConflict("CAPABILITY_INVALID");
    }
    return Object.freeze({ reference, type });
  });
  return deepFreezeReceipt({
    actorId: canonicalUuid(input.actorId),
    effectiveAt: validDate(input.effectiveAt),
    evidence,
    idempotencyKey,
    orderId: canonicalUuid(input.orderId),
    reason
  });
}

function closureSourceConflict() {
  return new ConflictException({
    code: SUBSCRIPTION_CLOSURE_ERROR_CODE.SOURCE_CONFLICT,
    message: "The stable subscription-closure source is bound to a different receipt payload."
  });
}
