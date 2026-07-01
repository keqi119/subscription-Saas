import { AgentType, type AgentDefinition } from "./agent.types";

export const AGENT_REGISTRY: AgentDefinition[] = [
  {
    agentType: AgentType.RISK,
    description: "PR-4 risk and control evaluator",
    priority: 1
  },
  {
    agentType: AgentType.ECONOMIC,
    description: "PR-3 economic and ROI interpreter",
    priority: 2
  },
  {
    agentType: AgentType.EXECUTION,
    description: "PR-5 execution history observer",
    priority: 3
  },
  {
    agentType: AgentType.OPTIMIZATION,
    description: "PR-6 optimization strategist",
    priority: 4
  },
  {
    agentType: AgentType.STATE,
    description: "PR-1 state interpreter",
    priority: 5
  },
  {
    agentType: AgentType.TIMELINE,
    description: "PR-2 timeline analyzer",
    priority: 6
  },
  {
    agentType: AgentType.GOVERNANCE,
    description: "PR-7 policy evolution analyst",
    priority: 7
  }
];

export function agentPriority(agentType: AgentType) {
  return AGENT_REGISTRY.find((agent) => agent.agentType === agentType)?.priority ?? Number.MAX_SAFE_INTEGER;
}

export function sortAgentsByPriority(agentTypes: AgentType[]) {
  return [...agentTypes].sort((left, right) => agentPriority(left) - agentPriority(right));
}
