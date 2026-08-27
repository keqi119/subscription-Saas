import { PermissionCode } from "@subscription-saas/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const seedSource = readFileSync(resolve(__dirname, "../prisma/seed.mjs"), "utf8");

describe("active-term subscription change permissions", () => {
  it("defines and seeds the independent generic approval permission", () => {
    expect(PermissionCode.SUBSCRIPTION_CHANGE_APPROVE).toBe("subscription_change:approve");
    expect(seedSource).toContain(
      '["subscription_change:approve", "审批合同变更", "subscription_change", "approve"]'
    );
    expect(seedSource).toMatch(
      /const subscriptionChangeAdminPermissions = \[[\s\S]*"subscription_change:approve"/
    );
  });
});
