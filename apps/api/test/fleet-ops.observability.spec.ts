import { describe, expect, it } from "vitest";

import { buildFleetOpsDiagnostics } from "../src/fleet-ops/fleet-ops.diagnostics";
import { FleetOpsInvariantId, FleetOpsInvariantStatus, type FleetOpsInvariantResult } from "../src/fleet-ops/fleet-ops.invariants";
import { createFleetOpsObservation } from "../src/fleet-ops/fleet-ops.observability";

describe("Fleet Ops observability readiness", () => {
  it("creates deterministic structured observation events without external telemetry dependencies", () => {
    const warnings = ["Timeline confidence below release threshold."];
    const event = createFleetOpsObservation({
      durationMs: 42.7,
      engineName: "timelineEngine",
      operationName: "getVehicleTimeline",
      requestId: "request-1",
      status: "WARN",
      traceId: "trace-1",
      warnings
    });

    warnings.push("mutated after event creation");

    expect(event).toEqual({
      durationMs: 43,
      engineName: "timelineEngine",
      operationName: "getVehicleTimeline",
      requestId: "request-1",
      status: "WARN",
      traceId: "trace-1",
      warnings: ["Timeline confidence below release threshold."]
    });
  });

  it("summarizes release diagnostics from module readiness, invariants, readonly scan, and known issues", () => {
    const diagnostics = buildFleetOpsDiagnostics({
      facadeReady: true,
      healthReady: true,
      invariantResults: [
        invariant(FleetOpsInvariantId.PR8_NO_ACTION_EXECUTION, FleetOpsInvariantStatus.PASS),
        invariant(FleetOpsInvariantId.PR2_TIMELINE_FULL_COVERAGE, FleetOpsInvariantStatus.PASS)
      ],
      knownIssues: ["Existing baseline failure: order-delivery.spec.ts / canPrepareDelivery."],
      moduleLoaded: true,
      readonlyViolations: []
    });

    expect(diagnostics).toEqual({
      facadeReady: true,
      healthReady: true,
      invariantStatus: "PASS",
      knownIssues: ["Existing baseline failure: order-delivery.spec.ts / canPrepareDelivery."],
      moduleLoaded: true,
      readonlyStatus: "PASS"
    });
  });
});

function invariant(id: FleetOpsInvariantId, status: FleetOpsInvariantStatus): FleetOpsInvariantResult {
  return {
    id,
    reason: `${id} ${status}`,
    status
  };
}
