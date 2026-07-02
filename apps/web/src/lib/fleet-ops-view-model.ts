import type { FleetOpsApiEnvelope, FleetOpsEvidence, FleetOpsSnapshot } from "./fleet-ops-api";

export const FLEET_OPS_READ_ONLY_SECTION_KEYS = [
  "overview",
  "state",
  "timeline",
  "economics",
  "risk",
  "evidence"
] as const;

export interface FleetOpsSnapshotSummary {
  economics: FleetOpsEconomicsSummary;
  evidenceCount: number;
  generatedAt?: string;
  consistencyScore?: number | null;
  overallConfidenceScore?: number | null;
  risk: FleetOpsRiskSummary;
  state: FleetOpsStateSummary;
  system: FleetOpsSystemSummary;
  timeline: FleetOpsTimelineSummary;
  vehicleId?: string;
  warningCodes: string[];
  warningCount: number;
}

export interface FleetOpsSystemSummary {
  confidenceBand?: string;
  consistencyScore?: number | null;
  overallConfidenceScore?: number | null;
}

export interface FleetOpsStateSummary {
  computedState?: string;
  confidenceScore?: number | null;
  conflictCount: number;
  evidenceCount: number;
}

export interface FleetOpsTimelineSummary {
  eventCount: number;
  fallbackWarningDays: number;
  rangeDays?: number | null;
  warnings: string[];
}

export interface FleetOpsEconomicsSummary {
  actualDepositCashflow?: number | null;
  actualOperatingCashflow?: number | null;
  cashflowWarnings: string[];
  cost?: number | null;
  denominatorEvidenceCount: number;
  depositExcludedRevenue?: number | null;
  netIncome?: number | null;
  plannedDepositCashflow?: number | null;
  plannedOperatingCashflow?: number | null;
  revenue?: number | null;
  roe?: number | null;
  roi?: number | null;
  unassignedPaymentCashflow?: number | null;
}

export interface FleetOpsRiskSummary {
  agingBucket?: string;
  arrearsStage?: string;
  collectionLevel?: string;
  level?: string;
  maxOverdueDays?: number | null;
  overdueBillCount: number;
  overdueRemainingAmount?: number | null;
  score?: number | null;
  warningCount: number;
}

export interface FleetOpsEvidenceGroup {
  items: FleetOpsEvidence[];
  source: string;
}

export interface FleetOpsReadOnlySection {
  key: (typeof FLEET_OPS_READ_ONLY_SECTION_KEYS)[number];
  ready: boolean;
  warningCount: number;
}

export interface FleetOpsDateRangeInput {
  from?: string | null;
  to?: string | null;
}

export interface FleetOpsDateRangeValidation {
  days?: number;
  reason?: string;
  valid: boolean;
}

export function summarizeFleetOpsSnapshot(snapshot: FleetOpsSnapshot): FleetOpsSnapshotSummary {
  const warnings = getFleetOpsWarningSummary(snapshot);
  const evidence = Array.isArray(snapshot.evidence) ? snapshot.evidence : [];
  const system = asRecord(snapshot.system);
  const state = asRecord(snapshot.state);
  const timeline = asRecord(snapshot.timeline);
  const economics = asRecord(snapshot.economics);
  const risk = asRecord(snapshot.risk);
  const exposureDetail = asRecord(risk.exposureDetail);
  const cashflow = asRecord(economics.cashflow);
  const actualCashflow = asRecord(cashflow.actual);
  const plannedCashflow = asRecord(cashflow.planned);
  const actualCashflowDetail = asRecord(cashflow.actualDetail);
  const plannedCashflowDetail = asRecord(cashflow.plannedDetail);
  const depositExclusion = asRecord(economics.depositExclusion);
  const attribution = asRecord(economics.attribution);
  const denominatorEvidence = Array.isArray(economics.denominatorEvidence) ? economics.denominatorEvidence : [];
  const timelineWarnings = collectWarningCodes(timeline.warnings);
  const cashflowWarnings = collectWarningCodes(cashflow.warnings);
  const riskWarnings = collectWarningCodes(risk.warnings);

  return {
    economics: {
      actualDepositCashflow: numberOrNull(actualCashflow.deposit ?? actualCashflowDetail.deposit ?? cashflow.deposit),
      actualOperatingCashflow: numberOrNull(actualCashflow.operating ?? actualCashflowDetail.operating ?? cashflow.actual),
      cashflowWarnings,
      cost: numberOrNull(economics.cost),
      denominatorEvidenceCount: denominatorEvidence.length,
      depositExcludedRevenue: numberOrNull(
        depositExclusion.excludedAmount ?? attribution.depositExcludedRevenue ?? cashflow.deposit
      ),
      netIncome: numberOrNull(economics.netIncome),
      plannedDepositCashflow: numberOrNull(plannedCashflow.deposit ?? plannedCashflowDetail.deposit),
      plannedOperatingCashflow: numberOrNull(plannedCashflow.operating ?? plannedCashflowDetail.operating ?? cashflow.planned),
      revenue: numberOrNull(economics.revenue),
      roe: numberOrNull(economics.roe),
      roi: numberOrNull(economics.roi),
      unassignedPaymentCashflow: numberOrNull(cashflow.unassignedPaymentAmount)
    },
    evidenceCount: evidence.length,
    generatedAt: stringOrUndefined(snapshot.generatedAt ?? system.generatedAt),
    consistencyScore: numberOrNull(system.consistencyScore),
    overallConfidenceScore: numberOrNull(asRecord(system.overallConfidence).score),
    risk: {
      agingBucket: stringOrUndefined(risk.agingBucket),
      arrearsStage: stringOrUndefined(asRecord(risk.arrearsPipeline).stage),
      collectionLevel: stringOrUndefined(risk.collectionLevel),
      level: stringOrUndefined(risk.level),
      maxOverdueDays: numberOrNull(exposureDetail.maxOverdueDays ?? risk.maxOverdueDays),
      overdueBillCount: numberOrZero(exposureDetail.overdueBillCount),
      overdueRemainingAmount: numberOrNull(exposureDetail.overdueRemainingAmount ?? risk.overdueRemainingAmount),
      score: numberOrNull(risk.score),
      warningCount: riskWarnings.length
    },
    state: {
      computedState: stringOrUndefined(state.computedState),
      confidenceScore: numberOrNull(asRecord(state.confidence).score),
      conflictCount: Array.isArray(state.conflicts) ? state.conflicts.length : 0,
      evidenceCount: Array.isArray(state.evidence) ? state.evidence.length : 0
    },
    system: {
      confidenceBand: stringOrUndefined(asRecord(system.overallConfidence).band),
      consistencyScore: numberOrNull(system.consistencyScore),
      overallConfidenceScore: numberOrNull(asRecord(system.overallConfidence).score)
    },
    timeline: {
      eventCount: Array.isArray(timeline.events) ? timeline.events.length : 0,
      fallbackWarningDays: countTimelineFallbackWarnings(timeline),
      rangeDays: numberOrNull(asRecord(timeline.summary).rangeDays),
      warnings: timelineWarnings
    },
    vehicleId: stringOrUndefined(snapshot.vehicleId),
    warningCodes: warnings.codes,
    warningCount: warnings.count
  };
}

