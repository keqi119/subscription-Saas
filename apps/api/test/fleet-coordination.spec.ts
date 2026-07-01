import { describe, expect, it } from "vitest";

import { AgentCommunicationBus } from "../src/fleet-ops/coordination/agent-communication.bus";
import { AgentOrchestratorService } from "../src/fleet-ops/coordination/agent-orchestrator.service";
import { AGENT_REGISTRY } from "../src/fleet-ops/coordination/agent-registry";
import {
  AgentType,
  CoordinationIntent,
  type AgentOutput,
  type MultiAgentCoordinationRequest
} from "../src/fleet-ops/coordination/agent.types";
import { ConflictResolutionEngine } from "../src/fleet-ops/coordination/conflict-resolution.engine";
import { CoordinationEngine } from "../src/fleet-ops/coordination/coordination-engine";
import { MultiAgentCoordinatorService } from "../src/fleet-ops/coordination/multi-agent-coordinator.service";
import { TaskDistributor } from "../src/fleet-ops/coordination/task-distributor";
import { EconomicTimelineState } from "../src/fleet-ops/economics/economics.types";
import { ExecutionActionType, ExecutionOutcome, ExecutionStatus } from "../src/fleet-ops/execution/execution.types";
import { CollectionPriorityLevel, ControlDecision, RiskSignalCode } from "../src/fleet-ops/risk/risk.types";
import { VehicleComputedOperationalState } from "../src/fleet-ops/vehicle-operational-state.types";

describe("TaskDistributor", () => {
  it("breaks a fleet coordination request into redundant multi-agent tasks without single-agent dominance", () => {
    const tasks = new TaskDistributor().distribute(coordinationRequest());

    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignedAgents: expect.arrayContaining([AgentType.RISK, AgentType.ECONOMIC]),
          critical: true,
          taskId: "coord-1:allocation-risk"
        }),
        expect.objectContaining({
          assignedAgents: expect.arrayContaining([AgentType.EXECUTION, AgentType.OPTIMIZATION]),
          taskId: "coord-1:execution-feedback"
        })
      ])
    );
    expect(tasks.every((task) => task.assignedAgents.length >= 2)).toBe(true);
    expect(Math.max(...Object.values(agentAssignmentCounts(tasks)))).toBeLessThanOrEqual(3);
  });
});

describe("AgentCommunicationBus", () => {
  it("aggregates async agent outputs and reconciles late-arriving signals deterministically", async () => {
    const bus = new AgentCommunicationBus();
    const collection = bus.collect("coord-1", 2);

    await bus.broadcast("coord-1", agentOutput(AgentType.TIMELINE, { confidence: 60, insights: ["Timeline data is partially missing."] }));
    await bus.broadcast("coord-1", agentOutput(AgentType.STATE, { confidence: 90, insights: ["Current state is LEASED_ACTIVE."] }));

    const collected = await collection;
    await bus.broadcast("coord-1", agentOutput(AgentType.RISK, { confidence: 95, insights: ["Risk agent late signal: BLOCK remains authoritative."] }));

    expect(collected.map((output) => output.agentType)).toEqual([AgentType.STATE, AgentType.TIMELINE]);
    expect(bus.getOutputs("coord-1").map((output) => output.agentType)).toEqual([AgentType.RISK, AgentType.STATE, AgentType.TIMELINE]);
  });
});

