import { describe, expect, it } from "vitest";

import { PermissionCode } from "../src";

const FORBIDDEN_FLEET_OPS_PERMISSIONS = [
  "fleet_ops:write",
  "fleet_ops:execute",
  "fleet_ops:admin",
  "fleet_ops:allocate",
  "fleet_ops:collect",
  "fleet_ops:action"
];

describe("Fleet Ops shared permissions", () => {
  it("defines only the read-only Fleet Ops permission", () => {
    expect(PermissionCode.FLEET_OPS_READ).toBe("fleet_ops:read");
  });

  it("does not define Fleet Ops write execution or action permissions", () => {
    const permissionCodes = Object.values(PermissionCode);

    for (const forbiddenPermission of FORBIDDEN_FLEET_OPS_PERMISSIONS) {
      expect(permissionCodes).not.toContain(forbiddenPermission);
    }
  });
});

describe("subscription change shared permissions", () => {
  it("defines the approved V2 contract change permissions", () => {
    const permissions = PermissionCode as Record<string, string>;

    expect(permissions.SUBSCRIPTION_CHANGE_VIEW).toBe("subscription_change:view");
    expect(permissions.SUBSCRIPTION_CHANGE_CREATE).toBe("subscription_change:create");
    expect(permissions.SUBSCRIPTION_CHANGE_QUOTE).toBe("subscription_change:quote");
    expect(permissions.SUBSCRIPTION_CHANGE_APPROVE).toBe("subscription_change:approve");
    expect(permissions.SUBSCRIPTION_CHANGE_PRICE_OVERRIDE_APPROVE).toBe(
      "subscription_change:price_override_approve"
    );
    expect(permissions.SUBSCRIPTION_CHANGE_SUBMIT).toBe("subscription_change:submit");
    expect(permissions.SUBSCRIPTION_CHANGE_ESIGN_RETRY).toBe(
      "subscription_change:esign_retry"
    );
    expect(permissions.SUBSCRIPTION_CHANGE_EXECUTE).toBe("subscription_change:execute");
    expect(permissions.SUBSCRIPTION_CHANGE_MANUAL_TAKEOVER).toBe(
      "subscription_change:manual_takeover"
    );
    expect(permissions.SUBSCRIPTION_CHANGE_CANCEL).toBe("subscription_change:cancel");
  });
});

describe("subscription journey shared permissions", () => {
  it("defines the six approved journey permissions", () => {
    expect(PermissionCode.SUBSCRIPTION_JOURNEY_VIEW).toBe("subscription_journey:view");
    expect(PermissionCode.SUBSCRIPTION_JOURNEY_PLAN_DECIDE).toBe(
      "subscription_journey:plan_decide"
    );
    expect(PermissionCode.SUBSCRIPTION_JOURNEY_VEHICLE_ALLOCATE).toBe(
      "subscription_journey:vehicle_allocate"
    );
    expect(PermissionCode.SUBSCRIPTION_JOURNEY_DELIVERY_EVIDENCE_DECIDE).toBe(
      "subscription_journey:delivery_evidence_decide"
    );
    expect(PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER).toBe("subscription_journey:recover");
    expect(PermissionCode.SUBSCRIPTION_JOURNEY_CANCEL).toBe("subscription_journey:cancel");
  });
});
