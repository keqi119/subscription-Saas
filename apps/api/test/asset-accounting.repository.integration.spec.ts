import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditAction, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ASSET_ACCOUNTING_ERROR_CODE,
  AssetAccountingRepository,
  type AppendCostEntryCommand,
  type DecideExceptionApprovalCommand,
  type ExpireExceptionApprovalCommand,
  type RequestExceptionApprovalCommand,
  type RequireCurrentApprovedExceptionCommand,
  type ReverseCostEntryCommand
} from "../src/asset-accounting/asset-accounting.repository";
import {
  canonicalAssetAccountingJson,
  hashBusinessExceptionSnapshot
} from "../src/asset-accounting/asset-accounting.domain";
import {
  ASSET_ACCOUNTING_PERMISSION,
  AssetAccountingService,
  type AssetAccountingCommandContext
} from "../src/asset-accounting/asset-accounting.service";
import { AuditService } from "../src/audit/audit.service";
import { PrismaService } from "../src/prisma/prisma.service";

const TEST_DATABASE_URL = requiredTestDatabaseUrl();
const FIXTURE_PREFIX = `S1CC${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const CONFIRMED_AT = new Date("2026-08-20T10:00:00.000Z");

describe("AssetAccountingRepository PostgreSQL command behavior", () => {
  let prisma: PrismaService;
  let fixture: Fixture;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
    fixture = await createFixture(prisma);
  });

  afterAll(async () => {
    try {
      await deleteFixtures(prisma, fixture);
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it("rejects a real root client and SERIALIZABLE transaction", async () => {
    const repository = new AssetAccountingRepository();

    await expectCode(
      repository.appendCostEntry(
        prisma as unknown as Prisma.TransactionClient,
        appendCommand(fixture, "root")
      ),
      ASSET_ACCOUNTING_ERROR_CODE.TRANSACTION_REQUIRED
    );
    await expectCode(
      prisma.$transaction(
        (tx) => repository.appendCostEntry(tx, appendCommand(fixture, "serializable")),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      ),
      ASSET_ACCOUNTING_ERROR_CODE.TRANSACTION_REQUIRED
    );
  });

  it("serializes concurrent exact append replay on the exact source advisory lock", async () => {
    const repository = new AssetAccountingRepository();
    const command = appendCommand(fixture, "append-race");
    const holder = await holdCompletedCommand(prisma, (tx) =>
      repository.appendCostEntry(tx, command)
    );
    const replayPromise = readCommitted(prisma, (tx) => repository.appendCostEntry(tx, command));

    expect(await waitForDatabaseLock(prisma, "pg_advisory_xact_lock")).toBe(true);
    holder.release.resolve();
    const [first, replay] = await Promise.all([holder.result, replayPromise]);

    expect(first.wrote).toBe(true);
    expect(replay).toEqual({ outcome: first.outcome, wrote: false });
    expect(first.outcome).toMatchObject({
      confirmedAt: CONFIRMED_AT,
      confirmedBy: fixture.userId,
      sourceId: command.source.id,
      sourceKey: command.source.key,
      sourceType: command.source.type
    });
    expect(first.outcome).not.toHaveProperty("createdAt");
    expect(first.outcome).not.toHaveProperty("payloadHash");
    await expect(countReceipts(prisma, command.source)).resolves.toBe(1);
    await expect(countEntries(prisma, command.source)).resolves.toBe(1);
  });

  it("serializes a same-source append/reverse race and rejects cross-command ownership", async () => {
    const repository = new AssetAccountingRepository();
    const original = await readCommitted(prisma, (tx) =>
      repository.appendCostEntry(tx, appendCommand(fixture, "cross-command-original"))
    );
    const append = appendCommand(fixture, "cross-command-source");
    const holder = await holdCompletedCommand(prisma, (tx) =>
      repository.appendCostEntry(tx, append)
    );
    const reversePromise = settled(
      readCommitted(prisma, (tx) =>
        repository.reverseCostEntry(tx, {
          actorId: fixture.userId,
          confirmedAt: CONFIRMED_AT,
          originalEntryId: original.outcome.id,
          source: append.source
        })
      )
    );

    expect(await waitForDatabaseLock(prisma, "pg_advisory_xact_lock")).toBe(true);
    holder.release.resolve();
    await holder.result;
    expectConflict(
      rejectedValue(await reversePromise),
      ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT
    );
    await expect(countReceipts(prisma, append.source)).resolves.toBe(1);
  });

  it("lets the partial unique index arbitrate different-source double reversal", async () => {
    const repository = new AssetAccountingRepository();
    const original = await readCommitted(prisma, (tx) =>
      repository.appendCostEntry(tx, appendCommand(fixture, "double-reversal-original"))
    );
    const firstCommand = reverseCommand(fixture, original.outcome.id, "double-reversal-first");
    const holder = await holdCompletedCommand(prisma, (tx) =>
      repository.reverseCostEntry(tx, firstCommand)
    );
    const secondCommand = reverseCommand(fixture, original.outcome.id, "double-reversal-second");
    const secondPromise = settled(
      readCommitted(prisma, (tx) => repository.reverseCostEntry(tx, secondCommand))
    );

    expect(await waitForDatabaseLock(prisma, "vehicle_cost_ledger_entry")).toBe(true);
    holder.release.resolve();
    await holder.result;
    expectConflict(
      rejectedValue(await secondPromise),
      ASSET_ACCOUNTING_ERROR_CODE.REVERSAL_ALREADY_EXISTS
    );
    await expect(
      prisma.vehicleCostLedgerEntry.count({
        where: { reversalOfEntryId: original.outcome.id }
      })
    ).resolves.toBe(1);
    await expect(countReceipts(prisma, secondCommand.source)).resolves.toBe(0);
  });

  it("uses NOWAIT for held authority rows while unrelated authorities stay independent", async () => {
    const repository = new AssetAccountingRepository();
    const holderReady = deferred<void>();
    const releaseHolder = deferred<void>();
    const holder = readCommitted(prisma, async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "vehicle" WHERE "id" = ${fixture.vehicleId}::uuid FOR UPDATE`
      );
      holderReady.resolve();
      await releaseHolder.promise;
    });
    void holder.catch(holderReady.reject);
    await holderReady.promise;

    const blockedCommand = appendCommand(fixture, "held-authority");
    const unrelatedCommand: AppendCostEntryCommand = {
      ...appendCommand(fixture, "unrelated-authority"),
      assetOwnerId: null,
      assetOwnerSnapshot: null,
      contractId: null,
      customerId: null,
      evidenceId: null,
      evidenceSnapshot: null,
      orderId: null,
      responsiblePartyId: null,
      vehicleId: fixture.otherVehicleId,
      workOrderId: null
    };
    try {
      await expectCode(
        readCommitted(prisma, (tx) => repository.appendCostEntry(tx, blockedCommand)),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_BUSY
      );
      const unrelated = await readCommitted(prisma, (tx) =>
        repository.appendCostEntry(tx, unrelatedCommand)
      );
      expect(unrelated).toMatchObject({
        outcome: {
          assetOwnerId: null,
          contractId: null,
          customerId: null,
          evidenceId: null,
          orderId: null,
          responsiblePartyId: null,
          workOrderId: null
        },
        wrote: true
      });
      await expect(
        prisma.vehicleCostLedgerEntry.findUnique({ where: { id: unrelated.outcome.id } })
      ).resolves.toMatchObject({
        assetOwnerId: null,
        contractId: null,
        customerId: null,
        evidenceId: null,
        orderId: null,
        workOrderId: null
      });
    } finally {
      releaseHolder.resolve();
      await holder;
    }
  });

  it("locks a contract authoritative order when orderId is omitted and preserves null", async () => {
    const repository = new AssetAccountingRepository();
    const command: AppendCostEntryCommand = {
      ...appendCommand(fixture, "contract-authoritative-order"),
      assetOwnerId: null,
      assetOwnerSnapshot: null,
      customerId: null,
      evidenceId: null,
      evidenceSnapshot: null,
      orderId: null,
      responsiblePartyId: null,
      workOrderId: null
    };
    const ready = deferred<void>();
    const release = deferred<void>();
    const holder = readCommitted(prisma, async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_order" WHERE "id" = ${fixture.orderId}::uuid FOR UPDATE`
      );
      ready.resolve();
      await release.promise;
    });
    void holder.catch(ready.reject);
    await ready.promise;
    try {
      await expectCode(
        readCommitted(prisma, (tx) => repository.appendCostEntry(tx, command)),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_BUSY
      );
    } finally {
      release.resolve();
      await holder;
    }

    const created = await readCommitted(prisma, (tx) => repository.appendCostEntry(tx, command));
    expect(created.outcome.orderId).toBeNull();
    await expect(
      prisma.vehicleCostLedgerEntry.findUniqueOrThrow({ where: { id: created.outcome.id } })
    ).resolves.toMatchObject({ orderId: null });

    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.appendCostEntry(tx, {
          ...command,
          source: {
            ...command.source,
            id: randomUUID(),
            key: `${FIXTURE_PREFIX}:contract-authoritative-order-mismatch`
          },
          vehicleId: fixture.otherVehicleId
        })
      ),
      ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_MISMATCH
    );
  });

  it("takes a NOWAIT share lock on the original row before reversing", async () => {
    const repository = new AssetAccountingRepository();
    const original = await readCommitted(prisma, (tx) =>
      repository.appendCostEntry(tx, appendCommand(fixture, "original-lock-original"))
    );
    const ready = deferred<void>();
    const release = deferred<void>();
    const holder = readCommitted(prisma, async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "vehicle_cost_ledger_entry" WHERE "id" = ${original.outcome.id}::uuid FOR UPDATE`
      );
      ready.resolve();
      await release.promise;
    });
    void holder.catch(ready.reject);
    await ready.promise;

    try {
      await expectCode(
        readCommitted(prisma, (tx) =>
          repository.reverseCostEntry(
            tx,
            reverseCommand(fixture, original.outcome.id, "original-lock-reverse")
          )
        ),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_BUSY
      );
    } finally {
      release.resolve();
      await holder;
    }
  });

  it("takes a NOWAIT share lock on the original work order before reversing", async () => {
    const repository = new AssetAccountingRepository();
    const original = await readCommitted(prisma, (tx) =>
      repository.appendCostEntry(tx, appendCommand(fixture, "work-order-lock-original"))
    );
    const ready = deferred<void>();
    const release = deferred<void>();
    const holder = readCommitted(prisma, async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "asset_work_order" WHERE "id" = ${fixture.workOrderId}::uuid FOR UPDATE`
      );
      ready.resolve();
      await release.promise;
    });
    void holder.catch(ready.reject);
    await ready.promise;

    try {
      await expectCode(
        readCommitted(prisma, (tx) =>
          repository.reverseCostEntry(
            tx,
            reverseCommand(fixture, original.outcome.id, "work-order-lock-reverse")
          )
        ),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_BUSY
      );
    } finally {
      release.resolve();
      await holder;
    }
  });

  it("rolls back both immutable entry and receipt when the caller transaction aborts", async () => {
    const repository = new AssetAccountingRepository();
    const command = appendCommand(fixture, "caller-rollback");

    await expect(
      readCommitted(prisma, async (tx) => {
        await repository.appendCostEntry(tx, command);
        throw new Error("ROLLBACK_FIXTURE");
      })
    ).rejects.toThrow("ROLLBACK_FIXTURE");

    await expect(countEntries(prisma, command.source)).resolves.toBe(0);
    await expect(countReceipts(prisma, command.source)).resolves.toBe(0);
  });

  it("rejects missing/deleted/mismatched authority facts without inference", async () => {
    const repository = new AssetAccountingRepository();
    const missing: AppendCostEntryCommand = {
      ...appendCommand(fixture, "missing-authority"),
      vehicleId: randomUUID()
    };
    await expectCode(
      readCommitted(prisma, (tx) => repository.appendCostEntry(tx, missing)),
      ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_FOUND
    );

    await prisma.vehicle.update({
      data: { deletedAt: CONFIRMED_AT },
      where: { id: fixture.otherVehicleId }
    });
    try {
      const deleted: AppendCostEntryCommand = {
        ...appendCommand(fixture, "deleted-authority"),
        assetOwnerId: null,
        assetOwnerSnapshot: null,
        contractId: null,
        customerId: null,
        evidenceId: null,
        evidenceSnapshot: null,
        orderId: null,
        responsiblePartyId: null,
        vehicleId: fixture.otherVehicleId,
        workOrderId: null
      };
      await expectCode(
        readCommitted(prisma, (tx) => repository.appendCostEntry(tx, deleted)),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_LIVE
      );
    } finally {
      await prisma.vehicle.update({
        data: { deletedAt: null },
        where: { id: fixture.otherVehicleId }
      });
    }

    const mismatch = appendCommand(fixture, "mismatched-authority");
    await prisma.subscriptionOrder.update({
      data: { vehicleId: fixture.otherVehicleId },
      where: { id: fixture.orderId }
    });
    try {
      await expectCode(
        readCommitted(prisma, (tx) => repository.appendCostEntry(tx, mismatch)),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_MISMATCH
      );
    } finally {
      await prisma.subscriptionOrder.update({
        data: { vehicleId: fixture.vehicleId },
        where: { id: fixture.orderId }
      });
    }

    const successorId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "asset_work_order_evidence" (
          "id", "work_order_id", "action", "evidence_type", "file_id", "file_bucket",
          "file_object_key", "file_size_bytes", "file_mime_type", "content_sha256",
          "supersedes_evidence_id", "source_type", "source_id", "source_key"
        ) VALUES (
          ${successorId}::uuid, ${fixture.workOrderId}::uuid, 'SUPERSEDE', 'PHOTO', ${randomUUID()}::uuid,
          'fixture', ${`${FIXTURE_PREFIX}/successor.jpg`}, 1, 'image/jpeg', ${"b".repeat(64)},
          ${fixture.evidenceId}::uuid, 'FIXTURE', ${randomUUID()}::uuid, ${`${FIXTURE_PREFIX}:successor`}
        )
      `);
    });
    try {
      await expectCode(
        readCommitted(prisma, (tx) =>
          repository.appendCostEntry(tx, appendCommand(fixture, "superseded-evidence"))
        ),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_LIVE
      );
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.assetWorkOrderEvidence.delete({ where: { id: successorId } });
      });
    }
  });

  it("accepts effective SUPERSEDE evidence and rejects a REMOVE tombstone", async () => {
    const repository = new AssetAccountingRepository();
    const attachedId = randomUUID();
    const supersedeId = randomUUID();
    const removeId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "asset_work_order_evidence" (
          "id", "work_order_id", "action", "evidence_type", "file_id", "file_bucket",
          "file_object_key", "file_size_bytes", "file_mime_type", "content_sha256",
          "supersedes_evidence_id", "source_type", "source_id", "source_key"
        ) VALUES
          (${attachedId}::uuid, ${fixture.workOrderId}::uuid, 'ATTACH', 'PHOTO', ${randomUUID()}::uuid,
           'fixture', ${`${FIXTURE_PREFIX}/liveness-attach.jpg`}, 1, 'image/jpeg', ${"c".repeat(64)},
           NULL, 'FIXTURE', ${randomUUID()}::uuid, ${`${FIXTURE_PREFIX}:liveness-attach`}),
          (${supersedeId}::uuid, ${fixture.workOrderId}::uuid, 'SUPERSEDE', 'PHOTO', ${randomUUID()}::uuid,
           'fixture', ${`${FIXTURE_PREFIX}/liveness-supercede.jpg`}, 1, 'image/jpeg', ${"d".repeat(64)},
           ${attachedId}::uuid, 'FIXTURE', ${randomUUID()}::uuid, ${`${FIXTURE_PREFIX}:liveness-supercede`})
      `);
    });

    const effective = await readCommitted(prisma, (tx) =>
      repository.appendCostEntry(tx, {
        ...appendCommand(fixture, "effective-supercede"),
        evidenceId: supersedeId,
        evidenceSnapshot: { evidenceId: supersedeId }
      })
    );
    expect(effective.outcome.evidenceId).toBe(supersedeId);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "asset_work_order_evidence" (
          "id", "work_order_id", "action", "evidence_type", "file_id", "file_bucket",
          "file_object_key", "file_size_bytes", "file_mime_type", "content_sha256",
          "supersedes_evidence_id", "source_type", "source_id", "source_key"
        ) VALUES (
          ${removeId}::uuid, ${fixture.workOrderId}::uuid, 'REMOVE', 'PHOTO', NULL,
          NULL, NULL, NULL, NULL, NULL,
          ${supersedeId}::uuid, 'FIXTURE', ${randomUUID()}::uuid, ${`${FIXTURE_PREFIX}:liveness-remove`}
        )
      `);
    });
    await expectCode(
      readCommitted(prisma, (tx) =>
        repository.appendCostEntry(tx, {
          ...appendCommand(fixture, "remove-tombstone"),
          evidenceId: removeId,
          evidenceSnapshot: { evidenceId: removeId }
        })
      ),
      ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_NOT_LIVE
    );
  });

  it("rejects raw ledger and receipt UPDATE/DELETE with SQLSTATE 55000", async () => {
    const repository = new AssetAccountingRepository();
    const command = appendCommand(fixture, "raw-immutability");
    const created = await readCommitted(prisma, (tx) => repository.appendCostEntry(tx, command));
    const receipt = await prisma.assetAccountingCommandReceipt.findUniqueOrThrow({
      where: {
        sourceType_sourceId_sourceKey: {
          sourceId: command.source.id,
          sourceKey: command.source.key,
          sourceType: command.source.type
        }
      }
    });

    for (const statement of [
      Prisma.sql`UPDATE "vehicle_cost_ledger_entry" SET "accounting_period" = '2026-09' WHERE "id" = ${created.outcome.id}::uuid`,
      Prisma.sql`DELETE FROM "vehicle_cost_ledger_entry" WHERE "id" = ${created.outcome.id}::uuid`,
      Prisma.sql`UPDATE "asset_accounting_command_receipt" SET "source_key" = 'changed' WHERE "id" = ${receipt.id}::uuid`,
      Prisma.sql`DELETE FROM "asset_accounting_command_receipt" WHERE "id" = ${receipt.id}::uuid`
    ]) {
      await expect(prisma.$executeRaw(statement)).rejects.toSatisfy(
        (error) => databaseErrorCode(error) === "55000"
      );
    }
  });

  it("enforces named reversal shape, equality, reference, and reverse-of-reversal constraints", async () => {
    const repository = new AssetAccountingRepository();
    const original = await readCommitted(prisma, (tx) =>
      repository.appendCostEntry(tx, appendCommand(fixture, "raw-constraints-original"))
    );

    await expect(
      rawReversal(prisma, original.outcome.id, {
        amountCents: -99n,
        costCategory: "REPAIR",
        id: randomUUID(),
        key: `${FIXTURE_PREFIX}:raw:amount`
      })
    ).rejects.toSatisfy(
      (error) => databaseConstraint(error) === "vehicle_cost_ledger_entry_reversal_amount_chk"
    );
    await expect(
      rawReversal(prisma, original.outcome.id, {
        amountCents: -100n,
        costCategory: "CLEANING",
        id: randomUUID(),
        key: `${FIXTURE_PREFIX}:raw:reference`
      })
    ).rejects.toSatisfy(
      (error) => databaseConstraint(error) === "vehicle_cost_ledger_entry_reversal_reference_chk"
    );

    for (const [suffix, drift] of [
      ["occurred-on", { occurredOn: new Date("2026-08-18T00:00:00.000Z") }],
      ["accounting-period", { accountingPeriod: "2026-07" }]
    ] as const) {
      const id = randomUUID();
      try {
        await expect(
          rawReversal(prisma, original.outcome.id, {
            amountCents: -100n,
            costCategory: "REPAIR",
            id,
            key: `${FIXTURE_PREFIX}:raw:${suffix}`,
            ...drift
          })
        ).rejects.toSatisfy(
          (error) =>
            databaseConstraint(error) === "vehicle_cost_ledger_entry_reversal_reference_chk"
        );
      } finally {
        await forceDeleteLedgerEntry(prisma, id);
      }
    }

    const valid = await readCommitted(prisma, (tx) =>
      repository.reverseCostEntry(
        tx,
        reverseCommand(fixture, original.outcome.id, "raw-constraints-valid")
      )
    );
    await expect(
      rawReversal(prisma, valid.outcome.id, {
        amountCents: 100n,
        costCategory: "REPAIR",
        id: randomUUID(),
        key: `${FIXTURE_PREFIX}:raw:reverse-of-reversal`
      })
    ).rejects.toSatisfy(
      (error) => databaseConstraint(error) === "vehicle_cost_ledger_entry_reverse_of_reversal_chk"
    );
    await expect(
      rawReversal(prisma, original.outcome.id, {
        amountCents: -100n,
        costCategory: "REPAIR",
        id: randomUUID(),
        key: `${FIXTURE_PREFIX}:raw:duplicate`
      })
    ).rejects.toSatisfy(
      (error) => databaseConstraint(error) === "vehicle_cost_ledger_entry_reversal_of_entry_id_key"
    );
  });

  it("enforces the remaining named ledger and receipt shape constraints with zero residue", async () => {
    const repository = new AssetAccountingRepository();
    const template = await readCommitted(prisma, (tx) =>
      repository.appendCostEntry(tx, appendCommand(fixture, "raw-shapes-template"))
    );
    const cases: Array<{
      expected: string;
      run: () => Promise<unknown>;
    }> = [
      {
        expected: "vehicle_cost_ledger_entry_kind_amount_shape_chk",
        run: () =>
          rawOriginal(prisma, template.outcome.id, {
            accountingPeriod: "2026-08",
            amountCents: -1n,
            key: `${FIXTURE_PREFIX}:raw-shape:kind`,
            sourceType: "RAW_FIXTURE"
          })
      },
      {
        expected: "vehicle_cost_ledger_entry_accounting_period_chk",
        run: () =>
          rawOriginal(prisma, template.outcome.id, {
            accountingPeriod: "2026-13",
            amountCents: 1n,
            key: `${FIXTURE_PREFIX}:raw-shape:period`,
            sourceType: "RAW_FIXTURE"
          })
      },
      {
        expected: "vehicle_cost_ledger_entry_source_key_not_blank_chk",
        run: () =>
          rawOriginal(prisma, template.outcome.id, {
            accountingPeriod: "2026-08",
            amountCents: 1n,
            key: `${FIXTURE_PREFIX}:raw-shape:source`,
            sourceType: " "
          })
      },
      {
        expected: "asset_accounting_command_receipt_payload_hash_chk",
        run: () =>
          rawReceipt(prisma, template.outcome.id, {
            key: `${FIXTURE_PREFIX}:raw-shape:receipt-hash`,
            payloadHash: "bad",
            sourceType: "RAW_FIXTURE",
            withTarget: true
          })
      },
      {
        expected: "asset_accounting_command_receipt_source_key_not_blank_chk",
        run: () =>
          rawReceipt(prisma, template.outcome.id, {
            key: `${FIXTURE_PREFIX}:raw-shape:receipt-source`,
            payloadHash: "c".repeat(64),
            sourceType: " ",
            withTarget: true
          })
      },
      {
        expected: "asset_accounting_command_receipt_target_shape_chk",
        run: () =>
          rawReceipt(prisma, template.outcome.id, {
            key: `${FIXTURE_PREFIX}:raw-shape:receipt-target`,
            payloadHash: "c".repeat(64),
            sourceType: "RAW_FIXTURE",
            withTarget: false
          })
      }
    ];

    for (const testCase of cases) {
      await expect(testCase.run()).rejects.toSatisfy(
        (error) => databaseConstraint(error) === testCase.expected
      );
    }
    await expect(
      prisma.vehicleCostLedgerEntry.count({
        where: { sourceKey: { startsWith: `${FIXTURE_PREFIX}:raw-shape:` } }
      })
    ).resolves.toBe(0);
    await expect(
      prisma.assetAccountingCommandReceipt.count({
        where: { sourceKey: { startsWith: `${FIXTURE_PREFIX}:raw-shape:` } }
      })
    ).resolves.toBe(0);
  });

  it("reverses after normal historical authority drift while retaining frozen dimensions", async () => {
    const repository = new AssetAccountingRepository();
    const original = await readCommitted(prisma, (tx) =>
      repository.appendCostEntry(tx, appendCommand(fixture, "historical-drift-original"))
    );
    const successorId = randomUUID();
    await prisma.subscriptionOrder.update({
      data: { vehicleId: fixture.otherVehicleId },
      where: { id: fixture.orderId }
    });
    await prisma.assetOwner.update({
      data: { status: "INACTIVE" },
      where: { id: fixture.assetOwnerId }
    });
    await prisma.assetWorkOrder.update({
      data: { status: "CANCELLED" },
      where: { id: fixture.workOrderId }
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "asset_work_order_evidence" (
          "id", "work_order_id", "action", "evidence_type", "file_id", "file_bucket",
          "file_object_key", "file_size_bytes", "file_mime_type", "content_sha256",
          "supersedes_evidence_id", "source_type", "source_id", "source_key"
        ) VALUES (
          ${successorId}::uuid, ${fixture.workOrderId}::uuid, 'SUPERSEDE', 'PHOTO', ${randomUUID()}::uuid,
          'fixture', ${`${FIXTURE_PREFIX}/historical-successor.jpg`}, 1, 'image/jpeg', ${"f".repeat(64)},
          ${fixture.evidenceId}::uuid, 'FIXTURE', ${randomUUID()}::uuid, ${`${FIXTURE_PREFIX}:historical-successor`}
        )
      `);
    });
    try {
      const reversal = await readCommitted(prisma, (tx) =>
        repository.reverseCostEntry(
          tx,
          reverseCommand(fixture, original.outcome.id, "historical-drift-reverse")
        )
      );
      expect(reversal.outcome).toMatchObject({
        accountingPeriod: original.outcome.accountingPeriod,
        evidenceId: original.outcome.evidenceId,
        occurredOn: original.outcome.occurredOn,
        orderId: original.outcome.orderId,
        vehicleId: original.outcome.vehicleId,
        workOrderId: original.outcome.workOrderId
      });
    } finally {
      await prisma.subscriptionOrder.update({
        data: { vehicleId: fixture.vehicleId },
        where: { id: fixture.orderId }
      });
      await prisma.assetOwner.update({
        data: { status: "ACTIVE" },
        where: { id: fixture.assetOwnerId }
      });
      await prisma.assetWorkOrder.update({
        data: { status: "PENDING_COST_CONFIRMATION" },
        where: { id: fixture.workOrderId }
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.assetWorkOrderEvidence.delete({ where: { id: successorId } });
      });
    }
  });

  it("commits stale approved expiry, exactly replays it, and creates no duplicate receipt", async () => {
    const repository = new AssetAccountingRepository();
    const requestCommand = requestApprovalCommand(fixture, "approval-stale-request");
    const request = await readCommitted(prisma, (tx) =>
      repository.requestExceptionApproval(tx, requestCommand)
    );
    const approveCommand = decideApprovalCommand(
      fixture,
      request.outcome.id,
      "approval-stale-approve"
    );
    const approved = await readCommitted(prisma, (tx) =>
      repository.decideExceptionApproval(tx, approveCommand)
    );
    const requireCommand = requireCurrentCommand(
      fixture,
      approved.outcome.id,
      approved.outcome.version,
      "approval-stale-require",
      { factRevision: 2, state: "CHANGED" }
    );

    const stale = await readCommitted(prisma, (tx) =>
      repository.requireCurrentApprovedException(tx, requireCommand)
    );
    const replay = await readCommitted(prisma, (tx) =>
      repository.requireCurrentApprovedException(tx, requireCommand)
    );

    expect(stale).toMatchObject({
      expiredApproval: { status: "EXPIRED", version: 2 },
      valid: false
    });
    expect(replay).toEqual(stale);
    await expect(
      prisma.businessExceptionApproval.findUniqueOrThrow({ where: { id: approved.outcome.id } })
    ).resolves.toMatchObject({ status: "EXPIRED", version: 2 });
    await expect(countReceipts(prisma, requireCommand.source)).resolves.toBe(1);
    await expect(
      prisma.businessExceptionApproval.count({
        where: { requestSourceKey: { startsWith: FIXTURE_PREFIX } }
      })
    ).resolves.toBe(1);
  });

  it("rolls back both a requested approval and its receipt when the caller aborts", async () => {
    const repository = new AssetAccountingRepository();
    const command = requestApprovalCommand(fixture, "approval-request-caller-rollback");
    const abort = new Error("abort request fixture transaction");

    await expect(
      readCommitted(prisma, async (tx) => {
        await repository.requestExceptionApproval(tx, command);
        throw abort;
      })
    ).rejects.toBe(abort);
    await expect(
      prisma.businessExceptionApproval.count({
        where: { requestSourceKey: command.source.key }
      })
    ).resolves.toBe(0);
    await expect(countReceipts(prisma, command.source)).resolves.toBe(0);
  });

  it("rolls back a decision to PENDING v0 with no decision receipt when the caller aborts", async () => {
    const repository = new AssetAccountingRepository();
    const request = await readCommitted(prisma, (tx) =>
      repository.requestExceptionApproval(
        tx,
        requestApprovalCommand(fixture, "approval-decision-rollback-request")
      )
    );
    const command = decideApprovalCommand(
      fixture,
      request.outcome.id,
      "approval-decision-caller-rollback"
    );
    const abort = new Error("abort decision fixture transaction");

    await expect(
      readCommitted(prisma, async (tx) => {
        await repository.decideExceptionApproval(tx, command);
        throw abort;
      })
    ).rejects.toBe(abort);
    await expect(
      prisma.businessExceptionApproval.findUniqueOrThrow({ where: { id: request.outcome.id } })
    ).resolves.toMatchObject({ decision: null, status: "PENDING", version: 0 });
    await expect(countReceipts(prisma, command.source)).resolves.toBe(0);
    await readCommitted(prisma, (tx) =>
      repository.expireExceptionApproval(
        tx,
        expireApprovalCommand(fixture, request.outcome.id, 0, "approval-decision-rollback-cleanup")
      )
    );
  });

  it("rolls back expiry from both PENDING and APPROVED with no expiry receipt", async () => {
    const repository = new AssetAccountingRepository();

    for (const priorStatus of ["PENDING", "APPROVED"] as const) {
      const request = await readCommitted(prisma, (tx) =>
        repository.requestExceptionApproval(
          tx,
          requestApprovalCommand(fixture, `approval-${priorStatus}-expiry-rollback-request`)
        )
      );
      const prior =
        priorStatus === "APPROVED"
          ? await readCommitted(prisma, (tx) =>
              repository.decideExceptionApproval(
                tx,
                decideApprovalCommand(
                  fixture,
                  request.outcome.id,
                  `approval-${priorStatus}-expiry-rollback-approve`
                )
              )
            )
          : request;
      const command = expireApprovalCommand(
        fixture,
        prior.outcome.id,
        prior.outcome.version,
        `approval-${priorStatus}-expiry-caller-rollback`
      );
      const abort = new Error(`abort ${priorStatus} expiry fixture transaction`);

      await expect(
        readCommitted(prisma, async (tx) => {
          await repository.expireExceptionApproval(tx, command);
          throw abort;
        })
      ).rejects.toBe(abort);
      await expect(
        prisma.businessExceptionApproval.findUniqueOrThrow({ where: { id: prior.outcome.id } })
      ).resolves.toMatchObject({
        status: priorStatus,
        version: prior.outcome.version
      });
      await expect(countReceipts(prisma, command.source)).resolves.toBe(0);
      await readCommitted(prisma, (tx) =>
        repository.expireExceptionApproval(
          tx,
          expireApprovalCommand(
            fixture,
            prior.outcome.id,
            prior.outcome.version,
            `approval-${priorStatus}-expiry-rollback-cleanup`
          )
        )
      );
    }
  });

  it("rolls back a decision when its immutable receipt loses a real unique race", async () => {
    const repository = new AssetAccountingRepository();
    const request = await readCommitted(prisma, (tx) =>
      repository.requestExceptionApproval(
        tx,
        requestApprovalCommand(fixture, "approval-receipt-failure-request")
      )
    );
    const command = decideApprovalCommand(
      fixture,
      request.outcome.id,
      "approval-decision-receipt-failure"
    );
    const receiptTargetRequestCommand = {
      ...requestApprovalCommand(fixture, "approval-receipt-failure-target-request"),
      subject: {
        ...approvalSubject(fixture),
        subjectField: "fixtureReceiptFailureTarget"
      }
    };
    const receiptTarget = await readCommitted(prisma, (tx) =>
      repository.requestExceptionApproval(tx, receiptTargetRequestCommand)
    );
    await readCommitted(prisma, (tx) =>
      repository.expireExceptionApproval(tx, {
        ...expireApprovalCommand(
          fixture,
          receiptTarget.outcome.id,
          0,
          "approval-receipt-failure-target-expire"
        ),
        subject: receiptTargetRequestCommand.subject
      })
    );
    const rawReady = deferred<void>();
    const releaseRaw = deferred<void>();
    const rawReceipt = readCommitted(prisma, async (tx) => {
      await tx.assetAccountingCommandReceipt.create({
        data: {
          actorId: fixture.userId,
          approvalId: receiptTarget.outcome.id,
          commandType: "EXCEPTION_REQUEST",
          costEntryId: null,
          id: randomUUID(),
          outcomeSnapshot: {},
          payloadHash: "a".repeat(64),
          payloadSnapshot: {},
          sourceId: command.source.id,
          sourceKey: command.source.key,
          sourceType: command.source.type
        }
      });
      rawReady.resolve();
      await releaseRaw.promise;
    });
    void rawReceipt.catch(rawReady.reject);
    await rawReady.promise;

    const decision = settled(
      readCommitted(prisma, (tx) => repository.decideExceptionApproval(tx, command))
    );
    const waitedForReceipt = await waitForDatabaseLock(prisma, "asset_accounting_command_receipt");
    releaseRaw.resolve();
    await rawReceipt;
    const decisionResult = await decision;

    expect(waitedForReceipt).toBe(true);
    expectConflict(rejectedValue(decisionResult), ASSET_ACCOUNTING_ERROR_CODE.SOURCE_CONFLICT);
    await expect(
      prisma.businessExceptionApproval.findUniqueOrThrow({ where: { id: request.outcome.id } })
    ).resolves.toMatchObject({ decision: null, status: "PENDING", version: 0 });
    await expect(
      prisma.assetAccountingCommandReceipt.count({
        where: {
          commandType: "EXCEPTION_DECIDE",
          sourceId: command.source.id,
          sourceKey: command.source.key,
          sourceType: command.source.type
        }
      })
    ).resolves.toBe(0);
    await readCommitted(prisma, (tx) =>
      repository.expireExceptionApproval(
        tx,
        expireApprovalCommand(fixture, request.outcome.id, 0, "approval-receipt-failure-cleanup")
      )
    );
  });

  it("serializes different-source requests on the shared subject lock and leaves one live approval", async () => {
    const repository = new AssetAccountingRepository();
    const firstCommand = requestApprovalCommand(fixture, "approval-request-race-first");
    const holder = await holdCompletedCommand(prisma, (tx) =>
      repository.requestExceptionApproval(tx, firstCommand)
    );
    const secondCommand = requestApprovalCommand(fixture, "approval-request-race-second");
    const secondPromise = settled(
      readCommitted(prisma, (tx) => repository.requestExceptionApproval(tx, secondCommand))
    );

    expect(await waitForDatabaseLock(prisma, "pg_advisory_xact_lock")).toBe(true);
    holder.release.resolve();
    const first = await holder.result;
    expectConflict(
      rejectedValue(await secondPromise),
      ASSET_ACCOUNTING_ERROR_CODE.APPROVAL_ALREADY_LIVE
    );
    await expect(
      prisma.businessExceptionApproval.count({
        where: {
          status: { in: ["PENDING", "APPROVED"] },
          subjectField: first.outcome.subjectField,
          subjectId: first.outcome.subjectId,
          subjectSnapshotHash: first.outcome.subjectSnapshotHash,
          subjectType: first.outcome.subjectType
        }
      })
    ).resolves.toBe(1);
    await expect(countReceipts(prisma, firstCommand.source)).resolves.toBe(1);
    await expect(countReceipts(prisma, secondCommand.source)).resolves.toBe(0);
    await readCommitted(prisma, (tx) =>
      repository.expireExceptionApproval(
        tx,
        expireApprovalCommand(
          fixture,
          first.outcome.id,
          first.outcome.version,
          "approval-request-race-cleanup"
        )
      )
    );
  });

  it("serializes case-only source UUID retries as one request write and one exact replay", async () => {
    const repository = new AssetAccountingRepository();
    const command = requestApprovalCommand(fixture, "approval-source-case-retry");
    const holder = await holdCompletedCommand(prisma, (tx) =>
      repository.requestExceptionApproval(tx, command)
    );
    const retryPromise = readCommitted(prisma, (tx) =>
      repository.requestExceptionApproval(tx, {
        ...command,
        source: { ...command.source, id: command.source.id.toUpperCase() }
      })
    );

    expect(await waitForDatabaseLock(prisma, "pg_advisory_xact_lock")).toBe(true);
    holder.release.resolve();
    const [first, retry] = await Promise.all([holder.result, retryPromise]);
    expect(first.wrote).toBe(true);
    expect(retry).toEqual({ outcome: first.outcome, wrote: false });
    await expect(countReceipts(prisma, command.source)).resolves.toBe(1);
    await expect(
      prisma.businessExceptionApproval.count({
        where: { requestSourceKey: command.source.key }
      })
    ).resolves.toBe(1);
    await readCommitted(prisma, (tx) =>
      repository.expireExceptionApproval(
        tx,
        expireApprovalCommand(
          fixture,
          first.outcome.id,
          first.outcome.version,
          "approval-source-case-cleanup"
        )
      )
    );
  });

  it("uses source-first owning-fact composition for revision, exact retry, and a racing decision", async () => {
    const repository = new AssetAccountingRepository();
    const initialRemark = `${FIXTURE_PREFIX}:approval-fact-v1`;
    const revisedRemark = `${FIXTURE_PREFIX}:approval-fact-v2`;
    await prisma.vehicle.update({
      data: { remark: initialRemark },
      where: { id: fixture.vehicleId }
    });
    const requestCommand = requestApprovalCommand(fixture, "approval-fact-revision-request");
    const request = await readCommitted(prisma, async (tx) => {
      await repository.lockBusinessExceptionSourceAndSubject(
        tx,
        requestCommand.source,
        requestCommand.subject
      );
      const authoritySnapshot = await lockVehicleRemarkSnapshot(tx, fixture.vehicleId);
      return repository.requestExceptionApproval(tx, { ...requestCommand, authoritySnapshot });
    });
    const expiryCommand = expireApprovalCommand(
      fixture,
      request.outcome.id,
      0,
      "approval-fact-revision-expire"
    );
    const revisionReady = deferred<RequireCurrentApprovedExceptionCommand["authoritySnapshot"]>();
    const releaseRevision = deferred<void>();
    const revisionResult = readCommitted(prisma, async (tx) => {
      await repository.lockBusinessExceptionSourceAndSubject(
        tx,
        expiryCommand.source,
        expiryCommand.subject
      );
      await lockVehicleRemarkSnapshot(tx, fixture.vehicleId);
      await tx.vehicle.update({
        data: { remark: revisedRemark },
        where: { id: fixture.vehicleId }
      });
      const authoritySnapshot = await currentVehicleRemarkSnapshot(tx, fixture.vehicleId);
      revisionReady.resolve(authoritySnapshot);
      await releaseRevision.promise;
      const expiry = await repository.expireExceptionApproval(tx, expiryCommand);
      return { authoritySnapshot, expiry };
    });
    void revisionResult.catch(revisionReady.reject);
    const revisedSnapshot = await revisionReady.promise;
    expect(revisedSnapshot).toEqual({ remark: revisedRemark });

    const retryPromise = readCommitted(prisma, (tx) =>
      repository.expireExceptionApproval(tx, expiryCommand)
    );
    const decisionCommand = decideApprovalCommand(
      fixture,
      request.outcome.id,
      "approval-fact-revision-decision"
    );
    const decisionPromise = settled(
      readCommitted(prisma, async (tx) => {
        await repository.lockBusinessExceptionSourceAndSubject(
          tx,
          decisionCommand.source,
          decisionCommand.subject
        );
        const authoritySnapshot = await lockVehicleRemarkSnapshot(tx, fixture.vehicleId);
        return repository.decideExceptionApproval(tx, {
          ...decisionCommand,
          authoritySnapshot
        });
      })
    );

    expect(await waitForDatabaseLockCount(prisma, "pg_advisory_xact_lock", 2)).toBe(true);
    releaseRevision.resolve();
    const [revision, retry, decision] = await Promise.all([
      revisionResult,
      retryPromise,
      decisionPromise
    ]);
    expect(revision.expiry.outcome).toMatchObject({ status: "EXPIRED", version: 1 });
    expect(retry).toEqual({ outcome: revision.expiry.outcome, wrote: false });
    expectConflict(rejectedValue(decision), ASSET_ACCOUNTING_ERROR_CODE.APPROVAL_VERSION_CONFLICT);
    await expect(countReceipts(prisma, decisionCommand.source)).resolves.toBe(0);
    await expect(countReceipts(prisma, expiryCommand.source)).resolves.toBe(1);
    await expect(
      prisma.businessExceptionApproval.findUniqueOrThrow({ where: { id: request.outcome.id } })
    ).resolves.toMatchObject({ status: "EXPIRED", version: 1 });
    await expect(
      prisma.vehicle.findUniqueOrThrow({ where: { id: fixture.vehicleId } })
    ).resolves.toMatchObject({ remark: revisedRemark });
  });

  it("uses FOR UPDATE NOWAIT for an existing approval row", async () => {
    const repository = new AssetAccountingRepository();
    const request = await readCommitted(prisma, (tx) =>
      repository.requestExceptionApproval(
        tx,
        requestApprovalCommand(fixture, "approval-nowait-request")
      )
    );
    const ready = deferred<void>();
    const release = deferred<void>();
    const holder = readCommitted(prisma, async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "business_exception_approval" WHERE "id" = ${request.outcome.id}::uuid FOR UPDATE`
      );
      ready.resolve();
      await release.promise;
    });
    void holder.catch(ready.reject);
    await ready.promise;

    try {
      await expectCode(
        readCommitted(prisma, (tx) =>
          repository.decideExceptionApproval(
            tx,
            decideApprovalCommand(fixture, request.outcome.id, "approval-nowait-decision")
          )
        ),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_BUSY
      );
    } finally {
      release.resolve();
      await holder;
    }
    await readCommitted(prisma, (tx) =>
      repository.expireExceptionApproval(
        tx,
        expireApprovalCommand(fixture, request.outcome.id, 0, "approval-nowait-cleanup")
      )
    );
  });

  it("normalizes the real Prisma adapter shape for the live-approval partial unique index", async () => {
    const repository = new AssetAccountingRepository();
    const command = requestApprovalCommand(fixture, "approval-live-index-contender");
    const rawApprovalId = randomUUID();
    const requestEvidenceSnapshot = JSON.parse(
      canonicalAssetAccountingJson(command.requestEvidenceSnapshot)
    ) as Prisma.InputJsonObject;
    const subjectSnapshot = JSON.parse(
      canonicalAssetAccountingJson(command.authoritySnapshot)
    ) as Prisma.InputJsonObject;
    const rawReady = deferred<void>();
    const releaseRaw = deferred<void>();
    const rawHolder = readCommitted(prisma, async (tx) => {
      await tx.businessExceptionApproval.create({
        data: {
          approvalNo: `BEA-${rawApprovalId}`,
          exceptionType: command.exceptionType,
          id: rawApprovalId,
          requestEvidenceSnapshot,
          requestReason: "unregistered writer fixture",
          requestSourceId: randomUUID(),
          requestSourceKey: `${FIXTURE_PREFIX}:approval-live-index-holder`,
          requestSourceType: "RAW_FIXTURE",
          requestedAt: command.requestedAt,
          requestedBy: fixture.userId,
          status: "PENDING",
          subjectField: command.subject.subjectField,
          subjectId: command.subject.subjectId,
          subjectSnapshot,
          subjectSnapshotHash: hashBusinessExceptionSnapshot(command.authoritySnapshot),
          subjectType: command.subject.subjectType,
          version: 0
        }
      });
      rawReady.resolve();
      await releaseRaw.promise;
    });
    void rawHolder.catch(rawReady.reject);
    await rawReady.promise;

    let observedAdapterError: unknown;
    const contender = settled(
      readCommitted(prisma, (tx) =>
        repository.requestExceptionApproval(
          observeApprovalCreateError(tx, (error) => {
            observedAdapterError = error;
          }),
          command
        )
      )
    );
    expect(await waitForDatabaseLock(prisma, "business_exception_approval")).toBe(true);
    releaseRaw.resolve();
    await rawHolder;
    const normalized = rejectedValue(await contender);

    expect(observedAdapterError).toMatchObject({
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: {
            constraint: {
              fields: ["subject_type", "subject_id", "subject_field", "subject_snapshot_hash"]
            },
            kind: "UniqueConstraintViolation",
            originalCode: "23505",
            originalMessage:
              'duplicate key value violates unique constraint "business_exception_approval_live_subject_field_snapshot_key"'
          }
        }
      }
    });
    expectConflict(normalized, ASSET_ACCOUNTING_ERROR_CODE.APPROVAL_ALREADY_LIVE);
    await expect(countReceipts(prisma, command.source)).resolves.toBe(0);
    await readCommitted(prisma, (tx) =>
      repository.expireExceptionApproval(
        tx,
        expireApprovalCommand(fixture, rawApprovalId, 0, "approval-live-index-cleanup")
      )
    );
  });

  it("audits service append, replay, reverse, reads, and summaries with exact request context", async () => {
    const service = realService(prisma);
    const appendRepositoryCommand = appendCommand(fixture, "service-cost-append");
    const append = omitFields(appendRepositoryCommand, "actorId");
    const appendContext = serviceContext(
      fixture.userId,
      ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM,
      append.source.key
    );

    const created = await service.appendCost(append, appendContext);
    const replay = await service.appendCost(append, appendContext);
    expect(replay).toEqual(created);
    expect(created).toMatchObject({
      amountCents: "100",
      confirmedAt: CONFIRMED_AT.toISOString(),
      occurredOn: "2026-08-19T00:00:00.000Z"
    });
    expect(created).not.toHaveProperty("wrote");
    expect(created).not.toHaveProperty("receipt");

    const appendAudits = await prisma.auditLog.findMany({
      where: {
        action: AuditAction.CREATE,
        entityId: created.id,
        entityType: "vehicle_cost_ledger_entry",
        module: "asset_accounting"
      }
    });
    expect(appendAudits).toHaveLength(1);
    expect(appendAudits[0]).toMatchObject({
      ipAddress: "203.0.113.18",
      operatorId: fixture.userId,
      userAgent: "asset-accounting-integration"
    });
    expect(appendAudits[0]?.afterSnapshot).toEqual({
      fact: created,
      permission: ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM,
      reason: "Confirmed ACTUAL_COST vehicle cost fact.",
      requestContext: {
        idempotencyKey: append.source.key,
        ipAddress: "203.0.113.18",
        requestId: `${FIXTURE_PREFIX}:request`,
        userAgent: "asset-accounting-integration"
      },
      snapshotHash: hashBusinessExceptionSnapshot(created),
      source: append.source
    });

    const readContext = serviceContext(fixture.userId, ASSET_ACCOUNTING_PERMISSION.COST_VIEW);
    await expect(service.getEntry(created.id, readContext)).resolves.toEqual(created);
    await expect(
      service.listVehicleEntries(fixture.vehicleId, readContext)
    ).resolves.toContainEqual(created);
    await expect(service.listOrderEntries(fixture.orderId, readContext)).resolves.toContainEqual(
      created
    );
    await expect(
      service.listWorkOrderEntries(fixture.workOrderId, readContext)
    ).resolves.toContainEqual(created);
    await expect(
      service.summarizeOrderCostFacts(fixture.orderId, readContext)
    ).resolves.toMatchObject({
      byActionType: { ACTUAL_COST: { amountCents: expect.any(String) } },
      totalAmountCents: expect.any(String)
    });

    const reverseRepositoryCommand = reverseCommand(fixture, created.id, "service-cost-reverse");
    const reverse = omitFields(reverseRepositoryCommand, "actorId");
    const reversed = await service.reverseCost(
      reverse,
      serviceContext(fixture.userId, ASSET_ACCOUNTING_PERMISSION.COST_REVERSE, reverse.source.key)
    );
    expect(reversed).toMatchObject({
      amountCents: "-100",
      entryKind: "REVERSAL",
      reversalOfEntryId: created.id
    });
    const reverseAudits = await prisma.auditLog.findMany({
      where: {
        action: AuditAction.CREATE,
        entityId: reversed.id,
        entityType: "vehicle_cost_ledger_entry",
        module: "asset_accounting"
      }
    });
    expect(reverseAudits).toHaveLength(1);
    expect(reverseAudits[0]).toMatchObject({
      ipAddress: "203.0.113.18",
      operatorId: fixture.userId,
      userAgent: "asset-accounting-integration"
    });
    expect(reverseAudits[0]?.afterSnapshot).toEqual({
      fact: reversed,
      permission: ASSET_ACCOUNTING_PERMISSION.COST_REVERSE,
      reason: `Reversed vehicle cost fact ${created.id}.`,
      requestContext: {
        idempotencyKey: reverse.source.key,
        ipAddress: "203.0.113.18",
        requestId: `${FIXTURE_PREFIX}:request`,
        userAgent: "asset-accounting-integration"
      },
      snapshotHash: hashBusinessExceptionSnapshot(reversed),
      source: reverse.source
    });
  });

  it("audits internal request, decide, automatic expiry, and exact replay without public comments", async () => {
    const service = realService(prisma);
    const requestRepositoryCommand = requestApprovalCommand(fixture, "service-approval-request");
    const request = omitFields(requestRepositoryCommand, "authoritySnapshot", "requestedBy");
    const requestContext = serviceContext(
      fixture.userId,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST,
      request.source.key
    );
    const requestAuthoritySnapshot = await currentVehicleRemarkSnapshot(prisma, fixture.vehicleId);
    const requested = await readCommitted(prisma, (tx) =>
      service.requestApprovalInTransaction(tx, request, requestContext, (resolverTx) =>
        lockVehicleRemarkSnapshot(resolverTx, fixture.vehicleId)
      )
    );
    const requestReplay = await readCommitted(prisma, (tx) =>
      service.requestApprovalInTransaction(tx, request, requestContext, (resolverTx) =>
        lockVehicleRemarkSnapshot(resolverTx, fixture.vehicleId)
      )
    );
    expect(requestReplay).toEqual(requested);
    expect(requested).not.toHaveProperty("decisionComment");

    const decisionRepositoryCommand = decideApprovalCommand(
      fixture,
      requested.id,
      "service-approval-decision"
    );
    const decision = omitFields(decisionRepositoryCommand, "authoritySnapshot", "decidedBy");
    const decisionContext = serviceContext(
      fixture.deciderId,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE,
      decision.source.key
    );
    const decisionAuthoritySnapshot = await currentVehicleRemarkSnapshot(prisma, fixture.vehicleId);
    const decided = await readCommitted(prisma, (tx) =>
      service.decideApprovalInTransaction(tx, decision, decisionContext, (resolverTx) =>
        lockVehicleRemarkSnapshot(resolverTx, fixture.vehicleId)
      )
    );
    expect(decided).toMatchObject({ decision: "APPROVED", status: "APPROVED" });
    expect(decided).not.toHaveProperty("decisionComment");

    const requireRepositoryCommand = requireCurrentCommand(
      fixture,
      requested.id,
      decided.version,
      "service-approval-require",
      { ignoredClientSnapshot: true }
    );
    const requireCommand = omitFields(requireRepositoryCommand, "authoritySnapshot", "expiredBy");
    const requireContext = serviceContext(
      fixture.deciderId,
      ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST,
      requireCommand.source.key
    );
    let staleAuthoritySnapshot:
      | Awaited<ReturnType<typeof currentVehicleRemarkSnapshot>>
      | undefined;
    const stale = await readCommitted(prisma, (tx) =>
      service.requireApprovedExceptionInTransaction(
        tx,
        requireCommand,
        requireContext,
        async (resolverTx) => {
          await lockVehicleRemarkSnapshot(resolverTx, fixture.vehicleId);
          await resolverTx.vehicle.update({
            data: { remark: `${FIXTURE_PREFIX}:service-stale` },
            where: { id: fixture.vehicleId }
          });
          staleAuthoritySnapshot = await currentVehicleRemarkSnapshot(
            resolverTx,
            fixture.vehicleId
          );
          return staleAuthoritySnapshot;
        }
      )
    );
    expect(stale).toBe(false);
    const staleReplay = await readCommitted(prisma, (tx) =>
      service.requireApprovedExceptionInTransaction(
        tx,
        requireCommand,
        requireContext,
        (resolverTx) => lockVehicleRemarkSnapshot(resolverTx, fixture.vehicleId)
      )
    );
    expect(staleReplay).toBe(false);

    const audits = await prisma.auditLog.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: { entityId: requested.id, module: "asset_accounting" }
    });
    expect(audits.map(({ action }) => action)).toEqual([
      AuditAction.CREATE,
      AuditAction.APPROVE,
      AuditAction.UPDATE
    ]);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: requested.id,
          entityType: "business_exception_approval",
          ipAddress: "203.0.113.18",
          module: "asset_accounting",
          operatorId: fixture.userId,
          userAgent: "asset-accounting-integration"
        }),
        expect.objectContaining({
          entityId: requested.id,
          entityType: "business_exception_approval",
          ipAddress: "203.0.113.18",
          module: "asset_accounting",
          operatorId: fixture.deciderId,
          userAgent: "asset-accounting-integration"
        })
      ])
    );
    expect(audits[0]?.beforeSnapshot).toBeNull();
    expect(audits[0]?.afterSnapshot).toEqual({
      fact: requested,
      permission: ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST,
      reason: request.requestReason,
      requestContext: {
        idempotencyKey: request.source.key,
        ipAddress: "203.0.113.18",
        requestId: `${FIXTURE_PREFIX}:request`,
        userAgent: "asset-accounting-integration"
      },
      snapshotHash: hashBusinessExceptionSnapshot(requestAuthoritySnapshot),
      source: request.source
    });
    expect(audits[1]).toMatchObject({
      ipAddress: "203.0.113.18",
      operatorId: fixture.deciderId,
      userAgent: "asset-accounting-integration"
    });
    expect(audits[1]?.beforeSnapshot).toEqual(requested);
    expect(audits[1]?.afterSnapshot).toEqual({
      fact: decided,
      permission: ASSET_ACCOUNTING_PERMISSION.EXCEPTION_APPROVE,
      reason: decision.decisionComment,
      requestContext: {
        idempotencyKey: decision.source.key,
        ipAddress: "203.0.113.18",
        requestId: `${FIXTURE_PREFIX}:request`,
        userAgent: "asset-accounting-integration"
      },
      snapshotHash: hashBusinessExceptionSnapshot(decisionAuthoritySnapshot),
      source: decision.source
    });
    expect(audits[2]).toMatchObject({
      entityId: requested.id,
      entityType: "business_exception_approval",
      ipAddress: "203.0.113.18",
      module: "asset_accounting",
      operatorId: fixture.deciderId,
      userAgent: "asset-accounting-integration"
    });
    expect(audits[2]?.beforeSnapshot).toEqual(decided);
    expect(audits[2]?.afterSnapshot).toMatchObject({
      fact: expect.objectContaining({
        id: requested.id,
        status: "EXPIRED",
        version: 2
      }),
      permission: ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST,
      reason: requireCommand.expiryReason,
      requestContext: {
        idempotencyKey: requireCommand.source.key,
        ipAddress: "203.0.113.18",
        requestId: `${FIXTURE_PREFIX}:request`,
        userAgent: "asset-accounting-integration"
      },
      snapshotHash: hashBusinessExceptionSnapshot(staleAuthoritySnapshot),
      source: requireCommand.source
    });
    expect(
      JSON.stringify(
        audits.map(
          ({ afterSnapshot }) => (afterSnapshot as { fact?: unknown } | null)?.fact ?? null
        )
      )
    ).not.toContain("fixture approval reviewed");
  });

  it("rolls back service cost and approval writes completely when audit fails", async () => {
    const auditFailure = new Error("SERVICE_AUDIT_FAILURE");
    const failingAudit = { write: async () => Promise.reject(auditFailure) } as AuditService;
    const service = realService(prisma, failingAudit);
    const appendRepositoryCommand = appendCommand(fixture, "service-audit-failure-cost");
    const append = omitFields(appendRepositoryCommand, "actorId");

    await expect(
      service.appendCost(
        append,
        serviceContext(fixture.userId, ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM, append.source.key)
      )
    ).rejects.toBe(auditFailure);
    await expect(countEntries(prisma, append.source)).resolves.toBe(0);
    await expect(countReceipts(prisma, append.source)).resolves.toBe(0);

    const requestRepositoryCommand = requestApprovalCommand(
      fixture,
      "service-audit-failure-approval"
    );
    const request = omitFields(requestRepositoryCommand, "authoritySnapshot", "requestedBy");
    await expect(
      readCommitted(prisma, (tx) =>
        service.requestApprovalInTransaction(
          tx,
          request,
          serviceContext(
            fixture.userId,
            ASSET_ACCOUNTING_PERMISSION.EXCEPTION_REQUEST,
            request.source.key
          ),
          (resolverTx) => lockVehicleRemarkSnapshot(resolverTx, fixture.vehicleId)
        )
      )
    ).rejects.toBe(auditFailure);
    await expect(
      prisma.businessExceptionApproval.count({
        where: { requestSourceKey: request.source.key }
      })
    ).resolves.toBe(0);
    await expect(countReceipts(prisma, request.source)).resolves.toBe(0);
  });

  it("returns a stable NOWAIT loser while the holder transaction remains usable", async () => {
    const service = realService(prisma);
    const ready = deferred<void>();
    const continueHolder = deferred<void>();
    const holderUsable = deferred<void>();
    const release = deferred<void>();
    const holder = readCommitted(prisma, async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "vehicle" WHERE "id" = ${fixture.vehicleId}::uuid FOR UPDATE`
      );
      ready.resolve();
      await continueHolder.promise;
      await tx.$queryRaw`SELECT 1`;
      holderUsable.resolve();
      await release.promise;
    });
    void holder.catch(ready.reject);
    await ready.promise;

    const appendRepositoryCommand = appendCommand(fixture, "service-nowait-loser");
    const append = omitFields(appendRepositoryCommand, "actorId");
    try {
      await expectCode(
        service.appendCost(
          append,
          serviceContext(
            fixture.userId,
            ASSET_ACCOUNTING_PERMISSION.COST_CONFIRM,
            append.source.key
          )
        ),
        ASSET_ACCOUNTING_ERROR_CODE.AUTHORITY_BUSY
      );
      continueHolder.resolve();
      await holderUsable.promise;
    } finally {
      release.resolve();
      await holder;
    }
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function appendCommand(fixtureValue: Fixture, suffix: string): AppendCostEntryCommand {
  return {
    actionType: "ACTUAL_COST",
    accountingPeriod: "2026-08",
    actorId: fixtureValue.userId,
    amountCents: 100n,
    assetOwnerId: fixtureValue.assetOwnerId,
    assetOwnerSnapshot: { ownerNo: fixtureValue.ownerNo },
    confirmedAt: CONFIRMED_AT,
    contractId: fixtureValue.contractId,
    costCategory: "REPAIR",
    customerId: fixtureValue.customerId,
    evidenceId: fixtureValue.evidenceId,
    evidenceSnapshot: { evidenceKey: fixtureValue.evidenceKey },
    occurredOn: new Date("2026-08-19T00:00:00.000Z"),
    orderId: fixtureValue.orderId,
    responsiblePartyId: fixtureValue.customerId,
    responsiblePartyType: "CUSTOMER",
    responsibilitySnapshot: { basis: "inspection", fixture: FIXTURE_PREFIX },
    source: { id: randomUUID(), key: `${FIXTURE_PREFIX}:${suffix}`, type: "ASSET_WORK_ORDER" },
    vehicleId: fixtureValue.vehicleId,
    workOrderId: fixtureValue.workOrderId
  };
}

