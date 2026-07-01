import { describe, expect, it, vi } from "vitest";

import { FleetKpiService } from "../src/fleet-ops/economics/fleet-kpi.service";
import { EconomicTimelineState, type FleetKpiReport } from "../src/fleet-ops/economics/economics.types";
import { ExecutionActionType, ExecutionOutcome, ExecutionStatus, type ExecutionLogEntry } from "../src/fleet-ops/execution/execution.types";
import { ExecutionLogService } from "../src/fleet-ops/execution/execution-log.service";
import { FleetGovernanceService } from "../src/fleet-ops/governance/fleet-governance.service";
import { PolicyEngine } from "../src/fleet-ops/governance/policy-engine";
import { PolicyDomain, type FleetGovernanceInput } from "../src/fleet-ops/governance/policy.types";
import { FleetOptimizationService } from "../src/fleet-ops/optimization/fleet-optimization.service";
import {
  OptimizationPriority,
  OptimizationSuggestionType,
  type FleetOptimizationReport
} from "../src/fleet-ops/optimization/optimization.types";
import { CollectionPriorityLevel, ControlDecision, RiskSignalCode, type FleetRiskReport } from "../src/fleet-ops/risk/risk.types";
import { FleetRiskService } from "../src/fleet-ops/risk/fleet-risk.service";
import { VehicleTimelineService } from "../src/fleet-ops/timeline/vehicle-timeline.service";
import { VehicleComputedOperationalState } from "../src/fleet-ops/vehicle-operational-state.types";
import { VehicleOperationalStateService } from "../src/fleet-ops/vehicle-operational-state.service";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-05T00:00:00.000Z");

describe("PolicyEngine", () => {
  it("measures policy drift and proposes simulated read-only policy evolution from PR-1 through PR-6 outcomes", () => {
    const first = new PolicyEngine().evaluate(governanceInput());
    const second = new PolicyEngine().evaluate(governanceInput());

    expect(first).toEqual(second);
    expect(first.governanceReport).toEqual({
      policyDriftIndex: 58,
      stabilityScore: 29,
      systemHealthScore: 30
    });
    expect(first.policyProposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: PolicyDomain.RISK,
          expectedImpact: expect.objectContaining({ riskReduction: 18 }),
          policyId: "risk.block-threshold.tuning",
          proposedUpdate: expect.objectContaining({ blockThresholdDelta: 5 }),
          simulation: expect.objectContaining({
            currentScore: 30,
            projectedScore: 39
          })
        }),
        expect.objectContaining({
          domain: PolicyDomain.EXECUTION,
          policyId: "execution.override-review.tuning",
          proposedUpdate: expect.objectContaining({ blockedRetryPolicy: "require_operator_review" })
        }),
        expect.objectContaining({
          domain: PolicyDomain.UTILIZATION,
          policyId: "utilization.timeline-stability.tuning",
          proposedUpdate: expect.objectContaining({ conflictDensityThresholdDelta: -0.05 })
        })
      ])
    );
    expect(first.rejectedPolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: PolicyDomain.ALLOCATION,
          policyId: "allocation.relax-blocked-high-roi"
        })
      ])
    );
    expect(first.insights).toEqual(
      expect.arrayContaining([
        "Observed 1 blocked high-ROI vehicle(s), indicating possible over-tight risk policy.",
        "Observed 1 failed execution attempt(s), requiring execution policy review.",
        "Observed timeline conflict density of 0.27."
      ])
    );
    expect(first.riskWarnings).toEqual(
      expect.arrayContaining(["Policy proposal allocation.relax-blocked-high-roi rejected because BLOCK decisions cannot be overridden by governance."])
    );
  });
});

