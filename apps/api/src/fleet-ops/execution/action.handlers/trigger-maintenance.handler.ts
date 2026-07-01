import {
  ExecutionOutcome,
  type ActionHandler,
  type ActionHandlerResult,
  type FleetExecutionRequest
} from "../execution.types";
import type { RiskOutput } from "../../risk/risk.types";

export class TriggerMaintenanceHandler implements ActionHandler {
  async execute(request: FleetExecutionRequest, riskSnapshot: RiskOutput): Promise<ActionHandlerResult> {
    return {
      outcome: ExecutionOutcome.MAINTENANCE_TRIGGERED,
      reason: ["Maintenance workflow trigger prepared without direct vehicle mutation."],
      sideEffects: [
        {
          payload: {
            signals: [...riskSnapshot.signals],
            vehicleId: request.vehicleId
          },
          type: "MAINTENANCE_WORKFLOW_TRIGGER"
        }
      ]
    };
  }
}
