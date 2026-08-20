import { ConflictException, Injectable } from "@nestjs/common";
import {
  AssetWorkOrderEvidenceAction,
  AssetWorkOrderEventType,
  AssetWorkOrderStatus,
  Prisma,
  VehicleOperationalRestrictionStatus,
  type AssetWorkOrder,
  type AssetWorkOrderEvidence,
  type AssetWorkOrderEvent,
  type VehicleOperationalRestriction
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { BUSINESS_NO_RETRY_LIMIT, createBusinessNo } from "../common/business-number";
import type {
  AppendEvidenceCommand,
  AppendNoteCommand,
  AppendWorkOrderEventCommand,
  AssetOperationSnapshot,
  AssetWorkOrderDetailProjection,
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
import type { VehicleAvailabilitySnapshot } from "./vehicle-availability";

export const ASSET_OPERATION_ERROR_CODE = {
  AUTHORITY_BUSY: "ASSET_OPERATION_AUTHORITY_BUSY",
  EVIDENCE_CHAIN_CONFLICT: "ASSET_WORK_ORDER_EVIDENCE_CHAIN_CONFLICT",
  EVIDENCE_INVALID: "ASSET_WORK_ORDER_EVIDENCE_INVALID",
  EVIDENCE_NOT_FOUND: "ASSET_WORK_ORDER_EVIDENCE_NOT_FOUND",
  EVENT_INVALID: "ASSET_WORK_ORDER_EVENT_INVALID",
  EVENT_TIME_INVALID: "ASSET_WORK_ORDER_EVENT_TIME_INVALID",
  FILE_NOT_FOUND: "ASSET_WORK_ORDER_FILE_NOT_FOUND",
  RESTRICTION_INVALID: "VEHICLE_OPERATIONAL_RESTRICTION_INVALID",
  RESTRICTION_NOT_FOUND: "VEHICLE_OPERATIONAL_RESTRICTION_NOT_FOUND",
  RESTRICTION_RELEASE_CONFLICT: "VEHICLE_OPERATIONAL_RESTRICTION_RELEASE_CONFLICT",
  RESTRICTION_RELEASE_EVIDENCE_REQUIRED:
    "VEHICLE_OPERATIONAL_RESTRICTION_RELEASE_EVIDENCE_REQUIRED",
  RESTRICTION_WORK_ORDER_NOT_ACCEPTED: "VEHICLE_OPERATIONAL_RESTRICTION_WORK_ORDER_NOT_ACCEPTED",
  SOURCE_CONFLICT: "ASSET_OPERATION_SOURCE_CONFLICT",
  TRANSACTION_REQUIRED: "ASSET_OPERATION_TRANSACTION_REQUIRED",
  WORK_ORDER_NOT_FOUND: "ASSET_WORK_ORDER_NOT_FOUND",
  WORK_ORDER_TRANSITION_INVALID: "ASSET_WORK_ORDER_TRANSITION_INVALID",
  WORK_ORDER_VERSION_CONFLICT: "ASSET_WORK_ORDER_VERSION_CONFLICT",
  WRITE_CONFLICT: "ASSET_OPERATION_WRITE_CONFLICT"
} as const;

type AssetOperationErrorCode =
  (typeof ASSET_OPERATION_ERROR_CODE)[keyof typeof ASSET_OPERATION_ERROR_CODE];

const ERROR_MESSAGES: Readonly<Record<AssetOperationErrorCode, string>> = {
  [ASSET_OPERATION_ERROR_CODE.AUTHORITY_BUSY]:
    "Asset operation authority is being updated. Review the current state and retry.",
  [ASSET_OPERATION_ERROR_CODE.EVIDENCE_CHAIN_CONFLICT]:
    "The immutable evidence row already has a successor.",
  [ASSET_OPERATION_ERROR_CODE.EVIDENCE_INVALID]: "The evidence command shape is invalid.",
  [ASSET_OPERATION_ERROR_CODE.EVIDENCE_NOT_FOUND]: "The referenced evidence was not found.",
  [ASSET_OPERATION_ERROR_CODE.EVENT_INVALID]:
    "The event must be emitted through its governed work-order command.",
  [ASSET_OPERATION_ERROR_CODE.EVENT_TIME_INVALID]:
    "The event occurrence time cannot be later than the transaction clock.",
  [ASSET_OPERATION_ERROR_CODE.FILE_NOT_FOUND]: "The referenced file is not live.",
  [ASSET_OPERATION_ERROR_CODE.RESTRICTION_INVALID]:
    "The vehicle operational restriction command is invalid.",
  [ASSET_OPERATION_ERROR_CODE.RESTRICTION_NOT_FOUND]:
    "The vehicle operational restriction was not found.",
  [ASSET_OPERATION_ERROR_CODE.RESTRICTION_RELEASE_CONFLICT]:
    "The vehicle operational restriction is no longer active.",
  [ASSET_OPERATION_ERROR_CODE.RESTRICTION_RELEASE_EVIDENCE_REQUIRED]:
    "Restriction release requires a non-empty evidence snapshot.",
  [ASSET_OPERATION_ERROR_CODE.RESTRICTION_WORK_ORDER_NOT_ACCEPTED]:
    "A linked work order must be accepted before its restriction can be released.",
  [ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT]:
    "The stable asset-operation source is already bound to a different payload.",
  [ASSET_OPERATION_ERROR_CODE.TRANSACTION_REQUIRED]:
    "Asset operation commands require a caller-provided PostgreSQL READ COMMITTED interactive transaction.",
  [ASSET_OPERATION_ERROR_CODE.WORK_ORDER_NOT_FOUND]: "The asset work order was not found.",
  [ASSET_OPERATION_ERROR_CODE.WORK_ORDER_TRANSITION_INVALID]:
    "The requested asset work-order transition is invalid.",
  [ASSET_OPERATION_ERROR_CODE.WORK_ORDER_VERSION_CONFLICT]:
    "The asset work order changed after it was read.",
  [ASSET_OPERATION_ERROR_CODE.WRITE_CONFLICT]:
    "The asset operation conflicts with the current database state."
};

const TERMINAL_STATUSES = new Set<AssetWorkOrderStatus>([
  AssetWorkOrderStatus.CANCELLED,
  AssetWorkOrderStatus.CLOSED
]);

const TRANSITIONS: Readonly<Record<AssetWorkOrderStatus, ReadonlySet<AssetWorkOrderStatus>>> = {
  [AssetWorkOrderStatus.PENDING]: new Set([
    AssetWorkOrderStatus.IN_PROGRESS,
    AssetWorkOrderStatus.CANCELLED
  ]),
  [AssetWorkOrderStatus.IN_PROGRESS]: new Set([
    AssetWorkOrderStatus.WAITING_EXTERNAL,
    AssetWorkOrderStatus.PENDING_ACCEPTANCE,
    AssetWorkOrderStatus.CANCELLED
  ]),
  [AssetWorkOrderStatus.WAITING_EXTERNAL]: new Set([
    AssetWorkOrderStatus.IN_PROGRESS,
    AssetWorkOrderStatus.CANCELLED
  ]),
  [AssetWorkOrderStatus.PENDING_ACCEPTANCE]: new Set([
    AssetWorkOrderStatus.IN_PROGRESS,
    AssetWorkOrderStatus.PENDING_COST_CONFIRMATION,
    AssetWorkOrderStatus.CLOSED,
    AssetWorkOrderStatus.CANCELLED
  ]),
  [AssetWorkOrderStatus.PENDING_COST_CONFIRMATION]: new Set([
    AssetWorkOrderStatus.IN_PROGRESS,
    AssetWorkOrderStatus.CLOSED,
    AssetWorkOrderStatus.CANCELLED
  ]),
  [AssetWorkOrderStatus.CLOSED]: new Set(),
  [AssetWorkOrderStatus.CANCELLED]: new Set()
};

const DIRECT_EVENT_TYPES = new Set<AssetWorkOrderEventType>([
  AssetWorkOrderEventType.NOTE_ADDED,
  AssetWorkOrderEventType.PHYSICAL_CONTROL_CONFIRMED,
  AssetWorkOrderEventType.INSPECTION_RECORDED,
  AssetWorkOrderEventType.RESTRICTION_CREATED,
  AssetWorkOrderEventType.RESTRICTION_RELEASED
]);

const COMMAND_ENVELOPE_KEY = "__assetOperationCommandV1";
const WORK_ORDER_DATE_FIELDS = [
  "acceptedAt",
  "cancelledAt",
  "closedAt",
  "costConfirmedAt",
  "createdAt",
  "scheduledAt",
  "slaDueAt",
  "startedAt",
  "updatedAt"
] as const;

type CommandEnvelopeKind =
  | "assign"
  | "create"
  | "event"
  | "evidence"
  | "note"
  | "restriction-create"
  | "restriction-release"
  | "transition";
type CommandEnvelopeInput = Readonly<{ command: unknown; kind: CommandEnvelopeKind }>;

/** Caller-owned READ COMMITTED transaction only; this repository never opens a transaction. */
@Injectable()
export class AssetOperationsRepository {
  constructor(private readonly businessNoFactory = () => createBusinessNo("AWO")) {}

  async createWorkOrder(
    tx: Prisma.TransactionClient,
    command: CreateWorkOrderCommand
  ): Promise<WorkOrderCommandOutcome> {
    const normalized = normalizeCreateCommand(command);
    await prepareCommand(tx, "work-order:create", normalized.source);
    await lockAuthorityRows(tx, createAuthorityRows(normalized));
    const existing = await findWorkOrderByCreateSource(tx, normalized.source);
    if (existing) return replayCreate(tx, existing, normalized);
    await assertEventTime(tx, normalized.occurredAt);
    const workOrder = await this.createHeaderWithUniqueBusinessNo(tx, normalized);
    const event = await createEventRow(tx, {
      actorId: normalized.actorId,
      afterStatus: AssetWorkOrderStatus.PENDING,
      beforeStatus: null,
      detailSnapshot: commandEventDetail(
        { command: normalized, kind: "create" },
        {
          authoritySnapshot: normalized.authoritySnapshot,
          metadata: normalized.metadata
        },
        workOrder
      ),
      eventType: AssetWorkOrderEventType.CREATED,
      occurredAt: normalized.occurredAt,
      sequence: 1,
      source: normalized.source,
      workOrderId: workOrder.id
    });
    return { event, workOrder, wrote: true };
  }

  async assignWorkOrder(
    tx: Prisma.TransactionClient,
    command: AssignWorkOrderCommand
  ): Promise<WorkOrderCommandOutcome> {
    const normalized = { ...command, detailSnapshot: normalizeSnapshot(command.detailSnapshot) };
    await prepareCommand(tx, "work-order:assign", normalized.source);
    await lockAuthorityRows(tx, [{ id: normalized.assignedUserId, table: "user" }]);
    const replay = await findEventBySource(tx, normalized.source);
    if (replay) return replayAssignment(replay, normalized);
    const current = await lockAndLoadWorkOrder(tx, normalized.workOrderId);
    assertVersion(current, normalized.expectedVersion);
    if (TERMINAL_STATUSES.has(current.status)) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.WORK_ORDER_TRANSITION_INVALID);
    }
    await assertEventTime(tx, normalized.occurredAt);
    const updated = await updateHeader(tx, current, normalized.expectedVersion, {
      assignedUserId: normalized.assignedUserId,
      scheduledAt: normalized.scheduledAt,
      slaDueAt: normalized.slaDueAt,
      updatedBy: normalized.actorId,
      version: { increment: 1 }
    });
    const event = await appendEventRow(tx, {
      actorId: normalized.actorId,
      afterStatus: current.status,
      beforeStatus: current.status,
      detailSnapshot: commandEventDetail(
        { command: normalized, kind: "assign" },
        assignmentPayload(normalized),
        updated
      ),
      eventType: AssetWorkOrderEventType.ASSIGNED,
      occurredAt: normalized.occurredAt,
      source: normalized.source,
      workOrderId: current.id
    });
    return { event, workOrder: updated, wrote: true };
  }

  async transitionWorkOrder(
    tx: Prisma.TransactionClient,
    command: TransitionWorkOrderCommand
  ): Promise<WorkOrderCommandOutcome> {
    const normalized = { ...command, detailSnapshot: normalizeSnapshot(command.detailSnapshot) };
    await prepareCommand(tx, "work-order:transition", normalized.source);
    const replay = await findEventBySource(tx, normalized.source);
    if (replay) return replayTransition(replay, normalized);
    const current = await lockAndLoadWorkOrder(tx, normalized.workOrderId);
    assertVersion(current, normalized.expectedVersion);
    assertTransition(current, normalized.targetStatus);
    await assertEventTime(tx, normalized.occurredAt);
    const updated = await updateHeader(
      tx,
      current,
      normalized.expectedVersion,
      transitionUpdate(current, normalized)
    );
    const event = await appendEventRow(tx, {
      actorId: normalized.actorId,
      afterStatus: normalized.targetStatus,
      beforeStatus: current.status,
      detailSnapshot: commandEventDetail(
        { command: normalized, kind: "transition" },
        transitionPayload(normalized, current.status),
        updated
      ),
      eventType: transitionEventType(current.status, normalized.targetStatus),
      occurredAt: normalized.occurredAt,
      source: normalized.source,
      workOrderId: current.id
    });
    return { event, workOrder: updated, wrote: true };
  }

  appendNote(tx: Prisma.TransactionClient, command: AppendNoteCommand) {
    return this.appendEvent(
      tx,
      {
        actorId: command.actorId,
        afterStatus: null,
        beforeStatus: null,
        detailSnapshot: { note: command.note },
        eventType: AssetWorkOrderEventType.NOTE_ADDED,
        occurredAt: command.occurredAt,
        source: command.source,
        workOrderId: command.workOrderId
      },
      { command, kind: "note" }
    );
  }

  private async appendEvent(
    tx: Prisma.TransactionClient,
    command: AppendWorkOrderEventCommand,
    envelope: CommandEnvelopeInput = { command, kind: "event" }
  ): Promise<WorkOrderCommandOutcome> {
    const normalized = { ...command, detailSnapshot: normalizeSnapshot(command.detailSnapshot) };
    await prepareCommand(tx, "work-order:event", normalized.source);
    if (!DIRECT_EVENT_TYPES.has(command.eventType)) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.EVENT_INVALID);
    }
    return appendEventCommand(tx, normalized, { envelope });
  }

  async appendEvidence(
    tx: Prisma.TransactionClient,
    command: AppendEvidenceCommand
  ): Promise<EvidenceCommandOutcome> {
    await prepareCommand(tx, "work-order:evidence", command.source);
    const normalized = normalizeEvidenceCommand(command);
    assertEvidenceShape(normalized);
    if (normalized.fileId) {
      await lockAuthorityRows(tx, [{ id: normalized.fileId, table: "file_object" }]);
    }
    const workOrder = await lockAndLoadWorkOrder(tx, normalized.workOrderId);
    const predecessor = normalized.supersedesEvidenceId
      ? await lockAndLoadEvidence(tx, normalized.supersedesEvidenceId)
      : null;
    const replay = await findEvidenceBySource(tx, normalized.source);
    if (replay) return replayEvidence(tx, replay, normalized);
    assertEvidencePredecessor(predecessor, normalized);
    if (predecessor) {
      const successor = await tx.assetWorkOrderEvidence.findFirst({
        where: { supersedesEvidenceId: predecessor.id }
      });
      if (successor) throw conflict(ASSET_OPERATION_ERROR_CODE.EVIDENCE_CHAIN_CONFLICT);
    }
    if (normalized.eventId) {
      const linkedEvent = await tx.assetWorkOrderEvent.findFirst({
        where: { id: normalized.eventId, workOrderId: normalized.workOrderId }
      });
      if (!linkedEvent) throw conflict(ASSET_OPERATION_ERROR_CODE.EVENT_INVALID);
    }
    const file = normalized.fileId
      ? await tx.fileObject.findUnique({ where: { id: normalized.fileId } })
      : null;
    if (normalized.fileId && !file) throw conflict(ASSET_OPERATION_ERROR_CODE.FILE_NOT_FOUND);
    await assertEventTime(tx, normalized.occurredAt);
    let evidence: AssetWorkOrderEvidence;
    try {
      evidence = await tx.assetWorkOrderEvidence.create({
        data: {
          action: normalized.action,
          actorId: normalized.actorId,
          capturedAt: normalized.capturedAt,
          captureMetadata: normalized.captureMetadata ?? Prisma.JsonNull,
          contentSha256: normalized.contentSha256,
          eventId: normalized.eventId,
          evidenceType: normalized.evidenceType,
          fileBucket: file?.bucket ?? null,
          fileId: normalized.fileId,
          fileMimeType: file?.mimeType ?? null,
          fileObjectKey: file?.objectKey ?? null,
          fileSizeBytes: file?.sizeBytes ?? null,
          sourceId: normalized.source.id,
          sourceKey: normalized.source.key,
          sourceType: normalized.source.type,
          supersedesEvidenceId: normalized.supersedesEvidenceId,
          workOrderId: normalized.workOrderId
        }
      });
    } catch (error) {
      throw normalizeWriteError(error, "evidence");
    }
    const eventOutcome = await appendEventCommand(
      tx,
      {
        actorId: normalized.actorId,
        afterStatus: null,
        beforeStatus: null,
        detailSnapshot: normalizeSnapshot({
          action: normalized.action,
          evidenceId: evidence.id,
          evidenceType: normalized.evidenceType,
          supersedesEvidenceId: normalized.supersedesEvidenceId
        }),
        eventType: AssetWorkOrderEventType.EVIDENCE_ATTACHED,
        occurredAt: normalized.occurredAt,
        source: normalized.source,
        workOrderId: normalized.workOrderId
      },
      {
        allowGovernedEvent: true,
        envelope: { command: normalized, kind: "evidence" },
        headerAlreadyLocked: workOrder
      }
    );
    return {
      evidence,
      event: eventOutcome.event,
      workOrder: eventOutcome.workOrder,
      wrote: true
    };
  }

  async createRestriction(
    tx: Prisma.TransactionClient,
    command: CreateRestrictionCommand
  ): Promise<RestrictionCommandOutcome> {
    await prepareCommand(tx, "restriction:create", command.source);
    const normalized = normalizeCreateRestrictionCommand(command);
    assertCreateRestrictionShape(normalized);
    await lockAuthorityRows(tx, restrictionAuthorityRows(normalized));
    const vehicle = await tx.vehicle.findUnique({
      select: { id: true },
      where: { id: normalized.vehicleId }
    });
    if (!vehicle) throw conflict(ASSET_OPERATION_ERROR_CODE.RESTRICTION_INVALID);
    const linkedWorkOrder = normalized.workOrderId
      ? await lockAndLoadWorkOrderNowait(tx, normalized.workOrderId)
      : null;
    if (
      normalized.workOrderId &&
      (!linkedWorkOrder || linkedWorkOrder.vehicleId !== normalized.vehicleId)
    ) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.RESTRICTION_INVALID);
    }
    const existing = await findRestrictionByStartSource(tx, normalized.source);
    if (existing) return replayRestrictionCreate(tx, existing, normalized);
    if (await findRestrictionByReleaseSource(tx, normalized.source)) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
    }
    const eventCollision = await findEventBySource(tx, normalized.source);
    if (eventCollision) throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
    const transactionNow = await transactionClock(tx);
    assertNotFuture(normalized.occurredAt, transactionNow);
    const workOrder = linkedWorkOrder;
    const restriction = createRestrictionResult(normalized, transactionNow);
    let stored: VehicleOperationalRestriction;
    try {
      stored = await tx.vehicleOperationalRestriction.create({
        data: {
          ...restriction,
          conditionsSnapshot: restrictionEnvelopeSnapshot(
            restriction.conditionsSnapshot,
            { command: normalized, kind: "restriction-create" },
            restriction
          ),
          evidenceSnapshot: restriction.evidenceSnapshot ?? Prisma.DbNull,
          releaseSnapshot: Prisma.DbNull
        }
      });
    } catch (error) {
      throw normalizeWriteError(error, "restriction");
    }
    const publicRestriction = restrictionEnvelopeResult(stored.conditionsSnapshot, {
      command: normalized,
      kind: "restriction-create"
    });
    if (!workOrder) {
      return { event: null, restriction: publicRestriction, workOrder: null, wrote: true };
    }
    const eventOutcome = await appendEventCommand(
      tx,
      {
        actorId: normalized.actorId,
        afterStatus: null,
        beforeStatus: null,
        detailSnapshot: {
          restrictionId: publicRestriction.id,
          restrictionType: publicRestriction.restrictionType,
          scopes: publicRestriction.scopes,
          severity: publicRestriction.severity
        },
        eventType: AssetWorkOrderEventType.RESTRICTION_CREATED,
        occurredAt: normalized.occurredAt,
        source: normalized.source,
        workOrderId: workOrder.id
      },
      {
        allowGovernedEvent: true,
        envelope: { command: normalized, kind: "restriction-create" },
        headerAlreadyLocked: workOrder
      }
    );
    return {
      event: eventOutcome.event,
      restriction: publicRestriction,
      workOrder: eventOutcome.workOrder,
      wrote: true
    };
  }

  async releaseRestriction(
    tx: Prisma.TransactionClient,
    command: ReleaseRestrictionCommand
  ): Promise<RestrictionCommandOutcome> {
    await prepareCommand(tx, "restriction:release", command.source);
    const normalized = normalizeReleaseRestrictionCommand(command);
    assertReleaseRestrictionShape(normalized);
    const replay = await findRestrictionByReleaseSource(tx, normalized.source);
    if (replay) return replayRestrictionRelease(tx, replay, normalized);
    if (await findRestrictionByStartSource(tx, normalized.source)) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
    }
    if (await findEventBySource(tx, normalized.source)) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
    }
    const candidate = await tx.vehicleOperationalRestriction.findUnique({
      where: { id: normalized.restrictionId }
    });
    if (!candidate) throw conflict(ASSET_OPERATION_ERROR_CODE.RESTRICTION_NOT_FOUND);
    const workOrder = candidate.workOrderId
      ? await lockAndLoadWorkOrderNowait(tx, candidate.workOrderId)
      : null;
    const current = await lockAndLoadRestriction(tx, normalized.restrictionId);
    if (current.status !== VehicleOperationalRestrictionStatus.ACTIVE) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.RESTRICTION_RELEASE_CONFLICT);
    }
    const transactionNow = await transactionClock(tx);
    assertNotFuture(normalized.occurredAt, transactionNow);
    if (normalized.occurredAt.getTime() < current.startedAt.getTime()) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.RESTRICTION_INVALID);
    }
    if (current.workOrderId !== workOrder?.id && current.workOrderId !== null) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.RESTRICTION_INVALID);
    }
    if (
      workOrder &&
      workOrder.status !== AssetWorkOrderStatus.PENDING_COST_CONFIRMATION &&
      workOrder.status !== AssetWorkOrderStatus.CLOSED
    ) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.RESTRICTION_WORK_ORDER_NOT_ACCEPTED);
    }
    const publicResult = releaseRestrictionResult(current, normalized, transactionNow);
    let stored: VehicleOperationalRestriction;
    try {
      stored = await tx.vehicleOperationalRestriction.update({
        data: {
          releaseReason: normalized.releaseReason,
          releaseSnapshot: restrictionEnvelopeSnapshot(
            normalized.releaseSnapshot,
            { command: normalized, kind: "restriction-release" },
            publicResult
          ),
          releaseSourceId: normalized.source.id,
          releaseSourceKey: normalized.source.key,
          releaseSourceType: normalized.source.type,
          releasedAt: normalized.occurredAt,
          releasedBy: normalized.actorId,
          status: normalized.targetStatus,
          updatedAt: transactionNow,
          updatedBy: normalized.actorId
        },
        where: { id: current.id }
      });
    } catch (error) {
      throw normalizeWriteError(error, "restriction");
    }
    const publicRestriction = restrictionEnvelopeResult(stored.releaseSnapshot, {
      command: normalized,
      kind: "restriction-release"
    });
    if (!workOrder) {
      return { event: null, restriction: publicRestriction, workOrder: null, wrote: true };
    }
    const eventOutcome = await appendEventCommand(
      tx,
      {
        actorId: normalized.actorId,
        afterStatus: null,
        beforeStatus: null,
        detailSnapshot: {
          releaseReason: normalized.releaseReason,
          restrictionId: publicRestriction.id,
          status: normalized.targetStatus
        },
        eventType: AssetWorkOrderEventType.RESTRICTION_RELEASED,
        occurredAt: normalized.occurredAt,
        source: normalized.source,
        workOrderId: workOrder.id
      },
      {
        allowGovernedEvent: true,
        envelope: { command: normalized, kind: "restriction-release" },
        headerAlreadyLocked: workOrder
      }
    );
    return {
      event: eventOutcome.event,
      restriction: publicRestriction,
      workOrder: eventOutcome.workOrder,
      wrote: true
    };
  }

  async loadAvailabilitySnapshot(
    tx: Prisma.TransactionClient,
    vehicleId: string,
    asOf: Date
  ): Promise<VehicleAvailabilitySnapshot> {
    await assertTransactionContract(tx);
    const [vehicle, activeSubscriptionPeriods, restrictions] = await Promise.all([
      tx.vehicle.findUnique({
        select: {
          currentSalePriceAmount: true,
          deletedAt: true,
          id: true,
          salePriceStatus: true,
          status: true
        },
        where: { id: vehicleId }
      }),
      tx.vehicleSubscriptionPeriod.findMany({
        orderBy: { id: "asc" },
        select: { id: true, orderId: true },
        where: {
          OR: [{ endedAt: null }, { endedAt: { gt: asOf } }],
          startedAt: { lte: asOf },
          vehicleId
        }
      }),
      tx.vehicleOperationalRestriction.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          restrictionType: true,
          scopes: true,
          severity: true,
          startSourceId: true,
          startSourceKey: true,
          startSourceType: true,
          workOrderId: true
        },
        where: {
          startedAt: { lte: asOf },
          status: VehicleOperationalRestrictionStatus.ACTIVE,
          vehicleId
        }
      })
    ]);
    return {
      activeRestrictions: restrictions.map((restriction) => ({
        id: restriction.id,
        restrictionType: restriction.restrictionType,
        scopes: restriction.scopes,
        severity: restriction.severity,
        sourceId: restriction.startSourceId,
        sourceKey: restriction.startSourceKey,
        sourceType: restriction.startSourceType,
        workOrderId: restriction.workOrderId
      })),
      activeSubscriptionPeriods,
      vehicle
    };
  }

  async getWorkOrderDetail(
    tx: Prisma.TransactionClient,
    workOrderId: string
  ): Promise<AssetWorkOrderDetailProjection | null> {
    await assertTransactionContract(tx);
    const workOrder = await tx.assetWorkOrder.findUnique({ where: { id: workOrderId } });
    if (!workOrder) return null;
    const [events, evidence, restrictions] = await Promise.all([
      tx.assetWorkOrderEvent.findMany({
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
        where: { workOrderId }
      }),
      tx.assetWorkOrderEvidence.findMany({
        orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
        where: { workOrderId }
      }),
      tx.vehicleOperationalRestriction.findMany({
        orderBy: { id: "asc" },
        where: { workOrderId }
      })
    ]);
    return { evidence, events, restrictions, workOrder };
  }

  async listWorkOrdersByVehicle(tx: Prisma.TransactionClient, vehicleId: string) {
    await assertTransactionContract(tx);
    return tx.assetWorkOrder.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      where: { vehicleId }
    });
  }

  private async createHeaderWithUniqueBusinessNo(
    tx: Prisma.TransactionClient,
    command: CreateWorkOrderCommand
  ) {
    for (let attempt = 1; attempt <= BUSINESS_NO_RETRY_LIMIT; attempt += 1) {
      const workOrderNo = this.businessNoFactory();
      await acquireAdvisoryLock(tx, ["asset-operations", "work-order-no", workOrderNo]);
      if (await tx.assetWorkOrder.findUnique({ where: { workOrderNo } })) continue;
      try {
        return await tx.assetWorkOrder.create({
          data: {
            assetOwnerId: command.assetOwnerId,
            authoritySnapshot: command.authoritySnapshot,
            contractId: command.contractId,
            costConfirmationRequired: command.costConfirmationRequired,
            createSourceId: command.source.id,
            createSourceKey: command.source.key,
            createSourceType: command.source.type,
            createdBy: command.actorId,
            customerId: command.customerId,
            description: command.description,
            metadata: command.metadata ?? Prisma.JsonNull,
            orderId: command.orderId,
            priority: command.priority,
            relatedWorkOrderId: command.relatedWorkOrderId,
            updatedBy: command.actorId,
            vehicleId: command.vehicleId,
            workOrderNo,
            workOrderType: command.workOrderType
          }
        });
      } catch (error) {
        throw normalizeWriteError(error, "work-order");
      }
    }
    throw conflict(ASSET_OPERATION_ERROR_CODE.WRITE_CONFLICT);
  }
}

