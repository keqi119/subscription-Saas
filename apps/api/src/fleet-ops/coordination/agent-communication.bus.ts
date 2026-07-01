import { agentPriority } from "./agent-registry";
import type { AgentOutput } from "./agent.types";

export class AgentCommunicationBus {
  private readonly outputsByCorrelationId = new Map<string, AgentOutput[]>();
  private readonly waitersByCorrelationId = new Map<string, Array<() => void>>();

  startCollection(correlationId: string) {
    this.outputsByCorrelationId.set(correlationId, []);
    this.waitersByCorrelationId.set(correlationId, []);
  }

  async broadcast(correlationId: string, output: AgentOutput) {
    const outputs = this.outputsByCorrelationId.get(correlationId) ?? [];

    outputs.push(cloneAgentOutput(output));
    this.outputsByCorrelationId.set(correlationId, sortOutputs(outputs));

    for (const resolve of this.waitersByCorrelationId.get(correlationId) ?? []) {
      resolve();
    }
  }

  async collect(correlationId: string, expectedCount: number): Promise<AgentOutput[]> {
    while ((this.outputsByCorrelationId.get(correlationId)?.length ?? 0) < expectedCount) {
      await new Promise<void>((resolve) => {
        const waiters = this.waitersByCorrelationId.get(correlationId) ?? [];

        waiters.push(resolve);
        this.waitersByCorrelationId.set(correlationId, waiters);
      });
    }

    return this.getOutputs(correlationId).slice(0, expectedCount);
  }

  getOutputs(correlationId: string) {
    return sortOutputs(this.outputsByCorrelationId.get(correlationId) ?? []).map(cloneAgentOutput);
  }
}

function sortOutputs(outputs: AgentOutput[]) {
  return [...outputs].sort((left, right) => agentPriority(left.agentType) - agentPriority(right.agentType));
}

function cloneAgentOutput(output: AgentOutput): AgentOutput {
  return {
    agentType: output.agentType,
    confidence: output.confidence,
    conflictsDetected: [...output.conflictsDetected],
    insights: [...output.insights],
    recommendations: [...output.recommendations],
    supportingSignals: [...output.supportingSignals]
  };
}