export function groupFleetOpsEvidenceBySource(evidence: readonly FleetOpsEvidence[] = []): FleetOpsEvidenceGroup[] {
  const groups = new Map<string, FleetOpsEvidence[]>();

  for (const item of evidence) {
    const source = item.sourceType ?? item.source ?? "unknown";
    groups.set(source, [...(groups.get(source) ?? []), item]);
  }

  return Array.from(groups.entries())
    .map(([source, items]) => ({ items, source }))
    .sort((left, right) => left.source.localeCompare(right.source));
}

export function getFleetOpsWarningSummary(value: FleetOpsSnapshot | FleetOpsApiEnvelope<FleetOpsSnapshot>) {
  const snapshot = isEnvelope(value) ? value.data : value;
  const warningCodes = [
    ...collectWarningCodes(snapshot.warnings),
    ...collectWarningCodes(asRecord(snapshot.timeline).warnings),
    ...collectWarningCodes(asRecord(snapshot.economics).warnings),
    ...collectWarningCodes(asRecord(asRecord(snapshot.economics).cashflow).warnings),
    ...collectWarningCodes(asRecord(snapshot.risk).warnings),
    ...collectWarningCodes(asRecord(snapshot.system).warnings)
  ];

  return {
    codes: Array.from(new Set(warningCodes)),
    count: warningCodes.length,
    hasTimelineFallback: warningCodes.includes("CURRENT_STATUS_PROJECTED_ACROSS_RANGE")
  };
}

export function validateFleetOpsDateRange(input: FleetOpsDateRangeInput): FleetOpsDateRangeValidation {
  if (!input.from || !input.to) {
    return { valid: true };
  }

  const start = Date.parse(`${input.from}T00:00:00.000Z`);
  const end = Date.parse(`${input.to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { reason: "Fleet Ops dates must use YYYY-MM-DD.", valid: false };
  }

  const days = Math.round((end - start) / 86_400_000);
  if (days < 0) {
    return { days, reason: "Fleet Ops end date must be on or after start date.", valid: false };
  }

  if (days > 366) {
    return { days, reason: "Fleet Ops date range must not exceed 366 days.", valid: false };
  }

  return { days, valid: true };
}

export function buildFleetOpsReadOnlySections(snapshot: FleetOpsSnapshot): FleetOpsReadOnlySection[] {
  const summary = summarizeFleetOpsSnapshot(snapshot);

  return [
    { key: "overview", ready: true, warningCount: summary.warningCount },
    { key: "state", ready: Boolean(summary.state.computedState), warningCount: summary.state.conflictCount },
    { key: "timeline", ready: true, warningCount: summary.timeline.warnings.length },
    { key: "economics", ready: true, warningCount: summary.economics.cashflowWarnings.length },
    { key: "risk", ready: true, warningCount: summary.risk.warningCount },
    { key: "evidence", ready: true, warningCount: 0 }
  ];
}

function countTimelineFallbackWarnings(timeline: Record<string, unknown>) {
  const warnings = collectWarningCodes(timeline.warnings);
  const summaryFallbackDays = numberOrNull(asRecord(timeline.summary).fallbackWarningDays);
  const fallbackFromDays = Array.isArray(timeline.days)
    ? timeline.days.filter((day) =>
        collectWarningCodes(asRecord(day).warnings).includes("CURRENT_STATUS_PROJECTED_ACROSS_RANGE")
      ).length
    : 0;

  if (summaryFallbackDays !== null) {
    return summaryFallbackDays;
  }

  return fallbackFromDays || warnings.filter((code) => code === "CURRENT_STATUS_PROJECTED_ACROSS_RANGE").length;
}

function collectWarningCodes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (!isRecord(item)) {
        return undefined;
      }
      return stringOrUndefined(item.code ?? item.message);
    })
    .filter((item): item is string => Boolean(item));
}

function isEnvelope(value: unknown): value is FleetOpsApiEnvelope<FleetOpsSnapshot> {
  return isRecord(value) && isRecord(value.data);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
