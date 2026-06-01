import { describe, expect, it } from "vitest";

import { hasRequiredPermissions } from "../src/auth/permissions";

describe("hasRequiredPermissions", () => {
  it("allows requests with every required permission", () => {
    expect(hasRequiredPermissions(["user:view", "role:view"], ["user:view"])).toBe(true);
  });

  it("denies requests missing a required permission", () => {
    expect(hasRequiredPermissions(["user:view"], ["user:view", "role:manage"])).toBe(false);
  });
});
