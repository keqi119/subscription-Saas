import {
  BillStatus,
  BillType,
  CollectionActionResult,
  CollectionActionType,
  CollectionCaseStatus,
  LeaseStatus,
  OrderStatus,
  PaymentStatus,
  ServiceCasePriority,
  ServiceCaseStatus,
  ServiceCaseType,
  VehicleConditionItemResult,
  VehicleConditionItemSeverity,
  VehicleConditionReportStatus
} from "@prisma/client";

import type { FleetKpiReport, FleetKpiVehicleResult } from "../economics/economics.types";

export enum RiskSignalCode {
  OVERDUE_SIGNAL = "OVERDUE_SIGNAL",
  TIMELINE_CONFLICT_SIGNAL = "TIMELINE_CONFLICT_SIGNAL",
  ROI_COLLAPSE_SIGNAL = "ROI_COLLAPSE_SIGNAL",
  UTILIZATION_DROP_SIGNAL = "UTILIZATION_DROP_SIGNAL",
  CONDITION_DEGRADATION_SIGNAL = "CONDITION_DEGRADATION_SIGNAL",
  ECONOMIC_WARNING_SIGNAL = "ECONOMIC_WARNING_SIGNAL",
  PAYMENT_INCONSISTENCY_SIGNAL = "PAYMENT_INCONSISTENCY_SIGNAL"
}

export enum CollectionPriorityLevel {
  NONE = "NONE",
  D1 = "D1",
  D2 = "D2",
  D3 = "D3",
  D4 = "D4",
  D5 = "D5"
}

export enum ControlDecision {
  ALLOW = "ALLOW",
  WARN = "WARN",
  BLOCK = "BLOCK"
}

export enum RiskSignalSeverity {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL"
}

export interface RiskOperationalStateInput {
  computedState: string;
  confidenceScore: number;
  vehicleId: string;
}

export interface RiskTimelineDay {
  confidence: number;
  conflicts?: unknown[];
  date: string;
  sourceEvents: string[];
  state: string;
  warnings?: string[];
}

export interface RiskReceivableBill {
  amount: number;
  billStatus: BillStatus;
  billType: BillType;
  dueDate: Date;
  id: string;
  paidAmount: number;
  remainingAmount: number;
  vehicleId: string | null;
  writeOffs?: RiskPaymentWriteOffEvidence[];
}

export interface RiskPaymentRecord {
  amount: number;
  id: string;
  paymentStatus: PaymentStatus;
  receivedAt: Date;
  vehicleId: string | null;
}

export interface RiskLeaseInput {
  id: string;
  status: LeaseStatus;
  vehicleId: string | null;
}

export interface RiskOrderInput {
  id: string;
  orderStatus: OrderStatus;
  vehicleId: string | null;
}

export interface RiskServiceCaseInput {
  caseStatus: ServiceCaseStatus;
  caseType: ServiceCaseType;
  closedAt?: Date | null;
  id: string;
  priority: ServiceCasePriority;
  resolvedAt?: Date | null;
  vehicleId: string | null;
}

export interface RiskConditionReportItemInput {
  affectsSafety?: boolean | null;
  id: string;
  repairRequired?: boolean | null;
  result: VehicleConditionItemResult;
  severity: VehicleConditionItemSeverity;
}

export interface RiskConditionReportInput {
  id: string;
  items: RiskConditionReportItemInput[];
  publishedAt?: Date | null;
  reportStatus: VehicleConditionReportStatus;
  vehicleId: string | null;
}

export interface FleetRiskInput {
  asOf: Date;
  collectionCases?: RiskCollectionCaseInput[];
  conditionReports: RiskConditionReportInput[];
  fleetKpis: FleetKpiReport;
  leases: RiskLeaseInput[];
  operationalStates: RiskOperationalStateInput[];
  orders: RiskOrderInput[];
  paymentRecords: RiskPaymentRecord[];
  receivableBills: RiskReceivableBill[];
  serviceCases: RiskServiceCaseInput[];
  timelines: Record<string, RiskTimelineDay[]>;
  vehicleIds: string[];
}

export interface RiskSignal {
  code: RiskSignalCode;
  reason: string;
  severity: RiskSignalSeverity;
  sourceId?: string;
  vehicleId: string;
  weight: number;
}

