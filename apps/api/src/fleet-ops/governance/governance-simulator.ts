import type { GovernanceReportMetrics, Policy, PolicyStrategy } from "./policy.types";

export class GovernanceSimulator {
  simulate(strategy: PolicyStrategy, metrics: GovernanceReportMetrics): Policy["simulation"] {
    const projectedScore = Math.min(100, metrics.systemHealthScore + expectedScoreLift(strategy));
    const riskWarnings: string[] = [];

    if (projectedScore < metrics.systemHealthScore) {
      riskWarnings.push("Simulation indicates system health regression.");
    }

    if (strategy.policyId.includes("relax-blocked")) {
      riskWarnings.push("Simulation rejected because governance cannot override PR-4 BLOCK decisions.");
    }

    return {
      currentScore: metrics.systemHealthScore,
      projectedScore,
      riskWarnings
    };
  }
}

function expectedScoreLift(strategy: PolicyStrategy) {
  return Math.round(
    (strategy.expectedImpact.riskReduction ?? 0) * 0.45 +
      (strategy.expectedImpact.executionAccuracyIncrease ?? 0) * 0.35 +
      (strategy.expectedImpact.utilizationIncrease ?? 0) * 0.3 +
      (strategy.expectedImpact.revenueIncrease ?? 0) * 0.2
  );
}
