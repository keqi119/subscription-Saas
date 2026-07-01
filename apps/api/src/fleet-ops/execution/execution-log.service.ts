import { Inject, Injectable, Optional } from "@nestjs/common";
import { AuditAction } from "@prisma/client";

import { CollectionPriorityLevel, ControlDecision } from "../risk/risk.types";
import { ExecutionOutcome, ExecutionStatus, type ExecutionLogEntry, type FleetExecutionResult } from "./execution.types";

interface ExecutionAuditSink {
  write(input: {
    action: AuditAction;
    after: ExecutionLogEntry;
    entityId: string;
    entityType: string;
    module: string;
    operatorId?: string;
  }): Promise<void>;
}

@Injectable()
export class ExecutionLogService {
  private readonly logs: ExecutionLogEntry[] = [];
  private readonly resultByIdempotencyKey = new Map<string, FleetExecutionResult>();

  constructor(@Optional() @Inject("FLEET_EXECUTION_AUDIT_SINK") private readonly auditSink?: ExecutionAuditSink) {}

  findResultByIdempotencyKey(idempotencyKey: string) {
    return this.resultByIdempotencyKey.get(idempotencyKey);
  }

  rememberResult(idempotencyKey: string, result: FleetExecutionResult) {
    this.resultByIdempotencyKey.set(idempotencyKey, cloneResult(result));
  }

  async record(entry: ExecutionLogEntry) {
    const clonedEntry = cloneLogEntry(entry);

    this.logs.push(clonedEntry);
    await this.auditSink?.write({
      action: AuditAction.CREATE,
      after: clonedEntry,
      entityId: clonedEntry.vehicleId,
      entityType: "FleetExecution",
      module: "fleet_ops_execution"
    });
  }

  async recordDuplicateAttempt(result: FleetExecutionResult, timestamp: Date) {
    await this.record({
      actionType: result.actionType,
      decisionUsed: result.decisionUsed,
      executionId: result.executionId,
      inputSnapshot: {
        collectionLevel: result.decisionUsed === ControlDecision.BLOCK ? CollectionPriorityLevel.D5 : CollectionPriorityLevel.D1,
        confidence: 0,
        controlDecision: result.decisionUsed,
        exposureScore: 0,
        reasons: result.reason,
        riskScore: 0,
        signals: [],
        vehicleId: result.vehicleId
      },
      outcome: ExecutionOutcome.DUPLICATE_SUPPRESSED,
      reason: ["Duplicate execution request suppressed by idempotency key."],
      status: ExecutionStatus.SKIPPED,
      success: true,
      timestamp,
      vehicleId: result.vehicleId
    });
  }

  listLogs() {
    return this.logs.map(cloneLogEntry);
  }
}

function cloneResult(result: FleetExecutionResult): FleetExecutionResult {
  return {
    ...result,
    reason: [...result.reason],
    sideEffects: result.sideEffects.map((effect) => ({ payload: { ...effect.payload }, type: effect.type })),
    timestamp: new Date(result.timestamp)
  };
}

function cloneLogEntry(entry: ExecutionLogEntry): ExecutionLogEntry {
  return {
    ...entry,
    inputSnapshot: {
      ...entry.inputSnapshot,
      reasons: [...entry.inputSnapshot.reasons],
      signals: [...entry.inputSnapshot.signals]
    },
    reason: [...entry.reason],
    timestamp: new Date(entry.timestamp)
  };
}
