import { ConflictException, Injectable } from "@nestjs/common";
import {
  AuditAction,
  ESignDocumentType,
  ESignProviderType,
  ESignSigningStage,
  ESignTaskStatus,
  Prisma,
  UserStatus
} from "@prisma/client";
import { createHash } from "node:crypto";

import { AssetOperationsService } from "../asset-operations/asset-operations.service";
import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-number";
import { HandoverWorkOrderService } from "../handover-work-order/handover-work-order.service";
import type { GovernedReturnInboundUpdateCapability } from "../handover-work-order/handover-work-order.service";
import { canonicalSubscriptionClosureJson } from "./subscription-closure.domain";
import {
  SubscriptionClosureRepository,
  type SubscriptionClosureMutationAuditHook
} from "./subscription-closure.repository";
import type { SubscriptionClosureSource } from "./subscription-closure.types";

export const SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE = {
  AUTHORITY_MISMATCH: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_MISMATCH",
  AUTHORITY_NOT_FOUND: "SUBSCRIPTION_CLOSURE_EXPIRY_AUTHORITY_NOT_FOUND",
  CAPABILITY_INVALID: "SUBSCRIPTION_CLOSURE_EXPIRY_CAPABILITY_INVALID",
  CLOCK_UNAVAILABLE: "SUBSCRIPTION_CLOSURE_DOCUMENT_CLOCK_UNAVAILABLE",
  MANAGED_RETURN_AUTHORITY_NOT_FOUND: "SUBSCRIPTION_CLOSURE_MANAGED_RETURN_AUTHORITY_NOT_FOUND",
  MANAGED_RETURN_CAPABILITY_INVALID: "SUBSCRIPTION_CLOSURE_MANAGED_RETURN_CAPABILITY_INVALID"
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
  assetCapability: unknown;
  assetSource: SubscriptionClosureSource;
  authority: NormalExpiryAuthority;
  caseSource: SubscriptionClosureSource;
  documentSource: SubscriptionClosureSource;
  handoverCapability: unknown;
  handoverSource: SubscriptionClosureSource;
  input: PrepareNormalExpiryInput;
  occurredAt: Date;
  transaction: Prisma.TransactionClient;
}>;

