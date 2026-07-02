import type { FleetKpiService } from "../economics/fleet-kpi.service";
import type { FleetRiskService } from "../risk/fleet-risk.service";
import type { VehicleTimelineService } from "../timeline/vehicle-timeline.service";
import type { VehicleOperationalStateService } from "../vehicle-operational-state.service";
import { FleetOpsInvalidRangeError } from "../fleet-ops.errors";
import { buildFleetOpsSnapshot } from "./fleet-ops.snapshot.builder";
import type { FleetOpsSnapshot } from "./fleet-ops.snapshot.types";

export interface FleetOpsFacadeDependencies {
  kpiService: Pick<FleetKpiService, "getFleetKpis">;
  riskService: Pick<FleetRiskService, "getFleetRisk">;
  stateService: Pick<VehicleOperationalStateService, "resolveVehicleOperationalState">;
  timelineService: Pick<VehicleTimelineService, "getVehicleTimeline">;
}

export interface FleetOpsQueryOptions {
  asOf?: Date;
  from?: Date;
  generatedAt?: Date;
  to?: Date;
}

export class FleetOpsFacade {
  constructor(
    private readonly dependencies: FleetOpsFacadeDependencies,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async query(vehicleId: string, options: FleetOpsQueryOptions = {}): Promise<FleetOpsSnapshot> {
    const generatedAt = cloneDate(options.generatedAt ?? this.clock());
    const asOf = cloneDate(options.asOf ?? options.to ?? generatedAt);
    const from = cloneDate(options.from ?? startOfUtcDay(asOf));
    const to = cloneDate(options.to ?? asOf);

    if (from.getTime() > to.getTime()) {
      throw new FleetOpsInvalidRangeError();
    }

    const [state, timeline, kpiReport, riskReport] = await Promise.all([
      this.dependencies.stateService.resolveVehicleOperationalState(vehicleId, asOf),
      this.dependencies.timelineService.getVehicleTimeline(vehicleId, from, to),
      this.dependencies.kpiService.getFleetKpis([vehicleId], from, to),
      this.dependencies.riskService.getFleetRisk([vehicleId], from, to)
    ]);

    return buildFleetOpsSnapshot({
      economics: kpiReport.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId) ?? null,
      from,
      generatedAt,
      risk: riskReport.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId) ?? null,
      state,
      timeline,
      to,
      vehicleId
    });
  }
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function cloneDate(date: Date) {
  return new Date(date.getTime());
}
