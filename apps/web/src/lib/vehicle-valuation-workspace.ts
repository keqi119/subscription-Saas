export const VEHICLE_VALUATION_SECTIONS = [
  { key: "overview", label: "估值总览" },
  { key: "residual", label: "残值预测" },
  { key: "reviews", label: "估值复核" },
  { key: "sale-price-history", label: "销售价历史" },
  { key: "depreciation", label: "折旧管理" }
] as const;

export type VehicleValuationSectionKey = (typeof VEHICLE_VALUATION_SECTIONS)[number]["key"];

export interface VehicleResidualForecastPointView {
  adoptedResidualAmount?: number | null;
  id?: string | null;
  pointStatus: string;
  predictedResidualAmount?: number | null;
}

export interface VehicleResidualForecastView {
  forecastStatus: string;
  points?: VehicleResidualForecastPointView[];
}

export interface VehicleValuationActionState {
  canAdoptForecastPoint: boolean;
  canCancelValuationReview: boolean;
  canCreateValuationReview: boolean;
  canGenerateForecast: boolean;
  canInitializeSalePrice: boolean;
  canManageDepreciation: boolean;
  canReviewSalePrice: boolean;
  canViewDepreciation: boolean;
  canViewForecast: boolean;
  canViewSalePriceHistory: boolean;
  canViewValuationReviews: boolean;
}

export interface StatusPresentation {
  color: string;
  label: string;
}

export function getValuationActions(input: {
  latestForecast: VehicleResidualForecastView | null;
  permissions: ReadonlySet<string>;
  vehicleStatus: string;
}): VehicleValuationActionState {
  const activeVehicle = !["RETIRED", "SOLD"].includes(input.vehicleStatus);
  const hasReviewablePoint = Boolean(
    input.latestForecast &&
      input.latestForecast.forecastStatus !== "VOIDED" &&
      input.latestForecast.forecastStatus !== "ARCHIVED" &&
      input.latestForecast.points?.some(
        (point) =>
          point.pointStatus !== "UNSUPPORTED" &&
          (positiveAmount(point.adoptedResidualAmount) || positiveAmount(point.predictedResidualAmount))
      )
  );

  return {
    canAdoptForecastPoint: input.permissions.has("residual_forecast:manage"),
    canCancelValuationReview: input.permissions.has("vehicle_valuation_review:create"),
    canCreateValuationReview:
      input.permissions.has("vehicle_valuation_review:create") && hasReviewablePoint,
    canGenerateForecast: input.permissions.has("residual_forecast:generate"),
    canInitializeSalePrice:
      activeVehicle && input.permissions.has("vehicle:initialize_sale_price"),
    canManageDepreciation: input.permissions.has("vehicle_depreciation:manage"),
    canReviewSalePrice: activeVehicle && input.permissions.has("vehicle:review_sale_price"),
    canViewDepreciation: input.permissions.has("vehicle_depreciation:view"),
    canViewForecast: input.permissions.has("residual_forecast:view"),
    canViewSalePriceHistory: input.permissions.has("vehicle:history_view"),
    canViewValuationReviews: input.permissions.has("vehicle_valuation_review:view")
  };
}

export function getSalePriceHistoryHref(vehicleId: string) {
  return `/vehicles/${encodeURIComponent(vehicleId)}?tab=valuation&section=sale-price-history`;
}

export function presentResidualForecastStatus(status?: string | null): StatusPresentation {
  return (
    {
      ADOPTED: { color: "green", label: "已采纳" },
      ARCHIVED: { color: "default", label: "已归档" },
      GENERATED: { color: "blue", label: "已生成" },
      VOIDED: { color: "default", label: "已作废" }
    }[status ?? ""] ?? { color: "default", label: status || "-" }
  );
}

export function presentValuationReviewStatus(status?: string | null): StatusPresentation {
  return (
    {
      APPROVED: { color: "green", label: "已通过" },
      CANCELLED: { color: "default", label: "已取消" },
      PENDING: { color: "orange", label: "待审核" },
      REJECTED: { color: "red", label: "已拒绝" }
    }[status ?? ""] ?? { color: "default", label: status || "-" }
  );
}

export function getForecastTrend(
  forecastAmount?: number | null,
  currentSalePriceAmount?: number | null
) {
  if (!positiveAmount(forecastAmount) || !positiveAmount(currentSalePriceAmount)) {
    return null;
  }
  const deltaAmount = forecastAmount - currentSalePriceAmount;
  return {
    deltaAmount,
    deltaRate: deltaAmount / currentSalePriceAmount,
    direction: deltaAmount === 0 ? "FLAT" : deltaAmount > 0 ? "UP" : "DOWN"
  } as const;
}

function positiveAmount(value?: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