type ManagedReturnCapabilityState = Readonly<{
  command: PrepareManagedReturnInput;
  handoverCapability: GovernedReturnInboundUpdateCapability;
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
    private readonly auditService: AuditService
  ) {}

  async prepareNormalExpiryInTransaction(
    tx: Prisma.TransactionClient,
    input: PrepareNormalExpiryInput
  ): Promise<NormalExpiryTransactionCapability> {
    const command = normalizePrepareInput(input);
    const authority = await this.loadNormalExpiryAuthority(tx, command);
    const handoverSource = source(command.segmentId, "return-inbound-handover");
    const assetSource = source(command.segmentId, "return-inbound-asset-work-order");
    const caseSource = source(command.segmentId, "normal-closure-case");
    const documentSource = source(command.segmentId, "return-manifest:1");
    const handoverCapability = await this.handoverWorkOrders.prepareReturnInboundInTransaction(tx, {
      actorId: authority.actorId,
      orderId: authority.orderId,
      source: handoverSource
    });
    const assetCapability = await this.assetOperations.prepareCallerOwnedTransaction(
      tx,
      assetSource
    );
    await this.repository.lockSourceOwnership(tx, caseSource);
    await this.repository.lockSourceOwnership(tx, documentSource);

    const currentCase = await tx.subscriptionClosureCase.findUnique({
      select: { effectiveAt: true, id: true },
      where: { orderId: authority.orderId }
    });
    const currentReturn = await tx.vehicleReturn.findUnique({
      select: { id: true },
      where: { orderId: authority.orderId }
    });
    await this.repository.lockAuthorityRows(tx, [
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
      { id: authority.customerId, mode: "SHARE", table: "customer" },
      { id: authority.actorId, mode: "SHARE", table: "user" }
    ]);
    const lockedAuthority = await this.loadNormalExpiryAuthority(tx, command);
    if (!sameAuthority(authority, lockedAuthority)) throw serviceConflict("AUTHORITY_MISMATCH");
    const lockedCase = await tx.subscriptionClosureCase.findUnique({
      select: { effectiveAt: true, id: true },
      where: { orderId: authority.orderId }
    });
    if (lockedCase?.id !== currentCase?.id) throw serviceConflict("AUTHORITY_MISMATCH");

    const capability = Object.freeze({}) as NormalExpiryTransactionCapability;
    this.normalExpiryCapabilities.set(
      capability,
      Object.freeze({
        assetCapability,
        assetSource,
        authority: lockedAuthority,
        caseSource,
        documentSource,
        handoverCapability,
        handoverSource,
        input: command,
        occurredAt: lockedCase ? new Date(lockedCase.effectiveAt) : command.decisionAt,
        transaction: tx
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
      state.input.decisionAt.getTime() !== command.decisionAt.getTime()
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

    const specialist = await this.handoverWorkOrders.createReturnInboundInTransaction(
      tx,
      {
        actorId: state.authority.actorId,
        orderId: state.authority.orderId,
        source: state.handoverSource
      },
      state.handoverCapability as never
    );
    const common = await this.assetOperations.createWorkOrderInTransaction(
      tx,
      {
        assetOwnerId: null,
        contractId: state.authority.contractId,
        costConfirmationRequired: false,
        customerId: state.authority.customerId,
        description: `Normal-expiry return inbound for ${state.authority.orderNo}`,
        metadata: {
          closureIntent: "NORMAL_COMPLETION",
          segmentId: state.authority.segmentId,
          vehicleReturnId: vehicleReturn.id
        },
        occurredAt: state.occurredAt,
        orderId: state.authority.orderId,
        priority: "NORMAL",
        relatedWorkOrderId: null,
        source: state.assetSource,
        vehicleId: state.authority.vehicleId,
        workOrderType: "RETURN_INBOUND"
      },
      {
        actorId: state.authority.actorId,
        permissions: [],
        userAgent: "subscription-expiry"
      },
      state.assetCapability as never
    );
    const createdCase = await this.repository.createCase(
      tx,
      {
        actorId: state.authority.actorId,
        authoritySnapshot: {
          actorAuthority: "CONTRACT_SEGMENT_OR_ORDER",
          contractId: state.authority.contractId,
          customerId: state.authority.customerId,
          decisionAt: state.occurredAt,
          orderId: state.authority.orderId,
          segmentEndDate: state.authority.segmentEndDate,
          segmentId: state.authority.segmentId,
          vehicleId: state.authority.vehicleId,
          vehicleReturnId: vehicleReturn.id
        },
        closureType: "NORMAL_COMPLETION",
        contractId: state.authority.contractId,
        customerId: state.authority.customerId,
        effectiveAt: state.occurredAt,
        finalDisposition: "COMPLETE",
        orderId: state.authority.orderId,
        physicalControlMode: "VOLUNTARY_RETURN",
        returnAssetWorkOrderId: common.workOrder.id,
        returnHandoverWorkOrderId: specialist.id,
        source: state.caseSource,
        vehicleId: state.authority.vehicleId,
        vehicleReturnId: vehicleReturn.id
      },
      this.closureAudit(state.authority.actorId)
    );
    const currentManifest = await tx.subscriptionClosureCurrentDocument.findUnique({
      include: { documentRevision: true },
      where: {
        closureCaseId_documentType: {
          closureCaseId: createdCase.outcome.id,
          documentType: "RETURN_MANIFEST"
        }
      }
    });
    const manifest = currentManifest
      ? await this.replayFirstManifest(tx, state, currentManifest.documentRevision)
      : await this.createFirstManifest(
          tx,
          state,
          createdCase.outcome.id,
          createdCase.outcome.caseNo,
          vehicleReturn.id,
          specialist.id,
          common.workOrder.id
        );
    return Object.freeze({
      closureCaseId: createdCase.outcome.id,
      returnAssetWorkOrderId: common.workOrder.id,
      returnHandoverWorkOrderId: specialist.id,
      returnManifestRevisionId: manifest.id
    });
  }

  async prepareManagedReturnInTransaction(
    tx: Prisma.TransactionClient,
    input: PrepareManagedReturnInput
  ): Promise<ManagedReturnTransactionCapability | null> {
    const command = normalizeManagedReturnInput(input);
    await this.repository.lockSourceOwnership(tx, {
      id: command.orderId,
      key: "legacy-prepare-return",
      type: "SUBSCRIPTION_CLOSURE"
    });
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
    await this.repository.lockAuthorityRows(tx, [
      ...(observedCase
        ? [
            {
              id: observedCase.id,
              mode: "UPDATE" as const,
              table: "subscription_closure_case" as const
            }
          ]
        : []),
      { id: command.orderId, mode: "UPDATE", table: "subscription_order" },
      ...(observedCase?.vehicleReturnId
        ? [
            {
              id: observedCase.vehicleReturnId,
              mode: "UPDATE" as const,
              table: "vehicle_return" as const
            }
          ]
        : []),
      ...(observedCase?.returnHandoverWorkOrderId
        ? [
            {
              id: observedCase.returnHandoverWorkOrderId,
              mode: "UPDATE" as const,
              table: "vehicle_handover_work_order" as const
            }
          ]
        : []),
      { id: command.actorId, mode: "SHARE", table: "user" }
    ]);
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
    if (!closureCase) return null;
    if (
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
    const handoverCommand = {
      actorId: command.actorId,
      deliveryLocation: command.returnLocation,
      orderId: command.orderId,
      scheduledAt: command.scheduledAt,
      source: {
        id: closureCase.id,
        key: "legacy-prepare-return",
        type: "SUBSCRIPTION_CLOSURE"
      },
      workOrderId: handoverWorkOrder.id
    };
    const handoverCapability =
      await this.handoverWorkOrders.prepareGovernedReturnInboundUpdateInTransaction(
        tx,
        handoverCommand
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
    await this.handoverWorkOrders.updateGovernedReturnInboundInTransaction(
      tx,
      {
        actorId: state.command.actorId,
        deliveryLocation: state.command.returnLocation,
        orderId: state.command.orderId,
        scheduledAt: state.command.scheduledAt,
        source: {
          id: await this.caseIdForManagedReturn(tx, state.command.orderId),
          key: "legacy-prepare-return",
          type: "SUBSCRIPTION_CLOSURE"
        },
        workOrderId: state.handoverWorkOrderId
      },
      state.handoverCapability
    );
    return Object.freeze({ handoverWorkOrderId: state.handoverWorkOrderId });
  }

  private async caseIdForManagedReturn(tx: Prisma.TransactionClient, orderId: string) {
    const closureCase = await tx.subscriptionClosureCase.findUnique({
      select: { id: true },
      where: { orderId }
    });
    if (!closureCase) throw serviceConflict("MANAGED_RETURN_AUTHORITY_NOT_FOUND");
    return closureCase.id;
  }

  private async createFirstManifest(
    tx: Prisma.TransactionClient,
    state: NormalExpiryCapabilityState,
    closureCaseId: string,
    caseNo: string,
    vehicleReturnId: string,
    handoverWorkOrderId: string,
    assetWorkOrderId: string
  ) {
    const generatedAt = await readDatabaseClock(tx);
    const documentSnapshot = {
      assetWorkOrderId,
      caseNo,
      closureCaseId,
      contractId: state.authority.contractId,
      customerId: state.authority.customerId,
      documentType: "RETURN_MANIFEST",
      handoverWorkOrderId,
      orderId: state.authority.orderId,
      segmentId: state.authority.segmentId,
      vehicleId: state.authority.vehicleId,
      vehicleReturnId
    } as const;
    const canonicalManifest = canonicalSubscriptionClosureJson(documentSnapshot);
    const sourceFileHash = createHash("sha256").update(canonicalManifest).digest("hex");
    const objectKey = `subscription-closure/${closureCaseId}/return-manifest-r1.json`;
    const sourceFile = await tx.fileObject.create({
      data: {
        bucket: "subscription-closure",
        mimeType: "application/json",
        objectKey,
        originalName: `${caseNo}-return-manifest-r1.json`,
        sizeBytes: BigInt(Buffer.byteLength(canonicalManifest)),
        uploadedBy: state.authority.actorId
      }
    });
    const esignTask = await tx.contractESignTask.create({
      data: {
        contractId: state.authority.contractId,
        createdBy: state.authority.actorId,
        customerId: state.authority.customerId,
        documentName: `${caseNo}-return-manifest-r1.json`,
        documentObjectKey: objectKey,
        documentType: ESignDocumentType.DELIVERY_HANDOVER,
        orderId: state.authority.orderId,
        provider: ESignProviderType.OTHER,
        requestSnapshot: {
          closureCaseId,
          documentSnapshotHash: sourceFileHash,
          documentType: "RETURN_MANIFEST",
          revisionNumber: 1
        },
        signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
        taskNo: createBusinessNo("ESG"),
        taskStatus: ESignTaskStatus.CREATED,
        updatedBy: state.authority.actorId
      }
    });
    return (
      await this.repository.appendDocumentRevision(
        tx,
        {
          actorId: state.authority.actorId,
          archivedAt: null,
          archivedBy: null,
          closureCaseId,
          contractESignTaskId: esignTask.id,
          documentSnapshot,
          documentType: "RETURN_MANIFEST",
          expectedCurrentRevisionId: null,
          expectedVersion: 0,
          generatedAt,
          handoverWorkOrderId,
          signedAt: null,
          signedBy: null,
          signedFileHash: null,
          signedFileId: null,
          source: state.documentSource,
          sourceFileHash,
          sourceFileId: sourceFile.id,
          stage: "GENERATED",
          vehicleReturnId
        },
        this.closureAudit(state.authority.actorId)
      )
    ).outcome;
  }

  private async replayFirstManifest(
    tx: Prisma.TransactionClient,
    state: NormalExpiryCapabilityState,
    revision: {
      archivedAt: Date | null;
      archivedBy: string | null;
      closureCaseId: string;
      contractESignTaskId: string;
      documentSnapshot: Prisma.JsonValue;
      documentType: "RETURN_MANIFEST" | "EARLY_TERMINATION_AGREEMENT" | "RECOVERY_AUTHORITY";
      generatedAt: Date;
      handoverWorkOrderId: string | null;
      id: string;
      signedAt: Date | null;
      signedBy: string | null;
      signedFileHash: string | null;
      signedFileId: string | null;
      sourceFileHash: string;
      sourceFileId: string;
      stage: "GENERATED" | "SIGNED" | "ARCHIVED";
      vehicleReturnId: string | null;
    }
  ) {
    if (
      revision.documentType !== "RETURN_MANIFEST" ||
      !revision.vehicleReturnId ||
      !revision.handoverWorkOrderId
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    return (
      await this.repository.appendDocumentRevision(
        tx,
        {
          actorId: state.authority.actorId,
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
          source: state.documentSource,
          sourceFileHash: revision.sourceFileHash,
          sourceFileId: revision.sourceFileId,
          stage: revision.stage,
          vehicleReturnId: revision.vehicleReturnId
        },
        this.closureAudit(state.authority.actorId)
      )
    ).outcome;
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
    input: PrepareNormalExpiryInput
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
    const actorCandidates = [
      ...new Set(
        [segment.createdBy, order.updatedBy, order.createdBy].filter((value): value is string =>
          Boolean(value)
        )
      )
    ];
    let actor: { id: string } | null = null;
    for (const actorId of actorCandidates) {
      actor = await tx.user.findFirst({
        select: { id: true },
        where: { deletedAt: null, id: actorId, status: UserStatus.ACTIVE }
      });
      if (actor) break;
    }
    if (!actor) throw serviceConflict("AUTHORITY_NOT_FOUND");
    return Object.freeze({
      actorId: actor.id,
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

function source(segmentId: string, key: string): SubscriptionClosureSource {
  return Object.freeze({ id: segmentId, key, type: "SUBSCRIPTION_EXPIRY" });
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

function serviceConflict(code: keyof typeof SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE) {
  return new ConflictException({
    code: SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE[code],
    message: "The governed normal-expiry authority is unavailable or changed."
  });
}
