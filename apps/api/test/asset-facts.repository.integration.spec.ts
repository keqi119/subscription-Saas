import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";

const TEST_DATABASE_URL = requiredTestDatabaseUrl();
const FIXTURE_PREFIX = `stage1c_asset_facts_${randomUUID().replaceAll("-", "")}`;

describe("Stage 1C asset fact PostgreSQL invariants", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    try {
      await deleteFixturesIfTablesExist(prisma);
    } finally {
      await prisma.onModuleDestroy();
    }
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

    await expect(insertSubscriptionPeriod(prisma, original)).rejects.toSatisfy(
      (error) => databaseErrorCode(error) === "23505"
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

async function insertSubscriptionPeriod(prisma: PrismaService, input: SubscriptionPeriodInput) {
  const startedAt = input.startedAt ?? new Date("2026-08-01T00:00:00.000Z");
  const endedAt = input.endedAt ?? null;
  const customerId = input.customerId ?? randomUUID();
  const sourceId = input.sourceId ?? randomUUID();
  const sourceType = input.sourceType ?? "STAGE1C_TEST";

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
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
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
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

async function deleteFixturesIfTablesExist(prisma: PrismaService) {
  const tables = await prisma.$queryRaw<Array<{ tableName: string | null }>>`
    SELECT to_regclass('public.vehicle_subscription_period')::text AS "tableName"
    UNION ALL
    SELECT to_regclass('public.vehicle_ownership_period')::text AS "tableName"
  `;
  if (tables[0]?.tableName) {
    await prisma.$executeRaw`
      DELETE FROM "vehicle_subscription_period"
      WHERE "start_source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
  }
  if (tables[1]?.tableName) {
    await prisma.$executeRaw`
      DELETE FROM "vehicle_ownership_period"
      WHERE "start_source_key" LIKE ${`${FIXTURE_PREFIX}%`}
    `;
  }
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
    meta?: { code?: string };
  };
  return candidate.meta?.code ?? candidate.code ?? candidate.cause?.code;
}

function requiredTestDatabaseUrl(value = process.env.DATABASE_URL) {
  if (!value) {
    throw new Error("DATABASE_URL is required for asset fact integration tests");
  }
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error("Asset fact integration tests require PostgreSQL");
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("Asset fact integration tests require a loopback PostgreSQL host");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*_(test|codex)$/.test(databaseName)) {
    throw new Error("Asset fact integration tests require a test-only database");
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
    octets.every((octet) => {
      if (!/^\d{1,3}$/.test(octet)) return false;
      const value = Number(octet);
      return value >= 0 && value <= 255;
    })
  );
}
