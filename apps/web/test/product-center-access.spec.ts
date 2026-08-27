import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const productsPagePath = "apps/web/src/app/products/page.tsx";
const portalTypesPath = "apps/web/src/lib/portal-types.ts";
const vehicleDetailActionsPath =
  "apps/web/src/components/vehicle-workspace/vehicle-detail-actions.tsx";
const vehiclesPagePath = "apps/web/src/app/vehicles/page.tsx";
const vehicleModelDefinitionsPagePath = "apps/web/src/app/vehicle-model-definitions/page.tsx";

describe("product center access isolation", () => {
  const source = read(productsPagePath);

  it("does not use an all-tab Promise.all loader for initial product center data", () => {
    const initialLoader = functionSource(source, "loadData");

    expect(initialLoader).not.toContain("Promise.all");
  });

  it("keeps vehicle model definitions out of the initial products tab load", () => {
    const initialLoader = functionSource(source, "loadData");

    expect(initialLoader).toContain('activeTab === "products"');
    expect(initialLoader).toContain("await loadProducts()");
    expect(initialLoader).not.toContain("/vehicle-model-definitions?enabled=true&pageSize=100");
  });

  it("keeps inactive package and plan endpoints out of the initial products tab load", () => {
    const initialLoader = functionSource(source, "loadData");
    const productsBranch = initialLoader.slice(
      initialLoader.indexOf('if (activeTab === "products"'),
      initialLoader.indexOf("const activePackageKind")
    );

    for (const endpoint of [
      "/vehicle-packages",
      "/mileage-packages",
      "/energy-packages",
      "/benefit-packages",
      "/subscription-plans"
    ]) {
      expect(productsBranch, `${endpoint} must not be fetched by the active products branch`).not.toContain(endpoint);
    }
  });

  it("checks the active tab permission before fetching active tab data", () => {
    const initialLoader = functionSource(source, "loadData");

    expect(initialLoader.indexOf("!permissions.has(requiredPermission)")).toBeLessThan(
      initialLoader.indexOf("await loadProducts()")
    );
    expect(initialLoader.indexOf("!permissions.has(requiredPermission)")).toBeLessThan(
      initialLoader.indexOf("await loadPackageRows(activePackageKind)")
    );
  });

  it("routes package tabs through one active package loader instead of fetching every package tab", () => {
    const initialLoader = functionSource(source, "loadData");

    expect(initialLoader).toContain("const activePackageKind = packageKindFromTab(activeTab)");
    expect(initialLoader).toContain("await loadPackageRows(activePackageKind)");
    expect(initialLoader).not.toContain('apiFetch<PackageRow[]>("/vehicle-packages")');
    expect(initialLoader).not.toContain('apiFetch<PackageRow[]>("/mileage-packages")');
    expect(initialLoader).not.toContain('apiFetch<PackageRow[]>("/energy-packages")');
    expect(initialLoader).not.toContain('apiFetch<PackageRow[]>("/benefit-packages")');
  });

  it("declares permission metadata for all product center tabs", () => {
    for (const permission of [
      "product:view",
      "product_version:view",
      "vehicle_package:view",
      "mileage_package:view",
      "energy_package:view",
      "benefit_package:view",
      "subscription_plan:view"
    ]) {
      expect(source).toContain(permission);
    }
  });

  it("renders a tab-level permission denied state", () => {
    expect(source).toContain("tabError");
    expect(source).toContain("403");
  });

  it("keeps legacy model controls out of Admin pages while retaining canonical selectors", () => {
    const portalTypesSource = read(portalTypesPath);
    const vehicleDetailActionsSource = read(vehicleDetailActionsPath);
    const vehiclesSource = read(vehiclesPagePath);
    const definitionsSource = read(vehicleModelDefinitionsPagePath);

    for (const pageSource of [source, vehiclesSource, definitionsSource, vehicleDetailActionsSource]) {
      expect(pageSource).not.toContain("legacyVehicleModel");
      expect(pageSource).not.toContain("兼容车型（legacy）");
      expect(pageSource).not.toContain('label="legacy enum"');
    }

    expect(vehiclesSource).not.toContain("legacyVehicleModels");
    expect(vehiclesSource).not.toContain("vehicleModelOptions");
    expect(source).not.toMatch(/\bvehicleModel\??:/);
    expect(source).not.toMatch(/\.vehicleModel\b/);
    expect(vehiclesSource).not.toMatch(/\bvehicleModel\??:/);
    expect(vehiclesSource).not.toMatch(/\.vehicleModel\b/);
    expect(portalTypesSource).not.toMatch(/\bvehicleModel\??:/);
    expect(vehiclesSource).toContain('name="modelDefinitionId"');
    expect(vehicleDetailActionsSource).toContain('name="modelDefinitionId"');
    expect(source).toContain('name="modelDefinitionId"');
    expect(functionDeclarationSource(vehiclesSource, "saveCreateVehicle")).not.toContain("vehicleModel");
    expect(functionDeclarationSource(vehicleDetailActionsSource, "saveEdit")).not.toContain("vehicleModel");
    expect(functionDeclarationSource(source, "buildPackagePayload")).not.toMatch(/\bvehicleModel\s*:/);
  });

  it("keeps an existing canonical model code immutable in the Admin edit form", () => {
    const definitionsSource = read(vehicleModelDefinitionsPagePath);

    expect(definitionsSource).toContain(
      '<Input disabled={Boolean(editing)} placeholder="ET5T" />'
    );
  });

  it("edits and displays all version-bound vehicle-package model members", () => {
    expect(source).toContain('name="modelDefinitionIds"');
    expect(source).toContain("modelMembers?: VehiclePackageModelMember[]");
    expect(functionDeclarationSource(source, "buildPackagePayload")).toContain(
      "modelDefinitionIds: values.modelDefinitionIds?.length"
    );
    expect(functionDeclarationSource(source, "packageModelDisplayName")).toContain(
      "row.modelMembers"
    );
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}

function functionSource(source: string, name: string) {
  const start = source.indexOf(`const ${name} =`);
  return sourceBlock(source, start);
}

function functionDeclarationSource(source: string, name: string) {
  const start = source.indexOf(`function ${name}(`);
  return sourceBlock(source, start);
}

function sourceBlock(source: string, start: number) {
  expect(start).toBeGreaterThanOrEqual(0);

  const openBrace = source.indexOf("{", start);
  expect(openBrace).toBeGreaterThan(start);

  let depth = 0;
  let end = -1;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = source.indexOf(";", index);
        break;
      }
    }
  }

  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}
