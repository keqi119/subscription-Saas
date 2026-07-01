import { Injectable } from "@nestjs/common";

import { AgentType, type AgentOutput, type MultiAgentCoordinationRequest } from "./agent.types";
import { AGENT_REGISTRY, sortAgentsByPriority } from "./agent-registry";

@Injectable()
export class AgentOrchestratorService {
  async runAgents(request: MultiAgentCoordinationRequest): Promise<AgentOutput[]> {
    return sortAgentsByPriority(AGENT_REGISTRY.map((agent) => agent.agentType)).map((agentType) => runAgent(agentType, request));
  }
}

function runAgent(agentType: AgentType, request: MultiAgentCoordinationRequest): AgentOutput {
  switch (agentType) {
    case AgentType.RISK:
      return riskAgent(request);
    case AgentType.ECONOMIC:
      return economicAgent(request);
    case AgentType.EXECUTION:
      return executionAgent(request);
    case AgentType.OPTIMIZATION:
      return optimizationAgent(request);
    case AgentType.STATE:
      return stateAgent(request);
    case AgentType.TIMELINE:
      return timelineAgent(request);
    case AgentType.GOVERNANCE:
      return governanceAgent(request);
  }
}

function riskAgent(request: MultiAgentCoordinationRequest): AgentOutput {
  const blockedVehicles = request.context.riskReport?.vehicles.filter((vehicle) => vehicle.controlDecision === "BLOCK") ?? [];
  const blockedVehicleIds = blockedVehicles.map((vehicle) => vehicle.vehicleId);

  return {
    agentType: AgentType.RISK,
    confidence: blockedVehicles.length > 0 ? 95 : 82,
    conflictsDetected: blockedVehicles.map((vehicle) => `${vehicle.vehicleId}.allocation`),
    insights: blockedVehicles.map((vehicle) => `Risk agent observes PR-4 BLOCK for ${vehicle.vehicleId}.`),
    recommendations: blockedVehicleIds.length > 0
      ? [`Respect PR-4 BLOCK for ${formatVehicleIds(blockedVehicleIds)}; route any accepted action through PR-5 only.`]
      : ["No PR-4 blocking signal observed."],
    supportingSignals: blockedVehicles.map((vehicle) => `PR4:${vehicle.vehicleId}:controlDecision=${vehicle.controlDecision}`)
  };
}

function economicAgent(request: MultiAgentCoordinationRequest): AgentOutput {
  const highRoiVehicles = request.context.fleetKpis?.vehicles.filter((vehicle) => vehicle.economics.roi > 0.2) ?? [];
  const highRoiVehicleIds = highRoiVehicles.map((vehicle) => vehicle.vehicleId);

  return {
    agentType: AgentType.ECONOMIC,
    confidence: 86,
    conflictsDetected: highRoiVehicles.map((vehicle) => `${vehicle.vehicleId}.allocation`),
    insights: highRoiVehicles.map((vehicle) => `Economic agent observes ROI ${vehicle.economics.roi} for ${vehicle.vehicleId}.`),
    recommendations: highRoiVehicleIds.length > 0
      ? [`Review ${formatVehicleIds(highRoiVehicleIds)} economics only after risk control causes are resolved.`]
      : ["No high-ROI allocation shift identified."],
    supportingSignals: highRoiVehicles.map((vehicle) => `PR3:${vehicle.vehicleId}:roi=${vehicle.economics.roi}`)
  };
}

function executionAgent(request: MultiAgentCoordinationRequest): AgentOutput {
  const failedExecutions = request.context.executionLogs?.filter((log) => !log.success) ?? [];

  return {
    agentType: AgentType.EXECUTION,
    confidence: failedExecutions.length > 0 ? 90 : 80,
    conflictsDetected: failedExecutions.map((log) => `${log.vehicleId}.execution`),
    insights: failedExecutions.map((log) => `Execution agent observes ${log.outcome} for ${log.vehicleId}.`),
    recommendations: failedExecutions.length > 0
      ? ["Do not infer execution success from recommendations; PR-5 history shows blocked execution."]
      : ["No failed PR-5 execution observed."],
    supportingSignals: failedExecutions.map((log) => `PR5:${log.vehicleId}:${log.outcome}`)
  };
}

