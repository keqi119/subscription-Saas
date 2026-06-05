import "reflect-metadata";

import fs from "node:fs";
import path from "node:path";

import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it } from "vitest";

import { REQUIRED_ANY_PERMISSIONS_KEY, REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { hasAnyRequiredPermission, hasRequiredPermissions } from "../src/auth/permissions";
import { ProductController } from "../src/product/product.controller";
import { VehicleController } from "../src/vehicle/vehicle.controller";

describe("hasRequiredPermissions", () => {
  it("allows requests with every required permission", () => {
    expect(hasRequiredPermissions(["user:view", "role:view"], ["user:view"])).toBe(true);
  });

  it("denies requests missing a required permission", () => {
    expect(hasRequiredPermissions(["user:view"], ["user:view", "role:manage"])).toBe(false);
  });
});

describe("hasAnyRequiredPermission", () => {
  it("allows requests with one matching permission", () => {
    expect(hasAnyRequiredPermission(["quote:create"], ["vehicle:view", "quote:create"])).toBe(true);
  });

  it("denies requests without any matching permission", () => {
    expect(hasAnyRequiredPermission(["quote:view"], ["vehicle:view", "quote:create"])).toBe(false);
  });
});

describe("vehicle availability permissions", () => {
  const requiredAnyPermissions = Reflect.getMetadata(
    REQUIRED_ANY_PERMISSIONS_KEY,
    VehicleController.prototype.listAvailableVehicles
  );

  it("allows vehicle:view or quote:create for /vehicles/available", () => {
    expect(requiredAnyPermissions).toEqual([
      PermissionCode.VEHICLE_VIEW,
      PermissionCode.QUOTE_CREATE
    ]);
    expect(hasAnyRequiredPermission([PermissionCode.VEHICLE_VIEW], requiredAnyPermissions)).toBe(true);
    expect(hasAnyRequiredPermission([PermissionCode.QUOTE_CREATE], requiredAnyPermissions)).toBe(true);
  });

  it("denies /vehicles/available without either permission", () => {
    expect(hasAnyRequiredPermission([PermissionCode.QUOTE_VIEW], requiredAnyPermissions)).toBe(false);
  });

  it("keeps available subscription plans gated by quote:create", () => {
    const requiredPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ProductController.prototype.listAvailableSubscriptionPlans
    );
    expect(requiredPermissions).toEqual([PermissionCode.QUOTE_CREATE]);
  });
});

describe("seed permission calibration", () => {
  const seedSource = fs.readFileSync(path.resolve(__dirname, "../prisma/seed.mjs"), "utf8");

  it("defines vehicle and subscription plan permissions for ADMIN all-permission seeding", () => {
    for (const permission of [
      "vehicle:view",
      "vehicle:create",
      "vehicle:update",
      "vehicle:delete",
      "vehicle:update_status",
      "vehicle:initialize_sale_price",
      "vehicle:review_sale_price",
      "vehicle:history_view",
      "subscription_plan:view",
      "subscription_plan:create",
      "subscription_plan:update",
      "subscription_plan:activate",
      "subscription_plan:deactivate",
      "subscription_plan:delete"
    ]) {
      expect(seedSource).toContain(`"${permission}"`);
    }
    expect(seedSource).toContain("const allPermissions = await prisma.permission.findMany()");
    expect(seedSource).toContain("allPermissions.map((permission)");
  });

  it("gives OP and SA quote, vehicle, application, and subscription plan access", () => {
    expect(roleBlock("SA")).toContain("\"application:view\"");
    expect(roleBlock("SA")).toContain("...productPackageViewPermissions");
    expect(roleBlock("SA")).toContain("...vehicleViewPermissions");
    expect(roleBlock("SA")).toContain("...quoteManagementPermissions");

    expect(roleBlock("OP")).toContain("\"application:view\"");
    expect(roleBlock("OP")).toContain("...productManagementPermissions");
    expect(roleBlock("OP")).toContain("...vehicleManagementPermissions");
    expect(roleBlock("OP")).toContain("...quoteManagementPermissions");

    expect(seedSource).toContain("\"quote:create\"");
    expect(seedSource).toContain("\"subscription_plan:view\"");
    expect(seedSource).toContain("const vehicleViewPermissions = [\"vehicle:view\"");
  });

  it("gives AS the vehicle management permission set", () => {
    expect(seedSource).toContain("for (const roleCode of [\"FI\", \"AS\"])");
    expect(seedSource).toContain("roleCode === \"AS\" ? vehicleManagementPermissions : vehicleViewPermissions");
    expect(seedSource).toContain("\"vehicle:initialize_sale_price\"");
    expect(seedSource).toContain("\"vehicle:review_sale_price\"");
  });

  function roleBlock(roleCode: string) {
    const marker = `await assignRoleAccess(\n    "${roleCode}",`;
    const start = seedSource.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = seedSource.indexOf("\n  await assignRoleAccess(", start + marker.length);
    return seedSource.slice(start, next === -1 ? undefined : next);
  }
});
