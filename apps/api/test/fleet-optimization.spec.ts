import { describe, expect, it, vi } from "vitest";

import { FleetKpiService } from "../src/fleet-ops/economics/fleet-kpi.service";
import { EconomicTimelineState, type FleetKpiReport } from "../src/fleet-ops/economics/economics.types";
import { ExecutionActionType, ExecutionOutcome, ExecutionStatus, type ExecutionLogEntry } from "../src/fleet-ops/execution/execution.types";
import { ExecutionLogService } from "../src/fleet-ops/execution/execution-log.service";
import { FleetOptimizationService } from "../src/fleet-ops/optimization/fleet-optimization.service";
import { OptimizationEngine } from "../src/fleet-ops/optimization/optimization-engine";
import {
  OptimizationPriority,
  OptimizationSuggestionType,
  type FleetOptimizationInput
} from "../src/fleet-ops/optimization/optimization.types";
import { CollectionPriorityLevel, ControlDecision, RiskSignalCode, type FleetRiskReport } from "../src/fleet-ops/risk/risk.types";
import { FleetRiskService } from "../src/fleet-ops/risk/fleet-risk.service";
import { VehicleTimelineService } from "../src/fleet-ops/timeline/vehicle-timeline.service";
import { VehicleComputedOperationalState } from "../src/fleet-ops/vehicle-operational-state.types";
import { VehicleOperationalStateService } from "../src/fleet-ops/vehicle-operational-state.service";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-05T00:00:00.000Z");

describe("OptimizationEngine", () => {
  it("generates deterministic advisory-only recommendations from PR-1 through PR-5 signals", () => {
    const first = new OptimizationEngine().optimize(optimizationInput());
    const second = new OptimizationEngine().optimize(optimizationInput());

    expect(first).toEqual(second);
    expect(first.vehicles).toHaveLength(3);
    expect(first.fleet.globalUtilizationEfficiencyScore).toBe(68);
    expect(first.fleet.revenueConcentrationRisk).toBe(80);
    expect(first.fleet.riskExposureIndex).toBe(46);
    expect(first.fleet.optimizationOpportunityScore).toBeGreaterThan(60);
    expect(first.fleet.topRecommendations.length).toBeLessThanOrEqual(5);

    expect(vehicle(first, "vehicle-1").optimizationSuggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          priority: OptimizationPriority.HIGH,
          type: OptimizationSuggestionType.REVENUE
        }),
        expect.objectContaining({
          priority: OptimizationPriority.MEDIUM,
          type: OptimizationSuggestionType.COST
        })
      ])
    );
    expect(vehicle(first, "vehicle-2").optimizationSuggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          priority: OptimizationPriority.HIGH,
          requiredSignals: expect.arrayContaining(["PR4:controlDecision=BLOCK", "PR3:roi>0"]),
          type: OptimizationSuggestionType.RISK
        }),
        expect.objectContaining({
          priority: OptimizationPriority.HIGH,
          requiredSignals: expect.arrayContaining(["PR5:failedExecution"]),
          type: OptimizationSuggestionType.ALLOCATION
        })
      ])
    );
    expect(vehicle(first, "vehicle-3").optimizationSuggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          priority: OptimizationPriority.HIGH,
          type: OptimizationSuggestionType.UTILIZATION
        })
      ])
    );
    expect(vehicle(first, "vehicle-2").strategyRecommendation).toContain("Do not execute allocation");
  });
});

