import { describe, expect, it } from "vitest";

import { buildRequestUser } from "../src/auth/auth.service";

describe("buildRequestUser", () => {
  it("collects roles, permissions, and menus from active role relations", () => {
    const user = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "系统管理员",
      roles: [
        {
          role: {
            code: "ADMIN",
            menus: [
              {
                menu: {
                  code: "dashboard",
                  icon: "dashboard",
                  name: "首页驾驶舱",
                  path: "/",
                  permissionCode: "dashboard:view",
                  sortOrder: 10
                }
              }
            ],
            permissions: [
              {
                permission: {
                  code: "dashboard:view"
                }
              },
              {
                permission: {
                  code: "user:view"
                }
              }
            ]
          }
        }
      ],
      username: "admin"
    } as Parameters<typeof buildRequestUser>[0];

    expect(buildRequestUser(user)).toMatchObject({
      permissions: ["dashboard:view", "user:view"],
      roles: ["ADMIN"],
      username: "admin"
    });
  });
});
