import fs from "node:fs";
import path from "node:path";

import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it, vi } from "vitest";

import {
  CreateVehicleModelDefinitionDto,
  UpdateVehicleModelDefinitionDto
} from "../src/vehicle-model-definition/dto/vehicle-model-definition.dto";
import { VehicleModelDefinitionService } from "../src/vehicle-model-definition/vehicle-model-definition.service";
import { VehicleModel, type VehicleModel as VehicleModelCode } from "./helpers/vehicle-model-codes";

describe("VehicleModelDefinitionService", () => {
  it("creates an enabled model definition without exposing it to portal by default", async () => {
    const { prisma, service, user } = createHarness({ definitions: [] });

    const definition = await service.createDefinition(
      {
        brand: "NIO",
        displayName: "ET5T",
        modelCode: "ET5T",
        modelName: "ET5T"
      },
      user
    );

    expect(definition).toMatchObject({
      brand: "NIO",
      displayName: "ET5T",
      enabled: true,
      legacyVehicleModel: null,
      modelCode: "ET5T",
      portalVisible: false
    });
    expect(prisma.vehicleModelDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          createdBy: "user-1",
          snapshot: { source: "BACK_OFFICE", stage: "10X-C" }
        })
      })
    );
  });

  it("checks the namespace and creates inside a Serializable transaction", async () => {
    const { prisma, service, user } = createHarness({ definitions: [] });

    await service.createDefinition(
      {
        brand: "NIO",
        displayName: "Model X",
        modelCode: "MODEL_X_2027",
        modelName: "Model X"
      },
      user
    );

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    expect(prisma.vehicleModelDefinition.findFirst).toHaveBeenCalled();
    expect(prisma.vehicleModelDefinition.create).toHaveBeenCalled();
  });

  it("checks the namespace and updates inside a Serializable transaction", async () => {
    const { prisma, service, user } = createHarness({
      definitions: [createDefinition({ id: "definition-et5" })]
    });

    await service.updateDefinition(
      "definition-et5",
      { modelCode: "NIO_ET5" },
      user
    );

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    expect(prisma.vehicleModelDefinition.update).toHaveBeenCalled();
  });

  it("maps Serializable write conflicts to a safe domain conflict", async () => {
    const { prisma, service, user } = createHarness({ definitions: [] });
    prisma.$transaction.mockRejectedValueOnce({ code: "P2034" });

    await expect(
      service.createDefinition(
        {
          brand: "NIO",
          displayName: "Model X",
          modelCode: "MODEL_X_2027",
          modelName: "Model X"
        },
        user
      )
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("maps transaction unique conflicts to a safe validation error", async () => {
    const { prisma, service, user } = createHarness({ definitions: [] });
    prisma.$transaction.mockRejectedValueOnce({ code: "P2002" });

    await expect(
      service.createDefinition(
        {
          brand: "NIO",
          displayName: "Model X",
          modelCode: "MODEL_X_2027",
          modelName: "Model X"
        },
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects duplicate modelCode including soft-deleted records", async () => {
    const { service, user } = createHarness({
      definitions: [createDefinition({ deletedAt: new Date("2026-06-24T00:00:00.000Z"), modelCode: "ET5T" })]
    });

    await expect(
      service.createDefinition(
        {
          brand: "NIO",
          displayName: "ET5T",
          modelCode: "ET5T",
          modelName: "ET5T"
        },
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a modelCode that collides with another definition legacy alias", async () => {
    const { service, user } = createHarness({
      definitions: [
        createDefinition({
          id: "definition-existing",
          legacyVehicleModel: VehicleModel.ET5,
          modelCode: "NIO_ET5"
        })
      ]
    });

    await expect(
      service.createDefinition(
        {
          brand: "NIO",
          displayName: "Conflicting ET5",
          modelCode: VehicleModel.ET5,
          modelName: "ET5"
        },
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects and never persists legacy aliases on definition create or update", async () => {
    const createDto = plainToInstance(CreateVehicleModelDefinitionDto, {
      brand: "NIO",
      displayName: "ET5",
      legacyVehicleModel: VehicleModel.ET5,
      modelCode: "NIO_ET5",
      modelName: "ET5"
    });
    const updateDto = plainToInstance(UpdateVehicleModelDefinitionDto, {
      legacyVehicleModel: VehicleModel.ET5T
    });

    await expect(validate(createDto, { forbidNonWhitelisted: true, whitelist: true })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "legacyVehicleModel" })])
    );
    await expect(validate(updateDto, { forbidNonWhitelisted: true, whitelist: true })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ property: "legacyVehicleModel" })])
    );

    const { prisma, service, user } = createHarness({
      definitions: [createDefinition({ id: "definition-et5", legacyVehicleModel: VehicleModel.ET5 })]
    });
    const legacyCreate = {
      brand: "NIO",
      displayName: "Model X",
      legacyVehicleModel: "MODEL_X_2027",
      modelCode: "MODEL_X_2027",
      modelName: "Model X"
    } as unknown as CreateVehicleModelDefinitionDto;
    const legacyUpdate = {
      legacyVehicleModel: VehicleModel.ET5T,
      modelCode: "NIO_ET5_TOURING"
    } as unknown as UpdateVehicleModelDefinitionDto;

    await service.createDefinition(legacyCreate, user);
    await service.updateDefinition("definition-et5", legacyUpdate, user);

    expect(prisma.vehicleModelDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ legacyVehicleModel: expect.anything() }) })
    );
    expect(prisma.vehicleModelDefinition.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ legacyVehicleModel: expect.anything() }) })
    );
  });

  it("allows new model definitions without legacyVehicleModel", async () => {
    const { service, user } = createHarness({ definitions: [] });

    const definition = await service.createDefinition(
      {
        brand: "NIO",
        displayName: "NEW MODEL",
        modelCode: "NEW_MODEL",
        modelName: "NEW MODEL"
      },
      user
    );

    expect(definition.legacyVehicleModel).toBeNull();
  });

  it("enables and disables model definitions", async () => {
    const { service, user } = createHarness({
      definitions: [createDefinition({ enabled: true, id: "definition-1" })]
    });

    const disabled = await service.disableDefinition("definition-1", user);
    expect(disabled.enabled).toBe(false);

    const enabled = await service.enableDefinition("definition-1", user);
    expect(enabled.enabled).toBe(true);
  });

  it("soft deletes definitions and hides them from default lists", async () => {
    const { service, user } = createHarness({
      definitions: [createDefinition({ id: "definition-1", modelCode: "ET5" })]
    });

    await service.deleteDefinition("definition-1", user);
    const result = await service.listDefinitions({});

    expect(result.items).toHaveLength(0);
  });

  it("supports keyword, enabled, and portalVisible filters", async () => {
    const { service } = createHarness({
      definitions: [
        createDefinition({ displayName: "ET5", enabled: true, modelCode: "ET5", portalVisible: true }),
        createDefinition({ displayName: "ES8", enabled: false, modelCode: "ES8", portalVisible: false })
      ]
    });

    const keywordResult = await service.listDefinitions({ keyword: "ET" });
    const enabledResult = await service.listDefinitions({ enabled: false });
    const portalVisibleResult = await service.listDefinitions({ portalVisible: true });

    expect(keywordResult.items.map((item) => item.modelCode)).toEqual(["ET5"]);
    expect(enabledResult.items.map((item) => item.modelCode)).toEqual(["ES8"]);
    expect(portalVisibleResult.items.map((item) => item.modelCode)).toEqual(["ET5"]);
  });

  it("keeps seed initialization aligned to the eight legacy enum mappings", () => {
    const seedSource = fs.readFileSync(path.resolve(__dirname, "../prisma/seed.mjs"), "utf8");

    expect(seedSource).toContain("const vehicleModelDefinitionSeedRows = [");
    for (const modelCode of ["ET5", "ET5T", "ET7", "EC6", "ES6", "ES8", "ET9", "ES9"]) {
      expect(seedSource).toContain(`"${modelCode}"`);
    }
    expect(seedSource).toContain("await seedVehicleModelDefinitions(adminUser.id)");
    expect(seedSource).toContain("prisma.vehicleModelDefinition.upsert");
  });

  it("keeps Vehicle model compatibility columns as strings with optional master-data linkage", () => {
    const schemaSource = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");

    expect(schemaSource).toContain("vehicleModel                  String");
    expect(schemaSource).toContain("modelDefinitionId");
    expect(schemaSource).toContain("VehicleModelDefinition?");
    expect(schemaSource).not.toContain("enum VehicleModel");
  });
});

