import { BillType, ServiceCasePriority, ServiceCaseType, VehicleDepreciationRecordStatus } from "@prisma/client";

import { TIMELINE_CURRENT_STATUS_PROJECTED_WARNING } from "../timeline/vehicle-timeline.types";
import { CashflowModel } from "./cashflow.model";
import { DowntimeCostModel } from "./downtime-cost.model";
import {
  type EconomicConfidenceBand,
  type EconomicDepreciationRecord,
  type EconomicOperationalStateSnapshot,
  type EconomicServiceCase,
  type EconomicTimelineDay,
  type FleetEconomicInput,
  type FleetKpiAggregate,
  type FleetKpiCashflow,
  type FleetKpiConfidence,
  type FleetKpiEvidence,
  type FleetKpiReport,
  type FleetKpiWarning,
  type FleetKpiVehicleInput,
  type FleetKpiVehicleResult,
  type RevenueAttributionResult
} from "./economics.types";
import { RevenueAttributionModel } from "./revenue-attribution.model";
import { RoiModel } from "./roi.model";
import { UtilizationMetricsService } from "./utilization-metrics.service";

const VALID_DEPRECIATION_RECORD_STATUSES = new Set<VehicleDepreciationRecordStatus>([
  VehicleDepreciationRecordStatus.CONFIRMED,
  VehicleDepreciationRecordStatus.LOCKED
]);

export class FleetKpiCalculator {
  private readonly cashflowModel = new CashflowModel();
  private readonly downtimeCostModel = new DowntimeCostModel();
  private readonly revenueAttributionModel = new RevenueAttributionModel();
  private readonly roiModel = new RoiModel();
  private readonly utilizationMetricsService = new UtilizationMetricsService();

  calculate(input: FleetEconomicInput): FleetKpiReport {
    const vehicles = input.vehicles.map((vehicle) => this.calculateVehicleKpi(vehicle, input));

    return {
      fleet: this.aggregateFleetKpi(vehicles, input.vehicles),
      vehicles
    };
  }

  private calculateVehicleKpi(vehicle: FleetKpiVehicleInput, input: FleetEconomicInput): FleetKpiVehicleResult {
    const timeline = input.timelines[vehicle.vehicleId] ?? [];
    const operationalState = input.operationalStates.find((state) => state.vehicleId === vehicle.vehicleId);
    const attribution = this.revenueAttributionModel.attributeVehicleRevenue(
      vehicle.vehicleId,
      input.paymentRecords,
      input.writeOffAdjustments,
      input.from,
      input.to
    );
    const utilization = this.utilizationMetricsService.calculate(timeline, attribution);
    const serviceCases = input.serviceCases.filter((serviceCase) => serviceCase.vehicleId === vehicle.vehicleId);
    const downtime = this.downtimeCostModel.calculate(vehicle.vehicleId, timeline, attribution, serviceCases);
    const cashflow = this.cashflowModel.calculate({
      depositLedgers: input.depositLedgers ?? [],
      from: input.from,
      paymentRecords: input.paymentRecords,
      receivableBills: input.receivableBills ?? [],
      to: input.to,
      vehicleId: vehicle.vehicleId,
      writeOffAllocations: input.writeOffAllocations ?? []
    });
    const depreciationCost = calculateDepreciationCost(vehicle.vehicleId, input.depreciationRecords);
    const serviceCaseCost = calculateServiceCaseCost(serviceCases);
    const cost = roundMoney(depreciationCost + serviceCaseCost + downtime.downtimeCost);
    const revenue = roundMoney(attribution.leaseRevenue + attribution.penaltyRevenue);
    const netIncome = roundMoney(revenue + attribution.writeOffImpact - cost);
    const { roe, roi } = this.roiModel.calculate(netIncome, vehicle.investedCapital, vehicle.equityBase);
    const denominatorEvidence = denominatorEvidenceForVehicle(vehicle);
    const warnings = collectVehicleWarnings({
      attribution,
      cashflow,
      denominatorEvidence,
      timeline
    });
    const evidence = [
      ...attribution.evidence,
      ...cashflow.evidence,
      ...denominatorEvidence,
      ...timelineEvidence(timeline)
    ];

    return {
      attribution: {
        depositExcludedRevenue: attribution.depositExcludedRevenue,
        ignoredRevenue: attribution.ignoredRevenue,
        leaseRevenue: attribution.leaseRevenue,
        penaltyRevenue: attribution.penaltyRevenue,
        recognizedPaymentCount: attribution.recognizedPaymentCount,
        unassignedRevenue: attribution.unassignedRevenue,
        writeOffImpact: attribution.writeOffImpact
      },
      cashflow,
      confidence: calculateConfidence({
        attribution,
        depreciationCost,
        operationalState,
        timeline,
        vehicle,
        warnings
      }),
      denominatorEvidence,
      downtime,
      economics: {
        cost,
        netIncome,
        revenue,
        roe,
        roi
      },
      evidence,
      reportParity: {
        depositIncludedInOperatingRevenue: false,
        operatingRevenueBillTypes: [
          BillType.FIRST_MONTHLY_FEE,
          BillType.MONTHLY_RENT,
          BillType.DAMAGE_FEE,
          BillType.OTHER
        ]
      },
      utilization,
      vehicleId: vehicle.vehicleId,
      warnings
    };
  }

