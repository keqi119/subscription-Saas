import { Injectable } from "@nestjs/common";

import { FleetKpiService } from "../economics/fleet-kpi.service";
import { ExecutionLogService } from "../execution/execution-log.service";
import { FleetRiskService } from "../risk/fleet-risk.service";
import { VehicleTimelineService } from "../timeline/vehicle-timeline.service";
import { VehicleOperationalStateService } from "../vehicle-operational-state.service";
import { OptimizationEngine } from "./optimization-engine";
import type { FleetOptimizationInput, OptimizationTimelineDay } from "./optimization.types";

@Injectable()
export class FleetOptimizationService {
  private readonly optimizationEngine = new OptimizationEngine();

  constructor(
    private readonly operationalStateService: VehicleOperationalStateService,
    private readonly timelineService: VehicleTimelineService,
    private readonly kpiService: FleetKpiService,
    private readonly riskService: FleetRiskService,
    private readonly executionLogService: ExecutionLogService
  ) {}

  async getFleetOptimization(vehicleIds: string[], from: Date, to: Date) {
    const normalizedVehicleIds = [...new Set(vehicleIds)];
    const [operationalStates, timelines, fleetKpis, riskReport] = await Promise.all([
      this.loadOperationalStates(normalizedVehicleIds, to),
      this.loadTimelines(normalizedVehicleIds, from, to),
      this.kpiService.getFleetKpis(normalizedVehicleIds, from, to),
      this.riskService.getFleetRisk(normalizedVehicleIds, from, to)
    ]);
    const input: FleetOptimizationInput = {
      asOf: to,
      executionLogs: this.executionLogService.listLogs(),
      fleetKpis,
      operationalStates,
      riskReport,
      timelines,
      vehicleIds: normalizedVehicleIds
    };

    return this.optimizationEngine.optimize(input);
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

  private async loadTimelines(vehicleIds: string[], from: Date, to: Date): Promise<Record<string, OptimizationTimelineDay[]>> {
    const entries = await Promise.all(
      vehicleIds.map(async (vehicleId) => {
        const timeline = await this.timelineService.getVehicleTimeline(vehicleId, from, to);

        return [vehicleId, timeline.map(toOptimizationTimelineDay)] as const;
      })
    );

    return Object.fromEntries(entries);
  }
}

function toOptimizationTimelineDay(day: {
  confidence: number;
  conflicts?: unknown[];
  date: string;
  sourceEvents: string[];
  state: string;
}): OptimizationTimelineDay {
  return {
    confidence: day.confidence,
    conflicts: [...(day.conflicts ?? [])],
    date: day.date,
    sourceEvents: [...day.sourceEvents],
    state: day.state
  };
}
