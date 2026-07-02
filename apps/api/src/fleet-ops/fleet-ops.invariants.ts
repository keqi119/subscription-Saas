export enum FleetOpsInvariantId {
  PR8_NO_ACTION_EXECUTION = "PR8_NO_ACTION_EXECUTION",
  PR7_NO_PR4_OVERRIDE = "PR7_NO_PR4_OVERRIDE",
  PR6_NO_PR5_EXECUTION = "PR6_NO_PR5_EXECUTION",
  PR5_REQUIRES_PR4_SNAPSHOT = "PR5_REQUIRES_PR4_SNAPSHOT",
  PR9_CONVERGENCE_PRESERVES_ECONOMICS = "PR9_CONVERGENCE_PRESERVES_ECONOMICS",
  PR9_CONVERGENCE_PRESERVES_RISK = "PR9_CONVERGENCE_PRESERVES_RISK",
  PR9_CONVERGENCE_AGGREGATION_ONLY = "PR9_CONVERGENCE_AGGREGATION_ONLY",
  PR9_FACADE_NO_EXECUTION_ACTIONS = "PR9_FACADE_NO_EXECUTION_ACTIONS",
  PR4_NO_UPSTREAM_MUTATION = "PR4_NO_UPSTREAM_MUTATION",
  PR4_REFRESH_INDEPENDENT_OVERDUE = "PR4_REFRESH_INDEPENDENT_OVERDUE",
  PR4_CANCELLED_AND_SETTLED_EXCLUDED = "PR4_CANCELLED_AND_SETTLED_EXCLUDED",
  PR4_D1_D5_THRESHOLDS = "PR4_D1_D5_THRESHOLDS",
  PR4_COLLECTION_CASE_SUPPORTING_ONLY = "PR4_COLLECTION_CASE_SUPPORTING_ONLY",
  PR4_AGING_BUCKET_NOT_RISK_ESCALATION = "PR4_AGING_BUCKET_NOT_RISK_ESCALATION",
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

export type FleetOpsLayerId = "pr1" | "pr2" | "pr3" | "pr4" | "pr5" | "pr6" | "pr7" | "pr8" | "pr9";

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
    evaluatePr9EconomicsParityInvariant(sourceForLayer(input, "pr9")),
    evaluatePr9RiskParityInvariant(sourceForLayer(input, "pr9")),
    evaluatePr9AggregationOnlyInvariant(sourceForLayer(input, "pr9")),
    evaluateForbiddenSourcePattern(
      FleetOpsInvariantId.PR9_FACADE_NO_EXECUTION_ACTIONS,
      sourceForLayer(input, "pr9"),
      /executeAction\s*\(|FleetExecutionService|executionService\.execute|action\.execute\s*\(/,
      "PR-9 convergence facade must not call PR-5 execution actions."
    ),
    evaluateForbiddenSourcePattern(
      FleetOpsInvariantId.PR4_NO_UPSTREAM_MUTATION,
      sourceForLayer(input, "pr4"),
      /\binput\.[A-Za-z0-9_]+\s*=|upstream.*\.push\s*\(|upstream.*\.splice\s*\(/,
      "PR-4 risk must not mutate upstream PR outputs."
    ),
    evaluatePr4RefreshIndependentOverdueInvariant(sourceForLayer(input, "pr4")),
    evaluatePr4CancelledAndSettledExclusionInvariant(sourceForLayer(input, "pr4")),
    evaluatePr4D1D5ThresholdInvariant(sourceForLayer(input, "pr4")),
    evaluatePr4CollectionCaseSupportingInvariant(sourceForLayer(input, "pr4")),
    evaluatePr4AgingBucketInvariant(sourceForLayer(input, "pr4")),
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

function evaluatePr9EconomicsParityInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR9_CONVERGENCE_PRESERVES_ECONOMICS;

  if (!sourceText) {
    return pass(id, "PR-9 convergence must preserve PR-3 economics cashflow, warnings, denominator evidence, and attribution details. Source evidence was not provided, so the invariant is treated as contract-only.");
  }

  const requiredPatterns = [/cashflow/, /denominatorEvidence/, /warnings/, /attribution/, /reportParity/];

  return requiredPatterns.every((pattern) => pattern.test(sourceText))
    ? pass(id, "PR-9 convergence preserves PR-3 economics detail fields.")
    : fail(id, "PR-9 convergence must not drop PR-3 economics cashflow, warnings, denominator evidence, attribution, or report parity fields.");
}

function evaluatePr9RiskParityInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR9_CONVERGENCE_PRESERVES_RISK;

  if (!sourceText) {
    return pass(id, "PR-9 convergence must preserve PR-4 risk exposure, aging bucket, arrears pipeline, warnings, and evidence. Source evidence was not provided, so the invariant is treated as contract-only.");
  }

  const requiredPatterns = [/exposureDetail/, /agingBucket/, /arrearsPipeline/, /warnings/, /evidence/];

  return requiredPatterns.every((pattern) => pattern.test(sourceText))
    ? pass(id, "PR-9 convergence preserves PR-4 risk detail fields.")
    : fail(id, "PR-9 convergence must not drop PR-4 exposure detail, aging bucket, arrears pipeline, warnings, or evidence.");
}

function evaluatePr9AggregationOnlyInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR9_CONVERGENCE_AGGREGATION_ONLY;

  if (!sourceText) {
    return pass(id, "PR-9 convergence must aggregate existing PR outputs without recomputing PR-3 or PR-4 logic. Source evidence was not provided, so the invariant is treated as contract-only.");
  }

  const recomputesBusinessLogic = /new\s+(?:CashflowModel|OverdueDetectorModel|CollectionPriorityModel|RiskScoreModel)|\b(?:roi|roe)\s*=\s*[^;\n]+\/|detectOverdue\s*\(|calculateVehicleRisk\s*\(|assignByOverdueDays\s*\(/i.test(sourceText);

  return recomputesBusinessLogic
    ? fail(id, "PR-9 convergence must not recompute PR-3 economics or PR-4 risk formulas.")
    : pass(id, "PR-9 convergence remains aggregation-only over existing PR outputs.");
}

function evaluatePr4RefreshIndependentOverdueInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR4_REFRESH_INDEPENDENT_OVERDUE;

  if (!sourceText) {
    return pass(id, "PR-4 overdue detection must use dueDate, remainingAmount, and cancellation status. Source evidence was not provided, so the invariant is treated as contract-only.");
  }

  const hasDueDateFact = /dueDate[\s\S]{0,120}(?:<|>=)[\s\S]{0,120}asOf|asOf[\s\S]{0,120}(?:>|<=)[\s\S]{0,120}dueDate/i.test(sourceText);
  const hasRemainingFact = /remainingAmount\s*(?:>|<=)\s*0/.test(sourceText);
  const excludesCancelled = /BillStatus\.CANCELLED/.test(sourceText);
  const onlyOverdueStatus = /billStatus\s*={2,3}\s*BillStatus\.OVERDUE/.test(sourceText) && !(hasDueDateFact && hasRemainingFact);

  return hasDueDateFact && hasRemainingFact && excludesCancelled && !onlyOverdueStatus
    ? pass(id, "PR-4 overdue facts are refresh-independent and do not require BillStatus.OVERDUE.")
    : fail(id, "PR-4 overdue detection must not rely only on refreshed BillStatus.OVERDUE.");
}

function evaluatePr4CancelledAndSettledExclusionInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR4_CANCELLED_AND_SETTLED_EXCLUDED;

  if (!sourceText) {
    return pass(id, "PR-4 exposure must exclude cancelled, paid, and zero-remaining bills. Source evidence was not provided, so the invariant is treated as contract-only.");
  }

  const excludesCancelled = /BillStatus\.CANCELLED/.test(sourceText);
  const excludesPaid = /BillStatus\.PAID/.test(sourceText);
  const excludesZeroRemaining = /remainingAmount\s*<=\s*0|remainingAmount\s*>\s*0/.test(sourceText);

  return excludesCancelled && excludesPaid && excludesZeroRemaining
    ? pass(id, "PR-4 exposure excludes cancelled, paid, and zero-remaining bills.")
    : fail(id, "PR-4 exposure must exclude cancelled, fully paid, and zero-remaining bills.");
}

function evaluatePr4D1D5ThresholdInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR4_D1_D5_THRESHOLDS;

  if (!sourceText) {
    return pass(id, "PR-4 D1-D5 threshold source evidence was not provided, so the invariant is treated as contract-only.");
  }

  const hasThresholds = [/<=\s*3/, /<=\s*7/, /<=\s*15/, /<=\s*30/, /CollectionPriorityLevel\.D5/].every((pattern) => pattern.test(sourceText));

  return hasThresholds
    ? pass(id, "PR-4 D1-D5 aging thresholds match 1-3, 4-7, 8-15, 16-30, and >30 days.")
    : fail(id, "PR-4 D1-D5 aging thresholds must match 1-3, 4-7, 8-15, 16-30, and >30 days.");
}

function evaluatePr4CollectionCaseSupportingInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR4_COLLECTION_CASE_SUPPORTING_ONLY;

  if (!sourceText) {
    return pass(id, "PR-4 collection case source evidence was not provided, so the invariant is treated as contract-only.");
  }

  const suppressesBillFacts = /caseStatus\s*={2,3}\s*CollectionCaseStatus\.CLOSED[\s\S]{0,180}return\s*(?:\[\]|0|null|undefined)/.test(sourceText);
  const hasSupportingEvidence = /supporting evidence only|CLOSED_COLLECTION_CASE_WITH_OPEN_OVERDUE_BILL|receivable bill remains the source of overdue truth/i.test(sourceText);

  return !suppressesBillFacts && hasSupportingEvidence
    ? pass(id, "PR-4 treats CollectionCase and CollectionAction as supporting evidence only.")
    : fail(id, "PR-4 CollectionCase status must not suppress open bill-level overdue facts.");
}

function evaluatePr4AgingBucketInvariant(sourceText: string | undefined): FleetOpsInvariantResult {
  const id = FleetOpsInvariantId.PR4_AGING_BUCKET_NOT_RISK_ESCALATION;

  if (!sourceText) {
    return pass(id, "PR-4 aging bucket source evidence was not provided, so the invariant is treated as contract-only.");
  }

  const scoreEscalatesBucket = /(?:riskScore|exposureScore)\s*(?:>=|>|<=|<)[\s\S]{0,160}CollectionPriorityLevel\.D[1-5]/.test(sourceText);

  return scoreEscalatesBucket
    ? fail(id, "PR-4 risk score escalation must not mutate D1-D5 aging bucket.")
    : pass(id, "PR-4 keeps aging bucket separate from risk score escalation.");
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
