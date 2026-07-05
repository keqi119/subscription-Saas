import type {
  FleetOpsApiEnvelope,
  FleetOpsEvidence,
  FleetOpsOverviewAnomalyItem,
  FleetOpsPoolIdentity,
  FleetOpsSnapshot,
  FleetOpsVehicleLookupItem,
  FleetOpsVehicleScopeItem
} from "./fleet-ops-api";

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

export interface FleetOpsLookupValidation {
  query?: string;
  reason?: string;
  valid: boolean;
}

export interface FleetOpsAnomalyTableRow {
  collectionLevel?: string;
  confidence?: number;
  drilldownHref: string;
  issueCount?: number;
  overdueRemainingAmount?: number;
  riskScore?: number;
  roe?: number;
  roi?: number;
  vehicleId: string;
  vehicleLabel: string;
}

export interface FleetOpsPoolTableRow extends FleetOpsPoolIdentity {
  detailHref: string;
  poolLabel: string;
}

export interface FleetOpsScopedVehicleTableRow extends FleetOpsVehicleScopeItem {
  drilldownHref: string;
  modelLabel: string;
  vehicleLabel: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateFleetOpsLookupQuery(input: string): FleetOpsLookupValidation {
  const query = input.trim();
  if (!query) {
    return { reason: "请输入车辆编号、VIN、车牌号或内部 ID。", valid: false };
  }

  if (query.length < 2 && !UUID_PATTERN.test(query)) {
    return { reason: "请输入至少 2 个字符，或输入完整内部车辆 ID。", valid: false };
  }

  return { query, valid: true };
}

export function buildFleetOpsLookupOptionLabel(item: FleetOpsVehicleLookupItem) {
  return [
    item.vehicleNo ?? item.vehicleId,
    item.plateMasked,
    item.vinSuffix ? `VIN后6位 ${item.vinSuffix}` : undefined,
    buildFleetOpsLookupModelLabel(item),
    item.statusLabel ?? item.operationalState
  ]
    .filter((value): value is string => Boolean(value))
    .join(" / ");
}

export function buildFleetOpsVehicleSelectionSummary(item: FleetOpsVehicleLookupItem) {
  return [
    item.vehicleNo ?? item.vehicleId,
    item.plateMasked,
    item.vinSuffix ? `VIN后6位 ${item.vinSuffix}` : undefined,
    buildFleetOpsLookupModelLabel(item)
  ]
    .filter((value): value is string => Boolean(value))
    .join(" / ");
}

export function formatFleetOpsMoney(value: unknown) {
  const amount = numberOrNull(value);
  if (amount === null) {
    return "-";
  }

  return `${(amount / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })} 元`;
}

export function formatFleetOpsCount(value: unknown) {
  const count = numberOrNull(value);
  return count === null ? "-" : count.toLocaleString("zh-CN");
}

export function formatFleetOpsRatio(value: unknown) {
  const ratio = numberOrNull(value);
  return ratio === null ? "-" : `${(ratio * 100).toFixed(2)}%`;
}

export function formatFleetOpsScore(value: unknown) {
  const score = numberOrNull(value);
  return score === null ? "-" : score.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function formatFleetOpsRoiLabel() {
  return "ROI（池/分群总额口径）";
}

export function formatFleetOpsRoeLabel() {
  return "ROE（非单车简单平均）";
}

export function formatFleetOpsDepositTreatmentNote() {
  return "押金已单列，不计入经营收入";
}

export function formatFleetOpsAgingBucketLabel(value?: string | null) {
  const labels: Record<string, string> = {
    D1: "D1 1-3 天",
    D2: "D2 4-7 天",
    D3: "D3 8-15 天",
    D4: "D4 16-30 天",
    D5: "D5 30 天以上",
    NONE: "无逾期"
  };

  return value ? labels[value] ?? value : "-";
}

export function formatFleetOpsConfidenceBandLabel(value?: string | null) {
  const labels: Record<string, string> = {
    HIGH: "高置信",
    LOW: "低置信",
    MEDIUM: "中置信",
    UNKNOWN: "未知"
  };

  return value ? labels[value] ?? value : "-";
}

export function formatFleetOpsRiskLevelLabel(value?: string | null) {
  const labels: Record<string, string> = {
    HIGH: "高风险",
    LOW: "低风险",
    MEDIUM: "中风险",
    NONE: "无风险",
    UNKNOWN: "未知"
  };

  return value ? labels[value] ?? value : "-";
}

export function summarizeFleetOpsWarnings(warnings: readonly unknown[] = []) {
  return warnings
    .map((warning) => {
      if (typeof warning === "string") {
        return warning;
      }
      if (!isRecord(warning)) {
        return undefined;
      }
      return stringOrUndefined(warning.code ?? warning.message);
    })
    .filter((value): value is string => Boolean(value));
}

export function buildFleetOpsVehicleDrilldownHref(vehicleId: string) {
  return `/fleet-ops?vehicleId=${encodeURIComponent(vehicleId)}`;
}

export function mapFleetOpsAnomalyRows(items: readonly FleetOpsOverviewAnomalyItem[] = []): FleetOpsAnomalyTableRow[] {
  return items.map((item) => ({
    collectionLevel: item.collectionLevel,
    confidence: item.confidence,
    drilldownHref: buildFleetOpsVehicleDrilldownHref(item.vehicleId),
    issueCount: item.issueCount,
    overdueRemainingAmount: item.overdueRemainingAmount,
    riskScore: item.riskScore,
    roe: item.roe,
    roi: item.roi,
    vehicleId: item.vehicleId,
    vehicleLabel: item.vehicleNo ?? item.vehicleId
  }));
}

export function mapFleetOpsPoolRows(items: readonly FleetOpsPoolIdentity[] = []): FleetOpsPoolTableRow[] {
  return items.map((item) => ({
    ...item,
    detailHref: `/fleet-ops/pools/${encodeURIComponent(item.poolId)}`,
    poolLabel: [item.poolNo, item.poolName].filter(Boolean).join(" / ")
  }));
}

export function mapFleetOpsScopedVehicleRows(items: readonly FleetOpsVehicleScopeItem[] = []): FleetOpsScopedVehicleTableRow[] {
  return items.map((item) => ({
    ...item,
    drilldownHref: buildFleetOpsVehicleDrilldownHref(item.vehicleId),
    modelLabel: [item.brand, item.model, item.modelYear ? String(item.modelYear) : undefined]
      .filter((value): value is string => Boolean(value))
      .join(" / "),
    vehicleLabel: item.vehicleNo ?? item.vehicleId
  }));
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
    return { reason: "车队运营日期必须使用 YYYY-MM-DD。", valid: false };
  }

  const days = Math.round((end - start) / 86_400_000);
  if (days < 0) {
    return { days, reason: "车队运营结束日期不能早于开始日期。", valid: false };
  }

  if (days > 366) {
    return { days, reason: "车队运营日期范围不能超过 366 天。", valid: false };
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

function buildFleetOpsLookupModelLabel(item: FleetOpsVehicleLookupItem) {
  return [item.brand, item.model, item.modelYear ? String(item.modelYear) : undefined]
    .filter((value): value is string => Boolean(value))
    .join(" / ");
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
