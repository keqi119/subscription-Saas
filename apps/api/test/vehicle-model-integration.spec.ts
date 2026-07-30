import { BadRequestException } from "@nestjs/common";
import {
  AuditAction,
  Prisma,
  SalePriceStatus,
  VehicleAcquisitionMode,
  VehicleBatteryUsageType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { RequestContext, RequestUser } from "../src/auth/auth.types";
import { PrismaService } from "../src/prisma/prisma.service";
import { VehicleService } from "../src/vehicle/vehicle.service";

describe("VehicleService canonical model master-data integration", () => {
  it("creates a vehicle from an active model definition", async () => {
    const definition = makeDefinition({
      displayName: "Model X 2027",
      id: "definition-model-x-2027",
      modelCode: "MODEL_X_2027"
    });
    const { auditService, prisma, service } = createHarness({
      definitions: [definition]
    });

    const result = await service.createVehicle(
      {
        brand: "NIO",
        modelDefinitionId: definition.id,
        purchasePriceAmount: 16800000,
        vin: "TESTVINMODELX2027"
      },
      user,
      context
    );

    expect(result).toMatchObject({
      modelCode: "MODEL_X_2027",
      modelDefinitionId: definition.id,
      modelDisplayName: "Model X 2027"
    });
    expect(prisma.vehicle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelDefinition: { connect: { id: definition.id } }
        })
      })
    );
    expect(prisma.vehicle.create.mock.calls[0]![0].data).not.toHaveProperty(
      "vehicleModel"
    );
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "vehicle"
      })
    );
  });

  it("rejects disabled model definitions", async () => {
    const definition = makeDefinition({
      enabled: false,
      id: "definition-disabled"
    });
    const { prisma, service } = createHarness({ definitions: [definition] });

    await expect(
      service.createVehicle(
        {
          brand: "NIO",
          modelDefinitionId: definition.id,
          purchasePriceAmount: 16800000,
          vin: "TESTVINDISABLED01"
        },
        user,
        context
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.vehicle.create).not.toHaveBeenCalled();
  });

  it("requires modelDefinitionId on vehicle creation", async () => {
    const { prisma, service } = createHarness();

    await expect(
      service.createVehicle(
        {
          brand: "NIO",
          purchasePriceAmount: 16800000,
          vin: "TESTVINNOMODEL01"
        } as never,
        user,
        context
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.vehicle.create).not.toHaveBeenCalled();
  });

  it("updates a vehicle model relation by canonical definition id", async () => {
    const oldDefinition = makeDefinition({
      id: "definition-et5",
      modelCode: "NIO_ET5"
    });
    const nextDefinition = makeDefinition({
      displayName: "ET9",
      id: "definition-et9",
      modelCode: "NIO_ET9"
    });
    const vehicle = makeVehicle(oldDefinition, { id: "vehicle-1" });
    const { prisma, service } = createHarness({
      definitions: [oldDefinition, nextDefinition],
      vehicles: [vehicle]
    });

    const result = await service.updateVehicle(
      "vehicle-1",
      { modelDefinitionId: nextDefinition.id },
      user,
      context
    );

    expect(result).toMatchObject({
      modelCode: "NIO_ET9",
      modelDefinitionId: nextDefinition.id,
      modelDisplayName: "ET9"
    });
    expect(prisma.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelDefinition: { connect: { id: nextDefinition.id } }
        })
      })
    );
  });

  it("returns canonical summaries for linked vehicles", async () => {
    const definition = makeDefinition({
      displayName: "EC6",
      id: "definition-ec6",
      modelCode: "NIO_EC6"
    });
    const vehicle = makeVehicle(definition, { id: "vehicle-linked" });
    const { service } = createHarness({
      definitions: [definition],
      vehicles: [vehicle]
    });

    const listResult = await service.listVehicles();
    const detailResult = await service.getVehicle("vehicle-linked");

    expect(listResult[0]).toMatchObject({
      modelCode: "NIO_EC6",
      modelDefinition: expect.objectContaining({
        id: definition.id,
        modelCode: "NIO_EC6"
      }),
      modelDefinitionId: definition.id,
      modelDisplayName: "EC6"
    });
    expect(detailResult).toMatchObject({
      modelCode: "NIO_EC6",
      modelDefinitionId: definition.id,
      modelDisplayName: "EC6"
    });
  });

  it("lists enabled model definitions using canonical fields", async () => {
    const definition = makeDefinition({
      id: "definition-model-x-2027",
      modelCode: "MODEL_X_2027"
    });
    const { prisma, service } = createHarness({ definitions: [definition] });

    const result = await service.listVehicleModelDefinitionOptions();

    expect(result.items).toEqual([
      expect.objectContaining({
        id: definition.id,
        modelCode: "MODEL_X_2027"
      })
    ]);
    expect(result.items[0]).not.toHaveProperty("legacyVehicleModel");
    expect(prisma.vehicleModelDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          enabled: true
        }
      })
    );
  });
});

