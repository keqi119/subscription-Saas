import { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const schemaSource = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");

function field(modelName: string, fieldName: string) {
  const model = Prisma.dmmf.datamodel.models.find((item) => item.name === modelName);
  return model?.fields.find((item) => item.name === fieldName);
}

function schemaType(modelName: string, fieldName: string) {
  const model = schemaSource.match(
    new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`)
  )?.[1];
  return model?.match(new RegExp(`^\\s*${fieldName}\\s+([^\\s]+)`, "m"))?.[1];
}

describe("customer application profile persistence", () => {
  it.each([
    ["residenceProvince", "String"],
    ["residenceCity", "String"],
    ["residenceDistrict", "String"],
    ["residenceDetail", "String"]
  ])("adds optional CustomerProfile.%s", (name, type) => {
    expect(field("CustomerProfile", name)).toMatchObject({ type });
    expect(schemaType("CustomerProfile", name)).toBe(`${type}?`);
  });

  it("adds an optional Application customer profile snapshot", () => {
    expect(field("Application", "customerProfileSnapshot")).toMatchObject({ type: "Json" });
    expect(schemaType("Application", "customerProfileSnapshot")).toBe("Json?");
  });
});
