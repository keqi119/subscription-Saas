export enum FleetOpsInvariantId {
  PR8_NO_ACTION_EXECUTION = "PR8_NO_ACTION_EXECUTION",
  PR7_NO_PR4_OVERRIDE = "PR7_NO_PR4_OVERRIDE",
  PR6_NO_PR5_EXECUTION = "PR6_NO_PR5_EXECUTION",
  PR5_REQUIRES_PR4_SNAPSHOT = "PR5_REQUIRES_PR4_SNAPSHOT",
  PR4_NO_UPSTREAM_MUTATION = "PR4_NO_UPSTREAM_MUTATION",
  PR3_REALIZED_PAYMENT_REVENUE_ONLY = "PR3_REALIZED_PAYMENT_REVENUE_ONLY",
  PR3_NO_RECEIVABLE_ONLY_REVENUE = "PR3_NO_RECEIVABLE_ONLY_REVENUE",
  PR3_CONFIRMED_PAYMENT_STATUS_ONLY = "PR3_CONFIRMED_PAYMENT_STATUS_ONLY",
  PR3_NO_SIMPLE_AVERAGE_RETURN = "PR3_NO_SIMPLE_AVERAGE_RETURN",
  PR3_TIMELINE_FALLBACK_WARNING_PROPAGATED = "PR3_TIMELINE_FALLBACK_WARNING_PROPAGATED",
  PR2_TIMELINE_FULL_COVERAGE = "PR2_TIMELINE_FULL_COVERAGE",
  PR2_TIMELINE_FALLBACK_MARKED = "PR2_TIMELINE_FALLBACK_MARKED",
  PR1_STATE_DETERMINISTIC = "PR1_STATE_DETERMINISTIC"
}

export enum FleetOpsInvariantStatus {
  FAIL = "FAIL",
  PASS = "PASS"
}

export type FleetOpsLayerId = "pr1" | "pr2" | "pr3" | "pr4" | "pr5" | "pr6" | "pr7" | "pr8";

export interface FleetOpsTimelineCoverageInput {
  days: Array<{ date: string }>;
  from: Date;
  to: Date;
}

export interface FleetOpsInvariantInput {
  sourceFilesByLayer?: Partial<Record<FleetOpsLayerId, FleetOpsSourceFile[]>>;
  sourceTextByLayer?: Partial<Record<FleetOpsLayerId, string>>;
  timelineCoverage?: FleetOpsTimelineCoverageInput;
}

export interface FleetOpsSourceFile {
  content: string;
  path: string;
}

export interface FleetOpsInvariantResult {
  id: FleetOpsInvariantId;
  reason: string;
  status: FleetOpsInvariantStatus;
}

const REALIZED_PAYMENT_EVIDENCE_PATTERN = /PaymentStatus\.CONFIRMED|realized payments only/i;

const DEPOSIT_EXCLUSION_EVIDENCE_PATTERN = new RegExp(
  [
    String.raw`isDeposit\s*\(`,
    String.raw`deposit\s+(?:payments\s+are\s+)?(?:excluded|ignored|is\s+not\s+revenue|not\s+operating\s+revenue)`,
    String.raw`DepositLedger[\s\S]{0,120}(?:separate|handled\s+separately)`,
    String.raw`BillType\.DEPOSIT[\s\S]{0,200}ignoredRevenue`
  ].join("|"),
  "i"
);

const DEPOSIT_COUNTED_AS_REVENUE_PATTERN = new RegExp(
  [
    String.raw`isDeposit\s*\([^)]*\)\s*\)\s*\{[^}]{0,200}\b(?:revenue|leaseRevenue|penaltyRevenue)\s*(?:\+=|=)`,
    String.raw`(?:billType|bill\.type|payment\.billType)\s*={2,3}\s*(?:BillType\.DEPOSIT|["']DEPOSIT["'])\s*\)\s*\{[^}]{0,200}\b(?:revenue|leaseRevenue|penaltyRevenue)\s*(?:\+=|=)`
  ].join("|"),
  "i"
);

