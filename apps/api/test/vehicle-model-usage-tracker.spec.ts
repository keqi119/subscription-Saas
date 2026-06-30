import { describe, expect, it } from "vitest";

import {
  VehicleModelUsageTracker,
  calculateVehicleModelRemovalReadiness
} from "../src/common/vehicle-model-usage-tracker";

describe("VehicleModelUsageTracker", () => {
  it("counts enum, fallback, business decision, and external usage events", () => {
    const tracker = new VehicleModelUsageTracker();

    tracker.record({
      decisionPath: "LEGACY_ENUM",
      legacyVehicleModelCode: "ET5",
      module: "product",
      operation: "quote.priceRule.resolve",
      riskLevel: "HIGH",
      usageKind: "BUSINESS_DECISION"
    });
    tracker.record({
      decisionPath: "LEGACY_ENUM",
      legacyVehicleModelCode: "ET5",
      module: "report",
      operation: "orders.filter",
      riskLevel: "MEDIUM",
      usageKind: "FALLBACK"
    });
    tracker.record({
      decisionPath: "LEGACY_ENUM",
      legacyVehicleModelCode: "ET5",
      module: "csv",
      operation: "orders.export",
      riskLevel: "LOW",
      usageKind: "EXTERNAL_CONTRACT"
    });

    expect(tracker.report()).toMatchObject({
      businessDecisionUsageCount: 1,
      decision: "NOT_READY",
      enumUsageCount: 3,
      externalUsageCount: 1,
      fallbackUsageCount: 1
    });
  });

  it("scores display-only enum usage as low risk but not blocking", () => {
    const report = calculateVehicleModelRemovalReadiness([
      {
        decisionPath: "LEGACY_ENUM",
        legacyVehicleModelCode: "ET5",
        module: "quote",
        operation: "display",
        riskLevel: "LOW",
        usageKind: "DISPLAY"
      }
    ]);

    expect(report).toMatchObject({
      businessDecisionUsageCount: 0,
      decision: "READY",
      enumUsageCount: 1,
      externalUsageCount: 0,
      fallbackUsageCount: 0
    });
    expect(report.readinessScore).toBeGreaterThanOrEqual(90);
  });

  it("counts external deprecation warnings without marking them as business decisions", () => {
    const tracker = new VehicleModelUsageTracker();

    tracker.record({
      decisionPath: "LEGACY_ENUM",
      legacyVehicleModelCode: "ET5",
      metadata: {
        consumerId: "report-api-vehicle-model-filter",
        field: "vehicleModel",
        replacement: "modelDefinitionId",
        surface: "REPORT_FILTER"
      },
      module: "report",
      operation: "DEPRECATED_VEHICLE_MODEL_FILTER",
      riskLevel: "MEDIUM",
      usageKind: "EXTERNAL_CONTRACT_DEPRECATION_WARNING"
    });

    expect(tracker.report()).toMatchObject({
      businessDecisionUsageCount: 0,
      decision: "NOT_READY",
      enumUsageCount: 1,
      externalUsageCount: 1,
      fallbackUsageCount: 0,
      riskClassification: "MEDIUM"
    });
  });

  it("keeps an immutable copy of recorded events in the report", () => {
    const tracker = new VehicleModelUsageTracker();
    tracker.record({
      decisionPath: "MODEL_DEFINITION_ID",
      modelDefinitionId: "model-et5",
      module: "product",
      operation: "priceRule.lookup",
      riskLevel: "LOW",
      usageKind: "BUSINESS_DECISION"
    });

    const report = tracker.report();
    report.events.length = 0;

    expect(tracker.report().events).toHaveLength(1);
  });
});
