import {
  TIMELINE_CURRENT_STATUS_PROJECTED_WARNING,
  TimelineState,
  type TimelineDay
} from "../timeline/vehicle-timeline.types";
import type { FleetKpiVehicleResult } from "../economics/economics.types";
import { CollectionPriorityLevel, type RiskOutput } from "../risk/risk.types";
import { VehicleComputedOperationalState, type VehicleOperationalStateResult } from "../vehicle-operational-state.types";
import type { FleetOpsWarning } from "../fleet-ops.shared-contracts";
import type { FleetOpsSnapshotConflict, FleetOpsSnapshotEvidence } from "./fleet-ops.snapshot.types";

export interface FleetOpsConsistencyInput {
  economics?: FleetKpiVehicleResult | null;
  evidence: FleetOpsSnapshotEvidence[];
  risk?: RiskOutput | null;
  state: VehicleOperationalStateResult;
  timeline: TimelineDay[];
}

export interface FleetOpsConsistencyResult {
  confidencePenaltyCount: number;
  conflicts: FleetOpsSnapshotConflict[];
  consistencyScore: number;
  warnings: FleetOpsWarning[];
}

export function checkFleetOpsConsistency(input: FleetOpsConsistencyInput): FleetOpsConsistencyResult {
  const conflicts = [
    ...stateTimelineConflicts(input.state, input.timeline, input.evidence),
    ...economicRiskConflicts(input.risk, input.evidence)
  ];
  const fallbackWarningDays = input.timeline.filter((day) => day.warnings.includes(TIMELINE_CURRENT_STATUS_PROJECTED_WARNING)).length;
  const warnings = [
    ...(fallbackWarningDays > 0
      ? [
          {
            code: TIMELINE_CURRENT_STATUS_PROJECTED_WARNING,
            message: `Timeline includes ${fallbackWarningDays} day(s) projected from current Vehicle.status.`
          }
        ]
      : []),
    ...economicRiskWarnings(input.economics, input.risk, input.evidence)
  ];

  return {
    confidencePenaltyCount: fallbackWarningDays,
    conflicts,
    consistencyScore: consistencyScore(conflicts),
    warnings
  };
}

function economicRiskConflicts(risk: RiskOutput | null | undefined, evidence: FleetOpsSnapshotEvidence[]): FleetOpsSnapshotConflict[] {
  const exposure = risk?.exposureDetail;

  if (!exposure || exposure.overdueRemainingAmount <= 0) {
    return [];
  }

  const hasOverdueEvidence = evidence.some((item) => item.source === "receivable_bill" && item.layers.includes("RISK"));

  return hasOverdueEvidence
    ? []
    : [
        {
          code: "RISK_EXPOSURE_WITHOUT_OVERDUE_EVIDENCE",
          evidence: evidenceForSources(evidence, ["RISK"]),
          reason: "PR-4 risk reports overdue exposure but convergence evidence lacks receivable bill traceability.",
          severity: "HIGH"
        }
      ];
}

