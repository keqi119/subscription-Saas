import { ContractSegmentStatus, SubscriptionChangeStatus, VehicleStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";
import {
  VEHICLE_SWAP_ACTIVATION_FAILURE_POINTS,
  type VehicleSwapActivationFailurePoint
} from "../src/subscription-change/subscription-vehicle-swap-activation.service";
import {
  cleanupVehicleSwapFixture,
  connectVehicleSwapTestPrisma,
  createVehicleSwapActivationService,
  createVehicleSwapFixture,
  markVehicleSwapWorkOrdersReady
} from "./subscription-vehicle-swap-test-support";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";

// @database-test: this suite reaches PostgreSQL through the shared vehicle-swap support module.
const TEST_DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/subscription-vehicle-swap-failure-injection.spec.ts"
).databaseUrl;

describe("vehicle-swap atomic activation failure injection", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = await connectVehicleSwapTestPrisma(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it.each(VEHICLE_SWAP_ACTIVATION_FAILURE_POINTS)(
    "rolls back every authoritative mutation at %s",
    async (failurePoint) => {
      const fixture = await createVehicleSwapFixture(prisma);
      try {
        const coordinator = createVehicleSwapActivationService(prisma);
        await coordinator.coordinate(fixture.changeId);
        await markVehicleSwapWorkOrdersReady(prisma, fixture);
        const service = createVehicleSwapActivationService(prisma, {
          after(point: VehicleSwapActivationFailurePoint) {
            if (point === failurePoint) throw new Error(`Injected failure at ${point}`);
          }
        });

        await expect(service.activateIfReady(fixture.changeId)).rejects.toThrow(
          `Injected failure at ${failurePoint}`
        );

        const [change, order, sourceVehicle, targetVehicle, periods, segments, restrictions] =
          await Promise.all([
            prisma.subscriptionChangeOrder.findUniqueOrThrow({
              include: { vehicleSwapDetail: true },
              where: { id: fixture.changeId }
            }),
            prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } }),
            prisma.vehicle.findUniqueOrThrow({ where: { id: fixture.sourceVehicleId } }),
            prisma.vehicle.findUniqueOrThrow({ where: { id: fixture.targetVehicleId } }),
            prisma.vehicleSubscriptionPeriod.findMany({
              where: { orderId: fixture.orderId }
            }),
            prisma.subscriptionContractSegment.findMany({
              where: { orderId: fixture.orderId }
            }),
            prisma.vehicleOperationalRestriction.findMany({
              where: { startSourceId: fixture.changeId }
            })
          ]);

        expect(change).toMatchObject({
          status: SubscriptionChangeStatus.EXECUTING,
          vehicleSwapDetail: { actualSwapAt: null }
        });
        expect(order.vehicleId).toBe(fixture.sourceVehicleId);
        expect(sourceVehicle.status).toBe(VehicleStatus.LEASED);
        expect(targetVehicle.status).toBe(VehicleStatus.REVIEW_RESERVED);
        expect(periods).toEqual([
          expect.objectContaining({ endedAt: null, vehicleId: fixture.sourceVehicleId })
        ]);
        expect(segments).toEqual([
          expect.objectContaining({
            id: fixture.sourceSegmentId,
            status: ContractSegmentStatus.ACTIVE
          })
        ]);
        expect(restrictions).toEqual([]);
      } finally {
        await cleanupVehicleSwapFixture(prisma, fixture);
      }
    }
  );
});