describe("CoordinationEngine", () => {
  it("resolves PR-4 vs PR-6 disagreement using priority hierarchy and keeps governance advisory", () => {
    const outputs = [
      agentOutput(AgentType.ECONOMIC, {
        recommendations: ["Allocate vehicle-2 to high ROI demand segment."],
        supportingSignals: ["PR3:roi=0.35"]
      }),
      agentOutput(AgentType.RISK, {
        conflictsDetected: ["vehicle-2.allocation"],
        recommendations: ["Do not allocate vehicle-2 while PR-4 controlDecision=BLOCK."],
        supportingSignals: ["PR4:controlDecision=BLOCK"]
      }),
      agentOutput(AgentType.GOVERNANCE, {
        conflictsDetected: ["vehicle-2.policy"],
        recommendations: ["Consider policy tuning for high ROI blocked vehicles, advisory only."],
        supportingSignals: ["PR7:policyProposal=risk.block-threshold.tuning"]
      }),
      agentOutput(AgentType.OPTIMIZATION, {
        conflictsDetected: ["vehicle-2.allocation"],
        recommendations: ["Optimization suggests allocation after risk resolution."],
        supportingSignals: ["PR6:strategyRecommendation"]
      })
    ];

    const result = new CoordinationEngine(new ConflictResolutionEngine()).synthesize(outputs);

    expect(result.conflictMap).toEqual(
      expect.objectContaining({
        "vehicle-2.allocation": expect.arrayContaining([AgentType.RISK, AgentType.OPTIMIZATION]),
        "vehicle-2.policy": [AgentType.GOVERNANCE]
      })
    );
    expect(result.consensusRecommendations[0]).toBe("Do not allocate vehicle-2 while PR-4 controlDecision=BLOCK.");
    expect(result.consensusRecommendations).toContain("Consider policy tuning for high ROI blocked vehicles, advisory only.");
    expect(result.unresolvedConflicts).toEqual(["vehicle-2.policy"]);
    expect(result.confidenceScore).toBe(83);
  });
});

describe("MultiAgentCoordinatorService", () => {
  it("generates independent agent outputs and returns a deterministic unified advisory response", async () => {
    const service = new MultiAgentCoordinatorService(new AgentOrchestratorService());
    const first = await service.coordinate(coordinationRequest());
    const second = await service.coordinate(coordinationRequest());

    expect(first).toEqual(second);
    expect(first.agentContributions.map((output) => output.agentType)).toEqual([
      AgentType.RISK,
      AgentType.ECONOMIC,
      AgentType.EXECUTION,
      AgentType.OPTIMIZATION,
      AgentType.STATE,
      AgentType.TIMELINE,
      AgentType.GOVERNANCE
    ]);
    expect(first.consensusRecommendations).toEqual(
      expect.arrayContaining([
        "Respect PR-4 BLOCK for vehicle-2; route any accepted action through PR-5 only.",
        "Review vehicle-2 economics only after risk control causes are resolved.",
        "Treat PR-7 policy evolution as advisory and do not override live controls."
      ])
    );
    expect(first.conflictMap["vehicle-2.allocation"]).toEqual(
      expect.arrayContaining([AgentType.RISK, AgentType.ECONOMIC, AgentType.OPTIMIZATION])
    );
    expect(first.unresolvedConflicts).toEqual(["vehicle-2.policy"]);
    expect(AGENT_REGISTRY).toHaveLength(7);
  });
});

function agentAssignmentCounts(tasks: ReturnType<TaskDistributor["distribute"]>) {
  return tasks.flatMap((task) => task.assignedAgents).reduce<Record<string, number>>((counts, agent) => {
    counts[agent] = (counts[agent] ?? 0) + 1;

    return counts;
  }, {});
}

function agentOutput(agentType: AgentType, overrides: Partial<AgentOutput> = {}): AgentOutput {
  return {
    agentType,
    confidence: 80,
    conflictsDetected: [],
    insights: [`${agentType} insight.`],
    recommendations: [`${agentType} recommendation.`],
    supportingSignals: [`${agentType}:signal`],
    ...overrides
  };
}