function optimizationAgent(request: MultiAgentCoordinationRequest): AgentOutput {
  const blockedStrategies = request.context.optimizationReport?.vehicles.filter((vehicle) => vehicle.strategyRecommendation.includes("Do not execute")) ?? [];

  return {
    agentType: AgentType.OPTIMIZATION,
    confidence: 84,
    conflictsDetected: blockedStrategies.map((vehicle) => `${vehicle.vehicleId}.allocation`),
    insights: blockedStrategies.map((vehicle) => `Optimization agent observes advisory hold for ${vehicle.vehicleId}.`),
    recommendations: blockedStrategies.length > 0
      ? ["Optimization recommendations remain advisory until PR-4 and PR-5 gates permit action."]
      : ["Optimization agent has no allocation hold."],
    supportingSignals: blockedStrategies.map((vehicle) => `PR6:${vehicle.vehicleId}:strategyRecommendation`)
  };
}

function stateAgent(request: MultiAgentCoordinationRequest): AgentOutput {
  const states = request.context.operationalStates ?? [];

  return {
    agentType: AgentType.STATE,
    confidence: average(states.map((state) => state.confidenceScore), 78),
    conflictsDetected: [],
    insights: states.map((state) => `State agent observes ${state.computedState} for ${state.vehicleId}.`),
    recommendations: ["Use PR-1 state as a snapshot signal, not as execution authority."],
    supportingSignals: states.map((state) => `PR1:${state.vehicleId}:${state.computedState}`)
  };
}

function timelineAgent(request: MultiAgentCoordinationRequest): AgentOutput {
  const conflictVehicleIds = Object.entries(request.context.timelines ?? {})
    .filter(([, days]) => days.some((day) => (day.conflicts?.length ?? 0) > 0 || day.confidence < 60))
    .map(([vehicleId]) => vehicleId);

  return {
    agentType: AgentType.TIMELINE,
    confidence: conflictVehicleIds.length > 0 ? 70 : 82,
    conflictsDetected: conflictVehicleIds.map((vehicleId) => `${vehicleId}.timeline`),
    insights: conflictVehicleIds.map((vehicleId) => `Timeline agent observes instability for ${vehicleId}.`),
    recommendations: conflictVehicleIds.length > 0
      ? ["Reconcile PR-2 timeline conflicts before relying on automated strategy synthesis."]
      : ["Timeline signals are stable."],
    supportingSignals: conflictVehicleIds.map((vehicleId) => `PR2:${vehicleId}:timelineConflict`)
  };
}

function governanceAgent(request: MultiAgentCoordinationRequest): AgentOutput {
  const policyProposals = request.context.governanceReport?.policyProposals ?? [];
  const policyConflictTarget = request.vehicleIds[0] ?? "fleet";

  return {
    agentType: AgentType.GOVERNANCE,
    confidence: policyProposals.length > 0 ? 78 : 70,
    conflictsDetected: policyProposals.map(() => `${policyConflictTarget}.policy`),
    insights: policyProposals.map((policy) => `Governance agent observes policy proposal ${policy.policyId}.`),
    recommendations: policyProposals.length > 0
      ? ["Treat PR-7 policy evolution as advisory and do not override live controls."]
      : ["No PR-7 policy proposal observed."],
    supportingSignals: policyProposals.map((policy) => `PR7:${policy.policyId}`)
  };
}

function average(values: number[], fallback: number) {
  if (values.length === 0) {
    return fallback;
  }

  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function formatVehicleIds(vehicleIds: string[]) {
  return vehicleIds.join(", ");
}
