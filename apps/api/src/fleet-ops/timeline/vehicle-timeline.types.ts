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

export enum TimelineState {
  LEASED = "LEASED",
  AVAILABLE = "AVAILABLE",
  MAINTENANCE = "MAINTENANCE",
  RESERVED = "RESERVED",
  SERVICE_BLOCKED = "SERVICE_BLOCKED",
  UNKNOWN = "UNKNOWN"
}

export enum TimelineEventSource {
  LEASE = "lease",
  ORDER = "order",
  SERVICE_CASE = "service_case",
  CONDITION_REPORT = "condition_report",
  VEHICLE = "vehicle"
}

export const TIMELINE_CURRENT_STATUS_PROJECTED_WARNING = "CURRENT_STATUS_PROJECTED_ACROSS_RANGE";

export interface TimelineDay {
  confidence: number;
  conflicts: TimelineConflict[];
  date: string;
  sourceEvents: string[];
  state: TimelineState;
  warnings: string[];
}

export interface TimelineConflict {
  loserEventId: string;
  loserState: TimelineState;
  reason: string;
  winnerEventId: string;
  winnerState: TimelineState;
}

export interface TimelineEvent {
  baseConfidence: number;
  endDate: string;
  eventId: string;
  isFallback: boolean;
  missingEndTimestamp: boolean;
  missingStartTimestamp: boolean;
  source: TimelineEventSource;
  sourceId: string;
  startDate: string;
  state: TimelineState;
  timestamp: Date | null;
  warnings: string[];
}

export interface VehicleTimelineRawInput {
  conditionReports: VehicleTimelineConditionReportInput[];
  from: Date;
  leases: VehicleTimelineLeaseInput[];
  orders: VehicleTimelineOrderInput[];
  serviceCases: VehicleTimelineServiceCaseInput[];
  to: Date;
  vehicle: VehicleTimelineVehicleInput | null;
  vehicleId: string;
}

export interface VehicleTimelineVehicleInput {
  createdAt?: Date | null;
  deletedAt?: Date | null;
  id: string;
  status: VehicleStatus;
  updatedAt?: Date | null;
  vehicleNo?: string | null;
}

export interface VehicleTimelineLeaseInput {
  activatedAt?: Date | null;
  createdAt?: Date | null;
  deletedAt?: Date | null;
  id: string;
  order?: VehicleTimelineLeaseOrderInput | null;
  orderId: string;
  status: LeaseStatus;
  updatedAt?: Date | null;
}

export interface VehicleTimelineLeaseOrderInput {
  actualDeliveryAt?: Date | null;
  actualReturnAt?: Date | null;
  endDate?: Date | null;
  orderStatus?: OrderStatus | null;
  startDate?: Date | null;
  vehicleId?: string | null;
}

export interface VehicleTimelineOrderInput {
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

export interface VehicleTimelineServiceCaseInput {
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

export interface VehicleTimelineConditionReportInput {
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
  items: VehicleTimelineConditionReportItemInput[];
  publishedAt?: Date | null;
  reportNo?: string | null;
  reportStatus: VehicleConditionReportStatus;
  safetyConclusion?: string | null;
  updatedAt?: Date | null;
  vehicleId?: string | null;
}

export interface VehicleTimelineConditionReportItemInput {
  affectsSafety?: boolean | null;
  deletedAt?: Date | null;
  id: string;
  repairRequired?: boolean | null;
  result: VehicleConditionItemResult;
  severity: VehicleConditionItemSeverity;
}

export interface TimelineDateRange {
  fromDate: string;
  toDate: string;
}
