import { BadRequestException } from "@nestjs/common";
import {
  AuditAction,
  Prisma,
  SalePriceStatus,
  VehicleAcquisitionMode,
  VehicleBatteryUsageType,
  VehicleModel,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { RequestContext, RequestUser } from "../src/auth/auth.types";
import { PrismaService } from "../src/prisma/prisma.service";
import { VehicleService } from "../src/vehicle/vehicle.service";

describe("VehicleService vehicle model master-data integration", () => {
  it("creates a vehicle with modelDefinitionId and writes the mapped legacy VehicleModel", async () => {
    const definition = makeDefinition({ id: "definition-et5t", legacyVehicleModel: VehicleModel.ET5T, modelCode: "ET5T" });
    const { auditService, prisma, service } = createHarness({ definitions: [definition] });

    const result = await service.createVehicle(
      {
        brand: "NIO",
        modelDefinitionId: definition.id,
        purchasePriceAmount: 16800000,
        vin: "TESTVINET5T00001"
      },
      user,
      context
    );

    expect(result).toMatchObject({
      modelDefinitionId: definition.id,
      vehicleModel: VehicleModel.ET5T
    });
    expect(result.modelDefinition).toMatchObject({
      displayName: "ET5T",
      id: definition.id,
      legacyVehicleModel: VehicleModel.ET5T,
      modelCode: "ET5T"
    });
    expect(prisma.vehicle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelDefinition: { connect: { id: definition.id } },
          vehicleModel: VehicleModel.ET5T
        })
      })
    );
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.CREATE, entityType: "vehicle" })
    );
  });

  it("allows modelDefinitionId with matching legacy vehicleModel", async () => {
    const definition = makeDefinition({ id: "definition-es8", legacyVehicleModel: VehicleModel.ES8, modelCode: "ES8" });
    const { service } = createHarness({ definitions: [definition] });

    const result = await service.createVehicle(
      {
        brand: "NIO",
        modelDefinitionId: definition.id,
        purchasePriceAmount: 16800000,
        vehicleModel: VehicleModel.ES8,
        vin: "TESTVINES800001"
      },
      user,
      context
    );

    expect(result.vehicleModel).toBe(VehicleModel.ES8);
    expect(result.modelDefinitionId).toBe(definition.id);
  });

  it("rejects modelDefinitionId with mismatched legacy vehicleModel", async () => {
    const definition = makeDefinition({ id: "definition-et7", legacyVehicleModel: VehicleModel.ET7, modelCode: "ET7" });
    const { prisma, service } = createHarness({ definitions: [definition] });

    await expect(
      service.createVehicle(
        {
          brand: "NIO",
          modelDefinitionId: definition.id,
          purchasePriceAmount: 16800000,
          vehicleModel: VehicleModel.ET5,
          vin: "TESTVINMISMATCH01"
        },
        user,
        context
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.vehicle.create).not.toHaveBeenCalled();
  });

  it("rejects disabled model definitions for vehicle creation", async () => {
    const definition = makeDefinition({
      enabled: false,
      id: "definition-disabled",
      legacyVehicleModel: VehicleModel.EC6,
      modelCode: "EC6"
    });
    const { service } = createHarness({ definitions: [definition] });

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
  });

  it("rejects model definitions without legacyVehicleModel for vehicle creation", async () => {
    const definition = makeDefinition({
      id: "definition-future",
      legacyVehicleModel: null,
      modelCode: "FUTURE_MODEL"
    });
    const { service } = createHarness({ definitions: [definition] });

    await expect(
      service.createVehicle(
        {
          brand: "NIO",
          modelDefinitionId: definition.id,
          purchasePriceAmount: 16800000,
          vin: "TESTVINFUTURE001"
        },
        user,
        context
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("preserves legacy VehicleModel creation when modelDefinitionId is omitted", async () => {
    const { prisma, service } = createHarness({ definitions: [] });

    const result = await service.createVehicle(
      {
        brand: "NIO",
        purchasePriceAmount: 16800000,
        vehicleModel: VehicleModel.ES6,
        vin: "TESTVINES600001"
      },
      user,
      context
    );

    expect(result).toMatchObject({
      modelDefinition: null,
      modelDefinitionId: null,
      vehicleModel: VehicleModel.ES6
    });
    expect(prisma.vehicle.create.mock.calls[0]?.[0].data.modelDefinition).toBeUndefined();
  });

  it("updates a vehicle to use a model definition and syncs the legacy VehicleModel", async () => {
    const definition = makeDefinition({ id: "definition-et9", legacyVehicleModel: VehicleModel.ET9, modelCode: "ET9" });
    const vehicle = makeVehicle({ id: "vehicle-1", vehicleModel: VehicleModel.ET5 });
    const { prisma, service } = createHarness({ definitions: [definition], vehicles: [vehicle] });

    const result = await service.updateVehicle(
      "vehicle-1",
      { modelDefinitionId: definition.id },
      user,
      context
    );

    expect(result).toMatchObject({
      modelDefinitionId: definition.id,
      vehicleModel: VehicleModel.ET9
    });
    expect(prisma.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelDefinition: { connect: { id: definition.id } },
          vehicleModel: VehicleModel.ET9
        })
      })
    );
  });

  it("clears modelDefinitionId while preserving explicit legacy VehicleModel updates", async () => {
    const definition = makeDefinition({ id: "definition-es9", legacyVehicleModel: VehicleModel.ES9, modelCode: "ES9" });
    const vehicle = makeVehicle({
      id: "vehicle-1",
      modelDefinition: definition,
      modelDefinitionId: definition.id,
      vehicleModel: VehicleModel.ES9
    });
    const { prisma, service } = createHarness({ definitions: [definition], vehicles: [vehicle] });

    const result = await service.updateVehicle(
      "vehicle-1",
      { modelDefinitionId: null, vehicleModel: VehicleModel.ET7 },
      user,
      context
    );

    expect(result).toMatchObject({
      modelDefinition: null,
      modelDefinitionId: null,
      vehicleModel: VehicleModel.ET7
    });
    expect(prisma.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelDefinition: { disconnect: true },
          vehicleModel: VehicleModel.ET7
        })
      })
    );
  });

  it("returns modelDefinition summaries for linked vehicles and legacy fallback for historical vehicles", async () => {
    const definition = makeDefinition({ id: "definition-ec6", legacyVehicleModel: VehicleModel.EC6, modelCode: "EC6" });
    const linkedVehicle = makeVehicle({
      id: "vehicle-linked",
      modelDefinition: definition,
      modelDefinitionId: definition.id,
      vehicleModel: VehicleModel.EC6
    });
    const legacyVehicle = makeVehicle({
      id: "vehicle-legacy",
      modelDefinition: null,
      modelDefinitionId: null,
      vehicleModel: VehicleModel.ET5
    });
    const { service } = createHarness({ definitions: [definition], vehicles: [linkedVehicle, legacyVehicle] });

    const listResult = await service.listVehicles();
    const detailResult = await service.getVehicle("vehicle-legacy");

    expect(listResult[0]).toMatchObject({
      modelDefinition: expect.objectContaining({ id: definition.id, modelCode: "EC6" }),
      modelDefinitionId: definition.id,
      modelDisplayName: "EC6"
    });
    expect(detailResult).toMatchObject({
      modelDefinition: null,
      modelDefinitionId: null,
      modelDisplayName: VehicleModel.ET5
    });
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
        const definition = definitionId ? definitions.find((item) => item.id === definitionId) ?? null : null;
        const vehicle = makeVehicle({
          brand: data.brand as string,
          id: `vehicle-${vehicles.length + 1}`,
          model: (data.model as string | null | undefined) ?? null,
          modelDefinition: definition,
          modelDefinitionId: definitionId,
          purchasePriceAmount: data.purchasePriceAmount as bigint,
          series: (data.series as string | null | undefined) ?? null,
          vehicleModel: data.vehicleModel as VehicleModel,
          vin: data.vin as string
        });
        vehicles.push(vehicle);
        return vehicle;
      }),
      findMany: vi.fn(async () => vehicles),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        vehicles.find((vehicle) => vehicle.id === where.id) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const index = vehicles.findIndex((vehicle) => vehicle.id === where.id);
        const current = vehicles[index] ?? makeVehicle({ id: where.id });
        const definitionId = relationConnectId(data.modelDefinition);
        const disconnectModelDefinition = relationDisconnect(data.modelDefinition);
        const nextDefinition =
          definitionId
            ? definitions.find((item) => item.id === definitionId) ?? null
            : disconnectModelDefinition
              ? null
              : current.modelDefinition;
        const updated = makeVehicle({
          ...current,
          ...data,
          modelDefinition: nextDefinition,
          modelDefinitionId: definitionId ?? (disconnectModelDefinition ? null : current.modelDefinitionId),
          updatedAt: new Date("2026-06-24T08:00:00.000Z"),
          vehicleModel:
            data.vehicleModel === undefined
              ? current.vehicleModel
              : data.vehicleModel as VehicleModel
        });
        vehicles[index] = updated;
        return updated;
      })
    },
    vehicleModelDefinition: {
      findFirst: vi.fn(async ({ where }: { where: { deletedAt?: null; id?: string } }) =>
        definitions.find((definition) => {
          if (where.deletedAt === null && definition.deletedAt !== null) {
            return false;
          }
          if (where.id && definition.id !== where.id) {
            return false;
          }
          return true;
        }) ?? null
      )
    }
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  const auditService = {
    write: vi.fn()
  };

  return {
    auditService,
    prisma,
    service: new VehicleService(auditService as unknown as AuditService, prisma as unknown as PrismaService)
  };
}

