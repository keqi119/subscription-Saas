import { ConfigService } from "@nestjs/config";
import { Prisma, VehicleStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import { AuditService } from "../src/audit/audit.service";
import { PrismaService } from "../src/prisma/prisma.service";

const TEST_DATABASE_URL = requiredTestDatabaseUrl(process.env.DATABASE_URL);

describe("vehicle-swap target reservation PostgreSQL integration", () => {
  let prisma: PrismaService;
  let service: AssetOperationsService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
    service = new AssetOperationsService(
      prisma,
      new AssetOperationsRepository(),
      new AuditService(prisma)
    );
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("allows one concurrent soft-reservation winner and releases only the published owner", async () => {
    const fixture = await createFixture(prisma);
    try {
      const attempts = await Promise.allSettled(
        fixture.changeIds.map((changeOrderId) =>
          prisma.$transaction((tx) =>
            service.reserveVehicleForSubscriptionChange(tx, {
              asOf: new Date("2026-08-27T04:00:00.000Z"),
              changeOrderId,
              vehicleId: fixture.vehicleId
            })
          )
        )
      );
      const winnerIndex = attempts.findIndex(({ status }) => status === "fulfilled");
      const loserIndex = attempts.findIndex(({ status }) => status === "rejected");

      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      expect(loserIndex).toBeGreaterThanOrEqual(0);
      expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(errorCode((attempts[loserIndex] as PromiseRejectedResult).reason)).toBe(
        "VEHICLE_NOT_AVAILABLE"
      );
      await expect(
        prisma.vehicle.findUnique({ where: { id: fixture.vehicleId } })
      ).resolves.toMatchObject({
        status: VehicleStatus.REVIEW_RESERVED
      });

      const winnerId = fixture.changeIds[winnerIndex]!;
      const loserId = fixture.changeIds[loserIndex]!;
      await prisma.subscriptionChangeOrder.update({
        data: { customerConfirmationPublishedAt: new Date("2026-08-27T04:00:01.000Z") },
        where: { id: winnerId }
      });
      const loserRelease = await prisma.$transaction((tx) =>
        service.releaseVehicleReservationForSubscriptionChange(tx, {
          changeOrderId: loserId,
          vehicleId: fixture.vehicleId
        })
      );
      expect(loserRelease.released).toBe(false);
      await expect(
        prisma.vehicle.findUnique({ where: { id: fixture.vehicleId } })
      ).resolves.toMatchObject({
        status: VehicleStatus.REVIEW_RESERVED
      });

      const ownerRelease = await prisma.$transaction((tx) =>
        service.releaseVehicleReservationForSubscriptionChange(tx, {
          changeOrderId: winnerId,
          vehicleId: fixture.vehicleId
        })
      );
      expect(ownerRelease.released).toBe(true);
      await expect(
        prisma.vehicle.findUnique({ where: { id: fixture.vehicleId } })
      ).resolves.toMatchObject({
        status: VehicleStatus.AVAILABLE
      });
    } finally {
      await cleanupFixture(prisma, fixture);
    }
  });
});

async function createFixture(prisma: PrismaService) {
  const vehicleId = randomUUID();
  const changeIds = [randomUUID(), randomUUID()];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "vehicle" (
        "id", "vehicle_no", "brand", "model_definition_id",
        "purchase_price_amount", "current_sale_price_amount",
        "current_sale_price_initialized_at", "current_sale_price_reviewed_at",
        "sale_price_status", "status", "created_at", "updated_at"
      ) VALUES (
        ${vehicleId}::uuid,
        ${`VEHSWAP${vehicleId.replaceAll("-", "").slice(0, 20)}`},
        'NIO',
        ${randomUUID()}::uuid,
        20000000,
        20000000,
        clock_timestamp(),
        clock_timestamp(),
        'EFFECTIVE',
        'AVAILABLE',
        clock_timestamp(),
        clock_timestamp()
      )
    `);
    for (const [index, changeId] of changeIds.entries()) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "subscription_change_order" (
          "id", "change_no", "order_id", "change_type", "status",
          "completion_deadline_at", "version", "created_at", "updated_at"
        ) VALUES (
          ${changeId}::uuid,
          ${`SCOSWAP${changeId.replaceAll("-", "").slice(0, 18)}`},
          ${randomUUID()}::uuid,
          'VEHICLE_SWAP',
          'QUOTED',
          '2026-09-15T02:00:00.000Z'::timestamptz,
          1,
          clock_timestamp(),
          clock_timestamp()
        )
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "subscription_vehicle_swap_change_detail" (
          "id", "change_order_id", "source_vehicle_id", "target_vehicle_id",
          "target_subscription_plan_id", "target_vehicle_package_id", "planned_swap_at",
          "commercial_snapshot", "commercial_snapshot_hash", "created_at", "updated_at"
        ) VALUES (
          ${randomUUID()}::uuid,
          ${changeId}::uuid,
          ${randomUUID()}::uuid,
          ${vehicleId}::uuid,
          ${randomUUID()}::uuid,
          ${randomUUID()}::uuid,
          ${new Date(`2026-09-${15 + index}T02:00:00.000Z`)},
          ${JSON.stringify({ stage: "integration", version: index + 1 })}::jsonb,
          ${String(index + 1).repeat(64)},
          clock_timestamp(),
          clock_timestamp()
        )
      `);
    }
  });
  return { changeIds, vehicleId };
}

async function cleanupFixture(
  prisma: PrismaService,
  fixture: { changeIds: string[]; vehicleId: string }
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.subscriptionVehicleSwapChangeDetail.deleteMany({
      where: { changeOrderId: { in: fixture.changeIds } }
    });
    await tx.subscriptionChangeOrder.deleteMany({ where: { id: { in: fixture.changeIds } } });
    await tx.vehicle.deleteMany({ where: { id: fixture.vehicleId } });
  });
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("getResponse" in error)) return undefined;
  const response = (error as { getResponse: () => unknown }).getResponse();
  return response && typeof response === "object" && "code" in response
    ? (response as { code: unknown }).code
    : undefined;
}

function requiredTestDatabaseUrl(value: string | undefined) {
  if (!value) throw new Error("DATABASE_URL is required for vehicle-swap integration tests");
  const url = new URL(value);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("Vehicle-swap integration tests require PostgreSQL");
  }
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("Vehicle-swap integration tests require a loopback PostgreSQL host");
  }
  if (!url.pathname.toLowerCase().includes("test")) {
    throw new Error("Vehicle-swap integration tests require a test-only database");
  }
  return value;
}