function createHarness(options: {
  definitions?: Array<ReturnType<typeof makeDefinition>>;
  vehicles?: Array<ReturnType<typeof makeVehicle>>;
} = {}) {
  const definitions = [...(options.definitions ?? [])];
  const vehicles = [...(options.vehicles ?? [])];
  const prisma = {
    $transaction: vi.fn(),
    vehicle: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const definitionId = relationConnectId(data.modelDefinition);
        const definition = definitions.find(
          (item) => item.id === definitionId
        );
        if (!definition) {
          throw new Error("missing model definition");
        }
        const vehicle = makeVehicle(definition, {
          brand: data.brand as string,
          id: `vehicle-${vehicles.length + 1}`,
          model: (data.model as string | null | undefined) ?? null,
          purchasePriceAmount: data.purchasePriceAmount as bigint,
          series: (data.series as string | null | undefined) ?? null,
          vin: data.vin as string
        });
        vehicles.push(vehicle);
        return vehicle;
      }),
      findMany: vi.fn(async () => vehicles),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        vehicles.find((vehicle) => vehicle.id === where.id) ?? null
      ),
      update: vi.fn(async ({
        data,
        where
      }: {
        data: Record<string, unknown>;
        where: { id: string };
      }) => {
        const index = vehicles.findIndex((vehicle) => vehicle.id === where.id);
        const current = vehicles[index];
        if (!current) {
          throw new Error("missing vehicle");
        }
        const definitionId = relationConnectId(data.modelDefinition);
        const definition = definitionId
          ? definitions.find((item) => item.id === definitionId)
          : current.modelDefinition;
        if (!definition) {
          throw new Error("missing model definition");
        }
        const updated = makeVehicle(definition, {
          ...current,
          ...data,
          updatedAt: new Date("2026-06-24T08:00:00.000Z")
        });
        vehicles[index] = updated;
        return updated;
      })
    },
    vehicleModelDefinition: {
      findFirst: vi.fn(async ({
        where
      }: {
        where: { id?: string };
      }) =>
        definitions.find((definition) => definition.id === where.id) ?? null
      ),
      findMany: vi.fn(async ({
        where
      }: {
        where: { deletedAt?: null; enabled?: boolean };
      }) =>
        definitions.filter(
          (definition) =>
            (where.deletedAt !== null || definition.deletedAt === null) &&
            (where.enabled === undefined ||
              definition.enabled === where.enabled)
        )
      )
    }
  };
  prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof prisma) => unknown) => callback(prisma)
  );
  const auditService = {
    write: vi.fn()
  };

  return {
    auditService,
    prisma,
    service: new VehicleService(
      auditService as unknown as AuditService,
      prisma as unknown as PrismaService
    )
  };
}

function makeDefinition(
  options: {
    deletedAt?: Date | null;
    displayName?: string;
    enabled?: boolean;
    id?: string;
    modelCode?: string;
  } = {}
) {
  const modelCode = options.modelCode ?? "NIO_ET5";
  return {
    brand: "NIO",
    customerDisplayName: options.displayName ?? modelCode,
    deletedAt: options.deletedAt ?? null,
    displayName: options.displayName ?? modelCode,
    enabled: options.enabled ?? true,
    id: options.id ?? `definition-${modelCode}`,
    modelCode,
    modelName: modelCode,
    modelYear: null,
    series: "ET"
  };
}

function makeVehicle(
  modelDefinition: ReturnType<typeof makeDefinition>,
  options: Record<string, unknown> = {}
) {
  const now = new Date("2026-06-24T00:00:00.000Z");

  return {
    acquisitionMode: VehicleAcquisitionMode.OWNED_CASH,
    assetLocation: null,
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    createdBy: "user-1",
    currentMileageKm: 0,
    currentSalePriceAmount: null,
    currentSalePriceInitializedAt: null,
    currentSalePriceReviewedAt: null,
    deletedAt: null,
    id: "vehicle-1",
    insurancePolicies: [],
    latestRegistrationDate: null,
    model: null,
    modelYear: null,
    nextSalePriceReviewAt: null,
    plateNo: null,
    purchaseDate: null,
    purchasePriceAmount: 16800000n,
    registrationDate: null,
    remark: null,
    salePriceHistories: [],
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.PENDING_INITIALIZE,
    series: null,
    status: VehicleStatus.DRAFT,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleNo: "VEH20260624000000A1B2",
    vin: "TESTVIN000000001",
    ...options,
    modelDefinition,
    modelDefinitionId: modelDefinition.id
  };
}

function relationConnectId(value: unknown) {
  if (!value || typeof value !== "object" || !("connect" in value)) {
    return null;
  }

  const connect = (value as { connect?: { id?: unknown } }).connect;
  return typeof connect?.id === "string" ? connect.id : null;
}

const user: RequestUser = {
  id: "user-1",
  menus: [],
  name: "Admin",
  permissions: [],
  roles: [],
  username: "admin"
};

const context: RequestContext = {
  ipAddress: "127.0.0.1",
  userAgent: "vitest"
};
