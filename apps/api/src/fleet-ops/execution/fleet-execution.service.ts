import { Injectable } from "@nestjs/common";

import { FleetRiskService } from "../risk/fleet-risk.service";
import { ActionOrchestratorService } from "./action-orchestrator.service";
import type { FleetExecutionRequest } from "./execution.types";

@Injectable()
export class FleetExecutionService {
  constructor(
    private readonly fleetRiskService: FleetRiskService,
    private readonly actionOrchestrator: ActionOrchestratorService = new ActionOrchestratorService()
  ) {}

  async executeAction(request: FleetExecutionRequest, from: Date, to: Date) {
    const riskReport = await this.fleetRiskService.getFleetRisk([request.vehicleId], from, to);
    const riskSnapshot = riskReport.vehicles.find((vehicle) => vehicle.vehicleId === request.vehicleId);

    return this.actionOrchestrator.execute(request, riskSnapshot as never);
  }
}