type AuthorityTable =
  | "asset_owner"
  | "asset_work_order"
  | "contract"
  | "customer"
  | "file_object"
  | "subscription_order"
  | "user"
  | "vehicle";

type NormalizedEvidenceCommand = Omit<AppendEvidenceCommand, "captureMetadata"> & {
  captureMetadata: Prisma.JsonObject | null;
};

type NormalizedCreateRestrictionCommand = Omit<
  CreateRestrictionCommand,
  "conditionsSnapshot" | "evidenceSnapshot" | "scopes"
> & {
  conditionsSnapshot: Prisma.JsonObject;
  evidenceSnapshot: Prisma.JsonObject | null;
  scopes: CreateRestrictionCommand["scopes"];
};

type NormalizedReleaseRestrictionCommand = Omit<ReleaseRestrictionCommand, "releaseSnapshot"> & {
  releaseSnapshot: Prisma.JsonObject;
};

async function prepareCommand(
  tx: Prisma.TransactionClient,
  namespace: string,
  source: StableAssetOperationSource
) {
  await assertTransactionContract(tx);
  await acquireAdvisoryLock(tx, [
    "asset-operations",
    namespace,
    source.type,
    source.id,
    source.key
  ]);
}

async function assertTransactionContract(tx: Prisma.TransactionClient) {
  const [first] = await tx.$queryRaw<Array<{ isolationLevel: string; transactionId: string }>>(
    Prisma.sql`
      SELECT current_setting('transaction_isolation') AS "isolationLevel",
             txid_current()::text AS "transactionId"
    `
  );
  const [second] = await tx.$queryRaw<Array<{ transactionId: string }>>(
    Prisma.sql`SELECT txid_current()::text AS "transactionId"`
  );
  if (
    first?.isolationLevel !== "read committed" ||
    !first.transactionId ||
    first.transactionId !== second?.transactionId
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.TRANSACTION_REQUIRED);
  }
}

