import { SalePriceStatus, VehicleStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { VehicleAvailabilityPurpose } from "../src/asset-operations/vehicle-availability";
import { VehicleService } from "../src/vehicle/vehicle.service";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  menus: [],
  name: "Operator",
  permissions: [],
  roles: ["ADMIN"],
  username: "operator"
};
const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };

describe("VehicleService operational availability boundaries", () => {
  it("filters available inventory by open occupancy and active blocking allocation restrictions", async () => {
    const harness = createHarness();

    await harness.service.listAvailableVehicles();

    expect(harness.prisma.vehicle.findMany).toHaveBeenCalledWith({
      include: expect.any(Object),
      orderBy: { vehicleNo: "asc" },
      where: {
        currentSalePriceAmount: { gt: 0 },
        deletedAt: null,
        operationalRestrictions: {
          none: {
            scopes: { has: "ALLOCATION" },
            severity: "BLOCKING",
            startedAt: { lte: expect.any(Date) },
            status: "ACTIVE"
          }
        },
        salePriceStatus: SalePriceStatus.EFFECTIVE,
        status: VehicleStatus.AVAILABLE,
        subscriptionPeriods: {
          none: {
            OR: [{ endedAt: null }, { endedAt: { gt: expect.any(Date) } }],
            startedAt: { lte: expect.any(Date) }
          }
        }
      }
    });
  });

  it.each([
    {
      invoke: (service: VehicleService) =>
        service.updateStatus(
          "00000000-0000-4000-8000-000000000010",
          { status: VehicleStatus.AVAILABLE },
          user,
          context
        ),
      label: "updateStatus"
    },
    {
      invoke: (service: VehicleService) =>
        service.updateVehicle(
          "00000000-0000-4000-8000-000000000010",
          { status: VehicleStatus.AVAILABLE },
          user,
          context
        ),
      label: "updateVehicle"
    }
  ])("locks, guards, and writes $label in one READ COMMITTED transaction", async ({ invoke }) => {
    const harness = createHarness();

    await invoke(harness.service);

    expect(harness.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted"
    });
    expect(harness.sequence).toEqual(["vehicle-lock", "availability-guard", "vehicle-write"]);
    expect(harness.assetOperationsService.assertVehicleAvailable).toHaveBeenCalledWith(
      harness.prisma,
      "00000000-0000-4000-8000-000000000010",
      VehicleAvailabilityPurpose.MARK_AVAILABLE,
      expect.any(Date)
    );
  });

  it("does not write AVAILABLE when the authoritative guard rejects occupancy or restrictions", async () => {
    const harness = createHarness();
    harness.assetOperationsService.assertVehicleAvailable.mockRejectedValueOnce(
      new Error("VEHICLE_OPERATIONALLY_RESTRICTED")
    );

    await expect(
      harness.service.updateStatus(
        "00000000-0000-4000-8000-000000000010",
        { status: VehicleStatus.AVAILABLE },
        user,
        context
      )
    ).rejects.toThrow("VEHICLE_OPERATIONALLY_RESTRICTED");
    expect(harness.prisma.vehicle.update).not.toHaveBeenCalled();
  });
});

function createHarness() {
  const sequence: string[] = [];
  const vehicle = makeVehicle();
  const prisma = {
    $queryRaw: vi.fn(async () => {
      sequence.push("vehicle-lock");
      return [{ id: vehicle.id }];
    }),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma as unknown)),
    vehicle: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => vehicle),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        sequence.push("vehicle-write");
        return { ...vehicle, ...data };
      })
    },
    vehicleModelDefinition: {
      findFirst: vi.fn(async () => vehicle.modelDefinition)
    }
  };
  const assetOperationsService = {
    assertVehicleAvailable: vi.fn(async () => {
      sequence.push("availability-guard");
      return {
        available: true,
        purpose: VehicleAvailabilityPurpose.MARK_AVAILABLE,
        reasons: []
      };
    })
  };
  const service = new VehicleService(
    { write: vi.fn(async () => undefined) } as never,
    prisma as never,
    { appendConfirmedReading: vi.fn(async () => undefined) } as never,
    assetOperationsService as never
  );
  return { assetOperationsService, prisma, sequence, service };
}

function makeVehicle() {
  const now = new Date("2026-08-20T00:00:00.000Z");
  return {
    acquisitionMode: "OWNED_CASH",
    assetLocation: null,
    batteryCapacityKwh: null,
    batteryUsageType: "BUYOUT",
    brand: "NIO",
    createdAt: now,
    createdBy: user.id,
    currentMileageKm: 0,
    currentSalePriceAmount: 100n,
    currentSalePriceInitializedAt: now,
    currentSalePriceReviewedAt: now,
    deletedAt: null,
    id: "00000000-0000-4000-8000-000000000010",
    insurancePolicies: [],
    latestRegistrationDate: null,
    model: "ET5",
    modelDefinition: {
      brand: "NIO",
      customerDisplayName: "ET5",
      displayName: "ET5",
      enabled: true,
      id: "00000000-0000-4000-8000-000000000020",
      modelCode: "NIO_ET5",
      modelName: "ET5",
      modelYear: 2026,
      series: "ET"
    },
    modelDefinitionId: "00000000-0000-4000-8000-000000000020",
    modelYear: 2026,
    nextSalePriceReviewAt: new Date("2026-10-01T00:00:00.000Z"),
    plateNo: "沪A00001",
    purchaseDate: now,
    purchasePriceAmount: 100n,
    registrationDate: now,
    remark: null,
    salePriceHistories: [],
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.EFFECTIVE,
    series: "ET",
    status: VehicleStatus.IN_PREPARATION,
    updatedAt: now,
    updatedBy: user.id,
    vehicleNo: "VEH-1",
    vin: "VIN-1"
  };
}