function economicRiskWarnings(
  economics: FleetKpiVehicleResult | null | undefined,
  risk: RiskOutput | null | undefined,
  evidence: FleetOpsSnapshotEvidence[]
): FleetOpsWarning[] {
  const warnings: FleetOpsWarning[] = [];
  const economicsWarnings = new Set([...(economics?.warnings ?? []), ...(economics?.cashflow?.warnings ?? [])]);
  const hasCashflowWarning = (economics?.cashflow?.warnings ?? []).length > 0;
  const hasDepositWarning = economicsWarnings.has("DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE");
  const riskHasNoCollectionLevel = !risk || !risk.collectionLevel || risk.collectionLevel === CollectionPriorityLevel.NONE;
  const riskExposure = risk?.exposureDetail;

  if (hasCashflowWarning && riskHasNoCollectionLevel) {
    warnings.push({
      code: "ECONOMICS_WARNING_WITHOUT_RISK_COLLECTION_LEVEL",
      message: "PR-3 cashflow warnings are present while PR-4 has no collection level."
    });
  }

  if (hasCashflowWarning) {
    warnings.push({
      code: "ECONOMICS_CASHFLOW_WARNING_PRESENT",
      message: "PR-3 cashflow warnings must remain visible at snapshot system level."
    });
  }

  if (riskExposure && riskExposure.overdueRemainingAmount > 0 && !risk?.arrearsPipeline) {
    warnings.push({
      code: "RISK_EXPOSURE_WITHOUT_ARREARS_PIPELINE",
      message: "PR-4 risk reports overdue exposure but no arrears pipeline was provided."
    });
  }

  if (hasDepositWarning && !hasDepositExclusionDetail(economics)) {
    warnings.push({
      code: "ECONOMICS_DEPOSIT_WARNING_WITHOUT_DETAIL",
      message: "PR-3 deposit exclusion warning exists but convergence lacks deposit exclusion detail."
    });
  }

  if (riskExposure && riskExposure.overdueRemainingAmount > 0) {
    const hasOverdueEvidence = evidence.some((item) => item.source === "receivable_bill" && item.layers.includes("RISK"));
    if (!hasOverdueEvidence) {
      warnings.push({
        code: "RISK_OVERDUE_EVIDENCE_MISSING",
        message: "Snapshot evidence should include receivable bill evidence for PR-4 overdue exposure."
      });
    }
  }

  return warnings.sort((left, right) => left.code.localeCompare(right.code));
}

function hasDepositExclusionDetail(economics: FleetKpiVehicleResult | null | undefined) {
  return Boolean(
    (economics?.attribution.depositExcludedRevenue ?? 0) > 0 ||
      (economics?.cashflow?.actual.deposit ?? 0) > 0 ||
      (economics?.cashflow?.planned.deposit ?? 0) > 0
  );
}

function stateTimelineConflicts(
  state: VehicleOperationalStateResult,
  timeline: TimelineDay[],
  evidence: FleetOpsSnapshotEvidence[]
): FleetOpsSnapshotConflict[] {
  const conflicts: FleetOpsSnapshotConflict[] = [];
  const leasedTimelineDays = timeline.filter((day) => day.state === TimelineState.LEASED);
  const serviceTimelineDays = timeline.filter((day) => day.state === TimelineState.SERVICE_BLOCKED || day.state === TimelineState.MAINTENANCE);

  if (state.computedState === VehicleComputedOperationalState.AVAILABLE && leasedTimelineDays.length > 0) {
    conflicts.push({
      code: "STATE_AVAILABLE_WITH_LEASE_TIMELINE",
      evidence: evidenceForSources(evidence, ["VEHICLE", "LEASE", "TIMELINE"]),
      reason: "PR-1 state is AVAILABLE while PR-2 timeline contains leased days.",
      severity: "HIGH"
    });
  }

  if (state.computedState === VehicleComputedOperationalState.AVAILABLE && serviceTimelineDays.length > 0) {
    conflicts.push({
      code: "STATE_AVAILABLE_WITH_SERVICE_TIMELINE",
      evidence: evidenceForSources(evidence, ["VEHICLE", "SERVICE_CASE", "TIMELINE"]),
      reason: "PR-1 state is AVAILABLE while PR-2 timeline contains service or maintenance days.",
      severity: "MEDIUM"
    });
  }

  return conflicts;
}

function evidenceForSources(evidence: FleetOpsSnapshotEvidence[], sources: string[]) {
  const sourceSet = new Set(sources);
  return evidence.filter((item) => sourceSet.has(item.source));
}

function consistencyScore(conflicts: FleetOpsSnapshotConflict[]) {
  const penalty = conflicts.reduce((total, conflict) => {
    if (conflict.severity === "CRITICAL") {
      return total + 35;
    }

    if (conflict.severity === "HIGH") {
      return total + 25;
    }

    if (conflict.severity === "MEDIUM") {
      return total + 15;
    }

    return total + 5;
  }, 0);

  return Math.max(0, 100 - penalty);
}
