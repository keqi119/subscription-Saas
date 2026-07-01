import {
  BillStatus,
  BillType,
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
  PAYMENT_INCONSISTENCY_SIGNAL = "PAYMENT_INCONSISTENCY_SIGNAL"
}

export enum CollectionPriorityLevel {
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

export interface RiskExposure {
  maxOverdueDays: number;
  overdueAmount: number;
  partialPaymentCount: number;
  score: number;
  unpaidAmount: number;
}

export interface RiskScoreComponents {
  assetRisk: number;
  financialRisk: number;
  operationalRisk: number;
}

export interface RiskOutput {
  collectionLevel: CollectionPriorityLevel;
  confidence: number;
  controlDecision: ControlDecision;
  exposureScore: number;
  reasons: string[];
  riskScore: number;
  signals: RiskSignalCode[];
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