async function acquireAdvisoryLock(tx: Prisma.TransactionClient, parts: readonly string[]) {
  const lockKey = JSON.stringify(parts);
  try {
    await tx.$queryRaw(
      Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
    );
  } catch (error) {
    if (isLockUnavailableError(error)) throw conflict(ASSET_OPERATION_ERROR_CODE.AUTHORITY_BUSY);
    throw error;
  }
}

async function lockAuthorityRows(
  tx: Prisma.TransactionClient,
  rows: ReadonlyArray<{ id: string; table: AuthorityTable }>
) {
  const ordered = [...rows].sort((left, right) =>
    left.table === right.table ? compare(left.id, right.id) : compare(left.table, right.table)
  );
  try {
    for (const row of ordered) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${row.table}"`)} WHERE "id" = ${row.id}::uuid FOR SHARE NOWAIT`
      );
    }
  } catch (error) {
    if (isLockUnavailableError(error)) throw conflict(ASSET_OPERATION_ERROR_CODE.AUTHORITY_BUSY);
    throw error;
  }
}

function createAuthorityRows(command: CreateWorkOrderCommand) {
  const rows: Array<{ id: string; table: AuthorityTable }> = [];
  if (command.assetOwnerId) rows.push({ id: command.assetOwnerId, table: "asset_owner" });
  if (command.contractId) rows.push({ id: command.contractId, table: "contract" });
  if (command.customerId) rows.push({ id: command.customerId, table: "customer" });
  if (command.orderId) rows.push({ id: command.orderId, table: "subscription_order" });
  if (command.relatedWorkOrderId) {
    rows.push({ id: command.relatedWorkOrderId, table: "asset_work_order" });
  }
  rows.push({ id: command.vehicleId, table: "vehicle" });
  return rows;
}

