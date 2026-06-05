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
    for (const roleCode of ["SA", "OP"]) {
      expectRolePermissions(roleCode, [
        "application:view",
        "quote:create",
        "quote:view",
        "vehicle:view",
        "subscription_plan:view"
      ]);
    }

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

  function expectRolePermissions(roleCode: string, permissionCodes: string[]) {
    const permissionsSource = rolePermissionArray(roleCode);

    for (const permissionCode of permissionCodes) {
      expect(roleHasPermission(permissionsSource, permissionCode)).toBe(true);
    }
  }

  function rolePermissionArray(roleCode: string) {
    const pattern = new RegExp(
      `await\\s+assignRoleAccess\\(\\s*["']${escapeRegExp(roleCode)}["']\\s*,\\s*\\[([\\s\\S]*?)\\]\\s*,`
    );
    const match = seedSource.match(pattern);
    const source = match?.[1];

    expect(source).toBeDefined();
    return source ?? "";
  }

  function roleHasPermission(source: string, permissionCode: string, seen = new Set<string>()) {
    if (containsQuotedValue(source, permissionCode)) {
      return true;
    }

    for (const identifier of spreadIdentifiers(source)) {
      if (seen.has(identifier)) {
        continue;
      }

      seen.add(identifier);

      if (roleHasPermission(permissionConstantSource(identifier), permissionCode, seen)) {
        return true;
      }
    }

    return false;
  }

  function permissionConstantSource(identifier: string) {
    const parts: string[] = [];
    const declarationPattern = new RegExp(
      `const\\s+${escapeRegExp(identifier)}\\s*=\\s*\\[([\\s\\S]*?)\\];`
    );
    const declarationMatch = seedSource.match(declarationPattern);
    const declarationSource = declarationMatch?.[1];

    if (declarationSource) {
      parts.push(declarationSource);
    }

    const pushPattern = new RegExp(`${escapeRegExp(identifier)}\\.push\\(([\\s\\S]*?)\\);`, "g");

    for (const pushMatch of seedSource.matchAll(pushPattern)) {
      const pushSource = pushMatch[1];

      if (pushSource) {
        parts.push(pushSource);
      }
    }

    return parts.join("\n");
  }

  function spreadIdentifiers(source: string) {
    const identifiers: string[] = [];

    for (const match of source.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) {
      const identifier = match[1];

      if (identifier) {
        identifiers.push(identifier);
      }
    }

    return identifiers;
  }

  function containsQuotedValue(source: string, value: string) {
    return new RegExp(`["']${escapeRegExp(value)}["']`).test(source);
  }

  function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
});
