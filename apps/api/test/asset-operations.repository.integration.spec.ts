import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AssetWorkOrderEvidenceAction,
  AssetWorkOrderEvidenceType,
  AssetWorkOrderEventType,
  AssetWorkOrderPriority,
  AssetWorkOrderStatus,
  AssetWorkOrderType,
  Prisma,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionStatus,
  VehicleOperationalRestrictionType
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ASSET_OPERATION_ERROR_CODE,
  AssetOperationsRepository
} from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import type {
  AppendEvidenceCommand,
  AppendNoteCommand,
  AppendWorkOrderEventCommand,
  CreateRestrictionCommand,
  CreateWorkOrderCommand,
  ReleaseRestrictionCommand,
  StableAssetOperationSource,
  TransitionWorkOrderCommand,
  WorkOrderCommandOutcome
} from "../src/asset-operations/asset-operations.types";
import { AuditService } from "../src/audit/audit.service";
import { PrismaService } from "../src/prisma/prisma.service";

const TEST_DATABASE_URL = requiredTestDatabaseUrl();
const FIXTURE_PREFIX = `S1CB${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const OCCURRED_AT = new Date("2026-08-20T01:00:00.000Z");

describe("AssetOperationsRepository PostgreSQL command behavior", () => {
  let prisma: PrismaService;
  let userId: string;
  let vehicleId: string;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
    vehicleId = await createVehicleFixture(prisma);
    userId = await createUserFixture(prisma);
  });

  afterAll(async () => {
    try {
      await deleteFixtures(prisma);
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it("rejects root and non-READ-COMMITTED clients with a stable transaction error", async () => {
    const repository = new AssetOperationsRepository();

    await expectCode(
      repository.createWorkOrder(
        prisma as unknown as Prisma.TransactionClient,
        createCommand(vehicleId, "root")
      ),
      ASSET_OPERATION_ERROR_CODE.TRANSACTION_REQUIRED
    );
    await expectCode(
      prisma.$transaction(
        (tx) => repository.createWorkOrder(tx, createCommand(vehicleId, "serializable")),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      ),
      ASSET_OPERATION_ERROR_CODE.TRANSACTION_REQUIRED
    );
  });

  it("serializes concurrent create replay and rejects payload drift without an aborted reread", async () => {
    const repository = new AssetOperationsRepository();
    const exact = createCommand(vehicleId, "create-exact");
    const replayRace = await holdFirstTransaction(prisma, (tx) =>
      repository.createWorkOrder(tx, exact)
    );
    const replayPromise = readCommitted(prisma, (tx) => repository.createWorkOrder(tx, exact));
    expect(await waitForDatabaseLock(prisma, "pg_advisory_xact_lock")).toBe(true);
    replayRace.release.resolve();
    const [created, replayed] = await Promise.all([replayRace.result, replayPromise]);

    expect(replayed.workOrder.id).toBe(created.workOrder.id);
    expect(replayed.event.id).toBe(created.event.id);
    await expect(countWorkOrdersBySource(prisma, exact.source)).resolves.toBe(1);
    await expect(countEventsBySource(prisma, exact.source)).resolves.toBe(1);

    const conflicting = createCommand(vehicleId, "create-drift");
    const driftRace = await holdFirstTransaction(prisma, (tx) =>
      repository.createWorkOrder(tx, conflicting)
    );
    const driftPromise = settled(
      readCommitted(prisma, (tx) =>
        repository.createWorkOrder(tx, {
          ...conflicting,
          authoritySnapshot: { lifecycle: "MAINTENANCE" }
        })
      )
    );
    try {
      expect(await waitForDatabaseLock(prisma, "pg_advisory_xact_lock")).toBe(true);
    } finally {
      driftRace.release.resolve();
    }
    await driftRace.result;
    expectConflict(rejectedValue(await driftPromise), ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
  });

  it("assigns the governed fields once and exactly replays the assignment", async () => {
    const repository = new AssetOperationsRepository();
    const created = await readCommitted(prisma, (tx) =>
      repository.createWorkOrder(tx, createCommand(vehicleId, "assignment-create"))
    );
    const command = {
      actorId: userId,
      assignedUserId: userId,
      detailSnapshot: { fixture: FIXTURE_PREFIX },
      expectedVersion: 0,
      occurredAt: new Date("2026-08-20T01:05:00.000Z"),
      scheduledAt: new Date("2026-08-21T01:00:00.000Z"),
      slaDueAt: new Date("2026-08-22T01:00:00.000Z"),
      source: source("assignment"),
      workOrderId: created.workOrder.id
    };

    const assigned = await readCommitted(prisma, (tx) => repository.assignWorkOrder(tx, command));
    const replayed = await readCommitted(prisma, (tx) => repository.assignWorkOrder(tx, command));

    expect(assigned.workOrder).toMatchObject({
      assignedUserId: userId,
      scheduledAt: command.scheduledAt,
      slaDueAt: command.slaDueAt,
      version: 1
    });
    expect(replayed.event.id).toBe(assigned.event.id);
    expect(replayed.wrote).toBe(false);
  });

  it("replays immutable post-command outcomes after later governed header changes", async () => {
    const repository = new AssetOperationsRepository();
    const create = createCommand(vehicleId, "snapshot-create");
    const created = await readCommitted(prisma, (tx) => repository.createWorkOrder(tx, create));

    const assign = assignmentCommand(created.workOrder.id, userId, "snapshot-assign-1", 0, 5);
    const assigned = await readCommitted(prisma, (tx) => repository.assignWorkOrder(tx, assign));
    await expect(
      readCommitted(prisma, (tx) => repository.createWorkOrder(tx, create))
    ).resolves.toEqual({ ...created, wrote: false });

    const transition = {
      ...transitionCommand(created.workOrder.id, "snapshot-transition"),
      expectedVersion: 1
    };
    const transitioned = await readCommitted(prisma, (tx) =>
      repository.transitionWorkOrder(tx, transition)
    );
    await expect(
      readCommitted(prisma, (tx) => repository.assignWorkOrder(tx, assign))
    ).resolves.toEqual({ ...assigned, wrote: false });

    await readCommitted(prisma, (tx) =>
      repository.assignWorkOrder(
        tx,
        assignmentCommand(created.workOrder.id, userId, "snapshot-assign-2", 2, 12)
      )
    );
    await expect(
      readCommitted(prisma, (tx) => repository.transitionWorkOrder(tx, transition))
    ).resolves.toEqual({ ...transitioned, wrote: false });

    const note = noteCommand(created.workOrder.id, "snapshot-note");
    const noted = await readCommitted(prisma, (tx) => repository.appendNote(tx, note));
    await readCommitted(prisma, (tx) =>
      repository.assignWorkOrder(
        tx,
        assignmentCommand(created.workOrder.id, userId, "snapshot-assign-3", 3, 21)
      )
    );
    await expect(readCommitted(prisma, (tx) => repository.appendNote(tx, note))).resolves.toEqual({
      ...noted,
      wrote: false
    });

    const evidence = evidenceCommand(
      created.workOrder.id,
      await createFileFixture(prisma, "snapshot"),
      "snapshot-evidence"
    );
    const attached = await readCommitted(prisma, (tx) => repository.appendEvidence(tx, evidence));
    await readCommitted(prisma, (tx) =>
      repository.assignWorkOrder(
        tx,
        assignmentCommand(created.workOrder.id, userId, "snapshot-assign-4", 4, 32)
      )
    );
    await expect(
      readCommitted(prisma, (tx) => repository.appendEvidence(tx, evidence))
    ).resolves.toEqual({ ...attached, wrote: false });
  });

  it("serializes distinct-source same-version transitions on the work-order header", async () => {
    const repository = new AssetOperationsRepository();
    const created = await readCommitted(prisma, (tx) =>
      repository.createWorkOrder(tx, createCommand(vehicleId, "transition-create"))
    );
    const firstTransition = transitionCommand(created.workOrder.id, "transition-header-first");
    const secondTransition = transitionCommand(created.workOrder.id, "transition-header-second");
    const first = await holdFirstTransaction(prisma, (tx) =>
      repository.transitionWorkOrder(tx, firstTransition)
    );
    const secondPromise = settled(
      readCommitted(prisma, (tx) => repository.transitionWorkOrder(tx, secondTransition))
    );
    try {
      expect(await waitForDatabaseLock(prisma, 'FROM "asset_work_order"')).toBe(true);
    } finally {
      first.release.resolve();
    }
    const firstResult = await first.result;
    const secondResult = await secondPromise;

    expect(firstResult.workOrder.version).toBe(1);
    expectConflict(
      rejectedValue(secondResult),
      ASSET_OPERATION_ERROR_CODE.WORK_ORDER_VERSION_CONFLICT
    );
    await expect(
      prisma.assetWorkOrder.findUnique({ where: { id: created.workOrder.id } })
    ).resolves.toMatchObject({ status: AssetWorkOrderStatus.IN_PROGRESS, version: 1 });
    await expect(
      prisma.assetWorkOrderEvent.count({
        where: {
          eventType: AssetWorkOrderEventType.STARTED,
          workOrderId: created.workOrder.id
        }
      })
    ).resolves.toBe(1);
  });

  it("serializes distinct-source notes on the header into adjacent unique sequences", async () => {
    const repository = new AssetOperationsRepository();
    const created = await readCommitted(prisma, (tx) =>
      repository.createWorkOrder(tx, createCommand(vehicleId, "event-create"))
    );
    const firstCommand = eventCommand(created.workOrder.id, "event-header-first");
    const secondCommand = eventCommand(created.workOrder.id, "event-header-second");
    const first = await holdFirstTransaction(prisma, (tx) =>
      appendInternalEvent(repository, tx, firstCommand)
    );
    const secondPromise = settled(
      readCommitted(prisma, (tx) => appendInternalEvent(repository, tx, secondCommand))
    );
    try {
      expect(await waitForDatabaseLock(prisma, 'FROM "asset_work_order"')).toBe(true);
    } finally {
      first.release.resolve();
    }
    const [firstResult, secondResult] = await Promise.all([first.result, secondPromise]);

    expect(firstResult.event.sequence).toBe(2);
    expect(secondResult.status).toBe("fulfilled");
    if (secondResult.status === "rejected") throw secondResult.reason;
    expect(secondResult.value.event.sequence).toBe(3);
    await expect(workOrderSequences(prisma, created.workOrder.id)).resolves.toEqual([1, 2, 3]);
  });

  it("allows one concurrent successor for an immutable evidence row", async () => {
    const repository = new AssetOperationsRepository();
    const created = await readCommitted(prisma, (tx) =>
      repository.createWorkOrder(tx, createCommand(vehicleId, "evidence-create"))
    );
    const originalFileId = await createFileFixture(prisma, "original");
    const original = await readCommitted(prisma, (tx) =>
      repository.appendEvidence(
        tx,
        evidenceCommand(created.workOrder.id, originalFileId, "evidence-original")
      )
    );
    const firstFileId = await createFileFixture(prisma, "successor-1");
    const secondFileId = await createFileFixture(prisma, "successor-2");
    const firstCommand = {
      ...evidenceCommand(created.workOrder.id, firstFileId, "evidence-successor-1"),
      action: AssetWorkOrderEvidenceAction.SUPERSEDE,
      supersedesEvidenceId: original.evidence.id
    };
    const secondCommand = {
      ...evidenceCommand(created.workOrder.id, secondFileId, "evidence-successor-2"),
      action: AssetWorkOrderEvidenceAction.SUPERSEDE,
      supersedesEvidenceId: original.evidence.id
    };
    const first = await holdFirstTransaction(prisma, (tx) =>
      repository.appendEvidence(tx, firstCommand)
    );
    const secondPromise = settled(
      readCommitted(prisma, (tx) => repository.appendEvidence(tx, secondCommand))
    );
    let waitedOnHeaderLock: boolean;
    try {
      waitedOnHeaderLock = await waitForDatabaseLock(prisma, "asset_work_order");
    } finally {
      first.release.resolve();
    }
    const [firstResult, secondResult] = await Promise.all([first.result, secondPromise]);

    expect(waitedOnHeaderLock).toBe(true);
    expect(firstResult.evidence.supersedesEvidenceId).toBe(original.evidence.id);
    expectConflict(rejectedValue(secondResult), ASSET_OPERATION_ERROR_CODE.EVIDENCE_CHAIN_CONFLICT);
    await expect(countEvidenceSuccessors(prisma, original.evidence.id)).resolves.toBe(1);
  });

  it("rolls back domain facts when the caller audit stub or the paired event append fails", async () => {
    const repository = new AssetOperationsRepository();
    const auditFailure = createCommand(vehicleId, "rollback-audit");

    await expect(
      readCommitted(prisma, async (tx) => {
        await repository.createWorkOrder(tx, auditFailure);
        throw new Error("AUDIT_STUB_FAILURE");
      })
    ).rejects.toThrow("AUDIT_STUB_FAILURE");
    await expect(countWorkOrdersBySource(prisma, auditFailure.source)).resolves.toBe(0);
    await expect(countEventsBySource(prisma, auditFailure.source)).resolves.toBe(0);

    const created = await readCommitted(prisma, (tx) =>
      repository.createWorkOrder(tx, createCommand(vehicleId, "rollback-evidence-create"))
    );
    const occupiedSource = source("rollback-paired-event");
    await readCommitted(prisma, (tx) =>
      appendInternalEvent(repository, tx, {
        ...eventCommand(created.workOrder.id, "rollback-event-seed"),
        source: occupiedSource
      })
    );
    const fileId = await createFileFixture(prisma, "rollback");
    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.appendEvidence(tx, {
          ...evidenceCommand(created.workOrder.id, fileId, "rollback-evidence"),
          source: occupiedSource
        })
      ),
      ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT
    );
    await expect(countEvidenceBySource(prisma, occupiedSource)).resolves.toBe(0);
  });

  it("serializes restriction start against release for exact source ownership", async () => {
    const repository = new AssetOperationsRepository();
    const releaseTarget = await readCommitted(prisma, (tx) =>
      repository.createRestriction(
        tx,
        createRestrictionCommand(vehicleId, "source-race-release-target")
      )
    );
    const sharedSource = source("source-race-start-release");
    const first = await holdFirstTransaction(prisma, (tx) =>
      repository.createRestriction(tx, {
        ...createRestrictionCommand(vehicleId, "source-race-start-owner"),
        source: sharedSource
      })
    );
    const secondPromise = settled(
      readCommitted(prisma, (tx) =>
        repository.releaseRestriction(tx, {
          ...releaseRestrictionCommand(
            releaseTarget.restriction.id,
            "source-race-release-loser",
            userId
          ),
          source: sharedSource
        })
      )
    );
    let waitedOnOwnershipLock: boolean;
    try {
      waitedOnOwnershipLock = await waitForDatabaseLock(prisma, "pg_advisory_xact_lock");
    } finally {
      first.release.resolve();
    }
    const [firstResult, secondResult] = await Promise.all([first.result, secondPromise]);

    expect(waitedOnOwnershipLock).toBe(true);
    expect(firstResult.wrote).toBe(true);
    expectConflict(rejectedValue(secondResult), ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
    await expect(countRestrictionStartsBySource(prisma, sharedSource)).resolves.toBe(1);
    await expect(countRestrictionReleasesBySource(prisma, sharedSource)).resolves.toBe(0);
    await expect(
      prisma.vehicleOperationalRestriction.findUnique({
        select: { status: true },
        where: { id: releaseTarget.restriction.id }
      })
    ).resolves.toEqual({ status: VehicleOperationalRestrictionStatus.ACTIVE });
  });

  it("serializes restriction start against work-order event for exact source ownership", async () => {
    const repository = new AssetOperationsRepository();
    const workOrder = await readCommitted(prisma, (tx) =>
      repository.createWorkOrder(tx, createCommand(vehicleId, "source-race-event-work-order"))
    );
    const sharedSource = source("source-race-start-event");
    const first = await holdFirstTransaction(prisma, (tx) =>
      repository.createRestriction(tx, {
        ...createRestrictionCommand(vehicleId, "source-race-start-event-owner"),
        source: sharedSource
      })
    );
    const secondPromise = settled(
      readCommitted(prisma, (tx) =>
        repository.appendNote(tx, {
          ...noteCommand(workOrder.workOrder.id, "source-race-event-loser"),
          source: sharedSource
        })
      )
    );
    let waitedOnOwnershipLock: boolean;
    try {
      waitedOnOwnershipLock = await waitForDatabaseLock(prisma, "pg_advisory_xact_lock");
    } finally {
      first.release.resolve();
    }
    const [firstResult, secondResult] = await Promise.all([first.result, secondPromise]);

    expect(waitedOnOwnershipLock).toBe(true);
    expect(firstResult.wrote).toBe(true);
    expectConflict(rejectedValue(secondResult), ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT);
    await expect(countRestrictionStartsBySource(prisma, sharedSource)).resolves.toBe(1);
    await expect(countEventsBySource(prisma, sharedSource)).resolves.toBe(0);
  });

  it("enforces linked acceptance and exactly replays immutable restriction outcomes", async () => {
    const repository = new AssetOperationsRepository();
    const workOrder = await readCommitted(prisma, (tx) =>
      repository.createWorkOrder(tx, {
        ...createCommand(vehicleId, "restriction-linked-work-order"),
        costConfirmationRequired: true
      })
    );
    const create = createRestrictionCommand(
      vehicleId,
      "restriction-linked-create",
      workOrder.workOrder.id
    );
    const created = await readCommitted(prisma, (tx) => repository.createRestriction(tx, create));
    expect(created.event).toMatchObject({
      eventType: AssetWorkOrderEventType.RESTRICTION_CREATED,
      sequence: 2
    });

    const release = releaseRestrictionCommand(
      created.restriction.id,
      "restriction-linked-release",
      userId
    );
    await expectCode(
      readCommitted(prisma, (tx) => repository.releaseRestriction(tx, release)),
      ASSET_OPERATION_ERROR_CODE.RESTRICTION_WORK_ORDER_NOT_ACCEPTED
    );
    await readCommitted(prisma, (tx) =>
      repository.transitionWorkOrder(
        tx,
        transitionTo(
          workOrder.workOrder.id,
          "restriction-start",
          0,
          AssetWorkOrderStatus.IN_PROGRESS
        )
      )
    );
    await readCommitted(prisma, (tx) =>
      repository.transitionWorkOrder(
        tx,
        transitionTo(
          workOrder.workOrder.id,
          "restriction-submit",
          1,
          AssetWorkOrderStatus.PENDING_ACCEPTANCE
        )
      )
    );
    await readCommitted(prisma, (tx) =>
      repository.transitionWorkOrder(
        tx,
        transitionTo(
          workOrder.workOrder.id,
          "restriction-accept",
          2,
          AssetWorkOrderStatus.PENDING_COST_CONFIRMATION
        )
      )
    );

    const released = await readCommitted(prisma, (tx) =>
      repository.releaseRestriction(tx, release)
    );
    await expect(
      readCommitted(prisma, (tx) => repository.releaseRestriction(tx, release))
    ).resolves.toEqual({ ...released, wrote: false });
    await expect(
      readCommitted(prisma, (tx) => repository.createRestriction(tx, create))
    ).resolves.toEqual({ ...created, wrote: false });
    expect(released).toMatchObject({
      event: { eventType: AssetWorkOrderEventType.RESTRICTION_RELEASED },
      restriction: { status: VehicleOperationalRestrictionStatus.RELEASED },
      wrote: true
    });
    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.releaseRestriction(tx, {
          ...releaseRestrictionCommand(created.restriction.id, "restriction-linked-drift", userId),
          source: release.source
        })
      ),
      ASSET_OPERATION_ERROR_CODE.SOURCE_CONFLICT
    );
  });

  it("allows concurrent release and a distinct active incident of the same type", async () => {
    const repository = new AssetOperationsRepository();
    const first = await readCommitted(prisma, (tx) =>
      repository.createRestriction(
        tx,
        createRestrictionCommand(vehicleId, "restriction-concurrent-first")
      )
    );
    const release = await holdFirstTransaction(prisma, (tx) =>
      repository.releaseRestriction(
        tx,
        releaseRestrictionCommand(first.restriction.id, "restriction-concurrent-release", userId)
      )
    );
    const secondPromise = readCommitted(prisma, (tx) =>
      repository.createRestriction(
        tx,
        createRestrictionCommand(vehicleId, "restriction-concurrent-second")
      )
    );
    const second = await secondPromise;
    release.release.resolve();
    const released = await release.result;

    expect(released.restriction.status).toBe(VehicleOperationalRestrictionStatus.RELEASED);
    expect(second.restriction.status).toBe(VehicleOperationalRestrictionStatus.ACTIVE);
    await expect(
      prisma.vehicleOperationalRestriction.count({
        where: {
          restrictionType: VehicleOperationalRestrictionType.MAINTENANCE_OR_ACCIDENT,
          startSourceKey: { startsWith: FIXTURE_PREFIX },
          vehicleId
        }
      })
    ).resolves.toBeGreaterThanOrEqual(2);
  });

  it("loads only deterministic as-of occupancy and active restrictions", async () => {
    const repository = new AssetOperationsRepository();
    const loaderVehicleId = await createVehicleFixture(prisma, "L");
    const asOf = new Date("2026-08-20T02:00:00.000Z");
    const periodB = randomUUID();
    const periodEnded = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      for (const [id, orderId, startedAt, endedAt] of [
        [periodEnded, randomUUID(), new Date("2026-08-18T00:00:00.000Z"), asOf],
        [periodB, randomUUID(), asOf, null]
      ] as const) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "vehicle_subscription_period" (
            "id", "vehicle_id", "order_id", "customer_id", "started_at", "ended_at",
            "start_reason", "start_source_type", "start_source_id", "start_source_key",
            "start_snapshot", "created_at", "updated_at"
          ) VALUES (
            ${id}::uuid, ${loaderVehicleId}::uuid, ${orderId}::uuid, ${randomUUID()}::uuid,
            ${startedAt}, ${endedAt}, 'LEASE_ACTIVATED', 'STAGE1C_TASK3_TEST',
            ${randomUUID()}::uuid, ${`${FIXTURE_PREFIX}:period:${id}`}, '{}'::jsonb,
            clock_timestamp(), clock_timestamp()
          )
        `);
      }
    });
    const restrictionB = await readCommitted(prisma, (tx) =>
      repository.createRestriction(
        tx,
        createRestrictionCommand(loaderVehicleId, "restriction-loader-b")
      )
    );
    const restrictionA = await readCommitted(prisma, (tx) =>
      repository.createRestriction(
        tx,
        createRestrictionCommand(loaderVehicleId, "restriction-loader-a")
      )
    );
    const released = await readCommitted(prisma, (tx) =>
      repository.createRestriction(
        tx,
        createRestrictionCommand(loaderVehicleId, "restriction-loader-released")
      )
    );
    await readCommitted(prisma, (tx) =>
      repository.releaseRestriction(
        tx,
        releaseRestrictionCommand(released.restriction.id, "restriction-loader-release", userId)
      )
    );
    const future = await readCommitted(prisma, (tx) =>
      repository.createRestriction(tx, {
        ...createRestrictionCommand(loaderVehicleId, "restriction-loader-future"),
        occurredAt: asOf,
        startedAt: new Date("2026-08-20T02:00:00.001Z")
      })
    );

    const snapshot = await readCommitted(prisma, (tx) =>
      repository.loadAvailabilitySnapshot(tx, loaderVehicleId, asOf)
    );

    expect(snapshot.activeSubscriptionPeriods.map((period) => period.id)).toEqual([periodB]);
    expect(snapshot.activeRestrictions.map((restriction) => restriction.id)).not.toContain(
      released.restriction.id
    );
    expect(snapshot.activeRestrictions.map((restriction) => restriction.id)).not.toContain(
      future.restriction.id
    );
    expect(snapshot.activeRestrictions.map((restriction) => restriction.id)).toEqual(
      [restrictionA.restriction.id, restrictionB.restriction.id].sort()
    );
  });

  it("rolls back a restriction release and its linked event with the caller transaction", async () => {
    const repository = new AssetOperationsRepository();
    const workOrder = await readCommitted(prisma, (tx) =>
      repository.createWorkOrder(tx, {
        ...createCommand(vehicleId, "restriction-rollback-work-order"),
        costConfirmationRequired: true
      })
    );
    await readCommitted(prisma, (tx) =>
      repository.transitionWorkOrder(
        tx,
        transitionTo(
          workOrder.workOrder.id,
          "restriction-rollback-start",
          0,
          AssetWorkOrderStatus.IN_PROGRESS
        )
      )
    );
    await readCommitted(prisma, (tx) =>
      repository.transitionWorkOrder(
        tx,
        transitionTo(
          workOrder.workOrder.id,
          "restriction-rollback-submit",
          1,
          AssetWorkOrderStatus.PENDING_ACCEPTANCE
        )
      )
    );
    await readCommitted(prisma, (tx) =>
      repository.transitionWorkOrder(
        tx,
        transitionTo(
          workOrder.workOrder.id,
          "restriction-rollback-accept",
          2,
          AssetWorkOrderStatus.PENDING_COST_CONFIRMATION
        )
      )
    );
    const created = await readCommitted(prisma, (tx) =>
      repository.createRestriction(
        tx,
        createRestrictionCommand(vehicleId, "restriction-rollback-create", workOrder.workOrder.id)
      )
    );
    const release = releaseRestrictionCommand(
      created.restriction.id,
      "restriction-rollback-release",
      userId
    );

    await expect(
      readCommitted(prisma, async (tx) => {
        await repository.releaseRestriction(tx, release);
        throw new Error("AUDIT_STUB_FAILURE");
      })
    ).rejects.toThrow("AUDIT_STUB_FAILURE");
    await expect(
      prisma.vehicleOperationalRestriction.findUnique({
        where: { id: created.restriction.id }
      })
    ).resolves.toMatchObject({
      releaseSourceKey: null,
      status: VehicleOperationalRestrictionStatus.ACTIVE
    });
    await expect(countEventsBySource(prisma, release.source)).resolves.toBe(0);
  });

  it("rolls back every service fact and prior audit row when audited commands fail", async () => {
    const baselineService = createAssetOperationsService(prisma);

    const create = serviceCreateCommand(vehicleId, "service-audit-create");
    await expect(
      createAssetOperationsService(prisma, failingAuditService(prisma, 2)).createWorkOrder(
        create,
        serviceContext(userId)
      )
    ).rejects.toThrow("AUDIT_STUB_FAILURE");
    await expect(countWorkOrdersBySource(prisma, create.source)).resolves.toBe(0);
    await expect(countEventsBySource(prisma, create.source)).resolves.toBe(0);
    await expect(countAuditsBySourceKey(prisma, create.source.key)).resolves.toBe(0);

    const baseline = await baselineService.createWorkOrder(
      serviceCreateCommand(vehicleId, "service-audit-baseline"),
      serviceContext(userId)
    );
    const assignment = assignmentCommand(
      baseline.workOrder.id,
      userId,
      "service-audit-assignment",
      0,
      6
    );
    await expect(
      createAssetOperationsService(prisma, failingAuditService(prisma, 2)).assignWorkOrder(
        withoutActor(assignment),
        serviceContext(userId)
      )
    ).rejects.toThrow("AUDIT_STUB_FAILURE");
    await expect(
      prisma.assetWorkOrder.findUnique({ where: { id: baseline.workOrder.id } })
    ).resolves.toMatchObject({ assignedUserId: null, version: 0 });
    await expect(countEventsBySource(prisma, assignment.source)).resolves.toBe(0);
    await expect(countAuditsBySourceKey(prisma, assignment.source.key)).resolves.toBe(0);

    const note = noteCommand(baseline.workOrder.id, "service-audit-note");
    await expect(
      createAssetOperationsService(prisma, failingAuditService(prisma, 1)).appendNote(
        withoutActor(note),
        serviceContext(userId)
      )
    ).rejects.toThrow("AUDIT_STUB_FAILURE");
    await expect(countEventsBySource(prisma, note.source)).resolves.toBe(0);
    await expect(countAuditsBySourceKey(prisma, note.source.key)).resolves.toBe(0);

    const fileId = await createFileFixture(prisma, "service-audit-evidence");
    const evidence = evidenceCommand(baseline.workOrder.id, fileId, "service-audit-evidence");
    await expect(
      createAssetOperationsService(prisma, failingAuditService(prisma, 2)).appendEvidence(
        withoutActor(evidence),
        serviceContext(userId)
      )
    ).rejects.toThrow("AUDIT_STUB_FAILURE");
    await expect(countEvidenceBySource(prisma, evidence.source)).resolves.toBe(0);
    await expect(countEventsBySource(prisma, evidence.source)).resolves.toBe(0);
    await expect(countAuditsBySourceKey(prisma, evidence.source.key)).resolves.toBe(0);

    const restriction = createRestrictionCommand(
      vehicleId,
      "service-audit-restriction",
      baseline.workOrder.id
    );
    await expect(
      createAssetOperationsService(prisma, failingAuditService(prisma, 2)).createRestriction(
        withoutActor(restriction),
        serviceContext(userId)
      )
    ).rejects.toThrow("AUDIT_STUB_FAILURE");
    await expect(countRestrictionStartsBySource(prisma, restriction.source)).resolves.toBe(0);
    await expect(countEventsBySource(prisma, restriction.source)).resolves.toBe(0);
    await expect(countAuditsBySourceKey(prisma, restriction.source.key)).resolves.toBe(0);

    const active = await baselineService.createRestriction(
      withoutActor(createRestrictionCommand(vehicleId, "service-audit-release-baseline")),
      serviceContext(userId)
    );
    const release = releaseRestrictionCommand(
      active.restriction.id,
      "service-audit-release",
      userId
    );
    await expect(
      createAssetOperationsService(prisma, failingAuditService(prisma, 1)).releaseRestriction(
        withoutActor(release),
        serviceContext(userId, ["vehicle_restriction:release"])
      )
    ).rejects.toThrow("AUDIT_STUB_FAILURE");
    await expect(
      prisma.vehicleOperationalRestriction.findUnique({ where: { id: active.restriction.id } })
    ).resolves.toMatchObject({
      releaseSourceKey: null,
      status: VehicleOperationalRestrictionStatus.ACTIVE
    });
    await expect(countRestrictionReleasesBySource(prisma, release.source)).resolves.toBe(0);
    await expect(countAuditsBySourceKey(prisma, release.source.key)).resolves.toBe(0);
  });

  it("audits one committed work-order and event once across exact service replay", async () => {
    const service = createAssetOperationsService(prisma);
    const command = serviceCreateCommand(vehicleId, "service-audit-replay");

    const created = await service.createWorkOrder(command, serviceContext(userId));
    const replayed = await service.createWorkOrder(command, serviceContext(userId));

    expect(replayed).toEqual({ ...created, wrote: false });
    await expect(countAuditsBySourceKey(prisma, command.source.key)).resolves.toBe(2);
  });

  it.each(["order-first", "vehicle-first"] as const)(
    "fails service authority validation fast behind a %s holder and leaves the holder usable",
    async (lockOrder) => {
      const fixture = await createServiceAuthorityFixture(prisma, lockOrder);
      const result = await runServiceAuthorityContention(prisma, fixture, lockOrder);

      expect(result.commandFinishedFast).toBe(true);
      expectConflict(rejectedValue(result.command), ASSET_OPERATION_ERROR_CODE.AUTHORITY_BUSY);
      expect(result.holder).toMatchObject({ followUpAuthorityUpdates: 1, transactionUsable: true });
      await expect(countWorkOrdersBySource(prisma, result.source)).resolves.toBe(0);
      await expect(countAuditsBySourceKey(prisma, result.source.key)).resolves.toBe(0);
    }
  );

  it.each(["note", "assignment", "evidence"] as const)(
    "fails a distinct-source service %s command fast while another command owns the mutable header",
    async (competingKind) => {
      const repository = new PausingTransitionRepository(competingKind);
      const service = createAssetOperationsService(prisma, new AuditService(prisma), repository);
      const created = await service.createWorkOrder(
        serviceCreateCommand(vehicleId, `service-header-${competingKind}-create`),
        serviceContext(userId)
      );
      const auditCountBefore = await countAuditsForWorkOrder(prisma, created.workOrder.id);
      const winnerCommand = withoutActor(
        transitionCommand(created.workOrder.id, `service-header-${competingKind}-winner`)
      );
      const winnerPromise = settled(
        service.transitionWorkOrder(winnerCommand, serviceContext(userId))
      );
      await repository.transitionReached.promise;

      const competitor = await createCompetingServiceCommand(
        prisma,
        service,
        competingKind,
        created.workOrder.id,
        userId
      );
      const loserPromise = settled(competitor.run());
      const early = await settlesWithin(loserPromise, 750);
      const repositoryEntry = await settlesWithin(repository.competingReached.promise, 50);
      repository.releaseTransition.resolve();
      const [winner, loser] = await Promise.all([
        winnerPromise,
        early.finished ? Promise.resolve(early.value) : loserPromise
      ]);

      expect(
        early.finished,
        `command did not fail fast; final settlements were winner=${settlementCode(winner)}, loser=${settlementCode(loser)}`
      ).toBe(true);
      expect(repositoryEntry.finished).toBe(false);
      expectConflict(rejectedValue(loser), ASSET_OPERATION_ERROR_CODE.AUTHORITY_BUSY);
      expect(winner.status).toBe("fulfilled");
      if (winner.status === "rejected") throw winner.reason;
      expect(winner.value.workOrder).toMatchObject({
        status: AssetWorkOrderStatus.IN_PROGRESS,
        version: 1
      });
      await expect(
        service.transitionWorkOrder(winnerCommand, serviceContext(userId))
      ).resolves.toEqual({ ...winner.value, wrote: false });
      await expect(countEventsBySource(prisma, winnerCommand.source)).resolves.toBe(1);
      await expect(countEventsBySource(prisma, competitor.source)).resolves.toBe(0);
      await expect(countEvidenceBySource(prisma, competitor.source)).resolves.toBe(0);
      await expect(countAuditsBySourceKey(prisma, competitor.source.key)).resolves.toBe(0);
      await expect(countAuditsForWorkOrder(prisma, created.workOrder.id)).resolves.toBe(
        auditCountBefore + 2
      );
      await expect(workOrderSequences(prisma, created.workOrder.id)).resolves.toEqual([1, 2]);
    }
  );
});