const RECEIVABLE_ONLY_REVENUE_PATTERN = new RegExp(
  [
    String.raw`\b(?:operatingRevenue|revenue|leaseRevenue|penaltyRevenue)\s*(?:\+=|=)[^;\n]{0,160}\b(?:receivableBill|bill)\.(?:amount|paidAmount)`,
    String.raw`\b(?:receivableBill|bill)\.(?:amount|paidAmount)[^;\n]{0,160}\b(?:operatingRevenue|revenue|leaseRevenue|penaltyRevenue)\s*(?:\+=|=)`
  ].join("|"),
  "i"
);

const NON_CONFIRMED_PAYMENT_REVENUE_PATTERN = new RegExp(
  [
    String.raw`PaymentStatus\.(?:PENDING_CONFIRM|CANCELLED)[\s\S]{0,200}\b(?:operatingRevenue|revenue|leaseRevenue|penaltyRevenue)\s*(?:\+=|=)`,
    String.raw`paymentStatus\s*!==\s*PaymentStatus\.CONFIRMED[\s\S]{0,200}\b(?:operatingRevenue|revenue|leaseRevenue|penaltyRevenue)\s*(?:\+=|=)`
  ].join("|"),
  "i"
);

const SIMPLE_AVERAGE_RETURN_PATTERN = new RegExp(
  [
    String.raw`(?:vehicles|rows)\.reduce[\s\S]{0,240}\.economics\.(?:roi|roe)[\s\S]{0,120}\/\s*(?:vehicles|rows)\.length`,
    String.raw`reduce\s*\([^)]*(?:roi|roe)[^)]*\)\s*\/\s*(?:vehicles|rows)\.length`,
    String.raw`(?:average|avg)[A-Za-z0-9_]*(?:Roi|ROI|Roe|ROE)`,
    String.raw`(?:roi|roe)[A-Za-z0-9_]*Average`
  ].join("|"),
  "i"
);

