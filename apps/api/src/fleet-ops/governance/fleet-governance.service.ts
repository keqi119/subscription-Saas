import { Injectable } from "@nestjs/common";

import { FleetKpiService } from "../economics/fleet-kpi.service";
import { ExecutionLogService } from "../execution/execution-log.service";
import { FleetOptimizationService } from "../optimization/fleet-optimization.service";
import { FleetRiskService } from "../risk/fleet-risk.service";
import { VehicleTimelineService } from "../timeline/vehicle-timeline.service";
import { VehicleOperationalStateService } from "../vehicle-operational-state.service";
import { PolicyEngine } from "./policy-engine";
import type { FleetGovernanceInput, GovernanceTimelineDay } from "./policy.types";

@Injectable()
export class FleetGovernanceService {
  private readonly policyEngine = new PolicyEngine();

  constructor(
    private readonly operationalStateService: VehicleOperationalStateService,
    private readonly timelineService: VehicleTimelineService,
    private readonly kpiService: FleetKpiService,
    private readonly riskService: FleetRiskService,
    private readonly executionLogService: ExecutionLogService,
    private readonly optimizationService: FleetOptimizationService
  ) {}

  async getFleetGovernance(vehicleIds: string[], from: Date, to: Date) {
    const normalizedVehicleIds = [...new Set(vehicleIds)];
    const [operationalStates, timelines, fleetKpis, riskReport, optimizationReport] = await Promise.all([
      this.loadOperationalStates(normalizedVehicleIds, to),
      this.loadTimelines(normalizedVehicleIds, from, to),
      this.kpiService.getFleetKpis(normalizedVehicleIds, from, to),
      this.riskService.getFleetRisk(normalizedVehicleIds, from, to),
      this.optimizationService.getFleetOptimization(normalizedVehicleIds, from, to)
    ]);
    const input: FleetGovernanceInput = {
      asOf: to,
      executionLogs: this.executionLogService.listLogs(),
      fleetKpis,
      optimizationReport,
      operationalStates,
      riskReport,
      timelines,
      vehicleIds: normalizedVehicleIds
    };

    return this.policyEngine.evaluate(input);
  }

  private async loadOperationalStates(vehicleIds: string[], asOf: Date) {
    return Promise.all(
      vehicleIds.map(async (vehicleId) => {
        const state = await this.operationalStateService.resolveVehicleOperationalState(vehicleId, asOf);

        return {
          computedState: state.computedState,
          confidenceScore: state.confidenceScore,
          vehicleId
        };
      })
    );
  }

  private async loadTimelines(vehicleIds: string[], from: Date, to: Date): Promise<Record<string, GovernanceTimelineDay[]>> {
    const entries = await Promise.all(
      vehicleIds.map(async (vehicleId) => {
        const timeline = await this.timelineService.getVehicleTimeline(vehicleId, from, to);

        return [vehicleId, timeline.map(toGovernanceTimelineDay)] as const;
      })
    );

    return Object.fromEntries(entries);
  }
}

function toGovernanceTimelineDay(day: {
  confidence: number;
  conflicts?: unknown[];
  date: string;
  sourceEvents: string[];
  state: string;
}): GovernanceTimelineDay {
  return {
    confidence: day.confidence,
    conflicts: [...(day.conflicts ?? [])],
    date: day.date,
    sourceEvents: [...day.sourceEvents],
    state: day.state
  };
}
