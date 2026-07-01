import type { FleetKpiReport } from "../economics/economics.types";
import type { ExecutionLogEntry } from "../execution/execution.types";
import type { FleetGovernanceReport } from "../governance/policy.types";
import type { FleetOptimizationReport } from "../optimization/optimization.types";
import type { FleetRiskReport } from "../risk/risk.types";

export enum AgentType {
  STATE = "STATE",
  TIMELINE = "TIMELINE",
  ECONOMIC = "ECONOMIC",
  RISK = "RISK",
  EXECUTION = "EXECUTION",
  OPTIMIZATION = "OPTIMIZATION",
  GOVERNANCE = "GOVERNANCE"
}

export enum CoordinationIntent {
  FLEET_ANALYSIS = "FLEET_ANALYSIS",
  FLEET_OPTIMIZATION_REVIEW = "FLEET_OPTIMIZATION_REVIEW",
  RISK_REVIEW = "RISK_REVIEW",
  EXECUTION_REVIEW = "EXECUTION_REVIEW"
}

export interface AgentOutput {
  agentType: AgentType;
  confidence: number;
  conflictsDetected: string[];
  insights: string[];
  recommendations: string[];
  supportingSignals: string[];
}

export interface AgentDefinition {
  agentType: AgentType;
  description: string;
  priority: number;
}

export interface CoordinationTimelineDay {
  confidence: number;
  conflicts?: unknown[];
  date: string;
  sourceEvents: string[];
  state: string;
}

export interface CoordinationOperationalState {
  computedState: string;
  confidenceScore: number;
  vehicleId: string;
}

export interface MultiAgentCoordinationContext {
  executionLogs?: ExecutionLogEntry[];
  fleetKpis?: FleetKpiReport;
  governanceReport?: FleetGovernanceReport;
  operationalStates?: CoordinationOperationalState[];
  optimizationReport?: FleetOptimizationReport;
  riskReport?: FleetRiskReport;
  timelines?: Record<string, CoordinationTimelineDay[]>;
}

export interface MultiAgentCoordinationRequest {
  context: MultiAgentCoordinationContext;
  intent: CoordinationIntent;
  requestId: string;
  vehicleIds: string[];
}

export interface AgentTask {
  assignedAgents: AgentType[];
  critical: boolean;
  requestId: string;
  taskId: string;
  topic: string;
}

export interface CoordinationOutput {
  agentContributions: AgentOutput[];
  confidenceScore: number;
  conflictMap: Record<string, AgentType[]>;
  consensusRecommendations: string[];
  unifiedInsights: string[];
  unresolvedConflicts: string[];
}