  private aggregateFleetKpi(vehicles: FleetKpiVehicleResult[], vehicleInputs: FleetKpiVehicleInput[]): FleetKpiAggregate {
    const cost = sum(vehicles, (vehicle) => vehicle.economics.cost);
    const downtimeCost = sum(vehicles, (vehicle) => vehicle.downtime.downtimeCost);
    const downtimeDays = sum(vehicles, (vehicle) => vehicle.downtime.totalDowntimeDays);
    const leasedDays = sum(vehicles, (vehicle) => vehicle.utilization.leasedDays);
    const netIncome = sum(vehicles, (vehicle) => vehicle.economics.netIncome);
    const operatingDays = sum(vehicles, (vehicle) => vehicle.utilization.operatingDays);
    const revenue = sum(vehicles, (vehicle) => vehicle.economics.revenue);
    const revenueWeightedDays = sum(vehicles, (vehicle) => vehicle.utilization.utilizationRate * vehicle.utilization.operatingDays);
    const totalEquityBase = sum(vehicleInputs, (vehicle) => vehicle.equityBase);
    const totalInvestedCapital = sum(vehicleInputs, (vehicle) => vehicle.investedCapital);
    const { roe, roi } = this.roiModel.calculate(netIncome, totalInvestedCapital, totalEquityBase);
    const cashflow = aggregateCashflow(vehicles);
    const warnings = uniqueStrings(vehicles.flatMap((vehicle) => vehicle.warnings ?? []));

    return {
      cashflow,
      cost: roundMoney(cost),
      denominatorEvidence: [
        {
          amount: roundMoney(totalInvestedCapital),
          reason: "fleet ROI = total net income / total invested capital",
          source: "denominator",
          sourceId: "fleet:invested_capital"
        },
        {
          amount: roundMoney(totalEquityBase),
          reason: "fleet ROE = total platform net income / total equity base",
          source: "denominator",
          sourceId: "fleet:equity_base"
        }
      ],
      downtimeCost: roundMoney(downtimeCost),
      downtimeDays,
      leasedDays,
      netIncome: roundMoney(netIncome),
      operatingDays,
      revenue: roundMoney(revenue),
      roe,
      roi,
      utilizationRate: operatingDays > 0 ? roundRatio(revenueWeightedDays / operatingDays) : 0,
      vehicleCount: vehicles.length,
      warnings
    };
  }
}

function calculateDepreciationCost(vehicleId: string, depreciationRecords: EconomicDepreciationRecord[]) {
  return roundMoney(
    depreciationRecords
      .filter((record) => record.vehicleId === vehicleId && VALID_DEPRECIATION_RECORD_STATUSES.has(record.recordStatus))
      .reduce((total, record) => total + Math.max(record.amount, 0), 0)
  );
}

function calculateServiceCaseCost(serviceCases: EconomicServiceCase[]) {
  return roundMoney(serviceCases.reduce((total, serviceCase) => total + estimateServiceCaseCost(serviceCase), 0));
}

function estimateServiceCaseCost(serviceCase: EconomicServiceCase) {
  const priorityCost = serviceCase.priority === ServiceCasePriority.URGENT
    ? 500
    : serviceCase.priority === ServiceCasePriority.HIGH
      ? 300
      : 120;

  if (serviceCase.caseType === ServiceCaseType.ACCIDENT_REPORT) {
    return priorityCost + 400;
  }

  if (serviceCase.caseType === ServiceCaseType.RESCUE_REQUEST) {
    return priorityCost + 150;
  }

  return priorityCost;
}

function calculateConfidence(input: {
  attribution: RevenueAttributionResult;
  depreciationCost: number;
  operationalState: EconomicOperationalStateSnapshot | undefined;
  timeline: EconomicTimelineDay[];
  vehicle: FleetKpiVehicleInput;
  warnings: FleetKpiWarning[];
}): FleetKpiConfidence {
  const recognizedRevenue = input.attribution.leaseRevenue + input.attribution.penaltyRevenue;
  const reasons: string[] = [];
  let score = 50;

  score += input.timeline.length > 0 ? 15 : -20;
  score += scoreOperationalState(input.operationalState);
  score += recognizedRevenue > 0 && input.attribution.recognizedPaymentCount > 0 ? 25 : -20;
  score += input.depreciationCost > 0 ? 10 : -5;
  score += input.vehicle.investedCapital > 0 ? 5 : -15;
  score += input.vehicle.equityBase > 0 ? 5 : -10;

  if (input.attribution.unassignedRevenue > 0 && recognizedRevenue === 0) {
    score -= 10;
    reasons.push("unassigned payments are excluded from vehicle revenue");
  }

  if (input.warnings.includes(TIMELINE_CURRENT_STATUS_PROJECTED_WARNING)) {
    score -= 25;
    reasons.push("timeline current-status fallback warning reduced economic confidence");
  }

  if (input.warnings.includes("NON_CONFIRMED_PAYMENT_EXCLUDED")) {
    score -= 5;
    reasons.push("non-confirmed payments were excluded from realized revenue");
  }

  if (input.vehicle.investedCapital <= 0 || input.vehicle.equityBase <= 0) {
    reasons.push("zero or missing denominator limits return metric confidence");
  }

  if (recognizedRevenue === 0) {
    score = Math.min(score, 45);
  }

  const boundedScore = clampScore(score);

  return {
    band: confidenceBand(boundedScore),
    reasons,
    score: boundedScore
  };
}

