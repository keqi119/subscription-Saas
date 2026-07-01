import type { CollectionPriorityLevel, ControlDecision, RiskOutput } from "../risk/risk.types";

export enum ExecutionActionType {
  VEHICLE_ALLOCATION = "VEHICLE_ALLOCATION",
  LEASE_ACTIVATION = "LEASE_ACTIVATION",
  RESTRICT_VEHICLE = "RESTRICT_VEHICLE",
  MAINTENANCE_TRIGGER = "MAINTENANCE_TRIGGER",
  COLLECTION_ESCALATION = "COLLECTION_ESCALATION"
}

export enum ExecutionOutcome {
  VEHICLE_ALLOCATED = "VEHICLE_ALLOCATED",
  VEHICLE_ALLOCATED_WITH_SOFT_RESTRICTION = "VEHICLE_ALLOCATED_WITH_SOFT_RESTRICTION",
  LEASE_ACTIVATED = "LEASE_ACTIVATED",
  LEASE_ACTIVATED_WITH_OVERRIDE = "LEASE_ACTIVATED_WITH_OVERRIDE",
  VEHICLE_RESTRICTED = "VEHICLE_RESTRICTED",
  MAINTENANCE_TRIGGERED = "MAINTENANCE_TRIGGERED",
  COLLECTION_ESCALATED = "COLLECTION_ESCALATED",
  BLOCKED_BY_CONTROL_GUARD = "BLOCKED_BY_CONTROL_GUARD",
  UNAUTHORIZED_OVERRIDE = "UNAUTHORIZED_OVERRIDE",
  INVALID_ACTION = "INVALID_ACTION",
  MISSING_PR4_DECISION = "MISSING_PR4_DECISION",
  DUPLICATE_SUPPRESSED = "DUPLICATE_SUPPRESSED",
  HANDLER_FAILED = "HANDLER_FAILED"
}

export enum ExecutionStatus {
  SUCCESS = "SUCCESS",
  BLOCKED = "BLOCKED",
  FAILED = "FAILED",
  SKIPPED = "SKIPPED"
}

export interface FleetExecutionRequest {
  actionType: ExecutionActionType;
  idempotencyKey: string;
  leaseId?: string;
  orderId?: string;
  overrideToken?: string;
  payload?: Record<string, unknown>;
  requestedAt?: Date;
  requestedBy?: string;
  vehicleId: string;
}

export interface ExecutionSideEffect {
  payload: Record<string, unknown>;
  type: string;
}

export interface ActionHandlerResult {
  outcome: ExecutionOutcome;
  reason: string[];
  sideEffects: ExecutionSideEffect[];
}

export interface FleetExecutionResult extends ActionHandlerResult {
  actionType: ExecutionActionType;
  decisionUsed: ControlDecision;
  executionId: string;
  status: ExecutionStatus;
  success: boolean;
  timestamp: Date;
  vehicleId: string;
}

export interface ExecutionLogEntry {
  actionType: ExecutionActionType;
  decisionUsed: ControlDecision;
  executionId: string;
  inputSnapshot: RiskOutput;
  outcome: ExecutionOutcome;
  reason: string[];
  status: ExecutionStatus;
  success: boolean;
  timestamp: Date;
  vehicleId: string;
}

export interface ExecutionGuardResult {
  allowed: boolean;
  outcome?: ExecutionOutcome;
  reason: string[];
  requiresOverride: boolean;
  softRestriction: boolean;
}

export interface ActionRegistryEntry {
  actionType: ExecutionActionType;
  allowedCollectionLevels?: CollectionPriorityLevel[];
  allowedDecisions: ControlDecision[];
  handlerKey: string;
  safetyConstraints: string[];
}

export interface ActionHandler {
  execute(request: FleetExecutionRequest, riskSnapshot: RiskOutput, guardResult: ExecutionGuardResult): Promise<ActionHandlerResult>;
}
