import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AgentOrchestratorService } from "./coordination/agent-orchestrator.service";
import { MultiAgentCoordinatorService } from "./coordination/multi-agent-coordinator.service";
import { FleetKpiService } from "./economics/fleet-kpi.service";
import { ActionOrchestratorService } from "./execution/action-orchestrator.service";
import { ExecutionLogService } from "./execution/execution-log.service";
import { FleetExecutionService } from "./execution/fleet-execution.service";
import { FleetGovernanceService } from "./governance/fleet-governance.service";
import { FleetOptimizationService } from "./optimization/fleet-optimization.service";
import { FleetRiskService } from "./risk/fleet-risk.service";
import { VehicleTimelineService } from "./timeline/vehicle-timeline.service";
import { FleetOpsApiEnabledGuard } from "./fleet-ops.api.guard";
import { FleetOpsController } from "./fleet-ops.controller";
import { FleetOpsFacade } from "./fleet-ops.facade";
import { FleetOpsHealthService } from "./fleet-ops.health.service";
import { VehicleOperationalStateRepository } from "./vehicle-operational-state.repository";
import { VehicleOperationalStateService } from "./vehicle-operational-state.service";

@Module({
  controllers: [FleetOpsController],
  exports: [FleetOpsFacade, FleetOpsHealthService],
  imports: [AuthModule, PrismaModule],
  providers: [
    VehicleOperationalStateRepository,
    VehicleOperationalStateService,
    VehicleTimelineService,
    FleetKpiService,
    FleetRiskService,
    ExecutionLogService,
    ActionOrchestratorService,
    FleetExecutionService,
    FleetOptimizationService,
    FleetGovernanceService,
    AgentOrchestratorService,
    MultiAgentCoordinatorService,
    FleetOpsApiEnabledGuard,
    FleetOpsFacade,
    FleetOpsHealthService
  ]
})
export class FleetOpsModule {}
