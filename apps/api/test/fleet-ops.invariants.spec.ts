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
      FleetOpsInvariantId.PR9_CONVERGENCE_PRESERVES_ECONOMICS,
      FleetOpsInvariantId.PR9_CONVERGENCE_PRESERVES_RISK,
      FleetOpsInvariantId.PR9_CONVERGENCE_AGGREGATION_ONLY,
      FleetOpsInvariantId.PR9_FACADE_NO_EXECUTION_ACTIONS,
      FleetOpsInvariantId.PR4_NO_UPSTREAM_MUTATION,
      FleetOpsInvariantId.PR4_REFRESH_INDEPENDENT_OVERDUE,
      FleetOpsInvariantId.PR4_CANCELLED_AND_SETTLED_EXCLUDED,
      FleetOpsInvariantId.PR4_D1_D5_THRESHOLDS,
      FleetOpsInvariantId.PR4_COLLECTION_CASE_SUPPORTING_ONLY,
      FleetOpsInvariantId.PR4_AGING_BUCKET_NOT_RISK_ESCALATION,
      FleetOpsInvariantId.PR3_REALIZED_PAYMENT_REVENUE_ONLY,
      FleetOpsInvariantId.PR3_NO_RECEIVABLE_ONLY_REVENUE,
      FleetOpsInvariantId.PR3_CONFIRMED_PAYMENT_STATUS_ONLY,
      FleetOpsInvariantId.PR3_NO_SIMPLE_AVERAGE_RETURN,
      FleetOpsInvariantId.PR3_TIMELINE_FALLBACK_WARNING_PROPAGATED,
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
        pr8: await readLayerFiles("coordination"),
        pr9: await readLayerFiles("facade")
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

  it("fails when convergence drops economics cashflow or warnings", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr9: "function economicsSnapshot(economics) { return { revenue: economics.economics.revenue, roi: economics.economics.roi }; }"
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR9_CONVERGENCE_PRESERVES_ECONOMICS]).toBe(FleetOpsInvariantStatus.FAIL);
  });

  it("fails when convergence drops risk exposure or arrears pipeline", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr9: "function riskSnapshot(risk) { return { level: risk.collectionLevel, score: risk.riskScore, signals: risk.signals }; }"
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR9_CONVERGENCE_PRESERVES_RISK]).toBe(FleetOpsInvariantStatus.FAIL);
  });

  it("fails when convergence recomputes economics or risk formulas", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr9: "function buildSnapshot(input) { const roi = input.netIncome / input.investedCapital; const overdue = detectOverdue(input.bills); return { roi, overdue }; }"
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR9_CONVERGENCE_AGGREGATION_ONLY]).toBe(FleetOpsInvariantStatus.FAIL);
  });

  it("fails when facade calls execution actions", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr9: "class FleetOpsFacade { query() { return this.executionService.executeAction(); } }"
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR9_FACADE_NO_EXECUTION_ACTIONS]).toBe(FleetOpsInvariantStatus.FAIL);
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

  it("fails when PR-4 overdue detection relies only on refreshed BillStatus.OVERDUE", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr4: `
          function detect(bill) {
            return bill.billStatus === BillStatus.OVERDUE;
          }
        `
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR4_REFRESH_INDEPENDENT_OVERDUE]).toBe(FleetOpsInvariantStatus.FAIL);
  });

  it("fails when PR-4 lets cancelled or settled bills contribute exposure", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr4: `
          function exposure(bill) {
            overdueAmount += bill.remainingAmount;
            return overdueAmount;
          }
        `
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR4_CANCELLED_AND_SETTLED_EXCLUDED]).toBe(FleetOpsInvariantStatus.FAIL);
  });

  it("fails when PR-4 D1-D5 aging thresholds drift", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr4: `
          function level(days) {
            if (days >= 30) return CollectionPriorityLevel.D5;
            if (days >= 15) return CollectionPriorityLevel.D4;
            return CollectionPriorityLevel.D3;
          }
        `
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR4_D1_D5_THRESHOLDS]).toBe(FleetOpsInvariantStatus.FAIL);
  });

  it("fails when PR-4 collection case status suppresses unpaid bill facts", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr4: `
          function detect(caseRecord, bill) {
            if (caseRecord.caseStatus === CollectionCaseStatus.CLOSED) return [];
            return bill.remainingAmount > 0 ? [bill] : [];
          }
        `
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR4_COLLECTION_CASE_SUPPORTING_ONLY]).toBe(FleetOpsInvariantStatus.FAIL);
  });

  it("fails when PR-4 risk score escalation mutates the aging bucket", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr4: `
          function assign(exposure, riskScore) {
            if (riskScore >= 85) return CollectionPriorityLevel.D5;
            if (exposure.maxOverdueDays <= 3) return CollectionPriorityLevel.D1;
          }
        `
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR4_AGING_BUCKET_NOT_RISK_ESCALATION]).toBe(FleetOpsInvariantStatus.FAIL);
  });

  it("fails when PR-3 economics appears to count receivable bills as realized revenue", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr3: `
          function calculateRevenue(receivableBill) {
            operatingRevenue += receivableBill.amount;
            return operatingRevenue;
          }
        `
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR3_NO_RECEIVABLE_ONLY_REVENUE]).toBe(FleetOpsInvariantStatus.FAIL);
  });

  it("fails when PR-3 economics appears to count non-confirmed payments as realized revenue", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr3: `
          function recognize(payment) {
            if (payment.paymentStatus === PaymentStatus.PENDING_CONFIRM) {
              leaseRevenue += payment.amount;
            }
          }
        `
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR3_CONFIRMED_PAYMENT_STATUS_ONLY]).toBe(FleetOpsInvariantStatus.FAIL);
  });

  it("fails when PR-3 fleet return aggregation uses a simple average of vehicle ROI", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr3: `
          function aggregateFleetKpi(vehicles) {
            return vehicles.reduce((total, vehicle) => total + vehicle.economics.roi, 0) / vehicles.length;
          }
        `
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR3_NO_SIMPLE_AVERAGE_RETURN]).toBe(FleetOpsInvariantStatus.FAIL);
  });

  it("fails when PR-3 economics drops PR-2 timeline fallback warnings before confidence scoring", () => {
    const results = evaluateFleetOpsInvariants({
      ...compliantInvariantInput(),
      sourceTextByLayer: {
        ...compliantInvariantInput().sourceTextByLayer,
        pr3: `
          function toEconomicTimelineDay(day) {
            return { confidence: day.confidence, date: day.date, state: day.state };
          }
        `
      }
    });

    expect(statusById(results)[FleetOpsInvariantId.PR3_TIMELINE_FALLBACK_WARNING_PROPAGATED]).toBe(FleetOpsInvariantStatus.FAIL);
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
      pr3:
        "PaymentStatus.CONFIRMED realized payments only; isDeposit payments are excluded from operating revenue; fleet ROI = total net income / total invested capital; CURRENT_STATUS_PROJECTED_ACROSS_RANGE warning propagates into economics confidence;",
      pr4:
        "OverdueDetectorModel uses dueDate < asOfDate and remainingAmount > 0 while excluding BillStatus.CANCELLED and BillStatus.PAID; D1 <= 3, D2 <= 7, D3 <= 15, D4 <= 30, CollectionPriorityLevel.D5 otherwise; CollectionCase is supporting evidence only; aging bucket ignores riskScore escalation;",
      pr5: "ActionOrchestrator execute(request, riskSnapshot) { if (!riskSnapshot) throw new Error(); }",
      pr6: "OptimizationEngine optimize(input) { return advisoryRecommendations; }",
      pr7: "PolicyEngine evaluate(input) { return proposed policy updates only; }",
      pr8: "CoordinationEngine synthesize(outputs) { return advisory consensus; }",
      pr9:
        "buildFleetOpsSnapshot forwards economics.cashflow, economics.denominatorEvidence, economics.warnings, economics.attribution, economics.reportParity, risk.exposureDetail, risk.agingBucket, risk.arrearsPipeline, risk.warnings, risk.evidence, and has no PR-5 execution action calls; convergence aggregation-only no formula recomputation;"
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
