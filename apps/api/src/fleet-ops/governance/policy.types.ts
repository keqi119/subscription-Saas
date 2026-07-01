import type { FleetKpiReport } from "../economics/economics.types";
import type { ExecutionLogEntry } from "../execution/execution.types";
import type { FleetOptimizationReport } from "../optimization/optimization.types";
import type { FleetRiskReport } from "../risk/risk.types";

export enum PolicyDomain {
  RISK = "RISK",
  EXECUTION = "EXECUTION",
  ALLOCATION = "ALLOCATION",
  ECONOMICS = "ECONOMICS",
  UTILIZATION = "UTILIZATION"
}

export interface GovernanceOperationalState {
  computedState: string;
  confidenceScore: number;
  vehicleId: string;
}

export interface GovernanceTimelineDay {
  confidence: number;
  conflicts?: unknown[];
  date: string;
  sourceEvents: string[];
  state: string;
}

export interface FleetGovernanceInput {
  asOf: Date;
  executionLogs: ExecutionLogEntry[];
  fleetKpis: FleetKpiReport;
  optimizationReport: FleetOptimizationReport;
  operationalStates: GovernanceOperationalState[];
  riskReport: FleetRiskReport;
  timelines: Record<string, GovernanceTimelineDay[]>;
  vehicleIds: string[];
}

export interface PolicyExpectedImpact {
  executionAccuracyIncrease?: number;
  revenueIncrease?: number;
  riskReduction?: number;
  utilizationIncrease?: number;
}

export interface PolicySimulationResult {
  currentScore: number;
  projectedScore: number;
  riskWarnings: string[];
}

export interface Policy {
  confidence: number;
  currentConfig: Record<string, unknown>;
  domain: PolicyDomain;
  expectedImpact: PolicyExpectedImpact;
  policyId: string;
  proposedUpdate: Record<string, unknown>;
  reason: string[];
  simulation: PolicySimulationResult;
}

export interface GovernanceReportMetrics {
  policyDriftIndex: number;
  stabilityScore: number;
  systemHealthScore: number;
}

export interface FleetGovernanceReport {
  governanceReport: GovernanceReportMetrics;
  insights: string[];
  policyProposals: Policy[];
  rejectedPolicies: Policy[];
  riskWarnings: string[];
}

export interface PolicyFeedbackMetrics {
  blockedHighRoiVehicles: number;
  executionFailureRate: number;
  failedExecutionCount: number;
  highRoiHighRiskVehicles: number;
  negativeRoiHighUtilizationVehicles: number;
  optimizationOpportunityScore: number;
  revenueConcentrationRisk: number;
  riskExposureIndex: number;
  timelineConflictDensity: number;
}

export interface PolicyEvaluationResult {
  metrics: GovernanceReportMetrics;
  feedback: PolicyFeedbackMetrics;
  insights: string[];
  riskWarnings: string[];
}

export interface PolicyStrategy {
  currentConfig: Record<string, unknown>;
  domain: PolicyDomain;
  expectedImpact: PolicyExpectedImpact;
  minimumEvidence: keyof PolicyFeedbackMetrics;
  policyId: string;
  proposedUpdate: Record<string, unknown>;
  reason: string[];
}
