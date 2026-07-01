import { AgentType, type AgentOutput } from "./agent.types";
import { agentPriority, sortAgentsByPriority } from "./agent-registry";

export class ConflictResolutionEngine {
  buildConflictMap(outputs: AgentOutput[]) {
    const conflictMap: Record<string, AgentType[]> = {};

    for (const output of outputs) {
      for (const conflict of output.conflictsDetected) {
        conflictMap[conflict] = sortAgentsByPriority([...new Set([...(conflictMap[conflict] ?? []), output.agentType])]);
      }
    }

    return conflictMap;
  }

  consensusRecommendations(outputs: AgentOutput[]) {
    const recommendations = new Map<string, AgentType>();

    for (const output of sortOutputs(outputs)) {
      for (const recommendation of output.recommendations) {
        if (!recommendations.has(recommendation)) {
          recommendations.set(recommendation, output.agentType);
        }
      }
    }

    return [...recommendations.entries()]
      .sort((left, right) => agentPriority(left[1]) - agentPriority(right[1]) || left[0].localeCompare(right[0]))
      .map(([recommendation]) => recommendation);
  }

  unresolvedConflicts(conflictMap: Record<string, AgentType[]>) {
    return Object.entries(conflictMap)
      .filter(([conflict, agents]) => (agents.length === 1 && agents[0] === AgentType.GOVERNANCE) || conflict.includes("policy"))
      .map(([conflict]) => conflict)
      .sort();
  }
}

function sortOutputs(outputs: AgentOutput[]) {
  return [...outputs].sort((left, right) => agentPriority(left.agentType) - agentPriority(right.agentType));
}
