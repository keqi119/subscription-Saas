import {
  maskEnterpriseCustomerId,
  maskEnterpriseSealId
} from "./enterprise-seal-mask";
import type {
  SealAuthorityView,
  SignaturePolicyEngineDecision,
  SignaturePolicyEngineInput
} from "./enterprise-seal.types";
import {
  compileSigningPlan,
  type SigningPlanCompilerInput
} from "./signing-plan-compiler";

export class SignaturePolicyEngine {
  evaluate(input: SignaturePolicyEngineInput): SignaturePolicyEngineDecision {
    if (input.customer.status !== "ACTIVE") {
      return decision(input, "DENY", "CUSTOMER_NOT_ACTIVE");
    }
    if (!input.customerReadiness.signingEligible) {
      const code = input.customerReadiness.realNameStatus === "VERIFIED"
        ? "REQUIRE_ONBOARDING"
        : "REQUIRE_REALNAME";
      return decision(input, code, code === "REQUIRE_REALNAME"
        ? "CUSTOMER_REALNAME_NOT_VERIFIED"
        : "CUSTOMER_NOT_SIGNING_READY");
    }
    if (input.customerReadiness.realNameStatus !== "VERIFIED") {
      return decision(input, "REQUIRE_REALNAME", "CUSTOMER_REALNAME_NOT_VERIFIED");
    }
    if (input.contract.status !== "PENDING_SIGN") {
      return decision(input, "DENY", "CONTRACT_NOT_PENDING_SIGN");
    }
    if (!input.policy || input.policy.status !== "ACTIVE") {
      return decision(input, "REQUIRE_POLICY_SELECTION", "ACTIVE_POLICY_MISSING");
    }
    if (input.policy.requiresEnterpriseSeal) {
      if (!input.seal || input.seal.status !== "ACTIVE") {
        return decision(input, "DENY", "ACTIVE_SEAL_MISSING");
      }
      if (input.policy.defaultSealId && input.seal.id !== input.policy.defaultSealId) {
        return decision(input, "DENY", "SEAL_POLICY_MISMATCH");
      }
      const authority = findUsableAuthority(input);
      if (!authority) {
        return decision(input, "REQUIRE_SEAL_AUTHORITY", "SEAL_AUTHORITY_MISSING");
      }
      if (authority.requiresTwoPersonApproval) {
        return decision(input, "REQUIRE_APPROVAL", "SEAL_APPROVAL_REQUIRED", {
          requiresApproval: true
        });
      }
    }

    return decision(input, "ALLOW", "POLICY_AUTHORITY_READY", {
      compileAllowed: true
    });
  }

  resolve(
    customer: SignaturePolicyEngineInput["customer"],
    contract: SignaturePolicyEngineInput["contract"],
    context: Omit<SignaturePolicyEngineInput, "contract" | "customer">
  ) {
    return this.evaluate({ ...context, contract, customer });
  }

  compile(input: SigningPlanCompilerInput) {
    return compileSigningPlan(input);
  }
}

export function createPolicyEvaluationAuditLog(input: SignaturePolicyEngineInput) {
  return {
    actorId: input.actor.id,
    contractId: input.contract.id,
    customerIdMasked: maskEnterpriseCustomerId(input.customer.id),
    policyId: input.policy?.id ?? null,
    sealId: input.seal?.id ?? null,
    providerSealIdMasked: maskEnterpriseSealId(input.seal?.providerSealId),
    source: input.source
  };
}

function findUsableAuthority(input: SignaturePolicyEngineInput): SealAuthorityView | undefined {
  const expectedSealId = input.seal?.id ?? input.policy?.defaultSealId;
  return input.authorities.find((authority) =>
    authority.status === "ACTIVE" &&
    authority.sealId === expectedSealId &&
    (authority.authorityType === "REQUEST_USE" || authority.authorityType === "AUTO_USE") &&
    (
      (authority.subjectType === "USER" && authority.subjectId === input.actor.id) ||
      (authority.subjectType === "ROLE" && input.actor.roleCodes.includes(authority.subjectId)) ||
      authority.subjectType === "SYSTEM"
    )
  );
}

function decision(
  input: SignaturePolicyEngineInput,
  code: SignaturePolicyEngineDecision["code"],
  reasonCode: string,
  overrides: Partial<SignaturePolicyEngineDecision> = {}
): SignaturePolicyEngineDecision {
  return {
    auditSummary: createPolicyEvaluationAuditLog(input),
    code,
    compileAllowed: false,
    policyId: input.policy?.id,
    reasonCode,
    requiresApproval: false,
    sealId: input.seal?.id,
    ...overrides
  };
}
