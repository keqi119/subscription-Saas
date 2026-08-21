import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  AssetWorkOrderEvidenceAction,
  AssetWorkOrderStatus,
  AuditAction,
  Prisma,
  VehicleOperationalRestrictionStatus,
  VehicleOperationalRestrictionType,
  VehicleStatus,
  type AssetWorkOrder,
  type AssetWorkOrderEvidence,
  type AssetWorkOrderEvent,
  type VehicleOperationalRestriction
} from "@prisma/client";
import { isDeepStrictEqual } from "node:util";

import { AssetAccountingService } from "../asset-accounting/asset-accounting.service";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  bindSubscriptionClosureAuthorityConsumer,
  consumeSubscriptionClosureAuthorityAttestation,
  type ClosureAuthorityAttestation,
  type SubscriptionClosureAuthorityRequirement,
  type SubscriptionClosureAuthoritySession
} from "../subscription-closure/subscription-closure.repository";
import {
  ASSET_OPERATION_ERROR_CODE,
  AssetOperationsRepository,
  type AssetOperationsCallerOwnedCreateAuthority,
  type AssetOperationsCallerOwnedCommandCapability
} from "./asset-operations.repository";
import type {
  AppendEvidenceCommand,
  AppendNoteCommand,
  AssignWorkOrderCommand,
  CreateWorkOrderCommand,
  CreateRestrictionCommand,
  EvidenceCommandOutcome,
  ReleaseRestrictionCommand,
  RestrictionCommandOutcome,
  StableAssetOperationSource,
  TransitionWorkOrderCommand,
  WorkOrderCommandOutcome
} from "./asset-operations.types";
import {
  evaluateVehicleAvailability,
  type VehicleAvailabilityDecision,
  VehicleAvailabilityPurpose
} from "./vehicle-availability";

export const ASSET_OPERATION_SERVICE_CODE = {
  ASSET_OWNER_NOT_FOUND: "ASSET_OPERATION_ASSET_OWNER_NOT_FOUND",
  AUTHORITY_MISMATCH: "ASSET_OPERATION_AUTHORITY_MISMATCH",
  CALLER_CAPABILITY_INVALID: "ASSET_OPERATION_CALLER_CAPABILITY_INVALID",
  CONTRACT_NOT_FOUND: "ASSET_OPERATION_CONTRACT_NOT_FOUND",
  CUSTOMER_NOT_FOUND: "ASSET_OPERATION_CUSTOMER_NOT_FOUND",
  FILE_NOT_FOUND: ASSET_OPERATION_ERROR_CODE.FILE_NOT_FOUND,
  ORDER_NOT_FOUND: "ASSET_OPERATION_ORDER_NOT_FOUND",
  RESTRICTION_NOT_FOUND: ASSET_OPERATION_ERROR_CODE.RESTRICTION_NOT_FOUND,
  USER_NOT_FOUND: "ASSET_OPERATION_USER_NOT_FOUND",
  VEHICLE_NOT_FOUND: "ASSET_OPERATION_VEHICLE_NOT_FOUND",
  VEHICLE_NOT_AVAILABLE: "VEHICLE_NOT_AVAILABLE",
  VEHICLE_OPERATIONALLY_RESTRICTED: "VEHICLE_OPERATIONALLY_RESTRICTED",
  VEHICLE_RESTRICTION_RELEASE_FORBIDDEN: "VEHICLE_RESTRICTION_RELEASE_FORBIDDEN",
  WORK_ORDER_NOT_FOUND: ASSET_OPERATION_ERROR_CODE.WORK_ORDER_NOT_FOUND
} as const;

export interface AssetOperationCommandContext {
  readonly actorId: string | null;
  readonly ipAddress?: string;
  readonly permissions: readonly string[];
  readonly userAgent?: string;
}

export type CreateWorkOrderServiceCommand = Omit<
  CreateWorkOrderCommand,
  "actorId" | "authoritySnapshot"
>;
export type AssignWorkOrderServiceCommand = Omit<AssignWorkOrderCommand, "actorId">;
export type TransitionWorkOrderServiceCommand = Omit<TransitionWorkOrderCommand, "actorId">;
export type AppendNoteServiceCommand = Omit<AppendNoteCommand, "actorId">;
export type AppendEvidenceServiceCommand = Omit<AppendEvidenceCommand, "actorId">;
export type CreateRestrictionServiceCommand = Omit<CreateRestrictionCommand, "actorId">;
export type ReleaseRestrictionServiceCommand = Omit<ReleaseRestrictionCommand, "actorId">;
declare const assetOperationsTransactionCapabilityBrand: unique symbol;
export type AssetOperationsTransactionCapability = Readonly<{
  [assetOperationsTransactionCapabilityBrand]: true;
}>;
type AssetOperationsTransactionCapabilityState = Readonly<{
  repositoryCapability: AssetOperationsCallerOwnedCommandCapability;
  source: StableAssetOperationSource;
  transaction: Prisma.TransactionClient;
}>;
declare const assetOperationsPreparedCreateCapabilityBrand: unique symbol;
export type AssetOperationsPreparedCreateCapability = Readonly<{
  [assetOperationsPreparedCreateCapabilityBrand]: true;
}>;
declare const assetOperationsPreparedTransitionCapabilityBrand: unique symbol;
export type AssetOperationsPreparedTransitionCapability = Readonly<{
  [assetOperationsPreparedTransitionCapabilityBrand]: true;
}>;
declare const assetOperationsPreparedRestrictionCapabilityBrand: unique symbol;
export type AssetOperationsPreparedRestrictionCapability = Readonly<{
  [assetOperationsPreparedRestrictionCapabilityBrand]: true;
}>;
declare const assetOperationsPreparedEvidenceCapabilityBrand: unique symbol;
export type AssetOperationsPreparedEvidenceCapability = Readonly<{
  [assetOperationsPreparedEvidenceCapabilityBrand]: true;
}>;
declare const assetOperationsPreparedRestrictionReleaseCapabilityBrand: unique symbol;
export type AssetOperationsPreparedRestrictionReleaseCapability = Readonly<{
  [assetOperationsPreparedRestrictionReleaseCapabilityBrand]: true;
}>;
type AssetOperationsPreparedCreateCapabilityState = Readonly<{
  authoritySnapshot: ReturnType<typeof projectAuthority>;
  command: CreateWorkOrderServiceCommand;
  context: AssetOperationCommandContext;
  repositoryAuthority: AssetOperationsCallerOwnedCreateAuthority;
  transaction: Prisma.TransactionClient;
  workOrderId: string;
}>;
type LockedWorkOrderCommandHandle = Awaited<
  ReturnType<AssetOperationsRepository["lockWorkOrderForCommand"]>
>;
type PreparedTransitionState = Readonly<{
  before: AssetWorkOrder;
  command: TransitionWorkOrderServiceCommand;
  context: AssetOperationCommandContext;
  lockHandle: LockedWorkOrderCommandHandle;
  transaction: Prisma.TransactionClient;
}>;
type PreparedRestrictionState = Readonly<{
  command: CreateRestrictionServiceCommand;
  context: AssetOperationCommandContext;
  lockHandle: LockedWorkOrderCommandHandle;
  transaction: Prisma.TransactionClient;
}>;
type PreparedEvidenceState = Readonly<{
  command: AppendEvidenceServiceCommand;
  context: AssetOperationCommandContext;
  lockHandle: LockedWorkOrderCommandHandle;
  transaction: Prisma.TransactionClient;
}>;
type PreparedRestrictionReleaseState = Readonly<{
  before: VehicleOperationalRestriction;
  command: ReleaseRestrictionServiceCommand;
  context: AssetOperationCommandContext;
  lockHandle: LockedWorkOrderCommandHandle;
  transaction: Prisma.TransactionClient;
}>;

export type AssetOperationsWorkOrderAuthority = Readonly<{
  assetOwnerId: string | null;
  contractId: string | null;
  customerId: string | null;
  orderId: string | null;
  relatedWorkOrderId: string | null;
  vehicleId: string;
  workOrderId: string;
}>;

const VEHICLE_SELECT = {
  deletedAt: true,
  id: true,
  plateNo: true,
  status: true,
  vehicleNo: true,
  vin: true
} satisfies Prisma.VehicleSelect;

