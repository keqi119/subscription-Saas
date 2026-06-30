import { describe, expect, it } from "vitest";

import { maskEnterpriseSealId } from "../src/esign/enterprise-seal/enterprise-seal-mask";
import {
  SignaturePolicyEngine,
  createPolicyEvaluationAuditLog
} from "../src/esign/enterprise-seal/signature-policy-engine";
import type {
  EnterpriseSealView,
  SealAuthorityView,
  SignaturePolicyEngineInput,
  SignaturePolicyView
} from "../src/esign/enterprise-seal/enterprise-seal.types";

describe("SignaturePolicyEngine", () => {
  it("masks provider seal ids in audit-safe summaries", () => {
    const providerSealId = "fadada-seal-1234567890abcdef";

    expect(maskEnterpriseSealId(providerSealId)).toBe("fadad...cdef");
    expect(JSON.stringify(createPolicyEvaluationAuditLog(baseInput({
      seal: activeSeal({ providerSealId })
    })))).not.toContain(providerSealId);
  });

  it("requires a VERIFIED customer before policy can compile", () => {
    const decision = new SignaturePolicyEngine().evaluate(baseInput({
      customerReadiness: {
        realNameStatus: "UNVERIFIED",
        signingEligible: false,
        state: "ACCOUNT_CREATED"
      }
    }));

    expect(decision).toMatchObject({
      code: "REQUIRE_REALNAME",
      compileAllowed: false,
      reasonCode: "CUSTOMER_REALNAME_NOT_VERIFIED"
    });
  });

  it("rejects inactive customers", () => {
    const decision = new SignaturePolicyEngine().evaluate(baseInput({
      customer: {
        id: "customer-secret-1",
        status: "DISABLED"
      }
    }));

    expect(decision).toMatchObject({
      code: "DENY",
      reasonCode: "CUSTOMER_NOT_ACTIVE"
    });
  });

  it("requires PENDING_SIGN contracts", () => {
    const decision = new SignaturePolicyEngine().evaluate(baseInput({
      contract: {
        businessType: "SUBSCRIPTION",
        contractTemplateType: "SUBSCRIPTION_STANDARD",
        contractVersionId: "version-1",
        id: "contract-1",
        status: "GENERATED"
      }
    }));

    expect(decision).toMatchObject({
      code: "DENY",
      reasonCode: "CONTRACT_NOT_PENDING_SIGN"
    });
  });

  it("requires an active policy before compiling a signing plan", () => {
    const decision = new SignaturePolicyEngine().evaluate(baseInput({
      policy: undefined
    }));

    expect(decision).toMatchObject({
      code: "REQUIRE_POLICY_SELECTION",
      reasonCode: "ACTIVE_POLICY_MISSING"
    });
  });

  it("requires seal authority for enterprise seal policies", () => {
    const decision = new SignaturePolicyEngine().evaluate(baseInput({
      authorities: []
    }));

    expect(decision).toMatchObject({
      code: "REQUIRE_SEAL_AUTHORITY",
      reasonCode: "SEAL_AUTHORITY_MISSING"
    });
  });

  it("requires approval when matching authority is two-person controlled", () => {
    const decision = new SignaturePolicyEngine().evaluate(baseInput({
      authorities: [authority({ requiresTwoPersonApproval: true })]
    }));

    expect(decision).toMatchObject({
      code: "REQUIRE_APPROVAL",
      reasonCode: "SEAL_APPROVAL_REQUIRED",
      requiresApproval: true
    });
  });

  it("allows compilation when customer, contract, policy, seal, and authority are ready", () => {
    const decision = new SignaturePolicyEngine().evaluate(baseInput());

    expect(decision).toMatchObject({
      code: "ALLOW",
      compileAllowed: true,
      policyId: "policy-1",
      reasonCode: "POLICY_AUTHORITY_READY",
      sealId: "seal-1"
    });
    expect(JSON.stringify(decision.auditSummary)).not.toContain("customer-secret-1");
    expect(JSON.stringify(decision.auditSummary)).not.toContain("fadada-seal-secret-1");
  });

  it("compiles an allowed decision into a reproducible signing plan", () => {
    const engine = new SignaturePolicyEngine();
    const input = baseInput();
    const decision = engine.evaluate(input);

    const plan = engine.compile({
      contractId: input.contract.id,
      decision,
      orderId: "order-1",
      policy: input.policy!,
      seal: input.seal
    });

    expect(plan).toMatchObject({
      contractId: "contract-1",
      policyId: "policy-1",
      sealId: "seal-1",
      version: 1
    });
    expect(plan.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("is pure and does not accept side-effect dependencies", () => {
    const engine = new SignaturePolicyEngine();
    const input = baseInput();
    const first = engine.evaluate(input);
    const second = engine.evaluate(input);

    expect(first).toEqual(second);
    expect(Object.keys(engine)).toEqual([]);
  });
});

function baseInput(overrides: Partial<SignaturePolicyEngineInput> = {}): SignaturePolicyEngineInput {
  return {
    actor: {
      id: "operator-1",
      permissionCodes: ["contract:sign"],
      roleCodes: ["contract-operator"]
    },
    authorities: [authority()],
    contract: {
      businessType: "SUBSCRIPTION",
      contractTemplateType: "SUBSCRIPTION_STANDARD",
      contractVersionId: "version-1",
      id: "contract-1",
      status: "PENDING_SIGN"
    },
    customer: {
      id: "customer-secret-1",
      status: "ACTIVE"
    },
    customerReadiness: {
      realNameStatus: "VERIFIED",
      signingEligible: true,
      state: "SIGNING_ENABLED"
    },
    policy: activePolicy(),
    seal: activeSeal(),
    source: "ADMIN",
    ...overrides
  };
}

function activePolicy(overrides: Partial<SignaturePolicyView> = {}): SignaturePolicyView {
  return {
    contractTemplateType: "SUBSCRIPTION_STANDARD",
    defaultSealId: "seal-1",
    executionMode: "SEQUENTIAL",
    id: "policy-1",
    policyCode: "SUBSCRIPTION_STANDARD_SEAL",
    policyName: "Subscription standard enterprise seal",
    requiresEnterpriseSeal: true,
    status: "ACTIVE",
    ...overrides
  };
}

function activeSeal(overrides: Partial<EnterpriseSealView> = {}): EnterpriseSealView {
  return {
    id: "seal-1",
    provider: "FADADA",
    providerSealId: "fadada-seal-secret-1",
    sealName: "Company seal",
    sealType: "COMPANY",
    status: "ACTIVE",
    ...overrides
  };
}

function authority(overrides: Partial<SealAuthorityView> = {}): SealAuthorityView {
  return {
    authorityType: "REQUEST_USE",
    id: "authority-1",
    requiresTwoPersonApproval: false,
    sealId: "seal-1",
    status: "ACTIVE",
    subjectId: "operator-1",
    subjectType: "USER",
    ...overrides
  };
}
