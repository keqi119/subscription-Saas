import { BadRequestException } from "@nestjs/common";
import { VehicleAssetPoolStatus, VehicleAssetPoolType, VehicleAssetPoolVehicleStatus, VehicleStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { FleetOpsScopeResolverService } from "../src/fleet-ops/fleet-ops.scope-resolver.service";

const vehicleA = {
  assetLocation: "Shanghai",
  brand: "NIO",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  id: "vehicle-a",
  model: "ES6",
  modelDefinition: { bodyType: "SUV", displayName: "ES6 2026", modelName: "ES6", modelYear: 2026 },
  modelYear: 2026,
  registrationDate: new Date("2026-01-02T00:00:00.000Z"),
  status: VehicleStatus.AVAILABLE,
  vehicleNo: "VEH-A",
  vin: "TESTVINA"
};

const vehicleB = {
  ...vehicleA,
  id: "vehicle-b",
  status: VehicleStatus.LEASED,
  vehicleNo: "VEH-B",
  vin: "TESTVINB"
};

function createPrismaMock() {
  return {
    vehicle: {
      findMany: vi.fn()
    },
    vehicleAssetPool: {
      findFirst: vi.fn(),
      findMany: vi.fn()
    }
  };
}

describe("Fleet Ops pool scope resolver", () => {
  it("resolves ALL scope with safe vehicle identity fields", async () => {
    const prisma = createPrismaMock();
    prisma.vehicle.findMany.mockResolvedValue([vehicleA, vehicleB]);

    const service = new FleetOpsScopeResolverService(prisma as never);
    const result = await service.resolveScope({ scopeType: "ALL" });

    expect(result.scope.type).toBe("ALL");
    expect(result.vehicleIds).toEqual(["vehicle-a", "vehicle-b"]);
    expect(result.vehicles).toEqual([
      expect.objectContaining({ vehicleId: "vehicle-a", vehicleNo: "VEH-A" }),
      expect.objectContaining({ vehicleId: "vehicle-b", vehicleNo: "VEH-B" })
    ]);
    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ snapshot: expect.anything() }),
        take: 301,
        where: expect.objectContaining({ deletedAt: null })
      })
    );
  });

  it("resolves POOL scope from active VehicleAssetPool membership only", async () => {
    const prisma = createPrismaMock();
    prisma.vehicleAssetPool.findFirst.mockResolvedValue({
      id: "pool-1",
      poolName: "Main Pool",
      poolNo: "POOL-1",
      poolStatus: VehicleAssetPoolStatus.ACTIVE,
      poolType: VehicleAssetPoolType.OPERATION,
      vehicles: [{ membershipStatus: VehicleAssetPoolVehicleStatus.ACTIVE }]
    });
    prisma.vehicle.findMany.mockResolvedValue([vehicleA]);

    const service = new FleetOpsScopeResolverService(prisma as never);
    const result = await service.resolveScope({ poolId: "pool-1", scopeType: "POOL" });

    expect(result.scope).toEqual(
      expect.objectContaining({
        pool: expect.objectContaining({
          activeVehicleCount: 1,
          poolId: "pool-1",
          poolName: "Main Pool",
          poolNo: "POOL-1",
          poolStatus: VehicleAssetPoolStatus.ACTIVE,
          poolType: VehicleAssetPoolType.OPERATION
        }),
        type: "POOL"
      })
    );
    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assetPoolMemberships: expect.objectContaining({
            some: expect.objectContaining({
              membershipStatus: VehicleAssetPoolVehicleStatus.ACTIVE,
              poolId: "pool-1"
            })
          })
        })
      })
    );
  });

  it("applies COHORT identity filters without calculating risk or economics", async () => {
    const prisma = createPrismaMock();
    prisma.vehicle.findMany.mockResolvedValue([vehicleA]);

    const service = new FleetOpsScopeResolverService(prisma as never);
    const result = await service.resolveScope({
      assetLocation: "Shanghai",
      brand: "NIO",
      createdFrom: "2026-01-01T00:00:00.000Z",
      createdTo: "2026-12-31T00:00:00.000Z",
      model: "ES6",
      modelYear: 2026,
      registrationDateFrom: "2026-01-01T00:00:00.000Z",
      registrationDateTo: "2026-12-31T00:00:00.000Z",
      scopeType: "COHORT",
      vehicleStatus: VehicleStatus.AVAILABLE
    });

    expect(result.scope.type).toBe("COHORT");
    expect(result.vehicleIds).toEqual(["vehicle-a"]);
    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assetLocation: { contains: "Shanghai", mode: "insensitive" },
          brand: { contains: "NIO", mode: "insensitive" },
          model: { contains: "ES6", mode: "insensitive" },
          modelYear: 2026,
          status: VehicleStatus.AVAILABLE
        })
      })
    );
    expect(prisma.vehicleAssetPool.findMany).not.toHaveBeenCalled();
  });

  it("rejects scopes larger than the configured cap without silent truncation", async () => {
    const prisma = createPrismaMock();
    prisma.vehicle.findMany.mockResolvedValue(Array.from({ length: 501 }, (_, index) => ({ ...vehicleA, id: `vehicle-${index}` })));

    const service = new FleetOpsScopeResolverService(prisma as never);

    await expect(service.resolveScope({ scopeType: "ALL" })).rejects.toBeInstanceOf(BadRequestException);
  });
});
