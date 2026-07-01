import { AgentType, CoordinationIntent, type AgentTask, type MultiAgentCoordinationRequest } from "./agent.types";

export class TaskDistributor {
  distribute(request: MultiAgentCoordinationRequest): AgentTask[] {
    const tasks: AgentTask[] = [
      {
        assignedAgents: [AgentType.RISK, AgentType.ECONOMIC, AgentType.OPTIMIZATION],
        critical: true,
        requestId: request.requestId,
        taskId: `${request.requestId}:allocation-risk`,
        topic: "Resolve allocation risk and economic tradeoffs."
      },
      {
        assignedAgents: [AgentType.EXECUTION, AgentType.OPTIMIZATION],
        critical: true,
        requestId: request.requestId,
        taskId: `${request.requestId}:execution-feedback`,
        topic: "Review execution feedback before recommending any follow-up."
      },
      {
        assignedAgents: [AgentType.STATE, AgentType.TIMELINE],
        critical: false,
        requestId: request.requestId,
        taskId: `${request.requestId}:operational-consistency`,
        topic: "Cross-check snapshot state with timeline stability."
      },
      {
        assignedAgents: [AgentType.GOVERNANCE, AgentType.RISK],
        critical: request.intent === CoordinationIntent.FLEET_OPTIMIZATION_REVIEW,
        requestId: request.requestId,
        taskId: `${request.requestId}:policy-consistency`,
        topic: "Keep policy evolution advisory and aligned with live controls."
      }
    ];

    return tasks;
  }
}
