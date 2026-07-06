import "reflect-metadata";

import fs from "node:fs";
import path from "node:path";

import { PermissionCode, SYSTEM_MENUS } from "@subscription-saas/shared";
import { describe, expect, it } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { ProductController } from "../src/product/product.controller";
import { VehicleModelDefinitionController } from "../src/vehicle-model-definition/vehicle-model-definition.controller";

describe("product center access contract", () => {
  it("keeps product center read endpoints aligned to product-center permissions", () => {
    const endpointPermissions = [
      [ProductController.prototype.listProducts, PermissionCode.PRODUCT_VIEW],
      [ProductController.prototype.listVersions, PermissionCode.PRODUCT_VERSION_VIEW],
      [ProductController.prototype.listVehiclePackages, PermissionCode.VEHICLE_PACKAGE_VIEW],
      [ProductController.prototype.listMileagePackages, PermissionCode.MILEAGE_PACKAGE_VIEW],
      [ProductController.prototype.listEnergyPackages, PermissionCode.ENERGY_PACKAGE_VIEW],
      [ProductController.prototype.listBenefitPackages, PermissionCode.BENEFIT_PACKAGE_VIEW],
      [ProductController.prototype.listSubscriptionPlans, PermissionCode.SUBSCRIPTION_PLAN_VIEW],
      [VehicleModelDefinitionController.prototype.listDefinitions, PermissionCode.VEHICLE_MODEL_VIEW]
    ] as const;

    for (const [handler, permission] of endpointPermissions) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([permission]);
    }
  });

  it("keeps product center menu keys mapped to their view permissions", () => {
    const expectedMenus = new Map([
      ["products.subscription", PermissionCode.PRODUCT_VIEW],
      ["products.versions", PermissionCode.PRODUCT_VERSION_VIEW],
      ["products.vehicle_packages", PermissionCode.VEHICLE_PACKAGE_VIEW],
      ["products.mileage_packages", PermissionCode.MILEAGE_PACKAGE_VIEW],
      ["products.energy_packages", PermissionCode.ENERGY_PACKAGE_VIEW],
      ["products.benefit_packages", PermissionCode.BENEFIT_PACKAGE_VIEW],
      ["products.subscription_plans", PermissionCode.SUBSCRIPTION_PLAN_VIEW]
    ]);

    const menus = flattenMenus(SYSTEM_MENUS);
    for (const [code, permission] of expectedMenus) {
      expect(menus.get(code)?.permissionCode).toBe(permission);
    }
  });

  it("keeps seed expectations compatible with ADMIN all-permission and all-menu provisioning", () => {
    const seedSource = fs.readFileSync(path.resolve(__dirname, "../prisma/seed.mjs"), "utf8");

    for (const permission of [
      "product:view",
      "product_version:view",
      "vehicle_package:view",
      "mileage_package:view",
      "energy_package:view",
      "benefit_package:view",
      "subscription_plan:view",
      "vehicle_model:view"
    ]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    for (const menuCode of [
      "products.subscription",
      "products.versions",
      "products.vehicle_packages",
      "products.mileage_packages",
      "products.energy_packages",
      "products.benefit_packages",
      "products.subscription_plans"
    ]) {
      expect(seedSource).toContain(`"${menuCode}"`);
    }

    expect(seedSource).toContain('const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: "ADMIN" } })');
    expect(seedSource).toContain("const allPermissions = await prisma.permission.findMany()");
    expect(seedSource).toContain("const allMenus = await prisma.menu.findMany()");
    expect(seedSource).toContain("data: allPermissions.map((permission) => ({");
    expect(seedSource).toContain("data: allMenus.map((menu) => ({");
  });
});

function flattenMenus(menus: typeof SYSTEM_MENUS) {
  const result = new Map<string, (typeof SYSTEM_MENUS)[number]>();
  for (const menu of menus) {
    result.set(menu.code, menu);
    for (const child of menu.children ?? []) {
      result.set(child.code, child);
    }
  }
  return result;
}