const ORDER_SELECT = {
  contractId: true,
  customerId: true,
  deletedAt: true,
  id: true,
  orderNo: true,
  orderStatus: true,
  vehicleId: true
} satisfies Prisma.SubscriptionOrderSelect;

const CONTRACT_SELECT = {
  contractNo: true,
  customerId: true,
  deletedAt: true,
  id: true,
  orderId: true,
  status: true
} satisfies Prisma.ContractSelect;

const CUSTOMER_SELECT = {
  customerNo: true,
  deletedAt: true,
  id: true,
  name: true,
  status: true
} satisfies Prisma.CustomerSelect;

const ASSET_OWNER_SELECT = {
  id: true,
  name: true,
  ownerNo: true,
  ownerType: true,
  status: true
} satisfies Prisma.AssetOwnerSelect;

type AuthorityTable =
  | "asset_owner"
  | "asset_work_order"
  | "contract"
  | "customer"
  | "file_object"
  | "subscription_order"
  | "user"
  | "vehicle";

@Injectable()
export class AssetOperationsService {
  private readonly closureAuthorityConsumer = Object.freeze({});
  private readonly callerOwnedCapabilities = new WeakMap<
    AssetOperationsTransactionCapability,
    AssetOperationsTransactionCapabilityState
  >();
  private readonly preparedCreateCapabilities = new WeakMap<
    AssetOperationsPreparedCreateCapability,
    AssetOperationsPreparedCreateCapabilityState
  >();
  private readonly preparedTransitionCapabilities = new WeakMap<
    AssetOperationsPreparedTransitionCapability,
    PreparedTransitionState
  >();
  private readonly preparedRestrictionCapabilities = new WeakMap<
    AssetOperationsPreparedRestrictionCapability,
    PreparedRestrictionState
  >();
  private readonly preparedEvidenceCapabilities = new WeakMap<
    AssetOperationsPreparedEvidenceCapability,
    PreparedEvidenceState
  >();
  private readonly preparedRestrictionReleaseCapabilities = new WeakMap<
    AssetOperationsPreparedRestrictionReleaseCapability,
    PreparedRestrictionReleaseState
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: AssetOperationsRepository,
    private readonly auditService: AuditService,
    private readonly assetAccountingService?: AssetAccountingService
  ) {}

  async prepareCallerOwnedTransaction(
    tx: Prisma.TransactionClient,
    source: StableAssetOperationSource
  ): Promise<AssetOperationsTransactionCapability> {
    const sourceSnapshot = snapshotAssetOperationSource(source);
    const repositoryCapability = await this.repository.prepareCallerOwnedCommand(
      tx,
      sourceSnapshot
    );
    const capability = Object.freeze({}) as AssetOperationsTransactionCapability;
    this.callerOwnedCapabilities.set(
      capability,
      Object.freeze({
        repositoryCapability,
        source: sourceSnapshot,
        transaction: tx
      })
    );
    return capability;
  }

  async createWorkOrderInTransaction(
    tx: Prisma.TransactionClient,
    command: CreateWorkOrderServiceCommand,
    context: AssetOperationCommandContext,
    capability: AssetOperationsTransactionCapability
  ): Promise<WorkOrderCommandOutcome> {
    const capabilityState = this.takeCallerOwnedCapability(capability);
    const commandSnapshot = snapshotCallerOwnedCreateCommand(command);
    const repositoryCapability = this.assertCallerOwnedCapability(
      capabilityState,
      tx,
      commandSnapshot.source
    );
    return this.createWorkOrderCommand(tx, commandSnapshot, context, repositoryCapability);
  }

  async attestCallerOwnedCreateAuthorityInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    command: CreateWorkOrderServiceCommand,
    context: AssetOperationCommandContext,
    capability: AssetOperationsTransactionCapability,
    authorityAttestation: ClosureAuthorityAttestation,
    workOrderId: string
  ): Promise<AssetOperationsPreparedCreateCapability> {
    try {
      consumeSubscriptionClosureAuthorityAttestation(
        tx,
        authoritySession,
        authorityAttestation,
        () =>
          this.createAuthorityRequirement(authoritySession, command, context.actorId, workOrderId),
        null
      );
    } catch (error) {
      if (hasConflictCode(error, "SUBSCRIPTION_CLOSURE_CAPABILITY_INVALID")) {
        throw callerCapabilityInvalid();
      }
      throw error;
    }
    const capabilityState = this.takeCallerOwnedCapability(capability);
    const commandSnapshot = snapshotCallerOwnedCreateCommand(command);
    const contextSnapshot = snapshotCommandContext(context);
    const repositoryCapability = this.assertCallerOwnedCapability(
      capabilityState,
      tx,
      commandSnapshot.source
    );
    let repositoryAuthority: AssetOperationsCallerOwnedCreateAuthority;
    try {
      repositoryAuthority = await this.repository.attestCallerOwnedCreateAuthority(
        tx,
        commandSnapshot,
        repositoryCapability
      );
    } catch (error) {
      if (hasConflictCode(error, ASSET_OPERATION_ERROR_CODE.AUTHORITY_NOT_FOUND)) {
        throw authorityMismatch();
      }
      throw error;
    }
    const authority = await loadCreateAuthority(tx, commandSnapshot);
    const prepared = Object.freeze({}) as AssetOperationsPreparedCreateCapability;
    this.preparedCreateCapabilities.set(
      prepared,
      Object.freeze({
        authoritySnapshot: projectAuthority(authority),
        command: commandSnapshot,
        context: contextSnapshot,
        repositoryAuthority,
        transaction: tx,
        workOrderId
      })
    );
    return prepared;
  }

  createAuthorityRequirement(
    authoritySession: SubscriptionClosureAuthoritySession,
    command: CreateWorkOrderServiceCommand,
    actorId: string | null,
    workOrderId: string
  ) {
    return bindSubscriptionClosureAuthorityConsumer(
      assetOperationsCreateAuthorityRequirement(command, actorId, workOrderId),
      this.closureAuthorityConsumer,
      authoritySession
    );
  }

  async createPreparedWorkOrderInTransaction(
    tx: Prisma.TransactionClient,
    capability: AssetOperationsPreparedCreateCapability
  ): Promise<WorkOrderCommandOutcome> {
    const state = this.preparedCreateCapabilities.get(capability);
    this.preparedCreateCapabilities.delete(capability);
    if (!state || state.transaction !== tx) {
      throw new ConflictException({
        code: ASSET_OPERATION_SERVICE_CODE.CALLER_CAPABILITY_INVALID,
        message: "The caller-owned asset-operation transaction capability is invalid."
      });
    }
    const outcome = await this.repository.createWorkOrder(
      tx,
      {
        ...state.command,
        actorId: state.context.actorId,
        authoritySnapshot: state.authoritySnapshot
      },
      state.repositoryAuthority,
      state.workOrderId
    );
    if (outcome.wrote) {
      await this.writeAudit(
        tx,
        AuditAction.CREATE,
        "asset_work_order",
        outcome.workOrder,
        state.context
      );
      await this.writeAudit(
        tx,
        AuditAction.CREATE,
        "asset_work_order_event",
        outcome.event,
        state.context
      );
    }
    return outcome;
  }

  workOrderTransitionAuthorityRequirement(
    authoritySession: SubscriptionClosureAuthoritySession,
    command: TransitionWorkOrderServiceCommand,
    actorId: string | null,
    authority: AssetOperationsWorkOrderAuthority
  ) {
    return bindSubscriptionClosureAuthorityConsumer(
      {
        command: { actorId, authority, command: command as never },
        key: "physical-work-order",
        locks: workOrderCoordinatorLocks(authority)
      },
      this.closureAuthorityConsumer,
      authoritySession
    );
  }

  restrictionCreateAuthorityRequirement(
    authoritySession: SubscriptionClosureAuthoritySession,
    command: CreateRestrictionServiceCommand,
    actorId: string | null,
    authority: AssetOperationsWorkOrderAuthority
  ) {
    return bindSubscriptionClosureAuthorityConsumer(
      {
        command: { actorId, authority, command: command as never },
        key: "return-inspection-restriction",
        locks: [
          { id: authority.vehicleId, mode: "UPDATE" as const, table: "vehicle" as const },
          { id: authority.workOrderId, mode: "UPDATE" as const, table: "asset_work_order" as const }
        ]
      },
      this.closureAuthorityConsumer,
      authoritySession
    );
  }

  async attestPreparedTransitionInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    command: TransitionWorkOrderServiceCommand,
    context: AssetOperationCommandContext,
    sourceCapability: AssetOperationsTransactionCapability,
    authority: AssetOperationsWorkOrderAuthority,
    authorityAttestation: ClosureAuthorityAttestation
  ): Promise<AssetOperationsPreparedTransitionCapability> {
    this.consumeClosureAttestation(tx, authoritySession, authorityAttestation, () =>
      this.workOrderTransitionAuthorityRequirement(
        authoritySession,
        command,
        context.actorId,
        authority
      )
    );
    const sourceState = this.takeCallerOwnedCapability(sourceCapability);
    const commandSnapshot = snapshotTransitionCommand(command);
    const repositoryCapability = this.assertCallerOwnedCapability(
      sourceState,
      tx,
      commandSnapshot.source
    );
    const lockHandle = await this.repository.attestCallerOwnedWorkOrderAuthority(
      tx,
      commandSnapshot.workOrderId,
      commandSnapshot.source,
      repositoryCapability
    );
    const before = await loadWorkOrderAuditPreimage(tx, commandSnapshot.workOrderId);
    if (!sameWorkOrderCoordinatorAuthority(before, authority)) throw authorityMismatch();
    const prepared = Object.freeze({}) as AssetOperationsPreparedTransitionCapability;
    this.preparedTransitionCapabilities.set(
      prepared,
      Object.freeze({
        before,
        command: commandSnapshot,
        context: snapshotCommandContext(context),
        lockHandle,
        transaction: tx
      })
    );
    return prepared;
  }

  async transitionPreparedWorkOrderInTransaction(
    tx: Prisma.TransactionClient,
    capability: AssetOperationsPreparedTransitionCapability
  ) {
    const state = this.preparedTransitionCapabilities.get(capability);
    this.preparedTransitionCapabilities.delete(capability);
    if (!state || state.transaction !== tx) throw callerCapabilityInvalid();
    const outcome = await this.repository.transitionPreparedWorkOrder(
      tx,
      { ...state.command, actorId: state.context.actorId },
      state.lockHandle
    );
    await this.auditWorkOrderOutcome(tx, outcome, state.context, state.before);
    return outcome;
  }

  async attestPreparedRestrictionCreateInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    command: CreateRestrictionServiceCommand,
    context: AssetOperationCommandContext,
    sourceCapability: AssetOperationsTransactionCapability,
    authority: AssetOperationsWorkOrderAuthority,
    authorityAttestation: ClosureAuthorityAttestation
  ): Promise<AssetOperationsPreparedRestrictionCapability> {
    this.consumeClosureAttestation(tx, authoritySession, authorityAttestation, () =>
      this.restrictionCreateAuthorityRequirement(
        authoritySession,
        command,
        context.actorId,
        authority
      )
    );
    const sourceState = this.takeCallerOwnedCapability(sourceCapability);
    const commandSnapshot = snapshotRestrictionCreateCommand(command);
    const repositoryCapability = this.assertCallerOwnedCapability(
      sourceState,
      tx,
      commandSnapshot.source
    );
    const lockHandle = await this.repository.attestCallerOwnedWorkOrderAuthority(
      tx,
      authority.workOrderId,
      commandSnapshot.source,
      repositoryCapability
    );
    const header = await loadWorkOrderAuditPreimage(tx, authority.workOrderId);
    if (
      commandSnapshot.workOrderId !== authority.workOrderId ||
      commandSnapshot.vehicleId !== authority.vehicleId ||
      !sameWorkOrderCoordinatorAuthority(header, authority)
    ) {
      throw authorityMismatch();
    }
    const prepared = Object.freeze({}) as AssetOperationsPreparedRestrictionCapability;
    this.preparedRestrictionCapabilities.set(
      prepared,
      Object.freeze({
        command: commandSnapshot,
        context: snapshotCommandContext(context),
        lockHandle,
        transaction: tx
      })
    );
    return prepared;
  }

  async createPreparedRestrictionInTransaction(
    tx: Prisma.TransactionClient,
    capability: AssetOperationsPreparedRestrictionCapability
  ) {
    const state = this.preparedRestrictionCapabilities.get(capability);
    this.preparedRestrictionCapabilities.delete(capability);
    if (!state || state.transaction !== tx) throw callerCapabilityInvalid();
    const outcome = await this.repository.createPreparedRestriction(
      tx,
      { ...state.command, actorId: state.context.actorId },
      state.lockHandle
    );
    if (outcome.wrote) {
      await this.writeAudit(
        tx,
        AuditAction.CREATE,
        "vehicle_operational_restriction",
        outcome.restriction,
        state.context
      );
      if (outcome.event) {
        await this.writeAudit(
          tx,
          AuditAction.CREATE,
          "asset_work_order_event",
          outcome.event,
          state.context
        );
      }
    }
    return outcome;
  }

  evidenceAuthorityRequirement(
    authoritySession: SubscriptionClosureAuthoritySession,
    command: AppendEvidenceServiceCommand,
    actorId: string | null,
    authority: AssetOperationsWorkOrderAuthority,
    key = "inspection-evidence"
  ) {
    return bindSubscriptionClosureAuthorityConsumer(
      {
        command: { actorId, authority, command: command as never },
        key,
        locks: [
          ...workOrderCoordinatorLocks(authority),
          ...(command.supersedesEvidenceId
            ? [
                {
                  id: command.supersedesEvidenceId,
                  mode: "SHARE" as const,
                  table: "asset_work_order_evidence" as const
                }
              ]
            : []),
          ...(command.fileId
            ? [{ id: command.fileId, mode: "SHARE" as const, table: "file_object" as const }]
            : [])
        ]
      },
      this.closureAuthorityConsumer,
      authoritySession
    );
  }

  restrictionReleaseAuthorityRequirement(
    authoritySession: SubscriptionClosureAuthoritySession,
    command: ReleaseRestrictionServiceCommand,
    actorId: string | null,
    authority: AssetOperationsWorkOrderAuthority,
    restrictionId: string
  ) {
    return bindSubscriptionClosureAuthorityConsumer(
      {
        command: { actorId, authority, command: command as never, restrictionId },
        key: "inspection-restriction-release",
        locks: [
          { id: authority.vehicleId, mode: "UPDATE" as const, table: "vehicle" as const },
          {
            id: authority.workOrderId,
            mode: "UPDATE" as const,
            table: "asset_work_order" as const
          },
          {
            id: restrictionId,
            mode: "UPDATE" as const,
            table: "vehicle_operational_restriction" as const
          }
        ]
      },
      this.closureAuthorityConsumer,
      authoritySession
    );
  }

  async attestPreparedEvidenceInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    command: AppendEvidenceServiceCommand,
    context: AssetOperationCommandContext,
    sourceCapability: AssetOperationsTransactionCapability,
    authority: AssetOperationsWorkOrderAuthority,
    authorityAttestation: ClosureAuthorityAttestation,
    key = "inspection-evidence"
  ): Promise<AssetOperationsPreparedEvidenceCapability> {
    this.consumeClosureAttestation(tx, authoritySession, authorityAttestation, () =>
      this.evidenceAuthorityRequirement(authoritySession, command, context.actorId, authority, key)
    );
    const sourceState = this.takeCallerOwnedCapability(sourceCapability);
    const commandSnapshot = deepFreeze(structuredClone(command));
    const repositoryCapability = this.assertCallerOwnedCapability(
      sourceState,
      tx,
      commandSnapshot.source
    );
    const lockHandle = await this.repository.attestCallerOwnedWorkOrderAuthority(
      tx,
      commandSnapshot.workOrderId,
      commandSnapshot.source,
      repositoryCapability
    );
    const header = await loadWorkOrderAuditPreimage(tx, commandSnapshot.workOrderId);
    if (!sameWorkOrderCoordinatorAuthority(header, authority)) throw authorityMismatch();
    if (commandSnapshot.fileId) {
      const file = await tx.fileObject.findUnique({ where: { id: commandSnapshot.fileId } });
      if (!file)
        throw notFound(ASSET_OPERATION_SERVICE_CODE.FILE_NOT_FOUND, "File object not found.");
    }
    const prepared = Object.freeze({}) as AssetOperationsPreparedEvidenceCapability;
    this.preparedEvidenceCapabilities.set(prepared, {
      command: commandSnapshot,
      context: snapshotCommandContext(context),
      lockHandle,
      transaction: tx
    });
    return prepared;
  }

  async appendPreparedEvidenceInTransaction(
    tx: Prisma.TransactionClient,
    capability: AssetOperationsPreparedEvidenceCapability
  ) {
    const state = this.preparedEvidenceCapabilities.get(capability);
    this.preparedEvidenceCapabilities.delete(capability);
    if (!state || state.transaction !== tx) throw callerCapabilityInvalid();
    const outcome = await this.repository.appendPreparedEvidence(
      tx,
      { ...state.command, actorId: state.context.actorId },
      state.lockHandle
    );
    if (outcome.wrote) {
      await this.writeAudit(
        tx,
        AuditAction.CREATE,
        "asset_work_order_evidence",
        outcome.evidence,
        state.context
      );
      await this.writeAudit(
        tx,
        AuditAction.CREATE,
        "asset_work_order_event",
        outcome.event,
        state.context
      );
    }
    return outcome;
  }

  async attestPreparedRestrictionReleaseInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    command: ReleaseRestrictionServiceCommand,
    context: AssetOperationCommandContext,
    sourceCapability: AssetOperationsTransactionCapability,
    authority: AssetOperationsWorkOrderAuthority,
    authorityAttestation: ClosureAuthorityAttestation
  ): Promise<AssetOperationsPreparedRestrictionReleaseCapability> {
    this.consumeClosureAttestation(tx, authoritySession, authorityAttestation, () =>
      this.restrictionReleaseAuthorityRequirement(
        authoritySession,
        command,
        context.actorId,
        authority,
        command.restrictionId
      )
    );
    const sourceState = this.takeCallerOwnedCapability(sourceCapability);
    const commandSnapshot = deepFreeze(structuredClone(command));
    const repositoryCapability = this.assertCallerOwnedCapability(
      sourceState,
      tx,
      commandSnapshot.source
    );
    const lockHandle = await this.repository.attestCallerOwnedWorkOrderAuthority(
      tx,
      authority.workOrderId,
      commandSnapshot.source,
      repositoryCapability
    );
    const before = await tx.vehicleOperationalRestriction.findUnique({
      where: { id: commandSnapshot.restrictionId }
    });
    if (
      !before ||
      before.vehicleId !== authority.vehicleId ||
      before.workOrderId !== authority.workOrderId
    ) {
      throw authorityMismatch();
    }
    assertReleasePermission(before.restrictionType, context.permissions);
    const prepared = Object.freeze({}) as AssetOperationsPreparedRestrictionReleaseCapability;
    this.preparedRestrictionReleaseCapabilities.set(prepared, {
      before,
      command: commandSnapshot,
      context: snapshotCommandContext(context),
      lockHandle,
      transaction: tx
    });
    return prepared;
  }

  async releasePreparedRestrictionInTransaction(
    tx: Prisma.TransactionClient,
    capability: AssetOperationsPreparedRestrictionReleaseCapability
  ) {
    const state = this.preparedRestrictionReleaseCapabilities.get(capability);
    this.preparedRestrictionReleaseCapabilities.delete(capability);
    if (!state || state.transaction !== tx) throw callerCapabilityInvalid();
    const outcome = await this.repository.releasePreparedRestriction(
      tx,
      { ...state.command, actorId: requireActor(state.context) },
      state.lockHandle
    );
    if (outcome.wrote) {
      await this.writeAudit(
        tx,
        AuditAction.UPDATE,
        "vehicle_operational_restriction",
        outcome.restriction,
        state.context,
        state.before
      );
      if (outcome.event) {
        await this.writeAudit(
          tx,
          AuditAction.CREATE,
          "asset_work_order_event",
          outcome.event,
          state.context
        );
      }
    }
    return outcome;
  }

  private consumeClosureAttestation(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    authorityAttestation: ClosureAuthorityAttestation,
    requirement: () => SubscriptionClosureAuthorityRequirement
  ) {
    try {
      consumeSubscriptionClosureAuthorityAttestation(
        tx,
        authoritySession,
        authorityAttestation,
        requirement,
        null
      );
    } catch (error) {
      if (hasConflictCode(error, "SUBSCRIPTION_CLOSURE_CAPABILITY_INVALID")) {
        throw callerCapabilityInvalid();
      }
      throw error;
    }
  }

  async createWorkOrder(
    command: CreateWorkOrderServiceCommand,
    context: AssetOperationCommandContext
  ): Promise<WorkOrderCommandOutcome> {
    return this.runCommand((tx) => this.createWorkOrderCommand(tx, command, context));
  }

  private async createWorkOrderCommand(
    tx: Prisma.TransactionClient,
    command: CreateWorkOrderServiceCommand,
    context: AssetOperationCommandContext,
    repositoryCapability?: AssetOperationsCallerOwnedCommandCapability
  ): Promise<WorkOrderCommandOutcome> {
    if (!repositoryCapability) await this.repository.lockSourceOwnership(tx, command.source);
    let callerOwnedAuthority: AssetOperationsCallerOwnedCreateAuthority | undefined;
    if (repositoryCapability) {
      try {
        callerOwnedAuthority = await this.repository.lockCallerOwnedCreateAuthority(
          tx,
          command,
          repositoryCapability
        );
      } catch (error) {
        if (hasConflictCode(error, ASSET_OPERATION_ERROR_CODE.AUTHORITY_NOT_FOUND)) {
          throw authorityMismatch();
        }
        throw error;
      }
    } else {
      await lockAuthorityRows(tx, createAuthorityRows(command));
    }
    const authority = await loadCreateAuthority(tx, command);
    const outcome = await this.repository.createWorkOrder(
      tx,
      {
        ...command,
        actorId: context.actorId,
        authoritySnapshot: projectAuthority(authority)
      },
      callerOwnedAuthority
    );
    if (outcome.wrote) {
      await this.writeAudit(tx, AuditAction.CREATE, "asset_work_order", outcome.workOrder, context);
      await this.writeAudit(
        tx,
        AuditAction.CREATE,
        "asset_work_order_event",
        outcome.event,
        context
      );
    }
    return outcome;
  }

  private takeCallerOwnedCapability(
    capability: AssetOperationsTransactionCapability
  ): AssetOperationsTransactionCapabilityState {
    const state = this.callerOwnedCapabilities.get(capability);
    this.callerOwnedCapabilities.delete(capability);
    if (!state) {
      throw new ConflictException({
        code: ASSET_OPERATION_SERVICE_CODE.CALLER_CAPABILITY_INVALID,
        message: "The caller-owned asset-operation transaction capability is invalid."
      });
    }
    return state;
  }

  private assertCallerOwnedCapability(
    state: AssetOperationsTransactionCapabilityState,
    tx: Prisma.TransactionClient,
    source: StableAssetOperationSource
  ): AssetOperationsCallerOwnedCommandCapability {
    if (
      state.transaction !== tx ||
      state.source.id !== source.id ||
      state.source.key !== source.key ||
      state.source.type !== source.type
    ) {
      throw new ConflictException({
        code: ASSET_OPERATION_SERVICE_CODE.CALLER_CAPABILITY_INVALID,
        message: "The caller-owned asset-operation transaction capability is invalid."
      });
    }
    return state.repositoryCapability;
  }

  async assignWorkOrder(
    command: AssignWorkOrderServiceCommand,
    context: AssetOperationCommandContext
  ): Promise<WorkOrderCommandOutcome> {
    return this.runWorkOrderCommand(
      command,
      [{ id: command.assignedUserId, table: "user" }],
      async (tx, before, lockHandle) => {
        const user = await tx.user.findUnique({
          select: { deletedAt: true, id: true, status: true },
          where: { id: command.assignedUserId }
        });
        if (!user || user.deletedAt || user.status !== "ACTIVE") {
          throw notFound(ASSET_OPERATION_SERVICE_CODE.USER_NOT_FOUND, "Assigned user not found.");
        }
        const outcome = await this.repository.assignWorkOrder(
          tx,
          {
            ...command,
            actorId: context.actorId
          },
          lockHandle
        );
        await this.auditWorkOrderOutcome(tx, outcome, context, before);
        return outcome;
      }
    );
  }

  async transitionWorkOrder(
    command: TransitionWorkOrderServiceCommand,
    context: AssetOperationCommandContext
  ): Promise<WorkOrderCommandOutcome> {
    return this.runWorkOrderCommand(command, [], async (tx, before, lockHandle) => {
      if (
        before.status === AssetWorkOrderStatus.PENDING_COST_CONFIRMATION &&
        before.costConfirmationRequired &&
        command.targetStatus === AssetWorkOrderStatus.CLOSED
      ) {
        if (!this.assetAccountingService) {
          throw new Error(
            "AssetAccountingService is required for cost-confirmed work-order closure."
          );
        }
        await this.assetAccountingService.assertWorkOrderCostConfirmed(tx, command.workOrderId);
      }
      const outcome = await this.repository.transitionWorkOrder(
        tx,
        {
          ...command,
          actorId: context.actorId
        },
        lockHandle
      );
      await this.auditWorkOrderOutcome(tx, outcome, context, before);
      return outcome;
    });
  }

  async appendNote(
    command: AppendNoteServiceCommand,
    context: AssetOperationCommandContext
  ): Promise<WorkOrderCommandOutcome> {
    return this.runWorkOrderCommand(command, [], async (tx, before, lockHandle) => {
      const outcome = await this.repository.appendNote(
        tx,
        {
          ...command,
          actorId: context.actorId
        },
        lockHandle
      );
      if (outcome.wrote) {
        await this.writeAudit(
          tx,
          AuditAction.CREATE,
          "asset_work_order_event",
          outcome.event,
          context
        );
      }
      return outcome;
    });
  }

  async appendEvidence(
    command: AppendEvidenceServiceCommand,
    context: AssetOperationCommandContext
  ): Promise<EvidenceCommandOutcome> {
    const extraRows = command.fileId ? [{ id: command.fileId, table: "file_object" as const }] : [];
    return this.runWorkOrderCommand(command, extraRows, async (tx, before, lockHandle) => {
      if (command.fileId) {
        const file = await tx.fileObject.findUnique({
          select: { id: true },
          where: { id: command.fileId }
        });
        if (!file) {
          throw notFound(ASSET_OPERATION_SERVICE_CODE.FILE_NOT_FOUND, "File object not found.");
        }
      }
      const outcome = await this.repository.appendEvidence(
        tx,
        {
          ...command,
          actorId: context.actorId
        },
        lockHandle
      );
      if (outcome.wrote) {
        await this.writeAudit(
          tx,
          AuditAction.CREATE,
          "asset_work_order_evidence",
          outcome.evidence,
          context
        );
        await this.writeAudit(
          tx,
          AuditAction.CREATE,
          "asset_work_order_event",
          outcome.event,
          context
        );
      }
      return outcome;
    });
  }

  async createRestriction(
    command: CreateRestrictionServiceCommand,
    context: AssetOperationCommandContext
  ): Promise<RestrictionCommandOutcome> {
    return this.runCommand(async (tx) => {
      await this.repository.lockSourceOwnership(tx, command.source);
      let lockHandle: LockedWorkOrderCommandHandle | undefined;
      if (command.workOrderId) {
        const linked = await this.validateWorkOrderAuthority(tx, command.workOrderId, [
          { id: command.vehicleId, table: "vehicle" }
        ]);
        lockHandle = linked.lockHandle;
        if (linked.workOrder.vehicleId !== command.vehicleId) {
          throw authorityMismatch();
        }
      } else {
        await lockAuthorityRows(tx, [{ id: command.vehicleId, table: "vehicle" }]);
        await loadLiveVehicle(tx, command.vehicleId);
      }
      const outcome = await this.repository.createRestriction(
        tx,
        {
          ...command,
          actorId: context.actorId
        },
        lockHandle
      );
      if (outcome.wrote) {
        await this.writeAudit(
          tx,
          AuditAction.CREATE,
          "vehicle_operational_restriction",
          outcome.restriction,
          context
        );
        if (outcome.event) {
          await this.writeAudit(
            tx,
            AuditAction.CREATE,
            "asset_work_order_event",
            outcome.event,
            context
          );
        }
      }
      return outcome;
    });
  }

  async releaseRestriction(
    command: ReleaseRestrictionServiceCommand,
    context: AssetOperationCommandContext
  ): Promise<RestrictionCommandOutcome> {
    return this.runCommand(async (tx) => {
      await this.repository.lockSourceOwnership(tx, command.source);
      let lockHandle: LockedWorkOrderCommandHandle | undefined;
      const candidate = await tx.vehicleOperationalRestriction.findUnique({
        where: { id: command.restrictionId }
      });
      if (!candidate) {
        throw notFound(
          ASSET_OPERATION_SERVICE_CODE.RESTRICTION_NOT_FOUND,
          "Vehicle operational restriction not found."
        );
      }
      if (candidate.workOrderId) {
        const linked = await this.validateWorkOrderAuthority(tx, candidate.workOrderId, [
          { id: candidate.vehicleId, table: "vehicle" }
        ]);
        lockHandle = linked.lockHandle;
        if (candidate.vehicleId !== linked.workOrder.vehicleId) {
          throw authorityMismatch();
        }
      } else {
        await lockAuthorityRows(tx, [{ id: candidate.vehicleId, table: "vehicle" }]);
        await loadLiveVehicle(tx, candidate.vehicleId);
      }
      assertReleasePermission(candidate.restrictionType, context.permissions);
      const outcome = await this.repository.releaseRestriction(
        tx,
        {
          ...command,
          actorId: requireActor(context)
        },
        lockHandle
      );
      if (outcome.wrote) {
        await this.writeAudit(
          tx,
          AuditAction.UPDATE,
          "vehicle_operational_restriction",
          outcome.restriction,
          context,
          candidate
        );
        if (outcome.event) {
          await this.writeAudit(
            tx,
            AuditAction.CREATE,
            "asset_work_order_event",
            outcome.event,
            context
          );
        }
      }
      return outcome;
    });
  }

  async getWorkOrderDetail(workOrderId: string) {
    return this.runRead(async (tx) => {
      const detail = await this.repository.getWorkOrderDetail(tx, workOrderId);
      if (!detail) {
        throw notFound(
          ASSET_OPERATION_SERVICE_CODE.WORK_ORDER_NOT_FOUND,
          "Asset work order not found."
        );
      }
      return projectWorkOrderDetail(detail);
    });
  }

  async listVehicleWorkOrders(vehicleId: string) {
    return this.runRead(async (tx) => {
      await loadLiveVehicle(tx, vehicleId);
      const rows = await this.repository.listWorkOrdersByVehicle(tx, vehicleId);
      return rows.map(projectWorkOrderSummary);
    });
  }

  async listVehicleRestrictions(vehicleId: string) {
    return this.runRead(async (tx) => {
      await loadLiveVehicle(tx, vehicleId);
      const rows = await tx.vehicleOperationalRestriction.findMany({
        orderBy: [{ startedAt: "desc" }, { id: "asc" }],
        where: { vehicleId }
      });
      return projectRestrictions(rows);
    });
  }

  async getVehicleAvailability(
    vehicleId: string,
    purpose: VehicleAvailabilityPurpose,
    asOf = new Date()
  ): Promise<VehicleAvailabilityDecision> {
    return this.runRead(async (tx) => {
      const snapshot = await this.repository.loadAvailabilitySnapshot(tx, vehicleId, asOf);
      return evaluateVehicleAvailability({ ...snapshot, purpose });
    });
  }

  async assertVehicleAvailable(
    tx: Prisma.TransactionClient,
    vehicleId: string,
    purpose: VehicleAvailabilityPurpose,
    asOf = new Date(),
    lifecycleStatusOverride?: VehicleStatus
  ): Promise<VehicleAvailabilityDecision> {
    const snapshot = await this.repository.loadAvailabilitySnapshot(tx, vehicleId, asOf);
    const decision = evaluateVehicleAvailability({
      ...snapshot,
      purpose,
      vehicle:
        snapshot.vehicle && lifecycleStatusOverride
          ? { ...snapshot.vehicle, status: lifecycleStatusOverride }
          : snapshot.vehicle
    });
    if (!decision.available) {
      const operationallyRestricted = decision.reasons.some(
        ({ code }) => code === "ACTIVE_OPERATIONAL_RESTRICTION"
      );
      throw new ConflictException({
        code: operationallyRestricted
          ? ASSET_OPERATION_SERVICE_CODE.VEHICLE_OPERATIONALLY_RESTRICTED
          : ASSET_OPERATION_SERVICE_CODE.VEHICLE_NOT_AVAILABLE,
        message: "Vehicle is not available for the requested asset operation.",
        reasons: decision.reasons
      });
    }
    return decision;
  }

  private async runWorkOrderCommand<T>(
    command: { source: StableAssetOperationSource; workOrderId: string },
    extraRows: ReadonlyArray<{ id: string; table: AuthorityTable }>,
    work: (
      tx: Prisma.TransactionClient,
      before: AssetWorkOrder,
      lockHandle: LockedWorkOrderCommandHandle
    ) => Promise<T>
  ) {
    return this.runCommand(async (tx) => {
      await this.repository.lockSourceOwnership(tx, command.source);
      const { before, lockHandle } = await this.validateWorkOrderAuthority(
        tx,
        command.workOrderId,
        extraRows
      );
      return work(tx, before, lockHandle);
    });
  }

  private async validateWorkOrderAuthority(
    tx: Prisma.TransactionClient,
    workOrderId: string,
    extraRows: ReadonlyArray<{ id: string; table: AuthorityTable }>
  ) {
    const seed = await loadWorkOrderHeader(tx, workOrderId);
    const lockHandle = await this.repository.lockWorkOrderForCommand(tx, workOrderId, [
      ...workOrderAuthorityRows(seed),
      ...extraRows
    ]);
    const current = await loadWorkOrderHeader(tx, workOrderId);
    if (!sameWorkOrderAuthority(seed, current)) {
      throw authorityMismatch();
    }
    const authority = await loadAuthority(tx, current);
    assertAuthorityConsistency(authority);
    const before = await loadWorkOrderAuditPreimage(tx, workOrderId);
    return { authority, before, lockHandle, workOrder: current };
  }

  private async auditWorkOrderOutcome(
    tx: Prisma.TransactionClient,
    outcome: WorkOrderCommandOutcome,
    context: AssetOperationCommandContext,
    before: AssetWorkOrder
  ) {
    if (!outcome.wrote) return;
    await this.writeAudit(
      tx,
      AuditAction.UPDATE,
      "asset_work_order",
      outcome.workOrder,
      context,
      before
    );
    await this.writeAudit(tx, AuditAction.CREATE, "asset_work_order_event", outcome.event, context);
  }

  private runCommand<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
    });
  }

  private runRead<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
    });
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    action: AuditAction,
    entityType: string,
    after: { id: string },
    context: AssetOperationCommandContext,
    before?: unknown
  ) {
    return this.auditService.write(
      {
        action,
        after: toAuditSnapshot(after),
        before: toAuditSnapshot(before),
        entityId: after.id,
        entityType,
        ipAddress: context.ipAddress,
        module: "asset_operations",
        operatorId: context.actorId ?? undefined,
        userAgent: context.userAgent
      },
      tx
    );
  }
}