function coordinationRequest(): MultiAgentCoordinationRequest {
  return {
    context: {
      executionLogs: [
        {
          actionType: ExecutionActionType.VEHICLE_ALLOCATION,
          decisionUsed: ControlDecision.BLOCK,
          executionId: "exec-blocked",
          inputSnapshot: {
            collectionLevel: CollectionPriorityLevel.D5,
            confidence: 80,
            controlDecision: ControlDecision.BLOCK,
            exposureScore: 92,
            reasons: ["Observed PR-4 risk signal."],
            riskScore: 92,
            signals: [RiskSignalCode.OVERDUE_SIGNAL],
            vehicleId: "vehicle-2"
          },
          outcome: ExecutionOutcome.BLOCKED_BY_CONTROL_GUARD,
          reason: ["PR-4 BLOCK decision prevents this execution action."],
          status: ExecutionStatus.BLOCKED,
          success: false,
          timestamp: new Date("2026-07-05T08:30:00.000Z"),
          vehicleId: "vehicle-2"
        }
      ],
      fleetKpis: {
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
          {
            attribution: { leaseRevenue: 12000, penaltyRevenue: 0, writeOffImpact: 0 },
            confidence: { band: "HIGH", score: 90 },
            downtime: { breakdown: { IDLE: 0, MAINTENANCE: 1, RESERVED: 0, SERVICE: 0 }, downtimeCost: 350, totalDowntimeDays: 1 },
            economics: { cost: 2200, netIncome: 9800, revenue: 12000, roe: 0.35, roi: 0.35 },
            utilization: { leasedDays: 5, operatingDays: 5, utilizationRate: 1 },
            vehicleId: "vehicle-2"
          }
        ]
      },
      governanceReport: {
        governanceReport: { policyDriftIndex: 58, stabilityScore: 29, systemHealthScore: 30 },
        insights: ["Observed 1 blocked high-ROI vehicle(s), indicating possible over-tight risk policy."],
        policyProposals: [
          {
            confidence: 90,
            currentConfig: { blockThreshold: 85 },
            domain: "RISK" as never,
            expectedImpact: { riskReduction: 18 },
            policyId: "risk.block-threshold.tuning",
            proposedUpdate: { blockThresholdDelta: 5 },
            reason: ["PR4:blockedHighRoiVehicles=1"],
            simulation: { currentScore: 30, projectedScore: 39, riskWarnings: [] }
          }
        ],
        rejectedPolicies: [],
        riskWarnings: ["Policy evolution is advisory only."]
      },
      operationalStates: [
        {
          computedState: VehicleComputedOperationalState.LEASED_ACTIVE,
          confidenceScore: 90,
          vehicleId: "vehicle-2"
        }
      ],
      optimizationReport: {
        fleet: {
          globalUtilizationEfficiencyScore: 68,
          optimizationOpportunityScore: 77,
          revenueConcentrationRisk: 80,
          riskExposureIndex: 46,
          topRecommendations: []
        },
        fleetLevelInsights: ["Execution history includes failed or blocked PR-5 actions; recommendations remain advisory only."],
        vehicles: [
          {
            fleetLevelInsights: [],
            optimizationSuggestions: [],
            strategyRecommendation: "Do not execute allocation until PR-4 risk decision improves.",
            vehicleId: "vehicle-2"
          }
        ]
      },
      riskReport: {
        fleet: {
          averageExposureScore: 35,
          averageRiskScore: 46,
          blockedVehicles: 1,
          vehicleCount: 3,
          warnedVehicles: 1
        },
        vehicles: [
          {
            collectionLevel: CollectionPriorityLevel.D5,
            confidence: 80,
            controlDecision: ControlDecision.BLOCK,
            exposureScore: 92,
            reasons: ["Observed PR-4 risk signal."],
            riskScore: 92,
            signals: [RiskSignalCode.OVERDUE_SIGNAL, RiskSignalCode.TIMELINE_CONFLICT_SIGNAL],
            vehicleId: "vehicle-2"
          }
        ]
      },
      timelines: {
        "vehicle-2": [
          {
            confidence: 50,
            conflicts: [{ id: "conflict-1" }],
            date: "2026-07-01",
            sourceEvents: ["vehicle-2"],
            state: EconomicTimelineState.LEASED
          }
        ]
      }
    },
    intent: CoordinationIntent.FLEET_OPTIMIZATION_REVIEW,
    requestId: "coord-1",
    vehicleIds: ["vehicle-2"]
  };
}
