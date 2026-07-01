import { Inject, Injectable, Optional } from "@nestjs/common";

import { AgentCommunicationBus } from "./agent-communication.bus";
import { AgentOrchestratorService } from "./agent-orchestrator.service";
import { CoordinationEngine } from "./coordination-engine";
import { TaskDistributor } from "./task-distributor";
import type { MultiAgentCoordinationRequest } from "./agent.types";

@Injectable()
export class MultiAgentCoordinatorService {
  private readonly communicationBus = new AgentCommunicationBus();
  private readonly coordinationEngine = new CoordinationEngine();
  private readonly taskDistributor = new TaskDistributor();

  constructor(@Optional() @Inject(AgentOrchestratorService) private readonly agentOrchestrator = new AgentOrchestratorService()) {}

  async coordinate(request: MultiAgentCoordinationRequest) {
    this.taskDistributor.distribute(request);
    this.communicationBus.startCollection(request.requestId);

    const outputs = await this.agentOrchestrator.runAgents(request);

    for (const output of outputs) {
      await this.communicationBus.broadcast(request.requestId, output);
    }

    return this.coordinationEngine.synthesize(this.communicationBus.getOutputs(request.requestId));
  }
}
