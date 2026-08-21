import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditAction, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";
import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import { AuditService } from "../src/audit/audit.service";
import {
  HANDOVER_P0_CAPABILITY_ERROR_CODE,
  HandoverWorkOrderService
} from "../src/handover-work-order/handover-work-order.service";
import {
  SUBSCRIPTION_CLOSURE_ERROR_CODE,
  SubscriptionClosureRepository,
  type AppendSubscriptionClosureDocumentCommand,
  type AppendSubscriptionClosureSettlementCommand,
  type CreateSubscriptionClosureCaseCommand,
  type SubscriptionClosureMutationAuditHook
} from "../src/subscription-closure/subscription-closure.repository";
import { hashSubscriptionClosureSnapshot } from "../src/subscription-closure/subscription-closure.domain";

const DATABASE_URL = requiredTestDatabaseUrl();
const NOW = new Date("2026-08-21T03:00:00.000Z");
const HASH = "a".repeat(64);

describe("SubscriptionClosureRepository PostgreSQL behavior", () => {
  let prisma: PrismaService;
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL }));
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    try {
      for (const fixture of fixtures.reverse()) await deleteFixture(prisma, fixture);
      await expect(expectFixtureResidue(prisma, fixtures)).resolves.toBe(0);
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  async function fixture() {
    const created = await createFixture(prisma);
    fixtures.push(created);
    return created;
  }

  it("binds RETURN_INBOUND capabilities to one service, transaction, payload, and use, then exactly replays", async () => {
    const data = await fixture();
    await removeSeededHandover(prisma, data);
    const service = returnInboundService(prisma);
    const foreignService = returnInboundService(prisma);
    const command = returnInboundCommand(data, "capability-guards");
    const wrongTransactionCapability = await readCommitted(prisma, (tx) =>
      service.prepareReturnInboundInTransaction(tx, command)
    );

    await expectCode(
      readCommitted(prisma, (tx) =>
        service.createReturnInboundInTransaction(tx, command, wrongTransactionCapability)
      ),
      HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID
    );
    const created = await readCommitted(prisma, async (tx) => {
      const capability = await service.prepareReturnInboundInTransaction(tx, command);
      await expectCode(
        foreignService.createReturnInboundInTransaction(tx, command, capability),
        HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID
      );
      await expectCode(
        service.createReturnInboundInTransaction(tx, command, Object.freeze({}) as never),
        HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID
      );
      const result = await service.createReturnInboundInTransaction(tx, command, capability);
      await expectCode(
        service.createReturnInboundInTransaction(tx, command, capability),
        HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID
      );
      return result;
    });
    data.handoverWorkOrderId = created.id;
    const replay = await readCommitted(prisma, async (tx) => {
      const capability = await service.prepareReturnInboundInTransaction(tx, command);
      return service.createReturnInboundInTransaction(tx, command, capability);
    });

    expect(replay.id).toBe(created.id);
    await expect(
      prisma.vehicleHandoverWorkOrder.count({
        where: { handoverType: "RETURN_INBOUND", orderId: data.orderId }
      })
    ).resolves.toBe(1);
    await expect(
      prisma.vehicleHandoverEvent.count({ where: { workOrderId: created.id } })
    ).resolves.toBe(1);
  });

  it("owns a specialist source globally across order and actor payload drift", async () => {
    const firstData = await fixture();
    const secondData = await fixture();
    await removeSeededHandover(prisma, firstData);
    await removeSeededHandover(prisma, secondData);
    const service = returnInboundService(prisma);
    const command = returnInboundCommand(firstData, "global-source-ownership");
    const created = await readCommitted(prisma, async (tx) => {
      const capability = await service.prepareReturnInboundInTransaction(tx, command);
      return service.createReturnInboundInTransaction(tx, command, capability);
    });
    firstData.handoverWorkOrderId = created.id;

    for (const drifted of [
      { ...command, orderId: secondData.orderId },
      { ...command, actorId: secondData.actorId }
    ]) {
      await expectCode(
        readCommitted(prisma, async (tx) => {
          const capability = await service.prepareReturnInboundInTransaction(tx, drifted);
          return service.createReturnInboundInTransaction(tx, drifted, capability);
        }),
        HANDOVER_P0_CAPABILITY_ERROR_CODE.SOURCE_CONFLICT
      );
    }

    const replay = await readCommitted(prisma, async (tx) => {
      const capability = await service.prepareReturnInboundInTransaction(tx, command);
      return service.createReturnInboundInTransaction(tx, command, capability);
    });
    expect(replay.id).toBe(created.id);
    await expect(
      prisma.vehicleHandoverWorkOrder.count({
        where: { orderId: { in: [firstData.orderId, secondData.orderId] } }
      })
    ).resolves.toBe(1);
    await expect(
      prisma.vehicleHandoverEvent.count({
        where: { orderId: { in: [firstData.orderId, secondData.orderId] } }
      })
    ).resolves.toBe(1);
  });

  it("fails closed on an empty required authority probe", async () => {
    const data = await fixture();
    const service = returnInboundService(prisma);
    const command = {
      ...returnInboundCommand(data, "empty-authority"),
      orderId: randomUUID()
    };

    await expectCode(
      readCommitted(prisma, async (tx) => {
        const capability = await service.prepareReturnInboundInTransaction(tx, command);
        return service.createReturnInboundInTransaction(tx, command, capability);
      }),
      HANDOVER_P0_CAPABILITY_ERROR_CODE.AUTHORITY_NOT_FOUND
    );
  });

  it("fast-fails RETURN_INBOUND authority contention while the holder remains usable", async () => {
    const data = await fixture();
    await removeSeededHandover(prisma, data);
    const service = returnInboundService(prisma);
    const holderCreated = deferred<void>();
    const probeHolder = deferred<void>();
    const holderUsable = deferred<void>();
    const releaseHolder = deferred<void>();
    const holderCommand = returnInboundCommand(data, "contention-holder");
    const holder = readCommitted(prisma, async (tx) => {
      const capability = await service.prepareReturnInboundInTransaction(tx, holderCommand);
      const result = await service.createReturnInboundInTransaction(tx, holderCommand, capability);
      holderCreated.resolve();
      await probeHolder.promise;
      await tx.$queryRaw(Prisma.sql`SELECT 1 AS "usable"`);
      holderUsable.resolve();
      await releaseHolder.promise;
      return result;
    });
    void holder.catch(holderCreated.reject);
    await holderCreated.promise;

    const contenderCommand = returnInboundCommand(data, "contention-contender");
    await expectCode(
      readCommitted(prisma, async (tx) => {
        const capability = await service.prepareReturnInboundInTransaction(tx, contenderCommand);
        return service.createReturnInboundInTransaction(tx, contenderCommand, capability);
      }),
      HANDOVER_P0_CAPABILITY_ERROR_CODE.AUTHORITY_BUSY
    );
    probeHolder.resolve();
    await holderUsable.promise;
    releaseHolder.resolve();
    const created = await holder;
    data.handoverWorkOrderId = created.id;
  });

  it.each([
    "after-specialist",
    "after-common-work-order",
    "case-audit",
    "document-audit",
    "after-first-document"
  ] as const)(
    "atomically rolls back the expiry-style cross-domain write set at %s",
    async (failpoint) => {
      const data = await fixture();
      await removeSeededHandover(prisma, data);
      const handoverService = returnInboundService(prisma);
      const auditService = new AuditService(prisma);
      const operationsService = new AssetOperationsService(
        prisma,
        new AssetOperationsRepository(),
        auditService
      );
      const closureRepository = new SubscriptionClosureRepository();
      const handoverCommand = returnInboundCommand(data, `atomic:${failpoint}:handover`);
      const workOrderCommand = commonReturnWorkOrderCommand(
        data,
        `atomic:${failpoint}:asset-work-order`
      );
      const caseSource = source(`atomic:${failpoint}:case`);
      const documentSource = source(`atomic:${failpoint}:document`);

      await expect(
        readCommitted(prisma, async (tx) => {
          const handoverCapability = await handoverService.prepareReturnInboundInTransaction(
            tx,
            handoverCommand
          );
          const workOrderCapability = await operationsService.prepareCallerOwnedTransaction(
            tx,
            workOrderCommand.source
          );
          await closureRepository.lockSourceOwnership(tx, caseSource);
          await closureRepository.lockSourceOwnership(tx, documentSource);
          await closureRepository.lockAuthorityRows(tx, [
            { id: data.orderId, mode: "UPDATE", table: "subscription_order" },
            { id: data.vehicleId, mode: "SHARE", table: "vehicle" },
            { id: data.contractId, mode: "SHARE", table: "contract" },
            { id: data.vehicleReturnId, mode: "SHARE", table: "vehicle_return" },
            { id: data.customerId, mode: "SHARE", table: "customer" },
            { id: data.actorId, mode: "SHARE", table: "user" }
          ]);

          const specialist = await handoverService.createReturnInboundInTransaction(
            tx,
            handoverCommand,
            handoverCapability
          );
          if (failpoint === "after-specialist") throw new Error(failpoint);
          const common = await operationsService.createWorkOrderInTransaction(
            tx,
            workOrderCommand,
            assetOperationContext(data.actorId),
            workOrderCapability
          );
          if (failpoint === "after-common-work-order") throw new Error(failpoint);

          data.handoverWorkOrderId = specialist.id;
          data.assetWorkOrderIds.push(common.workOrder.id);
          const createdCase = await closureRepository.createCase(
            tx,
            {
              ...createCaseCommand(data, `atomic:${failpoint}:case`),
              returnAssetWorkOrderId: common.workOrder.id,
              returnHandoverWorkOrderId: specialist.id,
              source: caseSource
            },
            closureAudit(auditService, data.actorId, failpoint, "case-audit")
          );
          const firstDocument = {
            ...documentCommand(data, createdCase.outcome.id, {
              documentType: "RETURN_MANIFEST",
              expectedVersion: 0,
              key: `atomic:${failpoint}:document`
            }),
            source: documentSource
          };
          await bindReturnManifestESign(tx, firstDocument);
          await closureRepository.appendDocumentRevision(
            tx,
            firstDocument,
            closureAudit(auditService, data.actorId, failpoint, "document-audit")
          );
          if (failpoint === "after-first-document") throw new Error(failpoint);
        })
      ).rejects.toThrow(failpoint);
      await expect(atomicResidue(prisma, data)).resolves.toEqual({
        assetEvents: 0,
        assetWorkOrders: 0,
        audits: 0,
        closureCases: 0,
        closureDocuments: 0,
        closureEvents: 0,
        closureReceipts: 0,
        handoverEvents: 0,
        handoverWorkOrders: 0
      });
    }
  );

  it("creates, loads, lists, and exactly replays a canonical case outcome", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const command = createCaseCommand(data, "create-replay");

    const first = await readCommitted(prisma, (tx) => repository.createCase(tx, command));
    const replay = await readCommitted(prisma, (tx) => repository.createCase(tx, command));
    const loaded = await readCommitted(prisma, (tx) => repository.getCase(tx, first.outcome.id));
    const listed = await readCommitted(prisma, (tx) =>
      repository.listCases(tx, { orderId: data.orderId })
    );

    expect(first.wrote).toBe(true);
    expect(replay).toEqual({ outcome: first.outcome, wrote: false });
    expect(loaded).toEqual(first.outcome);
    expect(listed).toEqual([first.outcome]);
    expect(first.outcome.currentDocuments).toEqual({});
    expect(first.outcome.currentSettlement).toBeNull();
    expect(first.outcome).not.toHaveProperty("currentDocumentRevisionId");
    expect(Object.isFrozen(replay.outcome)).toBe(true);
    expect(Object.isFrozen(replay.outcome.authoritySnapshot)).toBe(true);
    expect(JSON.stringify(replay.outcome)).not.toMatch(/\d+n|BigInt/);
    await expect(countCaseFacts(prisma, data.orderId)).resolves.toEqual({
      cases: 1,
      events: 1,
      receipts: 1
    });
  });

  it("derives collision-safe case numbers from the complete canonical source tuple", async () => {
    const firstData = await fixture();
    const secondData = await fixture();
    const thirdData = await fixture();
    const repository = new SubscriptionClosureRepository();
    const sharedSourceId = randomUUID();
    const firstCommand = {
      ...createCaseCommand(firstData, "tuple-a"),
      source: { id: sharedSourceId, key: "p0:tuple-a", type: "P0_TUPLE_A" }
    };
    const secondCommand = {
      ...createCaseCommand(secondData, "tuple-b"),
      source: { id: sharedSourceId, key: "p0:tuple-b", type: "P0_TUPLE_A" }
    };
    const thirdCommand = {
      ...createCaseCommand(thirdData, "tuple-c"),
      source: { id: sharedSourceId, key: "p0:tuple-a", type: "P0_TUPLE_B" }
    };

    const first = await readCommitted(prisma, (tx) => repository.createCase(tx, firstCommand));
    const second = await readCommitted(prisma, (tx) => repository.createCase(tx, secondCommand));
    const third = await readCommitted(prisma, (tx) => repository.createCase(tx, thirdCommand));
    const replay = await readCommitted(prisma, (tx) => repository.createCase(tx, firstCommand));

    expect(new Set([first.outcome.caseNo, second.outcome.caseNo, third.outcome.caseNo]).size).toBe(
      3
    );
    expect(replay).toEqual({ outcome: first.outcome, wrote: false });
  });

  it("rejects same-source payload drift and cross-command ownership", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const command = createCaseCommand(data, "source-conflict");
    const created = await readCommitted(prisma, (tx) => repository.createCase(tx, command));

    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.createCase(tx, {
          ...command,
          authoritySnapshot: { ...command.authoritySnapshot, drift: true }
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.SOURCE_CONFLICT
    );
    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.appendEvent(tx, {
          actorId: data.actorId,
          afterStatus: "PREPARING_RETURN",
          closureCaseId: created.outcome.id,
          detailSnapshot: { note: "cross-command" },
          eventType: "NOTE_ADDED",
          expectedStatus: "PREPARING_RETURN",
          expectedVersion: 0,
          occurredAt: NOW,
          source: command.source
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.SOURCE_CONFLICT
    );
    await expect(countCaseFacts(prisma, data.orderId)).resolves.toEqual({
      cases: 1,
      events: 1,
      receipts: 1
    });
  });

  it("rejects a fully existing but incoherent authority tuple", async () => {
    const governed = await fixture();
    const unrelated = await fixture();
    const repository = new SubscriptionClosureRepository();

    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.createCase(tx, {
          ...createCaseCommand(governed, "wrong-authority"),
          customerId: unrelated.customerId
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH
    );
    await expect(countCaseFacts(prisma, governed.orderId)).resolves.toEqual({
      cases: 0,
      events: 0,
      receipts: 0
    });
  });

  it("rejects wrong typed work-order roles and recovery links on a voluntary profile", async () => {
    const wrongRoleData = await fixture();
    const wrongProfileData = await fixture();
    const repository = new SubscriptionClosureRepository();
    const recoveryInReturnRole = await createFixtureWorkOrder(prisma, wrongRoleData, "RECOVERY");
    const recoveryOnVoluntary = await createFixtureWorkOrder(prisma, wrongProfileData, "RECOVERY");

    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.createCase(tx, {
          ...createCaseCommand(wrongRoleData, "wrong-return-work-order-type"),
          returnAssetWorkOrderId: recoveryInReturnRole
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH
    );
    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.createCase(tx, {
          ...createCaseCommand(wrongProfileData, "recovery-link-voluntary-profile"),
          recoveryAssetWorkOrderId: recoveryOnVoluntary
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_MISMATCH
    );
  });

  it("persists governed transitions and the sole approved normal-to-recovery escalation", async () => {
    const earlyData = await fixture();
    const normalData = await fixture();
    const repository = new SubscriptionClosureRepository();
    const early = await readCommitted(prisma, (tx) =>
      repository.createCase(
        tx,
        createCaseCommand(earlyData, "early-transition", "EARLY_TERMINATION")
      )
    );
    const transitioned = await readCommitted(prisma, async (tx) =>
      repository.appendEvent(tx, {
        actorId: earlyData.actorId,
        afterStatus: "RETURN_INSPECTION",
        closureCaseId: early.outcome.id,
        detailSnapshot: { reason: "vehicle arrived" },
        eventType: "STATUS_TRANSITIONED",
        expectedStatus: "PREPARING_RETURN",
        expectedVersion: 0,
        occurredAt: await databaseNow(tx),
        source: source("early-transition-event")
      })
    );
    const normal = await readCommitted(prisma, (tx) =>
      repository.createCase(tx, createCaseCommand(normalData, "normal-escalation"))
    );
    const escalated = await readCommitted(prisma, async (tx) =>
      repository.escalateRecovery(tx, {
        actorId: normalData.actorId,
        closureCaseId: normal.outcome.id,
        detailSnapshot: { authority: "approved recovery escalation" },
        expectedStatus: "PREPARING_RETURN",
        expectedVersion: 0,
        occurredAt: await databaseNow(tx),
        source: source("normal-escalation-event")
      })
    );

    expect(transitioned.outcome).toMatchObject({
      case: { status: "RETURN_INSPECTION", version: 1 },
      event: {
        afterStatus: "RETURN_INSPECTION",
        beforeStatus: "PREPARING_RETURN",
        eventType: "STATUS_TRANSITIONED",
        sequence: 2
      }
    });
    expect(escalated.outcome).toMatchObject({
      case: {
        closureType: "NORMAL_COMPLETION",
        finalDisposition: "TERMINATE",
        physicalControlMode: "RECOVERY",
        status: "RECOVERY_ASSESSMENT_PENDING",
        version: 1
      },
      event: { eventType: "RECOVERY_ESCALATED", sequence: 2 }
    });
    await expectCode(
      readCommitted(prisma, async (tx) =>
        repository.escalateRecovery(tx, {
          actorId: earlyData.actorId,
          closureCaseId: early.outcome.id,
          detailSnapshot: { forbidden: true },
          expectedStatus: "RETURN_INSPECTION",
          expectedVersion: 1,
          occurredAt: await databaseNow(tx),
          source: source("early-forbidden-escalation")
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT
    );
  });

  it("rejects pre-return and recovery-stage jumps from a history-free PAUSED row", async () => {
    const normalData = await fixture();
    const recoveryData = await fixture();
    const repository = new SubscriptionClosureRepository();
    const normal = await readCommitted(prisma, (tx) =>
      repository.createCase(tx, createCaseCommand(normalData, "paused-normal"))
    );
    const recovery = await readCommitted(prisma, (tx) =>
      repository.createCase(tx, {
        ...createCaseCommand(recoveryData, "paused-recovery", "EARLY_TERMINATION"),
        physicalControlMode: "RECOVERY"
      })
    );
    await readCommitted(prisma, async (tx) => {
      await tx.subscriptionClosureCase.updateMany({
        data: { status: "PAUSED", version: { increment: 1 } },
        where: { id: { in: [normal.outcome.id, recovery.outcome.id] } }
      });
    });

    await expectCode(
      readCommitted(prisma, async (tx) =>
        repository.appendEvent(tx, {
          actorId: normalData.actorId,
          afterStatus: "PENDING_SETTLEMENT",
          closureCaseId: normal.outcome.id,
          detailSnapshot: { forbidden: "pre-return-to-settlement" },
          eventType: "STATUS_TRANSITIONED",
          expectedStatus: "PAUSED",
          expectedVersion: 1,
          occurredAt: await databaseNow(tx),
          source: source("paused-normal-settlement")
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT
    );
    for (const target of [
      "RECOVERY_APPROVAL_PENDING",
      "RECOVERY_IN_PROGRESS",
      "VEHICLE_SECURED",
      "PENDING_SETTLEMENT"
    ] as const) {
      await expectCode(
        readCommitted(prisma, async (tx) =>
          repository.appendEvent(tx, {
            actorId: recoveryData.actorId,
            afterStatus: target,
            closureCaseId: recovery.outcome.id,
            detailSnapshot: { forbidden: `assessment-pause-to-${target}` },
            eventType: "STATUS_TRANSITIONED",
            expectedStatus: "PAUSED",
            expectedVersion: 1,
            occurredAt: await databaseNow(tx),
            source: source(`paused-recovery-${target}`)
          })
        ),
        SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT
      );
    }
  });

  it("rejects recovery escalation from paused, manual, controlled, and closed source states", async () => {
    const repository = new SubscriptionClosureRepository();
    for (const status of ["PAUSED", "MANUAL_TAKEOVER", "RETURN_INSPECTION", "CANCELLED"] as const) {
      const data = await fixture();
      const created = await readCommitted(prisma, (tx) =>
        repository.createCase(tx, createCaseCommand(data, `escalation-source-${status}`))
      );
      if (status === "PAUSED") {
        await readCommitted(prisma, async (tx) => {
          await tx.subscriptionClosureCase.update({
            data: { status, version: { increment: 1 } },
            where: { id: created.outcome.id }
          });
        });
      } else {
        await readCommitted(prisma, async (tx) =>
          repository.appendEvent(tx, {
            actorId: data.actorId,
            afterStatus: status,
            closureCaseId: created.outcome.id,
            detailSnapshot: { status },
            eventType: "STATUS_TRANSITIONED",
            expectedStatus: "PREPARING_RETURN",
            expectedVersion: 0,
            occurredAt: await databaseNow(tx),
            source: source(`escalation-source-transition-${status}`)
          })
        );
      }
      await expectCode(
        readCommitted(prisma, async (tx) =>
          repository.escalateRecovery(tx, {
            actorId: data.actorId,
            closureCaseId: created.outcome.id,
            detailSnapshot: { forbiddenSourceStatus: status },
            expectedStatus: status,
            expectedVersion: 1,
            occurredAt: await databaseNow(tx),
            source: source(`escalation-source-command-${status}`)
          })
        ),
        SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT
      );
      await expect(
        prisma.subscriptionClosureCase.findUniqueOrThrow({
          select: { physicalControlMode: true, status: true, version: true },
          where: { id: created.outcome.id }
        })
      ).resolves.toMatchObject({
        physicalControlMode: "VOLUNTARY_RETURN",
        status,
        version: 1
      });
      await expect(countCaseFacts(prisma, data.orderId)).resolves.toEqual({
        cases: 1,
        events: status === "PAUSED" ? 1 : 2,
        receipts: status === "PAUSED" ? 1 : 2
      });
    }
  });

  it("rejects backdated and future event times against database history and clock", async () => {
    const backdatedData = await fixture();
    const futureData = await fixture();
    const futureCreateData = await fixture();
    const repository = new SubscriptionClosureRepository();
    const backdated = await readCommitted(prisma, (tx) =>
      repository.createCase(tx, createCaseCommand(backdatedData, "event-time-backdated"))
    );
    const future = await readCommitted(prisma, (tx) =>
      repository.createCase(tx, createCaseCommand(futureData, "event-time-future"))
    );

    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.appendEvent(tx, {
          actorId: backdatedData.actorId,
          afterStatus: "PREPARING_RETURN",
          closureCaseId: backdated.outcome.id,
          detailSnapshot: { invalid: "before latest event" },
          eventType: "NOTE_ADDED",
          expectedStatus: "PREPARING_RETURN",
          expectedVersion: 0,
          occurredAt: new Date(NOW.getTime() - 1),
          source: source("event-time-backdated-note")
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND
    );
    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.appendEvent(tx, {
          actorId: futureData.actorId,
          afterStatus: "PREPARING_RETURN",
          closureCaseId: future.outcome.id,
          detailSnapshot: { invalid: "after database clock" },
          eventType: "NOTE_ADDED",
          expectedStatus: "PREPARING_RETURN",
          expectedVersion: 0,
          occurredAt: new Date("2099-01-01T00:00:00.000Z"),
          source: source("event-time-future-note")
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND
    );
    const futureEffectiveAt = new Date("2099-01-01T00:00:00.000Z");
    const futureEffective = await readCommitted(prisma, (tx) =>
      repository.createCase(tx, {
        ...createCaseCommand(futureCreateData, "event-time-future-create", "EARLY_TERMINATION"),
        effectiveAt: futureEffectiveAt
      })
    );
    const createEvent = await prisma.subscriptionClosureEvent.findFirstOrThrow({
      where: { closureCaseId: futureEffective.outcome.id, eventType: "CASE_CREATED" }
    });
    expect(futureEffective.outcome.effectiveAt).toBe(futureEffectiveAt.toISOString());
    expect(createEvent.occurredAt.getTime()).toBeLessThan(futureEffectiveAt.getTime());
  });

  it("keeps document business times while database event occurrences advance monotonically", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const generatedAt = new Date("2025-01-01T00:00:00.000Z");
    const signedAt = new Date("2026-01-01T00:00:00.000Z");
    const archivedAt = new Date("2026-08-01T00:00:00.000Z");
    const created = await readCommitted(prisma, (tx) =>
      repository.createCase(
        tx,
        createCaseCommand(data, "document-business-times", "EARLY_TERMINATION")
      )
    );
    const generated = await readCommitted(prisma, (tx) =>
      repository.appendDocumentRevision(tx, {
        ...documentCommand(data, created.outcome.id, {
          documentType: "EARLY_TERMINATION_AGREEMENT",
          expectedVersion: 0,
          key: "document-business-times-r1"
        }),
        generatedAt
      })
    );
    const signed = await readCommitted(prisma, (tx) =>
      repository.appendDocumentRevision(tx, {
        ...documentCommand(data, created.outcome.id, {
          documentType: "EARLY_TERMINATION_AGREEMENT",
          expectedVersion: 1,
          key: "document-business-times-r2"
        }),
        expectedCurrentRevisionId: generated.outcome.id,
        generatedAt,
        signedAt,
        signedBy: data.actorId,
        signedFileHash: HASH,
        signedFileId: data.signedFileId,
        stage: "SIGNED"
      })
    );
    const archived = await readCommitted(prisma, (tx) =>
      repository.appendDocumentRevision(tx, {
        ...documentCommand(data, created.outcome.id, {
          documentType: "EARLY_TERMINATION_AGREEMENT",
          expectedVersion: 2,
          key: "document-business-times-r3"
        }),
        archivedAt,
        archivedBy: data.actorId,
        expectedCurrentRevisionId: signed.outcome.id,
        generatedAt,
        signedAt,
        signedBy: data.actorId,
        signedFileHash: HASH,
        signedFileId: data.signedFileId,
        stage: "ARCHIVED"
      })
    );
    const events = await prisma.subscriptionClosureEvent.findMany({
      orderBy: { sequence: "asc" },
      where: { closureCaseId: created.outcome.id }
    });

    expect(signed.outcome).toMatchObject({
      generatedAt: generatedAt.toISOString(),
      signedAt: signedAt.toISOString()
    });
    expect(archived.outcome).toMatchObject({
      archivedAt: archivedAt.toISOString(),
      generatedAt: generatedAt.toISOString(),
      signedAt: signedAt.toISOString()
    });
    expect(events).toHaveLength(4);
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.occurredAt.getTime()).toBeGreaterThanOrEqual(
        events[index - 1]!.occurredAt.getTime()
      );
    }
    expect(events[1]!.occurredAt.getTime()).toBeGreaterThan(generatedAt.getTime());
  });

  it("preflights the current FINAL/SETTLED authority before either terminal transition", async () => {
    const repository = new SubscriptionClosureRepository();
    for (const closureType of ["NORMAL_COMPLETION", "EARLY_TERMINATION"] as const) {
      const data = await fixture();
      const created = await readCommitted(prisma, (tx) =>
        repository.createCase(
          tx,
          createCaseCommand(data, `terminal-preflight-${closureType}`, closureType)
        )
      );
      await readCommitted(prisma, async (tx) => {
        await tx.subscriptionClosureCase.update({
          data: {
            physicalControlledAt: NOW,
            status: "PENDING_SETTLEMENT",
            version: { increment: 1 }
          },
          where: { id: created.outcome.id }
        });
      });
      await expectCode(
        readCommitted(prisma, async (tx) =>
          repository.appendEvent(tx, {
            actorId: data.actorId,
            afterStatus: closureType === "NORMAL_COMPLETION" ? "COMPLETED" : "TERMINATED",
            closureCaseId: created.outcome.id,
            detailSnapshot: { invalid: "missing settled final authority" },
            eventType: "STATUS_TRANSITIONED",
            expectedStatus: "PENDING_SETTLEMENT",
            expectedVersion: 1,
            occurredAt: await databaseNow(tx),
            source: source(`terminal-preflight-event-${closureType}`)
          })
        ),
        SUBSCRIPTION_CLOSURE_ERROR_CODE.CURRENT_SETTLEMENT_CONFLICT
      );
    }
  });

  it("rolls back case, event, audit callback, and receipt together", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const command = createCaseCommand(data, "audit-rollback");

    await expect(
      readCommitted(prisma, (tx) =>
        repository.createCase(tx, command, async (sameTx, mutation) => {
          await sameTx.auditLog.create({
            data: {
              action: "CREATE",
              afterSnapshot: mutation.outcome,
              entityId: mutation.closureCaseId,
              entityType: "SubscriptionClosureCase",
              module: "subscription-closure",
              operatorId: data.actorId
            }
          });
          throw new Error("injected audit failure");
        })
      )
    ).rejects.toThrow("injected audit failure");

    await expect(countCaseFacts(prisma, data.orderId)).resolves.toEqual({
      cases: 0,
      events: 0,
      receipts: 0
    });
    await expect(
      prisma.auditLog.count({
        where: { entityType: "SubscriptionClosureCase", operatorId: data.actorId }
      })
    ).resolves.toBe(0);
  });

  it("has one winner for different-source same-order creation and leaves the holder usable", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const holderEntered = deferred<void>();
    const releaseHolder = deferred<void>();
    let holderUsable = false;
    const holder = readCommitted(prisma, (tx) =>
      repository.createCase(tx, createCaseCommand(data, "one-winner-holder"), async (sameTx) => {
        holderEntered.resolve();
        await releaseHolder.promise;
        holderUsable =
          (await sameTx.subscriptionOrder.count({ where: { id: data.orderId } })) === 1;
      })
    );
    void holder.catch(holderEntered.reject);
    await holderEntered.promise;

    const contender = settled(
      readCommitted(prisma, (tx) =>
        repository.createCase(tx, createCaseCommand(data, "one-winner-contender"))
      )
    );
    const early = await settlesWithin(contender, 1_000);
    try {
      expect(early.finished).toBe(true);
      if (!early.finished) throw new Error("Expected NOWAIT contender result");
      expectConflict(rejectedValue(early.value), SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_BUSY);
    } finally {
      releaseHolder.resolve();
    }
    await holder;
    expect(holderUsable).toBe(true);
    await expect(countCaseFacts(prisma, data.orderId)).resolves.toEqual({
      cases: 1,
      events: 1,
      receipts: 1
    });
  });

  it("fails a NOWAIT authority probe closed while the matching insert is uncommitted", async () => {
    const repository = new SubscriptionClosureRepository();
    const inserted = deferred<void>();
    const releaseInsert = deferred<void>();
    const uncommittedUserId = randomUUID();
    const username = `P0-PROBE-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const holder = settled(
      readCommitted(prisma, async (tx) => {
        await tx.user.create({
          data: {
            name: "P0 concurrent authority probe",
            passwordHash: "not-used",
            status: "ACTIVE",
            username,
            id: uncommittedUserId
          }
        });
        inserted.resolve();
        await releaseInsert.promise;
        throw new Error("rollback concurrent authority fixture");
      })
    );
    await inserted.promise;

    try {
      const probe = settled(
        readCommitted(prisma, (tx) =>
          repository.lockAuthorityRows(tx, [
            { id: uncommittedUserId, mode: "SHARE", table: "user" }
          ])
        )
      );
      const early = await settlesWithin(probe, 1_000);
      expect(early.finished).toBe(true);
      if (!early.finished) throw new Error("Expected empty authority probe to fail closed");
      expectConflict(
        rejectedValue(early.value),
        SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_NOT_FOUND
      );
    } finally {
      releaseInsert.resolve();
    }
    await holder;
    await expect(prisma.user.count({ where: { id: uncommittedUserId } })).resolves.toBe(0);
  });

  it("fails document return/handover contention fast without a cycle and keeps each holder usable", async () => {
    const repository = new SubscriptionClosureRepository();
    for (const authority of ["vehicle_return", "vehicle_handover_work_order"] as const) {
      const data = await fixture();
      const created = await readCommitted(prisma, (tx) =>
        repository.createCase(tx, createCaseCommand(data, `document-contention-${authority}`))
      );
      const holderEntered = deferred<void>();
      const releaseHolder = deferred<void>();
      let holderUsable = false;
      const authorityId =
        authority === "vehicle_return" ? data.vehicleReturnId : data.handoverWorkOrderId;
      const holder = readCommitted(prisma, async (tx) => {
        await repository.lockAuthorityRows(tx, [
          { id: authorityId, mode: "UPDATE", table: authority }
        ]);
        holderEntered.resolve();
        await releaseHolder.promise;
        holderUsable = (await tx.subscriptionOrder.count({ where: { id: data.orderId } })) === 1;
      });
      void holder.catch(holderEntered.reject);
      await holderEntered.promise;

      const contender = settled(
        readCommitted(prisma, (tx) =>
          repository.appendDocumentRevision(
            tx,
            documentCommand(data, created.outcome.id, {
              documentType: "RETURN_MANIFEST",
              expectedVersion: 0,
              key: `contended-${authority}`
            })
          )
        )
      );
      const early = await settlesWithin(contender, 1_000);
      try {
        expect(early.finished).toBe(true);
        if (!early.finished) throw new Error("Expected document authority NOWAIT result");
        expectConflict(rejectedValue(early.value), SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_BUSY);
      } finally {
        releaseHolder.resolve();
      }
      await holder;
      expect(holderUsable).toBe(true);
      await expect(
        prisma.subscriptionClosureDocumentRevision.count({
          where: { closureCaseId: created.outcome.id }
        })
      ).resolves.toBe(0);
    }
  });

  it("fails a reverse high-rank document holder race fast without a cycle and keeps the holder usable", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const created = await readCommitted(prisma, (tx) =>
      repository.createCase(
        tx,
        createCaseCommand(data, "document-reverse-holder", "EARLY_TERMINATION")
      )
    );
    const first = await readCommitted(prisma, (tx) =>
      repository.appendDocumentRevision(
        tx,
        documentCommand(data, created.outcome.id, {
          documentType: "EARLY_TERMINATION_AGREEMENT",
          expectedVersion: 0,
          key: "document-reverse-holder-r1"
        })
      )
    );
    const holderEntered = deferred<void>();
    const raceStarted = deferred<void>();
    const projectionHeld = deferred<void>();
    const releaseHolder = deferred<void>();
    let holderUsable = false;
    const holder = readCommitted(prisma, async (tx) => {
      await repository.lockAuthorityRows(tx, [
        { id: data.sourceFileId, mode: "UPDATE", table: "file_object" }
      ]);
      holderEntered.resolve();
      await raceStarted.promise;
      await tx.$queryRaw(Prisma.sql`
        SELECT "document_revision_id"
        FROM "subscription_closure_current_document"
        WHERE "closure_case_id" = ${created.outcome.id}::uuid
          AND "document_type" = 'EARLY_TERMINATION_AGREEMENT'::"subscription_closure_document_type"
        FOR UPDATE
      `);
      projectionHeld.resolve();
      await releaseHolder.promise;
      holderUsable =
        (await tx.subscriptionClosureDocumentRevision.count({
          where: { closureCaseId: created.outcome.id }
        })) === 1;
    });
    void holder.catch((error) => {
      holderEntered.reject(error);
      projectionHeld.reject(error);
    });
    await holderEntered.promise;

    const contender = settled(
      readCommitted(prisma, (tx) =>
        repository.appendDocumentRevision(tx, {
          ...documentCommand(data, created.outcome.id, {
            documentType: "EARLY_TERMINATION_AGREEMENT",
            expectedVersion: 1,
            key: "document-reverse-holder-r2"
          }),
          expectedCurrentRevisionId: first.outcome.id
        })
      )
    );
    raceStarted.resolve();
    const early = await settlesWithin(contender, 1_000);
    try {
      expect(early.finished).toBe(true);
      if (!early.finished) throw new Error("Expected reverse document race to fail fast");
      expectConflict(rejectedValue(early.value), SUBSCRIPTION_CLOSURE_ERROR_CODE.AUTHORITY_BUSY);
      await projectionHeld.promise;
    } finally {
      releaseHolder.resolve();
    }
    await holder;
    expect(holderUsable).toBe(true);
    await expect(
      prisma.subscriptionClosureDocumentRevision.count({
        where: { closureCaseId: created.outcome.id }
      })
    ).resolves.toBe(1);
  });

  it("keeps independent current document families and advances only the successor family", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const created = await readCommitted(prisma, (tx) =>
      repository.createCase(tx, createCaseCommand(data, "documents", "EARLY_TERMINATION"))
    );
    const agreement = documentCommand(data, created.outcome.id, {
      documentType: "EARLY_TERMINATION_AGREEMENT",
      expectedVersion: 0,
      key: "agreement-r1"
    });
    const agreementR1 = await readCommitted(prisma, (tx) =>
      repository.appendDocumentRevision(tx, agreement)
    );
    const agreementReplay = await readCommitted(prisma, (tx) =>
      repository.appendDocumentRevision(tx, agreement)
    );
    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.appendDocumentRevision(tx, {
          ...agreement,
          documentSnapshot: { drift: true }
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.SOURCE_CONFLICT
    );
    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.appendSettlementRevision(tx, {
          ...settlementCommand(data, created.outcome.id, {
            expectedVersion: 1,
            key: "document-cross-command",
            stage: "PROPOSED"
          }),
          source: agreement.source
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.SOURCE_CONFLICT
    );
    const manifestCommand = documentCommand(data, created.outcome.id, {
      documentType: "RETURN_MANIFEST",
      expectedVersion: 1,
      key: "manifest-r1"
    });
    await readCommitted(prisma, (tx) => bindReturnManifestESign(tx, manifestCommand));
    const manifestR1 = await readCommitted(prisma, (tx) =>
      repository.appendDocumentRevision(tx, manifestCommand)
    );
    const agreementR2 = await readCommitted(prisma, (tx) =>
      repository.appendDocumentRevision(tx, {
        ...agreement,
        expectedCurrentRevisionId: agreementR1.outcome.id,
        expectedVersion: 2,
        signedAt: NOW,
        signedBy: data.actorId,
        signedFileHash: HASH,
        signedFileId: data.signedFileId,
        source: source("agreement-r2"),
        stage: "SIGNED"
      })
    );
    const loaded = await readCommitted(prisma, (tx) => repository.getCase(tx, created.outcome.id));

    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.appendDocumentRevision(tx, {
          ...agreement,
          expectedCurrentRevisionId: agreementR1.outcome.id,
          expectedVersion: 3,
          source: source("agreement-stale-current")
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.CURRENT_DOCUMENT_CONFLICT
    );

    expect(agreementR1.outcome.revisionNumber).toBe(1);
    expect(agreementReplay).toEqual({ outcome: agreementR1.outcome, wrote: false });
    expect(manifestR1.outcome.revisionNumber).toBe(1);
    expect(agreementR2.outcome).toMatchObject({
      revisionNumber: 2,
      supersedesRevisionId: agreementR1.outcome.id
    });
    expect(loaded?.currentDocuments).toMatchObject({
      EARLY_TERMINATION_AGREEMENT: { id: agreementR2.outcome.id },
      RETURN_MANIFEST: { id: manifestR1.outcome.id }
    });
    expect(loaded).not.toHaveProperty("currentDocumentRevisionId");
    const storedCase = await prisma.subscriptionClosureCase.findUnique({
      where: { id: created.outcome.id }
    });
    expect(storedCase?.currentDocumentRevisionId).toBeNull();
  });

  it("appends immutable settlement successors and atomically advances the case pointer", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const created = await readCommitted(prisma, (tx) =>
      repository.createCase(tx, createCaseCommand(data, "settlements"))
    );
    const proposed = settlementCommand(data, created.outcome.id, {
      expectedVersion: 0,
      key: "settlement-r1",
      stage: "PROPOSED"
    });
    const first = await readCommitted(prisma, (tx) =>
      repository.appendSettlementRevision(tx, proposed)
    );
    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.appendSettlementRevision(tx, {
          ...proposed,
          expectedVersion: 1,
          source: source("settlement-stale-current")
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.CURRENT_SETTLEMENT_CONFLICT
    );
    const secondCommand: AppendSubscriptionClosureSettlementCommand = {
      ...proposed,
      expectedCurrentRevisionId: first.outcome.id,
      expectedVersion: 1,
      finalizedAt: NOW,
      finalizedBy: data.actorId,
      source: source("settlement-r2"),
      stage: "FINALIZED"
    };
    const second = await readCommitted(prisma, (tx) =>
      repository.appendSettlementRevision(tx, secondCommand)
    );
    const replay = await readCommitted(prisma, (tx) =>
      repository.appendSettlementRevision(tx, secondCommand)
    );
    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.appendSettlementRevision(tx, {
          ...secondCommand,
          resultSnapshot: { drift: true }
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.SOURCE_CONFLICT
    );
    const loaded = await readCommitted(prisma, (tx) => repository.getCase(tx, created.outcome.id));

    expect(first.outcome).toMatchObject({ revisionNumber: 1, supersedesRevisionId: null });
    expect(second.outcome).toMatchObject({
      revisionNumber: 2,
      supersedesRevisionId: first.outcome.id
    });
    expect(replay).toEqual({ outcome: second.outcome, wrote: false });
    expect(loaded?.currentSettlementRevisionId).toBe(second.outcome.id);
    expect(loaded?.currentSettlement).toEqual(second.outcome);
    await expect(
      prisma.subscriptionClosureSettlementRevision.count({
        where: { closureCaseId: created.outcome.id }
      })
    ).resolves.toBe(2);
  });
});

function createCaseCommand(
  fixture: Fixture,
  key: string,
  closureType: "NORMAL_COMPLETION" | "EARLY_TERMINATION" = "NORMAL_COMPLETION"
): CreateSubscriptionClosureCaseCommand {
  return {
    actorId: fixture.actorId,
    authoritySnapshot: { fixture: fixture.marker, intent: closureType },
    closureType,
    contractId: fixture.contractId,
    customerId: fixture.customerId,
    effectiveAt: NOW,
    finalDisposition: closureType === "NORMAL_COMPLETION" ? "COMPLETE" : "TERMINATE",
    physicalControlMode: "VOLUNTARY_RETURN",
    orderId: fixture.orderId,
    returnHandoverWorkOrderId: fixture.handoverWorkOrderId,
    source: source(key),
    vehicleId: fixture.vehicleId,
    vehicleReturnId: fixture.vehicleReturnId
  };
}

function documentCommand(
  fixture: Fixture,
  closureCaseId: string,
  input: {
    documentType: AppendSubscriptionClosureDocumentCommand["documentType"];
    expectedVersion: number;
    key: string;
  }
): AppendSubscriptionClosureDocumentCommand {
  const isManifest = input.documentType === "RETURN_MANIFEST";
  return {
    actorId: fixture.actorId,
    archivedAt: null,
    archivedBy: null,
    closureCaseId,
    contractESignTaskId: fixture.contractESignTaskId,
    documentSnapshot: { family: input.documentType, marker: fixture.marker },
    documentType: input.documentType,
    expectedCurrentRevisionId: null,
    expectedVersion: input.expectedVersion,
    generatedAt: NOW,
    handoverWorkOrderId: isManifest ? fixture.handoverWorkOrderId : null,
    signedAt: null,
    signedBy: null,
    signedFileHash: null,
    signedFileId: null,
    source: source(input.key),
    sourceFileHash: HASH,
    sourceFileId: fixture.sourceFileId,
    stage: "GENERATED",
    vehicleReturnId: isManifest ? fixture.vehicleReturnId : null
  };
}

async function bindReturnManifestESign(
  tx: Prisma.TransactionClient,
  command: AppendSubscriptionClosureDocumentCommand
) {
  const [baseTask, file] = await Promise.all([
    tx.contractESignTask.findUniqueOrThrow({ where: { id: command.contractESignTaskId } }),
    tx.fileObject.findUniqueOrThrow({ where: { id: command.sourceFileId } })
  ]);
  const taskId = randomUUID();
  (command as { contractESignTaskId: string }).contractESignTaskId = taskId;
  return tx.contractESignTask.create({
    data: {
      contractId: baseTask.contractId,
      customerId: baseTask.customerId,
      documentName: file.originalName,
      documentObjectKey: file.objectKey,
      documentType: "DELIVERY_HANDOVER",
      id: taskId,
      orderId: baseTask.orderId,
      provider: baseTask.provider,
      requestSnapshot: {
        closureCaseId: command.closureCaseId,
        documentSnapshotHash: hashSubscriptionClosureSnapshot(command.documentSnapshot),
        documentType: "RETURN_MANIFEST",
        returnManifestSource: command.source,
        revisionNumber: 1
      },
      signingStage: "STAGE2_DELIVERY_HANDOVER",
      sourceId: command.source.id,
      sourceKey: command.source.key,
      sourceType: command.source.type,
      taskNo: `P0-MANIFEST-${taskId}`,
      taskStatus: "CREATED"
    }
  });
}

function settlementCommand(
  fixture: Fixture,
  closureCaseId: string,
  input: {
    expectedVersion: number;
    key: string;
    stage: AppendSubscriptionClosureSettlementCommand["stage"];
  }
): AppendSubscriptionClosureSettlementCommand {
  return {
    actorId: fixture.actorId,
    amountDueCents: 0n,
    amountRefundableCents: 0n,
    billInputSnapshot: { bills: [] },
    closureCaseId,
    costTotalCents: 0n,
    depositAppliedCents: 0n,
    depositInputSnapshot: { disposition: "PENDING" },
    depositRefundCents: 0n,
    expectedCurrentRevisionId: null,
    expectedVersion: input.expectedVersion,
    finalizedAt: null,
    finalizedBy: null,
    ledgerInputSnapshot: { entries: [] },
    paidTotalCents: 0n,
    receivableTotalCents: 0n,
    responsibilitySnapshot: { parties: [] },
    resultSnapshot: { balanced: true },
    settledAt: null,
    settledBy: null,
    settlementType: "FINAL",
    source: source(input.key),
    stage: input.stage,
    waiverApprovalId: null,
    waiverTotalCents: 0n,
    writeOffApprovalId: null,
    writeOffTotalCents: 0n
  };
}

function source(key: string) {
  return { id: randomUUID(), key: `p0:${key}`, type: "P0_REPOSITORY_TEST" } as const;
}

function returnInboundService(prisma: PrismaService) {
  return new HandoverWorkOrderService(prisma, Object.freeze({}) as never);
}

function returnInboundCommand(fixture: Fixture, key: string) {
  return {
    actorId: fixture.actorId,
    orderId: fixture.orderId,
    source: source(key)
  };
}

function commonReturnWorkOrderCommand(fixture: Fixture, key: string) {
  return {
    assetOwnerId: null,
    contractId: fixture.contractId,
    costConfirmationRequired: false,
    customerId: fixture.customerId,
    description: `P0 atomic return work order ${fixture.marker}`,
    metadata: { fixture: fixture.marker, purpose: "expiry-rollback-proof" },
    occurredAt: NOW,
    orderId: fixture.orderId,
    priority: "NORMAL" as const,
    relatedWorkOrderId: null,
    source: source(key),
    vehicleId: fixture.vehicleId,
    workOrderType: "RETURN_INBOUND" as const
  };
}

function assetOperationContext(actorId: string) {
  return {
    actorId,
    ipAddress: "127.0.0.1",
    permissions: [] as const,
    userAgent: "subscription-closure-capability-integration"
  };
}

function closureAudit(
  auditService: AuditService,
  actorId: string,
  activeFailpoint: string,
  auditFailpoint: "case-audit" | "document-audit"
): SubscriptionClosureMutationAuditHook {
  return async (tx, mutation) => {
    await auditService.write(
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
    if (activeFailpoint === auditFailpoint) throw new Error(auditFailpoint);
  };
}

async function removeSeededHandover(prisma: PrismaService, fixture: Fixture) {
  await prisma.vehicleHandoverWorkOrder.delete({ where: { id: fixture.handoverWorkOrderId } });
}

async function atomicResidue(prisma: PrismaService, fixture: Fixture) {
  const closureCases = await prisma.subscriptionClosureCase.findMany({
    select: { id: true },
    where: { orderId: fixture.orderId }
  });
  const caseIds = closureCases.map(({ id }) => id);
  const assetWorkOrders = await prisma.assetWorkOrder.findMany({
    select: { id: true },
    where: { orderId: fixture.orderId }
  });
  const assetWorkOrderIds = assetWorkOrders.map(({ id }) => id);
  return {
    assetEvents: await prisma.assetWorkOrderEvent.count({
      where: { workOrderId: { in: assetWorkOrderIds } }
    }),
    assetWorkOrders: assetWorkOrders.length,
    audits: await prisma.auditLog.count({ where: { operatorId: fixture.actorId } }),
    closureCases: closureCases.length,
    closureDocuments: await prisma.subscriptionClosureDocumentRevision.count({
      where: { closureCaseId: { in: caseIds } }
    }),
    closureEvents: await prisma.subscriptionClosureEvent.count({
      where: { closureCaseId: { in: caseIds } }
    }),
    closureReceipts: await prisma.subscriptionClosureCommandReceipt.count({
      where: { closureCaseId: { in: caseIds } }
    }),
    handoverEvents: await prisma.vehicleHandoverEvent.count({
      where: { orderId: fixture.orderId }
    }),
    handoverWorkOrders: await prisma.vehicleHandoverWorkOrder.count({
      where: { orderId: fixture.orderId }
    })
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(prisma: PrismaService) {
  const marker = `P0R${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const fixture = {
    actorId: randomUUID(),
    assetWorkOrderIds: [] as string[],
    closureCaseIds: [] as string[],
    contractESignTaskId: randomUUID(),
    contractId: randomUUID(),
    customerId: randomUUID(),
    handoverWorkOrderId: String(randomUUID()),
    marker,
    orderId: randomUUID(),
    signedFileId: randomUUID(),
    sourceFileId: randomUUID(),
    vehicleId: randomUUID(),
    vehicleReturnId: randomUUID()
  };
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRaw`
      INSERT INTO "user" ("id", "username", "name", "password_hash", "status", "created_at", "updated_at")
      VALUES (${fixture.actorId}::uuid, ${marker}, 'P0 repository actor', 'not-used', 'ACTIVE', clock_timestamp(), clock_timestamp())
    `;
    await tx.$executeRaw`
      INSERT INTO "customer" ("id", "customer_no", "name", "mobile", "status", "created_at", "updated_at")
      VALUES (${fixture.customerId}::uuid, ${`C-${marker}`}, 'P0 repository customer', ${marker.slice(0, 16)}, 'ACTIVE', clock_timestamp(), clock_timestamp())
    `;
    await tx.$executeRaw`
      INSERT INTO "vehicle" ("id", "vehicle_no", "brand", "model_definition_id", "purchase_price_amount", "status", "current_mileage_km", "created_at", "updated_at")
      VALUES (${fixture.vehicleId}::uuid, ${`V-${marker}`}, 'P0', ${randomUUID()}::uuid, 1, 'LEASED', 0, clock_timestamp(), clock_timestamp())
    `;
    await tx.$executeRaw`
      INSERT INTO "contract" ("id", "contract_no", "order_id", "customer_id", "contract_version_id", "contract_title", "contract_snapshot", "status", "created_at", "updated_at")
      VALUES (${fixture.contractId}::uuid, ${`K-${marker}`}, ${fixture.orderId}::uuid, ${fixture.customerId}::uuid, ${randomUUID()}::uuid, 'P0 repository contract', '{}'::jsonb, 'ARCHIVED', clock_timestamp(), clock_timestamp())
    `;
    await tx.$executeRaw`
      INSERT INTO "subscription_order" (
        "id", "order_no", "customer_id", "application_id", "quote_id", "contract_id", "vehicle_id",
        "product_id", "product_version_id", "vehicle_purchase_price_amount", "monthly_fee_amount",
        "deposit_amount", "period_months", "mileage_limit_km", "over_mileage_fee_amount",
        "model_definition_id_snapshot", "model_code_snapshot", "model_display_name_snapshot",
        "quote_snapshot", "order_status", "created_at", "updated_at"
      ) VALUES (
        ${fixture.orderId}::uuid, ${`O-${marker}`}, ${fixture.customerId}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, ${fixture.contractId}::uuid, ${fixture.vehicleId}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, 1, 1, 0, 6, 1000, 1, ${randomUUID()}::uuid, 'P0', 'P0', '{}'::jsonb,
        'PENDING_RETURN', clock_timestamp(), clock_timestamp()
      )
    `;
    await tx.$executeRaw`
      INSERT INTO "vehicle_return" ("id", "return_no", "order_id", "vehicle_id", "customer_id", "return_type", "return_status", "created_at", "updated_at")
      VALUES (${fixture.vehicleReturnId}::uuid, ${`R-${marker}`}, ${fixture.orderId}::uuid, ${fixture.vehicleId}::uuid, ${fixture.customerId}::uuid, 'NORMAL_RETURN', 'PENDING', clock_timestamp(), clock_timestamp())
    `;
    await tx.$executeRaw`
      INSERT INTO "vehicle_handover_work_order" ("id", "order_id", "handover_type", "created_at", "updated_at")
      VALUES (${fixture.handoverWorkOrderId}::uuid, ${fixture.orderId}::uuid, 'RETURN_INBOUND', clock_timestamp(), clock_timestamp())
    `;
    await tx.$executeRaw`
      INSERT INTO "contract_esign_task" ("id", "task_no", "contract_id", "order_id", "customer_id", "provider", "created_at", "updated_at")
      VALUES (${fixture.contractESignTaskId}::uuid, ${`E-${marker}`}, ${fixture.contractId}::uuid, ${fixture.orderId}::uuid, ${fixture.customerId}::uuid, 'MOCK', clock_timestamp(), clock_timestamp())
    `;
    for (const [id, suffix] of [
      [fixture.sourceFileId, "source"],
      [fixture.signedFileId, "signed"]
    ] as const) {
      await tx.$executeRaw`
        INSERT INTO "file_object" ("id", "bucket", "object_key", "original_name", "size_bytes", "created_at")
        VALUES (${id}::uuid, 'p0-test', ${`${marker}/${suffix}.pdf`}, ${`${suffix}.pdf`}, 1, clock_timestamp())
      `;
    }
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
  });
  return fixture;
}

async function deleteFixture(prisma: PrismaService, fixture: Fixture) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    const cases = await tx.subscriptionClosureCase.findMany({
      select: { id: true },
      where: { orderId: fixture.orderId }
    });
    const ids = cases.map(({ id }) => id);
    fixture.closureCaseIds.push(...ids);
    if (ids.length > 0) {
      await tx.subscriptionClosureCommandReceipt.deleteMany({
        where: { closureCaseId: { in: ids } }
      });
      await tx.subscriptionClosureCurrentDocument.deleteMany({
        where: { closureCaseId: { in: ids } }
      });
      await tx.subscriptionClosureEvent.deleteMany({ where: { closureCaseId: { in: ids } } });
      await tx.subscriptionClosureDocumentRevision.deleteMany({
        where: { closureCaseId: { in: ids } }
      });
      await tx.subscriptionClosureCase.updateMany({
        data: { currentSettlementRevisionId: null },
        where: { id: { in: ids } }
      });
      await tx.subscriptionClosureSettlementRevision.deleteMany({
        where: { closureCaseId: { in: ids } }
      });
      await tx.subscriptionClosureCase.deleteMany({ where: { id: { in: ids } } });
    }
    await tx.auditLog.deleteMany({ where: { operatorId: fixture.actorId } });
    await tx.vehicleHandoverEvent.deleteMany({ where: { orderId: fixture.orderId } });
    await tx.assetWorkOrderEvent.deleteMany({
      where: { workOrderId: { in: fixture.assetWorkOrderIds } }
    });
    await tx.contractESignTask.deleteMany({ where: { id: fixture.contractESignTaskId } });
    await tx.assetWorkOrder.deleteMany({ where: { id: { in: fixture.assetWorkOrderIds } } });
    await tx.fileObject.deleteMany({
      where: { id: { in: [fixture.sourceFileId, fixture.signedFileId] } }
    });
    await tx.vehicleReturn.deleteMany({ where: { id: fixture.vehicleReturnId } });
    await tx.vehicleHandoverWorkOrder.deleteMany({ where: { orderId: fixture.orderId } });
    await tx.subscriptionOrder.deleteMany({ where: { id: fixture.orderId } });
    await tx.contract.deleteMany({ where: { id: fixture.contractId } });
    await tx.vehicle.deleteMany({ where: { id: fixture.vehicleId } });
    await tx.customer.deleteMany({ where: { id: fixture.customerId } });
    await tx.user.deleteMany({ where: { id: fixture.actorId } });
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
  });
}

async function createFixtureWorkOrder(
  prisma: PrismaService,
  fixture: Fixture,
  workOrderType: "RETURN_INBOUND" | "RECOVERY" | "RECONDITIONING"
) {
  const id = randomUUID();
  fixture.assetWorkOrderIds.push(id);
  await prisma.assetWorkOrder.create({
    data: {
      authoritySnapshot: { marker: fixture.marker, workOrderType },
      contractId: fixture.contractId,
      createSourceId: randomUUID(),
      createSourceKey: `p0:${fixture.marker}:${workOrderType}`,
      createSourceType: "P0_REPOSITORY_TEST",
      createdBy: fixture.actorId,
      customerId: fixture.customerId,
      id,
      orderId: fixture.orderId,
      vehicleId: fixture.vehicleId,
      workOrderNo: `AW-${fixture.marker}-${workOrderType}`,
      workOrderType
    }
  });
  return id;
}

async function expectFixtureResidue(prisma: PrismaService, fixtures: readonly Fixture[]) {
  if (fixtures.length === 0) return 0;
  const orderIds = fixtures.map(({ orderId }) => orderId);
  const actorIds = fixtures.map(({ actorId }) => actorId);
  const assetWorkOrderIds = fixtures.flatMap(({ assetWorkOrderIds }) => assetWorkOrderIds);
  const closureCaseIds = fixtures.flatMap(({ closureCaseIds }) => closureCaseIds);
  const contractIds = fixtures.map(({ contractId }) => contractId);
  const esignIds = fixtures.map(({ contractESignTaskId }) => contractESignTaskId);
  const fileIds = fixtures.flatMap(({ signedFileId, sourceFileId }) => [
    signedFileId,
    sourceFileId
  ]);
  const markerIds = fixtures.map(({ marker }) => marker);
  const returnIds = fixtures.map(({ vehicleReturnId }) => vehicleReturnId);
  const vehicleIds = fixtures.map(({ vehicleId }) => vehicleId);
  const counts = await Promise.all([
    prisma.subscriptionClosureCase.count({ where: { orderId: { in: orderIds } } }),
    prisma.subscriptionClosureEvent.count({ where: { closureCaseId: { in: closureCaseIds } } }),
    prisma.subscriptionClosureCommandReceipt.count({
      where: { closureCaseId: { in: closureCaseIds } }
    }),
    prisma.subscriptionClosureCurrentDocument.count({
      where: { closureCaseId: { in: closureCaseIds } }
    }),
    prisma.subscriptionClosureDocumentRevision.count({
      where: { closureCaseId: { in: closureCaseIds } }
    }),
    prisma.subscriptionClosureSettlementRevision.count({
      where: { closureCaseId: { in: closureCaseIds } }
    }),
    prisma.assetWorkOrder.count({ where: { id: { in: assetWorkOrderIds } } }),
    prisma.assetWorkOrderEvent.count({ where: { workOrderId: { in: assetWorkOrderIds } } }),
    prisma.auditLog.count({ where: { operatorId: { in: actorIds } } }),
    prisma.contractESignTask.count({ where: { id: { in: esignIds } } }),
    prisma.fileObject.count({ where: { id: { in: fileIds } } }),
    prisma.vehicleReturn.count({ where: { id: { in: returnIds } } }),
    prisma.vehicleHandoverEvent.count({ where: { orderId: { in: orderIds } } }),
    prisma.vehicleHandoverWorkOrder.count({ where: { orderId: { in: orderIds } } }),
    prisma.subscriptionOrder.count({ where: { id: { in: orderIds } } }),
    prisma.contract.count({ where: { id: { in: contractIds } } }),
    prisma.vehicle.count({ where: { id: { in: vehicleIds } } }),
    prisma.user.count({ where: { id: { in: actorIds } } }),
    prisma.customer.count({ where: { customerNo: { in: markerIds.map((id) => `C-${id}`) } } })
  ]);
  return counts.reduce((total, count) => total + count, 0);
}

async function countCaseFacts(prisma: PrismaService, orderId: string) {
  const cases = await prisma.subscriptionClosureCase.findMany({
    select: { id: true },
    where: { orderId }
  });
  const ids = cases.map(({ id }) => id);
  return {
    cases: ids.length,
    events: await prisma.subscriptionClosureEvent.count({ where: { closureCaseId: { in: ids } } }),
    receipts: await prisma.subscriptionClosureCommandReceipt.count({
      where: { closureCaseId: { in: ids } }
    })
  };
}

function readCommitted<T>(
  prisma: PrismaService,
  operation: (tx: Prisma.TransactionClient) => Promise<T>
) {
  return prisma.$transaction(operation, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    timeout: 10_000
  });
}

async function databaseNow(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ clockTimestamp: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS "clockTimestamp"`
  );
  if (!row) throw new Error("PostgreSQL clock query returned no row");
  return row.clockTimestamp;
}

function requiredTestDatabaseUrl(value = process.env.DATABASE_URL) {
  if (!value) throw new Error("DATABASE_URL is required for subscription closure repository tests");
  const url = new URL(value);
  if (!isLoopback(url.hostname)) throw new Error("A loopback PostgreSQL database is required");
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*_(test|codex)$/.test(database)) {
    throw new Error("A dedicated test/codex database is required");
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

async function expectCode(promise: Promise<unknown>, expected: string) {
  try {
    await promise;
    throw new Error(`Expected ${expected}`);
  } catch (error) {
    expectConflict(error, expected);
  }
}

function expectConflict(error: unknown, expected: string) {
  expect(error).toBeInstanceOf(ConflictException);
  expect((error as ConflictException).getResponse()).toMatchObject({ code: expected });
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

async function settled<T>(promise: Promise<T>) {
  try {
    return { status: "fulfilled" as const, value: await promise };
  } catch (reason) {
    return { reason, status: "rejected" as const };
  }
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number) {
  const timeout = Symbol("timeout");
  const value = await Promise.race([
    promise,
    new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), milliseconds))
  ]);
  return value === timeout ? ({ finished: false } as const) : ({ finished: true, value } as const);
}

function rejectedValue<T>(result: Awaited<ReturnType<typeof settled<T>>>) {
  if (result.status !== "rejected") throw new Error("Expected rejected result");
  return result.reason;
}
