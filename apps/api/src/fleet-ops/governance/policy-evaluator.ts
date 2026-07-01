import type { FleetGovernanceInput, PolicyEvaluationResult, PolicyFeedbackMetrics } from "./policy.types";

export class PolicyEvaluator {
  evaluate(input: FleetGovernanceInput, feedback: PolicyFeedbackMetrics): PolicyEvaluationResult {
    const policyDriftIndex = calculatePolicyDriftIndex(feedback);
    const stabilityScore = calculateStabilityScore(feedback);
    const systemHealthScore = calculateSystemHealthScore(policyDriftIndex, stabilityScore, feedback);
    const insights = buildInsights(feedback);

    return {
      feedback,
      insights,
      metrics: {
        policyDriftIndex,
        stabilityScore,
        systemHealthScore
      },
      riskWarnings: buildRiskWarnings(feedback)
    };
  }
}

function calculatePolicyDriftIndex(feedback: PolicyFeedbackMetrics) {
  return clampScore(
    feedback.blockedHighRoiVehicles * 18 +
      feedback.failedExecutionCount * 14 +
      feedback.timelineConflictDensity * 60 +
      feedback.negativeRoiHighUtilizationVehicles * 10
  );
}

function calculateStabilityScore(feedback: PolicyFeedbackMetrics) {
  return clampScore(100 - feedback.timelineConflictDensity * 90 - feedback.executionFailureRate * 35 - feedback.blockedHighRoiVehicles * 12);
}

function calculateSystemHealthScore(policyDriftIndex: number, stabilityScore: number, feedback: PolicyFeedbackMetrics) {
  return clampScore(stabilityScore * 0.6 + (100 - policyDriftIndex) * 0.4 - feedback.riskExposureIndex * 0.1);
}

function buildInsights(feedback: PolicyFeedbackMetrics) {
  const insights: string[] = [];

  if (feedback.blockedHighRoiVehicles > 0) {
    insights.push(`Observed ${feedback.blockedHighRoiVehicles} blocked high-ROI vehicle(s), indicating possible over-tight risk policy.`);
  }

  if (feedback.failedExecutionCount > 0) {
    insights.push(`Observed ${feedback.failedExecutionCount} failed execution attempt(s), requiring execution policy review.`);
  }

  insights.push(`Observed timeline conflict density of ${Number(feedback.timelineConflictDensity.toFixed(2))}.`);

  return insights;
}

function buildRiskWarnings(feedback: PolicyFeedbackMetrics) {
  const warnings: string[] = [];

  if (feedback.blockedHighRoiVehicles > 0 && feedback.failedExecutionCount > 0) {
    warnings.push("Blocked high-ROI assets are also producing failed execution attempts; policy tuning must remain advisory.");
  }

  return warnings;
}

function clampScore(score: number) {
  return Math.min(100, Math.max(0, Math.round(score)));
}