function createAssetOperationsService(
  prisma: PrismaService,
  auditService: AuditService = new AuditService(prisma),
  repository: AssetOperationsRepository = new AssetOperationsRepository()
) {
  return new AssetOperationsService(prisma, repository, auditService);
}

class PausingTransitionRepository extends AssetOperationsRepository {
  readonly competingReached = deferred<void>();
  readonly releaseTransition = deferred<void>();
  readonly transitionReached = deferred<void>();

  constructor(private readonly competingKind: "assignment" | "evidence" | "note") {
    super();
  }

  override async transitionWorkOrder(
    ...args: Parameters<AssetOperationsRepository["transitionWorkOrder"]>
  ) {
    this.transitionReached.resolve();
    await this.releaseTransition.promise;
    return super.transitionWorkOrder(...args);
  }

  override assignWorkOrder(...args: Parameters<AssetOperationsRepository["assignWorkOrder"]>) {
    if (this.competingKind === "assignment") this.competingReached.resolve();
    return super.assignWorkOrder(...args);
  }

  override appendEvidence(...args: Parameters<AssetOperationsRepository["appendEvidence"]>) {
    if (this.competingKind === "evidence") this.competingReached.resolve();
    return super.appendEvidence(...args);
  }

  override appendNote(...args: Parameters<AssetOperationsRepository["appendNote"]>) {
    if (this.competingKind === "note") this.competingReached.resolve();
    return super.appendNote(...args);
  }
}

