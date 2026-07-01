import { ControlDecision } from "../risk/risk.types";
import {
  OptimizationPriority,
  OptimizationSuggestionType,
  type OptimizationSuggestion,
  type OptimizationVehicleContext
} from "./optimization.types";

export class AllocationStrategyModel {
  recommend(context: OptimizationVehicleContext): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];
    const failedExecutions = context.executionLogs.filter((log) => log.vehicleId === context.vehicleId && !log.success);

    if (failedExecutions.length > 0) {
      suggestions.push({
        confidence: 85,
        description: "Recent execution attempts failed or were blocked; adjust allocation strategy before retrying through PR-5.",
        expectedImpact: {
          riskReduction: Math.min(40, failedExecutions.length * 20)
        },
        priority: OptimizationPriority.HIGH,
        reasoningTrace: failedExecutions.map((log) => `Observed executionOutcome=${log.outcome}`),
        requiredSignals: ["PR5:failedExecution", "PR4:controlDecision"],
        type: OptimizationSuggestionType.ALLOCATION
      });
    }

    if (context.kpi.utilization.utilizationRate < 0.35 && context.risk?.controlDecision !== ControlDecision.BLOCK) {
      suggestions.push({
        confidence: 75,
        description: "Prioritize this available low-utilization vehicle for compatible orders before assigning higher-performing assets.",
        expectedImpact: {
          utilizationIncrease: Number((0.5 - context.kpi.utilization.utilizationRate).toFixed(6))
        },
        priority: OptimizationPriority.MEDIUM,
        reasoningTrace: [`Observed utilization=${context.kpi.utilization.utilizationRate}`],
        requiredSignals: ["PR3:lowUtilization", "PR4:notBlocked"],
        type: OptimizationSuggestionType.ALLOCATION
      });
    }

    return suggestions;
  }

  strategyRecommendation(context: OptimizationVehicleContext, suggestions: OptimizationSuggestion[]) {
    if (context.risk?.controlDecision === ControlDecision.BLOCK) {
      return "Do not execute allocation until PR-4 risk decision improves; route only advisory recommendations to operators.";
    }

    if (suggestions.some((suggestion) => suggestion.type === OptimizationSuggestionType.UTILIZATION)) {
      return "Prioritize allocation experiments for this vehicle, then route any accepted action through PR-5.";
    }

    if (suggestions.some((suggestion) => suggestion.type === OptimizationSuggestionType.REVENUE)) {
      return "Review pricing and segment fit before increasing allocation volume.";
    }

    return "Maintain current strategy and continue monitoring PR-1 through PR-5 signals.";
  }
}
