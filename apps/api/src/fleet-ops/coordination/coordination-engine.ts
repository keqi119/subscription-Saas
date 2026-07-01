import { ConflictResolutionEngine } from "./conflict-resolution.engine";
import { agentPriority } from "./agent-registry";
import { AgentType } from "./agent.types";
import type { AgentOutput, CoordinationOutput } from "./agent.types";

export class CoordinationEngine {
  constructor(private readonly conflictResolutionEngine = new ConflictResolutionEngine()) {}

  synthesize(agentOutputs: AgentOutput[]): CoordinationOutput {
    const agentContributions = sortOutputs(agentOutputs);
    const conflictMap = this.conflictResolutionEngine.buildConflictMap(agentContributions);
    const unresolvedConflicts = this.conflictResolutionEngine.unresolvedConflicts(conflictMap);

    return {
      agentContributions,
      confidenceScore: calculateConfidence(agentContributions, unresolvedConflicts),
      conflictMap,
      consensusRecommendations: this.conflictResolutionEngine.consensusRecommendations(agentContributions),
      unifiedInsights: unique(agentContributions.flatMap((output) => output.insights)),
      unresolvedConflicts
    };
  }
}

function calculateConfidence(outputs: AgentOutput[], unresolvedConflicts: string[]) {
  if (outputs.length === 0) {
    return 0;
  }

  const averageConfidence = outputs.reduce((total, output) => total + output.confidence, 0) / outputs.length;
  const riskAnchorBonus = outputs.some((output) => output.agentType === AgentType.RISK) ? 5 : 0;
  const unresolvedPenalty = unresolvedConflicts.length * 2;

  return clampScore(Math.round(averageConfidence + riskAnchorBonus - unresolvedPenalty));
}

function sortOutputs(outputs: AgentOutput[]) {
  return [...outputs].sort((left, right) => agentPriority(left.agentType) - agentPriority(right.agentType));
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function clampScore(score: number) {
  return Math.max(0, Math.min(100, score));
}
