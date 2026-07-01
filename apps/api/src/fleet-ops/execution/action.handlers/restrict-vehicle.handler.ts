import {
  ExecutionOutcome,
  type ActionHandler,
  type ActionHandlerResult,
  type FleetExecutionRequest
} from "../execution.types";
import type { RiskOutput } from "../../risk/risk.types";

export class RestrictVehicleHandler implements ActionHandler {
  async execute(request: FleetExecutionRequest, riskSnapshot: RiskOutput): Promise<ActionHandlerResult> {
    return {
      outcome: ExecutionOutcome.VEHICLE_RESTRICTED,
      reason: ["Vehicle restriction control event prepared from PR-4 decision."],
      sideEffects: [
        {
          payload: {
            decision: riskSnapshot.controlDecision,
            reasons: [...riskSnapshot.reasons],
            vehicleId: request.vehicleId
          },
          type: "VEHICLE_RESTRICTION_CONTROL_EVENT"
        }
      ]
    };
  }
}
