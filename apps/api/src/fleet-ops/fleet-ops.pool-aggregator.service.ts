import { Injectable } from "@nestjs/common";

import { FleetKpiService } from "./economics/fleet-kpi.service";
import type { FleetKpiVehicleResult } from "./economics/economics.types";
import { FleetRiskService } from "./risk/fleet-risk.service";
import { CollectionPriorityLevel, type FleetRiskReport, type RiskOutput } from "./risk/risk.types";
import {
  FLEET_OPS_OVERVIEW_DEFAULT_TOP_N,
  FLEET_OPS_OVERVIEW_MAX_TOP_N
} from "./fleet-ops.api.types";
import type {
  FleetOpsAgingBucket,
  FleetOpsAnomalyReadModel,
  FleetOpsConfidenceBand,
  FleetOpsDateRangeReadModel,
  FleetOpsOverviewAnomalyItem,
  FleetOpsOverviewReadModel,
  FleetOpsResolvedScope,
  FleetOpsVehicleCountsReadModel,
  FleetOpsVehicleScopeItem
} from "./fleet-ops.pool-read-model";

@Injectable()
export class FleetOpsPoolAggregatorService {
  constructor(
    private readonly kpiService: FleetKpiService,
    private readonly riskService: FleetRiskService
  ) {}

  async buildOverview(
    scope: FleetOpsResolvedScope,
    range: FleetOpsDateRangeReadModel,
    options: { topN?: number } = {}
  ): Promise<FleetOpsOverviewReadModel> {
    const topN = normalizeTopN(options.topN);
    const [kpiReport, riskReport] = await Promise.all([
      this.kpiService.getFleetKpis(scope.vehicleIds, range.from, range.to),
      this.riskService.getFleetRisk(scope.vehicleIds, range.from, range.to)
    ]);
    const kpisByVehicle = mapByVehicleId(kpiReport.vehicles);
    const risksByVehicle = mapByVehicleId(riskReport.vehicles);
    const warnings = uniqueStrings([
      ...scope.warnings,
      ...(kpiReport.fleet.warnings ?? []),
      ...kpiReport.vehicles.flatMap((vehicle) => vehicle.warnings ?? []),
      ...riskReport.vehicles.flatMap((vehicle) => (vehicle.warnings ?? []).map((warning) => warning.code)),
      "FLEET_OPS_TIMELINE_FALLBACK_ANOMALY_DEFERRED"
    ]);
    const dataQuality = buildDataQuality(scope.vehicles, kpisByVehicle, risksByVehicle);

    return {
      anomalies: buildAnomalies(scope.vehicles, kpisByVehicle, risksByVehicle, topN),
      cashflow: {
        actualDeposit: roundMoney(kpiReport.fleet.cashflow?.actual.deposit ?? 0),
        actualOperating: roundMoney(kpiReport.fleet.cashflow?.actual.operating ?? 0),
        plannedDeposit: roundMoney(kpiReport.fleet.cashflow?.planned.deposit ?? 0),
        plannedOperating: roundMoney(kpiReport.fleet.cashflow?.planned.operating ?? 0),
        unallocated: roundMoney(kpiReport.fleet.cashflow?.actual.unassigned ?? 0)
      },
      dataQuality,
      distributions: {
        vehicleStatus: countBy(scope.vehicles, (vehicle) => String(vehicle.status ?? "UNKNOWN"))
      },
      evidenceSummary: {
        denominatorEvidenceCount: kpiReport.fleet.denominatorEvidence?.length ?? 0,
        economicsEvidenceCount: kpiReport.vehicles.reduce((total, vehicle) => total + (vehicle.evidence?.length ?? 0), 0),
        fullEvidenceIncluded: false,
        missingEvidenceVehicleCount: dataQuality.missingEvidenceVehicleCount,
        riskEvidenceCount: riskReport.vehicles.reduce((total, vehicle) => total + (vehicle.evidence?.length ?? 0), 0)
      },
      generatedAt: new Date().toISOString(),
      kpis: {
        cost: roundMoney(kpiReport.fleet.cost ?? 0),
        denominatorEvidenceCount: kpiReport.fleet.denominatorEvidence?.length ?? 0,
        lowRoiVehicleCount: kpiReport.vehicles.filter((vehicle) => vehicle.economics.roi < 0).length,
        netIncome: roundMoney(kpiReport.fleet.netIncome ?? 0),
        revenue: roundMoney(kpiReport.fleet.revenue ?? 0),
        roe: kpiReport.fleet.roe ?? 0,
        roi: kpiReport.fleet.roi ?? 0
      },
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString()
      },
      risk: buildRiskReadModel(riskReport),
      scope: scope.scope,
      vehicleCounts: buildVehicleCounts(scope.vehicles, risksByVehicle, dataQuality.lowConfidenceVehicleCount, dataQuality.missingEvidenceVehicleCount),
      warnings
    };
  }
}