describe("FleetOptimizationService", () => {
  it("orchestrates PR outputs and execution history without executing PR-5 actions", async () => {
    const operationalStateService = {
      resolveVehicleOperationalState: vi.fn(async (vehicleId: string) => ({
        computedState: VehicleComputedOperationalState.LEASED_ACTIVE,
        confidenceScore: 90,
        vehicleId
      }))
    };
    const timelineService = {
      getVehicleTimeline: vi.fn(async (vehicleId: string) => timeline(vehicleId))
    };
    const kpiService = {
      getFleetKpis: vi.fn(async () => kpiReport())
    };
    const riskService = {
      getFleetRisk: vi.fn(async () => riskReport())
    };
    const executionLogService = {
      listLogs: vi.fn(() => executionLogs())
    };
    const actionOrchestrator = {
      execute: vi.fn()
    };
    const service = new FleetOptimizationService(
      operationalStateService as unknown as VehicleOperationalStateService,
      timelineService as unknown as VehicleTimelineService,
      kpiService as unknown as FleetKpiService,
      riskService as unknown as FleetRiskService,
      executionLogService as unknown as ExecutionLogService
    );

    const report = await service.getFleetOptimization(["vehicle-1", "vehicle-2", "vehicle-3"], from, to);

    expect(report.vehicles).toHaveLength(3);
    expect(operationalStateService.resolveVehicleOperationalState).toHaveBeenCalledWith("vehicle-1", to);
    expect(timelineService.getVehicleTimeline).toHaveBeenCalledWith("vehicle-1", from, to);
    expect(kpiService.getFleetKpis).toHaveBeenCalledWith(["vehicle-1", "vehicle-2", "vehicle-3"], from, to);
    expect(riskService.getFleetRisk).toHaveBeenCalledWith(["vehicle-1", "vehicle-2", "vehicle-3"], from, to);
    expect(executionLogService.listLogs).toHaveBeenCalledTimes(1);
    expect(actionOrchestrator.execute).not.toHaveBeenCalled();
  });
});

function optimizationInput(): FleetOptimizationInput {
  return {
    asOf: to,
    executionLogs: executionLogs(),
    fleetKpis: kpiReport(),
    operationalStates: [
      operationalState("vehicle-1", VehicleComputedOperationalState.LEASED_ACTIVE),
      operationalState("vehicle-2", VehicleComputedOperationalState.LEASED_ACTIVE),
      operationalState("vehicle-3", VehicleComputedOperationalState.AVAILABLE)
    ],
    riskReport: riskReport(),
    timelines: {
      "vehicle-1": timeline("vehicle-1"),
      "vehicle-2": timeline("vehicle-2", 2),
      "vehicle-3": idleTimeline()
    },
    vehicleIds: ["vehicle-1", "vehicle-2", "vehicle-3"]
  };
}

function vehicle(report: ReturnType<OptimizationEngine["optimize"]>, vehicleId: string) {
  return report.vehicles.find((row) => row.vehicleId === vehicleId)!;
}

function operationalState(vehicleId: string, computedState: VehicleComputedOperationalState) {
  return {
    computedState,
    confidenceScore: 90,
    vehicleId
  };
}

function timeline(vehicleId: string, conflictDays = 0) {
  return [
    day("2026-07-01", EconomicTimelineState.LEASED, conflictDays > 0),
    day("2026-07-02", EconomicTimelineState.LEASED, conflictDays > 1),
    day("2026-07-03", EconomicTimelineState.LEASED),
    day("2026-07-04", EconomicTimelineState.LEASED),
    day("2026-07-05", EconomicTimelineState.LEASED)
  ].map((timelineDay) => ({ ...timelineDay, sourceEvents: [vehicleId] }));
}

function idleTimeline() {
  return [
    day("2026-07-01", EconomicTimelineState.AVAILABLE),
    day("2026-07-02", EconomicTimelineState.AVAILABLE),
    day("2026-07-03", EconomicTimelineState.RESERVED),
    day("2026-07-04", EconomicTimelineState.AVAILABLE),
    day("2026-07-05", EconomicTimelineState.LEASED)
  ];
}

function day(date: string, state: EconomicTimelineState, conflicted = false) {
  return {
    confidence: conflicted ? 50 : 90,
    conflicts: conflicted ? [{ id: `conflict-${date}` }] : [],
    date,
    sourceEvents: [],
    state
  };
}

