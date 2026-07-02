import { ACTION_REGISTRY } from "../execution/action.registry";
import { ExecutionGatewayGuard } from "../execution/execution-gateway.guard";
import type { ExecutionGuardResult, FleetExecutionRequest } from "../execution/execution.types";
import type { RiskOutput } from "../risk/risk.types";
import { TimelineState, type TimelineConflict, type TimelineDay } from "../timeline/vehicle-timeline.types";
import type {
  VehicleOperationalStateConflict,
  VehicleOperationalStateResult
} from "../vehicle-operational-state.types";
import type { FleetOpsConfidence, FleetOpsConfidenceBand, FleetOpsWarning } from "../fleet-ops.shared-contracts";
import { checkFleetOpsConsistency } from "./fleet-ops.consistency.checker";
import { mergeFleetOpsConfidence } from "./fleet-ops.confidence.merge";
import { mergeFleetOpsEvidence } from "./fleet-ops.evidence.merge";
import type {
  FleetOpsSnapshot,
  FleetOpsSnapshotBuilderInput,
  FleetOpsSnapshotConflict,
  FleetOpsSnapshotEconomics,
  FleetOpsSnapshotEvidence,
  FleetOpsSnapshotExecution,
  FleetOpsSnapshotExecutionAction,
  FleetOpsSnapshotTimeline,
  FleetOpsSnapshotTimelineEvent
} from "./fleet-ops.snapshot.types";

const FRESHNESS_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export function buildFleetOpsSnapshot(input: FleetOpsSnapshotBuilderInput): FleetOpsSnapshot {
  const stateEvidence = stateEvidenceFor(input.state);
  const timelineEvidence = timelineEvidenceFor(input.timeline);
  const economicsEvidence = economicsEvidenceFor(input.economics, input.vehicleId);
  const riskEvidence = riskEvidenceFor(input.risk);
  const execution = buildExecutionProjection(input.vehicleId, input.risk, input.generatedAt);
  const executionEvidence = executionEvidenceFor(execution, input.vehicleId);
  const evidence = mergeFleetOpsEvidence([
    stateEvidence,
    timelineEvidence,
    economicsEvidence,
    riskEvidence,
    executionEvidence
  ]);
  const timeline = buildTimelineSnapshot(input.timeline);
  const stateConflicts = stateConflictsFor(input.state.conflicts, evidence);
  const timelineConflicts = timelineConflictsFor(input.timeline, evidence);
  const consistency = checkFleetOpsConsistency({
    evidence,
    state: input.state,
    timeline: input.timeline
  });
  const conflicts = [...stateConflicts, ...timelineConflicts, ...consistency.conflicts].sort(compareConflicts);
  const missingDataCount = [input.economics, input.risk, input.timeline.length > 0 ? input.timeline : null].filter((value) => !value).length;
  const overallConfidence = mergeFleetOpsConfidence({
    conflictCount: conflicts.length,
    fallbackPenaltyCount: consistency.confidencePenaltyCount,
    inputs: [
      { label: "state", score: input.state.confidenceScore, weight: 0.35 },
      { label: "timeline", score: timeline.summary.averageConfidence, weight: 0.25 },
      { label: "economics", score: input.economics?.confidence.score, weight: 0.2 },
      { label: "risk", score: input.risk?.confidence, weight: 0.2 }
    ],
    missingDataCount
  });
  const warnings = [
    ...warningsFromStrings("STATE_WARNING", input.state.warnings),
    ...warningsFromStrings("TIMELINE_WARNING", timeline.warnings),
    ...consistency.warnings
  ].sort(compareWarnings);

  return {
    conflicts,
    economics: economicsSnapshot(input.economics),
    evidence,
    execution,
    generatedAt: cloneDate(input.generatedAt),
    range: {
      from: cloneDate(input.from),
      to: cloneDate(input.to)
    },
    risk: {
      level: input.risk?.collectionLevel ?? null,
      score: input.risk?.riskScore ?? null,
      signals: [...(input.risk?.signals ?? [])].sort()
    },
    state: {
      computedState: input.state.computedState,
      confidence: confidenceFromState(input.state),
      conflicts: stateConflicts,
      evidence: stateEvidence
    },
    system: {
      consistencyScore: consistency.consistencyScore,
      dataFreshness: dataFreshness(evidence, input.generatedAt),
      overallConfidence
    },
    timeline,
    vehicleId: input.vehicleId,
    warnings
  };
}

function stateEvidenceFor(state: VehicleOperationalStateResult): FleetOpsSnapshotEvidence[] {
  return [state.primaryEvidence, ...state.supportingEvidence].map((evidence) => ({
    fields: { ...evidence.fields },
    layers: ["STATE"],
    observedAt: cloneDateOrNull(evidence.recordedAt),
    source: evidence.source,
    sourceId: evidence.sourceId,
    summary: evidence.reason
  }));
}

