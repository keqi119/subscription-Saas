import {
  AssetWorkOrderEvidenceAction,
  AssetWorkOrderEvidenceType,
  AssetWorkOrderEventType,
  AssetWorkOrderPriority,
  AssetWorkOrderStatus,
  AssetWorkOrderType,
  Prisma,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionStatus,
  VehicleOperationalRestrictionType,
  type AssetWorkOrder,
  type AssetWorkOrderEvidence,
  type AssetWorkOrderEvent,
  type VehicleOperationalRestriction
} from "@prisma/client";

export type StableAssetOperationSource = Readonly<{
  type: string;
  id: string;
  key: string;
}>;

export type AssetOperationSnapshot = Readonly<Prisma.InputJsonObject>;

interface AssetOperationCommandMetadata {
  readonly actorId: string | null;
  readonly occurredAt: Date;
  readonly source: StableAssetOperationSource;
}

export interface CreateWorkOrderCommand extends AssetOperationCommandMetadata {
  readonly assetOwnerId: string | null;
  readonly authoritySnapshot: AssetOperationSnapshot;
  readonly contractId: string | null;
  readonly costConfirmationRequired: boolean;
  readonly customerId: string | null;
  readonly description: string | null;
  readonly metadata: AssetOperationSnapshot | null;
  readonly orderId: string | null;
  readonly priority: AssetWorkOrderPriority;
  readonly relatedWorkOrderId: string | null;
  readonly vehicleId: string;
  readonly workOrderType: AssetWorkOrderType;
}

export interface AssignWorkOrderCommand extends AssetOperationCommandMetadata {
  readonly assignedUserId: string;
  readonly detailSnapshot: AssetOperationSnapshot;
  readonly expectedVersion: number;
  readonly scheduledAt: Date | null;
  readonly slaDueAt: Date | null;
  readonly workOrderId: string;
}

export interface TransitionWorkOrderCommand extends AssetOperationCommandMetadata {
  readonly closeReason: string | null;
  readonly detailSnapshot: AssetOperationSnapshot;
  readonly expectedVersion: number;
  readonly solution: string | null;
  readonly targetStatus: AssetWorkOrderStatus;
  readonly workOrderId: string;
}

export interface AppendNoteCommand extends AssetOperationCommandMetadata {
  readonly note: string;
  readonly workOrderId: string;
}

export interface AppendWorkOrderEventCommand extends AssetOperationCommandMetadata {
  readonly afterStatus: AssetWorkOrderStatus | null;
  readonly beforeStatus: AssetWorkOrderStatus | null;
  readonly detailSnapshot: AssetOperationSnapshot;
  readonly eventType: AssetWorkOrderEventType;
  readonly workOrderId: string;
}

export interface AppendEvidenceCommand extends AssetOperationCommandMetadata {
  readonly action: AssetWorkOrderEvidenceAction;
  readonly capturedAt: Date | null;
  readonly captureMetadata: AssetOperationSnapshot | null;
  readonly contentSha256: string | null;
  readonly eventId: string | null;
  readonly evidenceType: AssetWorkOrderEvidenceType;
  readonly fileId: string | null;
  readonly supersedesEvidenceId: string | null;
  readonly workOrderId: string;
}

export interface CreateRestrictionCommand extends AssetOperationCommandMetadata {
  readonly conditionsSnapshot: AssetOperationSnapshot;
  readonly evidenceSnapshot: AssetOperationSnapshot | null;
  readonly restrictionType: VehicleOperationalRestrictionType;
  readonly scopes: readonly VehicleOperationalRestrictionScope[];
  readonly severity: VehicleOperationalRestrictionSeverity;
  readonly startedAt: Date;
  readonly vehicleId: string;
  readonly workOrderId: string | null;
}

export interface ReleaseRestrictionCommand extends AssetOperationCommandMetadata {
  readonly actorId: string;
  readonly releaseReason: string;
  readonly releaseSnapshot: AssetOperationSnapshot;
  readonly restrictionId: string;
  readonly targetStatus: Exclude<VehicleOperationalRestrictionStatus, "ACTIVE">;
}

export interface WorkOrderCommandOutcome {
  readonly event: AssetWorkOrderEvent;
  readonly workOrder: AssetWorkOrder;
  readonly wrote: boolean;
}

export interface EvidenceCommandOutcome extends WorkOrderCommandOutcome {
  readonly evidence: AssetWorkOrderEvidence;
}

export interface RestrictionCommandOutcome {
  readonly event: AssetWorkOrderEvent | null;
  readonly restriction: VehicleOperationalRestriction;
  readonly workOrder: AssetWorkOrder | null;
  readonly wrote: boolean;
}

export interface AssetWorkOrderDetailProjection {
  readonly evidence: readonly AssetWorkOrderEvidence[];
  readonly events: readonly AssetWorkOrderEvent[];
  readonly restrictions: readonly VehicleOperationalRestriction[];
  readonly workOrder: AssetWorkOrder;
}
