import { Injectable } from "@nestjs/common";

import { MultiAgentCoordinatorService } from "./coordination/multi-agent-coordinator.service";
import { FleetKpiService } from "./economics/fleet-kpi.service";
import { FleetGovernanceService } from "./governance/fleet-governance.service";
import { FleetOptimizationService } from "./optimization/fleet-optimization.service";
import { FleetRiskService } from "./risk/fleet-risk.service";
import { VehicleTimelineService } from "./timeline/vehicle-timeline.service";
import { VehicleOperationalStateService } from "./vehicle-operational-state.service";
import { FleetOpsInvalidRangeError } from "./fleet-ops.errors";
import {
  FleetOpsFacade as FleetOpsConvergenceFacade,
  type FleetOpsQueryOptions
} from "./facade/fleet-ops.facade";
import type { FleetOpsSnapshot } from "./facade/fleet-ops.snapshot.types";
import type {
  FleetOpsCoordinationContract,
  FleetOpsCoordinationInputContract,
  FleetOpsGovernanceContract,
  FleetOpsRangeContract,
  FleetOpsTimelineContract,
  FleetOpsVehicleKpiContract,
  FleetOpsVehicleOptimizationContract,
  FleetOpsVehicleRiskContract,
  FleetOpsVehicleStateContract
} from "./fleet-ops.contracts";

@Injectable()
export class FleetOpsFacade {
  constructor(
    private readonly stateService: VehicleOperationalStateService,
    private readonly timelineService: VehicleTimelineService,
    private readonly kpiService: FleetKpiService,
    private readonly riskService: FleetRiskService,
    private readonly optimizationService: FleetOptimizationService,
    private readonly governanceService: FleetGovernanceService,
    private readonly coordinatorService: MultiAgentCoordinatorService
  ) {}

  async query(vehicleId: string, options: FleetOpsQueryOptions = {}): Promise<FleetOpsSnapshot> {
    const convergenceFacade = new FleetOpsConvergenceFacade({
      kpiService: this.kpiService,
      riskService: this.riskService,
      stateService: this.stateService,
      timelineService: this.timelineService
    });

    return convergenceFacade.query(vehicleId, options);
  }

  async getVehicleState(vehicleId: string, asOf?: Date): Promise<FleetOpsVehicleStateContract> {
    return this.stateService.resolveVehicleOperationalState(vehicleId, asOf);
  }

  async getVehicleTimeline(vehicleId: string, from: Date, to: Date): Promise<FleetOpsTimelineContract> {
    assertValidRange({ from, to });

    return this.timelineService.getVehicleTimeline(vehicleId, from, to);
  }

  async getVehicleKpi(vehicleId: string, range: FleetOpsRangeContract): Promise<FleetOpsVehicleKpiContract | null> {
    assertValidRange(range);
    const report = await this.kpiService.getFleetKpis([vehicleId], range.from, range.to);

    return report.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId) ?? null;
  }

  async getVehicleRisk(vehicleId: string, range: FleetOpsRangeContract): Promise<FleetOpsVehicleRiskContract | null> {
    assertValidRange(range);
    const report = await this.riskService.getFleetRisk([vehicleId], range.from, range.to);

    return report.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId) ?? null;
  }

  async getVehicleOptimization(vehicleId: string, range: FleetOpsRangeContract): Promise<FleetOpsVehicleOptimizationContract | null> {
    assertValidRange(range);
    const report = await this.optimizationService.getFleetOptimization([vehicleId], range.from, range.to);

    return report.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId) ?? null;
  }

  async getFleetGovernanceReport(range: FleetOpsRangeContract): Promise<FleetOpsGovernanceContract> {
    assertValidRange(range);

    return this.governanceService.getFleetGovernance(range.vehicleIds ?? [], range.from, range.to);
  }

  async coordinateFleetDecision(input: FleetOpsCoordinationInputContract): Promise<FleetOpsCoordinationContract> {
    return this.coordinatorService.coordinate(input);
  }
}

function assertValidRange(range: Pick<FleetOpsRangeContract, "from" | "to">) {
  if (range.from.getTime() > range.to.getTime()) {
    throw new FleetOpsInvalidRangeError();
  }
}
