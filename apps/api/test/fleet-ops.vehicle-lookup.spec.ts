import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { FleetOpsVehicleLookupService } from "../src/fleet-ops/fleet-ops.vehicle-lookup.service";

const vehicleId = "00000000-0000-4000-8000-000000000001";

describe("FleetOpsVehicleLookupService", () => {
  it("finds vehicles by internal id, vehicle number, VIN suffix, and plate using safe fields only", async () => {
    const prisma = {
      vehicle: {
        findMany: vi.fn().mockResolvedValue([
          {
            brand: "Tesla",
            id: vehicleId,
            model: "Model Y",
            modelDefinition: { displayName: "Model Y Long Range", modelName: "Model Y", modelYear: 2025 },
            modelYear: 2024,
            plateNo: "沪A12345",
            status: "AVAILABLE",
            vehicleNo: "VEH-DEMO-001",
            vin: "TESTVINES60000001"
          }
        ])
      }
    };

    const result = await new FleetOpsVehicleLookupService(prisma as never).lookup({
      limit: 50,
      q: "  S60000001  "
    });

    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({
          customer: expect.anything(),
          orders: expect.anything(),
          payments: expect.anything()
        }),
        take: 20,
        where: expect.objectContaining({
          deletedAt: null,
          OR: expect.arrayContaining([
            { vehicleNo: { contains: "S60000001", mode: "insensitive" } },
            { vin: { contains: "S60000001", mode: "insensitive" } },
            { plateNo: { contains: "S60000001", mode: "insensitive" } }
          ])
        })
      })
    );
    expect(result).toEqual({
      items: [
        {
          brand: "Tesla",
          model: "Model Y Long Range",
          modelYear: 2025,
          operationalState: "AVAILABLE",
          plateMasked: "*****45",
          statusLabel: "AVAILABLE",
          vehicleId,
          vehicleNo: "VEH-DEMO-001",
          vinSuffix: "000001"
        }
      ],
      limit: 20,
      query: "S60000001"
    });
    expect(JSON.stringify(result)).not.toContain("TESTVINES60000001");
    expect(JSON.stringify(result)).not.toContain("沪A12345");
  });

  it("uses exact id lookup for UUID input and avoids broad one-character searches", async () => {
    const prisma = { vehicle: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new FleetOpsVehicleLookupService(prisma as never);

    await service.lookup({ q: vehicleId });
    expect(prisma.vehicle.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ id: vehicleId }])
        })
      })
    );

    const shortResult = await service.lookup({ q: "A" });
    expect(shortResult.items).toEqual([]);
    expect(prisma.vehicle.findMany).toHaveBeenCalledTimes(1);
  });

  it("rejects empty lookup query", async () => {
    const service = new FleetOpsVehicleLookupService({ vehicle: { findMany: vi.fn() } } as never);

    await expect(service.lookup({ q: "   " })).rejects.toBeInstanceOf(BadRequestException);
  });
});
