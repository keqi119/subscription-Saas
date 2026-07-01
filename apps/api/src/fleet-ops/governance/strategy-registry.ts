import { PolicyDomain, type PolicyFeedbackMetrics, type PolicyStrategy } from "./policy.types";

export class StrategyRegistry {
  strategiesFor(feedback: PolicyFeedbackMetrics): PolicyStrategy[] {
    const strategies: PolicyStrategy[] = [];

    if (feedback.blockedHighRoiVehicles > 0) {
      strategies.push({
        currentConfig: {
          blockThreshold: 85,
          highRoiRiskReview: false
        },
        domain: PolicyDomain.RISK,
        expectedImpact: {
          riskReduction: 18,
          revenueIncrease: 4
        },
        minimumEvidence: "blockedHighRoiVehicles",
        policyId: "risk.block-threshold.tuning",
        proposedUpdate: {
          blockThresholdDelta: 5,
          highRoiRiskReview: true
        },
        reason: ["PR4:blockedHighRoiVehicles=1", "PR3:roi>0.2", "PR6:riskRecommendationPresent"]
      });
      strategies.push({
        currentConfig: {
          allowBlockedHighRoiAllocation: false
        },
        domain: PolicyDomain.ALLOCATION,
        expectedImpact: {
          revenueIncrease: 10
        },
        minimumEvidence: "blockedHighRoiVehicles",
        policyId: "allocation.relax-blocked-high-roi",
        proposedUpdate: {
          allowBlockedHighRoiAllocation: true
        },
        reason: ["PR3:highRoi", "PR4:controlDecision=BLOCK"]
      });
    }

    if (feedback.failedExecutionCount > 0) {
      strategies.push({
        currentConfig: {
          blockedRetryPolicy: "allow_manual_retry",
          overrideReviewRequired: false
        },
        domain: PolicyDomain.EXECUTION,
        expectedImpact: {
          executionAccuracyIncrease: 20
        },
        minimumEvidence: "failedExecutionCount",
        policyId: "execution.override-review.tuning",
        proposedUpdate: {
          blockedRetryPolicy: "require_operator_review",
          overrideReviewRequired: true
        },
        reason: ["PR5:failedExecutionCount=1", "PR4:controlDecision=BLOCK"]
      });
    }

    if (feedback.timelineConflictDensity >= 0.2) {
      strategies.push({
        currentConfig: {
          conflictDensityThreshold: 0.2
        },
        domain: PolicyDomain.UTILIZATION,
        expectedImpact: {
          utilizationIncrease: 8
        },
        minimumEvidence: "timelineConflictDensity",
        policyId: "utilization.timeline-stability.tuning",
        proposedUpdate: {
          conflictDensityThresholdDelta: -0.05,
          requireTimelineReconciliation: true
        },
        reason: ["PR2:timelineConflictDensity>=0.2", "PR6:optimizationOpportunityScore"]
      });
    }

    if (feedback.negativeRoiHighUtilizationVehicles > 0) {
      strategies.push({
        currentConfig: {
          roiWeight: 0.25
        },
        domain: PolicyDomain.ECONOMICS,
        expectedImpact: {
          revenueIncrease: 6
        },
        minimumEvidence: "negativeRoiHighUtilizationVehicles",
        policyId: "economics.roi-weight.tuning",
        proposedUpdate: {
          roiWeightDelta: 0.05
        },
        reason: ["PR3:highUtilizationLowRoi"]
      });
    }

    return strategies;
  }
}
