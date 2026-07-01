import { CollectionPriorityLevel, ControlDecision } from "../risk/risk.types";
import { ExecutionActionType, type ActionRegistryEntry } from "./execution.types";

export const ACTION_REGISTRY: ActionRegistryEntry[] = [
  {
    actionType: ExecutionActionType.VEHICLE_ALLOCATION,
    allowedDecisions: [ControlDecision.ALLOW, ControlDecision.WARN],
    handlerKey: "allocateVehicle",
    safetyConstraints: ["PR4_DECISION_REQUIRED", "BLOCK_REQUIRES_OVERRIDE", "IDEMPOTENCY_KEY_REQUIRED"]
  },
  {
    actionType: ExecutionActionType.LEASE_ACTIVATION,
    allowedDecisions: [ControlDecision.ALLOW, ControlDecision.WARN],
    handlerKey: "activateLease",
    safetyConstraints: ["PR4_DECISION_REQUIRED", "BLOCK_REQUIRES_OVERRIDE", "LEASE_ID_REQUIRED", "IDEMPOTENCY_KEY_REQUIRED"]
  },
  {
    actionType: ExecutionActionType.RESTRICT_VEHICLE,
    allowedDecisions: [ControlDecision.WARN, ControlDecision.BLOCK],
    handlerKey: "restrictVehicle",
    safetyConstraints: ["PR4_DECISION_REQUIRED", "TRACEABLE_RESTRICTION_ONLY", "IDEMPOTENCY_KEY_REQUIRED"]
  },
  {
    actionType: ExecutionActionType.MAINTENANCE_TRIGGER,
    allowedDecisions: [ControlDecision.ALLOW, ControlDecision.WARN, ControlDecision.BLOCK],
    handlerKey: "triggerMaintenance",
    safetyConstraints: ["PR4_DECISION_REQUIRED", "WORKFLOW_TRIGGER_ONLY", "NO_DIRECT_VEHICLE_MUTATION"]
  },
  {
    actionType: ExecutionActionType.COLLECTION_ESCALATION,
    allowedCollectionLevels: [
      CollectionPriorityLevel.D1,
      CollectionPriorityLevel.D2,
      CollectionPriorityLevel.D3,
      CollectionPriorityLevel.D4,
      CollectionPriorityLevel.D5
    ],
    allowedDecisions: [ControlDecision.ALLOW, ControlDecision.WARN, ControlDecision.BLOCK],
    handlerKey: "collectionEscalation",
    safetyConstraints: ["PR4_DECISION_REQUIRED", "WORKFLOW_EVENT_ONLY", "COLLECTION_LEVEL_REQUIRED"]
  }
];

export function findActionRegistryEntry(actionType: ExecutionActionType) {
  return ACTION_REGISTRY.find((entry) => entry.actionType === actionType);
}
