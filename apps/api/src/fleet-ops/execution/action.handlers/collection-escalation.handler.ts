import {
  ExecutionOutcome,
  type ActionHandler,
  type ActionHandlerResult,
  type FleetExecutionRequest
} from "../execution.types";
import type { RiskOutput } from "../../risk/risk.types";

export class CollectionEscalationHandler implements ActionHandler {
  async execute(request: FleetExecutionRequest, riskSnapshot: RiskOutput): Promise<ActionHandlerResult> {
    return {
      outcome: ExecutionOutcome.COLLECTION_ESCALATED,
      reason: ["Collection escalation workflow event prepared from PR-4 collection level."],
      sideEffects: [
        {
          payload: {
            collectionLevel: riskSnapshot.collectionLevel,
            exposureScore: riskSnapshot.exposureScore,
            vehicleId: request.vehicleId
          },
          type: "COLLECTION_ESCALATION_WORKFLOW_EVENT"
        }
      ]
    };
  }
}