async function createCompetingServiceCommand(
  prisma: PrismaService,
  service: AssetOperationsService,
  kind: "assignment" | "evidence" | "note",
  workOrderId: string,
  actorId: string
) {
  if (kind === "assignment") {
    const command = withoutActor(
      assignmentCommand(workOrderId, actorId, "service-header-assignment-loser", 0, 42)
    );
    return {
      run: () => service.assignWorkOrder(command, serviceContext(actorId)),
      source: command.source
    };
  }
  if (kind === "evidence") {
    const command = withoutActor(
      evidenceCommand(
        workOrderId,
        await createFileFixture(prisma, "service-header-evidence-loser"),
        "service-header-evidence-loser"
      )
    );
    return {
      run: () => service.appendEvidence(command, serviceContext(actorId)),
      source: command.source
    };
  }
  const command = withoutActor(noteCommand(workOrderId, "service-header-note-loser"));
  return {
    run: () => service.appendNote(command, serviceContext(actorId)),
    source: command.source
  };
}

function failingAuditService(prisma: PrismaService, failOnCall: number) {
  const real = new AuditService(prisma);
  let calls = 0;
  return {
    async write(...args: Parameters<AuditService["write"]>) {
      calls += 1;
      await real.write(...args);
      if (calls === failOnCall) throw new Error("AUDIT_STUB_FAILURE");
    }
  } as unknown as AuditService;
}