export function evaluateFleetOpsInvariants(input: FleetOpsInvariantInput = {}): FleetOpsInvariantResult[] {
  return [
    evaluateForbiddenSourcePattern(
      FleetOpsInvariantId.PR8_NO_ACTION_EXECUTION,
      sourceForLayer(input, "pr8"),
      /executeAction\s*\(|\.execute\s*\(/,
      "PR-8 coordination must not execute actions."
    ),
    evaluateForbiddenSourcePattern(
      FleetOpsInvariantId.PR7_NO_PR4_OVERRIDE,
      sourceForLayer(input, "pr7"),
      /overrideControlDecision|controlDecision\s*=\s*ControlDecision\.(ALLOW|WARN|BLOCK)/,
      "PR-7 governance must not override PR-4 control decisions."
    ),
    evaluateForbiddenSourcePattern(
      FleetOpsInvariantId.PR6_NO_PR5_EXECUTION,
      sourceForLayer(input, "pr6"),
      /FleetExecutionService|executeAction\s*\(|\.execute\s*\(/,
      "PR-6 optimization must not call PR-5 execution."
    ),
    evaluateRequiredSourcePattern(
      FleetOpsInvariantId.PR5_REQUIRES_PR4_SNAPSHOT,
      sourceForLayer(input, "pr5"),
      /riskSnapshot|PR-4|PR4/,
      "PR-5 execution must require a PR-4 risk snapshot."
    ),
    evaluateForbiddenSourcePattern(
      FleetOpsInvariantId.PR4_NO_UPSTREAM_MUTATION,
      sourceForLayer(input, "pr4"),
      /\binput\.[A-Za-z0-9_]+\s*=|upstream.*\.push\s*\(|upstream.*\.splice\s*\(/,
      "PR-4 risk must not mutate upstream PR outputs."
    ),
    evaluatePr3RevenueInvariant(sourceForLayer(input, "pr3")),
    evaluateReceivableOnlyRevenueInvariant(sourceForLayer(input, "pr3")),
    evaluateConfirmedPaymentOnlyInvariant(sourceForLayer(input, "pr3")),
    evaluateFleetReturnAggregationInvariant(sourceForLayer(input, "pr3")),
    evaluateEconomicsTimelineWarningInvariant(sourceForLayer(input, "pr3")),
    evaluateTimelineCoverage(input.timelineCoverage),
    evaluateTimelineFallbackMarked(input.sourceFilesByLayer?.pr2),
    evaluateForbiddenSourcePattern(
      FleetOpsInvariantId.PR1_STATE_DETERMINISTIC,
      sourceForLayer(input, "pr1"),
      /Math\.random|Date\.now|crypto\.randomUUID/,
      "PR-1 state resolution must remain deterministic for the same snapshot."
    )
  ];
}

function evaluateReceivableOnlyRevenueInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR3_NO_RECEIVABLE_ONLY_REVENUE;

  if (!sourceText) {
    return pass(id, "PR-3 economics must not count receivable bills as realized revenue. Source evidence was not provided, so the invariant is treated as contract-only.");
  }

  return RECEIVABLE_ONLY_REVENUE_PATTERN.test(sourceText)
    ? fail(id, "PR-3 economics must not count receivable bills as realized operating revenue.")
    : pass(id, "PR-3 economics keeps receivable bills in planned cashflow rather than realized revenue.");
}

function evaluateConfirmedPaymentOnlyInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR3_CONFIRMED_PAYMENT_STATUS_ONLY;

  if (!sourceText) {
    return pass(id, "PR-3 economics must only count confirmed payments as realized revenue. Source evidence was not provided, so the invariant is treated as contract-only.");
  }

  return NON_CONFIRMED_PAYMENT_REVENUE_PATTERN.test(sourceText)
    ? fail(id, "PR-3 economics must not count pending or cancelled payments as realized revenue.")
    : pass(id, "PR-3 economics excludes non-confirmed payments from realized revenue.");
}

function evaluateFleetReturnAggregationInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR3_NO_SIMPLE_AVERAGE_RETURN;

  if (!sourceText) {
    return pass(id, "PR-3 fleet ROI/ROE must be total-return based, not simple vehicle-ratio averages. Source evidence was not provided, so the invariant is treated as contract-only.");
  }

  return SIMPLE_AVERAGE_RETURN_PATTERN.test(sourceText)
    ? fail(id, "PR-3 fleet ROI/ROE must not use a simple average of vehicle ROI/ROE.")
    : pass(id, "PR-3 fleet ROI/ROE aggregation avoids simple vehicle-ratio averaging.");
}

function evaluateEconomicsTimelineWarningInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR3_TIMELINE_FALLBACK_WARNING_PROPAGATED;

  if (!sourceText) {
    return pass(id, "PR-3 economics must propagate PR-2 fallback warnings into economic warnings or confidence. Source evidence was not provided, so the invariant is treated as contract-only.");
  }

  const mapsTimeline = /toEconomicTimelineDay|EconomicTimelineDay|timeline/i.test(sourceText);
  const propagatesWarning = /CURRENT_STATUS_PROJECTED_ACROSS_RANGE|TIMELINE_CURRENT_STATUS_PROJECTED_WARNING|TIMELINE_FALLBACK_CONFIDENCE_PENALTY/.test(sourceText);

  return mapsTimeline && !propagatesWarning
    ? fail(id, "PR-3 economics must not drop PR-2 current-status projection warnings before confidence scoring.")
    : pass(id, "PR-3 economics preserves PR-2 fallback warning evidence.");
}

function sourceForLayer(input: FleetOpsInvariantInput, layer: FleetOpsLayerId) {
  const sourceText = input.sourceTextByLayer?.[layer] ?? "";
  const sourceFiles = input.sourceFilesByLayer?.[layer]?.map((file) => file.content).join("\n") ?? "";
  const combined = [sourceText, sourceFiles].filter(Boolean).join("\n");

  return combined.length > 0 ? combined : undefined;
}

function evaluateForbiddenSourcePattern(
  id: FleetOpsInvariantId,
  sourceText: string | undefined,
  forbiddenPattern: RegExp,
  reason: string
): FleetOpsInvariantResult {
  if (!sourceText) {
    return pass(id, `${reason} Source evidence was not provided, so the invariant is treated as contract-only.`);
  }

  return forbiddenPattern.test(sourceText) ? fail(id, reason) : pass(id, reason);
}

function evaluateRequiredSourcePattern(
  id: FleetOpsInvariantId,
  sourceText: string | undefined,
  requiredPattern: RegExp,
  reason: string
): FleetOpsInvariantResult {
  if (!sourceText) {
    return pass(id, `${reason} Source evidence was not provided, so the invariant is treated as contract-only.`);
  }

  return requiredPattern.test(sourceText) ? pass(id, reason) : fail(id, reason);
}

function evaluatePr3RevenueInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR3_REALIZED_PAYMENT_REVENUE_ONLY;

  if (!sourceText) {
    return pass(
      id,
      "PR-3 economics must recognize revenue from realized payments and exclude deposits. Source evidence was not provided, so the invariant is treated as contract-only."
    );
  }

  if (DEPOSIT_COUNTED_AS_REVENUE_PATTERN.test(sourceText)) {
    return fail(id, "PR-3 economics must not count deposits as operating revenue.");
  }

  if (!REALIZED_PAYMENT_EVIDENCE_PATTERN.test(sourceText)) {
    return fail(id, "PR-3 economics must recognize revenue only from realized payments.");
  }

  if (!DEPOSIT_EXCLUSION_EVIDENCE_PATTERN.test(sourceText)) {
    return fail(id, "PR-3 economics must explicitly exclude deposits from operating revenue.");
  }

  return pass(id, "PR-3 economics recognizes realized payment revenue and excludes deposits from operating revenue.");
}

function evaluateTimelineCoverage(coverage: FleetOpsTimelineCoverageInput | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR2_TIMELINE_FULL_COVERAGE;

  if (!coverage) {
    return pass(id, "PR-2 timeline coverage evidence was not provided, so the invariant is treated as contract-only.");
  }

  const actualDates = new Set(coverage.days.map((day) => day.date));
  const missingDates = enumerateUtcDates(coverage.from, coverage.to).filter((date) => !actualDates.has(date));

  if (missingDates.length > 0) {
    return fail(id, `PR-2 timeline is missing date(s): ${missingDates.join(", ")}.`);
  }

  return pass(id, "PR-2 timeline fully covers the requested date range.");
}

function evaluateTimelineFallbackMarked(files: FleetOpsSourceFile[] | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR2_TIMELINE_FALLBACK_MARKED;

  if (!files || files.length === 0) {
    return pass(id, "PR-2 fallback source evidence was not provided, so the invariant is treated as contract-only.");
  }

  const sourceText = files.map((file) => file.content).join("\n");
  const hasFallbackBuilder = /buildVehicleFallbackEvents|isFallback:\s*true/.test(sourceText);
  const hasProjectionWarning = /CURRENT_STATUS_PROJECTED_ACROSS_RANGE|TIMELINE_CURRENT_STATUS_PROJECTED_WARNING/.test(sourceText);

  if (hasFallbackBuilder && !hasProjectionWarning) {
    return fail(id, "PR-2 current Vehicle.status fallback must be marked as projected evidence.");
  }

  return pass(id, "PR-2 current Vehicle.status fallback is explicitly marked as projected evidence.");
}

function pass(id: FleetOpsInvariantId, reason: string): FleetOpsInvariantResult {
  return {
    id,
    reason,
    status: FleetOpsInvariantStatus.PASS
  };
}

function fail(id: FleetOpsInvariantId, reason: string): FleetOpsInvariantResult {
  return {
    id,
    reason,
    status: FleetOpsInvariantStatus.FAIL
  };
}

function enumerateUtcDates(from: Date, to: Date) {
  const dates: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));

  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}