async function lockAndLoadWorkOrder(tx: Prisma.TransactionClient, workOrderId: string) {
  try {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "asset_work_order" WHERE "id" = ${workOrderId}::uuid FOR UPDATE`
    );
  } catch (error) {
    if (isLockUnavailableError(error)) throw conflict(ASSET_OPERATION_ERROR_CODE.AUTHORITY_BUSY);
    throw error;
  }
  const workOrder = await tx.assetWorkOrder.findUnique({ where: { id: workOrderId } });
  if (!workOrder) throw conflict(ASSET_OPERATION_ERROR_CODE.WORK_ORDER_NOT_FOUND);
  return workOrder;
}

async function lockAndLoadWorkOrderNowait(tx: Prisma.TransactionClient, workOrderId: string) {
  try {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "asset_work_order" WHERE "id" = ${workOrderId}::uuid FOR UPDATE NOWAIT`
    );
  } catch (error) {
    if (isLockUnavailableError(error)) throw conflict(ASSET_OPERATION_ERROR_CODE.AUTHORITY_BUSY);
    throw error;
  }
  const workOrder = await tx.assetWorkOrder.findUnique({ where: { id: workOrderId } });
  if (!workOrder) throw conflict(ASSET_OPERATION_ERROR_CODE.WORK_ORDER_NOT_FOUND);
  return workOrder;
}

