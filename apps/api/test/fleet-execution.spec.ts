import { describe, expect, it, vi } from "vitest";

import { ActionOrchestratorService } from "../src/fleet-ops/execution/action-orchestrator.service";
import { ACTION_REGISTRY } from "../src/fleet-ops/execution/action.registry";
import { ExecutionLogService } from "../src/fleet-ops/execution/execution-log.service";
import {
  ExecutionActionType,
  ExecutionOutcome,
  ExecutionStatus,
  type FleetExecutionRequest
} from "../src/fleet-ops/execution/execution.types";
import { FleetExecutionService } from "../src/fleet-ops/execution/fleet-execution.service";
import { CollectionPriorityLevel, ControlDecision, RiskSignalCode, type RiskOutput } from "../src/fleet-ops/risk/risk.types";

const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-05T00:00:00.000Z");
const requestedAt = new Date("2026-07-05T08:30:00.000Z");

describe("ActionOrchestratorService", () => {
  it("executes an ALLOW vehicle allocation through the registered handler and writes a traceable execution log", async () => {
    const logService = new ExecutionLogService();
    const orchestrator = new ActionOrchestratorService(logService);

    const result = await orchestrator.execute(actionRequest(), riskSnapshot({ controlDecision: ControlDecision.ALLOW }));

    expect(result).toEqual(
      expect.objectContaining({
        actionType: ExecutionActionType.VEHICLE_ALLOCATION,
        decisionUsed: ControlDecision.ALLOW,
        outcome: ExecutionOutcome.VEHICLE_ALLOCATED,
        status: ExecutionStatus.SUCCESS,
        success: true,
        vehicleId: "vehicle-1"
      })
    );
    expect(result.sideEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "ALLOCATION_WORKFLOW_EVENT"
        })
      ])
    );
    expect(logService.listLogs()).toEqual([
      expect.objectContaining({
        actionType: ExecutionActionType.VEHICLE_ALLOCATION,
        decisionUsed: ControlDecision.ALLOW,
        inputSnapshot: riskSnapshot({ controlDecision: ControlDecision.ALLOW }),
        outcome: ExecutionOutcome.VEHICLE_ALLOCATED,
        status: ExecutionStatus.SUCCESS,
        success: true,
        timestamp: requestedAt
      })
    ]);
  });

  it("persists execution logs through the optional audit sink when provided", async () => {
    type TestAuditWriteInput = {
      action: string;
      after: {
        executionId: string;
        inputSnapshot: RiskOutput;
        outcome: ExecutionOutcome;
      };
      entityId: string;
      entityType: string;
      module: string;
    };
    const auditWrite = vi.fn(async (input: TestAuditWriteInput) => {
      void input;
    });
    const auditService = {
      write: auditWrite
    };
    const logService = new ExecutionLogService(auditService);
    const result = await new ActionOrchestratorService(logService).execute(actionRequest({ idempotencyKey: "audit-allocation" }), riskSnapshot());

    expect(result.status).toBe(ExecutionStatus.SUCCESS);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE",
        entityId: "vehicle-1",
        entityType: "FleetExecution",
        module: "fleet_ops_execution"
      })
    );
    expect(auditWrite.mock.calls[0]?.[0].after).toEqual(
      expect.objectContaining({
        executionId: result.executionId,
        inputSnapshot: riskSnapshot(),
        outcome: ExecutionOutcome.VEHICLE_ALLOCATED
      })
    );
  });

  it("allows WARN execution while applying a soft restriction trace", async () => {
    const result = await new ActionOrchestratorService(new ExecutionLogService()).execute(
      actionRequest(),
      riskSnapshot({ collectionLevel: CollectionPriorityLevel.D3, controlDecision: ControlDecision.WARN })
    );

    expect(result.status).toBe(ExecutionStatus.SUCCESS);
    expect(result.outcome).toBe(ExecutionOutcome.VEHICLE_ALLOCATED_WITH_SOFT_RESTRICTION);
    expect(result.sideEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "SOFT_RESTRICTION_TRACE"
        })
      ])
    );
  });

  it("blocks lease activation when PR-4 decision is BLOCK and only executes with a valid override token", async () => {
    const logService = new ExecutionLogService();
    const orchestrator = new ActionOrchestratorService(logService);
    const request = actionRequest({
      actionType: ExecutionActionType.LEASE_ACTIVATION,
      idempotencyKey: "lease-activation-blocked",
      leaseId: "lease-1"
    });
    const blockedRisk = riskSnapshot({ controlDecision: ControlDecision.BLOCK });

    const blocked = await orchestrator.execute(request, blockedRisk);
    const invalidOverride = await orchestrator.execute({ ...request, idempotencyKey: "bad-override", overrideToken: "bad-token" }, blockedRisk);
    const approved = await orchestrator.execute(
      { ...request, idempotencyKey: "lease-activation-override", overrideToken: "OVERRIDE:vehicle-1:LEASE_ACTIVATION" },
      blockedRisk
    );

    expect(blocked).toEqual(
      expect.objectContaining({
        outcome: ExecutionOutcome.BLOCKED_BY_CONTROL_GUARD,
        status: ExecutionStatus.BLOCKED,
        success: false
      })
    );
    expect(invalidOverride.outcome).toBe(ExecutionOutcome.UNAUTHORIZED_OVERRIDE);
    expect(approved).toEqual(
      expect.objectContaining({
        decisionUsed: ControlDecision.BLOCK,
        outcome: ExecutionOutcome.LEASE_ACTIVATED_WITH_OVERRIDE,
        status: ExecutionStatus.SUCCESS,
        success: true
      })
    );
    expect(logService.listLogs()).toHaveLength(3);
  });

  it("suppresses duplicate execution by idempotency key while logging the retry attempt", async () => {
    const logService = new ExecutionLogService();
    const orchestrator = new ActionOrchestratorService(logService);
    const request = actionRequest({ idempotencyKey: "duplicate-allocation" });
    const risk = riskSnapshot({ controlDecision: ControlDecision.ALLOW });

    const first = await orchestrator.execute(request, risk);
    const second = await orchestrator.execute(request, risk);

    expect(second).toEqual(first);
    expect(logService.listLogs()).toEqual([
      expect.objectContaining({
        executionId: first.executionId,
        outcome: ExecutionOutcome.VEHICLE_ALLOCATED
      }),
      expect.objectContaining({
        executionId: first.executionId,
        outcome: ExecutionOutcome.DUPLICATE_SUPPRESSED,
        status: ExecutionStatus.SKIPPED,
        success: true
      })
    ]);
  });

  it("rejects execution when the PR-4 risk snapshot is missing", async () => {
    const logService = new ExecutionLogService();
    const result = await new ActionOrchestratorService(logService).execute(actionRequest({ idempotencyKey: "missing-pr4" }), undefined as never);

    expect(result).toEqual(
      expect.objectContaining({
        outcome: ExecutionOutcome.MISSING_PR4_DECISION,
        status: ExecutionStatus.BLOCKED,
        success: false
      })
    );
    expect(logService.listLogs()[0]).toEqual(
      expect.objectContaining({
        outcome: ExecutionOutcome.MISSING_PR4_DECISION,
        status: ExecutionStatus.BLOCKED
      })
    );
  });

  it("registers all supported execution actions with deterministic guard constraints", () => {
    expect(ACTION_REGISTRY.map((entry) => entry.actionType).sort()).toEqual([
      ExecutionActionType.COLLECTION_ESCALATION,
      ExecutionActionType.LEASE_ACTIVATION,
      ExecutionActionType.MAINTENANCE_TRIGGER,
      ExecutionActionType.RESTRICT_VEHICLE,
      ExecutionActionType.VEHICLE_ALLOCATION
    ].sort());
    expect(ACTION_REGISTRY.every((entry) => entry.allowedDecisions.length > 0)).toBe(true);
  });
});

