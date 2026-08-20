import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  SalePriceStatus,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionStatus,
  VehicleOperationalRestrictionType,
  VehicleStatus
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ASSET_OPERATION_SERVICE_CODE,
  AssetOperationsService
} from "../src/asset-operations/asset-operations.service";
import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import {
  evaluateVehicleAvailability,
  VehicleAvailabilityPurpose
} from "../src/asset-operations/vehicle-availability";
import { AuditService } from "../src/audit/audit.service";
import { PrismaService } from "../src/prisma/prisma.service";

const TEST_DATABASE_URL = requiredTestDatabaseUrl();
const FIXTURE_PREFIX = `S1CBA${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const AS_OF = new Date("2026-08-20T06:00:00.000Z");

const purposeCases = [
  {
    blockedScope: VehicleOperationalRestrictionScope.ALLOCATION,
    initialStatus: VehicleStatus.AVAILABLE,
    purpose: VehicleAvailabilityPurpose.ALLOCATION
  },
  {
    blockedScope: VehicleOperationalRestrictionScope.DELIVERY,
    initialStatus: VehicleStatus.RESERVED,
    purpose: VehicleAvailabilityPurpose.DELIVERY
  },
  {
    blockedScope: VehicleOperationalRestrictionScope.INVENTORY_RELEASE,
    initialStatus: VehicleStatus.RETURNED,
    purpose: VehicleAvailabilityPurpose.MARK_AVAILABLE
  }
] as const;

describe("authoritative vehicle availability PostgreSQL boundaries", () => {
  let prisma: PrismaService;
  let repository: AssetOperationsRepository;
  let service: AssetOperationsService;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
    repository = new AssetOperationsRepository();
    service = new AssetOperationsService(prisma, repository, new AuditService(prisma));
    userId = await createUserFixture(prisma);
  });

  afterAll(async () => {
    try {
      await deleteFixtures(prisma);
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it.each(purposeCases)(
    "keeps repository, pure evaluator and $purpose command behavior in parity",
    async ({ blockedScope, initialStatus, purpose }) => {
      const vehicleId = await createVehicleFixture(prisma, initialStatus, `parity-${purpose}`);
      await createRestriction(prisma, vehicleId, {
        scope: blockedScope,
        severity: VehicleOperationalRestrictionSeverity.ADVISORY
      });
      await createRestriction(prisma, vehicleId, {
        scope: VehicleOperationalRestrictionScope.CUSTOMER_USE,
        severity: VehicleOperationalRestrictionSeverity.BLOCKING
      });
      const releasedId = await createRestriction(prisma, vehicleId, {
        scope: blockedScope,
        severity: VehicleOperationalRestrictionSeverity.BLOCKING
      });
      await releaseRestriction(prisma, releasedId, userId);

      await readCommitted(prisma, async (tx) => {
        const snapshot = await repository.loadAvailabilitySnapshot(tx, vehicleId, AS_OF);
        const pure = evaluateVehicleAvailability({ ...snapshot, purpose });
        const command = await service.assertVehicleAvailable(tx, vehicleId, purpose, AS_OF);
        expect(command).toEqual(pure);
        expect(command.available).toBe(true);
      });

      if (purpose === VehicleAvailabilityPurpose.ALLOCATION) {
        await expect(listAvailableVehicleIds(prisma, AS_OF)).resolves.toContain(vehicleId);
      }

      await createRestriction(prisma, vehicleId, {
        scope: blockedScope,
        severity: VehicleOperationalRestrictionSeverity.BLOCKING
      });

      await readCommitted(prisma, async (tx) => {
        const snapshot = await repository.loadAvailabilitySnapshot(tx, vehicleId, AS_OF);
        const pure = evaluateVehicleAvailability({ ...snapshot, purpose });
        const error = await rejected(service.assertVehicleAvailable(tx, vehicleId, purpose, AS_OF));
        expect(pure.available).toBe(false);
        expectConflict(error, ASSET_OPERATION_SERVICE_CODE.VEHICLE_OPERATIONALLY_RESTRICTED);
        expect((error as ConflictException).getResponse()).toMatchObject({ reasons: pure.reasons });
      });

      if (purpose === VehicleAvailabilityPurpose.ALLOCATION) {
        await expect(listAvailableVehicleIds(prisma, AS_OF)).resolves.not.toContain(vehicleId);
      }
    }
  );

  it.each(purposeCases)(
    "serializes a held restriction create before $purpose and never commits the boundary write",
    async ({ blockedScope, initialStatus, purpose }) => {
      const vehicleId = await createVehicleFixture(prisma, initialStatus, `create-${purpose}`);
      const reached = deferred<void>();
      const release = deferred<void>();
      const holder = readCommitted(prisma, async (tx) => {
        await lockVehicleForRestriction(tx, vehicleId);
        await createRestriction(tx, vehicleId, {
          scope: blockedScope,
          severity: VehicleOperationalRestrictionSeverity.BLOCKING
        });
        reached.resolve();
        await release.promise;
      });
      void holder.catch(reached.reject);
      await reached.promise;
      const boundary = settled(runBoundary(prisma, service, vehicleId, purpose));
      try {
        expect(await waitForBoundaryLock(prisma)).toBe(true);
      } finally {
        release.resolve();
      }
      await holder;

      const result = await boundary;
      expect(result.status).toBe("rejected");
      expectConflict(
        rejectedValue(result),
        ASSET_OPERATION_SERVICE_CODE.VEHICLE_OPERATIONALLY_RESTRICTED
      );
      await expect(prisma.vehicle.findUnique({ where: { id: vehicleId } })).resolves.toMatchObject({
        brand: "NIO",
        status: initialStatus
      });
    }
  );

  it.each(purposeCases)(
    "serializes a held restriction release before $purpose and commits only after release",
    async ({ blockedScope, initialStatus, purpose }) => {
      const vehicleId = await createVehicleFixture(prisma, initialStatus, `release-${purpose}`);
      const restrictionId = await createRestriction(prisma, vehicleId, {
        scope: blockedScope,
        severity: VehicleOperationalRestrictionSeverity.BLOCKING
      });
      const reached = deferred<void>();
      const release = deferred<void>();
      const holder = readCommitted(prisma, async (tx) => {
        await lockVehicleForRestriction(tx, vehicleId);
        await releaseRestriction(tx, restrictionId, userId);
        reached.resolve();
        await release.promise;
      });
      void holder.catch(reached.reject);
      await reached.promise;
      const boundary = runBoundary(prisma, service, vehicleId, purpose);
      try {
        expect(await waitForBoundaryLock(prisma)).toBe(true);
      } finally {
        release.resolve();
      }
      await holder;
      await boundary;

      const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
      expect(vehicle).toMatchObject(
        purpose === VehicleAvailabilityPurpose.ALLOCATION
          ? { status: VehicleStatus.REVIEW_RESERVED }
          : purpose === VehicleAvailabilityPurpose.MARK_AVAILABLE
            ? { status: VehicleStatus.AVAILABLE }
            : { brand: `${FIXTURE_PREFIX}-delivered`, status: VehicleStatus.RESERVED }
      );
    }
  );
});

async function runBoundary(
  prisma: PrismaService,
  service: AssetOperationsService,
  vehicleId: string,
  purpose: VehicleAvailabilityPurpose
) {
  return readCommitted(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      /* vehicle-availability-boundary-lock */
      SELECT "id" FROM "vehicle" WHERE "id" = ${vehicleId}::uuid FOR UPDATE
    `);
    await service.assertVehicleAvailable(tx, vehicleId, purpose, AS_OF);
    return tx.vehicle.update({
      data:
        purpose === VehicleAvailabilityPurpose.ALLOCATION
          ? { status: VehicleStatus.REVIEW_RESERVED }
          : purpose === VehicleAvailabilityPurpose.MARK_AVAILABLE
            ? { status: VehicleStatus.AVAILABLE }
            : { brand: `${FIXTURE_PREFIX}-delivered` },
      where: { id: vehicleId }
    });
  });
}

