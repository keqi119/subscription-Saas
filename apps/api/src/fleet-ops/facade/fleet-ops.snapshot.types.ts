import type { FleetKpiVehicleResult } from "../economics/economics.types";
import type { ExecutionActionType, ExecutionGuardResult } from "../execution/execution.types";
import type { ControlDecision, RiskOutput, RiskSignalCode } from "../risk/risk.types";
import type { TimelineConflict, TimelineDay, TimelineState } from "../timeline/vehicle-timeline.types";
import type {
  VehicleComputedOperationalState,
  VehicleOperationalStateConflict,
  VehicleOperationalStateEvidence,
  VehicleOperationalStateResult
} from "../vehicle-operational-state.types";
import type { FleetOpsConfidence, FleetOpsConfidenceBand, FleetOpsConflictSeverity, FleetOpsWarning } from "../fleet-ops.shared-contracts";

export type FleetOpsSnapshotLayer = "STATE" | "TIMELINE" | "ECONOMICS" | "RISK" | "EXECUTION" | "SYSTEM";

export interface FleetOpsSnapshotEvidence {
  fields?: Record<string, unknown>;
  layers: FleetOpsSnapshotLayer[];
  observedAt?: Date | null;
  source: string;
  sourceId?: string;
  summary: string;
}

export interface FleetOpsSnapshotConflict {
  code: string;
  evidence: FleetOpsSnapshotEvidence[];
  reason: string;
  severity: FleetOpsConflictSeverity;
}

export interface FleetOpsSnapshotState {
  computedState: VehicleComputedOperationalState;
  confidence: FleetOpsConfidence;
  conflicts: FleetOpsSnapshotConflict[];
  evidence: FleetOpsSnapshotEvidence[];
}

export interface FleetOpsSnapshotTimelineEvent {
  confidence: number;
  conflicts: TimelineConflict[];
  date: string;
  sourceEvents: string[];
  state: TimelineState;
  warnings: string[];
}

export interface FleetOpsSnapshotTimelineSummary {
  averageConfidence: number;
  conflictCount: number;
  eventCount: number;
  fallbackWarningDays: number;
  rangeDays: number;
  stateCounts: Partial<Record<TimelineState, number>>;
}

export interface FleetOpsSnapshotTimeline {
  events: FleetOpsSnapshotTimelineEvent[];
  summary: FleetOpsSnapshotTimelineSummary;
  warnings: string[];
}

export interface FleetOpsSnapshotCashflow {
  actual: number | null;
  deposit: number | null;
  planned: number | null;
}

export interface FleetOpsSnapshotEconomics {
  cashflow: FleetOpsSnapshotCashflow;
  confidence: FleetOpsConfidence;
  cost: number | null;
  revenue: number | null;
  roe: number | null;
  roi: number | null;
}

export interface FleetOpsSnapshotRisk {
  level: string | null;
  score: number | null;
  signals: RiskSignalCode[];
}

export interface FleetOpsSnapshotExecutionAction {
  actionType: ExecutionActionType;
  guard: ExecutionGuardResult;
}

export interface FleetOpsSnapshotExecution {
  allowedActions: FleetOpsSnapshotExecutionAction[];
  blockedActions: FleetOpsSnapshotExecutionAction[];
  guardDecision: ControlDecision | "MISSING_RISK";
}

export type FleetOpsDataFreshnessStatus = "FRESH" | "STALE" | "UNKNOWN";

export interface FleetOpsSnapshotDataFreshness {
  latestObservedAt: Date | null;
  status: FleetOpsDataFreshnessStatus;
}

export interface FleetOpsSnapshotSystem {
  consistencyScore: number;
  dataFreshness: FleetOpsSnapshotDataFreshness;
  overallConfidence: FleetOpsConfidence;
}

export interface FleetOpsSnapshot {
  conflicts: FleetOpsSnapshotConflict[];
  economics: FleetOpsSnapshotEconomics;
  evidence: FleetOpsSnapshotEvidence[];
  execution: FleetOpsSnapshotExecution;
  generatedAt: Date;
  range: {
    from: Date;
    to: Date;
  };
  risk: FleetOpsSnapshotRisk;
  state: FleetOpsSnapshotState;
  system: FleetOpsSnapshotSystem;
  timeline: FleetOpsSnapshotTimeline;
  vehicleId: string;
  warnings: FleetOpsWarning[];
}

export interface FleetOpsSnapshotBuilderInput {
  economics?: FleetKpiVehicleResult | null;
  from: Date;
  generatedAt: Date;
  risk?: RiskOutput | null;
  state: VehicleOperationalStateResult;
  timeline: TimelineDay[];
  to: Date;
  vehicleId: string;
}

export interface FleetOpsStateEvidenceInput {
  conflicts: VehicleOperationalStateConflict[];
  evidence: VehicleOperationalStateEvidence[];
}

export interface FleetOpsConfidenceMergeInput {
  conflictCount?: number;
  fallbackPenaltyCount?: number;
  inputs: Array<{
    label: string;
    score?: number | null;
    weight: number;
  }>;
  missingDataCount?: number;
}

export interface FleetOpsConfidenceMergeResult extends FleetOpsConfidence {
  band: FleetOpsConfidenceBand;
}
