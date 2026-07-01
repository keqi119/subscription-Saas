import { ControlDecision, type RiskOutput } from "../risk/risk.types";
import { findActionRegistryEntry } from "./action.registry";
import { ExecutionOutcome, type ExecutionGuardResult, type FleetExecutionRequest } from "./execution.types";

export class ExecutionGatewayGuard {
  validate(request: FleetExecutionRequest, riskSnapshot: RiskOutput | null | undefined): ExecutionGuardResult {
    if (!riskSnapshot) {
      return blocked(ExecutionOutcome.MISSING_PR4_DECISION, "PR-4 risk decision snapshot is mandatory.");
    }

    if (riskSnapshot.vehicleId !== request.vehicleId) {
      return blocked(ExecutionOutcome.MISSING_PR4_DECISION, "PR-4 risk decision snapshot does not match execution vehicle.");
    }

    const registryEntry = findActionRegistryEntry(request.actionType);

    if (!registryEntry) {
      return blocked(ExecutionOutcome.INVALID_ACTION, "Execution action is not registered.");
    }

    const decisionAllowed = registryEntry.allowedDecisions.includes(riskSnapshot.controlDecision);
    const hasOverrideToken = isValidOverrideToken(request.overrideToken, request.vehicleId, request.actionType);

    if (!decisionAllowed && riskSnapshot.controlDecision === ControlDecision.BLOCK) {
      if (hasOverrideToken) {
        return {
          allowed: true,
          reason: ["BLOCK decision was overridden by an explicit valid override token."],
          requiresOverride: true,
          softRestriction: false
        };
      }

      if (request.overrideToken != null) {
        return blocked(ExecutionOutcome.UNAUTHORIZED_OVERRIDE, "Override token is not authorized for this execution action.");
      }

      return blocked(ExecutionOutcome.BLOCKED_BY_CONTROL_GUARD, "PR-4 BLOCK decision prevents this execution action.");
    }

    if (!decisionAllowed && request.overrideToken != null) {
      return blocked(ExecutionOutcome.UNAUTHORIZED_OVERRIDE, "Override token is not authorized for this execution action.");
    }

    if (!decisionAllowed) {
      return blocked(ExecutionOutcome.BLOCKED_BY_CONTROL_GUARD, "PR-4 decision is not allowed for this action.");
    }

    if (request.overrideToken != null && !hasOverrideToken) {
      return blocked(ExecutionOutcome.UNAUTHORIZED_OVERRIDE, "Override token is not authorized for this execution action.");
    }

    return {
      allowed: true,
      reason: [riskSnapshot.controlDecision === ControlDecision.WARN ? "WARN decision allows execution with soft restriction trace." : "PR-4 decision allows execution."],
      requiresOverride: false,
      softRestriction: riskSnapshot.controlDecision === ControlDecision.WARN
    };
  }
}

function blocked(outcome: ExecutionOutcome, reason: string): ExecutionGuardResult {
  return {
    allowed: false,
    outcome,
    reason: [reason],
    requiresOverride: false,
    softRestriction: false
  };
}

function isValidOverrideToken(token: string | undefined, vehicleId: string, actionType: string) {
  return token === `OVERRIDE:${vehicleId}:${actionType}`;
}