async function lockAndLoadEvidence(tx: Prisma.TransactionClient, evidenceId: string) {
  try {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "asset_work_order_evidence" WHERE "id" = ${evidenceId}::uuid FOR UPDATE`
    );
  } catch (error) {
    if (isLockUnavailableError(error)) throw conflict(ASSET_OPERATION_ERROR_CODE.AUTHORITY_BUSY);
    throw error;
  }
  const evidence = await tx.assetWorkOrderEvidence.findFirst({ where: { id: evidenceId } });
  if (!evidence) throw conflict(ASSET_OPERATION_ERROR_CODE.EVIDENCE_NOT_FOUND);
  return evidence;
}

async function lockAndLoadRestriction(tx: Prisma.TransactionClient, restrictionId: string) {
  try {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "vehicle_operational_restriction" WHERE "id" = ${restrictionId}::uuid FOR UPDATE`
    );
  } catch (error) {
    if (isLockUnavailableError(error)) throw conflict(ASSET_OPERATION_ERROR_CODE.AUTHORITY_BUSY);
    throw error;
  }
  const restriction = await tx.vehicleOperationalRestriction.findUnique({
    where: { id: restrictionId }
  });
  if (!restriction) throw conflict(ASSET_OPERATION_ERROR_CODE.RESTRICTION_NOT_FOUND);
  return restriction;
}

async function appendEventCommand(
  tx: Prisma.TransactionClient,
  command: AppendWorkOrderEventCommand,
  options: {
    allowGovernedEvent?: boolean;
    envelope?: CommandEnvelopeInput;
    headerAlreadyLocked?: AssetWorkOrder;
  } = {}
): Promise<WorkOrderCommandOutcome> {
  if (!options.allowGovernedEvent && !DIRECT_EVENT_TYPES.has(command.eventType)) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.EVENT_INVALID);
  }
  const replay = await findEventBySource(tx, command.source);
  const envelope = options.envelope ?? { command, kind: "event" };
  if (replay) return replayEvent(replay, command, envelope);
  const workOrder =
    options.headerAlreadyLocked ?? (await lockAndLoadWorkOrder(tx, command.workOrderId));
  await assertEventTime(tx, command.occurredAt);
  const event = await appendEventRow(tx, {
    ...command,
    detailSnapshot: commandEventDetail(envelope, command.detailSnapshot, workOrder)
  });
  return { event, workOrder, wrote: true };
}

async function appendEventRow(tx: Prisma.TransactionClient, command: AppendWorkOrderEventCommand) {
  const aggregate = await tx.assetWorkOrderEvent.aggregate({
    _max: { sequence: true },
    where: { workOrderId: command.workOrderId }
  });
  return createEventRow(tx, { ...command, sequence: (aggregate._max.sequence ?? 0) + 1 });
}

async function createEventRow(
  tx: Prisma.TransactionClient,
  command: AppendWorkOrderEventCommand & { sequence: number }
) {
  try {
    return await tx.assetWorkOrderEvent.create({
      data: {
        actorId: command.actorId,
        afterStatus: command.afterStatus,
        beforeStatus: command.beforeStatus,
        detailSnapshot: command.detailSnapshot,
        eventType: command.eventType,
        occurredAt: command.occurredAt,
        sequence: command.sequence,
        sourceId: command.source.id,
        sourceKey: command.source.key,
        sourceType: command.source.type,
        workOrderId: command.workOrderId
      }
    });
  } catch (error) {
    throw normalizeWriteError(error, "event");
  }
}

async function updateHeader(
  tx: Prisma.TransactionClient,
  current: AssetWorkOrder,
  expectedVersion: number,
  data: Prisma.AssetWorkOrderUncheckedUpdateManyInput
) {
  const updated = await tx.assetWorkOrder.updateMany({
    data,
    where: { id: current.id, status: current.status, version: expectedVersion }
  });
  if (updated.count !== 1) throw conflict(ASSET_OPERATION_ERROR_CODE.WORK_ORDER_VERSION_CONFLICT);
  const workOrder = await tx.assetWorkOrder.findUnique({ where: { id: current.id } });
  if (!workOrder) throw conflict(ASSET_OPERATION_ERROR_CODE.WORK_ORDER_NOT_FOUND);
  return workOrder;
}

async function assertEventTime(tx: Prisma.TransactionClient, occurredAt: Date) {
  assertNotFuture(occurredAt, await transactionClock(tx));
}

async function transactionClock(tx: Prisma.TransactionClient) {
  const [clock] = await tx.$queryRaw<Array<{ transactionNow: Date }>>(
    Prisma.sql`SELECT transaction_timestamp() AS "transactionNow"`
  );
  if (!clock?.transactionNow) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.EVENT_TIME_INVALID);
  }
  return clock.transactionNow;
}

function assertNotFuture(value: Date, transactionNow: Date) {
  if (value.getTime() > transactionNow.getTime()) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.EVENT_TIME_INVALID);
  }
}

