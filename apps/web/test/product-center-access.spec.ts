import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const productsPagePath = "apps/web/src/app/products/page.tsx";

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
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}

function functionSource(source: string, name: string) {
  const start = source.indexOf(`const ${name} =`);
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
