import type { FleetKpiReport, FleetKpiVehicleResult } from "../economics/economics.types";
import type { ExecutionLogEntry } from "../execution/execution.types";
import type { FleetRiskReport, RiskOutput } from "../risk/risk.types";

export enum OptimizationSuggestionType {
  UTILIZATION = "UTILIZATION",
  REVENUE = "REVENUE",
  COST = "COST",
  RISK = "RISK",
  ALLOCATION = "ALLOCATION"
}

export enum OptimizationPriority {
  HIGH = "HIGH",
  MEDIUM = "MEDIUM",
  LOW = "LOW"
}

export interface OptimizationExpectedImpact {
  costReduction?: number;
  revenueDelta?: number;
  riskReduction?: number;
  utilizationIncrease?: number;
}

export interface OptimizationSuggestion {
  confidence: number;
  description: string;
  expectedImpact: OptimizationExpectedImpact;
  priority: OptimizationPriority;
  reasoningTrace: string[];
  requiredSignals: string[];
  type: OptimizationSuggestionType;
}

export interface OptimizationOperationalState {
  computedState: string;
  confidenceScore: number;
  vehicleId: string;
}

export interface OptimizationTimelineDay {
  confidence: number;
  conflicts?: unknown[];
  date: string;
  sourceEvents: string[];
  state: string;
}

export interface FleetOptimizationInput {
  asOf: Date;
  executionLogs: ExecutionLogEntry[];
  fleetKpis: FleetKpiReport;
  operationalStates: OptimizationOperationalState[];
  riskReport: FleetRiskReport;
  timelines: Record<string, OptimizationTimelineDay[]>;
  vehicleIds: string[];
}

export interface OptimizationVehicleContext {
  executionLogs: ExecutionLogEntry[];
  kpi: FleetKpiVehicleResult;
  operationalState?: OptimizationOperationalState;
  risk?: RiskOutput;
  timeline: OptimizationTimelineDay[];
  vehicleId: string;
}

export interface VehicleOptimizationOutput {
  fleetLevelInsights: string[];
  optimizationSuggestions: OptimizationSuggestion[];
  strategyRecommendation: string;
  vehicleId: string;
}

export interface FleetOptimizationSummary {
  globalUtilizationEfficiencyScore: number;
  optimizationOpportunityScore: number;
  revenueConcentrationRisk: number;
  riskExposureIndex: number;
  topRecommendations: OptimizationSuggestion[];
}

export interface FleetOptimizationReport {
  fleet: FleetOptimizationSummary;
  fleetLevelInsights: string[];
  vehicles: VehicleOptimizationOutput[];
}
