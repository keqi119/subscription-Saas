import {
  BillType,
  DepositTransactionStatus,
  DepositTransactionType,
  PaymentStatus,
  ServiceCasePriority,
  ServiceCaseType,
  VehicleDepreciationRecordStatus
} from "@prisma/client";

export enum EconomicTimelineState {
  LEASED = "LEASED",
  AVAILABLE = "AVAILABLE",
  MAINTENANCE = "MAINTENANCE",
  RESERVED = "RESERVED",
  SERVICE_BLOCKED = "SERVICE_BLOCKED",
  UNKNOWN = "UNKNOWN"
}

export type EconomicConfidenceBand = "HIGH" | "MEDIUM" | "LOW";

export interface EconomicOperationalStateSnapshot {
  confidenceScore: number;
  vehicleId: string;
}

export interface EconomicTimelineDay {
  confidence: number;
  conflicts?: unknown[];
  date: string;
  sourceEvents: string[];
  state: EconomicTimelineState;
  warnings?: string[];
}

export interface FleetKpiVehicleInput {
  equityBase: number;
  investedCapital: number;
  vehicleId: string;
}

export interface EconomicPaymentRecord {
  amount: number;
  billId?: string | null;
  billType: BillType | null;
  id: string;
  paymentStatus: PaymentStatus;
  receivedAt: Date | null;
  vehicleId: string | null;
}

export interface EconomicReceivableBill {
  amount: number;
  billType: BillType;
  dueDate: Date | null;
  id: string;
  vehicleId: string | null;
}

export interface EconomicPaymentWriteOffAllocation {
  amount: number;
  billId: string | null;
  billType: BillType | null;
  id: string;
  paymentId: string;
  vehicleId: string | null;
  writeOffAt: Date | null;
}

export interface EconomicDepositLedger {
  amount: number;
  id: string;
  occurredAt: Date | null;
  transactionStatus: DepositTransactionStatus;
  transactionType: DepositTransactionType;
  vehicleId: string | null;
}

export interface EconomicDepreciationRecord {
  amount: number;
  recordStatus: VehicleDepreciationRecordStatus;
  vehicleId: string;
}

export interface EconomicServiceCase {
  caseType: ServiceCaseType;
  id: string;
  priority: ServiceCasePriority;
  vehicleId: string | null;
}

export interface EconomicWriteOffAdjustment {
  amount: number;
  vehicleId: string | null;
}

export interface FleetEconomicInput {
  depositLedgers?: EconomicDepositLedger[];
  depreciationRecords: EconomicDepreciationRecord[];
  from: Date;
  operationalStates: EconomicOperationalStateSnapshot[];
  paymentRecords: EconomicPaymentRecord[];
  receivableBills?: EconomicReceivableBill[];
  serviceCases: EconomicServiceCase[];
  timelines: Record<string, EconomicTimelineDay[]>;
  to: Date;
  vehicles: FleetKpiVehicleInput[];
  writeOffAllocations?: EconomicPaymentWriteOffAllocation[];
  writeOffAdjustments: EconomicWriteOffAdjustment[];
}

export interface FleetKpiUtilization {
  economicUtilizationSource?: "timeline_leased_days_with_revenue_support";
  leasedDays: number;
  operatingDays: number;
  timelineWarningCount?: number;
  utilizationRate: number;
}

export interface FleetKpiEconomics {
  cost: number;
  netIncome: number;
  revenue: number;
  roe: number;
  roi: number;
}

export interface FleetKpiDowntimeBreakdown {
  IDLE: number;
  MAINTENANCE: number;
  RESERVED: number;
  SERVICE: number;
}

export interface FleetKpiDowntime {
  breakdown: FleetKpiDowntimeBreakdown;
  downtimeCost: number;
  trace?: FleetKpiDowntimeTrace[];
  totalDowntimeDays: number;
}