export interface RiskEvidence {
  amount?: number;
  observedAt?: Date | string | null;
  reason: string;
  source: "collection_action" | "collection_case" | "collection_case_bill" | "payment_record" | "payment_write_off" | "receivable_bill" | "timeline" | "economics";
  sourceId: string;
}

export interface RiskWarning {
  code: string;
  message: string;
  sourceId?: string;
}

export interface RiskOverdueBillRef {
  billId: string;
  dueDate: Date;
  overdueDays: number;
  paidAmount: number;
  remainingAmount: number;
  sourceStatus: BillStatus;
}

export interface RiskPaymentWriteOffEvidence {
  amount: number;
  billId: string | null;
  id: string;
  paymentId: string | null;
  writeOffAt: Date | null;
}

export interface RiskCollectionCaseBillInput {
  billId: string;
  overdueAmount: number;
  overdueDays: number;
}

export interface RiskCollectionActionInput {
  actionResult: CollectionActionResult;
  actionType: CollectionActionType;
  caseId: string;
  id: string;
  promisedAmount?: number | null;
  promisedPayAt?: Date | null;
}

export interface RiskCollectionCaseInput {
  actions: RiskCollectionActionInput[];
  bills: RiskCollectionCaseBillInput[];
  caseStatus: CollectionCaseStatus;
  collectionLevel: CollectionPriorityLevel;
  id: string;
  maxOverdueDays: number;
  orderId: string;
  totalOverdueAmount: number;
  vehicleId: string | null;
}

export interface RiskArrearsPipeline {
  actionRefs: Array<{ actionId: string; actionType: CollectionActionType; result: CollectionActionResult }>;
  billRefs: RiskOverdueBillRef[];
  caseRefs: Array<{ caseId: string; caseStatus: CollectionCaseStatus; collectionLevel: CollectionPriorityLevel }>;
  evidence: RiskEvidence[];
  paymentRefs: Array<{ paymentId: string }>;
  promiseToPayRefs: Array<{ actionId: string; promisedAmount: number | null; promisedPayAt: Date | null }>;
  stage: "NO_OVERDUE" | "OVERDUE_WITHOUT_CASE" | "OVERDUE_WITH_ACTIVE_CASE" | "OVERDUE_WITH_STALE_CASE" | "ESCALATED";
  vehicleId: string;
  warnings: RiskWarning[];
  writeOffRefs: RiskPaymentWriteOffEvidence[];
}

export interface RiskExposure {
  evidence: RiskEvidence[];
  maxOverdueDays: number;
  overdueAmount: number;
  overdueBillCount: number;
  overdueBillRefs: RiskOverdueBillRef[];
  overdueRemainingAmount: number;
  partialPaymentCount: number;
  partialPaymentEvidence: RiskEvidence[];
  score: number;
  unpaidAmount: number;
  warnings: RiskWarning[];
  writeOffEvidence: RiskPaymentWriteOffEvidence[];
}

export interface RiskScoreComponents {
  assetRisk: number;
  financialRisk: number;
  operationalRisk: number;
}

export interface RiskOutput {
  agingBucket?: CollectionPriorityLevel;
  arrearsPipeline?: RiskArrearsPipeline;
  collectionLevel: CollectionPriorityLevel;
  confidence: number;
  controlDecision: ControlDecision;
  evidence?: RiskEvidence[];
  exposureDetail?: RiskExposure;
  exposureScore: number;
  reasons: string[];
  riskScore: number;
  signals: RiskSignalCode[];
  warnings?: RiskWarning[];
  vehicleId: string;
}

export interface FleetRiskAggregate {
  averageExposureScore: number;
  averageRiskScore: number;
  blockedVehicles: number;
  vehicleCount: number;
  warnedVehicles: number;
}

export interface FleetRiskReport {
  fleet: FleetRiskAggregate;
  vehicles: RiskOutput[];
}

export interface RiskVehicleContext {
  exposure: RiskExposure;
  input: FleetRiskInput;
  kpi: FleetKpiVehicleResult;
  operationalState?: RiskOperationalStateInput;
  signals: RiskSignal[];
  timeline: RiskTimelineDay[];
  vehicleId: string;
}

export interface GuardLeaseRef {
  leaseId: string;
  vehicleId: string | null;
}

export interface GuardOrderRef {
  orderId: string;
  vehicleId: string | null;
}

export interface ControlGuardResult {
  allowed: boolean;
  reason: string[];
  riskSnapshot: RiskOutput;
}
