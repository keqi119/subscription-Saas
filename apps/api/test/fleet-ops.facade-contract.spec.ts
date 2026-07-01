import { describe, expect, it, vi } from "vitest";

import { CoordinationIntent } from "../src/fleet-ops/coordination/agent.types";
import { FleetOpsFacade } from "../src/fleet-ops/fleet-ops.facade";
import { CollectionPriorityLevel, ControlDecision } from "../src/fleet-ops/risk/risk.types";
import { TimelineState } from "../src/fleet-ops/timeline/vehicle-timeline.types";
import { VehicleComputedOperationalState, VehicleOperationalConfidenceBand } from "../src/fleet-ops/vehicle-operational-state.types";

describe("FleetOpsFacade contract readiness", () => {
  it("exposes the stable release facade method surface", () => {
    const facade = createFacade();

    expect(Object.getOwnPropertyNames(FleetOpsFacade.prototype).filter((name) => name !== "constructor").sort()).toEqual([
      "coordinateFleetDecision",
      "getFleetGovernanceReport",
      "getVehicleKpi",
      "getVehicleOptimization",
      "getVehicleRisk",
      "getVehicleState",
      "getVehicleTimeline"
    ]);
    expect(facade.getVehicleState).toBeTypeOf("function");
    expect(facade.coordinateFleetDecision).toBeTypeOf("function");
  });

  it("returns API-safe contract shapes without requiring a real database", async () => {
    const facade = createFacade();
    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-07-03T00:00:00.000Z");

    await expect(facade.getVehicleState("vehicle-1")).resolves.toEqual(
      expect.objectContaining({
        computedState: VehicleComputedOperationalState.AVAILABLE,
        confidenceBand: VehicleOperationalConfidenceBand.HIGH,
        confidenceScore: expect.any(Number),
        vehicleId: "vehicle-1"
      })
    );
    await expect(facade.getVehicleTimeline("vehicle-1", from, to)).resolves.toEqual([
      expect.objectContaining({
        confidence: expect.any(Number),
        date: "2026-07-01",
        sourceEvents: expect.any(Array),
        state: TimelineState.AVAILABLE
      })
    ]);
    await expect(facade.getVehicleKpi("vehicle-1", { from, to })).resolves.toEqual(
      expect.objectContaining({
        economics: expect.objectContaining({ revenue: expect.any(Number), roi: expect.any(Number) }),
        utilization: expect.objectContaining({ utilizationRate: expect.any(Number) }),
        vehicleId: "vehicle-1"
      })
    );
    await expect(facade.getVehicleRisk("vehicle-1", { from, to })).resolves.toEqual(
      expect.objectContaining({
        collectionLevel: CollectionPriorityLevel.D1,
        controlDecision: ControlDecision.ALLOW,
        vehicleId: "vehicle-1"
      })
    );
    await expect(facade.getVehicleOptimization("vehicle-1", { from, to })).resolves.toEqual(
      expect.objectContaining({
        optimizationSuggestions: expect.any(Array),
        strategyRecommendation: expect.any(String),
        vehicleId: "vehicle-1"
      })
    );
    await expect(facade.getFleetGovernanceReport({ from, to, vehicleIds: ["vehicle-1"] })).resolves.toEqual(
      expect.objectContaining({
        governanceReport: expect.objectContaining({
          policyDriftIndex: expect.any(Number),
          stabilityScore: expect.any(Number),
          systemHealthScore: expect.any(Number)
        }),
        policyProposals: expect.any(Array)
      })
    );
    await expect(
      facade.coordinateFleetDecision({
        context: {},
        intent: CoordinationIntent.FLEET_ANALYSIS,
        requestId: "release-smoke-1",
        vehicleIds: ["vehicle-1"]
      })
    ).resolves.toEqual(
      expect.objectContaining({
        agentContributions: expect.any(Array),
        confidenceScore: expect.any(Number),
        consensusRecommendations: expect.any(Array)
      })
    );
  });
});

function createFacade() {
  const vehicleId = "vehicle-1";

  return new FleetOpsFacade(
    {
      resolveVehicleOperationalState: vi.fn().mockResolvedValue({
        asOf: new Date("2026-07-03T00:00:00.000Z"),
        computedState: VehicleComputedOperationalState.AVAILABLE,
        confidenceBand: VehicleOperationalConfidenceBand.HIGH,
        confidenceScore: 95,
        conflicts: [],
        primaryEvidence: { fields: {}, reason: "Vehicle is available.", source: "VEHICLE" },
        supportingEvidence: [],
        vehicleId,
        warnings: []
      })
    } as never,
    {
      getVehicleTimeline: vi.fn().mockResolvedValue([
        {
          confidence: 80,
          conflicts: [],
          date: "2026-07-01",
          sourceEvents: ["vehicle-status"],
          state: TimelineState.AVAILABLE,
          warnings: []
        }
      ])
    } as never,
    {
      getFleetKpis: vi.fn().mockResolvedValue({
        fleet: {},
        vehicles: [
          {
            attribution: { leaseRevenue: 0, penaltyRevenue: 0, writeOffImpact: 0 },
            confidence: { band: "HIGH", score: 90 },
            downtime: { breakdown: { IDLE: 0, MAINTENANCE: 0, RESERVED: 0, SERVICE: 0 }, downtimeCost: 0, totalDowntimeDays: 0 },
            economics: { cost: 0, netIncome: 0, revenue: 0, roe: 0, roi: 0 },
            utilization: { leasedDays: 0, operatingDays: 3, utilizationRate: 0 },
            vehicleId
          }
        ]
      })
    } as never,
    {
      getFleetRisk: vi.fn().mockResolvedValue({
        fleet: {},
        vehicles: [
          {
            collectionLevel: CollectionPriorityLevel.D1,
            confidence: 90,
            controlDecision: ControlDecision.ALLOW,
            exposureScore: 0,
            reasons: [],
            riskScore: 0,
            signals: [],
            vehicleId
          }
        ]
      })
    } as never,
    {
      getFleetOptimization: vi.fn().mockResolvedValue({
        fleet: {},
        fleetLevelInsights: [],
        vehicles: [
          {
            fleetLevelInsights: [],
            optimizationSuggestions: [],
            strategyRecommendation: "No release action required.",
            vehicleId
          }
        ]
      })
    } as never,
    {
      getFleetGovernance: vi.fn().mockResolvedValue({
        governanceReport: { policyDriftIndex: 0, stabilityScore: 100, systemHealthScore: 100 },
        insights: [],
        policyProposals: [],
        rejectedPolicies: [],
        riskWarnings: []
      })
    } as never,
    {
      coordinate: vi.fn().mockResolvedValue({
        agentContributions: [],
        confidenceScore: 100,
        conflictMap: {},
        consensusRecommendations: [],
        unifiedInsights: [],
        unresolvedConflicts: []
      })
    } as never
  );
}
