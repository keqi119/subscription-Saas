import fs from "node:fs";
import path from "node:path";

import { BadRequestException } from "@nestjs/common";
import { VehicleModel } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { VehicleModelDefinitionService } from "../src/vehicle-model-definition/vehicle-model-definition.service";

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

  it("rejects duplicate legacyVehicleModel mappings", async () => {
    const { service, user } = createHarness({
      definitions: [createDefinition({ legacyVehicleModel: VehicleModel.ET5, modelCode: "ET5" })]
    });

    await expect(
      service.createDefinition(
        {
          brand: "NIO",
          displayName: "ET5 legacy duplicate",
          legacyVehicleModel: VehicleModel.ET5,
          modelCode: "ET5_COPY",
          modelName: "ET5"
        },
        user
      )
    ).rejects.toBeInstanceOf(BadRequestException);
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

  it("keeps Vehicle on the legacy VehicleModel enum while allowing optional master-data linkage", () => {
    const schemaSource = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");

    expect(schemaSource).toContain("vehicleModel                  VehicleModel?");
    expect(schemaSource).toContain("modelDefinitionId");
    expect(schemaSource).toContain("VehicleModelDefinition?");
  });
});

function createHarness(options: { definitions?: Array<ReturnType<typeof createDefinition>> } = {}) {
  const definitions = [...(options.definitions ?? [createDefinition()])];
  const prisma = {
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
  legacyVehicleModel?: VehicleModel | null;
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
