import { ConflictException, Injectable } from "@nestjs/common";
import {
  AssetWorkOrderEvidenceAction,
  AssetWorkOrderEventType,
  AssetWorkOrderStatus,
  Prisma,
  type AssetWorkOrder,
  type AssetWorkOrderEvidence,
  type AssetWorkOrderEvent
} from "@prisma/client";
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
  EvidenceCommandOutcome,
  StableAssetOperationSource,
  TransitionWorkOrderCommand,
  WorkOrderCommandOutcome
} from "./asset-operations.types";

export const ASSET_OPERATION_ERROR_CODE = {
  AUTHORITY_BUSY: "ASSET_OPERATION_AUTHORITY_BUSY",
  EVIDENCE_CHAIN_CONFLICT: "ASSET_WORK_ORDER_EVIDENCE_CHAIN_CONFLICT",
  EVIDENCE_INVALID: "ASSET_WORK_ORDER_EVIDENCE_INVALID",
  EVIDENCE_NOT_FOUND: "ASSET_WORK_ORDER_EVIDENCE_NOT_FOUND",
  EVENT_INVALID: "ASSET_WORK_ORDER_EVENT_INVALID",
  EVENT_TIME_INVALID: "ASSET_WORK_ORDER_EVENT_TIME_INVALID",
  FILE_NOT_FOUND: "ASSET_WORK_ORDER_FILE_NOT_FOUND",
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
      detailSnapshot: normalizeSnapshot({
        authoritySnapshot: normalized.authoritySnapshot,
        metadata: normalized.metadata
      }),
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
    if (replay) return replayAssignment(tx, replay, normalized);
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
      detailSnapshot: assignmentPayload(normalized),
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
    if (replay) return replayTransition(tx, replay, normalized);
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
      detailSnapshot: transitionPayload(normalized),
      eventType: transitionEventType(current.status, normalized.targetStatus),
      occurredAt: normalized.occurredAt,
      source: normalized.source,
      workOrderId: current.id
    });
    return { event, workOrder: updated, wrote: true };
  }

  appendNote(tx: Prisma.TransactionClient, command: AppendNoteCommand) {
    return this.appendEvent(tx, {
      actorId: command.actorId,
      afterStatus: null,
      beforeStatus: null,
      detailSnapshot: { note: command.note },
      eventType: AssetWorkOrderEventType.NOTE_ADDED,
      occurredAt: command.occurredAt,
      source: command.source,
      workOrderId: command.workOrderId
    });
  }

  private async appendEvent(
    tx: Prisma.TransactionClient,
    command: AppendWorkOrderEventCommand
  ): Promise<WorkOrderCommandOutcome> {
    const normalized = { ...command, detailSnapshot: normalizeSnapshot(command.detailSnapshot) };
    await prepareCommand(tx, "work-order:event", normalized.source);
    if (!DIRECT_EVENT_TYPES.has(command.eventType)) {
      throw conflict(ASSET_OPERATION_ERROR_CODE.EVENT_INVALID);
    }
    return appendEventCommand(tx, normalized);
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
      { allowGovernedEvent: true, headerAlreadyLocked: workOrder }
    );
    return {
      evidence,
      event: eventOutcome.event,
      workOrder: eventOutcome.workOrder,
      wrote: true
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

async function appendEventCommand(
  tx: Prisma.TransactionClient,
  command: AppendWorkOrderEventCommand,
  options: { allowGovernedEvent?: boolean; headerAlreadyLocked?: AssetWorkOrder } = {}
): Promise<WorkOrderCommandOutcome> {
  if (!options.allowGovernedEvent && !DIRECT_EVENT_TYPES.has(command.eventType)) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.EVENT_INVALID);
  }
  const replay = await findEventBySource(tx, command.source);
  if (replay) return replayEvent(tx, replay, command);
  const workOrder =
    options.headerAlreadyLocked ?? (await lockAndLoadWorkOrder(tx, command.workOrderId));
  await assertEventTime(tx, command.occurredAt);
  const event = await appendEventRow(tx, command);
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
  const [clock] = await tx.$queryRaw<Array<{ transactionNow: Date }>>(
    Prisma.sql`SELECT transaction_timestamp() AS "transactionNow"`
  );
  if (!clock?.transactionNow || occurredAt.getTime() > clock.transactionNow.getTime()) {
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

function normalizeSnapshot(snapshot: AssetOperationSnapshot): Prisma.JsonObject {
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
    return { event, workOrder: existing, wrote: false };
  }
  throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
}

