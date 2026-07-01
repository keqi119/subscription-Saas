import {
  OptimizationPriority,
  OptimizationSuggestionType,
  type OptimizationSuggestion,
  type OptimizationVehicleContext
} from "./optimization.types";

export class UtilizationOptimizer {
  recommend(context: OptimizationVehicleContext): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];
    const utilizationRate = context.kpi.utilization.utilizationRate;
    const idleDays = context.kpi.downtime.breakdown.IDLE;

    if (utilizationRate < 0.35) {
      suggestions.push({
        confidence: confidenceFromSignals(["PR2:timeline", "PR3:utilization"], context),
        description: "Increase allocation pressure for under-utilized vehicle or move it into a demand segment with higher booking probability.",
        expectedImpact: {
          utilizationIncrease: roundRatio(Math.min(0.5, 0.65 - utilizationRate))
        },
        priority: OptimizationPriority.HIGH,
        reasoningTrace: [
          `Observed utilization=${roundRatio(utilizationRate)}`,
          `Observed idleDays=${idleDays}`
        ],
        requiredSignals: ["PR2:timeline", "PR3:utilization"],
        type: OptimizationSuggestionType.UTILIZATION
      });
    }

    if (idleDays >= 2 && utilizationRate < 0.6) {
      suggestions.push({
        confidence: confidenceFromSignals(["PR3:downtime.IDLE"], context),
        description: "Reduce idle inventory by prioritizing this vehicle for upcoming eligible orders before acquiring or preparing additional supply.",
        expectedImpact: {
          utilizationIncrease: roundRatio(Math.min(0.25, idleDays / Math.max(context.timeline.length, 1)))
        },
        priority: OptimizationPriority.MEDIUM,
        reasoningTrace: [`Observed idleDays=${idleDays}`],
        requiredSignals: ["PR3:downtime.IDLE"],
        type: OptimizationSuggestionType.UTILIZATION
      });
    }

    return suggestions;
  }
}

function confidenceFromSignals(requiredSignals: string[], context: OptimizationVehicleContext) {
  let score = 60 + requiredSignals.length * 10;

  if (context.timeline.length === 0) {
    score -= 20;
  }

  if (!context.risk) {
    score -= 10;
  }

  return Math.min(95, Math.max(35, score));
}

function roundRatio(value: number) {
  return Number(value.toFixed(6));
}
