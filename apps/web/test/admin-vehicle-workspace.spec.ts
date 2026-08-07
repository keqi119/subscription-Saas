import { describe, expect, it } from "vitest";

import {
  VEHICLE_CAPITAL_SECTION_KEYS,
  VEHICLE_LISTING_SECTION_KEYS,
  VEHICLE_VALUATION_SECTION_KEYS,
  VEHICLE_WORKSPACE_TAB_KEYS,
  buildVehicleWorkspaceHref,
  getVisibleVehicleWorkspaceTabs,
  parseVehicleWorkspaceLocation
} from "../src/lib/admin-vehicle-workspace";

describe("admin vehicle workspace navigation model", () => {
  it("builds a stable vehicle workspace URL", () => {
    expect(
      buildVehicleWorkspaceHref({
        section: "source-media",
        tab: "listing",
        vehicleId: "vehicle/1"
      })
    ).toBe("/vehicles/vehicle%2F1?tab=listing&section=source-media");
  });

  it("discards invalid, default, or foreign secondary sections when building URLs", () => {
    expect(buildVehicleWorkspaceHref({ section: "overview", tab: "listing", vehicleId: "vehicle-1" })).toBe(
      "/vehicles/vehicle-1?tab=listing"
    );
    expect(buildVehicleWorkspaceHref({ section: "events", tab: "listing", vehicleId: "vehicle-1" })).toBe(
      "/vehicles/vehicle-1?tab=listing"
    );
    expect(buildVehicleWorkspaceHref({ section: "unknown", tab: "capital", vehicleId: "vehicle-1" })).toBe(
      "/vehicles/vehicle-1?tab=capital"
    );
  });

  it("normalizes unknown or unauthorized state to the first visible tab", () => {
    const visibleTabs = ["overview", "documents"] as const;
    expect(
      parseVehicleWorkspaceLocation(
        new URLSearchParams("tab=capital&section=unknown&unrelated=keep-out"),
        visibleTabs
      )
    ).toEqual({ tab: "overview" });
  });

  it("keeps a valid secondary section only for its owning tab", () => {
    expect(
      parseVehicleWorkspaceLocation(
        new URLSearchParams("tab=valuation&section=sale-price-history"),
        VEHICLE_WORKSPACE_TAB_KEYS
      )
    ).toEqual({ section: "sale-price-history", tab: "valuation" });

    expect(
      parseVehicleWorkspaceLocation(
        new URLSearchParams("tab=listing&section=sale-price-history"),
        VEHICLE_WORKSPACE_TAB_KEYS
      )
    ).toEqual({ tab: "listing" });
  });

  it("omits redundant default secondary sections", () => {
    expect(
      parseVehicleWorkspaceLocation(
        new URLSearchParams("tab=capital&section=overview"),
        VEHICLE_WORKSPACE_TAB_KEYS
      )
    ).toEqual({ tab: "capital" });
  });

  it("defines stable typed secondary section orders", () => {
    expect(VEHICLE_LISTING_SECTION_KEYS).toEqual([
      "overview",
      "copy",
      "source-media",
      "plans",
      "condition-report"
    ]);
    expect(VEHICLE_VALUATION_SECTION_KEYS).toEqual([
      "overview",
      "residual",
      "reviews",
      "sale-price-history",
      "depreciation"
    ]);
    expect(VEHICLE_CAPITAL_SECTION_KEYS).toEqual([
      "overview",
      "events",
      "allocations",
      "revenue-rules",
      "revenue-preview"
    ]);
  });

  it("does not invent an overview tab when no vehicle read permission is present", () => {
    expect(getVisibleVehicleWorkspaceTabs([])).toEqual([]);
    expect(getVisibleVehicleWorkspaceTabs(["vehicle_document:view"])).toEqual([]);
    expect(() => parseVehicleWorkspaceLocation(new URLSearchParams(), [])).toThrow(
      "vehicle workspace has no visible tabs"
    );
  });

  it.each([
    [["vehicle:view"], ["overview", "listing"]],
    [["vehicle:view", "vehicle_document:view"], ["overview", "documents", "listing"]],
    [["vehicle:view", "vehicle_baas:view"], ["overview", "insurance-battery", "listing"]],
    [["vehicle:view", "vehicle:history_view"], ["overview", "listing", "valuation"]],
    [["vehicle:view", "capital_structure:view"], ["overview", "listing", "capital"]]
  ])("maps permissions %j to visible tabs", (permissions, expectedTabs) => {
    expect(getVisibleVehicleWorkspaceTabs(permissions)).toEqual(expectedTabs);
  });

  it("returns all six tabs in stable order for the exhaustive view permission union", () => {
    expect(
      getVisibleVehicleWorkspaceTabs([
        "vehicle:view",
        "vehicle_document:view",
        "vehicle_insurance:view",
        "residual_forecast:view",
        "capital_structure:view"
      ])
    ).toEqual(VEHICLE_WORKSPACE_TAB_KEYS);
  });
});
