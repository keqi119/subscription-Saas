import {
  BillType,
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
  date: string;
  sourceEvents: string[];
  state: EconomicTimelineState;
}

export interface FleetKpiVehicleInput {
  equityBase: number;
  investedCapital: number;
  vehicleId: string;
}

export interface EconomicPaymentRecord {
  amount: number;
  billType: BillType | null;
  id: string;
  paymentStatus: PaymentStatus;
  receivedAt: Date;
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
  depreciationRecords: EconomicDepreciationRecord[];
  from: Date;
  operationalStates: EconomicOperationalStateSnapshot[];
  paymentRecords: EconomicPaymentRecord[];
  serviceCases: EconomicServiceCase[];
  timelines: Record<string, EconomicTimelineDay[]>;
  to: Date;
  vehicles: FleetKpiVehicleInput[];
  writeOffAdjustments: EconomicWriteOffAdjustment[];
}

export interface FleetKpiUtilization {
  leasedDays: number;
  operatingDays: number;
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
  totalDowntimeDays: number;
}

export interface FleetKpiAttribution {
  leaseRevenue: number;
  penaltyRevenue: number;
  writeOffImpact: number;
}

export interface FleetKpiConfidence {
  band: EconomicConfidenceBand;
  score: number;
}

export interface FleetKpiVehicleResult {
  attribution: FleetKpiAttribution;
  confidence: FleetKpiConfidence;
  downtime: FleetKpiDowntime;
  economics: FleetKpiEconomics;
  utilization: FleetKpiUtilization;
  vehicleId: string;
}

export interface FleetKpiAggregate {
  cost: number;
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
}

export interface FleetKpiReport {
  fleet: FleetKpiAggregate;
  vehicles: FleetKpiVehicleResult[];
}

export interface RevenueAttributionResult extends FleetKpiAttribution {
  ignoredRevenue: number;
  recognizedPaymentCount: number;
  unassignedRevenue: number;
}
