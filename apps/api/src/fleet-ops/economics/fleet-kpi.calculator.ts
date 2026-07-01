import { ServiceCasePriority, ServiceCaseType, VehicleDepreciationRecordStatus } from "@prisma/client";

import { DowntimeCostModel } from "./downtime-cost.model";
import {
  type EconomicConfidenceBand,
  type EconomicDepreciationRecord,
  type EconomicOperationalStateSnapshot,
  type EconomicServiceCase,
  type EconomicTimelineDay,
  type FleetEconomicInput,
  type FleetKpiAggregate,
  type FleetKpiConfidence,
  type FleetKpiReport,
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
    const depreciationCost = calculateDepreciationCost(vehicle.vehicleId, input.depreciationRecords);
    const serviceCaseCost = calculateServiceCaseCost(serviceCases);
    const cost = roundMoney(depreciationCost + serviceCaseCost + downtime.downtimeCost);
    const revenue = roundMoney(attribution.leaseRevenue + attribution.penaltyRevenue);
    const netIncome = roundMoney(revenue + attribution.writeOffImpact - cost);
    const { roe, roi } = this.roiModel.calculate(netIncome, vehicle.investedCapital, vehicle.equityBase);

    return {
      attribution: {
        leaseRevenue: attribution.leaseRevenue,
        penaltyRevenue: attribution.penaltyRevenue,
        writeOffImpact: attribution.writeOffImpact
      },
      confidence: calculateConfidence({
        attribution,
        depreciationCost,
        operationalState,
        timeline,
        vehicle
      }),
      downtime,
      economics: {
        cost,
        netIncome,
        revenue,
        roe,
        roi
      },
      utilization,
      vehicleId: vehicle.vehicleId
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

    return {
      cost: roundMoney(cost),
      downtimeCost: roundMoney(downtimeCost),
      downtimeDays,
      leasedDays,
      netIncome: roundMoney(netIncome),
      operatingDays,
      revenue: roundMoney(revenue),
      roe,
      roi,
      utilizationRate: operatingDays > 0 ? roundRatio(revenueWeightedDays / operatingDays) : 0,
      vehicleCount: vehicles.length
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
}): FleetKpiConfidence {
  const recognizedRevenue = input.attribution.leaseRevenue + input.attribution.penaltyRevenue;
  let score = 50;

  score += input.timeline.length > 0 ? 15 : -20;
  score += scoreOperationalState(input.operationalState);
  score += recognizedRevenue > 0 && input.attribution.recognizedPaymentCount > 0 ? 25 : -20;
  score += input.depreciationCost > 0 ? 10 : -5;
  score += input.vehicle.investedCapital > 0 ? 5 : -15;
  score += input.vehicle.equityBase > 0 ? 5 : -10;

  if (input.attribution.unassignedRevenue > 0 && recognizedRevenue === 0) {
    score -= 10;
  }

  if (recognizedRevenue === 0) {
    score = Math.min(score, 45);
  }

  const boundedScore = clampScore(score);

  return {
    band: confidenceBand(boundedScore),
    score: boundedScore
  };
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
