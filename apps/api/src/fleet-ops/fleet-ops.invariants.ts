export enum FleetOpsInvariantId {
  PR8_NO_ACTION_EXECUTION = "PR8_NO_ACTION_EXECUTION",
  PR7_NO_PR4_OVERRIDE = "PR7_NO_PR4_OVERRIDE",
  PR6_NO_PR5_EXECUTION = "PR6_NO_PR5_EXECUTION",
  PR5_REQUIRES_PR4_SNAPSHOT = "PR5_REQUIRES_PR4_SNAPSHOT",
  PR4_NO_UPSTREAM_MUTATION = "PR4_NO_UPSTREAM_MUTATION",
  PR3_REALIZED_PAYMENT_REVENUE_ONLY = "PR3_REALIZED_PAYMENT_REVENUE_ONLY",
  PR2_TIMELINE_FULL_COVERAGE = "PR2_TIMELINE_FULL_COVERAGE",
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
  sourceTextByLayer?: Partial<Record<FleetOpsLayerId, string>>;
  timelineCoverage?: FleetOpsTimelineCoverageInput;
}

export interface FleetOpsInvariantResult {
  id: FleetOpsInvariantId;
  reason: string;
  status: FleetOpsInvariantStatus;
}

export function evaluateFleetOpsInvariants(input: FleetOpsInvariantInput = {}): FleetOpsInvariantResult[] {
  return [
    evaluateForbiddenSourcePattern(
      FleetOpsInvariantId.PR8_NO_ACTION_EXECUTION,
      input.sourceTextByLayer?.pr8,
      /executeAction\s*\(|\.execute\s*\(/,
      "PR-8 coordination must not execute actions."
    ),
    evaluateForbiddenSourcePattern(
      FleetOpsInvariantId.PR7_NO_PR4_OVERRIDE,
      input.sourceTextByLayer?.pr7,
      /overrideControlDecision|controlDecision\s*=|ControlDecision\.(ALLOW|WARN|BLOCK)/,
      "PR-7 governance must not override PR-4 control decisions."
    ),
    evaluateForbiddenSourcePattern(
      FleetOpsInvariantId.PR6_NO_PR5_EXECUTION,
      input.sourceTextByLayer?.pr6,
      /FleetExecutionService|executeAction\s*\(|\.execute\s*\(/,
      "PR-6 optimization must not call PR-5 execution."
    ),
    evaluateRequiredSourcePattern(
      FleetOpsInvariantId.PR5_REQUIRES_PR4_SNAPSHOT,
      input.sourceTextByLayer?.pr5,
      /riskSnapshot|PR-4|PR4/,
      "PR-5 execution must require a PR-4 risk snapshot."
    ),
    evaluateForbiddenSourcePattern(
      FleetOpsInvariantId.PR4_NO_UPSTREAM_MUTATION,
      input.sourceTextByLayer?.pr4,
      /\binput\.[A-Za-z0-9_]+\s*=|upstream.*\.push\s*\(|upstream.*\.splice\s*\(/,
      "PR-4 risk must not mutate upstream PR outputs."
    ),
    evaluateRequiredSourcePattern(
      FleetOpsInvariantId.PR3_REALIZED_PAYMENT_REVENUE_ONLY,
      input.sourceTextByLayer?.pr3,
      /PaymentStatus\.CONFIRMED|realized payments only/i,
      "PR-3 economics must recognize revenue only from realized payments."
    ),
    evaluateTimelineCoverage(input.timelineCoverage),
    evaluateForbiddenSourcePattern(
      FleetOpsInvariantId.PR1_STATE_DETERMINISTIC,
      input.sourceTextByLayer?.pr1,
      /Math\.random|Date\.now|crypto\.randomUUID/,
      "PR-1 state resolution must remain deterministic for the same snapshot."
    )
  ];
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