function reverseCommand(
  fixtureValue: Fixture,
  originalEntryId: string,
  suffix: string
): ReverseCostEntryCommand {
  return {
    actorId: fixtureValue.userId,
    confirmedAt: new Date("2026-08-20T11:00:00.000Z"),
    originalEntryId,
    source: { id: randomUUID(), key: `${FIXTURE_PREFIX}:${suffix}`, type: "ASSET_WORK_ORDER" }
  };
}

function approvalSubject(fixtureValue: Fixture) {
  return {
    subjectField: "fixtureApprovalField",
    subjectId: fixtureValue.vehicleId,
    subjectType: "VEHICLE" as const
  };
}

function requestApprovalCommand(
  fixtureValue: Fixture,
  suffix: string
): RequestExceptionApprovalCommand {
  return {
    authoritySnapshot: { factRevision: 1, state: "PENDING" },
    exceptionType: "HANDOVER_EVIDENCE_EXCEPTION",
    requestEvidenceSnapshot: { evidenceRevision: 1 },
    requestReason: "fixture exception requires review",
    requestedAt: CONFIRMED_AT,
    requestedBy: fixtureValue.userId,
    source: { id: randomUUID(), key: `${FIXTURE_PREFIX}:${suffix}`, type: "HANDOVER_FIXTURE" },
    subject: approvalSubject(fixtureValue)
  };
}

