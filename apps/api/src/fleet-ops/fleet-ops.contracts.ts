import type { MultiAgentCoordinationRequest, CoordinationOutput } from "./coordination/agent.types";
import type { FleetKpiVehicleResult } from "./economics/economics.types";
import type { ExecutionLogEntry, FleetExecutionResult } from "./execution/execution.types";
import type { FleetGovernanceReport } from "./governance/policy.types";
import type { VehicleOptimizationOutput } from "./optimization/optimization.types";
import type { RiskOutput } from "./risk/risk.types";
import type { TimelineDay } from "./timeline/vehicle-timeline.types";
import type { VehicleOperationalStateResult } from "./vehicle-operational-state.types";
import type { FleetOpsEngineHealthStatus } from "./fleet-ops.shared-contracts";

export {
  FLEET_OPS_FORBIDDEN_WRITE_PATTERNS,
  classifyFleetOpsStaticScanHit
} from "./fleet-ops.shared-contracts";
export type {
  FleetOpsConfidence,
  FleetOpsConfidenceBand,
  FleetOpsConflict,
  FleetOpsConflictSeverity,
  FleetOpsDateRange,
  FleetOpsEngineHealth,
  FleetOpsEngineHealthStatus,
  FleetOpsEntityRef,
  FleetOpsEvidence,
  FleetOpsEvidenceSource,
  FleetOpsForbiddenWritePattern,
  FleetOpsReadOnlyResult,
  FleetOpsSharedInvariantResult,
  FleetOpsSharedInvariantStatus,
  FleetOpsStaticScanClassification,
  FleetOpsStaticScanFinding,
  FleetOpsWarning
} from "./fleet-ops.shared-contracts";

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