function buildRiskReadModel(riskReport: FleetRiskReport) {
  const agingDistribution = emptyAgingDistribution();
  const collectionDistribution = emptyAgingDistribution();
  let overdueAmount = 0;
  let overdueBillCount = 0;
  let overdueVehicleCount = 0;
  let maxOverdueDays = 0;
  let highRiskVehicleCount = 0;

  for (const vehicle of riskReport.vehicles) {
    const aging = asAgingBucket(vehicle.agingBucket);
    const collection = asAgingBucket(vehicle.collectionLevel);
    agingDistribution[aging] += 1;
    collectionDistribution[collection] += 1;

    const exposure = vehicle.exposureDetail;
    const vehicleOverdueAmount = exposure?.overdueRemainingAmount ?? 0;
    if (vehicleOverdueAmount > 0 || (exposure?.overdueBillCount ?? 0) > 0) {
      overdueVehicleCount += 1;
    }

    overdueAmount += vehicleOverdueAmount;
    overdueBillCount += exposure?.overdueBillCount ?? 0;
    maxOverdueDays = Math.max(maxOverdueDays, exposure?.maxOverdueDays ?? 0);

    if (vehicle.riskScore >= 80) {
      highRiskVehicleCount += 1;
    }
  }

  return {
    agingDistribution,
    averageRiskScore: riskReport.fleet.averageRiskScore ?? average(riskReport.vehicles.map((vehicle) => vehicle.riskScore)),
    collectionDistribution,
    highRiskVehicleCount,
    maxOverdueDays,
    overdueAmount: roundMoney(overdueAmount),
    overdueBillCount,
    overdueVehicleCount
  };
}

function buildVehicleCounts(
  vehicles: FleetOpsVehicleScopeItem[],
  risksByVehicle: Map<string, RiskOutput>,
  lowConfidenceVehicleCount: number,
  missingEvidenceVehicleCount: number
): FleetOpsVehicleCountsReadModel {
  return {
    abnormal: vehicles.filter((vehicle) => ["MAINTENANCE", "RETIRED", "RETURNED"].includes(String(vehicle.status))).length,
    activeOperating: vehicles.filter((vehicle) => ["LEASED", "RENTED"].includes(String(vehicle.status))).length,
    idleAvailable: vehicles.filter((vehicle) => ["AVAILABLE", "IN_PREPARATION", "RESERVED", "REVIEW_RESERVED"].includes(String(vehicle.status))).length,
    lowConfidence: lowConfidenceVehicleCount,
    missingData: missingEvidenceVehicleCount,
    overdue: vehicles.filter((vehicle) => (risksByVehicle.get(vehicle.vehicleId)?.exposureDetail?.overdueRemainingAmount ?? 0) > 0).length,
    total: vehicles.length
  };
}

function buildDataQuality(
  vehicles: FleetOpsVehicleScopeItem[],
  kpisByVehicle: Map<string, FleetKpiVehicleResult>,
  risksByVehicle: Map<string, RiskOutput>
) {
  const scores = vehicles.map((vehicle) => confidenceFor(vehicle.vehicleId, kpisByVehicle, risksByVehicle));
  const confidenceDistribution = {
    HIGH: 0,
    LOW: 0,
    MEDIUM: 0,
    UNKNOWN: 0
  } satisfies Record<FleetOpsConfidenceBand, number>;

  for (const score of scores) {
    confidenceDistribution[confidenceBand(score)] += 1;
  }

  const missingEvidenceVehicleCount = vehicles.filter((vehicle) => missingEvidenceScore(vehicle.vehicleId, kpisByVehicle, risksByVehicle) > 0).length;
  const warningCount = vehicles.reduce((total, vehicle) => {
    const kpi = kpisByVehicle.get(vehicle.vehicleId);
    const risk = risksByVehicle.get(vehicle.vehicleId);
    return total + (kpi?.warnings?.length ?? 0) + (kpi?.cashflow?.warnings?.length ?? 0) + (risk?.warnings?.length ?? 0);
  }, 0);

  return {
    averageConfidence: roundScore(average(scores)),
    confidenceDistribution,
    consistencyScore: 100,
    lowConfidenceVehicleCount: scores.filter((score) => score > 0 && score < 50).length,
    minConfidence: scores.length > 0 ? Math.min(...scores) : 0,
    missingEvidenceVehicleCount,
    timelineFallbackVehicleCount: 0,
    warningCount
  };
}