function timelineEvidenceFor(timeline: TimelineDay[]): FleetOpsSnapshotEvidence[] {
  return timeline.flatMap((day) =>
    day.sourceEvents.map((eventId) => ({
      fields: {
        date: day.date,
        state: day.state
      },
      layers: ["TIMELINE" as const],
      source: sourceFromTimelineEvent(eventId),
      sourceId: eventId,
      summary: `Timeline event ${eventId} contributed to ${day.date}.`
    }))
  );
}

function economicsEvidenceFor(economics: FleetOpsSnapshotBuilderInput["economics"], vehicleId: string): FleetOpsSnapshotEvidence[] {
  if (!economics) {
    return [];
  }

  return [
    {
      fields: {
        cost: economics.economics.cost,
        revenue: economics.economics.revenue,
        roe: economics.economics.roe,
        roi: economics.economics.roi
      },
      layers: ["ECONOMICS"],
      source: "ECONOMICS",
      sourceId: vehicleId,
      summary: "PR-3 economic KPI output contributed to the snapshot."
    }
  ];
}

function riskEvidenceFor(risk: RiskOutput | null | undefined): FleetOpsSnapshotEvidence[] {
  if (!risk) {
    return [];
  }

  return [
    {
      fields: {
        collectionLevel: risk.collectionLevel,
        controlDecision: risk.controlDecision,
        riskScore: risk.riskScore,
        signals: [...risk.signals].sort()
      },
      layers: ["RISK"],
      source: "RISK",
      sourceId: risk.vehicleId,
      summary: "PR-4 risk output contributed to the snapshot."
    }
  ];
}

function executionEvidenceFor(execution: FleetOpsSnapshotExecution, vehicleId: string): FleetOpsSnapshotEvidence[] {
  return [...execution.allowedActions, ...execution.blockedActions].map((action) => ({
    fields: {
      allowed: action.guard.allowed,
      requiresOverride: action.guard.requiresOverride,
      softRestriction: action.guard.softRestriction
    },
    layers: ["EXECUTION" as const],
    source: "EXECUTION_GUARD",
    sourceId: `${vehicleId}:${action.actionType}`,
    summary: `PR-5 guard projection evaluated ${action.actionType}.`
  }));
}

function buildTimelineSnapshot(timeline: TimelineDay[]): FleetOpsSnapshotTimeline {
  const events = timeline.map(toTimelineEvent);
  const warnings = uniqueStrings(events.flatMap((event) => event.warnings));
  const averageConfidence =
    events.length === 0 ? null : events.reduce((total, event) => total + event.confidence, 0) / events.length;
  const stateCounts = events.reduce<Partial<Record<TimelineState, number>>>((counts, event) => {
    counts[event.state] = (counts[event.state] ?? 0) + 1;
    return counts;
  }, {});

  return {
    events,
    summary: {
      averageConfidence: averageConfidence === null ? 0 : roundScore(averageConfidence),
      conflictCount: events.reduce((total, event) => total + event.conflicts.length, 0),
      eventCount: uniqueStrings(events.flatMap((event) => event.sourceEvents)).length,
      fallbackWarningDays: events.filter((event) => event.warnings.includes("CURRENT_STATUS_PROJECTED_ACROSS_RANGE")).length,
      rangeDays: events.length,
      stateCounts
    },
    warnings
  };
}

function toTimelineEvent(day: TimelineDay): FleetOpsSnapshotTimelineEvent {
  return {
    confidence: day.confidence,
    conflicts: day.conflicts.map((conflict) => ({ ...conflict })),
    date: day.date,
    sourceEvents: [...day.sourceEvents].sort(),
    state: day.state,
    warnings: [...day.warnings].sort()
  };
}

function economicsSnapshot(economics: FleetOpsSnapshotBuilderInput["economics"]): FleetOpsSnapshotEconomics {
  if (!economics) {
    return {
      cashflow: {
        actual: null,
        deposit: null,
        planned: null
      },
      confidence: unknownConfidence("PR-3 economic output is missing."),
      cost: null,
      revenue: null,
      roe: null,
      roi: null
    };
  }

  return {
    cashflow: {
      actual: economics.economics.revenue,
      deposit: null,
      planned: null
    },
    confidence: {
      band: economics.confidence.band,
      reasons: ["PR-3 economic confidence forwarded without recalculation."],
      score: economics.confidence.score
    },
    cost: economics.economics.cost,
    revenue: economics.economics.revenue,
    roe: economics.economics.roe,
    roi: economics.economics.roi
  };
}

