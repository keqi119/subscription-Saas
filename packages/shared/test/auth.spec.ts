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