async function createVehicleFixture(prisma: PrismaService, status: VehicleStatus, label: string) {
  const id = randomUUID();
  const token = randomUUID().replaceAll("-", "").slice(0, 8);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle" (
        "id", "vehicle_no", "plate_no", "brand", "model_definition_id",
        "purchase_price_amount", "current_sale_price_amount", "sale_price_status",
        "status", "created_at", "updated_at"
      ) VALUES (
        ${id}::uuid, ${`${FIXTURE_PREFIX}-${label}-${token}`}, ${`沪C${token}`}, 'NIO',
        ${randomUUID()}::uuid, 20000000, 18000000, ${SalePriceStatus.EFFECTIVE}::"sale_price_status",
        ${status}::"vehicle_status", clock_timestamp(), clock_timestamp()
      )
    `);
  });
  return id;
}

async function createRestriction(
  db: Prisma.TransactionClient | PrismaService,
  vehicleId: string,
  options: {
    scope: VehicleOperationalRestrictionScope;
    severity: VehicleOperationalRestrictionSeverity;
  }
) {
  const id = randomUUID();
  return (
    await db.vehicleOperationalRestriction.create({
      data: {
        conditionsSnapshot: { fixture: FIXTURE_PREFIX },
        id,
        restrictionType: VehicleOperationalRestrictionType.OTHER,
        scopes: [options.scope],
        severity: options.severity,
        startSourceId: randomUUID(),
        startSourceKey: `${FIXTURE_PREFIX}:${id}`,
        startSourceType: "STAGE1C_TASK6_TEST",
        startedAt: new Date("2026-08-20T05:00:00.000Z"),
        vehicleId
      }
    })
  ).id;
}

async function releaseRestriction(
  db: Prisma.TransactionClient | PrismaService,
  restrictionId: string,
  releasedBy: string
) {
  return db.vehicleOperationalRestriction.update({
    data: {
      releaseReason: "Task 6 concurrency release",
      releaseSnapshot: { fixture: FIXTURE_PREFIX },
      releaseSourceId: randomUUID(),
      releaseSourceKey: `${FIXTURE_PREFIX}:release:${restrictionId}`,
      releaseSourceType: "STAGE1C_TASK6_TEST",
      releasedAt: new Date("2026-08-20T05:30:00.000Z"),
      releasedBy,
      status: VehicleOperationalRestrictionStatus.RELEASED
    },
    where: { id: restrictionId }
  });
}

async function createUserFixture(prisma: PrismaService) {
  return (
    await prisma.user.create({
      data: {
        name: "Task 6 Availability Operator",
        passwordHash: "not-used-by-test",
        username: `${FIXTURE_PREFIX.toLowerCase()}_operator`
      }
    })
  ).id;
}

async function lockVehicleForRestriction(tx: Prisma.TransactionClient, vehicleId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "vehicle" WHERE "id" = ${vehicleId}::uuid FOR SHARE
  `);
}

