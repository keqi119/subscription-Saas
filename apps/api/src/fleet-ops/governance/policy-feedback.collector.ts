import { ControlDecision } from "../risk/risk.types";
import type { FleetGovernanceInput, PolicyFeedbackMetrics } from "./policy.types";

export class PolicyFeedbackCollector {
  collect(input: FleetGovernanceInput): PolicyFeedbackMetrics {
    const blockedHighRoiVehicles = input.riskReport.vehicles.filter((risk) => {
      const kpi = input.fleetKpis.vehicles.find((vehicle) => vehicle.vehicleId === risk.vehicleId);

      return risk.controlDecision === ControlDecision.BLOCK && (kpi?.economics.roi ?? 0) > 0.2;
    }).length;
    const highRoiHighRiskVehicles = input.riskReport.vehicles.filter((risk) => {
      const kpi = input.fleetKpis.vehicles.find((vehicle) => vehicle.vehicleId === risk.vehicleId);

      return risk.riskScore >= 75 && (kpi?.economics.roi ?? 0) > 0.2;
    }).length;
    const negativeRoiHighUtilizationVehicles = input.fleetKpis.vehicles.filter(
      (vehicle) => vehicle.utilization.utilizationRate >= 0.8 && vehicle.economics.roi <= 0
    ).length;
    const failedExecutionCount = input.executionLogs.filter((log) => !log.success).length;
    const executionFailureRate = input.executionLogs.length > 0 ? failedExecutionCount / input.executionLogs.length : 0;

    return {
      blockedHighRoiVehicles,
      executionFailureRate: roundRatio(executionFailureRate),
      failedExecutionCount,
      highRoiHighRiskVehicles,
      negativeRoiHighUtilizationVehicles,
      optimizationOpportunityScore: input.optimizationReport.fleet.optimizationOpportunityScore,
      revenueConcentrationRisk: input.optimizationReport.fleet.revenueConcentrationRisk,
      riskExposureIndex: input.optimizationReport.fleet.riskExposureIndex,
      timelineConflictDensity: roundRatio(calculateTimelineConflictDensity(input))
    };
  }
}

function calculateTimelineConflictDensity(input: FleetGovernanceInput) {
  const days = Object.values(input.timelines).flat();

  if (days.length === 0) {
    return 0;
  }

  const conflictDays = days.filter((day) => (day.conflicts?.length ?? 0) > 0 || day.confidence < 60).length;

  return conflictDays / days.length;
}

function roundRatio(value: number) {
  return Number(value.toFixed(6));
}
