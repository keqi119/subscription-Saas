import { PolicyEvaluator } from "./policy-evaluator";
import { PolicyEvolutionModel } from "./policy-evolution.model";
import { PolicyFeedbackCollector } from "./policy-feedback.collector";
import { StrategyRegistry } from "./strategy-registry";
import type { FleetGovernanceInput, FleetGovernanceReport } from "./policy.types";

export class PolicyEngine {
  private readonly evaluator = new PolicyEvaluator();
  private readonly evolutionModel = new PolicyEvolutionModel();
  private readonly feedbackCollector = new PolicyFeedbackCollector();
  private readonly strategyRegistry = new StrategyRegistry();

  evaluate(input: FleetGovernanceInput): FleetGovernanceReport {
    const feedback = this.feedbackCollector.collect(input);
    const evaluation = this.evaluator.evaluate(input, feedback);
    const strategies = this.strategyRegistry.strategiesFor(feedback);
    const { policyProposals, rejectedPolicies } = this.evolutionModel.evolve(strategies, evaluation.metrics, feedback);
    const rejectionWarnings = rejectedPolicies.map(
      (policy) => `Policy proposal ${policy.policyId} rejected because BLOCK decisions cannot be overridden by governance.`
    );

    return {
      governanceReport: evaluation.metrics,
      insights: evaluation.insights,
      policyProposals,
      rejectedPolicies,
      riskWarnings: [...evaluation.riskWarnings, ...rejectionWarnings]
    };
  }
}
