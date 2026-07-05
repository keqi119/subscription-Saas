import type { VehicleAssetPoolStatus, VehicleAssetPoolType, VehicleAssetPoolVehicleStatus, VehicleStatus } from "@prisma/client";

import type { FleetOpsApiRequestContext } from "./fleet-ops.api.types";

export type FleetOpsScopeType = "ALL" | "COHORT" | "POOL";
export type FleetOpsConfidenceBand = "HIGH" | "LOW" | "MEDIUM" | "UNKNOWN";
export type FleetOpsAgingBucket = "D1" | "D2" | "D3" | "D4" | "D5" | "NONE";

export interface FleetOpsPoolIdentity {
  activeVehicleCount: number;
  poolId: string;
  poolName: string;
  poolNo: string;
  poolStatus: VehicleAssetPoolStatus | string;
  poolType: VehicleAssetPoolType | string;
}

export interface FleetOpsPoolMembershipIdentity {
  membershipStatus: VehicleAssetPoolVehicleStatus | string;
  poolId: string;
  vehicleId: string;
}

export interface FleetOpsVehicleScopeItem {
  assetLocation?: string;
  brand?: string;
  model?: string;
  modelYear?: number;
  status?: VehicleStatus | string;
  vehicleId: string;
  vehicleNo?: string;
  vinSuffix?: string;
}

export interface FleetOpsOverviewQueryInput extends FleetOpsApiRequestContext {
  agingBucket?: FleetOpsAgingBucket;
  assetLocation?: string;
  brand?: string;
  collectionLevel?: FleetOpsAgingBucket;
  confidenceBand?: FleetOpsConfidenceBand;
  createdFrom?: string;
  createdTo?: string;
  evidenceMissing?: boolean;
  from?: string;
  limit?: number;
  model?: string;
  modelYear?: number;
  overdueStatus?: "NONE" | "OVERDUE";
  page?: number;
  pageSize?: number;
  poolId?: string;
  registrationDateFrom?: string;
  registrationDateTo?: string;
  riskLevel?: string;
  scopeType?: FleetOpsScopeType;
  to?: string;
  topN?: number;
  vehicleStatus?: VehicleStatus | string;
  warningType?: string;
  asOf?: string;
}

export interface FleetOpsPoolListQueryInput extends FleetOpsApiRequestContext {
  page?: number;
  pageSize?: number;
  poolStatus?: VehicleAssetPoolStatus | string;
  poolType?: VehicleAssetPoolType | string;
}

export interface FleetOpsPagination {
  page: number;
  pageSize: number;
  total: number;
}

export interface FleetOpsResolvedScope {
  scope: {
    filters?: Record<string, unknown>;
    pool?: FleetOpsPoolIdentity;
    type: FleetOpsScopeType;
  };
  vehicleIds: string[];
  vehicles: FleetOpsVehicleScopeItem[];
  warnings: string[];
}

export interface FleetOpsDateRangeReadModel {
  from: Date;
  to: Date;
}

export interface FleetOpsVehicleCountsReadModel {
  abnormal: number;
  activeOperating: number;
  idleAvailable: number;
  lowConfidence: number;
  missingData: number;
  overdue: number;
  total: number;
}

export interface FleetOpsKpiReadModel {
  cost: number;
  denominatorEvidenceCount: number;
  lowRoiVehicleCount: number;
  netIncome: number;
  revenue: number;
  roe: number;
  roi: number;
}

export interface FleetOpsCashflowReadModel {
  actualDeposit: number;
  actualOperating: number;
  plannedDeposit: number;
  plannedOperating: number;
  unallocated: number;
}

export interface FleetOpsRiskReadModel {
  agingDistribution: Record<FleetOpsAgingBucket, number>;
  averageRiskScore: number;
  collectionDistribution: Record<FleetOpsAgingBucket, number>;
  highRiskVehicleCount: number;
  maxOverdueDays: number;
  overdueAmount: number;
  overdueBillCount: number;
  overdueVehicleCount: number;
}

export interface FleetOpsDataQualityReadModel {
  averageConfidence: number;
  confidenceDistribution: Record<FleetOpsConfidenceBand, number>;
  consistencyScore: number;
  lowConfidenceVehicleCount: number;
  minConfidence: number;
  missingEvidenceVehicleCount: number;
  timelineFallbackVehicleCount: number;
  warningCount: number;
}

export interface FleetOpsEvidenceSummaryReadModel {
  denominatorEvidenceCount: number;
  economicsEvidenceCount: number;
  fullEvidenceIncluded: false;
  missingEvidenceVehicleCount: number;
  riskEvidenceCount: number;
}

export interface FleetOpsOverviewAnomalyItem {
  collectionLevel?: FleetOpsAgingBucket | string;
  confidence?: number;
  issueCount?: number;
  overdueRemainingAmount?: number;
  riskScore?: number;
  roe?: number;
  roi?: number;
  vehicleId: string;
  vehicleNo?: string;
}

export interface FleetOpsAnomalyReadModel {
  cashflowAnomaly: FleetOpsOverviewAnomalyItem[];
  highestOverdue: FleetOpsOverviewAnomalyItem[];
  highestRisk: FleetOpsOverviewAnomalyItem[];
  lowestConfidence: FleetOpsOverviewAnomalyItem[];
  lowestRoi: FleetOpsOverviewAnomalyItem[];
  missingEvidence: FleetOpsOverviewAnomalyItem[];
  timelineFallback: FleetOpsOverviewAnomalyItem[];
}

export interface FleetOpsOverviewReadModel {
  anomalies: FleetOpsAnomalyReadModel;
  cashflow: FleetOpsCashflowReadModel;
  dataQuality: FleetOpsDataQualityReadModel;
  distributions: {
    vehicleStatus: Record<string, number>;
  };
  evidenceSummary: FleetOpsEvidenceSummaryReadModel;
  generatedAt: string;
  kpis: FleetOpsKpiReadModel;
  pagination?: FleetOpsPagination;
  range: {
    from: string;
    to: string;
  };
  risk: FleetOpsRiskReadModel;
  scope: FleetOpsResolvedScope["scope"];
  vehicleCounts: FleetOpsVehicleCountsReadModel;
  warnings: string[];
}

export interface FleetOpsPoolListReadModel {
  generatedAt: string;
  items: FleetOpsPoolIdentity[];
  pagination: FleetOpsPagination;
}

export interface FleetOpsPoolDetailReadModel {
  activeVehicleCount: number;
  generatedAt: string;
  overview: FleetOpsOverviewReadModel;
  pool: FleetOpsPoolIdentity;
  warnings: string[];
}

export interface FleetOpsScopedVehicleListReadModel {
  generatedAt: string;
  items: FleetOpsVehicleScopeItem[];
  pagination: FleetOpsPagination;
  scope: FleetOpsResolvedScope["scope"];
  warnings: string[];
}
