import {
  ContractSegmentStatus,
  ContractSegmentType,
  EntitlementGrantStatus,
  SubscriptionChangeStatus,
  VehicleOperationalRestrictionStatus,
  VehicleOperationalRestrictionType,
  VehicleStatus
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/prisma/prisma.service";
import {
  cleanupVehicleSwapFixture,
  connectVehicleSwapTestPrisma,
  createVehicleSwapActivationService,
  createVehicleSwapFixture,
  markVehicleSwapWorkOrdersReady
} from "./subscription-vehicle-swap-test-support";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";

const TEST_DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/subscription-vehicle-swap.e2e-spec.ts"
).databaseUrl;

describe("vehicle-swap atomic activation PostgreSQL E2E", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = await connectVehicleSwapTestPrisma(TEST_DATABASE_URL);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("coordinates exactly two governed work orders and atomically switches all authoritative facts", async () => {
    const fixture = await createVehicleSwapFixture(prisma);
    const service = createVehicleSwapActivationService(prisma);
    try {
      const coordinated = await service.coordinate(fixture.changeId);
      const replay = await service.coordinate(fixture.changeId);

      expect(coordinated).toMatchObject({
        changeOrderId: fixture.changeId,
        outcome: "EXECUTING",
        settlementBillIds: []
      });
      expect(replay).toEqual(coordinated);
      await expect(
        prisma.assetWorkOrder.count({
          where: { createSourceId: fixture.changeId }
        })
      ).resolves.toBe(2);

      await markVehicleSwapWorkOrdersReady(prisma, fixture);
      const activated = await service.activateIfReady(fixture.changeId);
      const activationReplay = await service.activateIfReady(fixture.changeId);

      expect(activated).toMatchObject({
        changeOrderId: fixture.changeId,
        outcome: "COMPLETED"
      });
      expect(activationReplay).toEqual(activated);

      const [change, order, sourceVehicle, targetVehicle, periods, segments, restriction] =
        await Promise.all([
          prisma.subscriptionChangeOrder.findUniqueOrThrow({
            include: { vehicleSwapDetail: true },
            where: { id: fixture.changeId }
          }),
          prisma.subscriptionOrder.findUniqueOrThrow({ where: { id: fixture.orderId } }),
          prisma.vehicle.findUniqueOrThrow({ where: { id: fixture.sourceVehicleId } }),
          prisma.vehicle.findUniqueOrThrow({ where: { id: fixture.targetVehicleId } }),
          prisma.vehicleSubscriptionPeriod.findMany({
            orderBy: { startedAt: "asc" },
            where: { orderId: fixture.orderId }
          }),
          prisma.subscriptionContractSegment.findMany({
            orderBy: { sequenceNo: "asc" },
            where: { orderId: fixture.orderId }
          }),
          prisma.vehicleOperationalRestriction.findFirstOrThrow({
            where: {
              restrictionType: VehicleOperationalRestrictionType.RECONDITIONING_PENDING,
              startSourceId: fixture.changeId
            }
          })
        ]);

      expect(change).toMatchObject({
        status: SubscriptionChangeStatus.COMPLETED,
        vehicleSwapDetail: { actualSwapAt: expect.any(Date) }
      });
      expect(order.vehicleId).toBe(fixture.targetVehicleId);
      expect(sourceVehicle.status).toBe(VehicleStatus.RETURNED);
      expect(targetVehicle.status).toBe(VehicleStatus.LEASED);
      expect(periods).toHaveLength(2);
      expect(periods.filter(({ endedAt }) => endedAt === null)).toEqual([
        expect.objectContaining({
          id: activated.outcome === "COMPLETED" ? activated.targetSubscriptionPeriodId : "",
          vehicleId: fixture.targetVehicleId
        })
      ]);
      expect(periods[0]!.endedAt?.getTime()).toBe(periods[1]!.startedAt.getTime());
      expect(segments).toEqual([
        expect.objectContaining({
          id: fixture.sourceSegmentId,
          segmentType: ContractSegmentType.BASE,
          status: ContractSegmentStatus.COMPLETED
        }),
        expect.objectContaining({
          id: activated.outcome === "COMPLETED" ? activated.contractSegmentId : "",
          segmentType: ContractSegmentType.VEHICLE_SWAP,
          status: ContractSegmentStatus.ACTIVE
        })
      ]);
      expect(segments[0]!.endDate.getTime() + 86_400_000).toBe(segments[1]!.startDate.getTime());
      expect(segments[1]!.endDate).toEqual(new Date("2027-12-31T00:00:00.000Z"));
      expect(restriction).toMatchObject({
        status: VehicleOperationalRestrictionStatus.ACTIVE,
        vehicleId: fixture.sourceVehicleId
      });
      await expect(
        prisma.orderEntitlementGrant.findUniqueOrThrow({
          where: { id: fixture.futureGrantId }
        })
      ).resolves.toMatchObject({ status: EntitlementGrantStatus.CANCELLED });
      await expect(
        prisma.orderEntitlementGrant.findMany({
          where: {
            accountId: fixture.entitlementAccountId,
            id: { not: fixture.futureGrantId },
            status: EntitlementGrantStatus.ACTIVE
          }
        })
      ).resolves.toEqual([expect.objectContaining({ remainingAmount: expect.anything() })]);
    } finally {
      await cleanupVehicleSwapFixture(prisma, fixture);
    }
  });

  it("keeps the swap executing until positive deposit and first-cycle price differences are settled", async () => {
    const fixture = await createVehicleSwapFixture(prisma, {
      depositDelta: 500n,
      monthlyFeeDelta: 20_000n
    });
    const service = createVehicleSwapActivationService(prisma);
    try {
      const coordinated = await service.coordinate(fixture.changeId);
      const coordinatedReplay = await service.coordinate(fixture.changeId);
      expect(coordinated).toMatchObject({
        outcome: "EXECUTING",
        settlementBillIds: [expect.any(String), expect.any(String)]
      });
      expect(coordinatedReplay).toEqual(coordinated);
      await markVehicleSwapWorkOrdersReady(prisma, fixture);

      await expect(service.activateIfReady(fixture.changeId)).resolves.toEqual({
        blockers: ["DEPOSIT_DIFFERENCE_NOT_SETTLED", "PRICE_DIFFERENCE_NOT_SETTLED"],
        changeOrderId: fixture.changeId,
        outcome: "WAITING"
      });
      const bills = await prisma.receivableBill.findMany({
        orderBy: { sourceKey: "asc" },
        where: { orderId: fixture.orderId }
      });
      expect(bills).toHaveLength(2);
      expect(bills).toEqual([
        expect.objectContaining({ amount: 500n, remainingAmount: 500n }),
        expect.objectContaining({ amount: 20_000n, remainingAmount: 20_000n })
      ]);
      for (const bill of bills) {
        await prisma.receivableBill.update({
          data: {
            billStatus: "PAID",
            paidAmount: bill.amount,
            paidAt: new Date(),
            remainingAmount: 0n
          },
          where: { id: bill.id }
        });
      }

      await expect(service.activateIfReady(fixture.changeId)).resolves.toMatchObject({
        changeOrderId: fixture.changeId,
        outcome: "COMPLETED"
      });
    } finally {
      await cleanupVehicleSwapFixture(prisma, fixture);
    }
  });

  it("keeps signed-document, reservation, and blocking-restriction failures as explicit business waits", async () => {
    const fixture = await createVehicleSwapFixture(prisma);
    const service = createVehicleSwapActivationService(prisma);
    try {
      await service.coordinate(fixture.changeId);
      await markVehicleSwapWorkOrdersReady(prisma, fixture);
      await prisma.$transaction(async (tx) => {
        await tx.contract.update({
          data: { status: "SIGNED" },
          where: { id: fixture.supplementContractId }
        });
        await tx.vehicle.update({
          data: { status: VehicleStatus.AVAILABLE },
          where: { id: fixture.targetVehicleId }
        });
        await tx.vehicleOperationalRestriction.create({
          data: {
            conditionsSnapshot: { reason: "TEST_BLOCKER" },
            restrictionType: VehicleOperationalRestrictionType.MAINTENANCE_OR_ACCIDENT,
            scopes: ["DELIVERY"],
            severity: "BLOCKING",
            startSourceId: fixture.changeId,
            startSourceKey: "activation-gate-test",
            startSourceType: "VEHICLE_SWAP_TEST",
            startedAt: new Date(),
            status: VehicleOperationalRestrictionStatus.ACTIVE,
            vehicleId: fixture.targetVehicleId
          }
        });
      });

      await expect(service.activateIfReady(fixture.changeId)).resolves.toEqual({
        blockers: [
          "SIGNED_SUPPLEMENT_NOT_ARCHIVED",
          "TARGET_RESERVATION_INVALID",
          "BLOCKING_VEHICLE_RESTRICTION_ACTIVE"
        ],
        changeOrderId: fixture.changeId,
        outcome: "WAITING"
      });
      await expect(
        prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: fixture.changeId } })
      ).resolves.toMatchObject({ status: SubscriptionChangeStatus.EXECUTING });
    } finally {
      await cleanupVehicleSwapFixture(prisma, fixture);
    }
  });
});
