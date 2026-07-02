import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

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
      FleetOpsInvariantId.PR2_TIMELINE_FALLBACK_MARKED,
      FleetOpsInvariantId.PR1_STATE_DETERMINISTIC
    ]);
    expect(results.every((result) => result.status === FleetOpsInvariantStatus.PASS)).toBe(true);
  });

  it("enforces production invariants against real Fleet Ops source files", async () => {
    const results = evaluateFleetOpsInvariants({
      sourceFilesByLayer: {
        pr1: await readLayerFiles("vehicle-operational-state"),
        pr2: await readLayerFiles("timeline"),
        pr3: await readLayerFiles("economics"),
        pr4: await readLayerFiles("risk"),
        pr5: await readLayerFiles("execution"),
        pr6: await readLayerFiles("optimization"),
        pr7: await readLayerFiles("governance"),
        pr8: await readLayerFiles("coordination")
      },
      timelineCoverage: compliantInvariantInput().timelineCoverage
    });

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

  it("fails when PR-3 economics appears to count deposits as operating revenue", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr3: `
          function recognizeRevenue(payment) {
            if (payment.paymentStatus === PaymentStatus.CONFIRMED && payment.billType === BillType.DEPOSIT) {
              revenue += payment.amount;
            }
          }
        `
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR3_REALIZED_PAYMENT_REVENUE_ONLY]).toBe(FleetOpsInvariantStatus.FAIL);
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

  it("fails when real-source facts omit current-status fallback warning evidence", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceFilesByLayer: {
        pr2: [
          {
            content: "class VehicleTimelineBuilder { buildVehicleFallbackEvents() { return event({ warnings: [] }); } }",
            path: "vehicle-timeline.builder.ts"
          }
        ]
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR2_TIMELINE_FALLBACK_MARKED]).toBe(FleetOpsInvariantStatus.FAIL);
  });
});

function compliantInvariantInput(): FleetOpsInvariantInput {
  return {
    sourceTextByLayer: {
      pr1: "VehicleOperationalStateResolver resolve(snapshot) { return deterministicSignals.sort(); }",
      pr2: "VehicleTimelineCalculator calculateTimeline(events, rawInput) { return eachDay(from, to); }",
      pr3: "PaymentStatus.CONFIRMED realized payments only; isDeposit payments are excluded from operating revenue;",
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

async function readLayerFiles(layer: string) {
  const fleetOpsRoot = join(process.cwd(), "src", "fleet-ops");
  const root = layer === "vehicle-operational-state" ? fleetOpsRoot : join(fleetOpsRoot, layer);
  const files =
    layer === "vehicle-operational-state"
      ? (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && /^vehicle-operational-state\..*\.ts$/.test(entry.name))
          .map((entry) => join(root, entry.name))
      : await listTypescriptFiles(root);

  return Promise.all(
    files.map(async (file) => ({
      content: await readFile(file, "utf8"),
      path: relative(process.cwd(), file).replaceAll("\\", "/")
    }))
  );
}

async function listTypescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);

      if (entry.isDirectory()) {
        return listTypescriptFiles(fullPath);
      }

      return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
    })
  );

  return nested.flat().sort();
}

function statusById(results: ReturnType<typeof evaluateFleetOpsInvariants>) {
  return Object.fromEntries(results.map((result) => [result.id, result.status]));
}
