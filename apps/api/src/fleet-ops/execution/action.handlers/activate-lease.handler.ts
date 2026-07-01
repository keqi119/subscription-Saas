import {
  ExecutionOutcome,
  type ActionHandler,
  type ActionHandlerResult,
  type ExecutionGuardResult,
  type FleetExecutionRequest
} from "../execution.types";
import type { RiskOutput } from "../../risk/risk.types";

export class ActivateLeaseHandler implements ActionHandler {
  async execute(request: FleetExecutionRequest, riskSnapshot: RiskOutput, guardResult: ExecutionGuardResult): Promise<ActionHandlerResult> {
    return {
      outcome: guardResult.requiresOverride ? ExecutionOutcome.LEASE_ACTIVATED_WITH_OVERRIDE : ExecutionOutcome.LEASE_ACTIVATED,
      reason: [
        guardResult.requiresOverride
          ? "Lease activation workflow event prepared with override trace."
          : "Lease activation workflow event prepared."
      ],
      sideEffects: [
        {
          payload: {
            leaseId: request.leaseId ?? null,
            overrideUsed: guardResult.requiresOverride,
            riskScore: riskSnapshot.riskScore,
            vehicleId: request.vehicleId
          },
          type: "LEASE_ACTIVATION_WORKFLOW_EVENT"
        }
      ]
    };
  }
}
