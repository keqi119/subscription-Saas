import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditAction,
  Prisma,
  VehicleStatus,
  VehicleOwnershipPeriodEndReason,
  VehicleOwnershipPeriodStartReason,
  VehicleSubscriptionPeriodEndReason,
  VehicleSubscriptionPeriodStartReason
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ASSET_FACT_CONFLICT_CODE,
  AssetFactsRepository
} from "../src/asset-facts/asset-facts.repository";
import { AuditService } from "../src/audit/audit.service";
import type {
  CloseOwnershipPeriodDto,
  CloseSubscriptionPeriodDto,
  OpenOwnershipPeriodDto,
  OpenSubscriptionPeriodDto
} from "../src/asset-facts/dto/asset-facts.dto";
import { AssetFactsService } from "../src/asset-facts/asset-facts.service";
import type {
  CloseOwnershipPeriodInput,
  CloseSubscriptionPeriodInput,
  OpenOwnershipPeriodInput,
  OpenSubscriptionPeriodInput
} from "../src/asset-facts/asset-facts.types";
import { PrismaService } from "../src/prisma/prisma.service";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
import {
  insertRuntimeAssetOwner,
  insertRuntimeOrderGraph,
  insertRuntimeVehicle
} from "./helpers/runtime-domain-fixture";

const TEST_DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/asset-facts.repository.integration.spec.ts"
).databaseUrl;
const FIXTURE_PREFIX = `stage1c_asset_facts_${randomUUID().replaceAll("-", "")}`;
const REPOSITORY_FIXTURE_PREFIX = `S1C${randomUUID().replaceAll("-", "").slice(0, 12)}`;

describe("Stage 1C asset fact PostgreSQL invariants", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("keeps the named exclusion constraints and partial unique open-period indexes", async () => {
    const constraints = await prisma.$queryRaw<Array<{ definition: string; name: string }>>`
      SELECT conname AS "name", pg_get_constraintdef(oid) AS "definition"
      FROM pg_constraint
      WHERE conname IN (
        'vehicle_subscription_period_no_overlap_excl',
        'vehicle_ownership_period_no_overlap_excl'
      )
      ORDER BY conname
    `;
    expect(constraints).toEqual([
      {
        definition:
          "EXCLUDE USING gist (vehicle_id WITH =, tstzrange(started_at, COALESCE(ended_at, 'infinity'::timestamp with time zone), '[)'::text) WITH &&)",
        name: "vehicle_ownership_period_no_overlap_excl"
      },
      {
        definition:
          "EXCLUDE USING gist (vehicle_id WITH =, tstzrange(started_at, COALESCE(ended_at, 'infinity'::timestamp with time zone), '[)'::text) WITH &&)",
        name: "vehicle_subscription_period_no_overlap_excl"
      }
    ]);

    const indexes = await prisma.$queryRaw<Array<{ definition: string; name: string }>>`
      SELECT indexname AS "name", indexdef AS "definition"
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'vehicle_ownership_period_one_open_per_vehicle_uidx',
          'vehicle_subscription_period_one_open_per_order_uidx',
          'vehicle_subscription_period_one_open_per_vehicle_uidx'
        )
      ORDER BY indexname
    `;
    expect(indexes).toEqual([
      {
        definition:
          "CREATE UNIQUE INDEX vehicle_ownership_period_one_open_per_vehicle_uidx ON public.vehicle_ownership_period USING btree (vehicle_id) WHERE (ended_at IS NULL)",
        name: "vehicle_ownership_period_one_open_per_vehicle_uidx"
      },
      {
        definition:
          "CREATE UNIQUE INDEX vehicle_subscription_period_one_open_per_order_uidx ON public.vehicle_subscription_period USING btree (order_id) WHERE (ended_at IS NULL)",
        name: "vehicle_subscription_period_one_open_per_order_uidx"
      },
      {
        definition:
          "CREATE UNIQUE INDEX vehicle_subscription_period_one_open_per_vehicle_uidx ON public.vehicle_subscription_period USING btree (vehicle_id) WHERE (ended_at IS NULL)",
        name: "vehicle_subscription_period_one_open_per_vehicle_uidx"
      }
    ]);
  });

  it("rejects concurrent overlapping subscription periods for one vehicle", async () => {
    const vehicleId = randomUUID();

    const attempts = await Promise.allSettled([
      insertSubscriptionPeriod(prisma, {
        endedAt: new Date("2026-10-01T00:00:00.000Z"),
        orderId: randomUUID(),
        sourceKey: `${FIXTURE_PREFIX}:subscription:concurrent:first`,
        startedAt: new Date("2026-08-01T00:00:00.000Z"),
        vehicleId
      }),
      insertSubscriptionPeriod(prisma, {
        endedAt: new Date("2026-10-15T00:00:00.000Z"),
        orderId: randomUUID(),
        sourceKey: `${FIXTURE_PREFIX}:subscription:concurrent:second`,
        startedAt: new Date("2026-09-01T00:00:00.000Z"),
        vehicleId
      })
    ]);

    const successfulAttempts = attempts.filter((attempt) => attempt.status === "fulfilled");
    if (successfulAttempts.length === 0) {
      throw rejectedReason(attempts);
    }
    expect(successfulAttempts).toHaveLength(1);
    expect(databaseErrorCode(rejectedReason(attempts))).toBe("23P01");
  });

  it("rejects concurrent open subscription periods for one vehicle", async () => {
    const vehicleId = randomUUID();

    const attempts = await Promise.allSettled([
      insertSubscriptionPeriod(prisma, {
        endedAt: null,
        orderId: randomUUID(),
        sourceKey: `${FIXTURE_PREFIX}:subscription:concurrent-open:first`,
        vehicleId
      }),
      insertSubscriptionPeriod(prisma, {
        endedAt: null,
        orderId: randomUUID(),
        sourceKey: `${FIXTURE_PREFIX}:subscription:concurrent-open:second`,
        vehicleId
      })
    ]);

    const successfulAttempts = attempts.filter((attempt) => attempt.status === "fulfilled");
    if (successfulAttempts.length === 0) {
      throw rejectedReason(attempts);
    }
    expect(successfulAttempts).toHaveLength(1);
    expect(databaseErrorCode(rejectedReason(attempts))).toBe("23P01");
  });

  it("rejects a second open subscription period for one order on another vehicle", async () => {
    const orderId = randomUUID();

    await insertSubscriptionPeriod(prisma, {
      orderId,
      sourceKey: `${FIXTURE_PREFIX}:subscription:one-order:first`,
      vehicleId: randomUUID()
    });

    await expect(
      insertSubscriptionPeriod(prisma, {
        orderId,
        sourceKey: `${FIXTURE_PREFIX}:subscription:one-order:second`,
        vehicleId: randomUUID()
      })
    ).rejects.toSatisfy((error) => databaseErrorCode(error) === "23505");
  });

  it("allows adjacent half-open subscription periods for one vehicle", async () => {
    const vehicleId = randomUUID();
    const boundary = new Date("2026-10-01T00:00:00.000Z");

    await insertSubscriptionPeriod(prisma, {
      endedAt: boundary,
      orderId: randomUUID(),
      sourceKey: `${FIXTURE_PREFIX}:subscription:adjacent:first`,
      startedAt: new Date("2026-09-01T00:00:00.000Z"),
      vehicleId
    });
    await expect(
      insertSubscriptionPeriod(prisma, {
        endedAt: new Date("2026-11-01T00:00:00.000Z"),
        orderId: randomUUID(),
        sourceKey: `${FIXTURE_PREFIX}:subscription:adjacent:second`,
        startedAt: boundary,
        vehicleId
      })
    ).resolves.toBeUndefined();
  });

  it("rejects equal and reversed subscription period boundaries", async () => {
    const startedAt = new Date("2026-08-01T00:00:00.000Z");

    await expect(
      insertSubscriptionPeriod(prisma, {
        endedAt: startedAt,
        orderId: randomUUID(),
        sourceKey: `${FIXTURE_PREFIX}:subscription:invalid:equal`,
        startedAt,
        vehicleId: randomUUID()
      })
    ).rejects.toSatisfy((error) => databaseErrorCode(error) === "23514");
    await expect(
      insertSubscriptionPeriod(prisma, {
        endedAt: new Date("2026-07-31T23:59:59.999Z"),
        orderId: randomUUID(),
        sourceKey: `${FIXTURE_PREFIX}:subscription:invalid:reversed`,
        startedAt,
        vehicleId: randomUUID()
      })
    ).rejects.toSatisfy((error) => databaseErrorCode(error) === "23514");
  });

  it("rejects overlapping ownership periods for one vehicle", async () => {
    const vehicleId = randomUUID();

    await insertOwnershipPeriod(prisma, {
      assetOwnerId: randomUUID(),
      endedAt: new Date("2026-10-01T00:00:00.000Z"),
      sourceKey: `${FIXTURE_PREFIX}:ownership:overlap:first`,
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      vehicleId
    });

    await expect(
      insertOwnershipPeriod(prisma, {
        assetOwnerId: randomUUID(),
        endedAt: new Date("2026-10-15T00:00:00.000Z"),
        sourceKey: `${FIXTURE_PREFIX}:ownership:overlap:second`,
        startedAt: new Date("2026-09-01T00:00:00.000Z"),
        vehicleId
      })
    ).rejects.toSatisfy((error) => databaseErrorCode(error) === "23P01");
  });

  it("rejects equal and reversed ownership period boundaries", async () => {
    const startedAt = new Date("2026-08-01T00:00:00.000Z");

    await expect(
      insertOwnershipPeriod(prisma, {
        assetOwnerId: randomUUID(),
        endedAt: startedAt,
        sourceKey: `${FIXTURE_PREFIX}:ownership:invalid:equal`,
        startedAt,
        vehicleId: randomUUID()
      })
    ).rejects.toSatisfy((error) => databaseErrorCode(error) === "23514");
    await expect(
      insertOwnershipPeriod(prisma, {
        assetOwnerId: randomUUID(),
        endedAt: new Date("2026-07-31T23:59:59.999Z"),
        sourceKey: `${FIXTURE_PREFIX}:ownership:invalid:reversed`,
        startedAt,
        vehicleId: randomUUID()
      })
    ).rejects.toSatisfy((error) => databaseErrorCode(error) === "23514");
  });

  it("keeps exact source replay distinguishable from conflicting source reuse", async () => {
    const sourceType = "STAGE1C_TEST";
    const sourceId = randomUUID();
    const sourceKey = `${FIXTURE_PREFIX}:subscription:source-identity`;
    const original = {
      customerId: randomUUID(),
      orderId: randomUUID(),
      sourceId,
      sourceKey,
      sourceType,
      vehicleId: randomUUID()
    };

    await insertSubscriptionPeriod(prisma, original);

    await expect(insertSubscriptionPeriod(prisma, original)).rejects.toSatisfy((error) =>
      ["23P01", "23505"].includes(databaseErrorCode(error) ?? "")
    );
    const replayed = await findSubscriptionPeriod(prisma, sourceType, sourceId, sourceKey);
    expect(replayed).toMatchObject({
      customerId: original.customerId,
      orderId: original.orderId,
      vehicleId: original.vehicleId
    });

    const conflicting = {
      ...original,
      customerId: randomUUID(),
      vehicleId: randomUUID()
    };
    await expect(insertSubscriptionPeriod(prisma, conflicting)).rejects.toSatisfy(
      (error) => databaseErrorCode(error) === "23505"
    );
    const persisted = await findSubscriptionPeriod(prisma, sourceType, sourceId, sourceKey);
    expect(persisted).not.toMatchObject({
      customerId: conflicting.customerId,
      vehicleId: conflicting.vehicleId
    });
  });
});

