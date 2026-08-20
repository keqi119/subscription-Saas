import { ConflictException } from "@nestjs/common";
import {
  AssetWorkOrderEvidenceAction,
  AssetWorkOrderEvidenceType,
  AssetWorkOrderEventType,
  AssetWorkOrderPriority,
  AssetWorkOrderStatus,
  AssetWorkOrderType,
  type Prisma
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ASSET_OPERATION_ERROR_CODE,
  AssetOperationsRepository
} from "../src/asset-operations/asset-operations.repository";
import type {
  AppendEvidenceCommand,
  AppendNoteCommand,
  AppendWorkOrderEventCommand,
  CreateWorkOrderCommand,
  TransitionWorkOrderCommand,
  WorkOrderCommandOutcome
} from "../src/asset-operations/asset-operations.types";

const NOW = new Date("2026-08-20T02:00:00.000Z");

describe("AssetOperationsRepository", () => {
  it("rejects a root client whose probes do not stay in one transaction", async () => {
    const database = new FakeDatabase({ transactionIds: ["tx-1", "tx-2"] });

    await expectCode(
      new AssetOperationsRepository().createWorkOrder(database.tx, createCommand()),
      ASSET_OPERATION_ERROR_CODE.TRANSACTION_REQUIRED
    );
  });

  it("rejects a caller transaction whose isolation is not READ COMMITTED", async () => {
    const database = new FakeDatabase({ isolationLevel: "serializable" });

    await expectCode(
      new AssetOperationsRepository().createWorkOrder(database.tx, createCommand()),
      ASSET_OPERATION_ERROR_CODE.TRANSACTION_REQUIRED
    );
  });

  it("returns an exact create replay and rejects the same source with payload drift", async () => {
    const database = new FakeDatabase();
    const repository = new AssetOperationsRepository(() => "AWO20260820100000TEST");
    const command = createCommand();

    const created = await repository.createWorkOrder(database.tx, command);
    const replayed = await repository.createWorkOrder(database.tx, command);

    expect(replayed).toMatchObject({
      event: created.event,
      workOrder: created.workOrder,
      wrote: false
    });
    expect(database.workOrders).toHaveLength(1);
    expect(database.events).toHaveLength(1);
    expect(created.workOrder.workOrderNo).toBe("AWO20260820100000TEST");
    expect(created.event.eventType).toBe(AssetWorkOrderEventType.CREATED);

    await expectCode(
      repository.createWorkOrder(database.tx, {
        ...command,
        authoritySnapshot: { vehicleStatus: "MAINTENANCE" }
      }),
      ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT
    );
  });

  it("retries a colliding generated work-order number within the bounded generator path", async () => {
    const database = new FakeDatabase();
    database.workOrders.push({ id: randomUUID(), workOrderNo: "AWOCOLLISION" });
    const candidates = ["AWOCOLLISION", "AWOUNIQUE"];
    const repository = new AssetOperationsRepository(() => candidates.shift() ?? "AWOEXHAUSTED");

    const created = await repository.createWorkOrder(database.tx, createCommand());

    expect(created.workOrder.workOrderNo).toBe("AWOUNIQUE");
    expect(database.workOrders.filter((row) => row.workOrderNo === "AWOCOLLISION")).toHaveLength(1);
  });

  it("applies the fixed transition table and rejects illegal transitions", async () => {
    const database = new FakeDatabase();
    const repository = new AssetOperationsRepository();
    const created = await repository.createWorkOrder(database.tx, createCommand());
    const start = transitionCommand(created.workOrder.id, AssetWorkOrderStatus.IN_PROGRESS, 0);

    const transitioned = await repository.transitionWorkOrder(database.tx, start);

    expect(transitioned.workOrder).toMatchObject({
      status: AssetWorkOrderStatus.IN_PROGRESS,
      version: 1
    });
    expect(transitioned.event).toMatchObject({
      afterStatus: AssetWorkOrderStatus.IN_PROGRESS,
      beforeStatus: AssetWorkOrderStatus.PENDING,
      eventType: AssetWorkOrderEventType.STARTED,
      sequence: 2
    });

    await expectCode(
      repository.transitionWorkOrder(database.tx, {
        ...transitionCommand(created.workOrder.id, AssetWorkOrderStatus.CLOSED, 1),
        source: source("illegal-transition")
      }),
      ASSET_OPERATION_ERROR_CODE.WORK_ORDER_TRANSITION_INVALID
    );
  });

  it("enforces expectedVersion compare-and-set without appending an event", async () => {
    const database = new FakeDatabase();
    const repository = new AssetOperationsRepository();
    const created = await repository.createWorkOrder(database.tx, createCommand());

    await expectCode(
      repository.transitionWorkOrder(
        database.tx,
        transitionCommand(created.workOrder.id, AssetWorkOrderStatus.IN_PROGRESS, 7)
      ),
      ASSET_OPERATION_ERROR_CODE.WORK_ORDER_VERSION_CONFLICT
    );
    expect(database.events).toHaveLength(1);
  });

  it("enforces the cost-confirmation branch before allowing a terminal close", async () => {
    const repository = new AssetOperationsRepository();
    const noCostDatabase = new FakeDatabase();
    const noCost = await repository.createWorkOrder(noCostDatabase.tx, createCommand());
    await repository.transitionWorkOrder(
      noCostDatabase.tx,
      transitionCommand(noCost.workOrder.id, AssetWorkOrderStatus.IN_PROGRESS, 0)
    );
    await repository.transitionWorkOrder(
      noCostDatabase.tx,
      transitionCommand(noCost.workOrder.id, AssetWorkOrderStatus.PENDING_ACCEPTANCE, 1)
    );
    await expectCode(
      repository.transitionWorkOrder(
        noCostDatabase.tx,
        transitionCommand(noCost.workOrder.id, AssetWorkOrderStatus.PENDING_COST_CONFIRMATION, 2)
      ),
      ASSET_OPERATION_ERROR_CODE.WORK_ORDER_TRANSITION_INVALID
    );
    const noCostClosed = await repository.transitionWorkOrder(
      noCostDatabase.tx,
      transitionCommand(noCost.workOrder.id, AssetWorkOrderStatus.CLOSED, 2)
    );
    expect(noCostClosed.event.eventType).toBe(AssetWorkOrderEventType.CLOSED);

    const costDatabase = new FakeDatabase();
    const cost = await repository.createWorkOrder(costDatabase.tx, {
      ...createCommand(),
      costConfirmationRequired: true
    });
    await repository.transitionWorkOrder(
      costDatabase.tx,
      transitionCommand(cost.workOrder.id, AssetWorkOrderStatus.IN_PROGRESS, 0)
    );
    await repository.transitionWorkOrder(
      costDatabase.tx,
      transitionCommand(cost.workOrder.id, AssetWorkOrderStatus.PENDING_ACCEPTANCE, 1)
    );
    await expectCode(
      repository.transitionWorkOrder(
        costDatabase.tx,
        transitionCommand(cost.workOrder.id, AssetWorkOrderStatus.CLOSED, 2)
      ),
      ASSET_OPERATION_ERROR_CODE.WORK_ORDER_TRANSITION_INVALID
    );
    const accepted = await repository.transitionWorkOrder(
      costDatabase.tx,
      transitionCommand(cost.workOrder.id, AssetWorkOrderStatus.PENDING_COST_CONFIRMATION, 2)
    );
    const costClosed = await repository.transitionWorkOrder(
      costDatabase.tx,
      transitionCommand(cost.workOrder.id, AssetWorkOrderStatus.CLOSED, 3)
    );
    expect(accepted.event.eventType).toBe(AssetWorkOrderEventType.ACCEPTED);
    expect(costClosed.event.eventType).toBe(AssetWorkOrderEventType.COST_CONFIRMED);
  });

  it("assigns only the governed assignment fields and exactly replays its event", async () => {
    const database = new FakeDatabase();
    const repository = new AssetOperationsRepository();
    const created = await repository.createWorkOrder(database.tx, createCommand());
    const assignedUserId = randomUUID();
    const command = {
      actorId: null,
      assignedUserId,
      detailSnapshot: { reason: "dispatch" },
      expectedVersion: 0,
      occurredAt: new Date("2026-08-20T01:15:00.000Z"),
      scheduledAt: new Date("2026-08-21T01:00:00.000Z"),
      slaDueAt: new Date("2026-08-22T01:00:00.000Z"),
      source: source("assign"),
      workOrderId: created.workOrder.id
    };

    const assigned = await repository.assignWorkOrder(database.tx, command);
    const replayed = await repository.assignWorkOrder(database.tx, command);

    expect(assigned.workOrder).toMatchObject({
      assignedUserId,
      scheduledAt: command.scheduledAt,
      slaDueAt: command.slaDueAt,
      version: 1
    });
    expect(assigned.event).toMatchObject({
      eventType: AssetWorkOrderEventType.ASSIGNED,
      sequence: 2
    });
    expect(replayed).toMatchObject({ event: assigned.event, wrote: false });
    await expectCode(
      repository.assignWorkOrder(database.tx, {
        ...command,
        scheduledAt: new Date("2026-08-23T01:00:00.000Z")
      }),
      ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT
    );
  });

  it("assigns deterministic event sequences while the header is locked", async () => {
    const database = new FakeDatabase();
    const repository = new AssetOperationsRepository();
    const created = await repository.createWorkOrder(database.tx, createCommand());
    const first = await repository.appendNote(
      database.tx,
      noteCommand(created.workOrder.id, "first", "note-first")
    );
    const second = await repository.appendNote(
      database.tx,
      noteCommand(created.workOrder.id, "second", "note-second")
    );

    expect([created.event.sequence, first.event.sequence, second.event.sequence]).toEqual([
      1, 2, 3
    ]);
    expect(first.event).toMatchObject({
      eventType: AssetWorkOrderEventType.NOTE_ADDED,
      beforeStatus: null,
      afterStatus: null
    });
  });

  it("rejects events in the future relative to the transaction clock", async () => {
    const database = new FakeDatabase();
    const repository = new AssetOperationsRepository();
    const created = await repository.createWorkOrder(database.tx, createCommand());

    await expectCode(
      repository.appendNote(database.tx, {
        ...noteCommand(created.workOrder.id, "future", "future-note"),
        occurredAt: new Date(NOW.getTime() + 1)
      }),
      ASSET_OPERATION_ERROR_CODE.EVENT_TIME_INVALID
    );
  });

  it("enforces the transaction contract before rejecting a forged lifecycle event", async () => {
    const database = new FakeDatabase({ transactionIds: ["tx-1", "tx-2"] });

    await expectCode(
      appendInternalEvent(new AssetOperationsRepository(), database.tx, {
        actorId: null,
        afterStatus: AssetWorkOrderStatus.CLOSED,
        beforeStatus: AssetWorkOrderStatus.PENDING,
        detailSnapshot: { forged: true },
        eventType: AssetWorkOrderEventType.CLOSED,
        occurredAt: new Date("2026-08-20T01:20:00.000Z"),
        source: source("forged-lifecycle"),
        workOrderId: randomUUID()
      }),
      ASSET_OPERATION_ERROR_CODE.TRANSACTION_REQUIRED
    );
    expect(database.events).toHaveLength(0);
  });

  it("freezes live file metadata and normalizes a SHA-256 evidence attachment", async () => {
    const database = new FakeDatabase();
    const repository = new AssetOperationsRepository();
    const created = await repository.createWorkOrder(database.tx, createCommand());
    const fileId = database.addFile();
    const command = evidenceCommand(created.workOrder.id, fileId, "attach");

    const attached = await repository.appendEvidence(database.tx, {
      ...command,
      contentSha256: `SHA256:${"A".repeat(64)}`
    });

    expect(attached.evidence).toMatchObject({
      action: AssetWorkOrderEvidenceAction.ATTACH,
      contentSha256: "a".repeat(64),
      fileBucket: "asset-evidence",
      fileMimeType: "image/jpeg",
      fileObjectKey: "work-orders/photo.jpg",
      fileSizeBytes: 1234n
    });
    expect(attached.event).toMatchObject({ eventType: AssetWorkOrderEventType.EVIDENCE_ATTACHED });
  });

  it("rejects missing files and malformed evidence action shapes", async () => {
    const database = new FakeDatabase();
    const repository = new AssetOperationsRepository();
    const created = await repository.createWorkOrder(database.tx, createCommand());

    await expectCode(
      repository.appendEvidence(
        database.tx,
        evidenceCommand(created.workOrder.id, randomUUID(), "missing-file")
      ),
      ASSET_OPERATION_ERROR_CODE.FILE_NOT_FOUND
    );
    await expectCode(
      repository.appendEvidence(database.tx, {
        ...evidenceCommand(created.workOrder.id, database.addFile(), "bad-remove"),
        action: AssetWorkOrderEvidenceAction.REMOVE,
        contentSha256: "a".repeat(64)
      }),
      ASSET_OPERATION_ERROR_CODE.EVIDENCE_INVALID
    );
  });

  it("keeps evidence append-only and rejects competing supersession", async () => {
    const database = new FakeDatabase();
    const repository = new AssetOperationsRepository();
    const created = await repository.createWorkOrder(database.tx, createCommand());
    const original = await repository.appendEvidence(
      database.tx,
      evidenceCommand(created.workOrder.id, database.addFile(), "original")
    );
    const successor = await repository.appendEvidence(database.tx, {
      ...evidenceCommand(created.workOrder.id, database.addFile(), "successor"),
      action: AssetWorkOrderEvidenceAction.SUPERSEDE,
      supersedesEvidenceId: original.evidence.id
    });

    expect(successor.evidence.supersedesEvidenceId).toBe(original.evidence.id);
    await expectCode(
      repository.appendEvidence(database.tx, {
        ...evidenceCommand(created.workOrder.id, database.addFile(), "competitor"),
        action: AssetWorkOrderEvidenceAction.SUPERSEDE,
        supersedesEvidenceId: original.evidence.id
      }),
      ASSET_OPERATION_ERROR_CODE.EVIDENCE_CHAIN_CONFLICT
    );
    expect(database.evidence).toHaveLength(2);
  });

  it("exactly replays evidence and returns ordered read projections", async () => {
    const database = new FakeDatabase();
    const repository = new AssetOperationsRepository();
    const created = await repository.createWorkOrder(database.tx, createCommand());
    await repository.appendNote(
      database.tx,
      noteCommand(created.workOrder.id, "projection note", "projection-note")
    );
    const command = evidenceCommand(created.workOrder.id, database.addFile(), "replay");
    const attached = await repository.appendEvidence(database.tx, command);
    const replayed = await repository.appendEvidence(database.tx, command);
    const detail = await repository.getWorkOrderDetail(database.tx, created.workOrder.id);
    const list = await repository.listWorkOrdersByVehicle(database.tx, created.workOrder.vehicleId);

    expect(replayed).toMatchObject({
      evidence: attached.evidence,
      event: attached.event,
      wrote: false
    });
    expect(detail?.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(detail?.evidence).toHaveLength(1);
    expect(detail?.restrictions).toEqual([]);
    expect(list.map((workOrder) => workOrder.id)).toEqual([created.workOrder.id]);

    await expectCode(
      repository.appendEvidence(database.tx, {
        ...command,
        contentSha256: "b".repeat(64)
      }),
      ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT
    );
  });

  it.each([
    { code: "55P03" },
    { meta: { driverAdapterError: { cause: { originalCode: "55P03" } } } }
  ])("maps an actual PostgreSQL/Prisma 55P03 shape", async (lockError) => {
    const database = new FakeDatabase({ advisoryLockError: lockError });

    await expectCode(
      new AssetOperationsRepository().createWorkOrder(database.tx, createCommand()),
      ASSET_OPERATION_ERROR_CODE.AUTHORITY_BUSY
    );
  });

  it.each([
    { message: "55P03" },
    { payload: { code: "55P03" } },
    { meta: { arbitrary: { originalCode: "55P03" } } }
  ])("does not map an arbitrary nested/string 55P03 lookalike", async (lockError) => {
    const database = new FakeDatabase({ advisoryLockError: lockError });

    await expect(
      new AssetOperationsRepository().createWorkOrder(database.tx, createCommand())
    ).rejects.toBe(lockError);
  });
});

function createCommand(): CreateWorkOrderCommand {
  return {
    actorId: null,
    assetOwnerId: null,
    authoritySnapshot: { vehicleStatus: "RETURNED" },
    contractId: null,
    costConfirmationRequired: false,
    customerId: null,
    description: "Inspect returned vehicle",
    metadata: { channel: "BACK_OFFICE" },
    occurredAt: new Date("2026-08-20T01:00:00.000Z"),
    orderId: null,
    priority: AssetWorkOrderPriority.NORMAL,
    relatedWorkOrderId: null,
    source: source("create"),
    vehicleId: randomUUID(),
    workOrderType: AssetWorkOrderType.RECONDITIONING
  };
}

function transitionCommand(
  workOrderId: string,
  targetStatus: AssetWorkOrderStatus,
  expectedVersion: number
): TransitionWorkOrderCommand {
  return {
    actorId: null,
    closeReason: null,
    detailSnapshot: { reason: "unit-test" },
    expectedVersion,
    occurredAt: new Date("2026-08-20T01:10:00.000Z"),
    solution: null,
    source: source(`transition-${targetStatus}-${expectedVersion}`),
    targetStatus,
    workOrderId
  };
}

function noteCommand(workOrderId: string, note: string, label: string): AppendNoteCommand {
  return {
    actorId: null,
    note,
    occurredAt: new Date("2026-08-20T01:20:00.000Z"),
    source: source(label),
    workOrderId
  };
}

function evidenceCommand(
  workOrderId: string,
  fileId: string,
  label: string
): AppendEvidenceCommand {
  return {
    action: AssetWorkOrderEvidenceAction.ATTACH,
    actorId: null,
    capturedAt: new Date("2026-08-20T01:30:00.000Z"),
    captureMetadata: { camera: "rear" },
    contentSha256: "a".repeat(64),
    eventId: null,
    evidenceType: AssetWorkOrderEvidenceType.PHOTO,
    fileId,
    occurredAt: new Date("2026-08-20T01:31:00.000Z"),
    source: source(`evidence-${label}`),
    supersedesEvidenceId: null,
    workOrderId
  };
}

function source(label: string) {
  const id = randomUUID();
  return { id, key: `stage1c-task2:${label}:${id}`, type: "STAGE1C_TASK2_TEST" };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected conflict ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code });
  }
}