function assertTransition(current: AssetWorkOrder, target: AssetWorkOrderStatus) {
  if (!TRANSITIONS[current.status].has(target)) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.WORK_ORDER_TRANSITION_INVALID);
  }
  if (
    current.status === AssetWorkOrderStatus.PENDING_ACCEPTANCE &&
    target === AssetWorkOrderStatus.CLOSED &&
    current.costConfirmationRequired
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.WORK_ORDER_TRANSITION_INVALID);
  }
  if (
    current.status === AssetWorkOrderStatus.PENDING_ACCEPTANCE &&
    target === AssetWorkOrderStatus.PENDING_COST_CONFIRMATION &&
    !current.costConfirmationRequired
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.WORK_ORDER_TRANSITION_INVALID);
  }
}

function transitionEventType(from: AssetWorkOrderStatus, to: AssetWorkOrderStatus) {
  if (to === AssetWorkOrderStatus.CANCELLED) return AssetWorkOrderEventType.CANCELLED;
  if (to === AssetWorkOrderStatus.WAITING_EXTERNAL) return AssetWorkOrderEventType.WAITING_EXTERNAL;
  if (to === AssetWorkOrderStatus.PENDING_ACCEPTANCE) {
    return AssetWorkOrderEventType.SUBMITTED_FOR_ACCEPTANCE;
  }
  if (to === AssetWorkOrderStatus.PENDING_COST_CONFIRMATION) {
    return AssetWorkOrderEventType.ACCEPTED;
  }
  if (to === AssetWorkOrderStatus.CLOSED) {
    return from === AssetWorkOrderStatus.PENDING_COST_CONFIRMATION
      ? AssetWorkOrderEventType.COST_CONFIRMED
      : AssetWorkOrderEventType.CLOSED;
  }
  return from === AssetWorkOrderStatus.PENDING
    ? AssetWorkOrderEventType.STARTED
    : AssetWorkOrderEventType.RESUMED;
}

function transitionUpdate(current: AssetWorkOrder, command: TransitionWorkOrderCommand) {
  const data: Prisma.AssetWorkOrderUncheckedUpdateManyInput = {
    status: command.targetStatus,
    updatedBy: command.actorId,
    version: { increment: 1 }
  };
  if (current.status === AssetWorkOrderStatus.PENDING) data.startedAt = command.occurredAt;
  if (command.targetStatus === AssetWorkOrderStatus.PENDING_COST_CONFIRMATION) {
    data.acceptedAt = command.occurredAt;
  }
  if (command.targetStatus === AssetWorkOrderStatus.CLOSED) {
    data.closedAt = command.occurredAt;
    data.closeReason = command.closeReason;
    data.solution = command.solution;
    if (current.status === AssetWorkOrderStatus.PENDING_ACCEPTANCE) {
      data.acceptedAt = command.occurredAt;
    } else {
      data.costConfirmedAt = command.occurredAt;
    }
  }
  if (command.targetStatus === AssetWorkOrderStatus.CANCELLED) {
    data.cancelledAt = command.occurredAt;
    data.closeReason = command.closeReason;
  }
  return data;
}

function assertVersion(current: AssetWorkOrder, expectedVersion: number) {
  if (current.version !== expectedVersion) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.WORK_ORDER_VERSION_CONFLICT);
  }
}

function normalizeCreateCommand(command: CreateWorkOrderCommand): CreateWorkOrderCommand {
  return {
    ...command,
    authoritySnapshot: normalizeSnapshot(command.authoritySnapshot),
    metadata: command.metadata ? normalizeSnapshot(command.metadata) : null
  };
}

function normalizeEvidenceCommand(command: AppendEvidenceCommand): NormalizedEvidenceCommand {
  return {
    ...command,
    captureMetadata: command.captureMetadata ? normalizeSnapshot(command.captureMetadata) : null,
    contentSha256: command.contentSha256 ? normalizeSha256(command.contentSha256) : null
  };
}

function normalizeCreateRestrictionCommand(
  command: CreateRestrictionCommand
): NormalizedCreateRestrictionCommand {
  return {
    ...command,
    conditionsSnapshot: normalizeSnapshot(command.conditionsSnapshot),
    evidenceSnapshot: command.evidenceSnapshot ? normalizeSnapshot(command.evidenceSnapshot) : null,
    scopes: [...new Set(command.scopes)].sort(compare)
  };
}

function normalizeReleaseRestrictionCommand(
  command: ReleaseRestrictionCommand
): NormalizedReleaseRestrictionCommand {
  return { ...command, releaseSnapshot: normalizeSnapshot(command.releaseSnapshot) };
}

function assertCreateRestrictionShape(command: NormalizedCreateRestrictionCommand) {
  if (command.scopes.length === 0 || Object.keys(command.conditionsSnapshot).length === 0) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.RESTRICTION_INVALID);
  }
}

function assertReleaseRestrictionShape(command: NormalizedReleaseRestrictionCommand) {
  if (
    !command.actorId ||
    !command.releaseReason.trim() ||
    Object.keys(command.releaseSnapshot).length === 0 ||
    (command.targetStatus !== VehicleOperationalRestrictionStatus.RELEASED &&
      command.targetStatus !== VehicleOperationalRestrictionStatus.VOIDED)
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.RESTRICTION_RELEASE_EVIDENCE_REQUIRED);
  }
}

function restrictionAuthorityRows(command: NormalizedCreateRestrictionCommand) {
  return [{ id: command.vehicleId, table: "vehicle" }] as const;
}

function createRestrictionResult(
  command: NormalizedCreateRestrictionCommand,
  transactionNow: Date
): VehicleOperationalRestriction {
  return {
    conditionsSnapshot: command.conditionsSnapshot,
    createdAt: transactionNow,
    createdBy: command.actorId,
    evidenceSnapshot: command.evidenceSnapshot,
    id: randomUUID(),
    releaseReason: null,
    releaseSnapshot: null,
    releaseSourceId: null,
    releaseSourceKey: null,
    releaseSourceType: null,
    releasedAt: null,
    releasedBy: null,
    restrictionType: command.restrictionType,
    scopes: [...command.scopes],
    severity: command.severity,
    startSourceId: command.source.id,
    startSourceKey: command.source.key,
    startSourceType: command.source.type,
    startedAt: command.startedAt,
    status: VehicleOperationalRestrictionStatus.ACTIVE,
    updatedAt: transactionNow,
    updatedBy: command.actorId,
    vehicleId: command.vehicleId,
    workOrderId: command.workOrderId
  };
}

function releaseRestrictionResult(
  current: VehicleOperationalRestriction,
  command: NormalizedReleaseRestrictionCommand,
  transactionNow: Date
): VehicleOperationalRestriction {
  return {
    ...current,
    conditionsSnapshot: publicSnapshot(current.conditionsSnapshot),
    releaseReason: command.releaseReason,
    releaseSnapshot: command.releaseSnapshot,
    releaseSourceId: command.source.id,
    releaseSourceKey: command.source.key,
    releaseSourceType: command.source.type,
    releasedAt: command.occurredAt,
    releasedBy: command.actorId,
    status: command.targetStatus,
    updatedAt: transactionNow,
    updatedBy: command.actorId
  };
}

function restrictionEnvelopeSnapshot(
  publicValue: Prisma.JsonValue,
  envelope: CommandEnvelopeInput,
  restriction: VehicleOperationalRestriction
) {
  const publicObject = normalizeSnapshot(publicValue);
  return normalizeSnapshot({
    ...publicObject,
    [COMMAND_ENVELOPE_KEY]: {
      command: normalizeSnapshot(envelope.command),
      kind: envelope.kind,
      result: { restriction: normalizeSnapshot(restriction) },
      version: 1
    }
  });
}

