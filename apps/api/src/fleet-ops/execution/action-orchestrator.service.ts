import { Injectable } from "@nestjs/common";

import { CollectionPriorityLevel, ControlDecision, type RiskOutput } from "../risk/risk.types";
import { AllocateVehicleHandler } from "./action.handlers/allocate-vehicle.handler";
import { ActivateLeaseHandler } from "./action.handlers/activate-lease.handler";
import { CollectionEscalationHandler } from "./action.handlers/collection-escalation.handler";
import { RestrictVehicleHandler } from "./action.handlers/restrict-vehicle.handler";
import { TriggerMaintenanceHandler } from "./action.handlers/trigger-maintenance.handler";
import { findActionRegistryEntry } from "./action.registry";
import { ExecutionGatewayGuard } from "./execution-gateway.guard";
import { ExecutionLogService } from "./execution-log.service";
import {
  ExecutionOutcome,
  ExecutionStatus,
  type ActionHandler,
  type ActionHandlerResult,
  type FleetExecutionRequest,
  type FleetExecutionResult
} from "./execution.types";

@Injectable()
export class ActionOrchestratorService {
  private readonly gateway = new ExecutionGatewayGuard();
  private readonly handlers: Record<string, ActionHandler> = {
    activateLease: new ActivateLeaseHandler(),
    allocateVehicle: new AllocateVehicleHandler(),
    collectionEscalation: new CollectionEscalationHandler(),
    restrictVehicle: new RestrictVehicleHandler(),
    triggerMaintenance: new TriggerMaintenanceHandler()
  };

  constructor(private readonly executionLogService: ExecutionLogService = new ExecutionLogService()) {}

  async execute(request: FleetExecutionRequest, riskSnapshot: RiskOutput | null | undefined): Promise<FleetExecutionResult> {
    const timestamp = request.requestedAt ?? new Date();
    const duplicate = this.executionLogService.findResultByIdempotencyKey(request.idempotencyKey);

    if (duplicate) {
      await this.executionLogService.recordDuplicateAttempt(duplicate, timestamp);

      return duplicate;
    }

    const executionId = buildExecutionId(request);
    const guardResult = this.gateway.validate(request, riskSnapshot);
    const effectiveRiskSnapshot = riskSnapshot ?? missingRiskSnapshot(request.vehicleId);

    if (!guardResult.allowed) {
      const result = buildResult({
        executionId,
        handlerResult: {
          outcome: guardResult.outcome ?? ExecutionOutcome.BLOCKED_BY_CONTROL_GUARD,
          reason: guardResult.reason,
          sideEffects: []
        },
        request,
        riskSnapshot: effectiveRiskSnapshot,
        status: ExecutionStatus.BLOCKED,
        success: false,
        timestamp
      });
      await this.executionLogService.record(toLogEntry(result, effectiveRiskSnapshot));
      this.executionLogService.rememberResult(request.idempotencyKey, result);

      return result;
    }

    const handler = this.resolveHandler(request);

    if (!handler) {
      const result = buildResult({
        executionId,
        handlerResult: {
          outcome: ExecutionOutcome.INVALID_ACTION,
          reason: ["Execution action is not registered."],
          sideEffects: []
        },
        request,
        riskSnapshot: effectiveRiskSnapshot,
        status: ExecutionStatus.FAILED,
        success: false,
        timestamp
      });
      await this.executionLogService.record(toLogEntry(result, effectiveRiskSnapshot));
      this.executionLogService.rememberResult(request.idempotencyKey, result);

      return result;
    }

    try {
      const handlerResult = await handler.execute(request, effectiveRiskSnapshot, guardResult);
      const result = buildResult({
        executionId,
        handlerResult,
        request,
        riskSnapshot: effectiveRiskSnapshot,
        status: ExecutionStatus.SUCCESS,
        success: true,
        timestamp
      });
      await this.executionLogService.record(toLogEntry(result, effectiveRiskSnapshot));
      this.executionLogService.rememberResult(request.idempotencyKey, result);

      return result;
    } catch (error) {
      const result = buildResult({
        executionId,
        handlerResult: {
          outcome: ExecutionOutcome.HANDLER_FAILED,
          reason: [error instanceof Error ? error.message : "Execution handler failed."],
          sideEffects: []
        },
        request,
        riskSnapshot: effectiveRiskSnapshot,
        status: ExecutionStatus.FAILED,
        success: false,
        timestamp
      });
      await this.executionLogService.record(toLogEntry(result, effectiveRiskSnapshot));
      this.executionLogService.rememberResult(request.idempotencyKey, result);

      return result;
    }
  }

  private resolveHandler(request: FleetExecutionRequest) {
    const registryEntry = findActionRegistryEntry(request.actionType);

    if (!registryEntry) {
      return null;
    }

    return this.handlers[registryEntry.handlerKey] ?? null;
  }
}

function buildResult(input: {
  executionId: string;
  handlerResult: ActionHandlerResult;
  request: FleetExecutionRequest;
  riskSnapshot: RiskOutput;
  status: ExecutionStatus;
  success: boolean;
  timestamp: Date;
}): FleetExecutionResult {
  return {
    actionType: input.request.actionType,
    decisionUsed: input.riskSnapshot.controlDecision,
    executionId: input.executionId,
    outcome: input.handlerResult.outcome,
    reason: input.handlerResult.reason,
    sideEffects: input.handlerResult.sideEffects,
    status: input.status,
    success: input.success,
    timestamp: input.timestamp,
    vehicleId: input.request.vehicleId
  };
}

function toLogEntry(result: FleetExecutionResult, riskSnapshot: RiskOutput) {
  return {
    actionType: result.actionType,
    decisionUsed: result.decisionUsed,
    executionId: result.executionId,
    inputSnapshot: riskSnapshot,
    outcome: result.outcome,
    reason: result.reason,
    status: result.status,
    success: result.success,
    timestamp: result.timestamp,
    vehicleId: result.vehicleId
  };
}

function buildExecutionId(request: FleetExecutionRequest) {
  return `exec-${request.idempotencyKey}`;
}

function missingRiskSnapshot(vehicleId: string): RiskOutput {
  return {
    collectionLevel: CollectionPriorityLevel.D5,
    confidence: 0,
    controlDecision: ControlDecision.BLOCK,
    exposureScore: 100,
    reasons: ["PR-4 risk decision snapshot is mandatory."],
    riskScore: 100,
    signals: [],
    vehicleId
  };
}
