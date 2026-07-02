import { describe, expect, it } from "vitest";

import { MenuItemDefinition, PermissionCode, SYSTEM_MENUS } from "../src";

describe("Fleet Ops shared menu", () => {
  it("adds a Chinese read-only Fleet Ops menu entry under vehicle assets", () => {
    const vehicleMenu = SYSTEM_MENUS.find((menu) => menu.code === "vehicles");
    const fleetOpsMenu = vehicleMenu?.children?.find((menu) => menu.code === "vehicles.fleet_ops");

    expect(fleetOpsMenu).toEqual(
      expect.objectContaining({
        code: "vehicles.fleet_ops",
        label: expect.stringMatching(/^车队运营(?:看板)?$/),
        path: "/fleet-ops",
        permissionCode: PermissionCode.FLEET_OPS_READ
      })
    );
  });

  it("does not add Fleet Ops execution action or public portal menus", () => {
    const fleetOpsMenus = flattenMenus(SYSTEM_MENUS).filter((menu) =>
      `${menu.code} ${menu.path}`.includes("fleet")
    );

    expect(fleetOpsMenus.map((menu) => menu.path)).toContain("/fleet-ops");
    for (const menu of fleetOpsMenus) {
      expect(menu.path).not.toMatch(/portal|customer/i);
      expect(menu.code).not.toMatch(/execute|action|allocate|collect|admin|write/i);
      expect(menu.path).not.toMatch(/execute|action|allocate|collect/i);
    }
  });
});

function flattenMenus(menus: readonly MenuItemDefinition[]): MenuItemDefinition[] {
  return menus.flatMap((menu) => [menu, ...flattenMenus(menu.children ?? [])]);
}