describe("AssetFactsRepository PostgreSQL command behavior", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("rejects the root Prisma client because consecutive probes use distinct autocommit transactions", async () => {
    const fixture = await createRepositoryFixture(prisma);
    await expectConflictCode(
      new AssetFactsRepository().openSubscriptionPeriod(
        prisma as unknown as Prisma.TransactionClient,
        openRepositoryInput(
          "subscription",
          fixture,
          "root-transaction-contract"
        ) as OpenSubscriptionPeriodInput
      ),
      ASSET_FACT_CONFLICT_CODE.TRANSACTION_CONTRACT
    );
  });

  it("rejects an actual PostgreSQL SERIALIZABLE interactive transaction", async () => {
    const fixture = await createRepositoryFixture(prisma);
    await expectConflictCode(
      prisma.$transaction(
        (tx) =>
          new AssetFactsRepository().openOwnershipPeriod(
            tx,
            openRepositoryInput(
              "ownership",
              fixture,
              "serializable-transaction-contract"
            ) as OpenOwnershipPeriodInput
          ),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      ),
      ASSET_FACT_CONFLICT_CODE.TRANSACTION_CONTRACT
    );
  });

  it("binds caller-owned fact capabilities to one repository, transaction, source, and use", async () => {
    const fixture = await createRepositoryFixture(prisma);
    const input = openRepositoryInput(
      "subscription",
      fixture,
      "caller-capability-guards"
    ) as OpenSubscriptionPeriodInput;
    const repository = new AssetFactsRepository();
    const foreignRepository = new AssetFactsRepository();

    const wrongTransactionCapability = await readCommitted(prisma, (tx) =>
      repository.prepareCallerOwnedCommand(tx, "subscription", "start", input.source)
    );
    await expectConflictCode(
      readCommitted(prisma, (tx) =>
        repository.openSubscriptionPeriod(tx, input, wrongTransactionCapability)
      ),
      ASSET_FACT_CONFLICT_CODE.CALLER_CAPABILITY_INVALID
    );

    await readCommitted(prisma, async (tx) => {
      const capability = await repository.prepareCallerOwnedCommand(
        tx,
        "subscription",
        "start",
        input.source
      );
      await expectConflictCode(
        foreignRepository.openSubscriptionPeriod(tx, input, capability),
        ASSET_FACT_CONFLICT_CODE.CALLER_CAPABILITY_INVALID
      );
      await expectConflictCode(
        repository.openSubscriptionPeriod(tx, input, Object.freeze({}) as never),
        ASSET_FACT_CONFLICT_CODE.CALLER_CAPABILITY_INVALID
      );
      const created = await repository.openSubscriptionPeriod(tx, input, capability);
      expect(created.orderId).toBe(fixture.orderId);
      await expectConflictCode(
        repository.openSubscriptionPeriod(tx, input, capability),
        ASSET_FACT_CONFLICT_CODE.CALLER_CAPABILITY_INVALID
      );
    });

    const wrongSourceInput = {
      ...input,
      source: { ...input.source, key: `${input.source.key}:drift` }
    };
    await readCommitted(prisma, async (tx) => {
      const capability = await repository.prepareCallerOwnedCommand(
        tx,
        "subscription",
        "start",
        input.source
      );
      await expectConflictCode(
        repository.openSubscriptionPeriod(tx, wrongSourceInput, capability),
        ASSET_FACT_CONFLICT_CODE.CALLER_CAPABILITY_INVALID
      );
    });
    const replay = await readCommitted(prisma, async (tx) => {
      const capability = await repository.prepareCallerOwnedCommand(
        tx,
        "subscription",
        "start",
        input.source
      );
      return repository.openSubscriptionPeriodWithOutcome(tx, input, capability);
    });
    expect(replay.wrote).toBe(false);
    await expect(countPeriodsByStartSource(prisma, "subscription", input.source)).resolves.toBe(1);
  });

  it.each(["subscription", "ownership"] as const)(
    "serializes concurrent exact %s start replay on the source lock and returns one fact",
    async (periodKind) => {
      const fixture = await createRepositoryFixture(prisma);
      const input = openRepositoryInput(periodKind, fixture, "exact-start");

      const result = await runStartRace(prisma, periodKind, input, input);

      expect(result.waitedOnSourceLock).toBe(true);
      expect(fulfilledValue(result.second).id).toBe(result.first.id);
      await expect(countPeriodsByStartSource(prisma, periodKind, input.source)).resolves.toBe(1);
    }
  );

  it.each(["subscription", "ownership"] as const)(
    "serializes concurrent conflicting %s start replay and rejects payload drift",
    async (periodKind) => {
      const fixture = await createRepositoryFixture(prisma);
      const firstInput = openRepositoryInput(periodKind, fixture, "conflicting-start");
      const secondInput = {
        ...firstInput,
        snapshot: { ...firstInput.snapshot, drift: true }
      };

      const result = await runStartRace(prisma, periodKind, firstInput, secondInput);

      expect(result.waitedOnSourceLock).toBe(true);
      expect(result.first.id).toBeTruthy();
      expectConflictError(
        rejectedValue(result.second),
        periodKind === "subscription"
          ? ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_START_SOURCE
          : ASSET_FACT_CONFLICT_CODE.OWNERSHIP_START_SOURCE
      );
    }
  );

  it.each(["subscription", "ownership"] as const)(
    "does not serialize an unrelated %s start source behind another source lock",
    async (periodKind) => {
      const fixture = await createRepositoryFixture(prisma);

      const result = await runDistinctStartSources(prisma, periodKind, fixture);

      expect(result.secondFinishedBeforeFirstCommitted).toBe(true);
      expect(result.second.id).not.toBe(result.first.id);
    }
  );

  it.each(["subscription", "ownership"] as const)(
    "resolves the losing %s close compare-and-set as an exact replay",
    async (periodKind) => {
      const fixture = await createRepositoryFixture(prisma);
      const opened = await readCommitted(prisma, (tx) =>
        repositoryOpen(
          new AssetFactsRepository(),
          tx,
          periodKind,
          openRepositoryInput(periodKind, fixture, "exact-close-open")
        )
      );
      const closeInput = closeRepositoryInput(periodKind, opened.id, "exact-close");

      const result = await runCloseRace(prisma, periodKind, closeInput, closeInput);

      expect(result.waitedOnSourceLock).toBe(true);
      expect(fulfilledValue(result.second).id).toBe(result.first.id);
      expect(fulfilledValue(result.second).endedAt).toEqual(closeInput.endedAt);
    }
  );

  it.each(["subscription", "ownership"] as const)(
    "rejects payload drift for the losing %s close compare-and-set",
    async (periodKind) => {
      const fixture = await createRepositoryFixture(prisma);
      const opened = await readCommitted(prisma, (tx) =>
        repositoryOpen(
          new AssetFactsRepository(),
          tx,
          periodKind,
          openRepositoryInput(periodKind, fixture, "conflicting-close-open")
        )
      );
      const firstInput = closeRepositoryInput(periodKind, opened.id, "conflicting-close");
      const secondInput = {
        ...firstInput,
        snapshot: { ...firstInput.snapshot, drift: true }
      };

      const result = await runCloseRace(prisma, periodKind, firstInput, secondInput);

      expect(result.waitedOnSourceLock).toBe(true);
      expect(result.first.id).toBe(opened.id);
      expectConflictError(
        rejectedValue(result.second),
        periodKind === "subscription"
          ? ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_END_SOURCE
          : ASSET_FACT_CONFLICT_CODE.OWNERSHIP_END_SOURCE
      );
    }
  );

  it.each([
    {
      conflictCode: ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_START_SOURCE,
      expectation: "rejects",
      periodKind: "subscription"
    },
    { conflictCode: null, expectation: "keeps", periodKind: "ownership" }
  ] as const)(
    "$expectation an exact $periodKind start replay when authority changes behind its source lock",
    async ({ conflictCode, periodKind }) => {
      const fixture = await createRepositoryFixture(prisma);
      const input = serviceOpenDto(periodKind, fixture, `service-${periodKind}-start-replay`);
      const service = createAssetFactsService(prisma);
      const auditReached = deferred<void>();
      const releaseAudit = deferred<void>();
      const firstService = createAssetFactsService(
        prisma,
        blockingAuditService(prisma, auditReached, releaseAudit)
      );
      const firstPromise = serviceOpen(firstService, periodKind, input);
      void firstPromise.catch(auditReached.reject);
      await auditReached.promise;
      const mutationPromise = prisma.vehicle.update({
        data: { status: VehicleStatus.AVAILABLE },
        where: { id: fixture.vehicleId }
      });
      const earlyMutation = await settlesWithin(mutationPromise, 300);

      const replayPromise = settled(serviceOpen(service, periodKind, input));
      let waitedOnSourceLock: boolean;
      try {
        waitedOnSourceLock = await waitForDatabaseLock(prisma, "pg_advisory_xact_lock");
      } finally {
        releaseAudit.resolve();
      }
      const original = await firstPromise;
      await mutationPromise;
      const replay = await replayPromise;

      expect(earlyMutation.finished).toBe(false);
      expect(waitedOnSourceLock).toBe(true);
      if (conflictCode) {
        expectConflictError(rejectedValue(replay), conflictCode);
      } else {
        expect(fulfilledValue(replay).id).toBe(original.id);
      }
      await expect(countAssetFactAudits(prisma, original.id, AuditAction.CREATE)).resolves.toBe(1);
    }
  );

  it("returns an exact ownership start replay while its authority row is locked", async () => {
    const fixture = await createRepositoryFixture(prisma);
    const input = serviceOpenDto(
      "ownership",
      fixture,
      "service-ownership-start-replay-locked-authority"
    );
    const service = createAssetFactsService(prisma);
    const original = await serviceOpen(service, "ownership", input);
    const authorityLocked = deferred<void>();
    const releaseAuthority = deferred<void>();
    const mutationPromise = prisma.$transaction(async (tx) => {
      await tx.vehicle.update({
        data: { status: VehicleStatus.AVAILABLE },
        where: { id: fixture.vehicleId }
      });
      authorityLocked.resolve();
      await releaseAuthority.promise;
    });
    void mutationPromise.catch(authorityLocked.reject);
    await authorityLocked.promise;

    const replayPromise = settled(serviceOpen(service, "ownership", input));
    const replay = await settlesWithin(replayPromise, 1_000);
    releaseAuthority.resolve();
    await mutationPromise;

    expect(replay.finished).toBe(true);
    if (!replay.finished) {
      throw new Error("Exact ownership replay did not finish while authority remained locked.");
    }
    expect(fulfilledValue(replay.value).id).toBe(original.id);
  });

  it.each(["subscription", "ownership"] as const)(
    "serializes an exact concurrent %s close before authority snapshot selection and audits once",
    async (periodKind) => {
      const fixture = await createRepositoryFixture(prisma);
      const service = createAssetFactsService(prisma);
      const opened = await serviceOpen(
        service,
        periodKind,
        serviceOpenDto(periodKind, fixture, `service-${periodKind}-close-open`)
      );
      const closeInput = serviceCloseDto(
        periodKind,
        opened.id,
        `service-${periodKind}-close-replay`
      );
      const auditReached = deferred<void>();
      const releaseAudit = deferred<void>();
      const firstService = createAssetFactsService(
        prisma,
        blockingAuditService(prisma, auditReached, releaseAudit)
      );
      const firstPromise = serviceClose(firstService, periodKind, closeInput);
      void firstPromise.catch(auditReached.reject);
      await auditReached.promise;
      const secondPromise = settled(serviceClose(service, periodKind, closeInput));
      let waitedOnSourceLock: boolean;
      try {
        waitedOnSourceLock = await waitForDatabaseLock(prisma, "pg_advisory_xact_lock");
      } finally {
        releaseAudit.resolve();
      }
      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(waitedOnSourceLock).toBe(true);
      expect(fulfilledValue(second).id).toBe(first.id);
      await expect(countAssetFactAudits(prisma, first.id, AuditAction.UPDATE)).resolves.toBe(1);
    }
  );

  it.each(["subscription", "ownership"] as const)(
    "fails an exact %s close replay fast while its vehicle authority is being updated, then replays after release",
    async (periodKind) => {
      const fixture = await createRepositoryFixture(prisma);
      const service = createAssetFactsService(prisma);
      const opened = await serviceOpen(
        service,
        periodKind,
        serviceOpenDto(periodKind, fixture, `service-${periodKind}-busy-close-open`)
      );
      const closeInput = serviceCloseDto(
        periodKind,
        opened.id,
        `service-${periodKind}-busy-close-replay`
      );
      const closed = await serviceClose(service, periodKind, closeInput);
      const authorityLocked = deferred<void>();
      const releaseAuthority = deferred<void>();
      const authorityWriter = readCommitted(prisma, async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`UPDATE "vehicle" SET "updated_at" = clock_timestamp() WHERE "id" = ${fixture.vehicleId}::uuid`
        );
        authorityLocked.resolve();
        await releaseAuthority.promise;
        const [transactionProbe] = await tx.$queryRaw<Array<{ transactionId: string }>>(
          Prisma.sql`SELECT txid_current()::text AS "transactionId"`
        );
        const [authorityProbe] = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "vehicle" WHERE "id" = ${fixture.vehicleId}::uuid`
        );
        return {
          authorityRowReadable: authorityProbe?.id === fixture.vehicleId,
          transactionUsable: Boolean(transactionProbe?.transactionId)
        };
      });
      void authorityWriter.catch(authorityLocked.reject);
      await authorityLocked.promise;

      const busyReplayPromise = settled(serviceClose(service, periodKind, closeInput));
      const earlyBusyReplay = await (async () => {
        try {
          return await settlesWithin(busyReplayPromise, 750);
        } finally {
          releaseAuthority.resolve();
        }
      })();
      const [authorityWriterResult, busyReplay] = await Promise.all([
        authorityWriter,
        earlyBusyReplay.finished ? Promise.resolve(earlyBusyReplay.value) : busyReplayPromise
      ]);

      expect(earlyBusyReplay.finished).toBe(true);
      expectConflictError(rejectedValue(busyReplay), "ASSET_FACT_AUTHORITY_BUSY");
      expect(authorityWriterResult).toEqual({
        authorityRowReadable: true,
        transactionUsable: true
      });

      await expect(serviceClose(service, periodKind, closeInput)).resolves.toMatchObject({
        id: closed.id
      });
      await expect(countAssetFactAudits(prisma, closed.id, AuditAction.UPDATE)).resolves.toBe(1);
    }
  );

  it.each(["subscription", "ownership"] as const)(
    "holds authoritative %s rows through the fact and audit write boundary",
    async (periodKind) => {
      const fixture = await createRepositoryFixture(prisma);
      const auditReached = deferred<void>();
      const releaseAudit = deferred<void>();
      const service = createAssetFactsService(
        prisma,
        blockingAuditService(prisma, auditReached, releaseAudit)
      );
      const commandPromise = serviceOpen(
        service,
        periodKind,
        serviceOpenDto(periodKind, fixture, `service-${periodKind}-authority-lock`)
      );
      void commandPromise.catch(auditReached.reject);
      await auditReached.promise;

      const mutationPromise: Promise<unknown> =
        periodKind === "subscription"
          ? prisma.subscriptionOrder.update({
              data: { vehicleId: fixture.otherVehicleId },
              where: { id: fixture.orderId }
            })
          : prisma.vehicle.update({
              data: { deletedAt: new Date() },
              where: { id: fixture.vehicleId }
            });
      const earlyMutation = await settlesWithin(mutationPromise, 300);
      releaseAudit.resolve();
      const fact = await commandPromise;
      await mutationPromise;

      expect(earlyMutation.finished).toBe(false);
      await expect(countAssetFactAudits(prisma, fact.id, AuditAction.CREATE)).resolves.toBe(1);
    }
  );

  it("fails repair fast while an order-first delivery-like writer remains usable", async () => {
    const result = await runAuthorityContention(prisma, "order-first");

    expect(result.repairFinishedFast).toBe(true);
    expectConflictError(rejectedValue(result.repair), "ASSET_FACT_AUTHORITY_BUSY");
    expect(fulfilledValue(result.liveWriter)).toMatchObject({
      followUpAuthorityUpdates: 1,
      transactionUsable: true
    });
    await expect(countPeriodsByStartSource(prisma, "subscription", result.source)).resolves.toBe(0);
  });

  it("fails repair fast while a vehicle-first return-like writer remains usable", async () => {
    const result = await runAuthorityContention(prisma, "vehicle-first");

    expect(result.repairFinishedFast).toBe(true);
    expectConflictError(rejectedValue(result.repair), "ASSET_FACT_AUTHORITY_BUSY");
    expect(fulfilledValue(result.liveWriter)).toMatchObject({
      followUpAuthorityUpdates: 1,
      transactionUsable: true
    });
    await expect(countPeriodsByStartSource(prisma, "subscription", result.source)).resolves.toBe(0);
  });

  it.each([
    [
      "start-source unique",
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_START_SOURCE,
      subscriptionStartSourceConflict
    ],
    [
      "end-source unique",
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_END_SOURCE,
      subscriptionEndSourceConflict
    ],
    [
      "open-vehicle collision",
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OVERLAP,
      subscriptionOpenVehicleConflict
    ],
    [
      "open-order unique",
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OPEN_ORDER,
      subscriptionOpenOrderConflict
    ],
    [
      "period exclusion",
      ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_OVERLAP,
      subscriptionOverlapConflict
    ],
    ["period check", ASSET_FACT_CONFLICT_CODE.SUBSCRIPTION_RANGE, subscriptionRangeConflict]
  ] as const)(
    "normalizes the real subscription %s failure after PostgreSQL aborts the transaction",
    async (_constraint, code, exercise) => {
      await expectConflictCode(exercise(prisma), code);
    }
  );

  it.each([
    [
      "start-source unique",
      ASSET_FACT_CONFLICT_CODE.OWNERSHIP_START_SOURCE,
      ownershipStartSourceConflict
    ],
    [
      "end-source unique",
      ASSET_FACT_CONFLICT_CODE.OWNERSHIP_END_SOURCE,
      ownershipEndSourceConflict
    ],
    [
      "open-vehicle collision",
      ASSET_FACT_CONFLICT_CODE.OWNERSHIP_OVERLAP,
      ownershipOpenVehicleConflict
    ],
    ["period exclusion", ASSET_FACT_CONFLICT_CODE.OWNERSHIP_OVERLAP, ownershipOverlapConflict],
    ["period check", ASSET_FACT_CONFLICT_CODE.OWNERSHIP_RANGE, ownershipRangeConflict]
  ] as const)(
    "normalizes the real ownership %s failure after PostgreSQL aborts the transaction",
    async (_constraint, code, exercise) => {
      await expectConflictCode(exercise(prisma), code);
    }
  );
});

type SubscriptionPeriodInput = {
  customerId?: string;
  endedAt?: Date | null;
  orderId: string;
  sourceId?: string;
  sourceKey: string;
  sourceType?: string;
  startedAt?: Date;
  vehicleId: string;
};

type OwnershipPeriodInput = {
  assetOwnerId: string;
  endedAt?: Date | null;
  sourceId?: string;
  sourceKey: string;
  sourceType?: string;
  startedAt?: Date;
  vehicleId: string;
};

type RepositoryPeriodKind = "ownership" | "subscription";
type RepositoryFact = { endedAt: Date | null; id: string };
type RepositoryOpenInput = OpenOwnershipPeriodInput | OpenSubscriptionPeriodInput;
type RepositoryCloseInput = CloseOwnershipPeriodInput | CloseSubscriptionPeriodInput;
type ServiceOpenDto = OpenOwnershipPeriodDto | OpenSubscriptionPeriodDto;
type ServiceCloseDto = CloseOwnershipPeriodDto | CloseSubscriptionPeriodDto;
type RepositoryFixture = {
  customerId: string;
  orderId: string;
  otherOrderId: string;
  otherOwnerId: string;
  otherVehicleId: string;
  ownerId: string;
  vehicleId: string;
};

async function createRepositoryFixture(prisma: PrismaService): Promise<RepositoryFixture> {
  const customerId = randomUUID();
  const orderId = randomUUID();
  const otherOrderId = randomUUID();
  const otherOwnerId = randomUUID();
  const otherVehicleId = randomUUID();
  const ownerId = randomUUID();
  const vehicleId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await insertRuntimeOrderGraph(tx, {
      customerId,
      label: "ASSET-FACTS-PRIMARY",
      orderId,
      vehicleId
    });
    await insertRuntimeOrderGraph(tx, {
      customerId,
      label: "ASSET-FACTS-OTHER",
      orderId: otherOrderId,
      vehicleId: otherVehicleId
    });
    await insertRuntimeAssetOwner(tx, ownerId, "ASSET-FACTS-PRIMARY");
    await insertRuntimeAssetOwner(tx, otherOwnerId, "ASSET-FACTS-OTHER");
    await tx.vehicle.updateMany({
      data: { status: "LEASED" },
      where: { id: { in: [vehicleId, otherVehicleId] } }
    });
    await tx.subscriptionOrder.updateMany({
      data: { orderStatus: "ACTIVE" },
      where: { id: { in: [orderId, otherOrderId] } }
    });
  });

  return {
    customerId,
    orderId,
    otherOrderId,
    otherOwnerId,
    otherVehicleId,
    ownerId,
    vehicleId
  };
}

function openRepositoryInput(
  periodKind: RepositoryPeriodKind,
  fixture: RepositoryFixture,
  label: string,
  useOtherAggregate = false
): RepositoryOpenInput {
  const sourceId = randomUUID();
  const common = {
    actorId: null,
    confirmedAt: new Date("2026-08-01T00:05:00.000Z"),
    snapshot: { label },
    source: {
      id: sourceId,
      key: `${REPOSITORY_FIXTURE_PREFIX}:${label}:${sourceId}`,
      type: "STAGE1C_TEST"
    },
    startedAt: new Date("2026-08-01T00:00:00.000Z"),
    vehicleId: useOtherAggregate ? fixture.otherVehicleId : fixture.vehicleId
  };
  if (periodKind === "subscription") {
    return {
      ...common,
      contractId: null,
      contractSegmentId: null,
      customerId: fixture.customerId,
      orderId: useOtherAggregate ? fixture.otherOrderId : fixture.orderId,
      reason: VehicleSubscriptionPeriodStartReason.DELIVERY_CONFIRMED
    };
  }
  return {
    ...common,
    assetOwnerId: useOtherAggregate ? fixture.otherOwnerId : fixture.ownerId,
    reason: VehicleOwnershipPeriodStartReason.INITIAL_ACQUISITION
  };
}

function closeRepositoryInput(
  periodKind: RepositoryPeriodKind,
  periodId: string,
  label: string
): RepositoryCloseInput {
  const sourceId = randomUUID();
  const common = {
    actorId: null,
    confirmedAt: new Date("2026-10-01T00:05:00.000Z"),
    endedAt: new Date("2026-10-01T00:00:00.000Z"),
    periodId,
    snapshot: { label },
    source: {
      id: sourceId,
      key: `${REPOSITORY_FIXTURE_PREFIX}:${label}:${sourceId}`,
      type: "STAGE1C_TEST"
    }
  };
  return periodKind === "subscription"
    ? { ...common, reason: VehicleSubscriptionPeriodEndReason.RETURN_CONFIRMED }
    : { ...common, reason: VehicleOwnershipPeriodEndReason.OWNERSHIP_TRANSFER };
}

function repositoryOpen(
  repository: AssetFactsRepository,
  tx: Prisma.TransactionClient,
  periodKind: RepositoryPeriodKind,
  input: RepositoryOpenInput
): Promise<RepositoryFact> {
  return periodKind === "subscription"
    ? repository.openSubscriptionPeriod(tx, input as OpenSubscriptionPeriodInput)
    : repository.openOwnershipPeriod(tx, input as OpenOwnershipPeriodInput);
}

function repositoryClose(
  repository: AssetFactsRepository,
  tx: Prisma.TransactionClient,
  periodKind: RepositoryPeriodKind,
  input: RepositoryCloseInput
): Promise<RepositoryFact> {
  return periodKind === "subscription"
    ? repository.closeSubscriptionPeriod(tx, input as CloseSubscriptionPeriodInput)
    : repository.closeOwnershipPeriod(tx, input as CloseOwnershipPeriodInput);
}

function readCommitted<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(work, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 5_000,
    timeout: 10_000
  });
}

function createAssetFactsService(prisma: PrismaService, auditService = new AuditService(prisma)) {
  return new AssetFactsService(prisma, new AssetFactsRepository(), auditService);
}

function blockingAuditService(
  prisma: PrismaService,
  reached: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>
) {
  const realAuditService = new AuditService(prisma);
  return {
    async write(...args: Parameters<AuditService["write"]>) {
      await realAuditService.write(...args);
      reached.resolve();
      await release.promise;
    }
  } as unknown as AuditService;
}

function serviceOpenDto(
  periodKind: RepositoryPeriodKind,
  fixture: RepositoryFixture,
  label: string
): ServiceOpenDto {
  const sourceId = randomUUID();
  const common = {
    confirmedAt: "2026-08-01T00:05:00.000Z",
    snapshot: { label },
    source: {
      id: sourceId,
      key: `${REPOSITORY_FIXTURE_PREFIX}:${label}:${sourceId}`,
      type: "STAGE1C_TEST"
    },
    startedAt: "2026-08-01T00:00:00.000Z",
    vehicleId: fixture.vehicleId
  };
  return periodKind === "subscription"
    ? {
        ...common,
        contractId: null,
        contractSegmentId: null,
        customerId: fixture.customerId,
        orderId: fixture.orderId,
        reason: VehicleSubscriptionPeriodStartReason.DELIVERY_CONFIRMED
      }
    : {
        ...common,
        assetOwnerId: fixture.ownerId,
        reason: VehicleOwnershipPeriodStartReason.INITIAL_ACQUISITION
      };
}

function serviceCloseDto(
  periodKind: RepositoryPeriodKind,
  periodId: string,
  label: string
): ServiceCloseDto {
  const sourceId = randomUUID();
  const common = {
    confirmedAt: "2026-10-01T00:05:00.000Z",
    endedAt: "2026-10-01T00:00:00.000Z",
    periodId,
    snapshot: { label },
    source: {
      id: sourceId,
      key: `${REPOSITORY_FIXTURE_PREFIX}:${label}:${sourceId}`,
      type: "STAGE1C_TEST"
    }
  };
  return periodKind === "subscription"
    ? { ...common, reason: VehicleSubscriptionPeriodEndReason.RETURN_CONFIRMED }
    : { ...common, reason: VehicleOwnershipPeriodEndReason.OWNERSHIP_TRANSFER };
}

function serviceOpen(
  service: AssetFactsService,
  periodKind: RepositoryPeriodKind,
  input: ServiceOpenDto
): Promise<RepositoryFact> {
  return periodKind === "subscription"
    ? service.openSubscriptionPeriod(input as OpenSubscriptionPeriodDto, { actorId: null })
    : service.openOwnershipPeriod(input as OpenOwnershipPeriodDto, { actorId: null });
}

function serviceClose(
  service: AssetFactsService,
  periodKind: RepositoryPeriodKind,
  input: ServiceCloseDto
): Promise<RepositoryFact> {
  return periodKind === "subscription"
    ? service.closeSubscriptionPeriod(input as CloseSubscriptionPeriodDto, { actorId: null })
    : service.closeOwnershipPeriod(input as CloseOwnershipPeriodDto, { actorId: null });
}

function countAssetFactAudits(prisma: PrismaService, entityId: string, action: AuditAction) {
  return prisma.auditLog.count({
    where: { action, entityId, module: "asset_facts" }
  });
}

async function runAuthorityContention(
  prisma: PrismaService,
  lockOrder: "order-first" | "vehicle-first"
) {
  const fixture = await createRepositoryFixture(prisma);
  const input = serviceOpenDto(
    "subscription",
    fixture,
    `service-subscription-authority-${lockOrder}`
  ) as OpenSubscriptionPeriodDto;
  const lockReached = deferred<void>();
  const allowFollowUp = deferred<void>();
  const liveWriterPromise = readCommitted(prisma, async (tx) => {
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
    const [transactionProbe] = await tx.$queryRaw<Array<{ transactionId: string }>>(
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
    return {
      followUpAuthorityUpdates,
      transactionUsable: Boolean(transactionProbe?.transactionId)
    };
  });
  void liveWriterPromise.catch(lockReached.reject);
  await lockReached.promise;

  const repairPromise = settled(
    createAssetFactsService(prisma).openSubscriptionPeriod(input, { actorId: null })
  );
  const earlyRepair = await settlesWithin(repairPromise, 750);
  allowFollowUp.resolve();
  const [liveWriter, repair] = await Promise.all([
    settled(liveWriterPromise),
    earlyRepair.finished ? Promise.resolve(earlyRepair.value) : repairPromise
  ]);

  return {
    liveWriter,
    repair,
    repairFinishedFast: earlyRepair.finished,
    source: input.source
  };
}

async function runStartRace(
  prisma: PrismaService,
  periodKind: RepositoryPeriodKind,
  firstInput: RepositoryOpenInput,
  secondInput: RepositoryOpenInput
) {
  const firstOpened = deferred<RepositoryFact>();
  const releaseFirst = deferred<void>();
  const repository = new AssetFactsRepository();
  const firstPromise = readCommitted(prisma, async (tx) => {
    const opened = await repositoryOpen(repository, tx, periodKind, firstInput);
    firstOpened.resolve(opened);
    await releaseFirst.promise;
    return opened;
  });
  void firstPromise.catch(firstOpened.reject);
  const first = await firstOpened.promise;
  const secondPromise = readCommitted(prisma, (tx) =>
    repositoryOpen(repository, tx, periodKind, secondInput)
  );
  let waitedOnSourceLock: boolean;
  try {
    waitedOnSourceLock = await waitForDatabaseLock(prisma, "pg_advisory_xact_lock");
  } finally {
    releaseFirst.resolve();
  }
  const [, second] = await Promise.all([firstPromise, settled(secondPromise)]);
  return { first, second, waitedOnSourceLock };
}

async function runDistinctStartSources(
  prisma: PrismaService,
  periodKind: RepositoryPeriodKind,
  fixture: RepositoryFixture
) {
  const repository = new AssetFactsRepository();
  const firstOpened = deferred<RepositoryFact>();
  const releaseFirst = deferred<void>();
  const firstInput = openRepositoryInput(periodKind, fixture, "distinct-first");
  const secondInput = openRepositoryInput(periodKind, fixture, "distinct-second", true);
  const firstPromise = readCommitted(prisma, async (tx) => {
    const opened = await repositoryOpen(repository, tx, periodKind, firstInput);
    firstOpened.resolve(opened);
    await releaseFirst.promise;
    return opened;
  });
  void firstPromise.catch(firstOpened.reject);
  const first = await firstOpened.promise;
  const secondPromise = readCommitted(prisma, (tx) =>
    repositoryOpen(repository, tx, periodKind, secondInput)
  );
  const earlySecond = await settlesWithin(secondPromise, 3_000);
  releaseFirst.resolve();
  await firstPromise;
  const second = earlySecond.finished ? earlySecond.value : await secondPromise;
  return { first, second, secondFinishedBeforeFirstCommitted: earlySecond.finished };
}

async function runCloseRace(
  prisma: PrismaService,
  periodKind: RepositoryPeriodKind,
  firstInput: RepositoryCloseInput,
  secondInput: RepositoryCloseInput
) {
  const repository = new AssetFactsRepository();
  const firstLocked = deferred<void>();
  const releaseFirst = deferred<void>();
  const table =
    periodKind === "subscription" ? "vehicle_subscription_period" : "vehicle_ownership_period";
  const firstPromise = readCommitted(prisma, async (tx) => {
    await repository.lockCommandSource(tx, periodKind, "end", firstInput.source);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${firstInput.periodId}::uuid FOR UPDATE`
    );
    firstLocked.resolve();
    await releaseFirst.promise;
    return repositoryClose(repository, tx, periodKind, firstInput);
  });
  void firstPromise.catch(firstLocked.reject);
  await firstLocked.promise;
  const secondPromise = readCommitted(prisma, (tx) =>
    repositoryClose(repository, tx, periodKind, secondInput)
  );
  let waitedOnSourceLock: boolean;
  try {
    waitedOnSourceLock = await waitForDatabaseLock(prisma, "pg_advisory_xact_lock");
  } finally {
    releaseFirst.resolve();
  }
  const [first, second] = await Promise.all([firstPromise, settled(secondPromise)]);
  return { first, second, waitedOnSourceLock };
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
    await delay(20);
  }
  return false;
}