function decideApprovalCommand(
  fixtureValue: Fixture,
  approvalId: string,
  suffix: string
): DecideExceptionApprovalCommand {
  return {
    approvalId,
    authoritySnapshot: { factRevision: 1, state: "PENDING" },
    decidedAt: new Date("2026-08-20T10:10:00.000Z"),
    decidedBy: fixtureValue.deciderId,
    decision: "APPROVED",
    decisionComment: "fixture approval reviewed",
    exceptionType: "HANDOVER_EVIDENCE_EXCEPTION",
    expectedVersion: 0,
    source: { id: randomUUID(), key: `${FIXTURE_PREFIX}:${suffix}`, type: "HANDOVER_FIXTURE" },
    subject: approvalSubject(fixtureValue)
  };
}

function expireApprovalCommand(
  fixtureValue: Fixture,
  approvalId: string,
  expectedVersion: number,
  suffix: string
): ExpireExceptionApprovalCommand {
  return {
    approvalId,
    exceptionType: "HANDOVER_EVIDENCE_EXCEPTION",
    expectedVersion,
    expiredAt: new Date("2026-08-20T10:20:00.000Z"),
    expiredBy: fixtureValue.deciderId,
    expiryReason: "authoritative snapshot changed",
    source: { id: randomUUID(), key: `${FIXTURE_PREFIX}:${suffix}`, type: "HANDOVER_FIXTURE" },
    subject: approvalSubject(fixtureValue)
  };
}

