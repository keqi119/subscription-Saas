import fs from "node:fs";
import path from "node:path";

import { BadRequestException, ConflictException, ValidationPipe } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import {
  CreateVehicleModelDefinitionDto,
  UpdateVehicleModelDefinitionDto
} from "../src/vehicle-model-definition/dto/vehicle-model-definition.dto";
import { VehicleModelDefinitionService } from "../src/vehicle-model-definition/vehicle-model-definition.service";
import {
  TEST_MODEL_CODES,
  type TestModelCode
} from "./helpers/vehicle-model-codes";

function validateProductionBody<T>(value: unknown, metatype: new () => T) {
  return new ValidationPipe({
    transform: true,
    whitelist: true
  }).transform(value, {
    metatype,
    type: "body"
  });
}

async function expectLegacyWriteRejected(validation: Promise<unknown>) {
  const dto = await validation;
  expect(dto).not.toHaveProperty("legacyVehicleModel");
}

describe("VehicleModelDefinition write DTO production validation", () => {
  it("accepts a canonical create payload", async () => {
    const dto = await validateProductionBody(
      {
        brand: "NIO",
        displayName: "ET5",
        modelCode: "NIO_ET5",
        modelName: "ET5"
      },
      CreateVehicleModelDefinitionDto
    );

    expect(dto).toBeInstanceOf(CreateVehicleModelDefinitionDto);
    expect(dto).toMatchObject({
      brand: "NIO",
      displayName: "ET5",
      modelCode: "NIO_ET5",
      modelName: "ET5"
    });
  });

  it("rejects legacyVehicleModel in a create payload", async () => {
    await expectLegacyWriteRejected(
      validateProductionBody(
        {
          brand: "NIO",
          displayName: "ET5",
          legacyVehicleModel: TEST_MODEL_CODES.ET5,
          modelCode: "NIO_ET5",
          modelName: "ET5"
        },
        CreateVehicleModelDefinitionDto
      )
    );
  });

  it.each([null, ""])(
    "rejects JSON-present legacyVehicleModel=%j in a create payload",
    async (legacyVehicleModel) => {
      await expectLegacyWriteRejected(
        validateProductionBody(
          {
            brand: "NIO",
            displayName: "ET5",
            legacyVehicleModel,
            modelCode: "NIO_ET5",
            modelName: "ET5"
          },
          CreateVehicleModelDefinitionDto
        )
      );
    }
  );

  it("accepts a canonical update payload", async () => {
    const dto = await validateProductionBody(
      {
        displayName: "ET5 2027",
        modelCode: "NIO_ET5_2027"
      },
      UpdateVehicleModelDefinitionDto
    );

    expect(dto).toBeInstanceOf(UpdateVehicleModelDefinitionDto);
    expect(dto).toMatchObject({
      displayName: "ET5 2027",
      modelCode: "NIO_ET5_2027"
    });
  });

  it("rejects legacyVehicleModel in an update payload", async () => {
    await expectLegacyWriteRejected(
      validateProductionBody(
        {
          legacyVehicleModel: TEST_MODEL_CODES.ET5T,
          modelCode: "NIO_ET5_TOURING"
        },
        UpdateVehicleModelDefinitionDto
      )
    );
  });

  it.each([null, ""])(
    "rejects JSON-present legacyVehicleModel=%j in an update payload",
    async (legacyVehicleModel) => {
      await expectLegacyWriteRejected(
        validateProductionBody(
          {
            legacyVehicleModel,
            modelCode: "NIO_ET5_TOURING"
          },
          UpdateVehicleModelDefinitionDto
        )
      );
    }
  );
});

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
      { displayName: "ET5 refreshed", modelCode: "ET5" },
      user
    );

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    expect(prisma.vehicleModelDefinition.update).toHaveBeenCalled();
  });

  it("rejects modelCode renaming after a definition has been created", async () => {
    const { prisma, service, user } = createHarness({
      definitions: [createDefinition({ id: "definition-et5", modelCode: "ET5" })]
    });

    await expect(
      service.updateDefinition(
        "definition-et5",
        { modelCode: "NIO_ET5" },
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.vehicleModelDefinition.update).not.toHaveBeenCalled();
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

  it("uses modelCode rather than displayName as the uniqueness namespace", async () => {
    const { service, user } = createHarness({
      definitions: [
        createDefinition({
          displayName: "Shared display name",
          id: "definition-existing",
          modelCode: "NIO_ET5"
        })
      ]
    });

    await expect(
      service.createDefinition(
        {
          brand: "NIO",
          displayName: "Shared display name",
          modelCode: "NIO_ET5_CUSTOM",
          modelName: "ET5 Custom"
        },
        user
      )
    ).resolves.toMatchObject({ modelCode: "NIO_ET5_CUSTOM" });
  });

  it("never persists legacy aliases when the service is called directly", async () => {
    const { prisma, service, user } = createHarness({
      definitions: [
        createDefinition({
          id: "definition-et5",
          legacyVehicleModel: TEST_MODEL_CODES.ET5
        })
      ]
    });
    const legacyCreate = {
      brand: "NIO",
      displayName: "Model X",
      legacyVehicleModel: "MODEL_X_2027",
      modelCode: "MODEL_X_2027",
      modelName: "Model X"
    } as unknown as CreateVehicleModelDefinitionDto;
    const legacyUpdate = {
      legacyVehicleModel: TEST_MODEL_CODES.ET5T,
      modelCode: "ET5"
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

  it("allows new model definitions with canonical modelCode", async () => {
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

    expect(definition.modelCode).toBe("NEW_MODEL");
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

  it("keeps seed initialization aligned to the eight canonical codes without aliases", () => {
    const seedSource = fs.readFileSync(path.resolve(__dirname, "../prisma/seed.mjs"), "utf8");

    expect(seedSource).toContain("const vehicleModelDefinitionSeedRows = [");
    for (const modelCode of [
      "NIO_ET5",
      "NIO_ET5T",
      "NIO_ET7",
      "NIO_EC6",
      "NIO_ES6",
      "NIO_ES8",
      "NIO_ET9",
      "NIO_ES9"
    ]) {
      expect(seedSource).toContain(`["${modelCode}", "NIO"`);
    }
    expect(seedSource).not.toContain("legacyVehicleModel");
    expect(seedSource).toContain("await seedVehicleModelDefinitions(adminUser.id)");
    expect(seedSource).toContain("await convergeVehicleModelDefinition(prisma");
  });

  it("keeps only required canonical master-data linkage", () => {
    const schemaSource = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");

    expect(schemaSource).not.toContain("vehicleModel                  String");
    expect(schemaSource).toContain("modelDefinitionId");
    expect(schemaSource).toContain("VehicleModelDefinition");
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
  legacyVehicleModel?: TestModelCode | string | null;
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