export function assetOperationsCreateAuthorityRequirement(
  command: CreateWorkOrderServiceCommand,
  actorId: string | null,
  workOrderId: string
): SubscriptionClosureAuthorityRequirement {
  const locks: SubscriptionClosureAuthorityRequirement["locks"] = [
    ...(command.orderId
      ? [{ id: command.orderId, mode: "UPDATE" as const, table: "subscription_order" as const }]
      : []),
    { id: command.vehicleId, mode: "SHARE", table: "vehicle" },
    ...(command.contractId
      ? [{ id: command.contractId, mode: "SHARE" as const, table: "contract" as const }]
      : []),
    ...(command.relatedWorkOrderId
      ? [
          {
            id: command.relatedWorkOrderId,
            mode: "SHARE" as const,
            table: "asset_work_order" as const
          }
        ]
      : []),
    ...(command.assetOwnerId
      ? [{ id: command.assetOwnerId, mode: "SHARE" as const, table: "asset_owner" as const }]
      : []),
    ...(command.customerId
      ? [{ id: command.customerId, mode: "SHARE" as const, table: "customer" as const }]
      : []),
    ...(actorId ? [{ id: actorId, mode: "SHARE" as const, table: "user" as const }] : [])
  ];
  return {
    command: {
      actorId,
      assetOwnerId: command.assetOwnerId,
      contractId: command.contractId,
      customerId: command.customerId,
      orderId: command.orderId,
      relatedWorkOrderId: command.relatedWorkOrderId,
      source: command.source,
      vehicleId: command.vehicleId,
      workOrderId
    },
    key: "asset-create",
    locks
  };
}

