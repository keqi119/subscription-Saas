import { describe, expect, it } from "vitest";

import {
  evaluateFleetOpsInvariants,
  FleetOpsInvariantId,
  FleetOpsInvariantStatus,
  type FleetOpsInvariantInput
} from "../src/fleet-ops/fleet-ops.invariants";

describe("Fleet Ops production invariants", () => {
  it("passes the production hardening invariants for compliant layer sources and complete timeline coverage", () => {
    const results = evaluateFleetOpsInvariants(compliantInvariantInput());

    expect(results.map((result) => result.id)).toEqual([
      FleetOpsInvariantId.PR8_NO_ACTION_EXECUTION,
      FleetOpsInvariantId.PR7_NO_PR4_OVERRIDE,
      FleetOpsInvariantId.PR6_NO_PR5_EXECUTION,
      FleetOpsInvariantId.PR5_REQUIRES_PR4_SNAPSHOT,
      FleetOpsInvariantId.PR4_NO_UPSTREAM_MUTATION,
      FleetOpsInvariantId.PR3_REALIZED_PAYMENT_REVENUE_ONLY,
      FleetOpsInvariantId.PR2_TIMELINE_FULL_COVERAGE,
      FleetOpsInvariantId.PR1_STATE_DETERMINISTIC
    ]);
    expect(results.every((result) => result.status === FleetOpsInvariantStatus.PASS)).toBe(true);
  });

  it("fails when advisory layers attempt to execute or override control decisions", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr6: "class Optimization { executeAction() { return this.executionService.executeAction(); } }",
        pr7: "class Governance { overrideControlDecision = ControlDecision.ALLOW; }",
        pr8: "class Coordinator { executeAction() { return action.execute(); } }"
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR8_NO_ACTION_EXECUTION]).toBe(FleetOpsInvariantStatus.FAIL);
    expect(statusById(results)[FleetOpsInvariantId.PR7_NO_PR4_OVERRIDE]).toBe(FleetOpsInvariantStatus.FAIL);
    expect(statusById(results)[FleetOpsInvariantId.PR6_NO_PR5_EXECUTION]).toBe(FleetOpsInvariantStatus.FAIL);
  });

  it("fails when PR-2 timeline output does not cover every day in the requested date range", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      timelineCoverage: {
        days: [{ date: "2026-07-01" }, { date: "2026-07-03" }],
        from: new Date("2026-07-01T00:00:00.000Z"),
        to: new Date("2026-07-03T00:00:00.000Z")
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR2_TIMELINE_FULL_COVERAGE]).toBe(FleetOpsInvariantStatus.FAIL);
  });
});

function compliantInvariantInput(): FleetOpsInvariantInput {
  return {
    sourceTextByLayer: {
      pr1: "VehicleOperationalStateResolver resolve(snapshot) { return deterministicSignals.sort(); }",
      pr2: "VehicleTimelineCalculator calculateTimeline(events, rawInput) { return eachDay(from, to); }",
      pr3: "PaymentStatus.CONFIRMED realized payments only; ReceivableBill is not revenue;",
      pr4: "FleetRiskCalculator calculate(input) { return cloneRiskOutput(input); }",
      pr5: "ActionOrchestrator execute(request, riskSnapshot) { if (!riskSnapshot) throw new Error(); }",
      pr6: "OptimizationEngine optimize(input) { return advisoryRecommendations; }",
      pr7: "PolicyEngine evaluate(input) { return proposed policy updates only; }",
      pr8: "CoordinationEngine synthesize(outputs) { return advisory consensus; }"
    },
    timelineCoverage: {
      days: [{ date: "2026-07-01" }, { date: "2026-07-02" }, { date: "2026-07-03" }],
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-03T00:00:00.000Z")
    }
  };
}

function statusById(results: ReturnType<typeof evaluateFleetOpsInvariants>) {
  return Object.fromEntries(results.map((result) => [result.id, result.status]));
}