function serviceContext(actorId: string | null, permissions: readonly string[] = []) {
  return {
    actorId,
    ipAddress: "127.0.0.1",
    permissions,
    userAgent: "asset-operations-integration"
  };
}

function serviceCreateCommand(vehicleId: string, label: string) {
  return Object.fromEntries(
    Object.entries(createCommand(vehicleId, label)).filter(
      ([key]) => key !== "actorId" && key !== "authoritySnapshot"
    )
  ) as Omit<CreateWorkOrderCommand, "actorId" | "authoritySnapshot">;
}

function withoutActor<T extends { actorId: unknown }>(command: T): Omit<T, "actorId"> {
  return Object.fromEntries(Object.entries(command).filter(([key]) => key !== "actorId")) as Omit<
    T,
    "actorId"
  >;
}

async function countAuditsBySourceKey(prisma: PrismaService, sourceKey: string) {
  const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS "count"
    FROM "audit_log"
    WHERE "module" = 'asset_operations'
      AND "after_snapshot"::text LIKE ${`%${sourceKey}%`}
  `);
  return Number(row?.count ?? 0n);
}

async function countAuditsForWorkOrder(prisma: PrismaService, workOrderId: string) {
  const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS "count"
    FROM "audit_log"
    WHERE "module" = 'asset_operations'
      AND (
        "entity_id" = ${workOrderId}::uuid
        OR "entity_id" IN (
          SELECT "id" FROM "asset_work_order_event" WHERE "work_order_id" = ${workOrderId}::uuid
        )
        OR "entity_id" IN (
          SELECT "id" FROM "asset_work_order_evidence" WHERE "work_order_id" = ${workOrderId}::uuid
        )
      )
  `);
  return Number(row?.count ?? 0n);
}

