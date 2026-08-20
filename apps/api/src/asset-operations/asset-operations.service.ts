import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  AssetWorkOrderEvidenceAction,
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

import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  ASSET_OPERATION_ERROR_CODE,
  AssetOperationsRepository
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
type LockedWorkOrderCommandHandle = Awaited<
  ReturnType<AssetOperationsRepository["lockWorkOrderForCommand"]>
>;

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: AssetOperationsRepository,
    private readonly auditService: AuditService
  ) {}

  async createWorkOrder(
    command: CreateWorkOrderServiceCommand,
    context: AssetOperationCommandContext
  ): Promise<WorkOrderCommandOutcome> {
    return this.runCommand(async (tx) => {
      await this.repository.lockSourceOwnership(tx, command.source);
      await lockAuthorityRows(tx, createAuthorityRows(command));
      const authority = await loadCreateAuthority(tx, command);
      const outcome = await this.repository.createWorkOrder(tx, {
        ...command,
        actorId: context.actorId,
        authoritySnapshot: projectAuthority(authority)
      });
      if (outcome.wrote) {
        await this.writeAudit(
          tx,
          AuditAction.CREATE,
          "asset_work_order",
          outcome.workOrder,
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
    return { authority, before: lockHandle.header, lockHandle, workOrder: current };
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

function authorityMismatch() {
  return new ConflictException({
    code: ASSET_OPERATION_SERVICE_CODE.AUTHORITY_MISMATCH,
    message: "Asset-operation references do not identify one consistent live aggregate."
  });
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
