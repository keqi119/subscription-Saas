import {
  EconomicTimelineState,
  type EconomicServiceCase,
  type EconomicTimelineDay,
  type FleetKpiDowntime,
  type FleetKpiDowntimeBreakdown,
  type RevenueAttributionResult
} from "./economics.types";

const DEFAULT_DAILY_REVENUE_BENCHMARK = 100;
const IDLE_OPPORTUNITY_COST_RATE = 0.5;
const MAINTENANCE_DIRECT_COST_PER_DAY = 180;
const RESERVED_SOFT_OPPORTUNITY_COST_RATE = 0.25;
const SERVICE_DIRECT_COST_PER_DAY = 250;

export class DowntimeCostModel {
  calculate(
    vehicleId: string,
    timeline: EconomicTimelineDay[],
    attribution: RevenueAttributionResult,
    serviceCases: EconomicServiceCase[]
  ): FleetKpiDowntime {
    const breakdown = createEmptyBreakdown();
    const averageDailyLeaseRevenue = calculateAverageDailyLeaseRevenue(timeline, attribution);
    const serviceMultiplier = serviceCases.some((serviceCase) => serviceCase.vehicleId === vehicleId) ? 1.1 : 1;
    let downtimeCost = 0;
    const trace: FleetKpiDowntime["trace"] = [];

    for (const day of timeline) {
      let dailyCost = 0;
      if (day.state === EconomicTimelineState.MAINTENANCE) {
        breakdown.MAINTENANCE += 1;
        dailyCost = MAINTENANCE_DIRECT_COST_PER_DAY;
      } else if (day.state === EconomicTimelineState.SERVICE_BLOCKED) {
        breakdown.SERVICE += 1;
        dailyCost = (averageDailyLeaseRevenue + SERVICE_DIRECT_COST_PER_DAY) * serviceMultiplier;
      } else if (day.state === EconomicTimelineState.RESERVED) {
        breakdown.RESERVED += 1;
        dailyCost = Math.max(averageDailyLeaseRevenue * RESERVED_SOFT_OPPORTUNITY_COST_RATE, 25);
      } else if (day.state === EconomicTimelineState.AVAILABLE) {
        breakdown.IDLE += 1;
        dailyCost = Math.max(averageDailyLeaseRevenue * IDLE_OPPORTUNITY_COST_RATE, 50);
      }

      if (dailyCost > 0) {
        downtimeCost += dailyCost;
        trace.push({
          cost: roundMoney(dailyCost),
          date: day.date,
          sourceEvents: [...day.sourceEvents],
          state: day.state
        });
      }
    }

    return {
      breakdown,
      downtimeCost: roundMoney(downtimeCost),
      trace,
      totalDowntimeDays: breakdown.IDLE + breakdown.MAINTENANCE + breakdown.RESERVED + breakdown.SERVICE
    };
  }
}

function calculateAverageDailyLeaseRevenue(timeline: EconomicTimelineDay[], attribution: RevenueAttributionResult) {
  const leasedDays = timeline.filter((day) => day.state === EconomicTimelineState.LEASED).length;

  if (leasedDays > 0 && attribution.leaseRevenue > 0) {
    return attribution.leaseRevenue / leasedDays;
  }

  return DEFAULT_DAILY_REVENUE_BENCHMARK;
}

function createEmptyBreakdown(): FleetKpiDowntimeBreakdown {
  return {
    IDLE: 0,
    MAINTENANCE: 0,
    RESERVED: 0,
    SERVICE: 0
  };
}

function roundMoney(value: number) {
  return Number(value.toFixed(6));
}