async function countPeriodsByStartSource(
  prisma: PrismaService,
  periodKind: RepositoryPeriodKind,
  source: { id: string; key: string; type: string }
) {
  const table =
    periodKind === "subscription" ? "vehicle_subscription_period" : "vehicle_ownership_period";
  const [result] = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS "count"
    FROM ${Prisma.raw(`"${table}"`)}
    WHERE "start_source_type" = ${source.type}
      AND "start_source_id" = ${source.id}::uuid
      AND "start_source_key" = ${source.key}
  `);
  return Number(result?.count ?? 0n);
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

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number) {
  const marker = Symbol("timeout");
  const result = await Promise.race([promise, delay(timeoutMs).then(() => marker)]);
  return result === marker
    ? ({ finished: false } as const)
    : ({ finished: true, value: result as T } as const);
}

function fulfilledValue<T>(result: PromiseSettledResult<T>) {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

function rejectedValue(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") {
    throw new Error("Expected repository command to be rejected.");
  }
  return result.reason;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function subscriptionStartSourceConflict(prisma: PrismaService) {
  const fixture = await createRepositoryFixture(prisma);
  const input = openRepositoryInput("subscription", fixture, "subscription-start-source");
  const original = await readCommitted(prisma, (tx) =>
    repositoryOpen(new AssetFactsRepository(), tx, "subscription", input)
  );
  await relocatePeriodAggregate(
    prisma,
    "subscription",
    original.id,
    fixture.otherVehicleId,
    fixture.otherOrderId
  );
  return readCommitted(prisma, (tx) =>
    repositoryOpen(new AssetFactsRepository(), tx, "subscription", input)
  );
}

async function subscriptionEndSourceConflict(prisma: PrismaService) {
  const fixture = await createRepositoryFixture(prisma);
  const repository = new AssetFactsRepository();
  const first = await readCommitted(prisma, (tx) =>
    repositoryOpen(
      repository,
      tx,
      "subscription",
      openRepositoryInput("subscription", fixture, "subscription-end-source-first")
    )
  );
  const second = await readCommitted(prisma, (tx) =>
    repositoryOpen(
      repository,
      tx,
      "subscription",
      openRepositoryInput("subscription", fixture, "subscription-end-source-second", true)
    )
  );
  const closeInput = closeRepositoryInput("subscription", first.id, "subscription-end-source");
  await readCommitted(prisma, (tx) => repositoryClose(repository, tx, "subscription", closeInput));
  const relocatedOrderId = randomUUID();
  const relocatedVehicleId = randomUUID();
  await prisma.$transaction((tx) =>
    insertRuntimeOrderGraph(tx, {
      customerId: fixture.customerId,
      label: "ASSET-FACTS-END-SOURCE",
      orderId: relocatedOrderId,
      vehicleId: relocatedVehicleId
    })
  );
  await relocatePeriodAggregate(
    prisma,
    "subscription",
    first.id,
    relocatedVehicleId,
    relocatedOrderId
  );
  return readCommitted(prisma, (tx) =>
    repositoryClose(repository, tx, "subscription", { ...closeInput, periodId: second.id })
  );
}

async function subscriptionOpenVehicleConflict(prisma: PrismaService) {
  const fixture = await createRepositoryFixture(prisma);
  const repository = new AssetFactsRepository();
  await readCommitted(prisma, (tx) =>
    repositoryOpen(
      repository,
      tx,
      "subscription",
      openRepositoryInput("subscription", fixture, "subscription-open-vehicle-first")
    )
  );
  const input = openRepositoryInput(
    "subscription",
    fixture,
    "subscription-open-vehicle-second",
    true
  ) as OpenSubscriptionPeriodInput;
  return readCommitted(prisma, (tx) =>
    repository.openSubscriptionPeriod(tx, { ...input, vehicleId: fixture.vehicleId })
  );
}

async function subscriptionOpenOrderConflict(prisma: PrismaService) {
  const fixture = await createRepositoryFixture(prisma);
  const repository = new AssetFactsRepository();
  await readCommitted(prisma, (tx) =>
    repositoryOpen(
      repository,
      tx,
      "subscription",
      openRepositoryInput("subscription", fixture, "subscription-open-order-first")
    )
  );
  const input = openRepositoryInput(
    "subscription",
    fixture,
    "subscription-open-order-second",
    true
  ) as OpenSubscriptionPeriodInput;
  return readCommitted(prisma, (tx) =>
    repository.openSubscriptionPeriod(tx, { ...input, orderId: fixture.orderId })
  );
}

async function subscriptionOverlapConflict(prisma: PrismaService) {
  const fixture = await createRepositoryFixture(prisma);
  const repository = new AssetFactsRepository();
  const first = await readCommitted(prisma, (tx) =>
    repositoryOpen(
      repository,
      tx,
      "subscription",
      openRepositoryInput("subscription", fixture, "subscription-overlap-first")
    )
  );
  await readCommitted(prisma, (tx) =>
    repositoryClose(
      repository,
      tx,
      "subscription",
      closeRepositoryInput("subscription", first.id, "subscription-overlap-close")
    )
  );
  const input = openRepositoryInput(
    "subscription",
    fixture,
    "subscription-overlap-second",
    true
  ) as OpenSubscriptionPeriodInput;
  return readCommitted(prisma, (tx) =>
    repository.openSubscriptionPeriod(tx, {
      ...input,
      startedAt: new Date("2026-09-01T00:00:00.000Z"),
      vehicleId: fixture.vehicleId
    })
  );
}

async function subscriptionRangeConflict(prisma: PrismaService) {
  const fixture = await createRepositoryFixture(prisma);
  const repository = new AssetFactsRepository();
  const input = openRepositoryInput(
    "subscription",
    fixture,
    "subscription-range-open"
  ) as OpenSubscriptionPeriodInput;
  const opened = await readCommitted(prisma, (tx) => repository.openSubscriptionPeriod(tx, input));
  return readCommitted(prisma, (tx) =>
    repository.closeSubscriptionPeriod(tx, {
      ...(closeRepositoryInput(
        "subscription",
        opened.id,
        "subscription-range-close"
      ) as CloseSubscriptionPeriodInput),
      endedAt: input.startedAt
    })
  );
}

async function ownershipStartSourceConflict(prisma: PrismaService) {
  const fixture = await createRepositoryFixture(prisma);
  const input = openRepositoryInput("ownership", fixture, "ownership-start-source");
  const original = await readCommitted(prisma, (tx) =>
    repositoryOpen(new AssetFactsRepository(), tx, "ownership", input)
  );
  await relocatePeriodAggregate(
    prisma,
    "ownership",
    original.id,
    fixture.otherVehicleId,
    fixture.otherOrderId
  );
  return readCommitted(prisma, (tx) =>
    repositoryOpen(new AssetFactsRepository(), tx, "ownership", input)
  );
}

async function ownershipEndSourceConflict(prisma: PrismaService) {
  const fixture = await createRepositoryFixture(prisma);
  const repository = new AssetFactsRepository();
  const first = await readCommitted(prisma, (tx) =>
    repositoryOpen(
      repository,
      tx,
      "ownership",
      openRepositoryInput("ownership", fixture, "ownership-end-source-first")
    )
  );
  const second = await readCommitted(prisma, (tx) =>
    repositoryOpen(
      repository,
      tx,
      "ownership",
      openRepositoryInput("ownership", fixture, "ownership-end-source-second", true)
    )
  );
  const closeInput = closeRepositoryInput("ownership", first.id, "ownership-end-source");
  await readCommitted(prisma, (tx) => repositoryClose(repository, tx, "ownership", closeInput));
  const relocatedVehicleId = randomUUID();
  await prisma.$transaction((tx) =>
    insertRuntimeVehicle(tx, relocatedVehicleId, "ASSET-FACTS-END-SOURCE")
  );
  await relocatePeriodAggregate(
    prisma,
    "ownership",
    first.id,
    relocatedVehicleId,
    fixture.otherOrderId
  );
  return readCommitted(prisma, (tx) =>
    repositoryClose(repository, tx, "ownership", { ...closeInput, periodId: second.id })
  );
}

async function ownershipOpenVehicleConflict(prisma: PrismaService) {
  const fixture = await createRepositoryFixture(prisma);
  const repository = new AssetFactsRepository();
  await readCommitted(prisma, (tx) =>
    repositoryOpen(
      repository,
      tx,
      "ownership",
      openRepositoryInput("ownership", fixture, "ownership-open-vehicle-first")
    )
  );
  const input = openRepositoryInput(
    "ownership",
    fixture,
    "ownership-open-vehicle-second",
    true
  ) as OpenOwnershipPeriodInput;
  return readCommitted(prisma, (tx) =>
    repository.openOwnershipPeriod(tx, { ...input, vehicleId: fixture.vehicleId })
  );
}

async function ownershipOverlapConflict(prisma: PrismaService) {
  const fixture = await createRepositoryFixture(prisma);
  const repository = new AssetFactsRepository();
  const first = await readCommitted(prisma, (tx) =>
    repositoryOpen(
      repository,
      tx,
      "ownership",
      openRepositoryInput("ownership", fixture, "ownership-overlap-first")
    )
  );
  await readCommitted(prisma, (tx) =>
    repositoryClose(
      repository,
      tx,
      "ownership",
      closeRepositoryInput("ownership", first.id, "ownership-overlap-close")
    )
  );
  const input = openRepositoryInput(
    "ownership",
    fixture,
    "ownership-overlap-second",
    true
  ) as OpenOwnershipPeriodInput;
  return readCommitted(prisma, (tx) =>
    repository.openOwnershipPeriod(tx, {
      ...input,
      startedAt: new Date("2026-09-01T00:00:00.000Z"),
      vehicleId: fixture.vehicleId
    })
  );
}

async function ownershipRangeConflict(prisma: PrismaService) {
  const fixture = await createRepositoryFixture(prisma);
  const repository = new AssetFactsRepository();
  const input = openRepositoryInput(
    "ownership",
    fixture,
    "ownership-range-open"
  ) as OpenOwnershipPeriodInput;
  const opened = await readCommitted(prisma, (tx) => repository.openOwnershipPeriod(tx, input));
  return readCommitted(prisma, (tx) =>
    repository.closeOwnershipPeriod(tx, {
      ...(closeRepositoryInput(
        "ownership",
        opened.id,
        "ownership-range-close"
      ) as CloseOwnershipPeriodInput),
      endedAt: input.startedAt
    })
  );
}

async function relocatePeriodAggregate(
  prisma: PrismaService,
  periodKind: RepositoryPeriodKind,
  periodId: string,
  vehicleId: string,
  orderId: string
) {
  await prisma.$transaction(async (tx) => {
    if (periodKind === "subscription") {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "vehicle_subscription_period"
        SET "vehicle_id" = ${vehicleId}::uuid, "order_id" = ${orderId}::uuid
        WHERE "id" = ${periodId}::uuid
      `);
      return;
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "vehicle_ownership_period"
      SET "vehicle_id" = ${vehicleId}::uuid
      WHERE "id" = ${periodId}::uuid
    `);
  });
}

async function expectConflictCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`Expected conflict ${code}.`);
  } catch (error) {
    expectConflictError(error, code);
  }
}

function expectConflictError(error: unknown, code: string) {
  expect(error).toBeInstanceOf(ConflictException);
  expect((error as ConflictException).getResponse()).toMatchObject({ code });
}

async function insertSubscriptionPeriod(prisma: PrismaService, input: SubscriptionPeriodInput) {
  const startedAt = input.startedAt ?? new Date("2026-08-01T00:00:00.000Z");
  const endedAt = input.endedAt ?? null;
  const customerId = input.customerId ?? randomUUID();
  const sourceId = input.sourceId ?? randomUUID();
  const sourceType = input.sourceType ?? "STAGE1C_TEST";

  await prisma.$transaction(async (tx) => {
    await insertRuntimeOrderGraph(tx, {
      customerId,
      label: "ASSET-FACTS-PERIOD",
      orderId: input.orderId,
      vehicleId: input.vehicleId
    });
    await tx.$executeRaw`
      INSERT INTO "vehicle_subscription_period" (
        "id", "vehicle_id", "order_id", "customer_id", "started_at", "ended_at",
        "start_reason", "start_source_type", "start_source_id", "start_source_key",
        "start_snapshot", "created_at", "updated_at"
      ) VALUES (
        ${randomUUID()}::uuid, ${input.vehicleId}::uuid, ${input.orderId}::uuid,
        ${customerId}::uuid, ${startedAt}, ${endedAt}, 'MANUAL_REPAIR', ${sourceType},
        ${sourceId}::uuid, ${input.sourceKey}, '{"fixture":"stage1c"}'::jsonb,
        clock_timestamp(), clock_timestamp()
      )
    `;
  });
}

async function insertOwnershipPeriod(prisma: PrismaService, input: OwnershipPeriodInput) {
  const startedAt = input.startedAt ?? new Date("2026-08-01T00:00:00.000Z");
  const endedAt = input.endedAt ?? null;
  const sourceId = input.sourceId ?? randomUUID();
  const sourceType = input.sourceType ?? "STAGE1C_TEST";

  await prisma.$transaction(async (tx) => {
    await insertRuntimeVehicle(tx, input.vehicleId, "ASSET-FACTS-OWNERSHIP");
    await insertRuntimeAssetOwner(tx, input.assetOwnerId, "ASSET-FACTS-OWNERSHIP");
    await tx.$executeRaw`
      INSERT INTO "vehicle_ownership_period" (
        "id", "vehicle_id", "asset_owner_id", "started_at", "ended_at", "start_reason",
        "start_source_type", "start_source_id", "start_source_key", "start_snapshot",
        "created_at", "updated_at"
      ) VALUES (
        ${randomUUID()}::uuid, ${input.vehicleId}::uuid, ${input.assetOwnerId}::uuid,
        ${startedAt}, ${endedAt}, 'MANUAL_REPAIR', ${sourceType}, ${sourceId}::uuid,
        ${input.sourceKey}, '{"fixture":"stage1c"}'::jsonb, clock_timestamp(), clock_timestamp()
      )
    `;
  });
}

async function findSubscriptionPeriod(
  prisma: PrismaService,
  sourceType: string,
  sourceId: string,
  sourceKey: string
) {
  const [period] = await prisma.$queryRaw<
    Array<{ customerId: string; orderId: string; vehicleId: string }>
  >`
    SELECT
      "customer_id" AS "customerId",
      "order_id" AS "orderId",
      "vehicle_id" AS "vehicleId"
    FROM "vehicle_subscription_period"
    WHERE "start_source_type" = ${sourceType}
      AND "start_source_id" = ${sourceId}::uuid
      AND "start_source_key" = ${sourceKey}
  `;
  return period;
}

function rejectedReason(results: PromiseSettledResult<unknown>[]) {
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (!rejected) {
    throw new Error("Expected one concurrent period insert to be rejected.");
  }
  return rejected.reason;
}

function databaseErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    cause?: { code?: string };
    code?: string;
    meta?: {
      code?: string;
      driverAdapterError?: { cause?: { originalCode?: string } };
    };
  };
  return (
    candidate.meta?.driverAdapterError?.cause?.originalCode ??
    candidate.meta?.code ??
    candidate.code ??
    candidate.cause?.code
  );
}