type CreateAuthority = {
  assetOwner: Prisma.AssetOwnerGetPayload<{ select: typeof ASSET_OWNER_SELECT }> | null;
  contract: Prisma.ContractGetPayload<{ select: typeof CONTRACT_SELECT }> | null;
  customer: Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_SELECT }> | null;
  order: Prisma.SubscriptionOrderGetPayload<{ select: typeof ORDER_SELECT }> | null;
  relatedWorkOrder: { id: string; vehicleId: string; workOrderNo: string } | null;
  vehicle: Prisma.VehicleGetPayload<{ select: typeof VEHICLE_SELECT }>;
};

type AuthorityReferences = Pick<
  AssetWorkOrder,
  "assetOwnerId" | "contractId" | "customerId" | "orderId" | "relatedWorkOrderId" | "vehicleId"
>;

const WORK_ORDER_AUTHORITY_SELECT = {
  assetOwnerId: true,
  contractId: true,
  customerId: true,
  id: true,
  orderId: true,
  relatedWorkOrderId: true,
  vehicleId: true,
  workOrderNo: true
} satisfies Prisma.AssetWorkOrderSelect;

type WorkOrderAuthorityHeader = Prisma.AssetWorkOrderGetPayload<{
  select: typeof WORK_ORDER_AUTHORITY_SELECT;
}>;