function restrictionEnvelopeResult(
  snapshot: Prisma.JsonValue | null,
  expected: CommandEnvelopeInput
) {
  if (!isRecord(snapshot)) throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  const envelope = snapshot[COMMAND_ENVELOPE_KEY];
  if (
    !isRecord(envelope) ||
    envelope.version !== 1 ||
    envelope.kind !== expected.kind ||
    !isDeepStrictEqual(envelope.command, normalizeSnapshot(expected.command)) ||
    !isRecord(envelope.result) ||
    !isRecord(envelope.result.restriction)
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  const restriction = normalizeSnapshot(envelope.result.restriction) as Record<string, unknown>;
  for (const field of ["createdAt", "releasedAt", "startedAt", "updatedAt"] as const) {
    const value = restriction[field];
    if (value === null || value === undefined) continue;
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
    }
    restriction[field] = new Date(value);
  }
  return restriction as VehicleOperationalRestriction;
}

function publicSnapshot(snapshot: Prisma.JsonValue) {
  const value = normalizeSnapshot(snapshot);
  delete value[COMMAND_ENVELOPE_KEY];
  return value;
}

function commandEventDetail(
  envelope: CommandEnvelopeInput,
  detailSnapshot: AssetOperationSnapshot,
  workOrder: AssetWorkOrder
) {
  const publicDetail = normalizeSnapshot(detailSnapshot);
  return normalizeSnapshot({
    ...publicDetail,
    [COMMAND_ENVELOPE_KEY]: {
      command: normalizeSnapshot(envelope.command),
      kind: envelope.kind,
      result: { workOrder: normalizeSnapshot(workOrder) },
      version: 1
    }
  });
}

function sameCommandEnvelope(event: AssetWorkOrderEvent, expected: CommandEnvelopeInput) {
  const envelope = commandEnvelope(event);
  return (
    envelope?.version === 1 &&
    envelope.kind === expected.kind &&
    isDeepStrictEqual(envelope.command, normalizeSnapshot(expected.command))
  );
}

function commandPayload(event: AssetWorkOrderEvent) {
  if (!isRecord(event.detailSnapshot)) return null;
  const payload = { ...event.detailSnapshot };
  delete payload[COMMAND_ENVELOPE_KEY];
  return payload;
}

function envelopeWorkOrder(event: AssetWorkOrderEvent, expected: CommandEnvelopeInput) {
  const envelope = commandEnvelope(event);
  if (
    !envelope ||
    envelope.version !== 1 ||
    envelope.kind !== expected.kind ||
    !isDeepStrictEqual(envelope.command, normalizeSnapshot(expected.command)) ||
    !isRecord(envelope.result) ||
    !isRecord(envelope.result.workOrder)
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  const workOrder = normalizeSnapshot(envelope.result.workOrder) as Record<string, unknown>;
  if (workOrder.id !== event.workOrderId) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  for (const field of WORK_ORDER_DATE_FIELDS) {
    const value = workOrder[field];
    if (value === null || value === undefined) continue;
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
    }
    workOrder[field] = new Date(value);
  }
  return workOrder as AssetWorkOrder;
}

function commandEnvelope(event: AssetWorkOrderEvent) {
  if (!isRecord(event.detailSnapshot)) return null;
  const envelope = event.detailSnapshot[COMMAND_ENVELOPE_KEY];
  return isRecord(envelope) ? envelope : null;
}

function normalizeSnapshot(snapshot: unknown): Prisma.JsonObject {
  const normalized: unknown = JSON.parse(JSON.stringify(snapshot));
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.WRITE_CONFLICT);
  }
  return normalized as Prisma.JsonObject;
}

function normalizeSha256(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.EVIDENCE_INVALID);
  }
  return normalized;
}

function assertEvidenceShape(command: NormalizedEvidenceCommand) {
  const attach =
    command.action === AssetWorkOrderEvidenceAction.ATTACH &&
    Boolean(command.fileId && command.contentSha256 && !command.supersedesEvidenceId);
  const supersede =
    command.action === AssetWorkOrderEvidenceAction.SUPERSEDE &&
    Boolean(command.fileId && command.contentSha256 && command.supersedesEvidenceId);
  const remove =
    command.action === AssetWorkOrderEvidenceAction.REMOVE &&
    !command.fileId &&
    !command.contentSha256 &&
    Boolean(command.supersedesEvidenceId);
  if (!attach && !supersede && !remove) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.EVIDENCE_INVALID);
  }
}

function assertEvidencePredecessor(
  predecessor: AssetWorkOrderEvidence | null,
  command: NormalizedEvidenceCommand
) {
  if (!predecessor) return;
  if (
    predecessor.workOrderId !== command.workOrderId ||
    predecessor.evidenceType !== command.evidenceType
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.EVIDENCE_INVALID);
  }
}

async function replayCreate(
  tx: Prisma.TransactionClient,
  existing: AssetWorkOrder,
  command: CreateWorkOrderCommand
): Promise<WorkOrderCommandOutcome> {
  const event = await findEventBySource(tx, command.source);
  if (event && sameCreate(existing, event, command)) {
    return replayEventWorkOrder(event, { command, kind: "create" });
  }
  throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
}