function createHarness(options: { definitions?: Array<ReturnType<typeof createDefinition>> } = {}) {
  const definitions = [...(options.definitions ?? [createDefinition()])];
  const prisma = {
    $transaction: vi.fn(),
    vehicleModelDefinition: {
      count: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        filterDefinitions(definitions, where).length
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const definition = {
          ...createDefinition(),
          ...data,
          id: `definition-${definitions.length + 1}`
        } as ReturnType<typeof createDefinition>;
        definitions.push(definition);
        return definition;
      }),
      findFirst: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        filterDefinitions(definitions, where)[0] ?? null
      ),
      findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        filterDefinitions(definitions, where)
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const index = definitions.findIndex((definition) => definition.id === where.id);
        const current = definitions[index] ?? createDefinition({ id: where.id });
        const updated = {
          ...current,
          ...data,
          updatedAt: new Date("2026-06-24T08:00:00.000Z")
        } as ReturnType<typeof createDefinition>;
        if (index >= 0) {
          definitions[index] = updated;
        } else {
          definitions.push(updated);
        }
        return updated;
      })
    }
  };
  prisma.$transaction.mockImplementation(
    (callback: (tx: typeof prisma) => unknown) => callback(prisma)
  );

  const service = new VehicleModelDefinitionService(prisma as never);
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: [],
    username: "admin"
  };

  return { prisma, service, user };
}