describe("FleetExecutionService", () => {
  it("fetches the PR-4 risk snapshot and executes only through the orchestrator", async () => {
    const riskService = {
      getFleetRisk: vi.fn(async () => ({
        fleet: {
          averageExposureScore: 0,
          averageRiskScore: 10,
          blockedVehicles: 0,
          vehicleCount: 1,
          warnedVehicles: 0
        },
        vehicles: [riskSnapshot({ controlDecision: ControlDecision.ALLOW })]
      }))
    };
    const orchestrator = {
      execute: vi.fn(async () => ({
        actionType: ExecutionActionType.VEHICLE_ALLOCATION,
        decisionUsed: ControlDecision.ALLOW,
        executionId: "exec-service",
        outcome: ExecutionOutcome.VEHICLE_ALLOCATED,
        reason: ["Vehicle allocation workflow event prepared."],
        sideEffects: [],
        status: ExecutionStatus.SUCCESS,
        success: true,
        timestamp: requestedAt,
        vehicleId: "vehicle-1"
      }))
    };
    const service = new FleetExecutionService(riskService as never, orchestrator as never);
    const request = actionRequest();

    const result = await service.executeAction(request, from, to);

    expect(riskService.getFleetRisk).toHaveBeenCalledWith(["vehicle-1"], from, to);
    expect(orchestrator.execute).toHaveBeenCalledWith(request, riskSnapshot({ controlDecision: ControlDecision.ALLOW }));
    expect(result.status).toBe(ExecutionStatus.SUCCESS);
  });
});

function actionRequest(overrides: Partial<FleetExecutionRequest> = {}): FleetExecutionRequest {
  return {
    actionType: ExecutionActionType.VEHICLE_ALLOCATION,
    idempotencyKey: "allocation-1",
    orderId: "order-1",
    requestedAt,
    requestedBy: "ops-user-1",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function riskSnapshot(overrides: Partial<RiskOutput> = {}): RiskOutput {
  return {
    collectionLevel: CollectionPriorityLevel.D1,
    confidence: 90,
    controlDecision: ControlDecision.ALLOW,
    exposureScore: 0,
    reasons: ["Risk signals within normal control tolerance."],
    riskScore: 10,
    signals: [RiskSignalCode.OVERDUE_SIGNAL],
    vehicleId: "vehicle-1",
    ...overrides
  };
}
