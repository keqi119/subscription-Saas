import { PolicyDomain, type GovernanceReportMetrics, type Policy, type PolicyFeedbackMetrics, type PolicyStrategy } from "./policy.types";
import { GovernanceSimulator } from "./governance-simulator";

export class PolicyEvolutionModel {
  private readonly simulator = new GovernanceSimulator();

  evolve(strategies: PolicyStrategy[], metrics: GovernanceReportMetrics, feedback: PolicyFeedbackMetrics) {
    const policyProposals: Policy[] = [];
    const rejectedPolicies: Policy[] = [];

    for (const strategy of strategies) {
      const simulation = this.simulator.simulate(strategy, metrics);
      const policy = {
        confidence: confidenceFor(strategy, feedback, simulation.projectedScore > simulation.currentScore),
        currentConfig: strategy.currentConfig,
        domain: strategy.domain,
        expectedImpact: strategy.expectedImpact,
        policyId: strategy.policyId,
        proposedUpdate: strategy.proposedUpdate,
        reason: strategy.reason,
        simulation
      };

      if (shouldReject(strategy, policy)) {
        rejectedPolicies.push(policy);
      } else {
        policyProposals.push(policy);
      }
    }

    return { policyProposals, rejectedPolicies };
  }
}

function shouldReject(strategy: PolicyStrategy, policy: Policy) {
  return strategy.domain === PolicyDomain.ALLOCATION && strategy.policyId.includes("relax-blocked") || policy.simulation.projectedScore <= policy.simulation.currentScore;
}

function confidenceFor(strategy: PolicyStrategy, feedback: PolicyFeedbackMetrics, improvesHealth: boolean) {
  let score = improvesHealth ? 70 : 45;
  const evidenceValue = feedback[strategy.minimumEvidence];

  if (typeof evidenceValue === "number" && evidenceValue > 0) {
    score += 15;
  }

  if (strategy.reason.length >= 2) {
    score += 5;
  }

  return Math.min(95, Math.max(25, score));
}