function makeDefinition(options: {
  deletedAt?: Date | null;
  enabled?: boolean;
  id?: string;
  legacyVehicleModel?: VehicleModel | null;
  modelCode?: string;
} = {}) {
  const modelCode = options.modelCode ?? "ET5";
  return {
    brand: "NIO",
    customerDisplayName: modelCode,
    deletedAt: options.deletedAt ?? null,
    displayName: modelCode,
    enabled: options.enabled ?? true,
    id: options.id ?? `definition-${modelCode}`,
    legacyVehicleModel: options.legacyVehicleModel === undefined ? VehicleModel.ET5 : options.legacyVehicleModel,
    modelCode,
    modelName: modelCode,
    modelYear: null,
    series: modelCode.startsWith("EC") ? "EC" : modelCode.startsWith("ES") ? "ES" : "ET"
  };
}

function makeVehicle(options: Record<string, unknown> = {}) {
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
    insuranceEndDate: null,
    insuranceStartDate: null,
    latestRegistrationDate: null,
    model: null,
    modelDefinition: null,
    modelDefinitionId: null,
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
    vehicleModel: VehicleModel.ET5,
    vehicleNo: "VEH20260624000000A1B2",
    vin: "TESTVIN000000001",
    ...options
  };
}

function relationConnectId(value: unknown) {
  if (!value || typeof value !== "object" || !("connect" in value)) {
    return null;
  }

  const connect = (value as { connect?: { id?: unknown } }).connect;
  return typeof connect?.id === "string" ? connect.id : null;
}

function relationDisconnect(value: unknown) {
  return Boolean(value && typeof value === "object" && (value as { disconnect?: unknown }).disconnect);
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
