import { describe, expect, it } from "vitest";

import { FleetOpsHealthService } from "../src/fleet-ops/fleet-ops.health.service";
import type { FleetOpsHealthContract } from "../src/fleet-ops/fleet-ops.contracts";

describe("FleetOpsHealthService readiness contract", () => {
  it("returns every Fleet Ops engine status with the release-safe status enum", () => {
    const health = new FleetOpsHealthService().getHealth();
    const typedHealth: FleetOpsHealthContract = health;
    const allowedStatuses = new Set(["OK", "WARN", "ERROR"]);

    expect(Object.keys(health).sort()).toEqual([
      "coordinationEngine",
      "economicsEngine",
      "executionEngine",
      "governanceEngine",
      "optimizationEngine",
      "riskEngine",
      "stateEngine",
      "timelineEngine"
    ]);
    expect(Object.values(health).every((status) => allowedStatuses.has(status))).toBe(true);
    expect(typedHealth).toBe(health);
  });
});