function buildExecutionProjection(vehicleId: string, risk: RiskOutput | null | undefined, generatedAt: Date): FleetOpsSnapshotExecution {
  const guard = new ExecutionGatewayGuard();
  const actions = [...ACTION_REGISTRY]
    .sort((left, right) => left.actionType.localeCompare(right.actionType))
    .map((entry): FleetOpsSnapshotExecutionAction => {
      const request: FleetExecutionRequest = {
        actionType: entry.actionType,
        idempotencyKey: `snapshot:${vehicleId}:${entry.actionType}`,
        requestedAt: cloneDate(generatedAt),
        vehicleId
      };

      return {
        actionType: entry.actionType,
        guard: cloneGuard(guard.validate(request, risk))
      };
    });

  return {
    allowedActions: actions.filter((action) => action.guard.allowed),
    blockedActions: actions.filter((action) => !action.guard.allowed),
    guardDecision: risk?.controlDecision ?? "MISSING_RISK"
  };
}

function stateConflictsFor(
  conflicts: VehicleOperationalStateConflict[],
  evidence: FleetOpsSnapshotEvidence[]
): FleetOpsSnapshotConflict[] {
  return conflicts.map((conflict) => ({
    code: `STATE_CONFLICT_${conflict.state}`,
    evidence: evidenceForSource(evidence, conflict.source, conflict.sourceId),
    reason: conflict.reason,
    severity: conflictSeverity(conflict.priority)
  }));
}

function timelineConflictsFor(timeline: TimelineDay[], evidence: FleetOpsSnapshotEvidence[]): FleetOpsSnapshotConflict[] {
  return timeline.flatMap((day) =>
    day.conflicts.map((conflict) => ({
      code: "TIMELINE_SIGNAL_CONFLICT",
      evidence: evidenceForTimelineConflict(evidence, conflict),
      reason: `${day.date}: ${conflict.reason}`,
      severity: "MEDIUM" as const
    }))
  );
}

function confidenceFromState(state: VehicleOperationalStateResult): FleetOpsConfidence {
  return {
    band: state.confidenceBand as unknown as FleetOpsConfidenceBand,
    reasons: ["PR-1 state confidence forwarded without recalculation."],
    score: state.confidenceScore
  };
}

function unknownConfidence(reason: string): FleetOpsConfidence {
  return {
    band: "UNKNOWN",
    reasons: [reason],
    score: 0
  };
}

function dataFreshness(evidence: FleetOpsSnapshotEvidence[], generatedAt: Date) {
  const latestObservedAt = evidence
    .map((item) => item.observedAt)
    .filter((date): date is Date => date instanceof Date)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

  if (!latestObservedAt) {
    return {
      latestObservedAt: null,
      status: "UNKNOWN" as const
    };
  }

  return {
    latestObservedAt: cloneDate(latestObservedAt),
    status: generatedAt.getTime() - latestObservedAt.getTime() > FRESHNESS_THRESHOLD_MS ? "STALE" as const : "FRESH" as const
  };
}

function evidenceForSource(evidence: FleetOpsSnapshotEvidence[], source: string, sourceId: string | undefined) {
  return evidence.filter((item) => item.source === source && (!sourceId || item.sourceId === sourceId));
}

function evidenceForTimelineConflict(evidence: FleetOpsSnapshotEvidence[], conflict: TimelineConflict) {
  const eventIds = new Set([conflict.winnerEventId, conflict.loserEventId]);
  return evidence.filter((item) => item.sourceId && eventIds.has(item.sourceId));
}

function sourceFromTimelineEvent(eventId: string) {
  const source = eventId.split(":")[0] ?? "timeline";

  return source.toUpperCase();
}

function conflictSeverity(priority: number) {
  if (priority >= 90) {
    return "HIGH" as const;
  }

  if (priority >= 60) {
    return "MEDIUM" as const;
  }

  return "LOW" as const;
}

function warningsFromStrings(code: string, warnings: string[]): FleetOpsWarning[] {
  return uniqueStrings(warnings).map((warning) => ({
    code,
    message: warning
  }));
}

function compareConflicts(left: FleetOpsSnapshotConflict, right: FleetOpsSnapshotConflict) {
  const codeDelta = left.code.localeCompare(right.code);
  if (codeDelta !== 0) {
    return codeDelta;
  }

  return left.reason.localeCompare(right.reason);
}

function compareWarnings(left: FleetOpsWarning, right: FleetOpsWarning) {
  const codeDelta = left.code.localeCompare(right.code);
  if (codeDelta !== 0) {
    return codeDelta;
  }

  return left.message.localeCompare(right.message);
}

function cloneGuard(guard: ExecutionGuardResult): ExecutionGuardResult {
  return {
    ...guard,
    reason: [...guard.reason]
  };
}

function cloneDate(date: Date) {
  return new Date(date.getTime());
}

function cloneDateOrNull(date: Date | null | undefined) {
  return date ? cloneDate(date) : null;
}

function roundScore(value: number) {
  return Math.round(value);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)].sort();
}