type ServiceAuthorityFixture = {
  customerId: string;
  orderId: string;
  vehicleId: string;
};

async function createServiceAuthorityFixture(
  prisma: PrismaService,
  label: string
): Promise<ServiceAuthorityFixture> {
  const customerId = randomUUID();
  const orderId = randomUUID();
  const vehicleId = await createVehicleFixture(prisma, label === "order-first" ? "O" : "R");
  const token = randomUUID().replaceAll("-", "").slice(0, 12);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "customer" (
        "id", "customer_no", "name", "mobile", "status", "created_at", "updated_at"
      ) VALUES (
        ${customerId}::uuid, ${`${FIXTURE_PREFIX}C${token}`}, 'Stage 1C-B Contention',
        '13800000000', 'ACTIVE', clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_order" (
        "id", "order_no", "customer_id", "application_id", "quote_id", "vehicle_id",
        "product_id", "product_version_id", "vehicle_purchase_price_amount", "monthly_fee_amount",
        "deposit_amount", "period_months", "mileage_limit_km", "over_mileage_fee_amount",
        "model_definition_id_snapshot", "model_code_snapshot", "model_display_name_snapshot",
        "quote_snapshot", "order_status", "created_at", "updated_at"
      ) VALUES (
        ${orderId}::uuid, ${`${FIXTURE_PREFIX}O${token}`}, ${customerId}::uuid,
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${vehicleId}::uuid,
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, 20000000, 100, 0, 6, 1500, 100,
        ${randomUUID()}::uuid, 'NIO_ET5_2024', 'NIO ET5', '{}'::jsonb,
        'ACTIVE', clock_timestamp(), clock_timestamp()
      )
    `);
  });
  return { customerId, orderId, vehicleId };
}

async function runServiceAuthorityContention(
  prisma: PrismaService,
  fixture: ServiceAuthorityFixture,
  lockOrder: "order-first" | "vehicle-first"
) {
  const lockReached = deferred<void>();
  const allowFollowUp = deferred<void>();
  const holderPromise = readCommitted(prisma, async (tx) => {
    if (lockOrder === "order-first") {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_order" WHERE "id" = ${fixture.orderId}::uuid FOR UPDATE`
      );
    } else {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "vehicle" WHERE "id" = ${fixture.vehicleId}::uuid FOR UPDATE`
      );
    }
    lockReached.resolve();
    await allowFollowUp.promise;
    const [probe] = await tx.$queryRaw<Array<{ transactionId: string }>>(
      Prisma.sql`SELECT txid_current()::text AS "transactionId"`
    );
    const followUpAuthorityUpdates =
      lockOrder === "order-first"
        ? await tx.$executeRaw(
            Prisma.sql`UPDATE "vehicle" SET "updated_at" = clock_timestamp() WHERE "id" = ${fixture.vehicleId}::uuid`
          )
        : await tx.$executeRaw(
            Prisma.sql`UPDATE "subscription_order" SET "updated_at" = clock_timestamp() WHERE "id" = ${fixture.orderId}::uuid`
          );
    return { followUpAuthorityUpdates, transactionUsable: Boolean(probe?.transactionId) };
  });
  void holderPromise.catch(lockReached.reject);
  await lockReached.promise;

  const create = {
    ...serviceCreateCommand(fixture.vehicleId, `service-contention-${lockOrder}`),
    customerId: fixture.customerId,
    orderId: fixture.orderId
  };
  const commandPromise = settled(
    createAssetOperationsService(prisma).createWorkOrder(create, serviceContext(null))
  );
  const early = await settlesWithin(commandPromise, 750);
  allowFollowUp.resolve();
  const [holder, command] = await Promise.all([
    holderPromise,
    early.finished ? Promise.resolve(early.value) : commandPromise
  ]);
  return {
    command,
    commandFinishedFast: early.finished,
    holder,
    source: create.source
  };
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number) {
  const marker = Symbol("timeout");
  const value = await Promise.race([
    promise,
    new Promise<typeof marker>((resolve) => setTimeout(() => resolve(marker), timeoutMs))
  ]);
  return value === marker
    ? { finished: false as const, value: undefined }
    : { finished: true as const, value };
}

function createCommand(vehicleId: string, label: string): CreateWorkOrderCommand {
  return {
    actorId: null,
    assetOwnerId: null,
    authoritySnapshot: { lifecycle: "RETURNED" },
    contractId: null,
    costConfirmationRequired: false,
    customerId: null,
    description: `Stage 1C-B ${label}`,
    metadata: { fixture: FIXTURE_PREFIX },
    occurredAt: OCCURRED_AT,
    orderId: null,
    priority: AssetWorkOrderPriority.NORMAL,
    relatedWorkOrderId: null,
    source: source(label),
    vehicleId,
    workOrderType: AssetWorkOrderType.RECONDITIONING
  };
}

function transitionCommand(workOrderId: string, label: string): TransitionWorkOrderCommand {
  return {
    actorId: null,
    closeReason: null,
    detailSnapshot: { fixture: FIXTURE_PREFIX },
    expectedVersion: 0,
    occurredAt: new Date("2026-08-20T01:10:00.000Z"),
    solution: null,
    source: source(label),
    targetStatus: AssetWorkOrderStatus.IN_PROGRESS,
    workOrderId
  };
}

function transitionTo(
  workOrderId: string,
  label: string,
  expectedVersion: number,
  targetStatus: AssetWorkOrderStatus
): TransitionWorkOrderCommand {
  return { ...transitionCommand(workOrderId, label), expectedVersion, targetStatus };
}

function assignmentCommand(
  workOrderId: string,
  assignedUserId: string,
  label: string,
  expectedVersion: number,
  minute: number
) {
  return {
    actorId: assignedUserId,
    assignedUserId,
    detailSnapshot: { fixture: FIXTURE_PREFIX, label },
    expectedVersion,
    occurredAt: new Date(`2026-08-20T01:${String(minute).padStart(2, "0")}:00.000Z`),
    scheduledAt: new Date("2026-08-21T01:00:00.000Z"),
    slaDueAt: new Date("2026-08-22T01:00:00.000Z"),
    source: source(label),
    workOrderId
  };
}

function noteCommand(workOrderId: string, label: string): AppendNoteCommand {
  return {
    actorId: null,
    note: label,
    occurredAt: new Date("2026-08-20T01:20:00.000Z"),
    source: source(label),
    workOrderId
  };
}

function eventCommand(workOrderId: string, label: string): AppendWorkOrderEventCommand {
  return {
    actorId: null,
    afterStatus: null,
    beforeStatus: null,
    detailSnapshot: { note: label },
    eventType: AssetWorkOrderEventType.NOTE_ADDED,
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
    captureMetadata: { fixture: FIXTURE_PREFIX },
    contentSha256: "a".repeat(64),
    eventId: null,
    evidenceType: AssetWorkOrderEvidenceType.PHOTO,
    fileId,
    occurredAt: new Date("2026-08-20T01:31:00.000Z"),
    source: source(label),
    supersedesEvidenceId: null,
    workOrderId
  };
}

function createRestrictionCommand(
  vehicleId: string,
  label: string,
  workOrderId: string | null = null
): CreateRestrictionCommand {
  return {
    actorId: null,
    conditionsSnapshot: { releaseCondition: "inspection completed" },
    evidenceSnapshot: { evidenceIds: [`${FIXTURE_PREFIX}:${label}`] },
    occurredAt: new Date("2026-08-20T01:40:00.000Z"),
    restrictionType: VehicleOperationalRestrictionType.MAINTENANCE_OR_ACCIDENT,
    scopes: [VehicleOperationalRestrictionScope.ALLOCATION],
    severity: VehicleOperationalRestrictionSeverity.BLOCKING,
    source: source(label),
    startedAt: new Date("2026-08-20T01:39:00.000Z"),
    vehicleId,
    workOrderId
  };
}

function releaseRestrictionCommand(
  restrictionId: string,
  label: string,
  actorId: string
): ReleaseRestrictionCommand {
  return {
    actorId,
    occurredAt: new Date("2026-08-20T01:50:00.000Z"),
    releaseReason: "inspection completed",
    releaseSnapshot: { evidenceIds: [`${FIXTURE_PREFIX}:${label}`] },
    restrictionId,
    source: source(label),
    targetStatus: VehicleOperationalRestrictionStatus.RELEASED
  };
}

function source(label: string): StableAssetOperationSource {
  const id = randomUUID();
  return { id, key: `${FIXTURE_PREFIX}:${label}:${id}`, type: "STAGE1C_TASK2_TEST" };
}

function readCommitted<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>
) {
  return prisma.$transaction(work, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 5_000,
    timeout: 15_000
  });
}

async function holdFirstTransaction<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>
) {
  const reached = deferred<T>();
  const release = deferred<void>();
  const result = readCommitted(prisma, async (tx) => {
    const value = await work(tx);
    reached.resolve(value);
    await release.promise;
    return value;
  });
  void result.catch(reached.reject);
  await reached.promise;
  return { release, result };
}

async function createVehicleFixture(prisma: PrismaService, label = "") {
  const id = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle" (
        "id", "vehicle_no", "plate_no", "brand", "model_definition_id",
        "purchase_price_amount", "status", "created_at", "updated_at"
      ) VALUES (
        ${id}::uuid, ${`${FIXTURE_PREFIX}V${label}`}, ${`沪T${FIXTURE_PREFIX.slice(-5)}${label}`},
        'NIO', ${randomUUID()}::uuid, 20000000, 'RETURNED', clock_timestamp(), clock_timestamp()
      )
    `);
  });
  return id;
}

