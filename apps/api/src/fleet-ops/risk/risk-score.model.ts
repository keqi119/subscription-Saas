import { LeaseStatus, ServiceCasePriority, ServiceCaseStatus } from "@prisma/client";

import type { FleetKpiVehicleResult } from "../economics/economics.types";
import { hasTimelineConflict } from "./risk-signals.builder";
import { RiskSignalCode, type FleetRiskInput, type RiskExposure, type RiskScoreComponents, type RiskSignal, type RiskTimelineDay } from "./risk.types";

export class RiskScoreModel {
  calculateComponents(input: {
    exposure: RiskExposure;
    fleetRiskInput: FleetRiskInput;
    kpi: FleetKpiVehicleResult;
    signals: RiskSignal[];
    timeline: RiskTimelineDay[];
    vehicleId: string;
  }): RiskScoreComponents {
    return {
      assetRisk: calculateAssetRisk(input.kpi),
      financialRisk: input.exposure.score,
      operationalRisk: calculateOperationalRisk(input.vehicleId, input.fleetRiskInput, input.kpi, input.timeline, input.signals)
    };
  }

  calculateWeightedScore(components: RiskScoreComponents) {
    return clampScore(components.financialRisk * 0.4 + components.operationalRisk * 0.35 + components.assetRisk * 0.25);
  }
}

function calculateOperationalRisk(
  vehicleId: string,
  input: FleetRiskInput,
  kpi: FleetKpiVehicleResult,
  timeline: RiskTimelineDay[],
  signals: RiskSignal[]
) {
  let score = 0;
  const downtimeRate = kpi.utilization.operatingDays > 0 ? kpi.downtime.totalDowntimeDays / kpi.utilization.operatingDays : 0;

  if (downtimeRate >= 0.5) {
    score += 25;
  } else if (downtimeRate >= 0.3) {
    score += 18;
  } else if (downtimeRate > 0) {
    score += 10;
  }

  if (hasSevereOpenServiceCase(vehicleId, input)) {
    score += 25;
  }

  if (signals.some((signal) => signal.code === RiskSignalCode.CONDITION_DEGRADATION_SIGNAL)) {
    score += 25;
  }

  if (hasTimelineConflict(timeline)) {
    score += 15;
  }

  if (timeline.some((day) => (day.warnings ?? []).length > 0)) {
    score += 8;
  }

  if (hasOperationalMismatch(vehicleId, input, timeline)) {
    score += 10;
  }

  return clampScore(score);
}

function calculateAssetRisk(kpi: FleetKpiVehicleResult) {
  let score = 0;

  if (kpi.economics.roi < -0.1) {
    score += 45;
  } else if (kpi.economics.roi < 0) {
    score += 30;
  }

  if (kpi.utilization.utilizationRate < 0.2) {
    score += 25;
  } else if (kpi.utilization.utilizationRate < 0.4) {
    score += 15;
  }

  if (kpi.attribution.writeOffImpact < 0) {
    score += 15;
  }

  if ((kpi.warnings ?? []).length > 0) {
    score += Math.min(15, (kpi.warnings ?? []).length * 5);
  }

  if (kpi.economics.cost > kpi.economics.revenue && kpi.economics.revenue > 0) {
    score += 10;
  }

  return clampScore(score);
}

export function hasSevereOpenServiceCase(vehicleId: string, input: FleetRiskInput) {
  return input.serviceCases
    .filter((serviceCase) => serviceCase.vehicleId === vehicleId)
    .some(
      (serviceCase) =>
        serviceCase.priority === ServiceCasePriority.URGENT &&
        serviceCase.caseStatus !== ServiceCaseStatus.CLOSED &&
        serviceCase.caseStatus !== ServiceCaseStatus.CANCELLED &&
        serviceCase.resolvedAt == null &&
        serviceCase.closedAt == null
    );
}

export function hasActiveLease(vehicleId: string, input: FleetRiskInput) {
  return input.leases.some((lease) => lease.vehicleId === vehicleId && lease.status === LeaseStatus.ACTIVE);
}

function hasOperationalMismatch(vehicleId: string, input: FleetRiskInput, timeline: RiskTimelineDay[]) {
  const operationalState = input.operationalStates.find((state) => state.vehicleId === vehicleId);
  const latestTimelineState = timeline.at(-1)?.state;

  return operationalState?.computedState === "LEASED_ACTIVE" && latestTimelineState != null && latestTimelineState !== "LEASED";
}

function clampScore(score: number) {
  return Math.min(100, Math.max(0, Math.round(score)));
}
