import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";

import { MultiAgentCoordinatorService } from "../src/fleet-ops/coordination/multi-agent-coordinator.service";
import { CoordinationIntent } from "../src/fleet-ops/coordination/agent.types";
import { FleetKpiService } from "../src/fleet-ops/economics/fleet-kpi.service";
import { FleetGovernanceService } from "../src/fleet-ops/governance/fleet-governance.service";
import { FleetOptimizationService } from "../src/fleet-ops/optimization/fleet-optimization.service";
import { FleetRiskService } from "../src/fleet-ops/risk/fleet-risk.service";
import { FleetOpsFacade } from "../src/fleet-ops/fleet-ops.facade";
import { FleetOpsHealthService } from "../src/fleet-ops/fleet-ops.health.service";
import { FleetOpsModule } from "../src/fleet-ops/fleet-ops.module";
import { VehicleOperationalStateService } from "../src/fleet-ops/vehicle-operational-state.service";
import { VehicleTimelineService } from "../src/fleet-ops/timeline/vehicle-timeline.service";
import { CollectionPriorityLevel, ControlDecision } from "../src/fleet-ops/risk/risk.types";
import { TimelineState } from "../src/fleet-ops/timeline/vehicle-timeline.types";
import { VehicleComputedOperationalState, VehicleOperationalConfidenceBand } from "../src/fleet-ops/vehicle-operational-state.types";

describe("FleetOpsModule", () => {
  it("compiles as the single production module boundary and exposes facade plus health service", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          envFilePath: [".env.local", "../../.env", ".env"],
          isGlobal: true
        }),
        FleetOpsModule
      ]
    }).compile();

    expect(moduleRef.get(FleetOpsFacade)).toBeInstanceOf(FleetOpsFacade);
    expect(moduleRef.get(FleetOpsHealthService).getHealth()).toEqual({
      coordinationEngine: "OK",
      economicsEngine: "OK",
      executionEngine: "OK",
      governanceEngine: "OK",
      optimizationEngine: "OK",
      riskEngine: "OK",
      stateEngine: "OK",
      timelineEngine: "OK"
    });

    await moduleRef.close();
  });
});

describe("FleetOpsFacade", () => {
  it("exposes stable read-only vehicle and fleet integration methods", async () => {
    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-07-03T00:00:00.000Z");
    const range = { from, to };
    const vehicleId = "vehicle-1";
    const state = vehicleState(vehicleId, to);
    const timeline = [
      { confidence: 90, conflicts: [], date: "2026-07-01", sourceEvents: ["lease-1"], state: TimelineState.LEASED, warnings: [] }
    ];
    const kpi = vehicleKpi(vehicleId);
    const risk = vehicleRisk(vehicleId);
    const optimization = vehicleOptimization(vehicleId);
    const governance = governanceReport();
    const coordination = {
      agentContributions: [],
      confidenceScore: 88,
      conflictMap: {},
      consensusRecommendations: ["Keep PR-4 as the control authority."],
      unifiedInsights: ["All agents coordinated through PR-8."],
      unresolvedConflicts: []
    };
    const facade = new FleetOpsFacade(
      { resolveVehicleOperationalState: vi.fn().mockResolvedValue(state) } as unknown as VehicleOperationalStateService,
      { getVehicleTimeline: vi.fn().mockResolvedValue(timeline) } as unknown as VehicleTimelineService,
      { getFleetKpis: vi.fn().mockResolvedValue({ fleet: fleetKpiAggregate(), vehicles: [kpi] }) } as unknown as FleetKpiService,
      { getFleetRisk: vi.fn().mockResolvedValue({ fleet: fleetRiskAggregate(), vehicles: [risk] }) } as unknown as FleetRiskService,
      { getFleetOptimization: vi.fn().mockResolvedValue({ fleet: fleetOptimizationSummary(), fleetLevelInsights: [], vehicles: [optimization] }) } as unknown as FleetOptimizationService,
      { getFleetGovernance: vi.fn().mockResolvedValue(governance) } as unknown as FleetGovernanceService,
      { coordinate: vi.fn().mockResolvedValue(coordination) } as unknown as MultiAgentCoordinatorService
    );

    await expect(facade.getVehicleState(vehicleId)).resolves.toEqual(state);
    await expect(facade.getVehicleTimeline(vehicleId, from, to)).resolves.toEqual(timeline);
    await expect(facade.getVehicleKpi(vehicleId, range)).resolves.toEqual(kpi);
    await expect(facade.getVehicleRisk(vehicleId, range)).resolves.toEqual(risk);
    await expect(facade.getVehicleOptimization(vehicleId, range)).resolves.toEqual(optimization);
    await expect(facade.getFleetGovernanceReport({ ...range, vehicleIds: [vehicleId] })).resolves.toEqual(governance);
    await expect(
      facade.coordinateFleetDecision({
        context: {},
        intent: CoordinationIntent.FLEET_ANALYSIS,
        requestId: "coord-prod-1",
        vehicleIds: [vehicleId]
      })
    ).resolves.toEqual(coordination);
  });

  it("returns null for vehicle-scoped reports when an upstream fleet report has no matching vehicle row", async () => {
    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-07-03T00:00:00.000Z");
    const facade = new FleetOpsFacade(
      { resolveVehicleOperationalState: vi.fn() } as unknown as VehicleOperationalStateService,
      { getVehicleTimeline: vi.fn() } as unknown as VehicleTimelineService,
      { getFleetKpis: vi.fn().mockResolvedValue({ fleet: fleetKpiAggregate(), vehicles: [] }) } as unknown as FleetKpiService,
      { getFleetRisk: vi.fn().mockResolvedValue({ fleet: fleetRiskAggregate(), vehicles: [] }) } as unknown as FleetRiskService,
      { getFleetOptimization: vi.fn().mockResolvedValue({ fleet: fleetOptimizationSummary(), fleetLevelInsights: [], vehicles: [] }) } as unknown as FleetOptimizationService,
      { getFleetGovernance: vi.fn() } as unknown as FleetGovernanceService,
      { coordinate: vi.fn() } as unknown as MultiAgentCoordinatorService
    );

    await expect(facade.getVehicleKpi("missing-vehicle", { from, to })).resolves.toBeNull();
    await expect(facade.getVehicleRisk("missing-vehicle", { from, to })).resolves.toBeNull();
    await expect(facade.getVehicleOptimization("missing-vehicle", { from, to })).resolves.toBeNull();
  });
});