async function createFileFixture(prisma: PrismaService, label: string) {
  const id = randomUUID();
  await prisma.fileObject.create({
    data: {
      bucket: "asset-evidence",
      id,
      mimeType: "image/jpeg",
      objectKey: `${FIXTURE_PREFIX}/${label}.jpg`,
      originalName: `${label}.jpg`,
      sizeBytes: 1234n
    }
  });
  return id;
}

async function createUserFixture(prisma: PrismaService) {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      name: "Stage 1C-B Operator",
      passwordHash: "not-used-by-test",
      username: `${FIXTURE_PREFIX.toLowerCase()}_op`
    }
  });
  return id;
}

async function deleteFixtures(prisma: PrismaService) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`
      DELETE FROM "audit_log"
      WHERE "module" = 'asset_operations'
        AND "after_snapshot"::text LIKE ${`%${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "vehicle_operational_restriction"
      WHERE "start_source_key" LIKE ${`${FIXTURE_PREFIX}%`}
         OR "release_source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "asset_work_order_evidence"
      WHERE "source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "asset_work_order_event"
      WHERE "source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "asset_work_order"
      WHERE "create_source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "vehicle_subscription_period"
      WHERE "start_source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "file_object"
      WHERE "object_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "subscription_order"
      WHERE "order_no" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "customer"
      WHERE "customer_no" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "vehicle"
      WHERE "vehicle_no" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "user"
      WHERE "username" LIKE ${`${FIXTURE_PREFIX.toLowerCase()}%`}
    `;
  });
}

async function countWorkOrdersBySource(
  prisma: PrismaService,
  sourceValue: StableAssetOperationSource
) {
  return prisma.assetWorkOrder.count({
    where: {
      createSourceId: sourceValue.id,
      createSourceKey: sourceValue.key,
      createSourceType: sourceValue.type
    }
  });
}

async function countEventsBySource(prisma: PrismaService, sourceValue: StableAssetOperationSource) {
  return prisma.assetWorkOrderEvent.count({
    where: {
      sourceId: sourceValue.id,
      sourceKey: sourceValue.key,
      sourceType: sourceValue.type
    }
  });
}

async function countEvidenceBySource(
  prisma: PrismaService,
  sourceValue: StableAssetOperationSource
) {
  return prisma.assetWorkOrderEvidence.count({
    where: {
      sourceId: sourceValue.id,
      sourceKey: sourceValue.key,
      sourceType: sourceValue.type
    }
  });
}

async function countRestrictionStartsBySource(
  prisma: PrismaService,
  sourceValue: StableAssetOperationSource
) {
  return prisma.vehicleOperationalRestriction.count({
    where: {
      startSourceId: sourceValue.id,
      startSourceKey: sourceValue.key,
      startSourceType: sourceValue.type
    }
  });
}

async function countRestrictionReleasesBySource(
  prisma: PrismaService,
  sourceValue: StableAssetOperationSource
) {
  return prisma.vehicleOperationalRestriction.count({
    where: {
      releaseSourceId: sourceValue.id,
      releaseSourceKey: sourceValue.key,
      releaseSourceType: sourceValue.type
    }
  });
}

async function countEvidenceSuccessors(prisma: PrismaService, evidenceId: string) {
  return prisma.assetWorkOrderEvidence.count({ where: { supersedesEvidenceId: evidenceId } });
}

async function workOrderSequences(prisma: PrismaService, workOrderId: string) {
  const rows = await prisma.assetWorkOrderEvent.findMany({
    orderBy: { sequence: "asc" },
    select: { sequence: true },
    where: { workOrderId }
  });
  return rows.map((row) => row.sequence);
}

async function waitForDatabaseLock(prisma: PrismaService, queryFragment: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [status] = await prisma.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE "pid" <> pg_backend_pid()
          AND "datname" = current_database()
          AND "state" = 'active'
          AND "wait_event_type" = 'Lock'
          AND "query" ILIKE ${`%${queryFragment}%`}
      ) AS "waiting"
    `);
    if (status?.waiting) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { reason, status: "rejected" };
  }
}

function rejectedValue(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") throw new Error("Expected rejection.");
  return result.reason;
}

function settlementCode(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return "fulfilled";
  const error = result.reason;
  if (error instanceof ConflictException) {
    const response = error.getResponse();
    if (typeof response === "object" && response && "code" in response) {
      return `rejected:${String(response.code)}`;
    }
  }
  if (typeof error === "object" && error && "code" in error) {
    return `rejected:${String(error.code)}`;
  }
  return `rejected:${error instanceof Error ? error.constructor.name : typeof error}`;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected conflict ${code}.`);
  } catch (error) {
    expectConflict(error, code);
  }
}

function expectConflict(error: unknown, code: string) {
  expect(error).toBeInstanceOf(ConflictException);
  expect((error as ConflictException).getResponse()).toMatchObject({ code });
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

function requiredTestDatabaseUrl(value = process.env.DATABASE_URL) {
  if (!value) throw new Error("DATABASE_URL is required for asset operations integration tests");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Asset operations integration tests require PostgreSQL");
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("Asset operations integration tests require a loopback PostgreSQL host");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*_(test|codex)$/.test(databaseName)) {
    throw new Error("Asset operations integration tests require a test-only database");
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

function isLoopbackHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}
