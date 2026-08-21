import { BadRequestException, ConflictException, Injectable, Optional } from "@nestjs/common";
import {
  AssetWorkOrderStatus,
  AuditAction,
  ContractStatus,
  ESignDocumentType,
  ESignProviderType,
  ESignSigningStage,
  ESignTaskStatus,
  LeaseStatus,
  OrderStatus,
  Prisma,
  UserStatus,
  VehicleCostActionType,
  VehicleMileageReadingStatus,
  VehicleMileageSourceType,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
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
  type AppendCostServiceCommand
} from "../asset-accounting/asset-accounting.service";
import { AssetFactsService } from "../asset-facts/asset-facts.service";
import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import {
  VehicleMileageService,
  type VehicleMileageTransactionCapability
} from "../vehicle-mileage/vehicle-mileage.service";
import {
  HandoverWorkOrderService,
  type PreparedGovernedReturnInboundUpdateCapability,
  type PreparedReturnInboundCapability
} from "../handover-work-order/handover-work-order.service";
import { canonicalSubscriptionClosureJson } from "./subscription-closure.domain";
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
  SubscriptionClosureSettlementSnapshot,
  SubscriptionClosureSource
} from "./subscription-closure.types";
import {
  SubscriptionClosureSettlementResolver,
  type ResolvedSubscriptionClosureSettlement
} from "./subscription-closure.settlement-resolver";

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
  SETTLEMENT_FACT_DRIFT: "SUBSCRIPTION_CLOSURE_SETTLEMENT_FACT_DRIFT",
  SETTLEMENT_NOT_RESOLVED: "SUBSCRIPTION_CLOSURE_SETTLEMENT_NOT_RESOLVED",
  SETTLEMENT_STATUS_CONFLICT: "SUBSCRIPTION_CLOSURE_SETTLEMENT_STATUS_CONFLICT"
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
    const currentCase = await tx.subscriptionClosureCase.findUnique({
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
      where: { orderId: command.orderId }
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
    const authorityAttestations = await this.repository.prepareAuthorityInTransaction(
      tx,
      authoritySession,
      locks,
      [
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
        )
      ]
    );
    const lockedAuthority = await this.loadNormalExpiryAuthority(
      tx,
      command,
      currentCase?.createdBy
    );
    if (!sameAuthority(authority, lockedAuthority)) throw serviceConflict("AUTHORITY_MISMATCH");
    const lockedCase = await tx.subscriptionClosureCase.findUnique({
      select: { effectiveAt: true, id: true },
      where: { orderId: authority.orderId }
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
    return Object.freeze({
      closureCaseId: createdCase.outcome.id,
      returnAssetWorkOrderId: common.workOrder.id,
      returnHandoverWorkOrderId: specialist.id,
      returnManifestRevisionId: manifest.id
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
    const observedCase = await tx.subscriptionClosureCase.findUnique({
      select: {
        closureType: true,
        id: true,
        physicalControlMode: true,
        returnHandoverWorkOrderId: true,
        vehicleReturnId: true
      },
      where: { orderId: command.orderId }
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
      observedCase.closureType !== "NORMAL_COMPLETION" ||
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
    const closureCase = await tx.subscriptionClosureCase.findUnique({
      select: {
        closureType: true,
        id: true,
        physicalControlMode: true,
        returnHandoverWorkOrderId: true,
        vehicleReturnId: true
      },
      where: { orderId: command.orderId }
    });
    if (
      !closureCase ||
      closureCase.id !== observedCase?.id ||
      closureCase.closureType !== "NORMAL_COMPLETION" ||
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
    const receiptSource = physicalSource(
      closureCase.id,
      `physical-receipt:${command.physicalControlMode}`
    );
    const periodSource = physicalSource(
      closureCase.id,
      `physical-period-close:${command.physicalControlMode}`
    );
    const workOrderSource = physicalSource(
      closureCase.id,
      `physical-work-order:${command.physicalControlMode}`
    );
    const restrictionSource = physicalSource(closureCase.id, "return-inspection-restriction");
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
      }
    ].sort((left, right) =>
      bytewiseCompare(sourceSortKey(left.source), sourceSortKey(right.source))
    );
    for (const preparation of preparations) await preparation.prepare();
    if (
      !receiptSourceCapability ||
      !periodCapability ||
      !workOrderCapability ||
      !restrictionCapability ||
      !mileageCapability
    ) {
      throw serviceConflict("MANAGED_RETURN_CAPABILITY_INVALID");
    }

    assertPhysicalReceiptObservedAuthority(observed, command);
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
      expectedVersion:
        closureCase.status === "RETURN_INSPECTION" ? closureCase.version - 1 : closureCase.version,
      occurredAt: command.returnedAt,
      source: receiptSource
    };
    const periodAuthority = {
      contractId: period.contractId,
      contractSegmentId: period.contractSegmentId,
      customerId: period.customerId,
      orderId: period.orderId,
      periodId: period.id,
      vehicleId: period.vehicleId
    };
    const authoritySession = this.repository.createAuthoritySessionInTransaction(tx);
    const attestations = await this.repository.prepareAuthorityInTransaction(
      tx,
      authoritySession,
      physicalReceiptLocks(observed, command.actorId),
      [
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
        )
      ]
    );
    const locked = await loadPhysicalReceiptAuthority(tx, command.orderId);
    if (physicalReceiptAuthorityIdentity(observed) !== physicalReceiptAuthorityIdentity(locked)) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    if (locked.closureCase!.status === "RETURN_INSPECTION") {
      assertExactPhysicalReceiptReplay(locked, command, receiptSource);
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

    const terminalSource =
      targetStage === "SETTLED"
        ? physicalSource(command.closureCaseId, `${command.idempotencyKey}:closure`)
        : null;
    const approvalInputs = await this.settlementApprovalInputs(
      tx,
      command,
      observedResolution,
      settlementSource
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
    const terminalOccurredAt =
      targetStage === "SETTLED" ? await readSettlementEventClock(tx, command.closureCaseId) : null;
    const settlementCommand = settlementRevisionCommand(
      command,
      observedCase!,
      observedResolution,
      settlementSource,
      targetStage,
      terminalOccurredAt
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
            occurredAt: terminalOccurredAt!,
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
    settlementSource: SubscriptionClosureSource
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
            expiredAt: command.occurredAt,
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

  private closureAudit(actorId: string): SubscriptionClosureMutationAuditHook {
    return async (tx, mutation) => {
      await this.auditService.write(
        {
          action: AuditAction.CREATE,
          after: mutation,
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

async function loadPhysicalReceiptAuthority(tx: Prisma.TransactionClient, orderId: string) {
  const [closureCase, order, vehicleReturn, lease, period] = await Promise.all([
    tx.subscriptionClosureCase.findUnique({ where: { orderId } }),
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
  const [vehicle, workOrder, currentDocument, managedHandovers] = await Promise.all([
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
        })
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

function assertPhysicalReceiptObservedAuthority(
  authority: PhysicalReceiptAuthority,
  command: ConfirmManagedPhysicalReceiptInput
) {
  const { closureCase, lease, order, period, vehicle, vehicleReturn, workOrder } = authority;
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
    vehicleReturn.id !== closureCase.vehicleReturnId ||
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
    period.customerId !== order.customerId
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const replay = closureCase.status === "RETURN_INSPECTION";
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
    esignTask.documentType !== ESignDocumentType.DELIVERY_HANDOVER ||
    esignTask.signingStage !== ESignSigningStage.STAGE2_DELIVERY_HANDOVER ||
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
  const snapshotHash = createHash("sha256")
    .update(canonicalSubscriptionClosureJson(serverSnapshot))
    .digest("hex");
  if (
    !approval ||
    approval.requestedBy === approval.decidedBy ||
    approval.decision !== "APPROVED" ||
    !approval.decidedAt ||
    approval.subjectSnapshotHash !== snapshotHash ||
    canonicalSubscriptionClosureJson(approval.subjectSnapshot as never) !==
      canonicalSubscriptionClosureJson(serverSnapshot)
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

function assertExactPhysicalReceiptReplay(
  authority: PhysicalReceiptAuthority,
  command: ConfirmManagedPhysicalReceiptInput,
  source: SubscriptionClosureSource
) {
  const expectedPayload = physicalReceiptPayload(command);
  const expectedPayloadHash = hashPhysicalReceiptPayload(expectedPayload);
  const event = authority.receiptEvent;
  const receipt = event?.commandReceipt;
  const detail = event?.detailSnapshot;
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
  if (
    !event ||
    !receipt ||
    event.sourceType !== source.type ||
    event.sourceId !== source.id ||
    event.sourceKey !== source.key ||
    receipt.sourceType !== source.type ||
    receipt.sourceId !== source.id ||
    receipt.sourceKey !== source.key ||
    !detail ||
    Array.isArray(detail) ||
    typeof detail !== "object" ||
    !sameCanonicalReceiptValue(detail.receiptPayload, expectedPayload) ||
    detail.receiptPayloadHash !== expectedPayloadHash ||
    receipt.payloadHash !==
      createHash("sha256")
        .update(canonicalSubscriptionClosureJson(receipt.payloadSnapshot as never))
        .digest("hex") ||
    vehicleReturn.returnedAt?.getTime() !== command.returnedAt.getTime() ||
    vehicleReturn.returnMileageKm !== command.returnMileageKm ||
    vehicleReturn.returnType !== command.returnType ||
    vehicleReturn.remark !== command.remark ||
    vehicleReturn.damageFound !== expectedPayload.damages.length > 0 ||
    !sameCanonicalReceiptValue(
      vehicleReturn.checklistSnapshot,
      expectedPayload.checklistSnapshot
    ) ||
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
      expectedCurrentRevisionId: null,
      expectedVersion: 0,
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
        command.sourceFileHash
      ),
      signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
      sourceId: command.source.id,
      sourceKey: command.source.key,
      sourceType: command.source.type,
      taskNo: createBusinessNo("ESG"),
      taskStatus: ESignTaskStatus.CREATED,
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
    snapshotHash
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
  documentSnapshotHash: string
) {
  return {
    closureCaseId,
    documentSnapshotHash,
    documentType: "RETURN_MANIFEST",
    returnManifestSource: documentSource,
    revisionNumber: 1
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
      finalizedAt?: Date | string | null;
      finalizedBy?: string | null;
    }> | null;
    currentSettlementRevisionId: string | null;
    version: number;
  }>,
  resolution: ResolvedSubscriptionClosureSettlement,
  source: SubscriptionClosureSource,
  targetStage: "PROPOSED" | "FINALIZED" | "SETTLED",
  recordedAt: Date | null
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
    ...(recordedAt ? { recordedAt } : {}),
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

function sameAuthority(left: NormalExpiryAuthority, right: NormalExpiryAuthority) {
  return canonicalSubscriptionClosureJson(left) === canonicalSubscriptionClosureJson(right);
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

async function readSettlementEventClock(tx: Prisma.TransactionClient, closureCaseId: string) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT GREATEST(
      clock_timestamp(),
      COALESCE(
        (
          SELECT MAX("occurred_at")
          FROM "subscription_closure_event"
          WHERE "closure_case_id" = ${closureCaseId}::uuid
        ),
        '-infinity'::timestamptz
      )
    ) AS "now"
  `);
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw serviceConflict("CLOCK_UNAVAILABLE");
  }
  return now;
}

function serviceConflict(code: keyof typeof SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE) {
  return new ConflictException({
    code: SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE[code],
    message: "The governed normal-expiry authority is unavailable or changed."
  });
}

function closureSourceConflict() {
  return new ConflictException({
    code: SUBSCRIPTION_CLOSURE_ERROR_CODE.SOURCE_CONFLICT,
    message: "The stable subscription-closure source is bound to a different receipt payload."
  });
}