describe("FleetGovernanceService", () => {
  it("collects PR-1 through PR-6 outputs read-only and never executes actions", async () => {
    const operationalStateService = {
      resolveVehicleOperationalState: vi.fn(async (vehicleId: string) => operationalState(vehicleId))
    };
    const timelineService = {
      getVehicleTimeline: vi.fn(async (vehicleId: string) => timeline(vehicleId, vehicleId === "vehicle-2" ? 2 : 0))
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
    const optimizationService = {
      getFleetOptimization: vi.fn(async () => optimizationReport())
    };
    const actionOrchestrator = {
      execute: vi.fn()
    };
    const service = new FleetGovernanceService(
      operationalStateService as unknown as VehicleOperationalStateService,
      timelineService as unknown as VehicleTimelineService,
      kpiService as unknown as FleetKpiService,
      riskService as unknown as FleetRiskService,
      executionLogService as unknown as ExecutionLogService,
      optimizationService as unknown as FleetOptimizationService
    );

    const report = await service.getFleetGovernance(["vehicle-1", "vehicle-2", "vehicle-3"], from, to);

    expect(report.policyProposals.length).toBeGreaterThan(0);
    expect(operationalStateService.resolveVehicleOperationalState).toHaveBeenCalledWith("vehicle-1", to);
    expect(timelineService.getVehicleTimeline).toHaveBeenCalledWith("vehicle-1", from, to);
    expect(kpiService.getFleetKpis).toHaveBeenCalledWith(["vehicle-1", "vehicle-2", "vehicle-3"], from, to);
    expect(riskService.getFleetRisk).toHaveBeenCalledWith(["vehicle-1", "vehicle-2", "vehicle-3"], from, to);
    expect(executionLogService.listLogs).toHaveBeenCalledTimes(1);
    expect(optimizationService.getFleetOptimization).toHaveBeenCalledWith(["vehicle-1", "vehicle-2", "vehicle-3"], from, to);
    expect(actionOrchestrator.execute).not.toHaveBeenCalled();
  });
});

function governanceInput(): FleetGovernanceInput {
  return {
    asOf: to,
    executionLogs: executionLogs(),
    fleetKpis: kpiReport(),
    optimizationReport: optimizationReport(),
    operationalStates: [
      operationalState("vehicle-1"),
      operationalState("vehicle-2"),
      operationalState("vehicle-3", VehicleComputedOperationalState.AVAILABLE)
    ],
    riskReport: riskReport(),
    timelines: {
      "vehicle-1": timeline("vehicle-1"),
      "vehicle-2": timeline("vehicle-2", 2),
      "vehicle-3": timeline("vehicle-3", 2, EconomicTimelineState.AVAILABLE)
    },
    vehicleIds: ["vehicle-1", "vehicle-2", "vehicle-3"]
  };
}

function operationalState(vehicleId: string, computedState = VehicleComputedOperationalState.LEASED_ACTIVE) {
  return {
    computedState,
    confidenceScore: 90,
    vehicleId
  };
}

function timeline(vehicleId: string, conflictDays = 0, state = EconomicTimelineState.LEASED) {
  return Array.from({ length: 5 }, (_, index) => ({
    confidence: index < conflictDays ? 50 : 90,
    conflicts: index < conflictDays ? [{ id: `conflict-${vehicleId}-${index}` }] : [],
    date: `2026-07-0${index + 1}`,
    sourceEvents: [vehicleId],
    state
  }));
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

function optimizationReport(): FleetOptimizationReport {
  return {
    fleet: {
      globalUtilizationEfficiencyScore: 68,
      optimizationOpportunityScore: 77,
      revenueConcentrationRisk: 80,
      riskExposureIndex: 46,
      topRecommendations: [
        {
          confidence: 90,
          description: "High ROI is paired with BLOCK risk; preserve economics by resolving control causes before any allocation or lease expansion.",
          expectedImpact: { riskReduction: 50 },
          priority: OptimizationPriority.HIGH,
          reasoningTrace: ["Observed roi=0.35", "Observed controlDecision=BLOCK"],
          requiredSignals: ["PR4:controlDecision=BLOCK", "PR3:roi>0"],
          type: OptimizationSuggestionType.RISK
        }
      ]
    },
    fleetLevelInsights: ["Execution history includes failed or blocked PR-5 actions; recommendations remain advisory only."],
    vehicles: [
      {
        fleetLevelInsights: [],
        optimizationSuggestions: [],
        strategyRecommendation: "Maintain current strategy.",
        vehicleId: "vehicle-1"
      },
      {
        fleetLevelInsights: [],
        optimizationSuggestions: [
          {
            confidence: 90,
            description: "High ROI is paired with BLOCK risk.",
            expectedImpact: { riskReduction: 50 },
            priority: OptimizationPriority.HIGH,
            reasoningTrace: ["Observed roi=0.35", "Observed controlDecision=BLOCK"],
            requiredSignals: ["PR4:controlDecision=BLOCK", "PR3:roi>0"],
            type: OptimizationSuggestionType.RISK
          }
        ],
        strategyRecommendation: "Do not execute allocation until PR-4 risk decision improves.",
        vehicleId: "vehicle-2"
      },
      {
        fleetLevelInsights: [],
        optimizationSuggestions: [],
        strategyRecommendation: "Prioritize allocation experiments.",
        vehicleId: "vehicle-3"
      }
    ]
  };
}
