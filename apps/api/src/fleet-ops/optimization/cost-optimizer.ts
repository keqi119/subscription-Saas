import {
  OptimizationPriority,
  OptimizationSuggestionType,
  type OptimizationSuggestion,
  type OptimizationVehicleContext
} from "./optimization.types";

export class CostOptimizer {
  recommend(context: OptimizationVehicleContext): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];
    const downtimeCost = context.kpi.downtime.downtimeCost;
    const cost = context.kpi.economics.cost;
    const revenue = context.kpi.economics.revenue;

    if (cost > revenue) {
      suggestions.push({
        confidence: 80,
        description: "Cost exceeds realized revenue; reduce preventable downtime and inspect maintenance timing before further allocation.",
        expectedImpact: {
          costReduction: roundMoney(Math.min(cost - revenue, downtimeCost || cost * 0.15))
        },
        priority: OptimizationPriority.MEDIUM,
        reasoningTrace: [
          `Observed cost=${cost}`,
          `Observed revenue=${revenue}`,
          `Observed downtimeCost=${downtimeCost}`
        ],
        requiredSignals: ["PR3:cost>revenue", "PR3:downtimeCost"],
        type: OptimizationSuggestionType.COST
      });
    }

    if (downtimeCost > revenue * 0.25 && revenue > 0) {
      suggestions.push({
        confidence: 75,
        description: "Downtime cost is materially high relative to revenue; sequence maintenance during lower-demand windows.",
        expectedImpact: {
          costReduction: roundMoney(downtimeCost * 0.2)
        },
        priority: OptimizationPriority.MEDIUM,
        reasoningTrace: [`Observed downtimeCost=${downtimeCost}`, `Observed revenue=${revenue}`],
        requiredSignals: ["PR3:downtimeCost", "PR3:revenue"],
        type: OptimizationSuggestionType.COST
      });
    }

    return suggestions;
  }
}

function roundMoney(value: number) {
  return Number(value.toFixed(6));
}
