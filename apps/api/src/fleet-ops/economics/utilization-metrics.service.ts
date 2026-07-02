import { EconomicTimelineState, type EconomicTimelineDay, type FleetKpiUtilization, type RevenueAttributionResult } from "./economics.types";

export class UtilizationMetricsService {
  calculate(timeline: EconomicTimelineDay[], attribution: RevenueAttributionResult): FleetKpiUtilization {
    const operatingDays = timeline.length;
    const leasedDays = timeline.filter((day) => day.state === EconomicTimelineState.LEASED).length;
    const revenueDays = attribution.leaseRevenue > 0 ? leasedDays : 0;
    const timelineWarningCount = timeline.reduce((total, day) => total + (day.warnings?.length ?? 0), 0);

    return {
      economicUtilizationSource: "timeline_leased_days_with_revenue_support",
      leasedDays,
      operatingDays,
      timelineWarningCount,
      utilizationRate: operatingDays > 0 ? roundRatio(revenueDays / operatingDays) : 0
    };
  }
}

function roundRatio(value: number) {
  return Number(value.toFixed(6));
}
