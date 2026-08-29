import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertVehicleModelEnumRemoved } from "./check-vehicle-model-no-enum.mjs";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

test("accepts string compatibility fields without Prisma enum dependencies", () => {
  assert.doesNotThrow(() =>
    assertVehicleModelEnumRemoved(
      `
        model Vehicle {
          vehicleModel String? @map("vehicle_model") @db.VarChar(64)
        }
      `,
      [
        {
          content: "export type VehicleSummary = { vehicleModel?: string | null };",
          path: "apps/api/src/vehicle/vehicle.service.ts"
        }
      ]
    )
  );
});

test("rejects a Prisma VehicleModel enum block", () => {
  assertDependency(
    `
      enum VehicleModel {
        ET5
      }
    `,
    [],
    { category: "SCHEMA_ENUM_BLOCK", path: "apps/api/prisma/schema.prisma" }
  );
});

test("rejects a Prisma field typed as VehicleModel", () => {
  assertDependency(
    `
      model Vehicle {
        vehicleModel VehicleModel? @map("vehicle_model")
      }
    `,
    [],
    { category: "SCHEMA_ENUM_FIELD", path: "apps/api/prisma/schema.prisma" }
  );
});

test("rejects a Prisma list field typed as VehicleModel", () => {
  assertDependency(
    `
      model VehicleModelCollection {
        models VehicleModel[]
      }
    `,
    [],
    { category: "SCHEMA_ENUM_FIELD", path: "apps/api/prisma/schema.prisma" }
  );
});