function collectVehicleWarnings(input: {
  attribution: RevenueAttributionResult;
  cashflow: FleetKpiCashflow;
  denominatorEvidence: FleetKpiEvidence[];
  timeline: EconomicTimelineDay[];
}) {
  const timelineWarnings = input.timeline.flatMap((day) => day.warnings ?? []);
  const denominatorWarnings = input.denominatorEvidence.some((item) => item.reason.includes("zero or missing"))
    ? ["ZERO_OR_MISSING_DENOMINATOR"]
    : [];

  return uniqueStrings([
    ...input.attribution.warnings,
    ...input.cashflow.warnings,
    ...timelineWarnings,
    ...(timelineWarnings.includes(TIMELINE_CURRENT_STATUS_PROJECTED_WARNING) ? ["TIMELINE_FALLBACK_CONFIDENCE_PENALTY"] : []),
    ...denominatorWarnings
  ]);
}

function denominatorEvidenceForVehicle(vehicle: FleetKpiVehicleInput): FleetKpiEvidence[] {
  return [
    {
      amount: roundMoney(vehicle.investedCapital),
      reason:
        vehicle.investedCapital > 0
          ? "vehicle ROI = vehicle net income / invested capital"
          : "zero or missing invested capital denominator",
      source: "denominator",
      sourceId: `${vehicle.vehicleId}:invested_capital`
    },
    {
      amount: roundMoney(vehicle.equityBase),
      reason:
        vehicle.equityBase > 0
          ? "vehicle ROE = platform net income / equity base"
          : "zero or missing equity base denominator",
      source: "denominator",
      sourceId: `${vehicle.vehicleId}:equity_base`
    }
  ];
}

function timelineEvidence(timeline: EconomicTimelineDay[]): FleetKpiEvidence[] {
  return timeline.flatMap((day) =>
    (day.warnings ?? []).map((warning) => ({
      reason: warning,
      source: "timeline" as const,
      sourceId: `${day.date}:${day.sourceEvents.join(",") || "timeline"}`
    }))
  );
}

function aggregateCashflow(vehicles: FleetKpiVehicleResult[]): FleetKpiCashflow {
  const cashflows = vehicles.map((vehicle) => vehicle.cashflow).filter((cashflow): cashflow is FleetKpiCashflow => Boolean(cashflow));

  return {
    actual: {
      deposit: roundMoney(sum(cashflows, (cashflow) => cashflow.actual.deposit)),
      operating: roundMoney(sum(cashflows, (cashflow) => cashflow.actual.operating)),
      unassigned: roundMoney(sum(cashflows, (cashflow) => cashflow.actual.unassigned ?? 0))
    },
    evidence: cashflows.flatMap((cashflow) => cashflow.evidence),
    planned: {
      deposit: roundMoney(sum(cashflows, (cashflow) => cashflow.planned.deposit)),
      operating: roundMoney(sum(cashflows, (cashflow) => cashflow.planned.operating))
    },
    warnings: uniqueStrings(cashflows.flatMap((cashflow) => cashflow.warnings)),
    writeOff: {
      appliedDeposit: roundMoney(sum(cashflows, (cashflow) => cashflow.writeOff.appliedDeposit)),
      appliedOperating: roundMoney(sum(cashflows, (cashflow) => cashflow.writeOff.appliedOperating)),
      unlinked: roundMoney(sum(cashflows, (cashflow) => cashflow.writeOff.unlinked))
    }
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)].sort();
}

function scoreOperationalState(operationalState: EconomicOperationalStateSnapshot | undefined) {
  if (!operationalState) {
    return -10;
  }

  if (operationalState.confidenceScore >= 75) {
    return 10;
  }

  if (operationalState.confidenceScore >= 45) {
    return 5;
  }

  return -10;
}

function confidenceBand(score: number): EconomicConfidenceBand {
  if (score >= 80) {
    return "HIGH";
  }

  if (score >= 55) {
    return "MEDIUM";
  }

  return "LOW";
}

function sum<T>(items: T[], projector: (item: T) => number) {
  return items.reduce((total, item) => total + projector(item), 0);
}

function clampScore(score: number) {
  return Math.min(100, Math.max(0, Math.round(score)));
}

function roundMoney(value: number) {
  return Number(value.toFixed(6));
}

function roundRatio(value: number) {
  return Number(value.toFixed(6));
}