function createAuthorityRows(command: CreateWorkOrderServiceCommand) {
  return [
    command.assetOwnerId ? { id: command.assetOwnerId, table: "asset_owner" as const } : null,
    command.contractId ? { id: command.contractId, table: "contract" as const } : null,
    command.customerId ? { id: command.customerId, table: "customer" as const } : null,
    command.orderId ? { id: command.orderId, table: "subscription_order" as const } : null,
    command.relatedWorkOrderId
      ? { id: command.relatedWorkOrderId, table: "asset_work_order" as const }
      : null,
    { id: command.vehicleId, table: "vehicle" as const }
  ];
}

async function lockAuthorityRows(
  tx: Prisma.TransactionClient,
  rows: ReadonlyArray<{ id: string; table: AuthorityTable } | null>
) {
  const ordered = rows
    .filter((row): row is { id: string; table: AuthorityTable } => row !== null)
    .sort((left, right) =>
      left.table === right.table ? compare(left.id, right.id) : compare(left.table, right.table)
    );
  try {
    for (const row of ordered) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${row.table}"`)} WHERE "id" = ${row.id}::uuid FOR SHARE NOWAIT`
      );
    }
  } catch (error) {
    if (isLockUnavailableError(error)) {
      throw new ConflictException({
        code: ASSET_OPERATION_ERROR_CODE.AUTHORITY_BUSY,
        message: "Asset operation authority is being updated. Review the current state and retry."
      });
    }
    throw error;
  }
}

