import {
  TIMELINE_CURRENT_STATUS_PROJECTED_WARNING,
  TimelineState,
  type TimelineDay
} from "../timeline/vehicle-timeline.types";
import { VehicleComputedOperationalState, type VehicleOperationalStateResult } from "../vehicle-operational-state.types";
import type { FleetOpsWarning } from "../fleet-ops.shared-contracts";
import type { FleetOpsSnapshotConflict, FleetOpsSnapshotEvidence } from "./fleet-ops.snapshot.types";

export interface FleetOpsConsistencyInput {
  evidence: FleetOpsSnapshotEvidence[];
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
    ...stateTimelineConflicts(input.state, input.timeline, input.evidence)
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
      : [])
  ];

  return {
    confidencePenaltyCount: fallbackWarningDays,
    conflicts,
    consistencyScore: consistencyScore(conflicts),
    warnings
  };
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