function buildAnomalies(
  vehicles: FleetOpsVehicleScopeItem[],
  kpisByVehicle: Map<string, FleetKpiVehicleResult>,
  risksByVehicle: Map<string, RiskOutput>,
  topN: number
): FleetOpsAnomalyReadModel {
  const baseItems = vehicles.map((vehicle) => {
    const kpi = kpisByVehicle.get(vehicle.vehicleId);
    const risk = risksByVehicle.get(vehicle.vehicleId);

    return {
      confidence: confidenceFor(vehicle.vehicleId, kpisByVehicle, risksByVehicle),
      issueCount: missingEvidenceScore(vehicle.vehicleId, kpisByVehicle, risksByVehicle),
      overdueRemainingAmount: risk?.exposureDetail?.overdueRemainingAmount ?? 0,
      riskScore: risk?.riskScore ?? 0,
      roe: kpi?.economics.roe,
      roi: kpi?.economics.roi,
      vehicleId: vehicle.vehicleId,
      vehicleNo: vehicle.vehicleNo
    } satisfies FleetOpsOverviewAnomalyItem;
  });

  return {
    cashflowAnomaly: topItems(
      baseItems.filter((item) => {
        const kpi = kpisByVehicle.get(item.vehicleId);
        return (kpi?.cashflow?.warnings?.length ?? 0) > 0 || (kpi?.cashflow?.actual.unassigned ?? 0) > 0 || (kpi?.warnings?.length ?? 0) > 0;
      }),
      topN,
      (item) => item.issueCount ?? 0
    ),
    highestOverdue: topItems(
      baseItems.filter((item) => (item.overdueRemainingAmount ?? 0) > 0),
      topN,
      (item) => item.overdueRemainingAmount ?? 0
    ),
    highestRisk: topItems(baseItems, topN, (item) => item.riskScore ?? 0),
    lowestConfidence: bottomItems(baseItems, topN, (item) => item.confidence ?? 0),
    lowestRoi: bottomItems(
      baseItems.filter((item) => item.roi !== undefined),
      topN,
      (item) => item.roi ?? 0
    ),
    missingEvidence: topItems(
      baseItems.filter((item) => (item.issueCount ?? 0) > 0),
      topN,
      (item) => item.issueCount ?? 0
    ),
    timelineFallback: []
  };
}

function confidenceFor(vehicleId: string, kpisByVehicle: Map<string, FleetKpiVehicleResult>, risksByVehicle: Map<string, RiskOutput>) {
  const scores = [kpisByVehicle.get(vehicleId)?.confidence.score, risksByVehicle.get(vehicleId)?.confidence].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  );

  return scores.length > 0 ? average(scores) : 0;
}

function missingEvidenceScore(vehicleId: string, kpisByVehicle: Map<string, FleetKpiVehicleResult>, risksByVehicle: Map<string, RiskOutput>) {
  const kpi = kpisByVehicle.get(vehicleId);
  const risk = risksByVehicle.get(vehicleId);

  return [
    !kpi,
    kpi && (kpi.evidence?.length ?? 0) === 0,
    kpi && (kpi.denominatorEvidence?.length ?? 0) === 0,
    !risk,
    risk && (risk.evidence?.length ?? 0) === 0 && (risk.exposureDetail?.evidence?.length ?? 0) === 0
  ].filter(Boolean).length;
}

function mapByVehicleId<T extends { vehicleId: string }>(items: T[]) {
  return new Map(items.map((item) => [item.vehicleId, item]));
}

function topItems<T extends { vehicleId: string }>(items: T[], topN: number, score: (item: T) => number) {
  return [...items].sort((left, right) => score(right) - score(left) || left.vehicleId.localeCompare(right.vehicleId)).slice(0, topN);
}

function bottomItems<T extends { vehicleId: string }>(items: T[], topN: number, score: (item: T) => number) {
  return [...items].sort((left, right) => score(left) - score(right) || left.vehicleId.localeCompare(right.vehicleId)).slice(0, topN);
}

function countBy<T>(items: T[], key: (item: T) => string) {
  return items.reduce<Record<string, number>>((counts, item) => {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function emptyAgingDistribution() {
  return {
    D1: 0,
    D2: 0,
    D3: 0,
    D4: 0,
    D5: 0,
    NONE: 0
  } satisfies Record<FleetOpsAgingBucket, number>;
}

function asAgingBucket(value: CollectionPriorityLevel | string | undefined): FleetOpsAgingBucket {
  return ["D1", "D2", "D3", "D4", "D5"].includes(String(value)) ? (value as FleetOpsAgingBucket) : "NONE";
}

function confidenceBand(score: number): FleetOpsConfidenceBand {
  if (score >= 80) {
    return "HIGH";
  }

  if (score >= 50) {
    return "MEDIUM";
  }

  if (score > 0) {
    return "LOW";
  }

  return "UNKNOWN";
}

function normalizeTopN(value: number | undefined) {
  const parsed = Number(value ?? FLEET_OPS_OVERVIEW_DEFAULT_TOP_N);
  if (!Number.isFinite(parsed)) {
    return FLEET_OPS_OVERVIEW_DEFAULT_TOP_N;
  }

  return Math.max(1, Math.min(FLEET_OPS_OVERVIEW_MAX_TOP_N, Math.trunc(parsed)));
}

function average(values: number[]) {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function roundScore(value: number) {
  return Math.round(value);
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)].sort();
}