async function loadCreateAuthority(
  tx: Prisma.TransactionClient,
  command: AuthorityReferences
): Promise<CreateAuthority> {
  const [vehicle, order, contract, customer, assetOwner, relatedWorkOrder] = await Promise.all([
    tx.vehicle.findUnique({ select: VEHICLE_SELECT, where: { id: command.vehicleId } }),
    command.orderId
      ? tx.subscriptionOrder.findUnique({ select: ORDER_SELECT, where: { id: command.orderId } })
      : null,
    command.contractId
      ? tx.contract.findUnique({ select: CONTRACT_SELECT, where: { id: command.contractId } })
      : null,
    command.customerId
      ? tx.customer.findUnique({ select: CUSTOMER_SELECT, where: { id: command.customerId } })
      : null,
    command.assetOwnerId
      ? tx.assetOwner.findUnique({
          select: ASSET_OWNER_SELECT,
          where: { id: command.assetOwnerId }
        })
      : null,
    command.relatedWorkOrderId
      ? tx.assetWorkOrder.findUnique({
          select: { id: true, vehicleId: true, workOrderNo: true },
          where: { id: command.relatedWorkOrderId }
        })
      : null
  ]);
  if (!vehicle || vehicle.deletedAt) {
    throw notFound(ASSET_OPERATION_SERVICE_CODE.VEHICLE_NOT_FOUND, "Vehicle not found.");
  }
  if (command.orderId && (!order || order.deletedAt)) {
    throw notFound(ASSET_OPERATION_SERVICE_CODE.ORDER_NOT_FOUND, "Order not found.");
  }
  if (command.contractId && (!contract || contract.deletedAt)) {
    throw notFound(ASSET_OPERATION_SERVICE_CODE.CONTRACT_NOT_FOUND, "Contract not found.");
  }
  if (command.customerId && (!customer || customer.deletedAt)) {
    throw notFound(ASSET_OPERATION_SERVICE_CODE.CUSTOMER_NOT_FOUND, "Customer not found.");
  }
  if (command.assetOwnerId && (!assetOwner || assetOwner.status !== "ACTIVE")) {
    throw notFound(ASSET_OPERATION_SERVICE_CODE.ASSET_OWNER_NOT_FOUND, "Asset owner not found.");
  }
  if (command.relatedWorkOrderId && !relatedWorkOrder) {
    throw notFound(
      ASSET_OPERATION_SERVICE_CODE.WORK_ORDER_NOT_FOUND,
      "Asset work order not found."
    );
  }
  const authority = { assetOwner, contract, customer, order, relatedWorkOrder, vehicle };
  assertAuthorityConsistency(authority);
  return authority;
}