function createDefinition(options: {
  deletedAt?: Date | null;
  displayName?: string;
  enabled?: boolean;
  id?: string;
  legacyVehicleModel?: VehicleModelCode | string | null;
  modelCode?: string;
  portalVisible?: boolean;
} = {}) {
  const now = new Date("2026-06-24T00:00:00.000Z");
  const modelCode = options.modelCode ?? "ET5";
  return {
    batteryCapacityKwh: null,
    bodyType: null,
    brand: "NIO",
    createdAt: now,
    createdBy: "user-1",
    customerDisplayName: options.displayName ?? modelCode,
    deletedAt: options.deletedAt ?? null,
    displayName: options.displayName ?? modelCode,
    driveType: null,
    enabled: options.enabled ?? true,
    energyType: null,
    id: options.id ?? `definition-${modelCode}`,
    legacyVehicleModel: options.legacyVehicleModel ?? null,
    modelCode,
    modelName: modelCode,
    modelYear: null,
    officialRangeKm: null,
    portalVisible: options.portalVisible ?? false,
    remark: null,
    seatCount: null,
    series: modelCode.startsWith("EC") ? "EC" : modelCode.startsWith("ES") ? "ES" : "ET",
    snapshot: null,
    sortOrder: 0,
    updatedAt: now,
    updatedBy: "user-1",
    variantName: null
  };
}

function filterDefinitions(definitions: Array<ReturnType<typeof createDefinition>>, where: Record<string, unknown> = {}) {
  return definitions.filter((definition) => {
    if (where.deletedAt === null && definition.deletedAt !== null) {
      return false;
    }
    if (typeof where.id === "string" && definition.id !== where.id) {
      return false;
    }
    if (isNotFilter(where.id) && definition.id === where.id.not) {
      return false;
    }
    if (typeof where.modelCode === "string" && definition.modelCode !== where.modelCode) {
      return false;
    }
    if (where.legacyVehicleModel && definition.legacyVehicleModel !== where.legacyVehicleModel) {
      return false;
    }
    if (typeof where.enabled === "boolean" && definition.enabled !== where.enabled) {
      return false;
    }
    if (typeof where.portalVisible === "boolean" && definition.portalVisible !== where.portalVisible) {
      return false;
    }
    if (isStringContainsFilter(where.brand) && !contains(definition.brand, where.brand.contains)) {
      return false;
    }
    if (isStringContainsFilter(where.series) && !contains(definition.series, where.series.contains)) {
      return false;
    }
    if (Array.isArray(where.OR) && !where.OR.some((item) => matchesOrFilter(definition, item))) {
      return false;
    }
    return true;
  });
}

function matchesOrFilter(definition: ReturnType<typeof createDefinition>, item: unknown) {
  if (!item || typeof item !== "object") {
    return false;
  }
  return Object.entries(item as Record<string, unknown>).some(([field, filter]) => {
    if (typeof filter === "string") {
      return definition[field as keyof typeof definition] === filter;
    }
    if (isStringInFilter(filter)) {
      return filter.in.includes(String(definition[field as keyof typeof definition] ?? ""));
    }
    if (!isStringContainsFilter(filter)) {
      return false;
    }
    return contains(definition[field as keyof typeof definition], filter.contains);
  });
}

function contains(value: unknown, search: string) {
  return typeof value === "string" && value.toLowerCase().includes(search.toLowerCase());
}

function isNotFilter(value: unknown): value is { not: string } {
  return Boolean(value && typeof value === "object" && typeof (value as { not?: unknown }).not === "string");
}

function isStringContainsFilter(value: unknown): value is { contains: string } {
  return Boolean(
    value && typeof value === "object" && typeof (value as { contains?: unknown }).contains === "string"
  );
}

function isStringInFilter(value: unknown): value is { in: string[] } {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as { in?: unknown }).in) &&
      (value as { in: unknown[] }).in.every((item) => typeof item === "string")
  );
}
