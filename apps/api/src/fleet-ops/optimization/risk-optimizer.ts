import { ControlDecision } from "../risk/risk.types";
import {
  OptimizationPriority,
  OptimizationSuggestionType,
  type OptimizationSuggestion,
  type OptimizationVehicleContext
} from "./optimization.types";

export class RiskOptimizer {
  recommend(context: OptimizationVehicleContext): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];
    const risk = context.risk;
    const roi = context.kpi.economics.roi;
    const conflictDensity = timelineConflictDensity(context);

    if (risk && roi > 0 && risk.controlDecision === ControlDecision.BLOCK) {
      suggestions.push({
        confidence: 90,
        description: "High ROI is paired with BLOCK risk; preserve economics by resolving control causes before any allocation or lease expansion.",
        expectedImpact: {
          riskReduction: Math.min(50, risk.riskScore)
        },
        priority: OptimizationPriority.HIGH,
        reasoningTrace: [`Observed roi=${roundRatio(roi)}`, `Observed controlDecision=${risk.controlDecision}`, `Observed riskScore=${risk.riskScore}`],
        requiredSignals: ["PR4:controlDecision=BLOCK", "PR3:roi>0"],
        type: OptimizationSuggestionType.RISK
      });
    }

    if (conflictDensity >= 0.2) {
      suggestions.push({
        confidence: 75,
        description: "Timeline instability is high; reconcile conflicting operational events before using this vehicle for autonomous strategy decisions.",
        expectedImpact: {
          riskReduction: roundRatio(conflictDensity * 30)
        },
        priority: OptimizationPriority.MEDIUM,
        reasoningTrace: [`Observed timelineConflictDensity=${roundRatio(conflictDensity)}`],
        requiredSignals: ["PR2:timelineConflicts"],
        type: OptimizationSuggestionType.RISK
      });
    }

    return suggestions;
  }
}

export function timelineConflictDensity(context: OptimizationVehicleContext) {
  if (context.timeline.length === 0) {
    return 0;
  }

  const conflictDays = context.timeline.filter((day) => (day.conflicts?.length ?? 0) > 0 || day.confidence < 60).length;

  return conflictDays / context.timeline.length;
}

function roundRatio(value: number) {
  return Number(value.toFixed(6));
}
