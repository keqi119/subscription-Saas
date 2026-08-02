import {
  Prisma,
  SalePriceStatus,
  VehicleAcquisitionMode,
  VehicleBatteryUsageType,
  VehicleMileageReadingStatus,
  VehicleMileageSourceType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { VehicleService } from "../src/vehicle/vehicle.service";
import { VehicleMileageService } from "../src/vehicle-mileage/vehicle-mileage.service";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  menus: [],
  name: "资产运营",
  permissions: [],
  roles: ["AS"],
  username: "asset"
};
const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };

describe("vehicle mileage workflow integration", () => {
  it("creates the vehicle and initialization reading in the same transaction", async () => {
    const harness = createHarness();

    const result = await harness.service.createVehicle(
      {
        brand: "NIO",
        currentMileageKm: 321,
        modelDefinitionId: harness.definition.id,
        purchasePriceAmount: 16800000,
        vin: "TESTVINMILEAGE0001"
      },
      user,
      context
    );

    expect(result.currentMileageKm).toBe(321);
    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(harness.readings).toHaveLength(1);
    expect(harness.readings[0]).toMatchObject({
      deltaKm: 321,
      mileageKm: 321,
      sourceRecordId: result.id,
      sourceType: VehicleMileageSourceType.VEHICLE_INITIALIZATION,
      status: VehicleMileageReadingStatus.ACTIVE,
      vehicleId: result.id
    });
  });

  it("rejects direct current mileage edits after vehicle creation", async () => {
    const harness = createHarness({ vehicle: makeVehicle({ currentMileageKm: 321 }) });

    await expect(
      harness.service.updateVehicle(
        harness.vehicle.id,
        { currentMileageKm: 400 },
        user,
        context
      )
    ).rejects.toThrow("车辆创建后只能通过里程流程单据更新当前里程。");

    expect(harness.prisma.vehicle.update).not.toHaveBeenCalled();
  });

  it("continues to allow unrelated vehicle master-data edits", async () => {
    const harness = createHarness({ vehicle: makeVehicle({ currentMileageKm: 321 }) });

    await expect(
      harness.service.updateVehicle(
        harness.vehicle.id,
        { remark: "已完成整备" },
        user,
        context
      )
    ).resolves.toMatchObject({ currentMileageKm: 321, remark: "已完成整备" });

    expect(harness.prisma.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ currentMileageKm: expect.anything() })
      })
    );
  });
});

function createHarness(options: { vehicle?: ReturnType<typeof makeVehicle> } = {}) {
  const definition = makeDefinition();
  let vehicle = options.vehicle ?? null;
  const readings: Array<Record<string, unknown>> = [];
  const prisma = {
    $queryRaw: vi.fn(async () => (vehicle ? [{ id: vehicle.id }] : [])),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
    vehicle: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        vehicle = makeVehicle({
          brand: data.brand,
          createdBy: data.createdBy,
          currentMileageKm: data.currentMileageKm,
          id: "00000000-0000-4000-8000-000000000101",
          modelDefinition: definition,
          modelDefinitionId: definition.id,
          purchasePriceAmount: data.purchasePriceAmount,
          updatedBy: data.updatedBy,
          vehicleNo: data.vehicleNo,
          vin: data.vin
        });
        return vehicle;
      }),
      findMany: vi.fn(async () => (vehicle ? [vehicle] : [])),
      findUnique: vi.fn(async () => vehicle),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (!vehicle) {
          throw new Error("missing vehicle");
        }
        vehicle = { ...vehicle, ...data };
        return vehicle;
      })
    },
    vehicleMileageReading: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const reading = {
          createdAt: new Date(),
          id: `reading-${readings.length + 1}`,
          status: VehicleMileageReadingStatus.ACTIVE,
          updatedAt: new Date(),
          ...data
        };
        readings.push(reading);
        return reading;
      }),
      findFirst: vi.fn(async () => readings.at(-1) ?? null),
      findUnique: vi.fn(async () => null)
    },
    vehicleModelDefinition: {
      findFirst: vi.fn(async () => definition)
    }
  };
  const auditService = { write: vi.fn() };
  const mileageService = new VehicleMileageService(prisma as never);
  const VehicleServiceConstructor = VehicleService as unknown as new (
    audit: unknown,
    database: unknown,
    mileage: VehicleMileageService
  ) => VehicleService;
  const service = new VehicleServiceConstructor(auditService, prisma, mileageService);

  return {
    definition,
    get vehicle() {
      if (!vehicle) {
        throw new Error("vehicle not initialized");
      }
      return vehicle;
    },
    prisma,
    readings,
    service
  };
}

function makeDefinition() {
  return {
    brand: "NIO",
    customerDisplayName: "NIO ET5 2024",
    deletedAt: null,
    displayName: "NIO ET5 2024",
    enabled: true,
    id: "00000000-0000-4000-8000-000000000501",
    modelCode: "NIO_ET5_2024",
    modelName: "ET5",
    modelYear: 2024,
    series: "ET5"
  };
}

function makeVehicle(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-02T04:00:00.000Z");
  const definition = makeDefinition();
  return {
    acquisitionMode: VehicleAcquisitionMode.OWNED_CASH,
    assetLocation: null,
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    createdBy: user.id,
    currentMileageKm: 0,
    currentSalePriceAmount: null,
    currentSalePriceInitializedAt: null,
    currentSalePriceReviewedAt: null,
    deletedAt: null,
    id: "00000000-0000-4000-8000-000000000101",
    insurancePolicies: [],
    latestRegistrationDate: null,
    model: "ET5",
    modelDefinition: definition,
    modelDefinitionId: definition.id,
    modelYear: 2024,
    nextSalePriceReviewAt: null,
    plateNo: "沪DGJ580",
    purchaseDate: null,
    purchasePriceAmount: 16800000n,
    registrationDate: null,
    remark: null,
    salePriceHistories: [],
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.PENDING_INITIALIZE,
    series: "ET5",
    status: VehicleStatus.DRAFT,
    updatedAt: now,
    updatedBy: user.id,
    vehicleNo: "VEH20260802000000TEST",
    vin: "TESTVINMILEAGE0001",
    ...overrides
  };
}