async function replayAssignment(
  tx: Prisma.TransactionClient,
  event: AssetWorkOrderEvent,
  command: AssignWorkOrderCommand
) {
  if (!sameEvent(event, command, AssetWorkOrderEventType.ASSIGNED, assignmentPayload(command))) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  return replayEventWorkOrder(tx, event);
}

async function replayTransition(
  tx: Prisma.TransactionClient,
  event: AssetWorkOrderEvent,
  command: TransitionWorkOrderCommand
) {
  if (
    event.workOrderId !== command.workOrderId ||
    event.afterStatus !== command.targetStatus ||
    event.actorId !== command.actorId ||
    !sameDate(event.occurredAt, command.occurredAt) ||
    !sameSource(event, command.source) ||
    !isDeepStrictEqual(event.detailSnapshot, transitionPayload(command))
  ) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  return replayEventWorkOrder(tx, event);
}

async function replayEvent(
  tx: Prisma.TransactionClient,
  event: AssetWorkOrderEvent,
  command: AppendWorkOrderEventCommand
) {
  if (!sameEvent(event, command, command.eventType, command.detailSnapshot as Prisma.JsonObject)) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  return replayEventWorkOrder(tx, event);
}

async function replayEventWorkOrder(tx: Prisma.TransactionClient, event: AssetWorkOrderEvent) {
  const workOrder = await tx.assetWorkOrder.findUnique({ where: { id: event.workOrderId } });
  if (!workOrder) throw conflict(ASSET_OPERATION_ERROR_CODE.WORK_ORDER_NOT_FOUND);
  return { event, workOrder, wrote: false } as WorkOrderCommandOutcome;
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
  if (!event || event.workOrderId !== command.workOrderId) {
    throw conflict(ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  }
  const workOrder = await tx.assetWorkOrder.findUnique({ where: { id: command.workOrderId } });
  if (!workOrder) throw conflict(ASSET_OPERATION_ERROR_CODE.WORK_ORDER_NOT_FOUND);
  return { evidence, event, workOrder, wrote: false };
}

function sameCreate(
  existing: AssetWorkOrder,
  event: AssetWorkOrderEvent,
  command: CreateWorkOrderCommand
) {
  return (
    existing.vehicleId === command.vehicleId &&
    existing.orderId === command.orderId &&
    existing.contractId === command.contractId &&
    existing.customerId === command.customerId &&
    existing.assetOwnerId === command.assetOwnerId &&
    existing.relatedWorkOrderId === command.relatedWorkOrderId &&
    existing.workOrderType === command.workOrderType &&
    existing.priority === command.priority &&
    existing.costConfirmationRequired === command.costConfirmationRequired &&
    existing.description === command.description &&
    isDeepStrictEqual(existing.authoritySnapshot, command.authoritySnapshot) &&
    isDeepStrictEqual(existing.metadata, command.metadata) &&
    existing.createdBy === command.actorId &&
    event.workOrderId === existing.id &&
    event.eventType === AssetWorkOrderEventType.CREATED &&
    event.sequence === 1 &&
    event.actorId === command.actorId &&
    sameDate(event.occurredAt, command.occurredAt) &&
    sameSource(event, command.source)
  );
}

function sameEvent(
  event: AssetWorkOrderEvent,
  command: AppendWorkOrderEventCommand | AssignWorkOrderCommand,
  eventType: AssetWorkOrderEventType,
  detailSnapshot: Prisma.JsonObject
) {
  const beforeStatus = "beforeStatus" in command ? command.beforeStatus : event.beforeStatus;
  const afterStatus = "afterStatus" in command ? command.afterStatus : event.afterStatus;
  return (
    event.workOrderId === command.workOrderId &&
    event.eventType === eventType &&
    event.beforeStatus === beforeStatus &&
    event.afterStatus === afterStatus &&
    event.actorId === command.actorId &&
    sameDate(event.occurredAt, command.occurredAt) &&
    sameSource(event, command.source) &&
    isDeepStrictEqual(event.detailSnapshot, detailSnapshot)
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

function transitionPayload(command: TransitionWorkOrderCommand) {
  return normalizeSnapshot({
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

function normalizeWriteError(error: unknown, kind: "evidence" | "event" | "work-order") {
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