function kpiReport(): FleetKpiReport {
  return {
    fleet: {
      cost: 5900,
      downtimeCost: 1600,
      downtimeDays: 8,
      leasedDays: 11,
      netIncome: 5100,
      operatingDays: 15,
      revenue: 15000,
      roe: 0.2,
      roi: 0.18,
      utilizationRate: 0.68,
      vehicleCount: 3
    },
    vehicles: [
      kpiVehicle("vehicle-1", { cost: 1400, revenue: 1000, roi: -0.05, utilizationRate: 1 }),
      kpiVehicle("vehicle-2", { cost: 2200, revenue: 12000, roi: 0.35, utilizationRate: 1 }),
      kpiVehicle("vehicle-3", { cost: 2300, revenue: 2000, roi: -0.02, utilizationRate: 0.2 })
    ]
  };
}

function kpiVehicle(vehicleId: string, overrides: { cost: number; revenue: number; roi: number; utilizationRate: number }) {
  return {
    attribution: {
      leaseRevenue: overrides.revenue,
      penaltyRevenue: 0,
      writeOffImpact: 0
    },
    confidence: {
      band: "HIGH" as const,
      score: 90
    },
    downtime: {
      breakdown: {
        IDLE: overrides.utilizationRate < 0.5 ? 3 : 0,
        MAINTENANCE: 1,
        RESERVED: 0,
        SERVICE: overrides.cost > overrides.revenue ? 1 : 0
      },
      downtimeCost: overrides.cost > overrides.revenue ? 900 : 350,
      totalDowntimeDays: overrides.utilizationRate < 0.5 ? 4 : 1
    },
    economics: {
      cost: overrides.cost,
      netIncome: overrides.revenue - overrides.cost,
      revenue: overrides.revenue,
      roe: overrides.roi,
      roi: overrides.roi
    },
    utilization: {
      leasedDays: Math.round(overrides.utilizationRate * 5),
      operatingDays: 5,
      utilizationRate: overrides.utilizationRate
    },
    vehicleId
  };
}

function riskReport(): FleetRiskReport {
  return {
    fleet: {
      averageExposureScore: 35,
      averageRiskScore: 46,
      blockedVehicles: 1,
      vehicleCount: 3,
      warnedVehicles: 1
    },
    vehicles: [
      riskVehicle("vehicle-1", { controlDecision: ControlDecision.ALLOW, riskScore: 20 }),
      riskVehicle("vehicle-2", { controlDecision: ControlDecision.BLOCK, riskScore: 92 }),
      riskVehicle("vehicle-3", { controlDecision: ControlDecision.WARN, riskScore: 55 })
    ]
  };
}

function riskVehicle(vehicleId: string, overrides: { controlDecision: ControlDecision; riskScore: number }) {
  return {
    collectionLevel: overrides.controlDecision === ControlDecision.BLOCK ? CollectionPriorityLevel.D5 : CollectionPriorityLevel.D2,
    confidence: 80,
    controlDecision: overrides.controlDecision,
    exposureScore: overrides.riskScore,
    reasons: ["Observed PR-4 risk signal."],
    riskScore: overrides.riskScore,
    signals: overrides.controlDecision === ControlDecision.BLOCK ? [RiskSignalCode.OVERDUE_SIGNAL, RiskSignalCode.TIMELINE_CONFLICT_SIGNAL] : [],
    vehicleId
  };
}

function executionLogs(): ExecutionLogEntry[] {
  return [
    {
      actionType: ExecutionActionType.VEHICLE_ALLOCATION,
      decisionUsed: ControlDecision.BLOCK,
      executionId: "exec-failed-allocation",
      inputSnapshot: riskVehicle("vehicle-2", { controlDecision: ControlDecision.BLOCK, riskScore: 92 }),
      outcome: ExecutionOutcome.BLOCKED_BY_CONTROL_GUARD,
      reason: ["PR-4 BLOCK decision prevents this execution action."],
      status: ExecutionStatus.BLOCKED,
      success: false,
      timestamp: new Date("2026-07-05T08:30:00.000Z"),
      vehicleId: "vehicle-2"
    }
  ];
}
