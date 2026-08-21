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
import { createHash, randomUUID } from "node:crypto";

import {
  assetOperationsCreateAuthorityRequirement,
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
  subscriptionClosureCaseAuthorityRequirement,
  subscriptionClosureCaseNo,
  subscriptionClosureDocumentAuthorityRequirement,
  type AppendSubscriptionClosureDocumentCommand,
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
  assetCommand: Parameters<typeof assetOperationsCreateAuthorityRequirement>[0];
  assetContext: Parameters<
    AssetOperationsService["attestCallerOwnedCreateAuthorityInTransaction"]
  >[2];
  assetWorkOrderId: string;
  assetSource: SubscriptionClosureSource;
  authorityAttestations: ReadonlyMap<string, ClosureAuthorityAttestation>;
  authority: NormalExpiryAuthority;
  caseSource: SubscriptionClosureSource;
  caseSourceCapability: PreparedClosureSourceCapability;
  caseCommand: Parameters<SubscriptionClosureRepository["createPreparedCaseInTransaction"]>[1];
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
    const authorityAttestations = await this.repository.prepareAuthorityInTransaction(tx, locks, [
      this.assetOperations.createAuthorityRequirement(
        assetCommand,
        authority.actorId,
        assetWorkOrderId
      ),
      subscriptionClosureCaseAuthorityRequirement(caseCommand, closureCaseId),
      this.handoverWorkOrders.createReturnInboundAuthorityRequirement(
        handoverCommand,
        handoverWorkOrderId
      ),
      subscriptionClosureDocumentAuthorityRequirement(manifestCommand)
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
    if (manifestPlan.creation) {
      const esignTask = await createManifestAuthoritiesInTransaction(
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
        esignTask
      );
    }
    const handoverCapability =
      await this.handoverWorkOrders.attestReturnInboundAuthorityInTransaction(
        tx,
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
      [this.handoverWorkOrders.createGovernedReturnInboundAuthorityRequirement(handoverCommand)]
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
  handoverWorkOrderId: string;
  vehicleReturnId: string;
}>;

async function planManifestAuthoritiesInTransaction(
  tx: Prisma.TransactionClient,
  input: ManifestAuthorityPlanInput
) {
  const generatedAt = await readDatabaseClock(tx);
  const documentSnapshot = {
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
  await tx.fileObject.create({
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
  return tx.contractESignTask.create({
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
  txOwnedTask: Awaited<ReturnType<typeof findReturnManifestEsignAuthorities>>[number] | null
) {
  const candidates = txOwnedTask
    ? [txOwnedTask]
    : await findReturnManifestEsignAuthorities(tx, documentSource);
  const task = candidates[0];
  if (candidates.length !== 1 || !task || task.id !== command.contractESignTaskId) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
  const snapshotHash = createHash("sha256")
    .update(canonicalSubscriptionClosureJson(command.documentSnapshot))
    .digest("hex");
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
    task.sourceId !== documentSource.id ||
    task.sourceKey !== documentSource.key ||
    task.sourceType !== documentSource.type ||
    canonicalSubscriptionClosureJson(task.requestSnapshot) !==
      canonicalSubscriptionClosureJson(expectedSnapshot)
  ) {
    throw serviceConflict("AUTHORITY_MISMATCH");
  }
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
