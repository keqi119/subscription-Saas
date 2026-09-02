import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditAction, Prisma, type SubscriptionClosureSettlementRevision } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";
import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import { AuditService } from "../src/audit/audit.service";
import { AssetAccountingRepository } from "../src/asset-accounting/asset-accounting.repository";
import { hashBusinessExceptionSnapshot } from "../src/asset-accounting/asset-accounting.domain";
import { AssetAccountingService } from "../src/asset-accounting/asset-accounting.service";
import { createBusinessNo } from "../src/common/business-number";
import { FinanceService } from "../src/finance/finance.service";
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
import {
  canonicalSubscriptionClosureJson,
  hashSubscriptionClosureSnapshot
} from "../src/subscription-closure/subscription-closure.domain";
import { SubscriptionClosureSettlementResolver } from "../src/subscription-closure/subscription-closure.settlement-resolver";
import {
  SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE,
  SubscriptionClosureService
} from "../src/subscription-closure/subscription-closure.service";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
import {
  insertRuntimeAssetOwner,
  insertRuntimeContract,
  insertRuntimeOrderGraph,
  insertRuntimeUser
} from "./helpers/runtime-domain-fixture";

const DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/subscription-closure.repository.integration.spec.ts"
).databaseUrl;
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
    await prisma.onModuleDestroy();
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
      finalizedAt: await databaseTimestamp(prisma),
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

  it("rejects repository finalization before its exact proposed predecessor", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const created = await readCommitted(prisma, (tx) =>
      repository.createCase(tx, createCaseCommand(data, "settlement-repository-chronology"))
    );
    const proposed = await readCommitted(prisma, (tx) =>
      repository.appendSettlementRevision(
        tx,
        settlementCommand(data, created.outcome.id, {
          expectedVersion: 0,
          key: "settlement-repository-chronology-proposed",
          stage: "PROPOSED"
        })
      )
    );

    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.appendSettlementRevision(tx, {
          ...settlementCommand(data, created.outcome.id, {
            expectedVersion: 1,
            key: "settlement-repository-chronology-finalized",
            stage: "FINALIZED"
          }),
          expectedCurrentRevisionId: proposed.outcome.id,
          finalizedAt: new Date(new Date(proposed.outcome.createdAt).getTime() - 1),
          finalizedBy: data.actorId
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND
    );
  });

  it.each([
    "settled-before-finalized",
    "settled-before-predecessor",
    "future-settled-at",
    "missing-settled-actor",
    "missing-settled-time",
    "rewritten-finalized-actor",
    "rewritten-finalized-time"
  ] as const)("rejects repository invalid SETTLED lifecycle: %s", async (mutation) => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const chain = await createFinalizedSettlementChain(
      prisma,
      repository,
      data,
      `settlement-repository-${mutation}`
    );
    const predecessor = await prisma.subscriptionClosureSettlementRevision.findUniqueOrThrow({
      where: { id: chain.finalized.outcome.id }
    });
    if (!predecessor.finalizedAt || !predecessor.finalizedBy) {
      throw new Error("Finalized settlement fixture is incomplete");
    }
    let finalizedAt: Date | null = predecessor.finalizedAt;
    let finalizedBy: string | null = predecessor.finalizedBy;
    let settledAt: Date | null = await databaseTimestamp(prisma);
    let settledBy: string | null = data.actorId;
    if (mutation === "settled-before-finalized") {
      settledAt = new Date(predecessor.finalizedAt.getTime() - 1);
    } else if (mutation === "settled-before-predecessor") {
      finalizedAt = new Date(predecessor.finalizedAt.getTime() - 1);
      settledAt = finalizedAt;
    } else if (mutation === "future-settled-at") {
      settledAt = new Date(Date.now() + 86_400_000);
    } else if (mutation === "missing-settled-actor") {
      settledBy = null;
    } else if (mutation === "missing-settled-time") {
      settledAt = null;
    } else if (mutation === "rewritten-finalized-actor") {
      finalizedBy = data.reviewerId;
    } else {
      finalizedAt = new Date(predecessor.finalizedAt.getTime() - 1);
    }
    const command: AppendSubscriptionClosureSettlementCommand = {
      ...settlementCommand(data, chain.closureCaseId, {
        expectedVersion: 2,
        key: `settlement-repository-${mutation}-settled`,
        stage: "SETTLED"
      }),
      expectedCurrentRevisionId: predecessor.id,
      finalizedAt,
      finalizedBy,
      settledAt,
      settledBy
    };

    await expectCode(
      readCommitted(prisma, (tx) => repository.appendSettlementRevision(tx, command)),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND
    );
    const [closureCase, revisions] = await Promise.all([
      prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: chain.closureCaseId } }),
      prisma.subscriptionClosureSettlementRevision.count({
        where: { closureCaseId: chain.closureCaseId }
      })
    ]);
    expect(closureCase.currentSettlementRevisionId).toBe(predecessor.id);
    expect(revisions).toBe(2);
  });

  it.each(["predecessor", "future-clock"] as const)(
    "rejects raw PostgreSQL settlement chronology mutation: %s",
    async (mutation) => {
      const data = await fixture();
      const repository = new SubscriptionClosureRepository();
      const created = await readCommitted(prisma, (tx) =>
        repository.createCase(tx, createCaseCommand(data, `settlement-db-${mutation}`))
      );
      const proposed = await readCommitted(prisma, (tx) =>
        repository.appendSettlementRevision(
          tx,
          settlementCommand(data, created.outcome.id, {
            expectedVersion: 0,
            key: `settlement-db-${mutation}-proposed`,
            stage: "PROPOSED"
          })
        )
      );
      const stored = await prisma.subscriptionClosureSettlementRevision.findUniqueOrThrow({
        where: { id: proposed.outcome.id }
      });
      const chronologyAt =
        mutation === "predecessor"
          ? new Date(stored.createdAt.getTime() - 1)
          : new Date(Date.now() + 86_400_000);

      await expect(
        prisma.$transaction(async (tx) => {
          const successor = await tx.subscriptionClosureSettlementRevision.create({
            data: cloneSettlementRevision(stored, data, mutation, chronologyAt)
          });
          await tx.subscriptionClosureCase.update({
            data: { currentSettlementRevisionId: successor.id, version: { increment: 1 } },
            where: { id: created.outcome.id }
          });
        })
      ).rejects.toThrow(
        mutation === "predecessor"
          ? "finalization cannot predate its proposed predecessor"
          : "settlement lifecycle timestamps must be chronological and no later than the database clock"
      );
    }
  );

  it.each([
    "settled-before-finalized",
    "settled-before-predecessor",
    "future-settled-at",
    "missing-settled-actor",
    "missing-settled-time",
    "rewritten-finalized-actor",
    "rewritten-finalized-time"
  ] as const)("rejects raw PostgreSQL invalid SETTLED successor: %s", async (mutation) => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const chain = await createFinalizedSettlementChain(
      prisma,
      repository,
      data,
      `settlement-db-${mutation}`
    );
    const predecessor = await prisma.subscriptionClosureSettlementRevision.findUniqueOrThrow({
      where: { id: chain.finalized.outcome.id }
    });
    const chronologyAt = await databaseTimestamp(prisma);

    await expect(
      prisma.$transaction(async (tx) => {
        const successor = await tx.subscriptionClosureSettlementRevision.create({
          data: cloneSettledRevision(predecessor, data, mutation, chronologyAt)
        });
        await tx.subscriptionClosureCase.update({
          data: { currentSettlementRevisionId: successor.id, version: { increment: 1 } },
          where: { id: chain.closureCaseId }
        });
      })
    ).rejects.toThrow(
      mutation === "settled-before-finalized" || mutation === "future-settled-at"
        ? "settlement lifecycle timestamps must be chronological and no later than the database clock"
        : mutation === "missing-settled-actor" || mutation === "missing-settled-time"
          ? "subscription_closure_settlement_stage_shape_chk"
          : "settlement cannot predate or rewrite its finalized predecessor"
    );
    const [closureCase, revisions] = await Promise.all([
      prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: chain.closureCaseId } }),
      prisma.subscriptionClosureSettlementRevision.count({
        where: { closureCaseId: chain.closureCaseId }
      })
    ]);
    expect(closureCase.currentSettlementRevisionId).toBe(predecessor.id);
    expect(revisions).toBe(2);
  });

  it("resolves, finalizes, settles, and exactly replays the zero-obligation normal closure without touching vehicle availability", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const created = await readCommitted(prisma, (tx) =>
      repository.createCase(tx, createCaseCommand(data, "service-settlement"))
    );
    await readCommitted(prisma, async (tx) => {
      const receiptAt = await databaseNow(tx);
      await repository.appendEvent(tx, {
        actorId: data.actorId,
        afterStatus: "RETURN_INSPECTION",
        closureCaseId: created.outcome.id,
        detailSnapshot: { fixture: data.marker },
        eventType: "PHYSICAL_CONTROL_CONFIRMED",
        expectedStatus: "PREPARING_RETURN",
        expectedVersion: 0,
        occurredAt: receiptAt,
        source: source("service-settlement-receipt")
      });
      const inspectionAt = await databaseNow(tx);
      await repository.appendEvent(tx, {
        actorId: data.actorId,
        afterStatus: "PENDING_SETTLEMENT",
        closureCaseId: created.outcome.id,
        detailSnapshot: { accepted: true, fixture: data.marker },
        eventType: "INSPECTION_RECORDED",
        expectedStatus: "RETURN_INSPECTION",
        expectedVersion: 1,
        occurredAt: inspectionAt,
        source: source("service-settlement-inspection")
      });
      await tx.subscriptionOrder.update({
        data: { orderStatus: "RETURNED_PENDING_SETTLEMENT", updatedBy: data.actorId },
        where: { id: data.orderId }
      });
    });
    const audit = new AuditService(prisma);
    const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
    const service = new SubscriptionClosureService(
      repository,
      Object.freeze({}) as never,
      Object.freeze({}) as never,
      audit,
      prisma,
      undefined,
      accounting,
      undefined,
      new SubscriptionClosureSettlementResolver()
    );
    const proposedAt = await databaseTimestamp(prisma);
    const proposalInput = {
      actorId: data.actorId,
      closureCaseId: created.outcome.id,
      idempotencyKey: `service-settlement:${data.marker}:propose`,
      occurredAt: proposedAt,
      waiverApprovalId: null,
      writeOffApprovalId: null
    };
    const proposed = await service.proposeManagedSettlement(proposalInput);
    const proposalReplay = await service.proposeManagedSettlement(proposalInput);
    const finalizedAt = await databaseTimestamp(prisma);
    const finalized = await service.finalizeManagedSettlement({
      ...proposalInput,
      idempotencyKey: `service-settlement:${data.marker}:finalize`,
      occurredAt: finalizedAt
    });
    const settledAt = await databaseTimestamp(prisma);
    const settleInput = {
      ...proposalInput,
      idempotencyKey: `service-settlement:${data.marker}:settle`,
      occurredAt: settledAt
    };
    const settledRevision = await service.settleManagedSettlement(settleInput);
    const settledReplay = await service.settleManagedSettlement(settleInput);
    const [closureCase, order, contract, vehicle, revisions] = await Promise.all([
      prisma.subscriptionClosureCase.findUnique({ where: { id: created.outcome.id } }),
      prisma.subscriptionOrder.findUnique({ where: { id: data.orderId } }),
      prisma.contract.findUnique({ where: { id: data.contractId } }),
      prisma.vehicle.findUnique({ where: { id: data.vehicleId } }),
      prisma.subscriptionClosureSettlementRevision.findMany({
        orderBy: { revisionNumber: "asc" },
        where: { closureCaseId: created.outcome.id }
      })
    ]);

    expect(proposalReplay).toEqual(proposed);
    expect(settledReplay).toEqual(settledRevision);
    expect(finalized).toMatchObject({ revisionNumber: 2, stage: "FINALIZED" });
    expect(settledRevision).toMatchObject({ revisionNumber: 3, stage: "SETTLED" });
    expect(
      revisions.map(({ stage, supersedesRevisionId }) => ({ stage, supersedesRevisionId }))
    ).toEqual([
      { stage: "PROPOSED", supersedesRevisionId: null },
      { stage: "FINALIZED", supersedesRevisionId: revisions[0]!.id },
      { stage: "SETTLED", supersedesRevisionId: revisions[1]!.id }
    ]);
    expect(closureCase).toMatchObject({ status: "COMPLETED", version: 6 });
    expect(order?.orderStatus).toBe("COMPLETED");
    expect(contract?.status).toBe("COMPLETED");
    expect(vehicle?.status).toBe("LEASED");
    await expect(
      prisma.subscriptionClosureSettlementRevision.update({
        data: { costTotalCents: 1n },
        where: { id: revisions[0]!.id }
      })
    ).rejects.toBeDefined();
  });

  it("rejects settlement lifecycle time before predecessors and after the database clock, with clock-consistent events", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const closureCaseId = await preparePendingSettlementCase(
      prisma,
      repository,
      data,
      "chronology-service"
    );
    const service = settlementService(prisma, repository);
    await expectCode(
      service.proposeManagedSettlement({
        ...(await managedSettlementInput(prisma, data, closureCaseId, "chronology-future")),
        occurredAt: new Date(Date.now() + 86_400_000)
      }),
      SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE.SETTLEMENT_CHRONOLOGY_INVALID
    );

    const proposed = await service.proposeManagedSettlement(
      await managedSettlementInput(prisma, data, closureCaseId, "chronology-proposed")
    );
    await expectCode(
      service.finalizeManagedSettlement({
        ...(await managedSettlementInput(prisma, data, closureCaseId, "chronology-pre-proposal")),
        occurredAt: new Date(new Date(proposed.createdAt).getTime() - 1)
      }),
      SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE.SETTLEMENT_CHRONOLOGY_INVALID
    );

    const finalized = await service.finalizeManagedSettlement(
      await managedSettlementInput(prisma, data, closureCaseId, "chronology-finalized")
    );
    await expectCode(
      service.settleManagedSettlement({
        ...(await managedSettlementInput(prisma, data, closureCaseId, "chronology-pre-final")),
        occurredAt: new Date(new Date(finalized.finalizedAt!).getTime() - 1)
      }),
      SUBSCRIPTION_CLOSURE_SERVICE_ERROR_CODE.SETTLEMENT_CHRONOLOGY_INVALID
    );

    const settled = await service.settleManagedSettlement(
      await managedSettlementInput(prisma, data, closureCaseId, "chronology-settled")
    );
    const events = await prisma.subscriptionClosureEvent.findMany({
      orderBy: { sequence: "asc" },
      where: {
        closureCaseId,
        eventType: { in: ["SETTLEMENT_REVISION_CREATED", "STATUS_TRANSITIONED"] }
      }
    });
    const settlementEvent = events.find(
      ({ detailSnapshot }) =>
        (detailSnapshot as { settlementRevisionId?: string }).settlementRevisionId === settled.id
    );
    const terminalEvent = events.at(-1);
    expect(settlementEvent?.occurredAt.toISOString()).toBe(settled.createdAt);
    expect(terminalEvent?.occurredAt.toISOString()).toBe(settled.createdAt);
  });

  it("keeps a partially paid authoritative receivable unsettled on real PostgreSQL", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const closureCaseId = await preparePendingSettlementCase(prisma, repository, data, "partial");
    await createReceivablePaymentFacts(prisma, data, {
      amountCents: 100n,
      paidCents: 40n,
      suffix: "partial"
    });
    const service = settlementService(prisma, repository);
    const proposed = await service.proposeManagedSettlement(
      await managedSettlementInput(prisma, data, closureCaseId, "partial-propose")
    );
    const finalized = await service.finalizeManagedSettlement(
      await managedSettlementInput(prisma, data, closureCaseId, "partial-finalize")
    );

    await expectCode(
      service.settleManagedSettlement(
        await managedSettlementInput(prisma, data, closureCaseId, "partial-settle")
      ),
      "SUBSCRIPTION_CLOSURE_SETTLEMENT_NOT_RESOLVED"
    );

    const [closureCase, order, contract, revisions] = await Promise.all([
      prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCaseId } }),
      prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: data.orderId } }),
      prisma.contract.findUniqueOrThrow({ where: { id: data.contractId } }),
      prisma.subscriptionClosureSettlementRevision.findMany({
        orderBy: { revisionNumber: "asc" },
        where: { closureCaseId }
      })
    ]);
    expect(proposed).toMatchObject({
      amountDueCents: "60",
      paidTotalCents: "40",
      stage: "PROPOSED"
    });
    expect(finalized).toMatchObject({
      amountDueCents: "60",
      paidTotalCents: "40",
      stage: "FINALIZED"
    });
    expect(revisions.map(({ stage }) => stage)).toEqual(["PROPOSED", "FINALIZED"]);
    expect(closureCase).toMatchObject({ status: "PENDING_SETTLEMENT", version: 4 });
    expect(order.orderStatus).toBe("RETURNED_PENDING_SETTLEMENT");
    expect(contract.status).toBe("ARCHIVED");
  });

  it("settles mixed payment, approved waiver, approved write-off, and deposit resolutions from server facts", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const closureCaseId = await preparePendingSettlementCase(prisma, repository, data, "mixed");
    const mixedBill = await createReceivablePaymentFacts(prisma, data, {
      amountCents: 700n,
      billType: "DAMAGE_FEE",
      paidCents: 200n,
      suffix: "mixed"
    });
    await createDepositDeduction(prisma, data, mixedBill.billId, 100n, "mixed");
    await appendSettlementLedgerEntry(prisma, data, "WAIVER", 200n, "mixed-waiver");
    await appendSettlementLedgerEntry(prisma, data, "WRITE_OFF", 200n, "mixed-write-off");
    const resolver = new SubscriptionClosureSettlementResolver();
    const resolved = await readCommitted(prisma, (tx) =>
      resolver.resolveInTransaction(tx, closureCaseId)
    );
    const waiverApprovalId = await createSettlementApproval(prisma, data, resolved, "WAIVER");
    const writeOffApprovalId = await createSettlementApproval(prisma, data, resolved, "WRITE_OFF");
    const service = settlementService(prisma, repository, resolver);
    const input = { waiverApprovalId, writeOffApprovalId };

    await service.proposeManagedSettlement(
      await managedSettlementInput(prisma, data, closureCaseId, "mixed-propose", input)
    );
    await service.finalizeManagedSettlement(
      await managedSettlementInput(prisma, data, closureCaseId, "mixed-finalize", input)
    );
    const settledRevision = await service.settleManagedSettlement(
      await managedSettlementInput(prisma, data, closureCaseId, "mixed-settle", input)
    );

    const [closureCase, revisions] = await Promise.all([
      prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCaseId } }),
      prisma.subscriptionClosureSettlementRevision.findMany({
        orderBy: { revisionNumber: "asc" },
        where: { closureCaseId }
      })
    ]);
    expect(settledRevision).toMatchObject({
      amountDueCents: "0",
      depositAppliedCents: "100",
      paidTotalCents: "300",
      receivableTotalCents: "700",
      stage: "SETTLED",
      waiverApprovalId,
      waiverTotalCents: "200",
      writeOffApprovalId,
      writeOffTotalCents: "200"
    });
    expect(revisions).toHaveLength(3);
    expect(new Set(revisions.map(({ inputSnapshotHash }) => inputSnapshotHash))).toEqual(
      new Set([resolved.inputSnapshotHash])
    );
    expect(closureCase.status).toBe("COMPLETED");
  });

  it("only applies current-customer waiver/write-off facts while retaining platform, owner, and reversal history", async () => {
    const data = await fixture();
    const foreign = await fixture();
    const repository = new SubscriptionClosureRepository();
    const closureCaseId = await preparePendingSettlementCase(
      prisma,
      repository,
      data,
      "responsibility"
    );
    await createReceivablePaymentFacts(prisma, data, {
      amountCents: 300n,
      paidCents: 0n,
      suffix: "responsibility"
    });
    const foreignReceivable = await createReceivablePaymentFacts(prisma, foreign, {
      amountCents: 25n,
      paidCents: 0n,
      suffix: "responsibility-foreign-order"
    });
    const customerWaiver = await appendSettlementLedgerEntry(
      prisma,
      data,
      "WAIVER",
      100n,
      "responsibility-customer-waiver"
    );
    await readCommitted(prisma, (tx) =>
      new AssetAccountingRepository().reverseCostEntry(tx, {
        actorId: data.actorId,
        confirmedAt: NOW,
        originalEntryId: customerWaiver.id,
        reason: "Reverse the superseded customer waiver before settlement",
        source: source("responsibility-customer-waiver-reversal")
      })
    );
    await appendSettlementLedgerEntry(
      prisma,
      data,
      "WAIVER",
      100n,
      "responsibility-platform-waiver",
      "PLATFORM"
    );
    await appendSettlementLedgerEntry(
      prisma,
      data,
      "WRITE_OFF",
      100n,
      "responsibility-owner-write-off",
      "ASSET_OWNER"
    );
    await appendSettlementLedgerEntry(
      prisma,
      data,
      "WRITE_OFF",
      100n,
      "responsibility-customer-write-off"
    );
    const rawMismatchEntries = await Promise.all([
      insertRawSettlementLedgerEntry(prisma, data, {
        actionType: "WAIVER",
        responsiblePartyId: foreign.customerId,
        suffix: "responsibility-wrong-responsible-party"
      }),
      insertRawSettlementLedgerEntry(prisma, data, {
        actionType: "WRITE_OFF",
        responsiblePartyId: null,
        suffix: "responsibility-null-responsible-party"
      }),
      insertRawSettlementLedgerEntry(prisma, data, {
        actionType: "WAIVER",
        customerId: foreign.customerId,
        suffix: "responsibility-wrong-customer"
      }),
      insertRawSettlementLedgerEntry(prisma, data, {
        actionType: "WRITE_OFF",
        customerId: null,
        suffix: "responsibility-null-customer"
      }),
      insertRawSettlementLedgerEntry(prisma, data, {
        actionType: "WAIVER",
        contractId: foreign.contractId,
        suffix: "responsibility-wrong-contract"
      }),
      insertRawSettlementLedgerEntry(prisma, data, {
        actionType: "WRITE_OFF",
        suffix: "responsibility-wrong-vehicle",
        vehicleId: foreign.vehicleId
      }),
      insertRawSettlementLedgerEntry(prisma, data, {
        actionType: "WAIVER",
        orderId: foreign.orderId,
        suffix: "responsibility-foreign-order"
      })
    ]);
    const reversedRawMismatch = await insertRawSettlementLedgerEntry(prisma, data, {
      actionType: "WAIVER",
      customerId: foreign.customerId,
      suffix: "responsibility-reversed-wrong-customer"
    });
    const reversedRawMismatchOutcome = await readCommitted(prisma, (tx) =>
      new AssetAccountingRepository().reverseCostEntry(tx, {
        actorId: data.actorId,
        confirmedAt: NOW,
        originalEntryId: reversedRawMismatch.id,
        reason: "Retain a reversed malformed historical customer authority row",
        source: source("responsibility-reversed-wrong-customer-reversal")
      })
    );

    const resolved = await readCommitted(prisma, (tx) =>
      new SubscriptionClosureSettlementResolver().resolveInTransaction(tx, closureCaseId)
    );

    expect(resolved).toMatchObject({
      amountDueCents: 200n,
      obligationsResolved: false,
      waiverTotalCents: 0n,
      writeOffTotalCents: 100n
    });
    expect(resolved.ledgerInputSnapshot.entries).toHaveLength(13);
    expect(resolved.ledgerInputSnapshot.entries).toEqual(
      expect.arrayContaining(
        [
          ...rawMismatchEntries.slice(0, -1),
          reversedRawMismatch,
          reversedRawMismatchOutcome.outcome
        ].map(({ id }) => expect.objectContaining({ id }))
      )
    );
    expect(resolved.ledgerInputSnapshot.entries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: rawMismatchEntries.at(-1)!.id })])
    );
    expect(resolved.billInputSnapshot.bills).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: foreignReceivable.billId })])
    );
  });

  it("commits stale settlement approval expiry while rolling back the attempted proposal", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const closureCaseId = await preparePendingSettlementCase(prisma, repository, data, "stale");
    await createReceivablePaymentFacts(prisma, data, {
      amountCents: 100n,
      paidCents: 0n,
      suffix: "stale"
    });
    await appendSettlementLedgerEntry(prisma, data, "WAIVER", 100n, "stale-waiver");
    const resolver = new SubscriptionClosureSettlementResolver();
    const approvedResolution = await readCommitted(prisma, (tx) =>
      resolver.resolveInTransaction(tx, closureCaseId)
    );
    const waiverApprovalId = await createSettlementApproval(
      prisma,
      data,
      approvedResolution,
      "WAIVER"
    );
    await appendSettlementLedgerEntry(prisma, data, "ACTUAL_COST", 1n, "stale-drift");
    const service = settlementService(prisma, repository, resolver);

    await expectCode(
      service.proposeManagedSettlement(
        await managedSettlementInput(prisma, data, closureCaseId, "stale-propose", {
          waiverApprovalId,
          writeOffApprovalId: null
        })
      ),
      "SUBSCRIPTION_CLOSURE_SETTLEMENT_APPROVAL_STALE"
    );

    const [approval, revisionCount, expiryReceiptCount, closureReceiptCount] = await Promise.all([
      prisma.businessExceptionApproval.findUniqueOrThrow({ where: { id: waiverApprovalId } }),
      prisma.subscriptionClosureSettlementRevision.count({ where: { closureCaseId } }),
      prisma.assetAccountingCommandReceipt.count({
        where: { approvalId: waiverApprovalId, commandType: "EXCEPTION_EXPIRE" }
      }),
      prisma.subscriptionClosureCommandReceipt.count({ where: { closureCaseId } })
    ]);
    expect(approval).toMatchObject({ status: "EXPIRED", version: 2 });
    expect(approval.expiryReason).toBe("Authoritative settlement facts changed.");
    expect(revisionCount).toBe(0);
    expect(expiryReceiptCount).toBe(1);
    expect(closureReceiptCount).toBe(3);
  });

  it("rolls back a settlement revision and source receipt when its audit write fails", async () => {
    const data = await fixture();
    const repository = new SubscriptionClosureRepository();
    const closureCaseId = await preparePendingSettlementCase(prisma, repository, data, "audit");
    const injectedAudit = Object.freeze({
      write: async () => {
        throw new Error("injected settlement audit failure");
      }
    }) as unknown as AuditService;
    const failingService = settlementService(
      prisma,
      repository,
      new SubscriptionClosureSettlementResolver(),
      injectedAudit
    );
    const command = await managedSettlementInput(prisma, data, closureCaseId, "audit-propose");

    await expect(failingService.proposeManagedSettlement(command)).rejects.toThrow(
      "injected settlement audit failure"
    );
    const afterFailure = await settlementResidue(prisma, closureCaseId, data.orderId);
    expect(afterFailure).toEqual({
      currentSettlementRevisionId: null,
      orderStatus: "RETURNED_PENDING_SETTLEMENT",
      receipts: 3,
      revisions: 0,
      version: 2
    });

    const retried = await settlementService(prisma, repository).proposeManagedSettlement(command);
    expect(retried).toMatchObject({ revisionNumber: 1, stage: "PROPOSED" });
  });

  it.each([
    ["append", "WAIVER"],
    ["append", "WRITE_OFF"],
    ["reverse", "WAIVER"],
    ["reverse", "WRITE_OFF"]
  ] as const)(
    "makes the closure-case lock operative for preterminal %s %s corrections",
    async (operation, actionType) => {
      const data = await fixture();
      const closureRepository = new SubscriptionClosureRepository();
      const accountingRepository = new AssetAccountingRepository();
      const closureCaseId = await preparePendingSettlementCase(
        prisma,
        closureRepository,
        data,
        `case-lock-${operation}-${actionType.toLowerCase()}`
      );
      const original =
        operation === "reverse"
          ? await appendSettlementLedgerEntry(
              prisma,
              data,
              actionType,
              25n,
              `case-lock-${operation}-${actionType.toLowerCase()}-original`
            )
          : null;
      const appendCommand = settlementLedgerCommand(
        data,
        actionType,
        25n,
        `case-lock-${operation}-${actionType.toLowerCase()}-contender`
      );
      const reverseCommand = original
        ? {
            actorId: data.actorId,
            confirmedAt: NOW,
            originalEntryId: original.id,
            reason: `Task 5 ${actionType} preterminal case-lock proof`,
            source: source(`case-lock-${operation}-${actionType.toLowerCase()}-contender`)
          }
        : null;
      const perform = () =>
        readCommitted(prisma, (tx) =>
          operation === "append"
            ? accountingRepository.appendCostEntry(tx, appendCommand)
            : accountingRepository.reverseCostEntry(tx, reverseCommand!)
        );
      const baseline = await accountingMutationResidue(prisma, data);
      const ready = deferred<void>();
      const probeHolder = deferred<void>();
      const holderUsable = deferred<void>();
      const releaseHolder = deferred<void>();
      const holder = readCommitted(prisma, async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "subscription_closure_case"
          WHERE "id" = ${closureCaseId}::uuid
          FOR UPDATE
        `);
        ready.resolve();
        await probeHolder.promise;
        await tx.$queryRaw(Prisma.sql`SELECT 1 AS "usable"`);
        holderUsable.resolve();
        await releaseHolder.promise;
      });
      void holder.catch((error) => {
        ready.reject(error);
        holderUsable.reject(error);
      });
      try {
        await ready.promise;
        const startedAt = Date.now();
        await expectCode(perform(), "ASSET_ACCOUNTING_AUTHORITY_BUSY");
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        await expect(accountingMutationResidue(prisma, data)).resolves.toEqual(baseline);
        probeHolder.resolve();
        await holderUsable.promise;
      } finally {
        probeHolder.resolve();
        releaseHolder.resolve();
        await holder;
      }

      const written = await perform();
      expect(written).toMatchObject({ wrote: true });
      await expect(accountingMutationResidue(prisma, data)).resolves.toEqual({
        audits: baseline.audits,
        ledgerEntries: baseline.ledgerEntries + 1,
        receipts: baseline.receipts + 1
      });
    }
  );

  it.each(["WAIVER", "WRITE_OFF"] as const)(
    "lets a %s reversal win before close and rejects the stale finalized settlement without a deadlock",
    async (actionType) => {
      const data = await fixture();
      const repository = new SubscriptionClosureRepository();
      const accountingRepository = new AssetAccountingRepository();
      const closureCaseId = await preparePendingSettlementCase(
        prisma,
        repository,
        data,
        "race-reverse"
      );
      await createReceivablePaymentFacts(prisma, data, {
        amountCents: 100n,
        paidCents: 0n,
        suffix: `race-reverse-${actionType.toLowerCase()}`
      });
      const original = await appendSettlementLedgerEntry(
        prisma,
        data,
        actionType,
        100n,
        "race-reverse-original"
      );
      const resolver = new SubscriptionClosureSettlementResolver();
      const resolution = await readCommitted(prisma, (tx) =>
        resolver.resolveInTransaction(tx, closureCaseId)
      );
      const approvalId = await createSettlementApproval(prisma, data, resolution, actionType);
      const approvals = {
        waiverApprovalId: actionType === "WAIVER" ? approvalId : null,
        writeOffApprovalId: actionType === "WRITE_OFF" ? approvalId : null
      };
      const service = settlementService(prisma, repository, resolver);
      await service.proposeManagedSettlement(
        await managedSettlementInput(prisma, data, closureCaseId, "race-reverse-propose", approvals)
      );
      await service.finalizeManagedSettlement(
        await managedSettlementInput(
          prisma,
          data,
          closureCaseId,
          "race-reverse-finalize",
          approvals
        )
      );
      const finalizedRevision = await prisma.subscriptionClosureSettlementRevision.findFirstOrThrow(
        {
          orderBy: { revisionNumber: "desc" },
          where: { closureCaseId }
        }
      );
      const settleInput = await managedSettlementInput(
        prisma,
        data,
        closureCaseId,
        "race-reverse-settle",
        approvals
      );
      const settleSource = {
        id: closureCaseId,
        key: settleInput.idempotencyKey,
        type: "SUBSCRIPTION_CLOSURE"
      } as const;
      const ready = deferred<void>();
      const release = deferred<void>();
      const holder = readCommitted(prisma, async (tx) => {
        await repository.lockSourceOwnership(tx, settleSource);
        ready.resolve();
        await release.promise;
      });
      void holder.catch(ready.reject);
      await ready.promise;
      const close = settled(service.settleManagedSettlement(settleInput));
      expect(await waitForDatabaseLock(prisma, "pg_advisory_xact_lock")).toBe(true);

      const reversal = await readCommitted(prisma, (tx) =>
        accountingRepository.reverseCostEntry(tx, {
          actorId: data.actorId,
          confirmedAt: NOW,
          originalEntryId: original.id,
          reason: "real PostgreSQL close-versus-ledger reversal proof",
          source: source("race-reverse-ledger")
        })
      );
      release.resolve();
      await holder;
      const closeResult = await close;

      expect(reversal.outcome).toMatchObject({
        amountCents: -100n,
        entryKind: "REVERSAL",
        reversalOfEntryId: original.id
      });
      expectConflict(rejectedValue(closeResult), "SUBSCRIPTION_CLOSURE_SETTLEMENT_FACT_DRIFT");
      await expect(settlementResidue(prisma, closureCaseId, data.orderId)).resolves.toMatchObject({
        currentSettlementRevisionId: finalizedRevision.id,
        orderStatus: "RETURNED_PENDING_SETTLEMENT",
        receipts: 5,
        revisions: 2,
        version: 4
      });
      const [closureCase, contract, terminalRevisions, reversalReceipts] = await Promise.all([
        prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCaseId } }),
        prisma.contract.findUniqueOrThrow({ where: { id: data.contractId } }),
        prisma.subscriptionClosureSettlementRevision.count({
          where: { closureCaseId, stage: "SETTLED" }
        }),
        prisma.assetAccountingCommandReceipt.count({
          where: { costEntryId: reversal.outcome.id, commandType: "COST_REVERSE" }
        })
      ]);
      expect(closureCase.status).toBe("PENDING_SETTLEMENT");
      expect(contract.status).toBe("ARCHIVED");
      expect(terminalRevisions).toBe(0);
      expect(reversalReceipts).toBe(1);
    }
  );

  it.each(["WAIVER", "WRITE_OFF"] as const)(
    "rejects a waiting %s reversal after close wins and preserves the terminal projection",
    async (actionType) => {
      const data = await fixture();
      const repository = new SubscriptionClosureRepository();
      const accountingRepository = new AssetAccountingRepository();
      const closureCaseId = await preparePendingSettlementCase(
        prisma,
        repository,
        data,
        "race-close"
      );
      await createReceivablePaymentFacts(prisma, data, {
        amountCents: 100n,
        paidCents: 0n,
        suffix: `race-close-${actionType.toLowerCase()}`
      });
      const original = await appendSettlementLedgerEntry(
        prisma,
        data,
        actionType,
        100n,
        "race-close-original"
      );
      const resolver = new SubscriptionClosureSettlementResolver();
      const resolution = await readCommitted(prisma, (tx) =>
        resolver.resolveInTransaction(tx, closureCaseId)
      );
      const approvalId = await createSettlementApproval(prisma, data, resolution, actionType);
      const approvals = {
        waiverApprovalId: actionType === "WAIVER" ? approvalId : null,
        writeOffApprovalId: actionType === "WRITE_OFF" ? approvalId : null
      };
      const service = settlementService(prisma, repository, resolver);
      await service.proposeManagedSettlement(
        await managedSettlementInput(prisma, data, closureCaseId, "race-close-propose", approvals)
      );
      await service.finalizeManagedSettlement(
        await managedSettlementInput(prisma, data, closureCaseId, "race-close-finalize", approvals)
      );
      const reverseSource = source("race-close-ledger");
      const reverseCommand = {
        actorId: data.actorId,
        confirmedAt: NOW,
        originalEntryId: original.id,
        reason: "real PostgreSQL close-winner serialization proof",
        source: reverseSource
      };
      const ready = deferred<void>();
      const release = deferred<void>();
      const holder = readCommitted(prisma, async (tx) => {
        await accountingRepository.lockSourceOwnership(tx, reverseSource);
        ready.resolve();
        await release.promise;
      });
      void holder.catch(ready.reject);
      await ready.promise;
      const reversal = settled(
        readCommitted(prisma, (tx) => accountingRepository.reverseCostEntry(tx, reverseCommand))
      );
      expect(await waitForDatabaseLock(prisma, "pg_advisory_xact_lock")).toBe(true);

      const settledRevision = await service.settleManagedSettlement(
        await managedSettlementInput(prisma, data, closureCaseId, "race-close-settle", approvals)
      );
      release.resolve();
      await holder;
      const reversalResult = await reversal;

      expect(settledRevision).toMatchObject({
        stage: "SETTLED",
        waiverTotalCents: actionType === "WAIVER" ? "100" : "0",
        writeOffTotalCents: actionType === "WRITE_OFF" ? "100" : "0"
      });
      expect(reversalResult.status).toBe("rejected");
      expectConflict(rejectedValue(reversalResult), "ASSET_ACCOUNTING_SETTLEMENT_CLOSED");
      const [persisted, closureCase, order, contract, receipts, events, audits] = await Promise.all(
        [
          prisma.subscriptionClosureSettlementRevision.findUniqueOrThrow({
            where: { id: settledRevision.id }
          }),
          prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCaseId } }),
          prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: data.orderId } }),
          prisma.contract.findUniqueOrThrow({ where: { id: data.contractId } }),
          prisma.subscriptionClosureCommandReceipt.count({ where: { closureCaseId } }),
          prisma.subscriptionClosureEvent.count({ where: { closureCaseId } }),
          prisma.auditLog.count({
            where: { module: "subscription_closure", operatorId: data.actorId }
          })
        ]
      );
      expect(persisted.id).toBe(closureCase.currentSettlementRevisionId);
      expect(closureCase).toMatchObject({ status: "COMPLETED", version: 6 });
      expect(order.orderStatus).toBe("COMPLETED");
      expect(contract.status).toBe("COMPLETED");
      expect({ audits, events, receipts }).toEqual({ audits: 6, events: 7, receipts: 7 });
      await expect(
        prisma.vehicleCostLedgerEntry.count({ where: { reversalOfEntryId: original.id } })
      ).resolves.toBe(0);
      const ledgerCount = await prisma.vehicleCostLedgerEntry.count({
        where: { orderId: data.orderId }
      });
      await expectCode(
        appendSettlementLedgerEntry(
          prisma,
          data,
          actionType,
          1n,
          `race-close-post-terminal-${actionType.toLowerCase()}`
        ),
        "ASSET_ACCOUNTING_SETTLEMENT_CLOSED"
      );
      await expect(
        prisma.vehicleCostLedgerEntry.count({ where: { orderId: data.orderId } })
      ).resolves.toBe(ledgerCount);
    }
  );
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
  const [baseTask, closureCase] = await Promise.all([
    tx.contractESignTask.findUniqueOrThrow({ where: { id: command.contractESignTaskId } }),
    tx.subscriptionClosureCase.findUniqueOrThrow({
      select: { caseNo: true },
      where: { id: command.closureCaseId }
    })
  ]);
  const documentSnapshot = { ...command.documentSnapshot, caseNo: closureCase.caseNo };
  const canonicalManifest = canonicalSubscriptionClosureJson(documentSnapshot);
  const sourceFileHash = hashSubscriptionClosureSnapshot(documentSnapshot);
  const sourceObjectKey = `subscription-closure/${command.closureCaseId}/return-manifest-r1.json`;
  const sourceName = `${closureCase.caseNo}-return-manifest-r1.json`;
  Object.assign(command, { documentSnapshot, sourceFileHash });
  const file = await tx.fileObject.update({
    data: {
      bucket: "subscription-closure",
      createdAt: command.generatedAt,
      mimeType: "application/json",
      objectKey: sourceObjectKey,
      originalName: sourceName,
      sizeBytes: BigInt(Buffer.byteLength(canonicalManifest)),
      uploadedBy: command.actorId
    },
    where: { id: command.sourceFileId }
  });
  const taskId = randomUUID();
  (command as { contractESignTaskId: string }).contractESignTaskId = taskId;
  return tx.contractESignTask.create({
    data: {
      contractId: baseTask.contractId,
      createdAt: command.generatedAt,
      createdBy: command.actorId,
      customerId: baseTask.customerId,
      documentName: file.originalName,
      documentObjectKey: file.objectKey,
      documentType: "RETURN_MANIFEST",
      id: taskId,
      orderId: baseTask.orderId,
      provider: "OTHER",
      requestSnapshot: {
        closureCaseId: command.closureCaseId,
        documentSnapshotHash: hashSubscriptionClosureSnapshot(command.documentSnapshot),
        documentType: "RETURN_MANIFEST",
        returnManifestSource: command.source,
        revisionNumber: 1,
        sourceFileHash: command.sourceFileHash,
        sourceFileId: command.sourceFileId
      },
      signingStage: "STAGE6_RETURN_MANIFEST",
      sourceId: command.source.id,
      sourceKey: command.source.key,
      sourceType: command.source.type,
      taskNo: createBusinessNo("ESG", command.generatedAt),
      taskStatus: "CREATED",
      updatedAt: command.generatedAt,
      updatedBy: command.actorId
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

function cloneSettlementRevision(
  row: SubscriptionClosureSettlementRevision,
  fixture: Fixture,
  mutation: "future-clock" | "predecessor",
  chronologyAt: Date
): Prisma.SubscriptionClosureSettlementRevisionUncheckedCreateInput {
  const finalized = mutation === "predecessor";
  return {
    amountDueCents: row.amountDueCents,
    amountRefundableCents: row.amountRefundableCents,
    billInputSnapshot: row.billInputSnapshot as Prisma.InputJsonValue,
    closureCaseId: row.closureCaseId,
    costTotalCents: row.costTotalCents,
    createdAt: finalized ? row.createdAt : chronologyAt,
    createdBy: fixture.actorId,
    depositAppliedCents: row.depositAppliedCents,
    depositInputSnapshot: row.depositInputSnapshot as Prisma.InputJsonValue,
    depositRefundCents: row.depositRefundCents,
    finalizedAt: finalized ? chronologyAt : null,
    finalizedBy: finalized ? fixture.actorId : null,
    id: randomUUID(),
    inputSnapshotHash: row.inputSnapshotHash,
    ledgerInputSnapshot: row.ledgerInputSnapshot as Prisma.InputJsonValue,
    paidTotalCents: row.paidTotalCents,
    receivableTotalCents: row.receivableTotalCents,
    responsibilitySnapshot: row.responsibilitySnapshot as Prisma.InputJsonValue,
    resultHash: row.resultHash,
    resultSnapshot: row.resultSnapshot as Prisma.InputJsonValue,
    revisionNumber: 2,
    settledAt: null,
    settledBy: null,
    settlementType: row.settlementType,
    sourceId: randomUUID(),
    sourceKey: `raw-chronology-${mutation}-${fixture.marker}`,
    sourceType: "SUBSCRIPTION_CLOSURE",
    stage: finalized ? "FINALIZED" : "PROPOSED",
    supersedesRevisionId: row.id,
    waiverApprovalId: row.waiverApprovalId,
    waiverTotalCents: row.waiverTotalCents,
    writeOffApprovalId: row.writeOffApprovalId,
    writeOffTotalCents: row.writeOffTotalCents
  };
}

function cloneSettledRevision(
  row: SubscriptionClosureSettlementRevision,
  fixture: Fixture,
  mutation:
    | "future-settled-at"
    | "missing-settled-actor"
    | "missing-settled-time"
    | "rewritten-finalized-actor"
    | "rewritten-finalized-time"
    | "settled-before-finalized"
    | "settled-before-predecessor",
  chronologyAt: Date
): Prisma.SubscriptionClosureSettlementRevisionUncheckedCreateInput {
  if (!row.finalizedAt || !row.finalizedBy) {
    throw new Error("Finalized settlement fixture is incomplete");
  }
  let finalizedAt: Date = row.finalizedAt;
  let finalizedBy: string = row.finalizedBy;
  let settledAt: Date | null = chronologyAt;
  let settledBy: string | null = fixture.actorId;
  if (mutation === "settled-before-finalized") {
    settledAt = new Date(row.finalizedAt.getTime() - 1);
  } else if (mutation === "settled-before-predecessor") {
    finalizedAt = new Date(row.finalizedAt.getTime() - 1);
    settledAt = finalizedAt;
  } else if (mutation === "future-settled-at") {
    settledAt = new Date(Date.now() + 86_400_000);
  } else if (mutation === "missing-settled-actor") {
    settledBy = null;
  } else if (mutation === "missing-settled-time") {
    settledAt = null;
  } else if (mutation === "rewritten-finalized-actor") {
    finalizedBy = fixture.reviewerId;
  } else {
    finalizedAt = new Date(row.finalizedAt.getTime() - 1);
  }
  return {
    amountDueCents: row.amountDueCents,
    amountRefundableCents: row.amountRefundableCents,
    billInputSnapshot: row.billInputSnapshot as Prisma.InputJsonValue,
    closureCaseId: row.closureCaseId,
    costTotalCents: row.costTotalCents,
    createdAt: chronologyAt,
    createdBy: fixture.actorId,
    depositAppliedCents: row.depositAppliedCents,
    depositInputSnapshot: row.depositInputSnapshot as Prisma.InputJsonValue,
    depositRefundCents: row.depositRefundCents,
    finalizedAt,
    finalizedBy,
    id: randomUUID(),
    inputSnapshotHash: row.inputSnapshotHash,
    ledgerInputSnapshot: row.ledgerInputSnapshot as Prisma.InputJsonValue,
    paidTotalCents: row.paidTotalCents,
    receivableTotalCents: row.receivableTotalCents,
    responsibilitySnapshot: row.responsibilitySnapshot as Prisma.InputJsonValue,
    resultHash: row.resultHash,
    resultSnapshot: row.resultSnapshot as Prisma.InputJsonValue,
    revisionNumber: row.revisionNumber + 1,
    settledAt,
    settledBy,
    settlementType: row.settlementType,
    sourceId: randomUUID(),
    sourceKey: `raw-settled-${mutation}-${fixture.marker}`,
    sourceType: "SUBSCRIPTION_CLOSURE",
    stage: "SETTLED",
    supersedesRevisionId: row.id,
    waiverApprovalId: row.waiverApprovalId,
    waiverTotalCents: row.waiverTotalCents,
    writeOffApprovalId: row.writeOffApprovalId,
    writeOffTotalCents: row.writeOffTotalCents
  };
}

async function createFinalizedSettlementChain(
  prisma: PrismaService,
  repository: SubscriptionClosureRepository,
  fixture: Fixture,
  suffix: string
) {
  const created = await readCommitted(prisma, (tx) =>
    repository.createCase(tx, createCaseCommand(fixture, `${suffix}-case`))
  );
  const proposed = await readCommitted(prisma, (tx) =>
    repository.appendSettlementRevision(
      tx,
      settlementCommand(fixture, created.outcome.id, {
        expectedVersion: 0,
        key: `${suffix}-proposed`,
        stage: "PROPOSED"
      })
    )
  );
  const finalized = await readCommitted(prisma, (tx) =>
    repository.appendSettlementRevision(tx, {
      ...settlementCommand(fixture, created.outcome.id, {
        expectedVersion: 1,
        key: `${suffix}-finalized`,
        stage: "FINALIZED"
      }),
      expectedCurrentRevisionId: proposed.outcome.id,
      finalizedAt: new Date(proposed.outcome.createdAt),
      finalizedBy: fixture.actorId
    })
  );
  return { closureCaseId: created.outcome.id, finalized, proposed };
}

function settlementService(
  prisma: PrismaService,
  repository = new SubscriptionClosureRepository(),
  resolver = new SubscriptionClosureSettlementResolver(),
  audit: AuditService = new AuditService(prisma)
) {
  const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
  return new SubscriptionClosureService(
    repository,
    Object.freeze({}) as never,
    Object.freeze({}) as never,
    audit,
    prisma,
    undefined,
    accounting,
    undefined,
    resolver
  );
}

async function preparePendingSettlementCase(
  prisma: PrismaService,
  repository: SubscriptionClosureRepository,
  fixture: Fixture,
  suffix: string,
  closureType: "NORMAL_COMPLETION" | "EARLY_TERMINATION" = "NORMAL_COMPLETION"
) {
  const created = await readCommitted(prisma, (tx) =>
    repository.createCase(tx, createCaseCommand(fixture, `settlement-${suffix}`, closureType))
  );
  await readCommitted(prisma, async (tx) => {
    const receiptAt = await databaseNow(tx);
    await repository.appendEvent(tx, {
      actorId: fixture.actorId,
      afterStatus: "RETURN_INSPECTION",
      closureCaseId: created.outcome.id,
      detailSnapshot: { fixture: fixture.marker, suffix },
      eventType: "PHYSICAL_CONTROL_CONFIRMED",
      expectedStatus: "PREPARING_RETURN",
      expectedVersion: 0,
      occurredAt: receiptAt,
      source: source(`settlement-${suffix}-receipt`)
    });
    const inspectionAt = await databaseNow(tx);
    await repository.appendEvent(tx, {
      actorId: fixture.actorId,
      afterStatus: "PENDING_SETTLEMENT",
      closureCaseId: created.outcome.id,
      detailSnapshot: { accepted: true, fixture: fixture.marker, suffix },
      eventType: "INSPECTION_RECORDED",
      expectedStatus: "RETURN_INSPECTION",
      expectedVersion: 1,
      occurredAt: inspectionAt,
      source: source(`settlement-${suffix}-inspection`)
    });
    await tx.subscriptionOrder.update({
      data: { orderStatus: "RETURNED_PENDING_SETTLEMENT", updatedBy: fixture.actorId },
      where: { id: fixture.orderId }
    });
  });
  return created.outcome.id;
}

async function managedSettlementInput(
  prisma: PrismaService,
  fixture: Fixture,
  closureCaseId: string,
  suffix: string,
  approvals: Readonly<{
    waiverApprovalId: string | null;
    writeOffApprovalId: string | null;
  }> = { waiverApprovalId: null, writeOffApprovalId: null }
) {
  return {
    actorId: fixture.actorId,
    closureCaseId,
    idempotencyKey: `${fixture.marker}:${suffix}`,
    occurredAt: await databaseTimestamp(prisma),
    ...approvals
  };
}

async function appendSettlementLedgerEntry(
  prisma: PrismaService,
  fixture: Fixture,
  actionType: "ACTUAL_COST" | "WAIVER" | "WRITE_OFF",
  amountCents: bigint,
  suffix: string,
  responsiblePartyType: "ASSET_OWNER" | "CUSTOMER" | "PLATFORM" = "CUSTOMER"
) {
  const result = await readCommitted(prisma, (tx) =>
    new AssetAccountingRepository().appendCostEntry(
      tx,
      settlementLedgerCommand(fixture, actionType, amountCents, suffix, responsiblePartyType)
    )
  );
  return result.outcome;
}

function settlementLedgerCommand(
  fixture: Fixture,
  actionType: "ACTUAL_COST" | "WAIVER" | "WRITE_OFF",
  amountCents: bigint,
  suffix: string,
  responsiblePartyType: "ASSET_OWNER" | "CUSTOMER" | "PLATFORM" = "CUSTOMER"
) {
  const assetOwner = responsiblePartyType === "ASSET_OWNER";
  return {
    actionType,
    accountingPeriod: "2026-08",
    actorId: fixture.actorId,
    amountCents,
    assetOwnerId: assetOwner ? fixture.assetOwnerId : null,
    assetOwnerSnapshot: assetOwner ? { assetOwnerId: fixture.assetOwnerId } : null,
    confirmedAt: NOW,
    contractId: fixture.contractId,
    costCategory: "OTHER" as const,
    customerId: fixture.customerId,
    occurredOn: new Date("2026-08-21T00:00:00.000Z"),
    orderId: fixture.orderId,
    reason: `Task 5 settlement ${actionType.toLowerCase()} fixture`,
    responsiblePartyId:
      responsiblePartyType === "CUSTOMER"
        ? fixture.customerId
        : responsiblePartyType === "ASSET_OWNER"
          ? fixture.assetOwnerId
          : null,
    responsiblePartyType,
    responsibilitySnapshot: {
      actionType,
      fixture: fixture.marker,
      responsiblePartyType,
      suffix
    },
    source: source(`ledger-${suffix}`),
    vehicleId: fixture.vehicleId
  };
}

async function insertRawSettlementLedgerEntry(
  prisma: PrismaService,
  fixture: Fixture,
  input: Readonly<{
    actionType: "WAIVER" | "WRITE_OFF";
    contractId?: string | null;
    customerId?: string | null;
    orderId?: string;
    responsiblePartyId?: string | null;
    suffix: string;
    vehicleId?: string;
  }>
) {
  return prisma.vehicleCostLedgerEntry.create({
    data: {
      accountingPeriod: "2026-08",
      actionType: input.actionType,
      amountCents: 25n,
      assetOwnerSnapshot: Prisma.JsonNull,
      confirmedAt: NOW,
      confirmedBy: fixture.actorId,
      contractId: input.contractId === undefined ? fixture.contractId : input.contractId,
      costCategory: "OTHER",
      customerId: input.customerId === undefined ? fixture.customerId : input.customerId,
      entryKind: "ORIGINAL",
      evidenceSnapshot: Prisma.JsonNull,
      occurredOn: new Date("2026-08-21T00:00:00.000Z"),
      orderId: input.orderId ?? fixture.orderId,
      responsiblePartyId:
        input.responsiblePartyId === undefined ? fixture.customerId : input.responsiblePartyId,
      responsiblePartyType: "CUSTOMER",
      responsibilitySnapshot: {
        fixture: fixture.marker,
        rawPersistedFact: true,
        suffix: input.suffix
      },
      reversalOfEntryId: null,
      sourceId: randomUUID(),
      sourceKey: `raw-responsibility-${input.suffix}-${fixture.marker}`,
      sourceType: "P0_REPOSITORY_TEST",
      vehicleId: input.vehicleId ?? fixture.vehicleId
    }
  });
}

async function createReceivablePaymentFacts(
  prisma: PrismaService,
  fixture: Fixture,
  input: Readonly<{
    amountCents: bigint;
    billType?: "DAMAGE_FEE" | "OTHER";
    paidCents: bigint;
    suffix: string;
  }>
) {
  const billId = randomUUID();
  const paymentId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.receivableBill.create({
      data: {
        amount: input.amountCents,
        billNo: `B-${fixture.marker}-${input.suffix}`,
        billStatus:
          input.paidCents === 0n
            ? "PENDING"
            : input.paidCents === input.amountCents
              ? "PAID"
              : "PARTIALLY_PAID",
        billType: input.billType ?? "OTHER",
        customerId: fixture.customerId,
        dueDate: NOW,
        id: billId,
        orderId: fixture.orderId,
        paidAmount: input.paidCents,
        remainingAmount: input.amountCents - input.paidCents,
        snapshot: { fixture: fixture.marker, suffix: input.suffix }
      }
    });
    if (input.paidCents > 0n) {
      await tx.paymentRecord.create({
        data: {
          customerId: fixture.customerId,
          id: paymentId,
          orderId: fixture.orderId,
          paymentAmount: input.paidCents,
          paymentMethod: "BANK_TRANSFER",
          paymentNo: `P-${fixture.marker}-${input.suffix}`,
          paymentStatus: "CONFIRMED",
          receivedAt: NOW
        }
      });
      await tx.paymentWriteOff.create({
        data: {
          billId,
          customerId: fixture.customerId,
          orderId: fixture.orderId,
          paymentId,
          remark: `Task 5 ${input.suffix} allocation`,
          writeOffAmount: input.paidCents,
          writeOffAt: NOW
        }
      });
    }
  });
  return { billId, paymentId: input.paidCents > 0n ? paymentId : null };
}

async function createDepositDeduction(
  prisma: PrismaService,
  fixture: Fixture,
  billId: string,
  amountCents: bigint,
  suffix: string
) {
  await prisma.$transaction(async (tx) => {
    await tx.subscriptionOrder.update({
      data: {
        depositAmount: amountCents,
        depositStatus: "CONFIRMED",
        finalDepositAmount: amountCents
      },
      where: { id: fixture.orderId }
    });
    await tx.depositLedger.create({
      data: {
        amount: amountCents,
        balanceAfter: amountCents,
        createdBy: fixture.actorId,
        customerId: fixture.customerId,
        ledgerNo: `D-${fixture.marker}-${suffix}-collect`,
        occurredAt: new Date(NOW.getTime() - 1_000),
        orderId: fixture.orderId,
        paymentId: null,
        snapshot: { fixture: fixture.marker, suffix, productionPath: true },
        transactionStatus: "CONFIRMED",
        transactionType: "COLLECT"
      }
    });
  });
  const finance = new FinanceService(new AuditService(prisma), prisma);
  const result = await finance.deductDeposit(
    fixture.orderId,
    { amount: Number(amountCents), billId, remark: `Task 5 production DEDUCT ${suffix}` },
    {
      id: fixture.actorId,
      menus: [],
      name: "P0 repository actor",
      permissions: [],
      roles: ["ADMIN"],
      username: fixture.marker
    },
    { ipAddress: "127.0.0.1", userAgent: "task-5-production-deposit-proof" }
  );
  const [bill, ledger] = await Promise.all([
    prisma.receivableBill.findUniqueOrThrow({ where: { id: billId } }),
    prisma.depositLedger.findUniqueOrThrow({ where: { id: result.ledger.id } })
  ]);
  expect(ledger).toMatchObject({
    amount: amountCents,
    balanceAfter: 0n,
    billId,
    customerId: fixture.customerId,
    orderId: fixture.orderId,
    paymentId: null,
    transactionStatus: "CONFIRMED",
    transactionType: "DEDUCT"
  });
  expect(bill.paidAmount + bill.remainingAmount).toBe(bill.amount);
  expect(bill.paidAmount).toBe(300n);
  expect(bill.remainingAmount).toBe(400n);
  return ledger;
}

async function createSettlementApproval(
  prisma: PrismaService,
  fixture: Fixture,
  resolution: Awaited<ReturnType<SubscriptionClosureSettlementResolver["resolveInTransaction"]>>,
  kind: "WAIVER" | "WRITE_OFF"
) {
  const exceptionType = kind === "WAIVER" ? "SETTLEMENT_WAIVER" : "SETTLEMENT_WRITE_OFF";
  const subjectField = kind === "WAIVER" ? "settlementWaiver" : "settlementWriteOff";
  const amountCents =
    kind === "WAIVER" ? resolution.waiverTotalCents : resolution.writeOffTotalCents;
  const authoritySnapshot = {
    amountCents: amountCents.toString(),
    closureCaseId: resolution.closureCaseId,
    inputSnapshotHash: resolution.inputSnapshotHash,
    orderId: resolution.orderId,
    resolutionType: exceptionType,
    resultHash: resolution.resultHash
  };
  const subject = {
    subjectField,
    subjectId: resolution.closureCaseId,
    subjectType: "SETTLEMENT_CASE" as const
  };
  const repository = new AssetAccountingRepository();
  const requested = await readCommitted(prisma, (tx) =>
    repository.requestExceptionApproval(tx, {
      authoritySnapshot,
      exceptionType,
      requestEvidenceSnapshot: { fixture: fixture.marker, kind },
      requestReason: `Task 5 ${kind.toLowerCase()} fixture`,
      requestedAt: NOW,
      requestedBy: fixture.actorId,
      source: source(`approval-${kind.toLowerCase()}-request`),
      subject
    })
  );
  const decided = await readCommitted(prisma, (tx) =>
    repository.decideExceptionApproval(tx, {
      approvalId: requested.outcome.id,
      authoritySnapshot,
      decidedAt: NOW,
      decidedBy: fixture.reviewerId,
      decision: "APPROVED",
      decisionComment: "Task 5 approved fixture",
      exceptionType,
      expectedVersion: 0,
      source: source(`approval-${kind.toLowerCase()}-decide`),
      subject
    })
  );
  expect(hashBusinessExceptionSnapshot(authoritySnapshot)).toBe(
    decided.outcome.subjectSnapshotHash
  );
  return decided.outcome.id;
}

async function settlementResidue(prisma: PrismaService, closureCaseId: string, orderId: string) {
  const [closureCase, order, revisions, receipts] = await Promise.all([
    prisma.subscriptionClosureCase.findUniqueOrThrow({ where: { id: closureCaseId } }),
    prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: orderId } }),
    prisma.subscriptionClosureSettlementRevision.count({ where: { closureCaseId } }),
    prisma.subscriptionClosureCommandReceipt.count({ where: { closureCaseId } })
  ]);
  return {
    currentSettlementRevisionId: closureCase.currentSettlementRevisionId,
    orderStatus: order.orderStatus,
    receipts,
    revisions,
    version: closureCase.version
  };
}

async function accountingMutationResidue(prisma: PrismaService, fixture: Fixture) {
  const [audits, ledgerEntries, receipts] = await Promise.all([
    prisma.auditLog.count({ where: { operatorId: fixture.actorId } }),
    prisma.vehicleCostLedgerEntry.count({ where: { orderId: fixture.orderId } }),
    prisma.assetAccountingCommandReceipt.count({ where: { actorId: fixture.actorId } })
  ]);
  return { audits, ledgerEntries, receipts };
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
    applicationId: randomUUID(),
    assetOwnerId: randomUUID(),
    assetWorkOrderIds: [] as string[],
    closureCaseIds: [] as string[],
    contractESignTaskId: randomUUID(),
    contractId: randomUUID(),
    customerId: randomUUID(),
    handoverWorkOrderId: String(randomUUID()),
    marker,
    orderId: randomUUID(),
    productId: randomUUID(),
    productVersionId: randomUUID(),
    quoteId: randomUUID(),
    reviewerId: randomUUID(),
    signedFileId: randomUUID(),
    sourceFileId: randomUUID(),
    vehicleId: randomUUID(),
    vehicleReturnId: randomUUID()
  };
  await prisma.$transaction(async (tx) => {
    await insertRuntimeOrderGraph(tx, {
      applicationId: fixture.applicationId,
      customerId: fixture.customerId,
      label: marker,
      orderId: fixture.orderId,
      productId: fixture.productId,
      productVersionId: fixture.productVersionId,
      quoteId: fixture.quoteId,
      salesUserId: fixture.actorId,
      vehicleId: fixture.vehicleId
    });
    await insertRuntimeUser(tx, fixture.reviewerId, `${marker}-reviewer`);
    await insertRuntimeAssetOwner(tx, fixture.assetOwnerId, marker);
    await insertRuntimeContract(tx, {
      contractId: fixture.contractId,
      customerId: fixture.customerId,
      label: marker,
      orderId: fixture.orderId
    });
    await tx.subscriptionOrder.update({
      data: {
        depositAmount: 0n,
        mileageLimitKm: 1000,
        monthlyFeeAmount: 1n,
        orderStatus: "PENDING_RETURN",
        overMileageFeeAmount: 1n,
        vehiclePurchasePriceAmount: 1n
      },
      where: { id: fixture.orderId }
    });
    await tx.subscriptionQuote.update({
      data: {
        depositAmount: 0n,
        mileageLimitKm: 1000,
        monthlyFeeAmount: 1n,
        overMileageFeeAmount: 1n,
        vehiclePurchasePriceAmount: 1n
      },
      where: { id: fixture.quoteId }
    });
    await tx.vehicle.update({
      data: { purchasePriceAmount: 1n, status: "LEASED" },
      where: { id: fixture.vehicleId }
    });
    await tx.contract.update({
      data: { archivedAt: null, signedAt: null },
      where: { id: fixture.contractId }
    });
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
  });
  return fixture;
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

async function databaseTimestamp(prisma: PrismaService) {
  const [row] = await prisma.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS "now"`
  );
  if (!row) throw new Error("PostgreSQL clock query returned no row");
  return row.now;
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
