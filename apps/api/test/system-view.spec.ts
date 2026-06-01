import { describe, expect, it } from "vitest";

import { toUserView } from "../src/system/system.service";

describe("toUserView", () => {
  it("does not expose password hashes", () => {
    const view = toUserView({
      createdAt: new Date("2026-05-29T00:00:00.000Z"),
      email: "admin@example.com",
      id: "00000000-0000-4000-8000-000000000001",
      mobile: null,
      name: "系统管理员",
      roles: [],
      status: "ACTIVE",
      username: "admin"
    } as unknown as Parameters<typeof toUserView>[0]);

    expect(view).not.toHaveProperty("passwordHash");
    expect(view.username).toBe("admin");
  });
});