function assertAuthorityConsistency(authority: CreateAuthority) {
  const { contract, customer, order, relatedWorkOrder, vehicle } = authority;
  if (
    (order && order.vehicleId !== vehicle.id) ||
    (order && customer && order.customerId !== customer.id) ||
    (contract && order && contract.orderId !== order.id) ||
    (contract && order && order.contractId !== contract.id) ||
    (contract && order && order.customerId !== contract.customerId) ||
    (contract && customer && contract.customerId !== customer.id) ||
    (relatedWorkOrder && relatedWorkOrder.vehicleId !== vehicle.id)
  ) {
    throw authorityMismatch();
  }
}

function projectAuthority(authority: CreateAuthority): Prisma.JsonObject {
  return {
    assetOwner: authority.assetOwner
      ? {
          id: authority.assetOwner.id,
          name: authority.assetOwner.name,
          ownerNo: authority.assetOwner.ownerNo,
          ownerType: authority.assetOwner.ownerType,
          status: authority.assetOwner.status
        }
      : null,
    contract: authority.contract
      ? {
          contractNo: authority.contract.contractNo,
          customerId: authority.contract.customerId,
          id: authority.contract.id,
          orderId: authority.contract.orderId,
          status: authority.contract.status
        }
      : null,
    customer: authority.customer
      ? {
          customerNo: authority.customer.customerNo,
          id: authority.customer.id,
          name: authority.customer.name,
          status: authority.customer.status
        }
      : null,
    order: authority.order
      ? {
          contractId: authority.order.contractId,
          customerId: authority.order.customerId,
          id: authority.order.id,
          orderNo: authority.order.orderNo,
          orderStatus: authority.order.orderStatus,
          vehicleId: authority.order.vehicleId
        }
      : null,
    relatedWorkOrder: authority.relatedWorkOrder,
    vehicle: {
      id: authority.vehicle.id,
      plateNo: authority.vehicle.plateNo,
      status: authority.vehicle.status,
      vehicleNo: authority.vehicle.vehicleNo,
      vin: authority.vehicle.vin
    }
  };
}

function loadAuthority(tx: Prisma.TransactionClient, input: AuthorityReferences) {
  return loadCreateAuthority(tx, input);
}

async function loadWorkOrderHeader(
  tx: Prisma.TransactionClient,
  workOrderId: string
): Promise<WorkOrderAuthorityHeader> {
  const workOrder = await tx.assetWorkOrder.findUnique({
    select: WORK_ORDER_AUTHORITY_SELECT,
    where: { id: workOrderId }
  });
  if (!workOrder) {
    throw notFound(
      ASSET_OPERATION_SERVICE_CODE.WORK_ORDER_NOT_FOUND,
      "Asset work order not found."
    );
  }
  return workOrder;
}

async function loadWorkOrderAuditPreimage(
  tx: Prisma.TransactionClient,
  workOrderId: string
): Promise<AssetWorkOrder> {
  const workOrder = await tx.assetWorkOrder.findUnique({ where: { id: workOrderId } });
  if (!workOrder) {
    throw notFound(
      ASSET_OPERATION_SERVICE_CODE.WORK_ORDER_NOT_FOUND,
      "Asset work order not found."
    );
  }
  return deepFreeze(structuredClone(workOrder));
}

function workOrderAuthorityRows(workOrder: WorkOrderAuthorityHeader) {
  return [
    workOrder.assetOwnerId ? { id: workOrder.assetOwnerId, table: "asset_owner" as const } : null,
    workOrder.relatedWorkOrderId
      ? { id: workOrder.relatedWorkOrderId, table: "asset_work_order" as const }
      : null,
    workOrder.contractId ? { id: workOrder.contractId, table: "contract" as const } : null,
    workOrder.customerId ? { id: workOrder.customerId, table: "customer" as const } : null,
    workOrder.orderId ? { id: workOrder.orderId, table: "subscription_order" as const } : null,
    { id: workOrder.vehicleId, table: "vehicle" as const }
  ];
}

function sameWorkOrderAuthority(left: WorkOrderAuthorityHeader, right: WorkOrderAuthorityHeader) {
  return isDeepStrictEqual(left, right);
}

async function loadLiveVehicle(tx: Prisma.TransactionClient, vehicleId: string) {
  const vehicle = await tx.vehicle.findUnique({ select: VEHICLE_SELECT, where: { id: vehicleId } });
  if (!vehicle || vehicle.deletedAt) {
    throw notFound(ASSET_OPERATION_SERVICE_CODE.VEHICLE_NOT_FOUND, "Vehicle not found.");
  }
  return vehicle;
}

const HIGH_RISK_RESTRICTION_TYPES = new Set<VehicleOperationalRestrictionType>([
  VehicleOperationalRestrictionType.EVIDENCE_EXCEPTION,
  VehicleOperationalRestrictionType.LEGAL_HOLD,
  VehicleOperationalRestrictionType.OWNERSHIP_EXCEPTION
]);

function assertReleasePermission(
  restrictionType: VehicleOperationalRestrictionType,
  permissions: readonly string[]
) {
  const required = HIGH_RISK_RESTRICTION_TYPES.has(restrictionType)
    ? "vehicle_restriction:approve_release"
    : "vehicle_restriction:release";
  if (!permissions.includes(required)) {
    throw new ForbiddenException({
      code: ASSET_OPERATION_SERVICE_CODE.VEHICLE_RESTRICTION_RELEASE_FORBIDDEN,
      message: "The authenticated operator cannot release this vehicle restriction."
    });
  }
}

function requireActor(context: AssetOperationCommandContext) {
  if (!context.actorId) {
    throw new ForbiddenException({
      code: ASSET_OPERATION_SERVICE_CODE.VEHICLE_RESTRICTION_RELEASE_FORBIDDEN,
      message: "An authenticated operator is required to release a vehicle restriction."
    });
  }
  return context.actorId;
}

function projectWorkOrderDetail(detail: {
  evidence: readonly AssetWorkOrderEvidence[];
  events: readonly AssetWorkOrderEvent[];
  restrictions: readonly VehicleOperationalRestriction[];
  workOrder: AssetWorkOrder;
}) {
  return {
    evidence: projectEvidence(detail.evidence),
    events: [...detail.events]
      .sort((left, right) => left.sequence - right.sequence || compare(left.id, right.id))
      .map(sanitizeAssetOperationPublicValue),
    restrictions: projectRestrictions(detail.restrictions),
    ...projectWorkOrderSummary(detail.workOrder)
  };
}

function projectWorkOrderSummary(workOrder: AssetWorkOrder) {
  const source = {
    id: workOrder.createSourceId,
    key: workOrder.createSourceKey,
    type: workOrder.createSourceType
  };
  return {
    source,
    specialistDeepLink: specialistDeepLink(source),
    workOrder: sanitizeAssetOperationPublicValue(workOrder)
  };
}

