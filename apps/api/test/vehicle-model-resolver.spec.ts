import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import {
  requireActiveVehicleModelDefinition,
  vehicleModelResolverDefinitionSelect
} from "../src/common/vehicle-model-resolver";

describe("requireActiveVehicleModelDefinition", () => {
  it("returns the canonical identity for an active definition", async () => {
    const calls: unknown[] = [];
    const prisma = createReader(
      {
        deletedAt: null,
        displayName: "Model X 2027",
        enabled: true,
        id: "definition-id",
        modelCode: "MODEL_X_2027"
      },
      calls
    );

    await expect(
      requireActiveVehicleModelDefinition(prisma as never, "definition-id")
    ).resolves.toEqual({
      modelCode: "MODEL_X_2027",
      modelDefinitionId: "definition-id",
      modelDisplayName: "Model X 2027"
    });
    expect(calls).toEqual([
      {
        select: vehicleModelResolverDefinitionSelect,
        where: { id: "definition-id" }
      }
    ]);
  });

  it("rejects a missing definition with a Chinese BadRequestException", async () => {
    const promise = requireActiveVehicleModelDefinition(
      createReader(null) as never,
      "missing-definition"
    );

    await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    await expect(promise).rejects.toThrow("车型主数据不存在。");
  });

  it("rejects a deleted definition with a Chinese BadRequestException", async () => {
    const promise = requireActiveVehicleModelDefinition(
      createReader({
        deletedAt: new Date("2026-07-30T00:00:00.000Z"),
        displayName: "Deleted Model",
        enabled: true,
        id: "deleted-definition",
        modelCode: "DELETED_MODEL"
      }) as never,
      "deleted-definition"
    );

    await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    await expect(promise).rejects.toThrow("车型主数据已删除。");
  });

  it("rejects a disabled definition with a Chinese BadRequestException", async () => {
    const promise = requireActiveVehicleModelDefinition(
      createReader({
        deletedAt: null,
        displayName: "Disabled Model",
        enabled: false,
        id: "disabled-definition",
        modelCode: "DISABLED_MODEL"
      }) as never,
      "disabled-definition"
    );

    await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    await expect(promise).rejects.toThrow("车型主数据已停用。");
  });
});

function createReader(definition: unknown, calls: unknown[] = []) {
  return {
    vehicleModelDefinition: {
      findFirst: async (args: unknown) => {
        calls.push(args);
        return definition;
      }
    }
  };
}
