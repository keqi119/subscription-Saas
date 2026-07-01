import type { FleetKpiVehicleResult } from "../economics/economics.types";
import { CollectionPriorityModel } from "./collection-priority.model";
import { ControlGuardEngine } from "./control-guard.engine";
import { ExposureModel } from "./exposure.model";
import { RiskScoreModel } from "./risk-score.model";
import { hasTimelineConflict, RiskSignalsBuilder } from "./risk-signals.builder";
import { ControlDecision, type FleetRiskAggregate, type FleetRiskInput, type FleetRiskReport, type RiskOutput, type RiskVehicleContext } from "./risk.types";

export class FleetRiskCalculator {
  private readonly collectionPriorityModel = new CollectionPriorityModel();
  private readonly controlGuardEngine = new ControlGuardEngine();
  private readonly exposureModel = new ExposureModel();
  private readonly riskScoreModel = new RiskScoreModel();
  private readonly riskSignalsBuilder = new RiskSignalsBuilder();

  calculate(input: FleetRiskInput): FleetRiskReport {
    const vehicles = input.vehicleIds.map((vehicleId) => this.calculateVehicleRisk(vehicleId, input));

    return {
      fleet: aggregateFleetRisk(vehicles),
      vehicles
    };
  }

  private calculateVehicleRisk(vehicleId: string, input: FleetRiskInput): RiskOutput {
    const kpi = input.fleetKpis.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId) ?? emptyKpi(vehicleId);
    const timeline = input.timelines[vehicleId] ?? [];
    const exposure = this.exposureModel.calculate(vehicleId, input, kpi.economics.revenue);
    const signals = this.riskSignalsBuilder.buildVehicleSignals(vehicleId, input, kpi, exposure);
    const components = this.riskScoreModel.calculateComponents({
      exposure,
      fleetRiskInput: input,
      kpi,
      signals,
      timeline,
      vehicleId
    });
    const riskScore = this.riskScoreModel.calculateWeightedScore(components);
    const collectionLevel = this.collectionPriorityModel.assign({
      exposure,
      exposureScore: exposure.score,
      riskScore
    });
    const context: RiskVehicleContext = {
      exposure,
      input,
      kpi,
      operationalState: input.operationalStates.find((state) => state.vehicleId === vehicleId),
      signals,
      timeline,
      vehicleId
    };
    const controlDecision = this.controlGuardEngine.decide(context, collectionLevel, riskScore);

    return {
      collectionLevel,
      confidence: calculateConfidence(context, controlDecision.controlDecision),
      controlDecision: controlDecision.controlDecision,
      exposureScore: exposure.score,
      reasons: controlDecision.reasons,
      riskScore,
      signals: signals.map((signal) => signal.code),
      vehicleId
    };
  }
}

function calculateConfidence(context: RiskVehicleContext, controlDecision: ControlDecision) {
  let score = 0;

  if (context.operationalState) {
    score += 25;
  }

  if (context.timeline.length > 0) {
    score += 25;
  }

  if (context.kpi.vehicleId === context.vehicleId) {
    score += 25;
  }

  if (hasCoreSystemEvidence(context.vehicleId, context.input)) {
    score += 15;
  }

  if (hasTimelineConflict(context.timeline)) {
    score -= 20;
  }

  if (controlDecision === ControlDecision.BLOCK) {
    score -= 25;
  }

  return Math.min(100, Math.max(0, Math.round(score)));
}

function hasCoreSystemEvidence(vehicleId: string, input: FleetRiskInput) {
  return (
    input.receivableBills.some((bill) => bill.vehicleId === vehicleId) ||
    input.paymentRecords.some((payment) => payment.vehicleId === vehicleId) ||
    input.leases.some((lease) => lease.vehicleId === vehicleId) ||
    input.orders.some((order) => order.vehicleId === vehicleId) ||
    input.serviceCases.some((serviceCase) => serviceCase.vehicleId === vehicleId) ||
    input.conditionReports.some((report) => report.vehicleId === vehicleId)
  );
}

function aggregateFleetRisk(vehicles: RiskOutput[]): FleetRiskAggregate {
  const vehicleCount = vehicles.length;

  return {
    averageExposureScore: vehicleCount > 0 ? roundRatio(sum(vehicles, (vehicle) => vehicle.exposureScore) / vehicleCount) : 0,
    averageRiskScore: vehicleCount > 0 ? roundRatio(sum(vehicles, (vehicle) => vehicle.riskScore) / vehicleCount) : 0,
    blockedVehicles: vehicles.filter((vehicle) => vehicle.controlDecision === ControlDecision.BLOCK).length,
    vehicleCount,
    warnedVehicles: vehicles.filter((vehicle) => vehicle.controlDecision === ControlDecision.WARN).length
  };
}

function emptyKpi(vehicleId: string): FleetKpiVehicleResult {
  return {
    attribution: {
      leaseRevenue: 0,
      penaltyRevenue: 0,
      writeOffImpact: 0
    },
    confidence: {
      band: "LOW",
      score: 0
    },
    downtime: {
      breakdown: {
        IDLE: 0,
        MAINTENANCE: 0,
        RESERVED: 0,
        SERVICE: 0
      },
      downtimeCost: 0,
      totalDowntimeDays: 0
    },
    economics: {
      cost: 0,
      netIncome: 0,
      revenue: 0,
      roe: 0,
      roi: 0
    },
    utilization: {
      leasedDays: 0,
      operatingDays: 0,
      utilizationRate: 0
    },
    vehicleId
  };
}

function sum<T>(items: T[], projector: (item: T) => number) {
  return items.reduce((total, item) => total + projector(item), 0);
}

function roundRatio(value: number) {
  return Number(value.toFixed(6));
}
