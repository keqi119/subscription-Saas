import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";
import {
  SUBSCRIPTION_CLOSURE_ERROR_CODE,
  SubscriptionClosureRepository,
  type AppendSubscriptionClosureDocumentCommand,
  type AppendSubscriptionClosureSettlementCommand,
  type CreateSubscriptionClosureCaseCommand
} from "../src/subscription-closure/subscription-closure.repository";

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
    const transitioned = await readCommitted(prisma, (tx) =>
      repository.appendEvent(tx, {
        actorId: earlyData.actorId,
        afterStatus: "RETURN_INSPECTION",
        closureCaseId: early.outcome.id,
        detailSnapshot: { reason: "vehicle arrived" },
        eventType: "STATUS_TRANSITIONED",
        expectedStatus: "PREPARING_RETURN",
        expectedVersion: 0,
        occurredAt: NOW,
        source: source("early-transition-event")
      })
    );
    const normal = await readCommitted(prisma, (tx) =>
      repository.createCase(tx, createCaseCommand(normalData, "normal-escalation"))
    );
    const escalated = await readCommitted(prisma, (tx) =>
      repository.escalateRecovery(tx, {
        actorId: normalData.actorId,
        closureCaseId: normal.outcome.id,
        detailSnapshot: { authority: "approved recovery escalation" },
        expectedStatus: "PREPARING_RETURN",
        expectedVersion: 0,
        occurredAt: NOW,
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
      readCommitted(prisma, (tx) =>
        repository.escalateRecovery(tx, {
          actorId: earlyData.actorId,
          closureCaseId: early.outcome.id,
          detailSnapshot: { forbidden: true },
          expectedStatus: "RETURN_INSPECTION",
          expectedVersion: 1,
          occurredAt: NOW,
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
      readCommitted(prisma, (tx) =>
        repository.appendEvent(tx, {
          actorId: normalData.actorId,
          afterStatus: "PENDING_SETTLEMENT",
          closureCaseId: normal.outcome.id,
          detailSnapshot: { forbidden: "pre-return-to-settlement" },
          eventType: "STATUS_TRANSITIONED",
          expectedStatus: "PAUSED",
          expectedVersion: 1,
          occurredAt: NOW,
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
        readCommitted(prisma, (tx) =>
          repository.appendEvent(tx, {
            actorId: recoveryData.actorId,
            afterStatus: target,
            closureCaseId: recovery.outcome.id,
            detailSnapshot: { forbidden: `assessment-pause-to-${target}` },
            eventType: "STATUS_TRANSITIONED",
            expectedStatus: "PAUSED",
            expectedVersion: 1,
            occurredAt: NOW,
            source: source(`paused-recovery-${target}`)
          })
        ),
        SUBSCRIPTION_CLOSURE_ERROR_CODE.STATUS_CONFLICT
      );
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
    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.createCase(tx, {
          ...createCaseCommand(futureCreateData, "event-time-future-create"),
          effectiveAt: new Date("2099-01-01T00:00:00.000Z")
        })
      ),
      SUBSCRIPTION_CLOSURE_ERROR_CODE.INVALID_COMMAND
    );
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
        readCommitted(prisma, (tx) =>
          repository.appendEvent(tx, {
            actorId: data.actorId,
            afterStatus: closureType === "NORMAL_COMPLETION" ? "COMPLETED" : "TERMINATED",
            closureCaseId: created.outcome.id,
            detailSnapshot: { invalid: "missing settled final authority" },
            eventType: "STATUS_TRANSITIONED",
            expectedStatus: "PENDING_SETTLEMENT",
            expectedVersion: 1,
            occurredAt: NOW,
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
    const manifestR1 = await readCommitted(prisma, (tx) =>
      repository.appendDocumentRevision(
        tx,
        documentCommand(data, created.outcome.id, {
          documentType: "RETURN_MANIFEST",
          expectedVersion: 1,
          key: "manifest-r1"
        })
      )
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
    handoverWorkOrderId: randomUUID(),
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
    await tx.contractESignTask.deleteMany({ where: { id: fixture.contractESignTaskId } });
    await tx.assetWorkOrder.deleteMany({ where: { id: { in: fixture.assetWorkOrderIds } } });
    await tx.fileObject.deleteMany({
      where: { id: { in: [fixture.sourceFileId, fixture.signedFileId] } }
    });
    await tx.vehicleReturn.deleteMany({ where: { id: fixture.vehicleReturnId } });
    await tx.vehicleHandoverWorkOrder.deleteMany({ where: { id: fixture.handoverWorkOrderId } });
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
  const handoverIds = fixtures.map(({ handoverWorkOrderId }) => handoverWorkOrderId);
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
    prisma.contractESignTask.count({ where: { id: { in: esignIds } } }),
    prisma.fileObject.count({ where: { id: { in: fileIds } } }),
    prisma.vehicleReturn.count({ where: { id: { in: returnIds } } }),
    prisma.vehicleHandoverWorkOrder.count({ where: { id: { in: handoverIds } } }),
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
