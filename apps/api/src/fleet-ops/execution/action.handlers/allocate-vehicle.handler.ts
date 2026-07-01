import { ControlDecision } from "../../risk/risk.types";
import {
  ExecutionOutcome,
  type ActionHandler,
  type ActionHandlerResult,
  type ExecutionGuardResult,
  type ExecutionSideEffect,
  type FleetExecutionRequest
} from "../execution.types";
import type { RiskOutput } from "../../risk/risk.types";

export class AllocateVehicleHandler implements ActionHandler {
  async execute(request: FleetExecutionRequest, riskSnapshot: RiskOutput, guardResult: ExecutionGuardResult): Promise<ActionHandlerResult> {
    const sideEffects: ExecutionSideEffect[] = [
      {
        payload: {
          orderId: request.orderId ?? null,
          requestedBy: request.requestedBy ?? null,
          vehicleId: request.vehicleId
        },
        type: "ALLOCATION_WORKFLOW_EVENT"
      }
    ];

    if (guardResult.softRestriction || riskSnapshot.controlDecision === ControlDecision.WARN) {
      sideEffects.push({
        payload: {
          collectionLevel: riskSnapshot.collectionLevel,
          riskScore: riskSnapshot.riskScore,
          vehicleId: request.vehicleId
        },
        type: "SOFT_RESTRICTION_TRACE"
      });
    }

    return {
      outcome: guardResult.softRestriction ? ExecutionOutcome.VEHICLE_ALLOCATED_WITH_SOFT_RESTRICTION : ExecutionOutcome.VEHICLE_ALLOCATED,
      reason: ["Vehicle allocation workflow event prepared."],
      sideEffects
    };
  }
}
