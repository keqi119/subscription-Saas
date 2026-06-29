import { describe, expect, it } from "vitest";

import {
  compileSigningPlan,
  createSigningPlanGenerationAuditLog
} from "../src/esign/enterprise-seal/signing-plan-compiler";
import { hashSigningPlanPayload } from "../src/esign/enterprise-seal/signing-plan-hash";
import type {
  EnterpriseSealView,
  SignaturePolicyEngineDecision,
  SignaturePolicyView
} from "../src/esign/enterprise-seal/enterprise-seal.types";

describe("enterprise seal signing plan compiler", () => {
  it("hashes equivalent semantic payloads reproducibly", () => {
    const left = hashSigningPlanPayload({
      executionMode: "SEQUENTIAL",
      policyId: "policy-1",
      sealId: "seal-1",
      steps: [
        { required: true, signerRole: "CUSTOMER", stepOrder: 1 },
        { required: true, signerRole: "ENTERPRISE_SEAL", stepOrder: 2 }
      ]
    });
    const right = hashSigningPlanPayload({
      policyId: "policy-1",
      sealId: "seal-1",
      executionMode: "SEQUENTIAL",
      steps: [
        { signerRole: "CUSTOMER", stepOrder: 1, required: true },
        { signerRole: "ENTERPRISE_SEAL", required: true, stepOrder: 2 }
      ]
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("changes the hash when the seal or step order changes", () => {
    const base = compileSigningPlan(baseInput());
    const differentSeal = compileSigningPlan(baseInput({
      seal: activeSeal({ id: "seal-2" })
    }));
    const differentOrder = compileSigningPlan(baseInput({
      policy: activePolicy({ executionMode: "PARALLEL" })
    }));

    expect(differentSeal.hash).not.toBe(base.hash);
    expect(differentOrder.hash).not.toBe(base.hash);
  });

  it("compiles an immutable customer then enterprise seal signing plan", () => {
    const plan = compileSigningPlan(baseInput());

    expect(plan).toMatchObject({
      constraints: {
        contractStatusRequired: "PENDING_SIGN",
        customerStatusRequired: "ACTIVE",
        realNameStatusRequired: "VERIFIED",
        sealRequired: true
      },
      executionMode: "SEQUENTIAL",
      planId: expect.stringMatching(/^plan_[a-f0-9]{24}$/),
      policyId: "policy-1",
      sealId: "seal-1",
      version: 1
    });
    expect(plan.steps).toEqual([
      {
        required: true,
        signerRole: "CUSTOMER",
        signerType: "CUSTOMER",
        stepOrder: 1,
        stepType: "CUSTOMER_SIGN"
      },
      {
        required: true,
        sealId: "seal-1",
        signerRole: "ENTERPRISE_SEAL",
        signerType: "PLATFORM",
        stepOrder: 2,
        stepType: "ENTERPRISE_SEAL"
      }
    ]);
    expect(() => {
      (plan.steps as unknown as Array<unknown>).push({ stepOrder: 3 });
    }).toThrow(TypeError);
  });

  it("does not include masked audit fields in provider execution refs", () => {
    const plan = compileSigningPlan(baseInput({
      customerId: "customer-secret-1",
      seal: activeSeal({ providerSealId: "fadada-seal-secret-1" })
    }));

    expect(JSON.stringify(plan)).not.toContain("customer-secret-1");
    expect(JSON.stringify(plan)).not.toContain("fadada-seal-secret-1");
  });

  it("creates a masked plan generation audit summary", () => {
    const plan = compileSigningPlan(baseInput({
      customerId: "customer-secret-1"
    }));
    const audit = createSigningPlanGenerationAuditLog(plan, {
      customerId: "customer-secret-1",
      source: "ADMIN"
    });

    expect(audit).toMatchObject({
      action: "esign.signing_plan.compile",
      planHash: plan.hash,
      policyId: "policy-1",
      source: "ADMIN"
    });
    expect(JSON.stringify(audit)).not.toContain("customer-secret-1");
    expect(JSON.stringify(audit)).toContain("custo...et-1");
  });
});

function baseInput(overrides: Partial<Parameters<typeof compileSigningPlan>[0]> = {}) {
  const policy = overrides.policy ?? activePolicy();
  const seal = overrides.seal ?? activeSeal();
  return {
    contractId: "contract-1",
    customerId: "customer-secret-1",
    decision: {
      code: "ALLOW",
      compileAllowed: true,
      reasonCode: "POLICY_AUTHORITY_READY",
      requiresApproval: false
    } satisfies SignaturePolicyEngineDecision,
    orderId: "order-1",
    policy,
    seal,
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
