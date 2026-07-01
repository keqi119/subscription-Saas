import type { FleetKpiVehicleResult } from "../economics/economics.types";
import { AllocationStrategyModel } from "./allocation-strategy.model";
import { CostOptimizer } from "./cost-optimizer";
import {
  OptimizationPriority,
  type FleetOptimizationInput,
  type FleetOptimizationReport,
  type OptimizationSuggestion,
  type OptimizationVehicleContext
} from "./optimization.types";
import { RevenueOptimizer } from "./revenue-optimizer";
import { RiskOptimizer } from "./risk-optimizer";
import { UtilizationOptimizer } from "./utilization-optimizer";

export class OptimizationEngine {
  private readonly allocationStrategyModel = new AllocationStrategyModel();
  private readonly costOptimizer = new CostOptimizer();
  private readonly revenueOptimizer = new RevenueOptimizer();
  private readonly riskOptimizer = new RiskOptimizer();
  private readonly utilizationOptimizer = new UtilizationOptimizer();

  optimize(input: FleetOptimizationInput): FleetOptimizationReport {
    const contexts = input.vehicleIds.map((vehicleId) => this.buildVehicleContext(vehicleId, input));
    const fleetLevelInsights = buildFleetLevelInsights(input);
    const vehicles = contexts.map((context) => {
      const suggestions = sortSuggestions([
        ...this.utilizationOptimizer.recommend(context),
        ...this.revenueOptimizer.recommend(context),
        ...this.costOptimizer.recommend(context),
        ...this.riskOptimizer.recommend(context),
        ...this.allocationStrategyModel.recommend(context)
      ]);

      return {
        fleetLevelInsights,
        optimizationSuggestions: suggestions,
        strategyRecommendation: this.allocationStrategyModel.strategyRecommendation(context, suggestions),
        vehicleId: context.vehicleId
      };
    });
    const allSuggestions = sortSuggestions(vehicles.flatMap((vehicle) => vehicle.optimizationSuggestions));

    return {
      fleet: {
        globalUtilizationEfficiencyScore: Math.round(input.fleetKpis.fleet.utilizationRate * 100),
        optimizationOpportunityScore: calculateOptimizationOpportunityScore(input, allSuggestions),
        revenueConcentrationRisk: calculateRevenueConcentrationRisk(input),
        riskExposureIndex: Math.round(input.riskReport.fleet.averageRiskScore),
        topRecommendations: allSuggestions.slice(0, 5)
      },
      fleetLevelInsights,
      vehicles
    };
  }

  private buildVehicleContext(vehicleId: string, input: FleetOptimizationInput): OptimizationVehicleContext {
    return {
      executionLogs: input.executionLogs.filter((log) => log.vehicleId === vehicleId),
      kpi: input.fleetKpis.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId) ?? emptyKpi(vehicleId),
      operationalState: input.operationalStates.find((state) => state.vehicleId === vehicleId),
      risk: input.riskReport.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId),
      timeline: input.timelines[vehicleId] ?? [],
      vehicleId
    };
  }
}

function calculateRevenueConcentrationRisk(input: FleetOptimizationInput) {
  const totalRevenue = input.fleetKpis.vehicles.reduce((total, vehicle) => total + vehicle.economics.revenue, 0);

  if (totalRevenue <= 0) {
    return 0;
  }

  const largestVehicleRevenue = Math.max(...input.fleetKpis.vehicles.map((vehicle) => vehicle.economics.revenue), 0);

  return Math.round((largestVehicleRevenue / totalRevenue) * 100);
}

function calculateOptimizationOpportunityScore(input: FleetOptimizationInput, suggestions: OptimizationSuggestion[]) {
  const highPriorityCount = suggestions.filter((suggestion) => suggestion.priority === OptimizationPriority.HIGH).length;
  const blockedRatio = input.vehicleIds.length > 0 ? input.riskReport.fleet.blockedVehicles / input.vehicleIds.length : 0;
  const idleRatio = input.fleetKpis.fleet.operatingDays > 0
    ? Math.max(0, 1 - input.fleetKpis.fleet.leasedDays / input.fleetKpis.fleet.operatingDays)
    : 0;

  return clampScore(highPriorityCount * 18 + blockedRatio * 35 + idleRatio * 45);
}

function buildFleetLevelInsights(input: FleetOptimizationInput) {
  const insights: string[] = [];
  const utilizationScore = Math.round(input.fleetKpis.fleet.utilizationRate * 100);
  const concentrationRisk = calculateRevenueConcentrationRisk(input);

  insights.push(`Global utilization efficiency score is ${utilizationScore}.`);
  insights.push(`Revenue concentration risk is ${concentrationRisk}.`);
  insights.push(`Risk exposure index is ${Math.round(input.riskReport.fleet.averageRiskScore)}.`);

  if (input.executionLogs.some((log) => !log.success)) {
    insights.push("Execution history includes failed or blocked PR-5 actions; recommendations remain advisory only.");
  }

  return insights;
}

function sortSuggestions(suggestions: OptimizationSuggestion[]) {
  const priorityRank: Record<OptimizationPriority, number> = {
    [OptimizationPriority.HIGH]: 0,
    [OptimizationPriority.MEDIUM]: 1,
    [OptimizationPriority.LOW]: 2
  };

  return [...suggestions].sort((left, right) => {
    const priorityDelta = priorityRank[left.priority] - priorityRank[right.priority];

    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }

    return left.type.localeCompare(right.type);
  });
}

function emptyKpi(vehicleId: string): FleetKpiVehicleResult {
  return {
    attribution: {
      leaseRevenue: 0,
      penaltyRevenue: 0,
      writeOffImpact: 0
    },
    confidence: {
      band: "LOW",
      score: 0
    },
    downtime: {
      breakdown: {
        IDLE: 0,
        MAINTENANCE: 0,
        RESERVED: 0,
        SERVICE: 0
      },
      downtimeCost: 0,
      totalDowntimeDays: 0
    },
    economics: {
      cost: 0,
      netIncome: 0,
      revenue: 0,
      roe: 0,
      roi: 0
    },
    utilization: {
      leasedDays: 0,
      operatingDays: 0,
      utilizationRate: 0
    },
    vehicleId
  };
}

function clampScore(score: number) {
  return Math.min(100, Math.max(0, Math.round(score)));
}
