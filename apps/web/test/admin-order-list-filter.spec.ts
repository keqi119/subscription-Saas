import { describe, expect, it } from "vitest";

import * as adminOrderWorkspace from "../src/lib/admin-order-workspace";

type OrderListFilters = {
  journeyStatus: "EXCEPTION" | null;
  orderStatus: "ACTIVE" | null;
};

type AdminOrderWorkspaceWithListFilters = typeof adminOrderWorkspace & {
  buildAdminOrderListApiPath?: (filters: OrderListFilters) => string;
  parseAdminOrderListFilters?: (searchParams: URLSearchParams) => OrderListFilters;
};

describe("admin order list filters", () => {
  it("preserves the active-order filter from the change-center link through the API request", () => {
    const workspace = adminOrderWorkspace as AdminOrderWorkspaceWithListFilters;

    expect(workspace.parseAdminOrderListFilters).toBeTypeOf("function");
    expect(workspace.buildAdminOrderListApiPath).toBeTypeOf("function");

    const filters = workspace.parseAdminOrderListFilters!(
      new URLSearchParams({ orderStatus: "ACTIVE" })
    );

    expect(filters).toEqual({ journeyStatus: null, orderStatus: "ACTIVE" });
    expect(workspace.buildAdminOrderListApiPath!(filters)).toBe("/orders?orderStatus=ACTIVE");
  });

  it("keeps independently valid journey and active-order filters when both are present", () => {
    const workspace = adminOrderWorkspace as AdminOrderWorkspaceWithListFilters;
    const filters = workspace.parseAdminOrderListFilters!(
      new URLSearchParams({ journeyStatus: "EXCEPTION", orderStatus: "ACTIVE" })
    );

    expect(filters).toEqual({ journeyStatus: "EXCEPTION", orderStatus: "ACTIVE" });
    expect(workspace.buildAdminOrderListApiPath!(filters)).toBe(
      "/orders?journeyStatus=EXCEPTION&orderStatus=ACTIVE"
    );
  });

  it("fails closed for unsupported order and journey filter values", () => {
    const workspace = adminOrderWorkspace as AdminOrderWorkspaceWithListFilters;
    const filters = workspace.parseAdminOrderListFilters!(
      new URLSearchParams({ journeyStatus: "RUNNING", orderStatus: "TERMINATED" })
    );

    expect(filters).toEqual({ journeyStatus: null, orderStatus: null });
    expect(workspace.buildAdminOrderListApiPath!(filters)).toBe("/orders");
  });
});