test("rejects a runtime Prisma VehicleModel import", () => {
  assertDependency(
    "model Vehicle { vehicleModel String? }",
    [
      {
        content: 'import { Prisma, VehicleModel } from "@prisma/client";',
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ],
    { category: "PRISMA_VEHICLE_MODEL_IMPORT", path: "apps/api/src/vehicle/vehicle.service.ts" }
  );
});

test("rejects real Prisma VehicleModel imports in JS, MJS, TS, and TSX sources", () => {
  for (const extension of ["js", "mjs", "ts", "tsx"]) {
    const path = `apps/api/src/vehicle/vehicle.service.${extension}`;

    assertDependency(
      "model Vehicle { vehicleModel String? }",
      [
        {
          content: 'import { VehicleModel } from "@prisma/client";',
          path
        }
      ],
      { category: "PRISMA_VEHICLE_MODEL_IMPORT", path }
    );
  }
});

test("rejects a real Prisma namespace VehicleModel dependency", () => {
  assertDependency(
    "model Vehicle { vehicleModel String? }",
    [
      {
        content:
          'import * as PrismaClient from "@prisma/client";\nexport type LegacyModel = PrismaClient.VehicleModel;',
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ],
    { category: "PRISMA_VEHICLE_MODEL_NAMESPACE", path: "apps/api/src/vehicle/vehicle.service.ts" }
  );
});

test("rejects VehicleModel references through a named Prisma import", () => {
  for (const reference of ["Prisma.VehicleModel", "Prisma.$Enums.VehicleModel"]) {
    assertDependency(
      "model Vehicle { vehicleModel String? }",
      [
        {
          content: [
            'import { Prisma } from "@prisma/client";',
            `export type LegacyModel = ${reference};`
          ].join("\n"),
          path: "apps/api/src/vehicle/vehicle.service.ts"
        }
      ],
      {
        category: "PRISMA_VEHICLE_MODEL_NAMESPACE",
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    );
  }
});

test("rejects VehicleModel re-exports from Prisma", () => {
  for (const content of [
    'export { VehicleModel } from "@prisma/client";',
    'export type { VehicleModel as LegacyModel } from "@prisma/client";',
    'export * from "@prisma/client";',
    'export * as PrismaClient from "@prisma/client";'
  ]) {
    assertDependency(
      "model Vehicle { vehicleModel String? }",
      [
        {
          content,
          path: "apps/api/src/vehicle/vehicle.service.ts"
        }
      ],
      { category: "PRISMA_VEHICLE_MODEL_IMPORT", path: "apps/api/src/vehicle/vehicle.service.ts" }
    );
  }
});

test("rejects VehicleModel import-type expressions", () => {
  for (const reference of [
    'import("@prisma/client").VehicleModel',
    'import("@prisma/client").Prisma.VehicleModel',
    'import("@prisma/client").Prisma.$Enums.VehicleModel'
  ]) {
    assertDependency(
      "model Vehicle { vehicleModel String? }",
      [
        {
          content: `export type LegacyModel = ${reference};`,
          path: "apps/api/src/vehicle/vehicle.service.ts"
        }
      ],
      { category: "PRISMA_VEHICLE_MODEL_IMPORT", path: "apps/api/src/vehicle/vehicle.service.ts" }
    );
  }
});

test("rejects CommonJS destructured VehicleModel and Prisma dependencies", () => {
  for (const fixture of [
    {
      content: 'const { VehicleModel } = require("@prisma/client");',
      category: "PRISMA_VEHICLE_MODEL_IMPORT"
    },
    {
      content: 'const { VehicleModel: LegacyModel } = require("@prisma/client");',
      category: "PRISMA_VEHICLE_MODEL_IMPORT"
    },
    {
      content: [
        'const { Prisma } = require("@prisma/client");',
        "const legacyModel = Prisma.$Enums.VehicleModel;"
      ].join("\n"),
      category: "PRISMA_VEHICLE_MODEL_NAMESPACE"
    }
  ]) {
    assertDependency(
      "model Vehicle { vehicleModel String? }",
      [
        {
          content: fixture.content,
          path: "apps/api/src/vehicle/vehicle.service.ts"
        }
      ],
      { category: fixture.category, path: "apps/api/src/vehicle/vehicle.service.ts" }
    );
  }
});

test("rejects CommonJS namespace require VehicleModel dependencies", () => {
  for (const reference of [
    "PrismaClient.VehicleModel",
    "PrismaClient.Prisma.VehicleModel",
    "PrismaClient.Prisma.$Enums.VehicleModel"
  ]) {
    assertDependency(
      "model Vehicle { vehicleModel String? }",
      [
        {
          content: [
            'const PrismaClient = require("@prisma/client");',
            `const legacyModel = ${reference};`
          ].join("\n"),
          path: "apps/api/src/vehicle/vehicle.service.ts"
        }
      ],
      {
        category: "PRISMA_VEHICLE_MODEL_NAMESPACE",
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    );
  }
});

test("rejects direct CommonJS require VehicleModel property access", () => {
  for (const expression of [
    'require("@prisma/client").VehicleModel',
    'require("@prisma/client").$Enums.VehicleModel',
    'require("@prisma/client").Prisma.VehicleModel',
    'require("@prisma/client").Prisma.$Enums.VehicleModel'
  ]) {
    assertDependency(
      "model Vehicle { vehicleModel String? }",
      [
        {
          content: `const legacyModel = ${expression};`,
          path: "scripts/runtime-backfill.mjs"
        }
      ],
      {
        category: "PRISMA_VEHICLE_MODEL_IMPORT",
        path: "scripts/runtime-backfill.mjs"
      }
    );
  }
});

test("ignores an imported namespace identifier shadowed by a function parameter", () => {
  assert.doesNotThrow(() =>
    assertVehicleModelEnumRemoved("model Vehicle { vehicleModel String? }", [
      {
        content: [
          'import * as PrismaClient from "@prisma/client";',
          "function getModel(PrismaClient) {",
          "  return PrismaClient.VehicleModel;",
          "}"
        ].join("\n"),
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ])
  );
});

test("ignores an imported namespace identifier shadowed by a local binding", () => {
  assert.doesNotThrow(() =>
    assertVehicleModelEnumRemoved("model Vehicle { vehicleModel String? }", [
      {
        content: [
          'import * as PrismaClient from "@prisma/client";',
          "function getModel() {",
          "  const PrismaClient = { VehicleModel: null };",
          "  return PrismaClient.VehicleModel;",
          "}"
        ].join("\n"),
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ])
  );
});

test("rejects a real Prisma import after a regex character class with comment markers", () => {
  assertDependency(
    "model Vehicle { vehicleModel String? }",
    [
      {
        content: [
          "const slashOrStar = /[/*]/;",
          'import { VehicleModel } from "@prisma/client";'
        ].join("\n"),
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ],
    { category: "PRISMA_VEHICLE_MODEL_IMPORT", path: "apps/api/src/vehicle/vehicle.service.ts" }
  );
});

test("ignores Prisma VehicleModel imports inside JavaScript and TypeScript comments", () => {
  assert.doesNotThrow(() =>
    assertVehicleModelEnumRemoved("model Vehicle { vehicleModel String? }", [
      {
        content: [
          '// import { VehicleModel } from "@prisma/client";',
          '/* import * as PrismaClient from "@prisma/client";',
          "type LegacyModel = PrismaClient.VehicleModel; */",
          "export const vehicleModel = null;"
        ].join("\n"),
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ])
  );
});

test("ignores Prisma VehicleModel imports inside string and template literals", () => {
  assert.doesNotThrow(() =>
    assertVehicleModelEnumRemoved("model Vehicle { vehicleModel String? }", [
      {
        content: [
          "const namedImportFixture = 'import { VehicleModel } from \"@prisma/client\";';",
          'const namespaceFixture = `import * as PrismaClient from "@prisma/client";',
          "type LegacyModel = PrismaClient.VehicleModel;`;"
        ].join("\n"),
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ])
  );
});

test("ignores Prisma VehicleModel import text inside regex literals", () => {
  assert.doesNotThrow(() =>
    assertVehicleModelEnumRemoved("model Vehicle { vehicleModel String? }", [
      {
        content: 'const importPattern = /import { VehicleModel } from "@prisma\\/client"/;',
        path: "apps/api/src/vehicle/vehicle.service.ts"
      }
    ])
  );
});

test("release check runs the no-enum guard directly without a package script", () => {
  const releaseCheck = readFileSync(resolve(currentDirectory, "release-check.mjs"), "utf8");

  assert.match(
    releaseCheck,
    /\[\s*"VehicleModel no-enum guard"\s*,\s*"node"\s*,\s*\[\s*"scripts\/check-vehicle-model-no-enum\.mjs"\s*\]\s*\]/
  );
  assert.match(
    releaseCheck,
    /\[\s*"VehicleModel no-enum guard tests"\s*,\s*"node"\s*,\s*\[\s*"--test"\s*,\s*"scripts\/check-vehicle-model-no-enum\.test\.mjs"\s*\]\s*\]/
  );
  assert.doesNotMatch(releaseCheck, /vehicle-model:enum-freeze/);
});

test("no-enum guard scans executable model backfill scripts", () => {
  const source = readFileSync(resolve(currentDirectory, "check-vehicle-model-no-enum.mjs"), "utf8");

  assert.doesNotMatch(
    source,
    /pathFromRoot\.startsWith\("scripts\/(?:model-definition|quote-order-model(?:-code)?-snapshot)-backfill"\)/
  );
});

function assertDependency(schemaText, runtimeFiles, expectedDependency) {
  assert.throws(
    () => assertVehicleModelEnumRemoved(schemaText, runtimeFiles),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.deepEqual(error.dependencies, [expectedDependency]);
      return true;
    }
  );
}