type FakeDatabaseOptions = {
  advisoryLockError?: unknown;
  isolationLevel?: string;
  transactionIds?: string[];
};

class FakeDatabase {
  readonly evidence: Array<Record<string, unknown>> = [];
  readonly events: Array<Record<string, unknown>> = [];
  readonly files: Array<Record<string, unknown>> = [];
  readonly workOrders: Array<Record<string, unknown>> = [];
  readonly tx: Prisma.TransactionClient;
  private readonly options: FakeDatabaseOptions;
  private transactionProbe = 0;

  constructor(options: FakeDatabaseOptions = {}) {
    this.options = options;
    this.tx = this.buildTransaction();
  }

  addFile() {
    const id = randomUUID();
    this.files.push({
      bucket: "asset-evidence",
      id,
      mimeType: "image/jpeg",
      objectKey: "work-orders/photo.jpg",
      sizeBytes: 1234n
    });
    return id;
  }

  private buildTransaction() {
    const queryRaw = async (query: Prisma.Sql) => {
      const sql = query.strings.join("?");
      if (sql.includes("current_setting('transaction_isolation')")) {
        return [
          {
            isolationLevel: this.options.isolationLevel ?? "read committed",
            transactionId: this.options.transactionIds?.[this.transactionProbe++] ?? "tx-1"
          }
        ];
      }
      if (sql.includes("txid_current()")) {
        return [
          {
            transactionId: this.options.transactionIds?.[this.transactionProbe++] ?? "tx-1"
          }
        ];
      }
      if (sql.includes("pg_advisory_xact_lock") && this.options.advisoryLockError) {
        throw this.options.advisoryLockError;
      }
      if (sql.includes("transaction_timestamp()")) return [{ transactionNow: NOW }];
      return [{ locked: true }];
    };

    return {
      $queryRaw: queryRaw,
      assetWorkOrder: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            ...data,
            acceptedAt: null,
            cancelledAt: null,
            closedAt: null,
            costConfirmedAt: null,
            createdAt: NOW,
            id: randomUUID(),
            startedAt: null,
            status: AssetWorkOrderStatus.PENDING,
            updatedAt: NOW,
            updatedBy: data.createdBy ?? null,
            version: 0
          };
          this.workOrders.push(row);
          return row;
        },
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          const row = this.workOrders.find((candidate) => matches(candidate, where));
          return row ? { ...row } : null;
        },
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          this.workOrders.filter((row) => matches(row, where)),
        findUnique: async ({ where }: { where: Record<string, unknown> }) => {
          const row = this.workOrders.find((candidate) => matches(candidate, where));
          return row ? { ...row } : null;
        },
        updateMany: async ({
          data,
          where
        }: {
          data: Record<string, unknown>;
          where: Record<string, unknown>;
        }) => {
          const row = this.workOrders.find((candidate) => matches(candidate, where));
          if (!row) return { count: 0 };
          const normalizedData = { ...data };
          if (
            normalizedData.version &&
            typeof normalizedData.version === "object" &&
            "increment" in normalizedData.version
          ) {
            normalizedData.version = Number(row.version) + Number(normalizedData.version.increment);
          }
          Object.assign(row, normalizedData, { updatedAt: NOW });
          return { count: 1 };
        }
      },
      assetWorkOrderEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { ...data, id: randomUUID(), recordedAt: NOW };
          this.events.push(row);
          return row;
        },
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          this.events.find((row) => matches(row, where)) ?? null,
        findMany: async ({ where }: { orderBy?: unknown; where: Record<string, unknown> }) =>
          this.events
            .filter((row) => matches(row, where))
            .sort((left, right) => Number(left.sequence) - Number(right.sequence)),
        aggregate: async ({ where }: { where: Record<string, unknown> }) => ({
          _max: {
            sequence: Math.max(
              0,
              ...this.events.filter((row) => matches(row, where)).map((row) => Number(row.sequence))
            )
          }
        })
      },
      assetWorkOrderEvidence: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { ...data, id: randomUUID(), recordedAt: NOW };
          this.evidence.push(row);
          return row;
        },
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          this.evidence.find((row) => matches(row, where)) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          this.evidence.filter((row) => matches(row, where))
      },
      fileObject: {
        findUnique: async ({ where }: { where: Record<string, unknown> }) =>
          this.files.find((row) => matches(row, where)) ?? null
      },
      vehicleOperationalRestriction: {
        findMany: async () => []
      }
    } as unknown as Prisma.TransactionClient;
  }
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      return matches(row, value as Record<string, unknown>);
    }
    return row[key] === value;
  });
}

function appendInternalEvent(
  repository: AssetOperationsRepository,
  tx: Prisma.TransactionClient,
  command: AppendWorkOrderEventCommand
): Promise<WorkOrderCommandOutcome> {
  return (
    repository as unknown as {
      appendEvent(
        tx: Prisma.TransactionClient,
        command: AppendWorkOrderEventCommand
      ): Promise<WorkOrderCommandOutcome>;
    }
  ).appendEvent(tx, command);
}