async function listAvailableVehicleIds(prisma: PrismaService, asOf: Date) {
  const vehicles = await prisma.vehicle.findMany({
    select: { id: true },
    where: {
      currentSalePriceAmount: { gt: 0 },
      deletedAt: null,
      operationalRestrictions: {
        none: {
          scopes: { has: VehicleOperationalRestrictionScope.ALLOCATION },
          severity: VehicleOperationalRestrictionSeverity.BLOCKING,
          startedAt: { lte: asOf },
          status: VehicleOperationalRestrictionStatus.ACTIVE
        }
      },
      salePriceStatus: SalePriceStatus.EFFECTIVE,
      status: VehicleStatus.AVAILABLE,
      subscriptionPeriods: {
        none: {
          OR: [{ endedAt: null }, { endedAt: { gt: asOf } }],
          startedAt: { lte: asOf }
        }
      },
      vehicleNo: { startsWith: FIXTURE_PREFIX }
    }
  });
  return vehicles.map(({ id }) => id);
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

async function waitForBoundaryLock(prisma: PrismaService) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [status] = await prisma.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE "pid" <> pg_backend_pid()
          AND "datname" = current_database()
          AND "state" = 'active'
          AND "wait_event_type" = 'Lock'
          AND "query" ILIKE '%vehicle-availability-boundary-lock%'
      ) AS "waiting"
    `);
    if (status?.waiting) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function deleteFixtures(prisma: PrismaService) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`
      DELETE FROM "vehicle_operational_restriction"
      WHERE "start_source_key" LIKE ${`${FIXTURE_PREFIX}%`}
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

async function rejected(promise: Promise<unknown>) {
  const result = await settled(promise);
  return rejectedValue(result);
}

function rejectedValue(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") throw new Error("Expected rejection.");
  return result.reason;
}

function expectConflict(error: unknown, code: string) {
  expect(error).toBeInstanceOf(ConflictException);
  expect((error as ConflictException).getResponse()).toMatchObject({ code });
}

function requiredTestDatabaseUrl(value = process.env.DATABASE_URL) {
  if (!value)
    throw new Error("DATABASE_URL is required for vehicle availability integration tests");
  const url = new URL(value);
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("Vehicle availability integration tests require a loopback PostgreSQL host");
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== "subscription_saas_codex") {
    throw new Error("Vehicle availability integration tests require the dedicated codex database");
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