export interface FleetKpiDowntimeTrace {
  cost: number;
  date: string;
  sourceEvents: string[];
  state: EconomicTimelineState;
}

export interface FleetKpiAttribution {
  depositExcludedRevenue?: number;
  ignoredRevenue?: number;
  leaseRevenue: number;
  penaltyRevenue: number;
  recognizedPaymentCount?: number;
  unassignedRevenue?: number;
  writeOffImpact: number;
}

export interface FleetKpiConfidence {
  band: EconomicConfidenceBand;
  reasons?: string[];
  score: number;
}

export interface FleetKpiEvidence {
  amount?: number;
  reason: string;
  source:
    | "denominator"
    | "deposit_ledger"
    | "payment_record"
    | "payment_write_off"
    | "receivable_bill"
    | "timeline";
  sourceId: string;
}

export type FleetKpiWarning =
  | "DEPOSIT_EXCLUDED_FROM_OPERATING_REVENUE"
  | "MISSING_PAYMENT_RECEIVED_AT"
  | "MISSING_RECEIVABLE_DUE_DATE"
  | "NON_CONFIRMED_PAYMENT_EXCLUDED"
  | "TIMELINE_FALLBACK_CONFIDENCE_PENALTY"
  | "UNASSIGNED_PAYMENT_EXCLUDED"
  | "WRITE_OFF_WITHOUT_CLEAR_BILL_LINKAGE"
  | "ZERO_OR_MISSING_DENOMINATOR"
  | string;

export interface FleetKpiCashflowBucket {
  deposit: number;
  operating: number;
  unassigned?: number;
}

export interface FleetKpiWriteOffCashflow {
  appliedDeposit: number;
  appliedOperating: number;
  unlinked: number;
}

export interface FleetKpiCashflow {
  actual: FleetKpiCashflowBucket;
  evidence: FleetKpiEvidence[];
  planned: FleetKpiCashflowBucket;
  warnings: FleetKpiWarning[];
  writeOff: FleetKpiWriteOffCashflow;
}

export interface EconomicCashflowInput {
  depositLedgers: EconomicDepositLedger[];
  from: Date;
  paymentRecords: EconomicPaymentRecord[];
  receivableBills: EconomicReceivableBill[];
  to: Date;
  vehicleId: string;
  writeOffAllocations: EconomicPaymentWriteOffAllocation[];
}

export interface FleetKpiReportParity {
  depositIncludedInOperatingRevenue: false;
  operatingRevenueBillTypes: BillType[];
}

export interface FleetKpiVehicleResult {
  attribution: FleetKpiAttribution;
  cashflow?: FleetKpiCashflow;
  confidence: FleetKpiConfidence;
  denominatorEvidence?: FleetKpiEvidence[];
  downtime: FleetKpiDowntime;
  economics: FleetKpiEconomics;
  evidence?: FleetKpiEvidence[];
  reportParity?: FleetKpiReportParity;
  utilization: FleetKpiUtilization;
  vehicleId: string;
  warnings?: FleetKpiWarning[];
}

export interface FleetKpiAggregate {
  cashflow?: FleetKpiCashflow;
  cost: number;
  denominatorEvidence?: FleetKpiEvidence[];
  downtimeCost: number;
  downtimeDays: number;
  leasedDays: number;
  netIncome: number;
  operatingDays: number;
  revenue: number;
  roe: number;
  roi: number;
  utilizationRate: number;
  vehicleCount: number;
  warnings?: FleetKpiWarning[];
}

export interface FleetKpiReport {
  fleet: FleetKpiAggregate;
  vehicles: FleetKpiVehicleResult[];
}

export interface RevenueAttributionResult extends FleetKpiAttribution {
  depositExcludedRevenue: number;
  evidence: FleetKpiEvidence[];
  ignoredRevenue: number;
  recognizedPaymentCount: number;
  unassignedRevenue: number;
  warnings: FleetKpiWarning[];
}
