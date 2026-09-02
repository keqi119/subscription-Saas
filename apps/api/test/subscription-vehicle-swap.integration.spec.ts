import { ConfigService } from "@nestjs/config";
import { Prisma, VehicleStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import { AuditService } from "../src/audit/audit.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
import {
  insertRuntimeOrderGraph,
  insertRuntimeSubscriptionPlan,
  insertRuntimeVehicle
} from "./helpers/runtime-domain-fixture";

const TEST_DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/subscription-vehicle-swap.integration.spec.ts"
).databaseUrl;

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
  const orderIds = [randomUUID(), randomUUID()];
  const sourceVehicleIds = [randomUUID(), randomUUID()];
  const vehicleId = randomUUID();
  const targetPlanId = randomUUID();
  const vehiclePackageId = randomUUID();
  const changeIds = [randomUUID(), randomUUID()];
  await prisma.$transaction(async (tx) => {
    const orderGraphs = [];
    for (const [index, orderId] of orderIds.entries()) {
      orderGraphs.push(
        await insertRuntimeOrderGraph(tx, {
          label: `SWAP-RESERVATION-${index}`,
          orderId,
          vehicleId: sourceVehicleIds[index]!
        })
      );
    }
    const targetVehicle = await insertRuntimeVehicle(tx, vehicleId, "SWAP-RESERVATION-TARGET");
    await tx.vehicle.update({
      data: {
        currentSalePriceAmount: 20000000n,
        currentSalePriceInitializedAt: new Date("2026-08-01T00:00:00.000Z"),
        currentSalePriceReviewedAt: new Date("2026-08-01T00:00:00.000Z"),
        salePriceStatus: "EFFECTIVE",
        status: "AVAILABLE"
      },
      where: { id: vehicleId }
    });
    await insertRuntimeSubscriptionPlan(tx, {
      label: "SWAP-RESERVATION",
      modelDefinitionId: targetVehicle.modelDefinitionId,
      planId: targetPlanId,
      productId: orderGraphs[0]!.productId,
      productVersionId: orderGraphs[0]!.productVersionId,
      vehiclePackageId
    });
    for (const [index, changeId] of changeIds.entries()) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "subscription_change_order" (
          "id", "change_no", "order_id", "change_type", "status",
          "completion_deadline_at", "version", "created_at", "updated_at"
        ) VALUES (
          ${changeId}::uuid,
          ${`SCOSWAP${changeId.replaceAll("-", "").slice(0, 18)}`},
          ${orderIds[index]}::uuid,
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
          ${sourceVehicleIds[index]}::uuid,
          ${vehicleId}::uuid,
          ${targetPlanId}::uuid,
          ${vehiclePackageId}::uuid,
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
  if (!prisma || !fixture)
    throw new Error("Vehicle reservation cleanup requires its suite fixture");
  // The release database launcher drops the exact disposable database after the suite.
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("getResponse" in error)) return undefined;
  const response = (error as { getResponse: () => unknown }).getResponse();
  return response && typeof response === "object" && "code" in response
    ? (response as { code: unknown }).code
    : undefined;
}
