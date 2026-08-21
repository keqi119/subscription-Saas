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

import {
  AssetOperationsService,
  type AssetOperationsTransactionCapability
} from "../asset-operations/asset-operations.service";
import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-number";
import {
  HandoverWorkOrderService,
  type PreparedGovernedReturnInboundUpdateCapability,
  type PreparedReturnInboundCapability
} from "../handover-work-order/handover-work-order.service";
import { canonicalSubscriptionClosureJson } from "./subscription-closure.domain";
import {
  SubscriptionClosureRepository,
  type ClosureAuthorityAttestation,
  type PreparedClosureSourceCapability,
  type SubscriptionClosureAuthorityLock,
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
  assetCapability: AssetOperationsTransactionCapability;
  assetSource: SubscriptionClosureSource;
  authorityAttestations: ReadonlyMap<string, ClosureAuthorityAttestation>;
  authority: NormalExpiryAuthority;
  caseSource: SubscriptionClosureSource;
  caseSourceCapability: PreparedClosureSourceCapability;
  documentSource: SubscriptionClosureSource;
  documentSourceCapability: PreparedClosureSourceCapability;
  handoverCapability: PreparedReturnInboundCapability;
  handoverSource: SubscriptionClosureSource;
  input: PrepareNormalExpiryInput;
  occurredAt: Date;
  transaction: Prisma.TransactionClient;
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
    private readonly auditService: AuditService
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
    ].sort((left, right) => sourceSortKey(left.source).localeCompare(sourceSortKey(right.source)));
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
    const [changes, considerations, currentManifest, existingEsignTask] = await Promise.all([
      tx.subscriptionChangeOrder.findMany({
        select: { id: true },
        where: { sourceSegmentId: command.segmentId }
      }),
      tx.renewalConsideration.findMany({
        select: { id: true },
        where: { segmentId: command.segmentId }
      }),
      currentCase
        ? tx.subscriptionClosureCurrentDocument.findUnique({
            include: { documentRevision: true },
            where: {
              closureCaseId_documentType: {
                closureCaseId: currentCase.id,
                documentType: "RETURN_MANIFEST"
              }
            }
          })
        : null,
      tx.contractESignTask.findFirst({
        select: { id: true },
        where: { contractId: authority.contractId, deletedAt: null }
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
      ...(existingEsignTask
        ? [
            {
              id: existingEsignTask.id,
              mode: "SHARE" as const,
              table: "contract_esign_task" as const
            }
          ]
        : []),
      { id: authority.customerId, mode: "SHARE", table: "customer" },
      { id: authority.actorId, mode: "SHARE", table: "user" }
    ];
    const authorityAttestations = await this.repository.prepareAuthorityInTransaction(tx, locks, [
      "asset-create",
      "case-create",
      "handover-create",
      "manifest-create"
    ]);
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
    await this.repository.consumeAuthorityAttestationInTransaction(
      tx,
      requiredAttestation(authorityAttestations, "handover-create"),
      "handover-create"
    );
    const handoverCapability =
      await this.handoverWorkOrders.attestReturnInboundAuthorityInTransaction(
        tx,
        {
          actorId: lockedAuthority.actorId,
          orderId: lockedAuthority.orderId,
          source: handoverSource
        },
        handoverSourceCapability as never
      );

    const capability = Object.freeze({}) as NormalExpiryTransactionCapability;
    this.normalExpiryCapabilities.set(
      capability,
      Object.freeze({
        assetCapability,
        assetSource,
        authorityAttestations,
        authority: lockedAuthority,
        caseSource,
        caseSourceCapability,
        documentSource,
        documentSourceCapability,
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

    const assetCommand = {
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
      priority: "NORMAL" as const,
      relatedWorkOrderId: null,
      source: state.assetSource,
      vehicleId: state.authority.vehicleId,
      workOrderType: "RETURN_INBOUND" as const
    };
    const assetContext = {
      actorId: state.authority.actorId,
      permissions: [],
      userAgent: "subscription-expiry"
    } as const;
    await this.repository.consumeAuthorityAttestationInTransaction(
      tx,
      requiredAttestation(state.authorityAttestations, "asset-create"),
      "asset-create"
    );
    const preparedAsset = await this.assetOperations.attestCallerOwnedCreateAuthorityInTransaction(
      tx,
      assetCommand,
      assetContext,
      state.assetCapability
    );
    const specialist = await this.handoverWorkOrders.createPreparedReturnInboundInTransaction(
      tx,
      state.handoverCapability
    );
    const common = await this.assetOperations.createPreparedWorkOrderInTransaction(
      tx,
      preparedAsset
    );
    const createdCase = await this.repository.createPreparedCaseInTransaction(
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
      state.caseSourceCapability,
      requiredAttestation(state.authorityAttestations, "case-create"),
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
    const revisionOne = currentManifest
      ? await tx.subscriptionClosureDocumentRevision.findFirst({
          where: {
            closureCaseId: createdCase.outcome.id,
            documentType: "RETURN_MANIFEST",
            revisionNumber: 1,
            sourceId: state.documentSource.id,
            sourceKey: state.documentSource.key,
            sourceType: state.documentSource.type
          }
        })
      : null;
    const manifest = currentManifest
      ? await this.replayFirstManifest(tx, state, revisionOne)
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
    const authority = await this.repository.prepareAuthorityInTransaction(
      tx,
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
      ["managed-return"]
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
    await this.repository.consumeAuthorityAttestationInTransaction(
      tx,
      authorityAttestation,
      "managed-return"
    );
    const handoverCapability =
      await this.handoverWorkOrders.attestGovernedReturnInboundAuthorityInTransaction(
        tx,
        handoverCommand,
        handoverSourceCapability
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
    const existingEsignTask = await tx.contractESignTask.findFirst({
      where: { contractId: state.authority.contractId, deletedAt: null }
    });
    const esignTask =
      existingEsignTask ??
      (await tx.contractESignTask.create({
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
      }));
    return (
      await this.repository.appendPreparedDocumentRevisionInTransaction(
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
        state.documentSourceCapability,
        requiredAttestation(state.authorityAttestations, "manifest-create"),
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
      generatedBy: string;
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
    } | null
  ) {
    if (
      !revision ||
      revision.documentType !== "RETURN_MANIFEST" ||
      !revision.vehicleReturnId ||
      !revision.handoverWorkOrderId
    ) {
      throw serviceConflict("AUTHORITY_MISMATCH");
    }
    return (
      await this.repository.appendPreparedDocumentRevisionInTransaction(
        tx,
        {
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
          source: state.documentSource,
          sourceFileHash: revision.sourceFileHash,
          sourceFileId: revision.sourceFileId,
          stage: revision.stage,
          vehicleReturnId: revision.vehicleReturnId
        },
        state.documentSourceCapability,
        requiredAttestation(state.authorityAttestations, "manifest-create"),
        this.closureAudit(revision.generatedBy)
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

function source(segmentId: string, key: string): SubscriptionClosureSource {
  return Object.freeze({ id: segmentId, key, type: "SUBSCRIPTION_EXPIRY" });
}

function sourceSortKey(value: SubscriptionClosureSource) {
  return `${value.type.trim()}\u0000${value.id.trim().toLowerCase()}\u0000${value.key.trim()}`;
}

function requiredAttestation(
  attestations: ReadonlyMap<string, ClosureAuthorityAttestation>,
  key: string
) {
  const attestation = attestations.get(key);
  if (!attestation) throw serviceConflict("CAPABILITY_INVALID");
  return attestation;
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

function serviceConflict(code: keyof typeof SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE) {
  return new ConflictException({
    code: SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE[code],
    message: "The governed normal-expiry authority is unavailable or changed."
  });
}
