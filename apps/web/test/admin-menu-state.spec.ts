import { afterEach, describe, expect, it } from "vitest";

import {
  ADMIN_MENU_OPEN_KEYS_STORAGE_KEY,
  ADMIN_MENU_SCROLL_TOP_STORAGE_KEY,
  getAdminMenuState,
  persistAdminMenuOpenKeys,
  persistAdminMenuScrollTop,
  resetAdminMenuStateForTests,
  resolveAdminMenuOpenKeys,
  type AdminMenuStorage
} from "../src/lib/admin-menu-state";

describe("admin menu UI state", () => {
  afterEach(() => resetAdminMenuStateForTests());

  it("restores valid open keys and scroll position from session storage", () => {
    const storage = createStorage({
      [ADMIN_MENU_OPEN_KEYS_STORAGE_KEY]: JSON.stringify(["assets", "assets.vehicles"]),
      [ADMIN_MENU_SCROLL_TOP_STORAGE_KEY]: "128"
    });

    expect(getAdminMenuState(storage)).toEqual({
      openKeys: ["assets", "assets.vehicles"],
      scrollTop: 128
    });
  });

  it("keeps the latest in-memory values across a route remount", () => {
    const storage = createStorage();

    persistAdminMenuOpenKeys(["orders"], storage);
    persistAdminMenuScrollTop(96, storage);

    expect(getAdminMenuState(createStorage())).toEqual({
      openKeys: ["orders"],
      scrollTop: 96
    });
  });

  it("filters inaccessible keys and adds the active route ancestors", () => {
    expect(
      resolveAdminMenuOpenKeys(
        ["assets", "unknown", "assets"],
        ["orders", "orders.review"],
        new Set(["assets", "orders", "orders.review"])
      )
    ).toEqual(["assets", "orders", "orders.review"]);
  });

  it("ignores corrupt, mixed and duplicate stored keys", () => {
    const corrupt = createStorage({
      [ADMIN_MENU_OPEN_KEYS_STORAGE_KEY]: "not-json",
      [ADMIN_MENU_SCROLL_TOP_STORAGE_KEY]: "-20"
    });
    expect(getAdminMenuState(corrupt)).toEqual({ openKeys: [], scrollTop: 0 });

    resetAdminMenuStateForTests();
    const mixed = createStorage({
      [ADMIN_MENU_OPEN_KEYS_STORAGE_KEY]: JSON.stringify(["orders", 1, "orders", null]),
      [ADMIN_MENU_SCROLL_TOP_STORAGE_KEY]: "not-a-number"
    });
    expect(getAdminMenuState(mixed)).toEqual({ openKeys: ["orders"], scrollTop: 0 });
  });

  it("does not break navigation when storage access throws", () => {
    const storage: AdminMenuStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      }
    };

    expect(getAdminMenuState(storage)).toEqual({ openKeys: [], scrollTop: 0 });
    expect(() => persistAdminMenuOpenKeys(["orders"], storage)).not.toThrow();
    expect(() => persistAdminMenuScrollTop(32, storage)).not.toThrow();
    expect(getAdminMenuState(storage)).toEqual({ openKeys: ["orders"], scrollTop: 32 });
  });
});

function createStorage(initial: Record<string, string> = {}): AdminMenuStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    }
  };
}
