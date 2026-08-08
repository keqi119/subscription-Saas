import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  VEHICLE_VALUATION_SECTIONS,
  getForecastTrend,
  getSalePriceHistoryHref,
  getValuationActions,
  presentResidualForecastStatus,
  presentValuationReviewStatus
} from "../src/lib/vehicle-valuation-workspace";

const repoRoot = join(__dirname, "..", "..", "..");

describe("vehicle valuation workspace model", () => {
  it("never exposes a cross-vehicle sale-price history section", () => {
    expect(VEHICLE_VALUATION_SECTIONS.map(({ key }) => key)).toEqual([
      "overview",
      "residual",
      "reviews",
      "sale-price-history",
      "depreciation"
    ]);
    expect(getSalePriceHistoryHref("vehicle-1")).toBe(
      "/vehicles/vehicle-1?tab=valuation&section=sale-price-history"
    );
  });

  it("enables only actions covered by exact permissions", () => {
    const actions = getValuationActions({
      latestForecast: {
        forecastStatus: "GENERATED",
        points: [{ id: "point-1", pointStatus: "GENERATED", predictedResidualAmount: 900_000 }]
      },
      permissions: new Set([
        "residual_forecast:view",
        "residual_forecast:generate",
        "vehicle_valuation_review:create",
        "vehicle:history_view"
      ]),
      vehicleStatus: "AVAILABLE"
    });

    expect(actions).toMatchObject({
      canAdoptForecastPoint: false,
      canCreateValuationReview: true,
      canGenerateForecast: true,
      canInitializeSalePrice: false,
      canViewForecast: true,
      canViewSalePriceHistory: true
    });
  });

  it("does not offer a review when the latest forecast has no supported amount", () => {
    const actions = getValuationActions({
      latestForecast: {
        forecastStatus: "GENERATED",
        points: [{ id: "point-1", pointStatus: "UNSUPPORTED", predictedResidualAmount: null }]
      },
      permissions: new Set(["vehicle_valuation_review:create"]),
      vehicleStatus: "AVAILABLE"
    });

    expect(actions.canCreateValuationReview).toBe(false);
  });

  it("keeps retired vehicles out of direct sale-price maintenance", () => {
    const actions = getValuationActions({
      latestForecast: null,
      permissions: new Set(["vehicle:initialize_sale_price", "vehicle:review_sale_price"]),
      vehicleStatus: "RETIRED"
    });

    expect(actions.canInitializeSalePrice).toBe(false);
    expect(actions.canReviewSalePrice).toBe(false);
  });

  it("presents stable forecast and review statuses", () => {
    expect(presentResidualForecastStatus("GENERATED")).toEqual({ color: "blue", label: "已生成" });
    expect(presentResidualForecastStatus("VOIDED")).toEqual({ color: "default", label: "已作废" });
    expect(presentValuationReviewStatus("PENDING")).toEqual({ color: "orange", label: "待审核" });
    expect(presentValuationReviewStatus("APPROVED")).toEqual({ color: "green", label: "已通过" });
  });

  it("compares forecast residual amount with current sale price", () => {
    expect(getForecastTrend(800_000, 1_000_000)).toEqual({
      deltaAmount: -200_000,
      deltaRate: -0.2,
      direction: "DOWN"
    });
    expect(getForecastTrend(null, 1_000_000)).toBeNull();
  });

  it("keeps valuation mutations behind the approved APIs and workflow", () => {
    const source = readFileSync(
      join(repoRoot, "apps/web/src/components/vehicle-workspace/vehicle-valuation-tab.tsx"),
      "utf8"
    );

    expect(source).toContain("/residual-forecasts/generate");
    expect(source).toContain("/valuation-reviews/from-residual-forecast");
    expect(source).toContain("/sale-price-history");
    expect(source).toContain("/asset-cost-profile/preview");
    expect(source).toContain("/depreciation-summary");
    expect(source).toContain("预测或采纳值不会直接改写当前销售价");
    expect(source).toContain("只有审批通过的估值复核才会写入销售价历史");
  });
});
