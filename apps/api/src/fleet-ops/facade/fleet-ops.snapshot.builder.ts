import { ACTION_REGISTRY } from "../execution/action.registry";
import { ExecutionGatewayGuard } from "../execution/execution-gateway.guard";
import type { FleetKpiEvidence, FleetKpiWarning } from "../economics/economics.types";
import type { ExecutionGuardResult, FleetExecutionRequest } from "../execution/execution.types";
import type {
  RiskArrearsPipeline,
  RiskEvidence,
  RiskOutput,
  RiskPaymentWriteOffEvidence,
  RiskWarning
} from "../risk/risk.types";
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
    economics: input.economics,
    evidence,
    risk: input.risk,
    state: input.state,
    timeline: input.timeline
  });
  const conflicts = [...stateConflicts, ...timelineConflicts, ...consistency.conflicts].sort(compareConflicts);
  const missingDataCount = [input.economics, input.risk, input.timeline.length > 0 ? input.timeline : null].filter((value) => !value).length;
  const economicsWarnings = economicsWarningsFor(input.economics);
  const riskWarnings = riskWarningsFor(input.risk);
  const overallConfidence = mergeFleetOpsConfidence({
    conflictCount: conflicts.length,
    economicsWarningCount: economicsWarnings.length,
    fallbackPenaltyCount: consistency.confidencePenaltyCount,
    inputs: [
      { label: "state", score: input.state.confidenceScore, weight: 0.35 },
      { label: "timeline", score: timeline.summary.averageConfidence, weight: 0.25 },
      { label: "economics", score: input.economics?.confidence.score, weight: 0.2 },
      { label: "risk", score: input.risk?.confidence, weight: 0.2 }
    ],
    missingDataCount,
    missingDetailCount: missingDetailCountFor(input.economics, input.risk),
    riskWarningCount: riskWarnings.length
  });
  const warnings = [
    ...warningsFromStrings("STATE_WARNING", input.state.warnings),
    ...warningsFromStrings("TIMELINE_WARNING", timeline.warnings),
    ...warningsFromKpiWarnings(economicsWarnings),
    ...warningsFromRiskWarnings(riskWarnings),
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
    risk: riskSnapshot(input.risk),
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

  const evidenceItems = [
    ...(economics.evidence ?? []),
    ...(economics.denominatorEvidence ?? []),
    ...(economics.cashflow?.evidence ?? [])
  ];

  return [
    ...evidenceItems.map((evidence) => kpiEvidenceToSnapshotEvidence(evidence)),
    {
      evidenceType: "summary",
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

  const riskEvidence = [
    ...(risk.evidence ?? []),
    ...(risk.exposureDetail?.evidence ?? []),
    ...(risk.exposureDetail?.partialPaymentEvidence ?? []),
    ...(risk.arrearsPipeline?.evidence ?? [])
  ];

  return [
    ...riskEvidence.map((evidence) => riskEvidenceToSnapshotEvidence(evidence)),
    ...(risk.exposureDetail?.overdueBillRefs ?? []).map((billRef) => ({
      evidenceType: "overdue_bill",
      fields: {
        dueDate: cloneDate(billRef.dueDate),
        overdueDays: billRef.overdueDays,
        paidAmount: billRef.paidAmount,
        remainingAmount: billRef.remainingAmount,
        sourceStatus: billRef.sourceStatus
      },
      layers: ["RISK" as const],
      source: "receivable_bill",
      sourceId: billRef.billId,
      summary: "PR-4 overdue bill reference contributed to risk exposure."
    })),
    ...(risk.exposureDetail?.writeOffEvidence ?? []).map(riskWriteOffToSnapshotEvidence),
    ...(risk.arrearsPipeline ? arrearsPipelineEvidenceFor(risk.arrearsPipeline) : []),
    {
      evidenceType: "summary",
      fields: {
        agingBucket: risk.agingBucket,
        collectionLevel: risk.collectionLevel,
        controlDecision: risk.controlDecision,
        maxOverdueDays: risk.exposureDetail?.maxOverdueDays,
        overdueRemainingAmount: risk.exposureDetail?.overdueRemainingAmount,
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

function kpiEvidenceToSnapshotEvidence(evidence: FleetKpiEvidence): FleetOpsSnapshotEvidence {
  return {
    evidenceType: evidence.source,
    fields: {
      amount: evidence.amount,
      reason: evidence.reason
    },
    layers: ["ECONOMICS"],
    source: evidence.source,
    sourceId: evidence.sourceId,
    summary: evidence.reason
  };
}

function riskEvidenceToSnapshotEvidence(evidence: RiskEvidence): FleetOpsSnapshotEvidence {
  return {
    evidenceType: evidence.source,
    fields: {
      amount: evidence.amount,
      observedAt: cloneObservedAt(evidence.observedAt),
      reason: evidence.reason
    },
    layers: ["RISK"],
    source: evidence.source,
    sourceId: evidence.sourceId,
    summary: evidence.reason
  };
}

function riskWriteOffToSnapshotEvidence(writeOff: RiskPaymentWriteOffEvidence): FleetOpsSnapshotEvidence {
  return {
    evidenceType: "write_off_allocation",
    fields: {
      amount: writeOff.amount,
      billId: writeOff.billId,
      paymentId: writeOff.paymentId,
      writeOffAt: cloneDateOrNull(writeOff.writeOffAt)
    },
    layers: ["RISK"],
    source: "payment_write_off",
    sourceId: writeOff.id,
    summary: "PR-4 write-off evidence contributed to overdue exposure traceability."
  };
}

function arrearsPipelineEvidenceFor(pipeline: RiskArrearsPipeline): FleetOpsSnapshotEvidence[] {
  return [
    ...pipeline.billRefs.map((billRef) => ({
      evidenceType: "arrears_bill",
      fields: {
        dueDate: cloneDate(billRef.dueDate),
        overdueDays: billRef.overdueDays,
        paidAmount: billRef.paidAmount,
        remainingAmount: billRef.remainingAmount,
        sourceStatus: billRef.sourceStatus
      },
      layers: ["RISK" as const],
      source: "receivable_bill",
      sourceId: billRef.billId,
      summary: "PR-4 arrears pipeline includes overdue bill evidence."
    })),
    ...pipeline.caseRefs.map((caseRef) => ({
      evidenceType: "arrears_case",
      fields: {
        caseStatus: caseRef.caseStatus,
        collectionLevel: caseRef.collectionLevel
      },
      layers: ["RISK" as const],
      source: "collection_case",
      sourceId: caseRef.caseId,
      summary: "PR-4 arrears pipeline includes collection case evidence."
    })),
    ...pipeline.actionRefs.map((actionRef) => ({
      evidenceType: "arrears_action",
      fields: {
        actionType: actionRef.actionType,
        result: actionRef.result
      },
      layers: ["RISK" as const],
      source: "collection_action",
      sourceId: actionRef.actionId,
      summary: "PR-4 arrears pipeline includes collection action evidence."
    })),
    ...pipeline.paymentRefs.map((paymentRef) => ({
      evidenceType: "arrears_payment",
      layers: ["RISK" as const],
      source: "payment_record",
      sourceId: paymentRef.paymentId,
      summary: "PR-4 arrears pipeline includes payment evidence."
    })),
    ...pipeline.writeOffRefs.map(riskWriteOffToSnapshotEvidence)
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
      attribution: null,
      cashflow: {
        actual: null,
        actualDetail: null,
        deposit: null,
        evidence: [],
        planned: null,
        plannedDetail: null,
        warnings: [],
        writeOff: null
      },
      confidence: unknownConfidence("PR-3 economic output is missing."),
      cost: null,
      denominatorEvidence: [],
      downtimeTrace: [],
      evidence: [],
      revenue: null,
      reportParity: null,
      roe: null,
      roi: null,
      warnings: []
    };
  }

  const cashflow = economics.cashflow;
  const warnings = economicsWarningsFor(economics);

  return {
    attribution: { ...economics.attribution },
    cashflow: {
      actual: cashflow?.actual.operating ?? economics.economics.revenue,
      actualDetail: cashflow ? { ...cashflow.actual } : null,
      deposit: cashflow ? roundMoney(cashflow.actual.deposit + cashflow.planned.deposit) : null,
      evidence: cloneKpiEvidence(cashflow?.evidence ?? []),
      planned: cashflow?.planned.operating ?? null,
      plannedDetail: cashflow ? { ...cashflow.planned } : null,
      warnings: uniqueStrings(cashflow?.warnings ?? []) as FleetKpiWarning[],
      writeOff: cashflow ? { ...cashflow.writeOff } : null
    },
    confidence: {
      band: economics.confidence.band,
      reasons: ["PR-3 economic confidence forwarded without recalculation."],
      score: economics.confidence.score
    },
    cost: economics.economics.cost,
    denominatorEvidence: cloneKpiEvidence(economics.denominatorEvidence ?? []),
    downtimeTrace: (economics.downtime.trace ?? []).map((trace) => ({
      ...trace,
      sourceEvents: [...trace.sourceEvents].sort()
    })),
    evidence: cloneKpiEvidence(economics.evidence ?? []),
    revenue: economics.economics.revenue,
    reportParity: economics.reportParity
      ? {
          depositIncludedInOperatingRevenue: economics.reportParity.depositIncludedInOperatingRevenue,
          operatingRevenueBillTypes: [...economics.reportParity.operatingRevenueBillTypes]
        }
      : null,
    roe: economics.economics.roe,
    roi: economics.economics.roi,
    warnings
  };
}

function riskSnapshot(risk: RiskOutput | null | undefined) {
  if (!risk) {
    return {
      agingBucket: null,
      arrearsPipeline: null,
      collectionLevel: null,
      evidence: [],
      exposureDetail: null,
      level: null,
      maxOverdueDays: null,
      overdueBillRefs: [],
      overdueRemainingAmount: null,
      score: null,
      signals: [],
      warnings: []
    };
  }

  const exposureDetail = risk.exposureDetail ? cloneRiskExposure(risk.exposureDetail) : null;

  return {
    agingBucket: risk.agingBucket ?? null,
    arrearsPipeline: risk.arrearsPipeline ? cloneArrearsPipeline(risk.arrearsPipeline) : null,
    collectionLevel: risk.collectionLevel,
    evidence: cloneRiskEvidence(risk.evidence ?? []),
    exposureDetail,
    level: risk.collectionLevel,
    maxOverdueDays: exposureDetail?.maxOverdueDays ?? null,
    overdueBillRefs: exposureDetail?.overdueBillRefs ?? [],
    overdueRemainingAmount: exposureDetail?.overdueRemainingAmount ?? null,
    score: risk.riskScore,
    signals: [...risk.signals].sort(),
    warnings: cloneRiskWarnings(risk.warnings ?? [])
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

function warningsFromKpiWarnings(warnings: FleetKpiWarning[]): FleetOpsWarning[] {
  return uniqueStrings(warnings).map((warning) => ({
    code: "ECONOMICS_WARNING",
    message: warning
  }));
}

function warningsFromRiskWarnings(warnings: RiskWarning[]): FleetOpsWarning[] {
  return warnings
    .map((warning) => ({
      code: "RISK_WARNING",
      message: warning.code
    }))
    .sort(compareWarnings);
}

function economicsWarningsFor(economics: FleetOpsSnapshotBuilderInput["economics"]): FleetKpiWarning[] {
  if (!economics) {
    return [];
  }

  return uniqueStrings([...(economics.warnings ?? []), ...(economics.cashflow?.warnings ?? [])]) as FleetKpiWarning[];
}

function riskWarningsFor(risk: RiskOutput | null | undefined): RiskWarning[] {
  return cloneRiskWarnings(risk?.warnings ?? []);
}

function missingDetailCountFor(economics: FleetOpsSnapshotBuilderInput["economics"], risk: RiskOutput | null | undefined) {
  return [
    economics && !economics.cashflow,
    economics && !economics.denominatorEvidence,
    risk && !risk.exposureDetail,
    risk && !risk.arrearsPipeline
  ].filter(Boolean).length;
}

function cloneKpiEvidence(evidence: FleetKpiEvidence[]): FleetKpiEvidence[] {
  return evidence.map((item) => ({ ...item }));
}

function cloneRiskEvidence(evidence: RiskEvidence[]): RiskEvidence[] {
  return evidence.map((item) => ({
    ...item,
    observedAt: cloneObservedAt(item.observedAt)
  }));
}

function cloneRiskWarnings(warnings: RiskWarning[]): RiskWarning[] {
  return warnings.map((warning) => ({ ...warning })).sort((left, right) => {
    const codeDelta = left.code.localeCompare(right.code);
    if (codeDelta !== 0) {
      return codeDelta;
    }

    return (left.sourceId ?? "").localeCompare(right.sourceId ?? "");
  });
}

function cloneRiskExposure(exposure: NonNullable<RiskOutput["exposureDetail"]>): NonNullable<RiskOutput["exposureDetail"]> {
  return {
    ...exposure,
    evidence: cloneRiskEvidence(exposure.evidence),
    overdueBillRefs: exposure.overdueBillRefs.map((billRef) => ({
      ...billRef,
      dueDate: cloneDate(billRef.dueDate)
    })),
    partialPaymentEvidence: cloneRiskEvidence(exposure.partialPaymentEvidence),
    warnings: cloneRiskWarnings(exposure.warnings),
    writeOffEvidence: exposure.writeOffEvidence.map(cloneRiskWriteOffEvidence)
  };
}

function cloneArrearsPipeline(pipeline: RiskArrearsPipeline): RiskArrearsPipeline {
  return {
    ...pipeline,
    actionRefs: pipeline.actionRefs.map((actionRef) => ({ ...actionRef })),
    billRefs: pipeline.billRefs.map((billRef) => ({
      ...billRef,
      dueDate: cloneDate(billRef.dueDate)
    })),
    caseRefs: pipeline.caseRefs.map((caseRef) => ({ ...caseRef })),
    evidence: cloneRiskEvidence(pipeline.evidence),
    paymentRefs: pipeline.paymentRefs.map((paymentRef) => ({ ...paymentRef })),
    promiseToPayRefs: pipeline.promiseToPayRefs.map((promiseRef) => ({
      ...promiseRef,
      promisedPayAt: cloneDateOrNull(promiseRef.promisedPayAt)
    })),
    warnings: cloneRiskWarnings(pipeline.warnings),
    writeOffRefs: pipeline.writeOffRefs.map(cloneRiskWriteOffEvidence)
  };
}

function cloneRiskWriteOffEvidence(writeOff: RiskPaymentWriteOffEvidence): RiskPaymentWriteOffEvidence {
  return {
    ...writeOff,
    writeOffAt: cloneDateOrNull(writeOff.writeOffAt)
  };
}

function cloneObservedAt(observedAt: Date | string | null | undefined) {
  if (observedAt instanceof Date) {
    return cloneDate(observedAt);
  }

  return observedAt ?? null;
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

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)].sort();
}
