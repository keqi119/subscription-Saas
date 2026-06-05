import { describe, expect, it } from "vitest";

import { centsToYuan, yuanToCents } from "../src";
import { PermissionCode, SYSTEM_MENUS } from "../src";

describe("money helpers", () => {
  it("stores yuan values as cents", () => {
    expect(yuanToCents(1999.99)).toBe(199999n);
  });

  it("formats cents as yuan strings", () => {
    expect(centsToYuan(3500n)).toBe("35.00");
  });
});

describe("system menus", () => {
  it("keeps menu permission codes centralized", () => {
    expect(SYSTEM_MENUS[0]?.permissionCode).toBe(PermissionCode.DASHBOARD_VIEW);
    expect(SYSTEM_MENUS.some((menu) => menu.permissionCode === PermissionCode.CUSTOMER_VIEW)).toBe(
      true
    );
    expect(
      SYSTEM_MENUS.some((menu) => menu.permissionCode === PermissionCode.APPLICATION_VIEW)
    ).toBe(true);
  });
});