function vehicleState(vehicleId: string, asOf: Date) {
  return {
    asOf,
    computedState: VehicleComputedOperationalState.LEASED_ACTIVE,
    confidenceBand: VehicleOperationalConfidenceBand.HIGH,
    confidenceScore: 92,
    conflicts: [],
    primaryEvidence: { fields: {}, reason: "Lease is active.", source: "LEASE" as const, sourceId: "lease-1" },
    supportingEvidence: [],
    vehicleId,
    warnings: []
  };
}

function vehicleKpi(vehicleId: string) {
  return {
    attribution: { leaseRevenue: 1000, penaltyRevenue: 0, writeOffImpact: 0 },
    confidence: { band: "HIGH" as const, score: 90 },
    downtime: { breakdown: { IDLE: 0, MAINTENANCE: 0, RESERVED: 0, SERVICE: 0 }, downtimeCost: 0, totalDowntimeDays: 0 },
    economics: { cost: 200, netIncome: 800, revenue: 1000, roe: 0.16, roi: 0.12 },
    utilization: { leasedDays: 3, operatingDays: 3, utilizationRate: 1 },
    vehicleId
  };
}

function vehicleRisk(vehicleId: string) {
  return {
    collectionLevel: CollectionPriorityLevel.D1,
    confidence: 90,
    controlDecision: ControlDecision.ALLOW,
    exposureScore: 10,
    reasons: ["Stable risk profile."],
    riskScore: 12,
    signals: [],
    vehicleId
  };
}

function vehicleOptimization(vehicleId: string) {
  return {
    fleetLevelInsights: [],
    optimizationSuggestions: [],
    strategyRecommendation: "Maintain current allocation.",
    vehicleId
  };
}

function governanceReport() {
  return {
    governanceReport: { policyDriftIndex: 10, stabilityScore: 90, systemHealthScore: 88 },
    insights: ["Policy drift is controlled."],
    policyProposals: [],
    rejectedPolicies: [],
    riskWarnings: []
  };
}

function fleetKpiAggregate() {
  return {
    cost: 200,
    downtimeCost: 0,
    downtimeDays: 0,
    leasedDays: 3,
    netIncome: 800,
    operatingDays: 3,
    revenue: 1000,
    roe: 0.16,
    roi: 0.12,
    utilizationRate: 1,
    vehicleCount: 1
  };
}

function fleetRiskAggregate() {
  return {
    averageExposureScore: 10,
    averageRiskScore: 12,
    blockedVehicles: 0,
    vehicleCount: 1,
    warnedVehicles: 0
  };
}

function fleetOptimizationSummary() {
  return {
    globalUtilizationEfficiencyScore: 90,
    optimizationOpportunityScore: 20,
    revenueConcentrationRisk: 10,
    riskExposureIndex: 12,
    topRecommendations: []
  };
}
