import {
  LeaseStatus,
  OrderStatus,
  ServiceCasePriority,
  ServiceCaseStatus,
  ServiceCaseType,
  VehicleConditionItemResult,
  VehicleConditionItemSeverity,
  VehicleConditionReportStatus,
  VehicleStatus
} from "@prisma/client";

export enum VehicleComputedOperationalState {
  RETIRED_OR_INACTIVE = "RETIRED_OR_INACTIVE",
  LEASED_ACTIVE = "LEASED_ACTIVE",
  SERVICE_BLOCKED = "SERVICE_BLOCKED",
  CONDITION_BLOCKED = "CONDITION_BLOCKED",
  RESERVED_OR_ORDER_LOCKED = "RESERVED_OR_ORDER_LOCKED",
  AVAILABLE = "AVAILABLE",
  PREPARATION = "PREPARATION",
  UNKNOWN = "UNKNOWN"
}

export enum VehicleOperationalConfidenceBand {
  HIGH = "HIGH",
  MEDIUM = "MEDIUM",
  LOW = "LOW",
  UNKNOWN = "UNKNOWN"
}

export type VehicleOperationalStateSource =
  | "VEHICLE"
  | "LEASE"
  | "ORDER"
  | "SERVICE_CASE"
  | "CONDITION_REPORT"
  | "SYSTEM";

export interface VehicleOperationalStateVehicleSnapshot {
  createdAt?: Date | null;
  deletedAt?: Date | null;
  id: string;
  status: VehicleStatus;
  updatedAt?: Date | null;
  vehicleNo?: string | null;
}

export interface VehicleOperationalStateLeaseSnapshot {
  activatedAt?: Date | null;
  createdAt?: Date | null;
  deletedAt?: Date | null;
  id: string;
  orderId: string;
  status: LeaseStatus;
  updatedAt?: Date | null;
}

export interface VehicleOperationalStateOrderSnapshot {
  actualDeliveryAt?: Date | null;
  actualReturnAt?: Date | null;
  createdAt?: Date | null;
  deletedAt?: Date | null;
  endDate?: Date | null;
  id: string;
  orderNo?: string | null;
  orderStatus: OrderStatus;
  startDate?: Date | null;
  updatedAt?: Date | null;
  vehicleId?: string | null;
}

export interface VehicleOperationalStateServiceCaseSnapshot {
  cancelledAt?: Date | null;
  caseNo?: string | null;
  caseStatus: ServiceCaseStatus;
  caseType: ServiceCaseType;
  closedAt?: Date | null;
  createdAt?: Date | null;
  deletedAt?: Date | null;
  id: string;
  occurredAt?: Date | null;
  priority: ServiceCasePriority;
  resolvedAt?: Date | null;
  updatedAt?: Date | null;
  vehicleId?: string | null;
}

export interface VehicleOperationalStateConditionReportItemSnapshot {
  affectsSafety?: boolean | null;
  deletedAt?: Date | null;
  id: string;
  repairRequired?: boolean | null;
  result: VehicleConditionItemResult;
  severity: VehicleConditionItemSeverity;
}

export interface VehicleOperationalStateConditionReportSnapshot {
  archivedAt?: Date | null;
  createdAt?: Date | null;
  customerVisible?: boolean | null;
  deletedAt?: Date | null;
  hasFireDamage?: boolean | null;
  hasFloodDamage?: boolean | null;
  hasMajorAccident?: boolean | null;
  hasStructuralDamage?: boolean | null;
  id: string;
  inspectionDate?: Date | null;
  items?: VehicleOperationalStateConditionReportItemSnapshot[];
  publishedAt?: Date | null;
  reportNo?: string | null;
  reportStatus: VehicleConditionReportStatus;
  safetyConclusion?: string | null;
  updatedAt?: Date | null;
  vehicleId?: string | null;
}

export interface VehicleOperationalStateInput {
  asOf?: Date;
  conditionReports: VehicleOperationalStateConditionReportSnapshot[];
  leases: VehicleOperationalStateLeaseSnapshot[];
  orders: VehicleOperationalStateOrderSnapshot[];
  serviceCases: VehicleOperationalStateServiceCaseSnapshot[];
  vehicle: VehicleOperationalStateVehicleSnapshot | null;
}

export interface VehicleOperationalStateEvidence {
  fields: Record<string, unknown>;
  reason: string;
  recordedAt?: Date | null;
  source: VehicleOperationalStateSource;
  sourceId?: string;
}

export interface VehicleOperationalStateSignal {
  direct: boolean;
  evidence: VehicleOperationalStateEvidence;
  freshnessDate?: Date | null;
  priority: number;
  source: VehicleOperationalStateSource;
  sourceId?: string;
  state: VehicleComputedOperationalState;
}

export interface VehicleOperationalStateConflict {
  priority: number;
  reason: string;
  source: VehicleOperationalStateSource;
  sourceId?: string;
  state: VehicleComputedOperationalState;
}

export interface VehicleOperationalStateConfidenceDetail {
  additions: string[];
  band: VehicleOperationalConfidenceBand;
  penalties: string[];
  score: number;
}

export interface VehicleOperationalStateResult {
  asOf: Date;
  computedState: VehicleComputedOperationalState;
  confidenceBand: VehicleOperationalConfidenceBand;
  confidenceScore: number;
  conflicts: VehicleOperationalStateConflict[];
  primaryEvidence: VehicleOperationalStateEvidence;
  supportingEvidence: VehicleOperationalStateEvidence[];
  vehicleId: string | null;
  warnings: string[];
}
