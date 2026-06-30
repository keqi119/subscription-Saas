export type EnterpriseSealType = "COMPANY" | "DEPARTMENT" | "CONTRACT" | "FINANCE" | "HR" | "OTHER";
export type EnterpriseSealStatus = "DRAFT" | "ACTIVE" | "DISABLED" | "REVOKED";
export type SealAuthoritySubjectType = "USER" | "ROLE" | "DEPARTMENT" | "SYSTEM";
export type SealAuthorityType = "REQUEST_USE" | "APPROVE_USE" | "AUTO_USE" | "MANAGE";
export type SignaturePolicyStatus = "DRAFT" | "ACTIVE" | "DISABLED";
export type SignaturePolicyExecutionMode = "PARALLEL" | "SEQUENTIAL";
export type SignaturePolicyTrigger = "MANUAL" | "ORDER_PENDING_SIGN" | "PORTAL_REQUEST" | "SYSTEM_APPROVED";
export type EnterpriseSealProvider = "FADADA" | "MOCK" | "ESIGN" | "TENCENT_ESIGN" | "OTHER";

export type SignaturePolicyDecisionCode =
  | "ALLOW"
  | "DENY"
  | "REQUIRE_APPROVAL"
  | "REQUIRE_ONBOARDING"
  | "REQUIRE_REALNAME"
  | "REQUIRE_SEAL_AUTHORITY"
  | "REQUIRE_POLICY_SELECTION";

export interface EnterpriseSealView {
  id: string;
  provider: EnterpriseSealProvider;
  providerSealId?: string | null;
  sealName: string;
  sealType: EnterpriseSealType;
  status: EnterpriseSealStatus;
}

export interface SealAuthorityView {
  authorityType: SealAuthorityType;
  id: string;
  requiresTwoPersonApproval: boolean;
  sealId: string;
  status: "ACTIVE" | "DISABLED" | "INACTIVE";
  subjectId: string;
  subjectType: SealAuthoritySubjectType;
}

export interface SignaturePolicyView {
  contractTemplateType?: string | null;
  defaultSealId?: string | null;
  executionMode: SignaturePolicyExecutionMode;
  id: string;
  policyCode: string;
  policyName: string;
  requiresEnterpriseSeal: boolean;
  status: SignaturePolicyStatus;
  trigger?: SignaturePolicyTrigger;
}

export interface SignaturePolicyEngineInput {
  actor: {
    id: string;
    permissionCodes: string[];
    roleCodes: string[];
  };
  authorities: SealAuthorityView[];
  contract: {
    businessType: string;
    contractTemplateType: string;
    contractVersionId?: string | null;
    id: string;
    status: string;
  };
  customer: {
    id: string;
    status: string;
  };
  customerReadiness: {
    realNameStatus?: string | null;
    signingEligible: boolean;
    state: string;
  };
  order?: {
    customerId: string;
    id: string;
    orderStatus: string;
  };
  policy?: SignaturePolicyView;
  seal?: EnterpriseSealView;
  source: "ADMIN" | "ORDER" | "PORTAL" | "SYSTEM";
}

export interface SignaturePolicyEngineDecision {
  auditSummary?: Record<string, unknown>;
  code: SignaturePolicyDecisionCode;
  compileAllowed: boolean;
  policyId?: string;
  reasonCode: string;
  requiresApproval: boolean;
  sealId?: string;
}

export type SigningPlanStepType = "CUSTOMER_SIGN" | "ENTERPRISE_SEAL" | "INTERNAL_APPROVAL" | "EXTERNAL_PARTY_SIGN";
export type SigningPlanSignerRole = "CUSTOMER" | "ENTERPRISE_SEAL" | "INTERNAL_APPROVAL" | "EXTERNAL_PARTY";
export type SigningPlanSignerType = "CUSTOMER" | "PLATFORM";

export interface SigningPlanStep {
  readonly customerId?: string;
  readonly required: boolean;
  readonly sealId?: string;
  readonly signerRole: SigningPlanSignerRole;
  readonly signerType: SigningPlanSignerType;
  readonly stepOrder: number;
  readonly stepType: SigningPlanStepType;
}

export interface SigningPlanConstraints {
  readonly contractStatusRequired: "PENDING_SIGN";
  readonly customerStatusRequired: "ACTIVE";
  readonly realNameStatusRequired: "VERIFIED";
  readonly sealRequired: boolean;
}

export interface SigningPlan {
  readonly constraints: SigningPlanConstraints;
  readonly contractId: string;
  readonly executionMode: SignaturePolicyExecutionMode;
  readonly hash: string;
  readonly orderId?: string;
  readonly planId: string;
  readonly policyId: string;
  readonly sealId?: string;
  readonly steps: readonly SigningPlanStep[];
  readonly version: 1;
}

export interface ApprovedSigningPlanRef {
  executionMode: SignaturePolicyExecutionMode;
  planHash: string;
  policyId: string;
  signingPlanId: string;
  steps: Array<{
    customerId?: string;
    required: boolean;
    sealId?: string;
    signerRole: SigningPlanSignerRole;
    signerType?: SigningPlanSignerType;
    stepOrder: number;
  }>;
}
