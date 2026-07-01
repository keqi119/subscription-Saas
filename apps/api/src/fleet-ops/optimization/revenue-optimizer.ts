import {
  OptimizationPriority,
  OptimizationSuggestionType,
  type OptimizationSuggestion,
  type OptimizationVehicleContext
} from "./optimization.types";

export class RevenueOptimizer {
  recommend(context: OptimizationVehicleContext): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];
    const utilizationRate = context.kpi.utilization.utilizationRate;
    const roi = context.kpi.economics.roi;

    if (utilizationRate >= 0.8 && roi <= 0) {
      suggestions.push({
        confidence: 85,
        description: "High utilization is not converting into positive ROI; review pricing, lease terms, and revenue leakage before increasing allocation volume.",
        expectedImpact: {
          revenueDelta: roundMoney(Math.max(context.kpi.economics.cost - context.kpi.economics.revenue, context.kpi.economics.revenue * 0.1))
        },
        priority: OptimizationPriority.HIGH,
        reasoningTrace: [
          `Observed utilization=${roundRatio(utilizationRate)}`,
          `Observed roi=${roundRatio(roi)}`
        ],
        requiredSignals: ["PR3:utilization>=0.8", "PR3:roi<=0"],
        type: OptimizationSuggestionType.REVENUE
      });
    }

    if (roi > 0.2 && (context.risk?.riskScore ?? 0) < 50) {
      suggestions.push({
        confidence: 80,
        description: "Use this high-ROI low-risk vehicle as an allocation benchmark for similar orders and segments.",
        expectedImpact: {
          revenueDelta: roundMoney(context.kpi.economics.revenue * 0.08)
        },
        priority: OptimizationPriority.MEDIUM,
        reasoningTrace: [`Observed roi=${roundRatio(roi)}`, `Observed riskScore=${context.risk?.riskScore ?? "missing"}`],
        requiredSignals: ["PR3:roi>0.2", "PR4:riskScore<50"],
        type: OptimizationSuggestionType.REVENUE
      });
    }

    return suggestions;
  }
}

function roundMoney(value: number) {
  return Number(value.toFixed(6));
}

function roundRatio(value: number) {
  return Number(value.toFixed(6));
}