async function replayRestrictionCreate(
  tx: Prisma.TransactionClient,
  existing: VehicleOperationalRestriction,
  command: NormalizedCreateRestrictionCommand
): Promise<RestrictionCommandOutcome> {
  const restriction = restrictionEnvelopeResult(existing.conditionsSnapshot, {
    command,
    kind: "restriction-create"
  });
  if (restriction.id !== existing.id || restriction.workOrderId !== command.workOrderId) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  const event = await findEventBySource(tx, command.source);
  if (!command.workOrderId) {
    if (event) throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
    return { event: null, restriction, workOrder: null, wrote: false };
  }
  if (
    !event ||
    !sameRestrictionEvent(
      event,
      command,
      AssetWorkOrderEventType.RESTRICTION_CREATED,
      "restriction-create"
    )
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  return {
    event,
    restriction,
    workOrder: envelopeWorkOrder(event, { command, kind: "restriction-create" }),
    wrote: false
  };
}

async function replayRestrictionRelease(
  tx: Prisma.TransactionClient,
  existing: VehicleOperationalRestriction,
  command: NormalizedReleaseRestrictionCommand
): Promise<RestrictionCommandOutcome> {
  const restriction = restrictionEnvelopeResult(existing.releaseSnapshot, {
    command,
    kind: "restriction-release"
  });
  if (restriction.id !== command.restrictionId || restriction.id !== existing.id) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  const event = await findEventBySource(tx, command.source);
  if (!existing.workOrderId) {
    if (event) throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
    return { event: null, restriction, workOrder: null, wrote: false };
  }
  if (
    !event ||
    !sameRestrictionEvent(
      event,
      command,
      AssetWorkOrderEventType.RESTRICTION_RELEASED,
      "restriction-release",
      existing.workOrderId
    )
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  return {
    event,
    restriction,
    workOrder: envelopeWorkOrder(event, { command, kind: "restriction-release" }),
    wrote: false
  };
}

function sameRestrictionEvent(
  event: AssetWorkOrderEvent,
  command: NormalizedCreateRestrictionCommand | NormalizedReleaseRestrictionCommand,
  eventType: AssetWorkOrderEventType,
  kind: "restriction-create" | "restriction-release",
  workOrderId = "workOrderId" in command && typeof command.workOrderId === "string"
    ? command.workOrderId
    : null
) {
  return (
    workOrderId !== null &&
    event.workOrderId === workOrderId &&
    event.eventType === eventType &&
    event.beforeStatus === null &&
    event.afterStatus === null &&
    event.actorId === command.actorId &&
    sameDate(event.occurredAt, command.occurredAt) &&
    sameSource(event, command.source) &&
    sameCommandEnvelope(event, { command, kind })
  );
}

function replayAssignment(event: AssetWorkOrderEvent, command: AssignWorkOrderCommand) {
  if (
    event.beforeStatus === null ||
    event.beforeStatus !== event.afterStatus ||
    !sameCommandEvent(event, command, AssetWorkOrderEventType.ASSIGNED, {
      command,
      kind: "assign"
    })
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  return replayEventWorkOrder(event, { command, kind: "assign" });
}

function replayTransition(event: AssetWorkOrderEvent, command: TransitionWorkOrderCommand) {
  const beforeStatus = event.beforeStatus;
  if (
    beforeStatus === null ||
    event.eventType !== transitionEventType(beforeStatus, command.targetStatus) ||
    event.afterStatus !== command.targetStatus ||
    !sameCommandEvent(event, command, event.eventType, { command, kind: "transition" }) ||
    !isDeepStrictEqual(commandPayload(event), transitionPayload(command, beforeStatus))
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  return replayEventWorkOrder(event, { command, kind: "transition" });
}

function replayEvent(
  event: AssetWorkOrderEvent,
  command: AppendWorkOrderEventCommand,
  envelope: CommandEnvelopeInput
) {
  if (!sameCommandEvent(event, command, command.eventType, envelope)) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  return replayEventWorkOrder(event, envelope);
}

function replayEventWorkOrder(event: AssetWorkOrderEvent, envelope: CommandEnvelopeInput) {
  return {
    event,
    workOrder: envelopeWorkOrder(event, envelope),
    wrote: false
  } as WorkOrderCommandOutcome;
}

async function replayEvidence(
  tx: Prisma.TransactionClient,
  evidence: AssetWorkOrderEvidence,
  command: NormalizedEvidenceCommand
): Promise<EvidenceCommandOutcome> {
  if (!sameEvidence(evidence, command)) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  const event = await findEventBySource(tx, command.source);
  const envelope = { command, kind: "evidence" } as const;
  if (
    !event ||
    event.beforeStatus !== null ||
    event.afterStatus !== null ||
    !sameCommandEvent(event, command, AssetWorkOrderEventType.EVIDENCE_ATTACHED, envelope)
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  return { evidence, ...replayEventWorkOrder(event, envelope) };
}

function sameCreate(
  existing: AssetWorkOrder,
  event: AssetWorkOrderEvent,
  command: CreateWorkOrderCommand
) {
  return (
    event.workOrderId === existing.id &&
    event.eventType === AssetWorkOrderEventType.CREATED &&
    event.sequence === 1 &&
    event.beforeStatus === null &&
    event.afterStatus === AssetWorkOrderStatus.PENDING &&
    event.actorId === command.actorId &&
    sameDate(event.occurredAt, command.occurredAt) &&
    sameSource(event, command.source) &&
    sameCommandEnvelope(event, { command, kind: "create" })
  );
}

function sameCommandEvent(
  event: AssetWorkOrderEvent,
  command:
    | AppendWorkOrderEventCommand
    | AppendEvidenceCommand
    | AssignWorkOrderCommand
    | TransitionWorkOrderCommand,
  eventType: AssetWorkOrderEventType,
  envelope: CommandEnvelopeInput
) {
  return (
    event.workOrderId === command.workOrderId &&
    event.eventType === eventType &&
    (!("beforeStatus" in command) || event.beforeStatus === command.beforeStatus) &&
    (!("afterStatus" in command) || event.afterStatus === command.afterStatus) &&
    event.actorId === command.actorId &&
    sameDate(event.occurredAt, command.occurredAt) &&
    sameSource(event, command.source) &&
    sameCommandEnvelope(event, envelope)
  );
}

function sameEvidence(evidence: AssetWorkOrderEvidence, command: NormalizedEvidenceCommand) {
  return (
    evidence.workOrderId === command.workOrderId &&
    evidence.eventId === command.eventId &&
    evidence.action === command.action &&
    evidence.evidenceType === command.evidenceType &&
    evidence.fileId === command.fileId &&
    evidence.supersedesEvidenceId === command.supersedesEvidenceId &&
    evidence.contentSha256 === command.contentSha256 &&
    sameNullableDate(evidence.capturedAt, command.capturedAt) &&
    isDeepStrictEqual(evidence.captureMetadata, command.captureMetadata) &&
    evidence.actorId === command.actorId &&
    sameSource(evidence, command.source)
  );
}

function assignmentPayload(command: AssignWorkOrderCommand) {
  return normalizeSnapshot({
    assignedUserId: command.assignedUserId,
    detailSnapshot: command.detailSnapshot,
    expectedVersion: command.expectedVersion,
    scheduledAt: command.scheduledAt?.toISOString() ?? null,
    slaDueAt: command.slaDueAt?.toISOString() ?? null
  });
}

function transitionPayload(
  command: TransitionWorkOrderCommand,
  beforeStatus: AssetWorkOrderStatus
) {
  return normalizeSnapshot({
    beforeStatus,
    closeReason: command.closeReason,
    detailSnapshot: command.detailSnapshot,
    expectedVersion: command.expectedVersion,
    solution: command.solution,
    targetStatus: command.targetStatus
  });
}

function findWorkOrderByCreateSource(
  tx: Prisma.TransactionClient,
  source: StableAssetOperationSource
) {
  return tx.assetWorkOrder.findFirst({
    where: {
      createSourceId: source.id,
      createSourceKey: source.key,
      createSourceType: source.type
    }
  });
}

function findEventBySource(tx: Prisma.TransactionClient, source: StableAssetOperationSource) {
  return tx.assetWorkOrderEvent.findFirst({
    where: { sourceId: source.id, sourceKey: source.key, sourceType: source.type }
  });
}

function findEvidenceBySource(tx: Prisma.TransactionClient, source: StableAssetOperationSource) {
  return tx.assetWorkOrderEvidence.findFirst({
    where: { sourceId: source.id, sourceKey: source.key, sourceType: source.type }
  });
}

function findRestrictionByStartSource(
  tx: Prisma.TransactionClient,
  source: StableAssetOperationSource
) {
  return tx.vehicleOperationalRestriction.findFirst({
    where: {
      startSourceId: source.id,
      startSourceKey: source.key,
      startSourceType: source.type
    }
  });
}

function findRestrictionByReleaseSource(
  tx: Prisma.TransactionClient,
  source: StableAssetOperationSource
) {
  return tx.vehicleOperationalRestriction.findFirst({
    where: {
      releaseSourceId: source.id,
      releaseSourceKey: source.key,
      releaseSourceType: source.type
    }
  });
}

function normalizeWriteError(
  error: unknown,
  kind: "evidence" | "event" | "restriction" | "work-order"
) {
  if (prismaErrorCode(error) !== "P2002") {
    return error instanceof Error
      ? error
      : new Error("Asset operation database write failed", { cause: error });
  }
  const target = prismaTarget(error).toLowerCase();
  if (kind === "evidence" && target.includes("supersedes")) {
    return conflict(ASSET_OPERATION_ERROR_CODE.EVIDENCE_CHAIN_CONFLICT);
  }
  if (target.includes("source")) return conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  return conflict(ASSET_OPERATION_ERROR_CODE.WRITE_CONFLICT);
}

function prismaErrorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function prismaTarget(error: unknown) {
  if (!isRecord(error) || !isRecord(error.meta)) return "";
  const target = error.meta.target ?? error.meta.constraint;
  return Array.isArray(target)
    ? target.filter((item): item is string => typeof item === "string").join(" ")
    : typeof target === "string"
      ? target
      : "";
}

function isLockUnavailableError(value: unknown) {
  if (!isRecord(value)) return false;
  if (value.code === "55P03") return true;
  if (!isRecord(value.meta) || !isRecord(value.meta.driverAdapterError)) return false;
  const cause = value.meta.driverAdapterError.cause;
  return isRecord(cause) && cause.originalCode === "55P03";
}

function sameSource(
  row: { sourceId: string; sourceKey: string; sourceType: string },
  source: StableAssetOperationSource
) {
  return (
    row.sourceId === source.id && row.sourceKey === source.key && row.sourceType === source.type
  );
}

function sameDate(left: Date, right: Date) {
  return left.getTime() === right.getTime();
}

function sameNullableDate(left: Date | null, right: Date | null) {
  return left?.getTime() === right?.getTime();
}

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function conflict(code: AssetOperationErrorCode) {
  return new ConflictException({ code, message: ERROR_MESSAGES[code] });
}
