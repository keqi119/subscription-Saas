import type { MultiAgentCoordinationRequest, CoordinationOutput } from "./coordination/agent.types";
import type { FleetKpiVehicleResult } from "./economics/economics.types";
import type { ExecutionLogEntry, FleetExecutionResult } from "./execution/execution.types";
import type { FleetGovernanceReport } from "./governance/policy.types";
import type { VehicleOptimizationOutput } from "./optimization/optimization.types";
import type { RiskOutput } from "./risk/risk.types";
import type { TimelineDay } from "./timeline/vehicle-timeline.types";
import type { VehicleOperationalStateResult } from "./vehicle-operational-state.types";

export type FleetOpsEngineHealthStatus = "OK" | "WARN" | "ERROR";

export interface FleetOpsHealthContract {
  coordinationEngine: FleetOpsEngineHealthStatus;
  economicsEngine: FleetOpsEngineHealthStatus;
  executionEngine: FleetOpsEngineHealthStatus;
  governanceEngine: FleetOpsEngineHealthStatus;
  optimizationEngine: FleetOpsEngineHealthStatus;
  riskEngine: FleetOpsEngineHealthStatus;
  stateEngine: FleetOpsEngineHealthStatus;
  timelineEngine: FleetOpsEngineHealthStatus;
}

export interface FleetOpsRangeContract {
  from: Date;
  to: Date;
  vehicleIds?: string[];
}

export type FleetOpsVehicleStateContract = VehicleOperationalStateResult;
export type FleetOpsTimelineContract = TimelineDay[];
export type FleetOpsVehicleKpiContract = FleetKpiVehicleResult;
export type FleetOpsVehicleRiskContract = RiskOutput;
export type FleetOpsExecutionContract = FleetExecutionResult | ExecutionLogEntry;
export type FleetOpsVehicleOptimizationContract = VehicleOptimizationOutput;
export type FleetOpsGovernanceContract = FleetGovernanceReport;
export type FleetOpsCoordinationInputContract = MultiAgentCoordinationRequest;
export type FleetOpsCoordinationContract = CoordinationOutput;

export interface FleetOpsForbiddenWritePattern {
  expression: RegExp;
  label: string;
}

export const FLEET_OPS_FORBIDDEN_WRITE_PATTERNS: FleetOpsForbiddenWritePattern[] = [
  { expression: /\.create\s*\(/, label: "prisma-create-call" },
  { expression: /\.update\s*\(/, label: "prisma-update-call" },
  { expression: /\.delete\s*\(/, label: "prisma-delete-call" },
  { expression: /\.upsert\s*\(/, label: "prisma-upsert-call" },
  { expression: new RegExp("\\$" + "executeRaw\\b"), label: "raw-execute-call" },
  { expression: new RegExp("\\$" + "queryRawUnsafe\\b"), label: "unsafe-raw-query-call" }
];
