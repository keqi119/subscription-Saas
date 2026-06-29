import type {
  EnterpriseSealView,
  SignaturePolicyEngineDecision,
  SignaturePolicyView,
  SigningPlan,
  SigningPlanStep
} from "./enterprise-seal.types";
import { maskEnterpriseCustomerId } from "./enterprise-seal-mask";
import { hashSigningPlanPayload } from "./signing-plan-hash";

export interface SigningPlanCompilerInput {
  contractId: string;
  customerId?: string;
  decision: SignaturePolicyEngineDecision;
  orderId?: string;
  policy: SignaturePolicyView;
  seal?: EnterpriseSealView;
}

export function compileSigningPlan(input: SigningPlanCompilerInput): SigningPlan {
  if (!input.decision.compileAllowed || input.decision.code !== "ALLOW") {
    throw new Error("SIGNING_PLAN_COMPILE_NOT_ALLOWED");
  }
  if (input.policy.requiresEnterpriseSeal && !input.seal) {
    throw new Error("SIGNING_PLAN_SEAL_REQUIRED");
  }

  const steps = freeze([
    customerStep(),
    ...(input.policy.requiresEnterpriseSeal && input.seal ? [enterpriseSealStep(input.seal.id)] : [])
  ]);
  const constraints = freeze({
    contractStatusRequired: "PENDING_SIGN" as const,
    customerStatusRequired: "ACTIVE" as const,
    realNameStatusRequired: "VERIFIED" as const,
    sealRequired: input.policy.requiresEnterpriseSeal
  });
  const payload = {
    constraints,
    contractId: input.contractId,
    executionMode: input.policy.executionMode,
    orderId: input.orderId,
    policyId: input.policy.id,
    sealId: input.seal?.id,
    steps,
    version: 1
  };
  const hash = hashSigningPlanPayload(payload);
  const plan: SigningPlan = {
    ...payload,
    constraints,
    hash,
    planId: `plan_${hash.replace(/^sha256:/, "").slice(0, 24)}`,
    steps,
    version: 1
  };

  return freeze(plan);
}

export function createSigningPlanGenerationAuditLog(
  plan: SigningPlan,
  context: { customerId?: string; source: "ADMIN" | "ORDER" | "PORTAL" | "SYSTEM" }
) {
  return {
    action: "esign.signing_plan.compile",
    customerIdMasked: maskEnterpriseCustomerId(context.customerId),
    executionMode: plan.executionMode,
    planHash: plan.hash,
    planId: plan.planId,
    policyId: plan.policyId,
    sealId: plan.sealId ?? null,
    source: context.source,
    stepCount: plan.steps.length
  };
}

function customerStep(): SigningPlanStep {
  return freeze({
    required: true,
    signerRole: "CUSTOMER" as const,
    signerType: "CUSTOMER" as const,
    stepOrder: 1,
    stepType: "CUSTOMER_SIGN" as const
  });
}

function enterpriseSealStep(sealId: string): SigningPlanStep {
  return freeze({
    required: true,
    sealId,
    signerRole: "ENTERPRISE_SEAL" as const,
    signerType: "PLATFORM" as const,
    stepOrder: 2,
    stepType: "ENTERPRISE_SEAL" as const
  });
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => freeze(item));
    return Object.freeze(value) as T;
  }
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((item) => freeze(item));
    return Object.freeze(value);
  }
  return value;
}