function projectEvidence(rows: readonly AssetWorkOrderEvidence[]) {
  const all = [...rows]
    .sort(
      (left, right) =>
        left.recordedAt.getTime() - right.recordedAt.getTime() || compare(left.id, right.id)
    )
    .map(sanitizeAssetOperationPublicValue);
  const superseded = new Set(
    rows.map(({ supersedesEvidenceId }) => supersedesEvidenceId).filter(Boolean)
  );
  const effective = rows
    .filter((row) => row.action !== AssetWorkOrderEvidenceAction.REMOVE && !superseded.has(row.id))
    .sort(
      (left, right) =>
        left.recordedAt.getTime() - right.recordedAt.getTime() || compare(left.id, right.id)
    )
    .map(sanitizeAssetOperationPublicValue);
  return { all, effective };
}

function projectRestriction(row: VehicleOperationalRestriction) {
  const source = {
    id: row.startSourceId,
    key: row.startSourceKey,
    type: row.startSourceType
  };
  return {
    ...sanitizeAssetOperationPublicValue(row),
    source,
    specialistDeepLink: specialistDeepLink(source)
  };
}

function projectRestrictions(rows: readonly VehicleOperationalRestriction[]) {
  const all = [...rows]
    .sort((left, right) => {
      const active =
        Number(right.status === VehicleOperationalRestrictionStatus.ACTIVE) -
        Number(left.status === VehicleOperationalRestrictionStatus.ACTIVE);
      return (
        active || right.startedAt.getTime() - left.startedAt.getTime() || compare(left.id, right.id)
      );
    })
    .map(projectRestriction);
  return {
    active: all.filter(({ status }) => status === VehicleOperationalRestrictionStatus.ACTIVE),
    all
  };
}

function specialistDeepLink(source: StableAssetOperationSource) {
  const id = encodeURIComponent(source.id);
  switch (source.type) {
    case "HANDOVER_WORK_ORDER":
    case "VEHICLE_HANDOVER_WORK_ORDER":
      return `/handover-work-orders/${id}`;
    case "SERVICE_CASE":
      return `/service-cases/${id}`;
    case "VEHICLE_CONDITION_REPORT":
      return `/vehicle-condition-reports/${id}`;
    case "VEHICLE_RETURN":
      return `/vehicle-returns/${id}`;
    default:
      return null;
  }
}

export type AssetOperationJsonSafe<T> = T extends bigint
  ? string
  : T extends Date
    ? T
    : T extends readonly (infer Item)[]
      ? AssetOperationJsonSafe<Item>[]
      : T extends object
        ? { [Key in keyof T]: AssetOperationJsonSafe<T[Key]> }
        : T;

export function sanitizeAssetOperationPublicValue<T>(value: T): AssetOperationJsonSafe<T> {
  if (typeof value === "bigint") return value.toString() as AssetOperationJsonSafe<T>;
  if (Array.isArray(value)) {
    return value.map(sanitizeAssetOperationPublicValue) as AssetOperationJsonSafe<T>;
  }
  if (value instanceof Date || value === null || typeof value !== "object") {
    return value as AssetOperationJsonSafe<T>;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "__assetOperationCommandV1")
      .map(([key, item]) => [key, sanitizeAssetOperationPublicValue(item)])
  ) as AssetOperationJsonSafe<T>;
}

function toAuditSnapshot(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toAuditSnapshot);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      toAuditSnapshot(item)
    ])
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}

function authorityMismatch() {
  return new ConflictException({
    code: ASSET_OPERATION_SERVICE_CODE.AUTHORITY_MISMATCH,
    message: "Asset-operation references do not identify one consistent live aggregate."
  });
}

function callerCapabilityInvalid() {
  return new ConflictException({
    code: ASSET_OPERATION_SERVICE_CODE.CALLER_CAPABILITY_INVALID,
    message: "The caller-owned asset-operation transaction capability is invalid."
  });
}

function hasConflictCode(error: unknown, code: string) {
  if (!(error instanceof ConflictException)) return false;
  const response = error.getResponse();
  return isRecord(response) && response.code === code;
}

function snapshotAssetOperationSource(
  source: StableAssetOperationSource
): StableAssetOperationSource {
  return Object.freeze({ id: source.id, key: source.key, type: source.type });
}

function snapshotCommandContext(
  context: AssetOperationCommandContext
): AssetOperationCommandContext {
  return Object.freeze({
    actorId: context.actorId,
    ...(context.ipAddress === undefined ? {} : { ipAddress: context.ipAddress }),
    permissions: Object.freeze([...context.permissions]),
    ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent })
  });
}

function snapshotCallerOwnedCreateCommand(
  command: CreateWorkOrderServiceCommand
): CreateWorkOrderServiceCommand {
  return deepFreeze(
    structuredClone({
      assetOwnerId: command.assetOwnerId,
      contractId: command.contractId,
      costConfirmationRequired: command.costConfirmationRequired,
      customerId: command.customerId,
      description: command.description,
      metadata: command.metadata,
      occurredAt: command.occurredAt,
      orderId: command.orderId,
      priority: command.priority,
      relatedWorkOrderId: command.relatedWorkOrderId,
      source: snapshotAssetOperationSource(command.source),
      vehicleId: command.vehicleId,
      workOrderType: command.workOrderType
    })
  );
}

function snapshotTransitionCommand(
  command: TransitionWorkOrderServiceCommand
): TransitionWorkOrderServiceCommand {
  return deepFreeze(
    structuredClone({
      closeReason: command.closeReason,
      detailSnapshot: command.detailSnapshot,
      expectedVersion: command.expectedVersion,
      occurredAt: command.occurredAt,
      solution: command.solution,
      source: snapshotAssetOperationSource(command.source),
      targetStatus: command.targetStatus,
      workOrderId: command.workOrderId
    })
  );
}

function snapshotRestrictionCreateCommand(
  command: CreateRestrictionServiceCommand
): CreateRestrictionServiceCommand {
  return deepFreeze(
    structuredClone({
      conditionsSnapshot: command.conditionsSnapshot,
      evidenceSnapshot: command.evidenceSnapshot,
      occurredAt: command.occurredAt,
      restrictionType: command.restrictionType,
      scopes: command.scopes,
      severity: command.severity,
      source: snapshotAssetOperationSource(command.source),
      startedAt: command.startedAt,
      vehicleId: command.vehicleId,
      workOrderId: command.workOrderId
    })
  );
}

function workOrderCoordinatorLocks(authority: AssetOperationsWorkOrderAuthority) {
  return [
    ...(authority.orderId
      ? [{ id: authority.orderId, mode: "SHARE" as const, table: "subscription_order" as const }]
      : []),
    { id: authority.vehicleId, mode: "SHARE" as const, table: "vehicle" as const },
    ...(authority.contractId
      ? [{ id: authority.contractId, mode: "SHARE" as const, table: "contract" as const }]
      : []),
    ...(authority.relatedWorkOrderId
      ? [
          {
            id: authority.relatedWorkOrderId,
            mode: "SHARE" as const,
            table: "asset_work_order" as const
          }
        ]
      : []),
    { id: authority.workOrderId, mode: "UPDATE" as const, table: "asset_work_order" as const },
    ...(authority.assetOwnerId
      ? [{ id: authority.assetOwnerId, mode: "SHARE" as const, table: "asset_owner" as const }]
      : []),
    ...(authority.customerId
      ? [{ id: authority.customerId, mode: "SHARE" as const, table: "customer" as const }]
      : [])
  ];
}

function sameWorkOrderCoordinatorAuthority(
  workOrder: AssetWorkOrder,
  authority: AssetOperationsWorkOrderAuthority
) {
  return (
    workOrder.id === authority.workOrderId &&
    workOrder.vehicleId === authority.vehicleId &&
    workOrder.orderId === authority.orderId &&
    workOrder.contractId === authority.contractId &&
    workOrder.customerId === authority.customerId &&
    workOrder.assetOwnerId === authority.assetOwnerId &&
    workOrder.relatedWorkOrderId === authority.relatedWorkOrderId
  );
}

function isLockUnavailableError(value: unknown) {
  if (!isRecord(value)) return false;
  if (value.code === "55P03") return true;
  if (!isRecord(value.meta) || !isRecord(value.meta.driverAdapterError)) return false;
  const cause = value.meta.driverAdapterError.cause;
  return isRecord(cause) && cause.originalCode === "55P03";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function notFound(code: string, message: string) {
  return new NotFoundException({ code, message });
}
