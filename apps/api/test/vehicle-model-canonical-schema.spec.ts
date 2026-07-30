import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");

describe("canonical VehicleModel schema contract", () => {
  it("removes every legacy model compatibility field", () => {
    const uncommentedSchema = stripPrismaComments(schema);

    for (const pattern of [
      /\bvehicleModel\s+(?:String|VehicleModel)/,
      /\blegacyVehicleModel\b/,
      /\blegacyVehicleModelSnapshot\b/,
      /\blegacyVehicleModelCodeSnapshot\b/,
      /\benum\s+VehicleModel\b/
    ]) {
      expect(uncommentedSchema).not.toMatch(pattern);
    }
  });

  it.each(["Vehicle", "VehiclePackage", "ProductPriceRule"])(
    "requires %s.modelDefinitionId",
    (modelName) => {
      expect(extractModel(schema, modelName)).toMatch(
        /^\s*modelDefinitionId\s+String\s+@map\("model_definition_id"\)\s+@db\.Uuid/m
      );
    }
  );

  it.each(["SubscriptionQuote", "SubscriptionOrder"])(
    "requires canonical immutable model snapshots on %s",
    (modelName) => {
      const model = extractModel(schema, modelName);

      expect(model).toMatch(
        /^\s*modelDefinitionIdSnapshot\s+String\s+@map\("model_definition_id_snapshot"\)\s+@db\.Uuid/m
      );
      expect(model).toMatch(
        /^\s*modelCodeSnapshot\s+String\s+@map\("model_code_snapshot"\)\s+@db\.VarChar\(64\)/m
      );
      expect(model).toMatch(
        /^\s*modelDisplayNameSnapshot\s+String\s+@map\("model_display_name_snapshot"\)\s+@db\.VarChar\(128\)/m
      );
    }
  );
});

function stripPrismaComments(value: string) {
  return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function extractModel(value: string, modelName: string) {
  const match = value.match(new RegExp(`\\bmodel\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"));

  if (!match) {
    throw new Error(`Prisma model ${modelName} was not found.`);
  }

  return match[1];
}