function requireCurrentCommand(
  fixtureValue: Fixture,
  approvalId: string,
  expectedVersion: number,
  suffix: string,
  authoritySnapshot: RequireCurrentApprovedExceptionCommand["authoritySnapshot"]
): RequireCurrentApprovedExceptionCommand {
  return {
    ...expireApprovalCommand(fixtureValue, approvalId, expectedVersion, suffix),
    authoritySnapshot
  };
}

async function createFixture(prisma: PrismaService) {
  const fixture = {
    assetOwnerId: randomUUID(),
    contractId: randomUUID(),
    customerId: randomUUID(),
    deciderId: randomUUID(),
    evidenceId: randomUUID(),
    evidenceKey: `${FIXTURE_PREFIX}:evidence`,
    orderId: randomUUID(),
    otherVehicleId: randomUUID(),
    ownerNo: `${FIXTURE_PREFIX}-OWNER`,
    userId: randomUUID(),
    vehicleId: randomUUID(),
    workOrderId: randomUUID()
  };
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "user" ("id", "username", "name", "password_hash", "updated_at")
      VALUES
        (${fixture.userId}::uuid, ${`${FIXTURE_PREFIX.toLowerCase()}_operator`}, 'Stage 1C-C Operator', 'not-used-by-test', CURRENT_TIMESTAMP),
        (${fixture.deciderId}::uuid, ${`${FIXTURE_PREFIX.toLowerCase()}_decider`}, 'Stage 1C-C Decider', 'not-used-by-test', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle" ("id", "vehicle_no", "brand", "model_definition_id", "purchase_price_amount", "updated_at")
      VALUES
        (${fixture.vehicleId}::uuid, ${`${FIXTURE_PREFIX}-VEHICLE`}, 'TEST', ${randomUUID()}::uuid, 1000000, CURRENT_TIMESTAMP),
        (${fixture.otherVehicleId}::uuid, ${`${FIXTURE_PREFIX}-OTHER`}, 'TEST', ${randomUUID()}::uuid, 1000000, CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "customer" ("id", "customer_no", "name", "mobile", "updated_at")
      VALUES (${fixture.customerId}::uuid, ${`${FIXTURE_PREFIX}-CUSTOMER`}, 'Stage 1C-C Customer', '13000000000', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_order" (
        "id", "order_no", "customer_id", "application_id", "quote_id", "vehicle_id",
        "product_id", "product_version_id", "vehicle_purchase_price_amount", "monthly_fee_amount",
        "deposit_amount", "period_months", "mileage_limit_km", "over_mileage_fee_amount",
        "model_definition_id_snapshot", "model_code_snapshot", "model_display_name_snapshot", "quote_snapshot", "updated_at"
      ) VALUES (
        ${fixture.orderId}::uuid, ${`${FIXTURE_PREFIX}-ORDER`}, ${fixture.customerId}::uuid,
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${fixture.vehicleId}::uuid,
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1000000, 10000, 100000, 6, 10000, 100,
        ${randomUUID()}::uuid, 'TEST-MODEL', 'Test Model', '{}'::jsonb, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "contract" (
        "id", "contract_no", "order_id", "customer_id", "contract_version_id", "contract_title", "contract_snapshot", "updated_at"
      ) VALUES (
        ${fixture.contractId}::uuid, ${`${FIXTURE_PREFIX}-CONTRACT`}, ${fixture.orderId}::uuid,
        ${fixture.customerId}::uuid, ${randomUUID()}::uuid, 'Stage 1C-C Contract', '{}'::jsonb, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "subscription_order" SET "contract_id" = ${fixture.contractId}::uuid
      WHERE "id" = ${fixture.orderId}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "asset_owner" ("id", "owner_no", "name", "owner_type", "status", "updated_at")
      VALUES (${fixture.assetOwnerId}::uuid, ${fixture.ownerNo}, 'Stage 1C-C Owner', 'PLATFORM', 'ACTIVE', CURRENT_TIMESTAMP)
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "asset_work_order" (
        "id", "work_order_no", "vehicle_id", "order_id", "contract_id", "customer_id",
        "asset_owner_id", "work_order_type", "status", "cost_confirmation_required",
        "create_source_type", "create_source_id", "create_source_key", "authority_snapshot", "updated_at"
      ) VALUES (
        ${fixture.workOrderId}::uuid, ${`${FIXTURE_PREFIX}-WORK`}, ${fixture.vehicleId}::uuid,
        ${fixture.orderId}::uuid, ${fixture.contractId}::uuid, ${fixture.customerId}::uuid,
        ${fixture.assetOwnerId}::uuid, 'MAINTENANCE', 'PENDING_COST_CONFIRMATION', TRUE,
        'FIXTURE', ${randomUUID()}::uuid, ${`${FIXTURE_PREFIX}:work-order`}, '{}'::jsonb, CURRENT_TIMESTAMP
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "asset_work_order_evidence" (
        "id", "work_order_id", "action", "evidence_type", "file_id", "file_bucket",
        "file_object_key", "file_size_bytes", "file_mime_type", "content_sha256",
        "source_type", "source_id", "source_key"
      ) VALUES (
        ${fixture.evidenceId}::uuid, ${fixture.workOrderId}::uuid, 'ATTACH', 'PHOTO', ${randomUUID()}::uuid,
        'fixture', ${`${FIXTURE_PREFIX}/evidence.jpg`}, 1, 'image/jpeg', ${"a".repeat(64)},
        'FIXTURE', ${randomUUID()}::uuid, ${fixture.evidenceKey}
      )
    `);
  });
  return fixture;
}

async function deleteFixtures(prisma: PrismaService, fixtureValue: Fixture) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.auditLog.deleteMany({
      where: {
        module: "asset_accounting",
        operatorId: { in: [fixtureValue.userId, fixtureValue.deciderId] }
      }
    });
    await tx.$executeRaw`
      DELETE FROM "asset_accounting_command_receipt"
      WHERE "source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "business_exception_approval"
      WHERE "request_source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "vehicle_cost_ledger_entry"
      WHERE "source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "asset_work_order_evidence"
      WHERE "source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "asset_work_order"
      WHERE "create_source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "asset_owner"
      WHERE "owner_no" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
    await tx.$executeRaw`
      DELETE FROM "contract"
      WHERE "contract_no" LIKE ${`${FIXTURE_PREFIX}%`}
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

function realService(prisma: PrismaService, audit = new AuditService(prisma)) {
  return new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
}

function serviceContext(
  actorId: string,
  permission: string,
  idempotencyKey?: string
): AssetAccountingCommandContext {
  return {
    actorId,
    idempotencyKey,
    ipAddress: "203.0.113.18",
    permissions: [permission],
    requestId: `${FIXTURE_PREFIX}:request`,
    userAgent: "asset-accounting-integration"
  };
}

function omitFields<T extends object, K extends keyof T>(
  value: T,
  ...keys: readonly K[]
): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key as K))
  ) as Omit<T, K>;
}

async function rawReversal(
  prisma: PrismaService,
  originalEntryId: string,
  input: {
    accountingPeriod?: string;
    amountCents: bigint;
    costCategory: "CLEANING" | "REPAIR";
    id: string;
    key: string;
    occurredOn?: Date;
  }
) {
  const original = await prisma.vehicleCostLedgerEntry.findUniqueOrThrow({
    where: { id: originalEntryId }
  });
  return prisma.$executeRaw(Prisma.sql`
    INSERT INTO "vehicle_cost_ledger_entry" (
      "id", "vehicle_id", "order_id", "contract_id", "customer_id", "asset_owner_id",
      "work_order_id", "evidence_id", "asset_owner_snapshot", "evidence_snapshot",
      "responsibility_snapshot", "entry_kind", "action_type", "cost_category", "amount_cents",
      "responsible_party_type", "responsible_party_id", "occurred_on", "accounting_period",
      "confirmed_at", "confirmed_by", "reversal_of_entry_id", "source_type", "source_id", "source_key"
    ) VALUES (
      ${input.id}::uuid, ${original.vehicleId}::uuid, ${original.orderId}::uuid,
      ${original.contractId}::uuid, ${original.customerId}::uuid, ${original.assetOwnerId}::uuid,
      ${original.workOrderId}::uuid, ${original.evidenceId}::uuid, ${JSON.stringify(original.assetOwnerSnapshot)}::jsonb,
      ${JSON.stringify(original.evidenceSnapshot)}::jsonb, ${JSON.stringify(original.responsibilitySnapshot)}::jsonb,
      'REVERSAL', ${original.actionType}::vehicle_cost_action_type,
      ${input.costCategory}::vehicle_cost_category, ${input.amountCents},
      ${original.responsiblePartyType}::vehicle_cost_responsible_party_type,
      ${original.responsiblePartyId}::uuid, ${input.occurredOn ?? original.occurredOn}::date,
      ${input.accountingPeriod ?? original.accountingPeriod},
      ${CONFIRMED_AT}::timestamptz, ${original.confirmedBy}::uuid, ${originalEntryId}::uuid,
      'RAW_FIXTURE', ${randomUUID()}::uuid, ${input.key}
    )
  `);
}

async function forceDeleteLedgerEntry(prisma: PrismaService, entryId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "vehicle_cost_ledger_entry" WHERE "id" = ${entryId}::uuid`
    );
  });
}

async function rawOriginal(
  prisma: PrismaService,
  templateEntryId: string,
  input: {
    accountingPeriod: string;
    amountCents: bigint;
    key: string;
    sourceType: string;
  }
) {
  const original = await prisma.vehicleCostLedgerEntry.findUniqueOrThrow({
    where: { id: templateEntryId }
  });
  return prisma.$executeRaw(Prisma.sql`
    INSERT INTO "vehicle_cost_ledger_entry" (
      "id", "vehicle_id", "order_id", "contract_id", "customer_id", "asset_owner_id",
      "work_order_id", "evidence_id", "asset_owner_snapshot", "evidence_snapshot",
      "responsibility_snapshot", "entry_kind", "action_type", "cost_category", "amount_cents",
      "responsible_party_type", "responsible_party_id", "occurred_on", "accounting_period",
      "confirmed_at", "confirmed_by", "reversal_of_entry_id", "source_type", "source_id", "source_key"
    ) VALUES (
      ${randomUUID()}::uuid, ${original.vehicleId}::uuid, ${original.orderId}::uuid,
      ${original.contractId}::uuid, ${original.customerId}::uuid, ${original.assetOwnerId}::uuid,
      ${original.workOrderId}::uuid, ${original.evidenceId}::uuid, ${JSON.stringify(original.assetOwnerSnapshot)}::jsonb,
      ${JSON.stringify(original.evidenceSnapshot)}::jsonb, ${JSON.stringify(original.responsibilitySnapshot)}::jsonb,
      'ORIGINAL', ${original.actionType}::vehicle_cost_action_type,
      ${original.costCategory}::vehicle_cost_category, ${input.amountCents},
      ${original.responsiblePartyType}::vehicle_cost_responsible_party_type,
      ${original.responsiblePartyId}::uuid, ${original.occurredOn}::date, ${input.accountingPeriod},
      ${CONFIRMED_AT}::timestamptz, ${original.confirmedBy}::uuid, NULL,
      ${input.sourceType}, ${randomUUID()}::uuid, ${input.key}
    )
  `);
}

async function rawReceipt(
  prisma: PrismaService,
  costEntryId: string,
  input: {
    key: string;
    payloadHash: string;
    sourceType: string;
    withTarget: boolean;
  }
) {
  const costEntry = await prisma.vehicleCostLedgerEntry.findUniqueOrThrow({
    where: { id: costEntryId }
  });
  return prisma.$executeRaw(Prisma.sql`
    INSERT INTO "asset_accounting_command_receipt" (
      "id", "source_type", "source_id", "source_key", "command_type", "payload_hash",
      "payload_snapshot", "outcome_snapshot", "cost_entry_id", "approval_id", "actor_id"
    ) VALUES (
      ${randomUUID()}::uuid, ${input.sourceType}, ${randomUUID()}::uuid, ${input.key}, 'COST_APPEND',
      ${input.payloadHash}, '{}'::jsonb, '{}'::jsonb,
      ${input.withTarget ? costEntryId : null}::uuid, NULL, ${costEntry.confirmedBy}::uuid
    )
  `);
}

function readCommitted<T>(
  prisma: PrismaService,
  callback: (tx: Prisma.TransactionClient) => Promise<T>
) {
  return prisma.$transaction(callback, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 10_000,
    timeout: 20_000
  });
}

function observeApprovalCreateError(
  tx: Prisma.TransactionClient,
  observe: (error: unknown) => void
) {
  const approvalDelegate = new Proxy(tx.businessExceptionApproval, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "create" && typeof value === "function") {
        return async (...args: unknown[]) => {
          try {
            return await value.apply(target, args);
          } catch (error) {
            observe(error);
            throw error;
          }
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return new Proxy(tx, {
    get(target, property) {
      if (property === "businessExceptionApproval") return approvalDelegate;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function holdCompletedCommand<T>(
  prisma: PrismaService,
  callback: (tx: Prisma.TransactionClient) => Promise<T>
) {
  const ready = deferred<T>();
  const release = deferred<void>();
  const result = readCommitted(prisma, async (tx) => {
    const outcome = await callback(tx);
    ready.resolve(outcome);
    await release.promise;
    return outcome;
  });
  void result.catch(ready.reject);
  await ready.promise;
  return { release, result };
}

async function lockVehicleRemarkSnapshot(tx: Prisma.TransactionClient, vehicleId: string) {
  const [vehicle] = await tx.$queryRaw<Array<{ remark: string | null }>>(Prisma.sql`
    SELECT "remark"
    FROM "vehicle"
    WHERE "id" = ${vehicleId}::uuid
    FOR UPDATE NOWAIT
  `);
  if (!vehicle) throw new Error("missing vehicle fact fixture");
  return { remark: vehicle.remark };
}

async function currentVehicleRemarkSnapshot(tx: Prisma.TransactionClient, vehicleId: string) {
  const vehicle = await tx.vehicle.findUniqueOrThrow({
    select: { remark: true },
    where: { id: vehicleId }
  });
  return { remark: vehicle.remark };
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

async function waitForDatabaseLockCount(
  prisma: PrismaService,
  queryFragment: string,
  minimumCount: number
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [status] = await prisma.$queryRaw<Array<{ waitingCount: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS "waitingCount"
      FROM pg_stat_activity
      WHERE "pid" <> pg_backend_pid()
        AND "datname" = current_database()
        AND "state" = 'active'
        AND "wait_event_type" = 'Lock'
        AND "query" ILIKE ${`%${queryFragment}%`}
    `);
    if (Number(status?.waitingCount ?? 0n) >= minimumCount) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function countEntries(prisma: PrismaService, source: AppendCostEntryCommand["source"]) {
  return prisma.vehicleCostLedgerEntry.count({
    where: { sourceId: source.id, sourceKey: source.key, sourceType: source.type }
  });
}

function countReceipts(prisma: PrismaService, source: AppendCostEntryCommand["source"]) {
  return prisma.assetAccountingCommandReceipt.count({
    where: { sourceId: source.id, sourceKey: source.key, sourceType: source.type }
  });
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
  if (result.status === "fulfilled") throw new Error("Expected rejection");
  return result.reason;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected conflict ${code}`);
  } catch (error) {
    expectConflict(error, code);
  }
}

function expectConflict(error: unknown, code: string) {
  expect(error).toBeInstanceOf(ConflictException);
  expect((error as ConflictException).getResponse()).toMatchObject({ code });
}

function databaseErrorCode(error: unknown) {
  return collectStrings(error).find((value) =>
    ["23505", "23514", "55000", "55P03"].includes(value)
  );
}

function databaseConstraint(error: unknown) {
  const strings = collectStrings(error);
  const knownNames = [
    "asset_accounting_command_receipt_payload_hash_chk",
    "asset_accounting_command_receipt_source_key_not_blank_chk",
    "asset_accounting_command_receipt_target_shape_chk",
    "vehicle_cost_ledger_entry_accounting_period_chk",
    "vehicle_cost_ledger_entry_kind_amount_shape_chk",
    "vehicle_cost_ledger_entry_reversal_amount_chk",
    "vehicle_cost_ledger_entry_reversal_reference_chk",
    "vehicle_cost_ledger_entry_reverse_of_reversal_chk",
    "vehicle_cost_ledger_entry_reversal_of_entry_id_key",
    "vehicle_cost_ledger_entry_source_key_not_blank_chk"
  ];
  const exposedName = knownNames.find((name) => strings.some((value) => value.includes(name)));
  if (exposedName) return exposedName;
  const message = strings.join(" ");
  if (message.includes("reversal amount must be the exact opposite of the original")) {
    return "vehicle_cost_ledger_entry_reversal_amount_chk";
  }
  if (message.includes("reversal must preserve the original accounting and authority references")) {
    return "vehicle_cost_ledger_entry_reversal_reference_chk";
  }
  if (message.includes("a reversal cannot target another reversal")) {
    return "vehicle_cost_ledger_entry_reverse_of_reversal_chk";
  }
  return undefined;
}

function collectStrings(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value as Record<string, unknown>).flatMap((child) =>
    collectStrings(child, seen)
  );
}

function requiredTestDatabaseUrl(value = process.env.DATABASE_URL) {
  if (!value) throw new Error("DATABASE_URL is required for asset-accounting integration tests");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Asset-accounting integration tests require PostgreSQL");
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Asset-accounting integration tests require a loopback database");
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!["subscription_saas_codex", "subscription_saas_test"].includes(database)) {
    throw new Error("Asset-accounting integration tests require a dedicated test database");
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}
