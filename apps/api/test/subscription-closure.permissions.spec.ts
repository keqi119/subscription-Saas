import fs from "node:fs";
import path from "node:path";

import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it } from "vitest";

const permissionCodes = [
  "subscription_closure:view",
  "subscription_closure:prepare",
  "subscription_closure:receive",
  "subscription_closure:inspect",
  "subscription_closure:settle",
  "subscription_recovery:assess",
  "subscription_recovery:approve",
  "subscription_recovery:execute",
  "subscription_early_termination:create",
  "subscription_early_termination:execute"
] as const;

describe("Stage 1 P0 subscription closure access inventory", () => {
  const seed = fs.readFileSync(path.resolve(__dirname, "../prisma/seed.mjs"), "utf8");
  const labels = fs.readFileSync(
    path.resolve(__dirname, "../../web/src/constants/labels.ts"),
    "utf8"
  );
  const synchronizer = fs.readFileSync(
    path.resolve(__dirname, "../../../scripts/stage1-p0-closure-access.mjs"),
    "utf8"
  );

  it("publishes the exact shared codes and seed identities", () => {
    expect([
      PermissionCode.SUBSCRIPTION_CLOSURE_VIEW,
      PermissionCode.SUBSCRIPTION_CLOSURE_PREPARE,
      PermissionCode.SUBSCRIPTION_CLOSURE_RECEIVE,
      PermissionCode.SUBSCRIPTION_CLOSURE_INSPECT,
      PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE,
      PermissionCode.SUBSCRIPTION_RECOVERY_ASSESS,
      PermissionCode.SUBSCRIPTION_RECOVERY_APPROVE,
      PermissionCode.SUBSCRIPTION_RECOVERY_EXECUTE,
      PermissionCode.SUBSCRIPTION_EARLY_TERMINATION_CREATE,
      PermissionCode.SUBSCRIPTION_EARLY_TERMINATION_EXECUTE
    ]).toEqual(permissionCodes);
    for (const code of permissionCodes) {
      expect(seed).toContain(`"${code}"`);
      expect(labels).toContain(`"${code}"`);
    }
    expect(seed).toContain("allPermissions.map((permission)");
  });

  it("keeps role duties named and proves access without generic seed execution", () => {
    expect(seedPermissionArray("subscriptionClosureSalesPermissions")).toEqual([
      "subscription_closure:view"
    ]);
    expect(seedPermissionArray("subscriptionClosureCustomerServicePermissions")).toEqual([
      "subscription_closure:view",
      "subscription_closure:prepare",
      "subscription_early_termination:create"
    ]);
    expect(seedPermissionArray("subscriptionClosureOperationsPermissions")).toEqual([
      "subscription_closure:view",
      "subscription_closure:prepare",
      "subscription_closure:receive",
      "subscription_closure:inspect",
      "subscription_recovery:assess",
      "subscription_recovery:execute",
      "subscription_early_termination:create",
      "subscription_early_termination:execute"
    ]);
    expect(seedPermissionArray("subscriptionClosureRiskPermissions")).toEqual([
      "subscription_closure:view",
      "subscription_recovery:assess"
    ]);
    expect(seedPermissionArray("subscriptionClosureFinancePermissions")).toEqual([
      "subscription_closure:view",
      "subscription_closure:settle"
    ]);
    expect(seedPermissionArray("subscriptionClosureAssetPermissions")).toEqual([
      "subscription_closure:view",
      "subscription_closure:receive",
      "subscription_closure:inspect",
      "subscription_recovery:execute"
    ]);
    expect(seedPermissionArray("subscriptionClosureApprovalPermissions")).toEqual([
      "subscription_closure:view",
      "subscription_recovery:approve"
    ]);
    expect(synchronizer).not.toContain("seed.mjs");
    expect(synchronizer).not.toContain("prisma:seed");
    expect(synchronizer).toContain("STAGE1_P0_CLOSURE_ACCESS_DEDICATED_LOCAL_REQUIRED");
  });

  function seedPermissionArray(name: string) {
    const source = seed.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))?.[1];
    expect(source, `${name} must remain an explicit seed array`).toBeDefined();
    return [...source!.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  }
});
