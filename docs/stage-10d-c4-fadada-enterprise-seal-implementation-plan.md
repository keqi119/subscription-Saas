# Stage 10D-C4-B Enterprise Seal Policy Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the C4-A enterprise seal model into an executable implementation plan for schema, services, policy evaluation, immutable signing plans, B5 integration contracts, audit, and validation.

**Architecture:** C4 is a policy layer above B5. It owns enterprise seal governance, authority checks, signature policy resolution, and immutable signing plan compilation; B5 remains the provider execution engine and is called only after C4 returns `READY_FOR_B5`.

**Tech Stack:** NestJS, Prisma, PostgreSQL, Vitest, existing `AuditService`, existing `CustomerESignOnboardingService`, existing B5 `ESignService` and `ContractESignTask` model.

---

## Non-Execution Boundary For C4-B

This C4-B document is planning-only.

It does not:

```text
modify apps/api/src
modify apps/api/prisma/schema.prisma
create a migration
call Fadada
generate signUrl
trigger signing
mutate Contract / Order
touch payment logic
deploy production
```

## Implementation Units

Planned files for C4 implementation:

```text
apps/api/prisma/schema.prisma
  Add provider-neutral C4 enterprise seal, authority, policy, and signing plan models.

apps/api/src/esign/enterprise-seal/enterprise-seal.service.ts
  Manage active seals and masked seal views.

apps/api/src/esign/enterprise-seal/seal-authority.service.ts
  Validate who can request, approve, auto-use, or manage a seal.

apps/api/src/esign/enterprise-seal/signature-policy.service.ts
  Resolve active signature policies for contracts/orders.

apps/api/src/esign/enterprise-seal/signature-policy-engine.ts
  Pure policy evaluator returning ALLOW / DENY / REQUIRE_* decisions.

apps/api/src/esign/enterprise-seal/signing-plan-compiler.ts
  Compile immutable signing plans from policy, authority, and C3 readiness.

apps/api/src/esign/enterprise-seal/signing-plan.service.ts
  Persist/retrieve/freeze plans and enforce plan immutability.

apps/api/src/esign/enterprise-seal/enterprise-seal.controller.ts
  Admin APIs for seals, authorities, policies, and contract policy evaluation.

apps/api/src/esign/enterprise-seal/enterprise-seal.dto.ts
  Request/response DTOs with masked provider fields.

apps/api/src/esign/enterprise-seal/enterprise-seal.types.ts
  Provider-neutral domain types shared by services and tests.

apps/api/src/esign/esign.service.ts
  Accept an optional C4 signing plan reference before B5 provider execution.

apps/api/test/enterprise-seal-policy.spec.ts
  Unit tests for policy engine and authority validation.

apps/api/test/enterprise-seal-signing-plan.spec.ts
  Unit tests for signing plan compilation and immutability.

apps/api/test/enterprise-seal-b5-contract.spec.ts
  Unit tests proving C4 gives constraints and B5 still executes signing.

docs/stage-10d-c4-fadada-enterprise-seal-implementation-result.md
  Record implementation result after the execution phase.
```

## Schema Evolution Plan

Schema changes should be additive and backward compatible.

No existing C1/C2/C3/B5 table should be removed or rewritten.

Recommended migration name:

```text
20260701_enterprise_seal_policy
```

Planned enums:

```prisma
enum EnterpriseSealType {
  COMPANY
  DEPARTMENT
  CONTRACT
  FINANCE
  HR
  OTHER

  @@map("enterprise_seal_type")
}

enum EnterpriseSealStatus {
  DRAFT
  ACTIVE
  DISABLED
  REVOKED

  @@map("enterprise_seal_status")
}

enum SealAuthoritySubjectType {
  USER
  ROLE
  DEPARTMENT
  SYSTEM

  @@map("seal_authority_subject_type")
}

enum SealAuthorityType {
  REQUEST_USE
  APPROVE_USE
  AUTO_USE
  MANAGE

  @@map("seal_authority_type")
}

enum SignaturePolicyStatus {
  DRAFT
  ACTIVE
  DISABLED

  @@map("signature_policy_status")
}

enum SignaturePolicyTrigger {
  MANUAL
  ORDER_PENDING_SIGN
  PORTAL_REQUEST
  SYSTEM_APPROVED

  @@map("signature_policy_trigger")
}

enum SignaturePolicyExecutionMode {
  PARALLEL
  SEQUENTIAL

  @@map("signature_policy_execution_mode")
}

enum SigningPlanStatus {
  DRAFT
  AUTHORITY_PENDING
  AUTHORITY_APPROVED
  READY_FOR_B5
  CONSUMED
  REJECTED
  EXPIRED
  CANCELLED

  @@map("signing_plan_status")
}
```

Planned models:

```prisma
model EnterpriseSeal {
  id                 String                 @id @default(uuid()) @db.Uuid
  provider           ESignProviderType
  providerSealId     String?                @map("provider_seal_id") @db.VarChar(128)
  sealType           EnterpriseSealType      @map("seal_type")
  sealName           String                 @map("seal_name") @db.VarChar(128)
  status             EnterpriseSealStatus   @default(DRAFT)
  departmentId       String?                @map("department_id") @db.Uuid
  effectiveFrom      DateTime?              @map("effective_from") @db.Timestamptz(6)
  effectiveTo        DateTime?              @map("effective_to") @db.Timestamptz(6)
  providerSnapshot   Json?                  @map("provider_snapshot")
  createdAt          DateTime               @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt          DateTime               @updatedAt @map("updated_at") @db.Timestamptz(6)
  createdBy          String?                @map("created_by") @db.Uuid
  updatedBy          String?                @map("updated_by") @db.Uuid
  deletedAt          DateTime?              @map("deleted_at") @db.Timestamptz(6)
  authorities        SealAuthority[]
  policies           SignaturePolicy[]
  signingPlans       SigningPlan[]

  @@unique([provider, providerSealId])
  @@index([provider])
  @@index([sealType])
  @@index([status])
  @@index([departmentId])
  @@map("enterprise_seal")
}

model SealAuthority {
  id                        String                   @id @default(uuid()) @db.Uuid
  sealId                    String                   @map("seal_id") @db.Uuid
  seal                      EnterpriseSeal           @relation(fields: [sealId], references: [id])
  subjectType               SealAuthoritySubjectType @map("subject_type")
  subjectId                 String                   @map("subject_id") @db.Uuid
  authorityType             SealAuthorityType        @map("authority_type")
  scopeType                 String                   @map("scope_type") @db.VarChar(64)
  scopeValue                String?                  @map("scope_value") @db.VarChar(128)
  requiresTwoPersonApproval Boolean                  @default(false) @map("requires_two_person_approval")
  status                    RecordStatus             @default(ACTIVE)
  createdAt                 DateTime                 @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt                 DateTime                 @updatedAt @map("updated_at") @db.Timestamptz(6)
  createdBy                 String?                  @map("created_by") @db.Uuid
  updatedBy                 String?                  @map("updated_by") @db.Uuid
  deletedAt                 DateTime?                @map("deleted_at") @db.Timestamptz(6)

  @@index([sealId])
  @@index([subjectType, subjectId])
  @@index([authorityType])
  @@index([status])
  @@map("seal_authority")
}

model SignaturePolicy {
  id                 String                       @id @default(uuid()) @db.Uuid
  policyCode         String                       @unique @map("policy_code") @db.VarChar(64)
  policyName         String                       @map("policy_name") @db.VarChar(128)
  businessType       BusinessType                 @default(SUBSCRIPTION) @map("business_type")
  contractTemplateType ContractTemplateType       @map("contract_template_type")
  contractVersionId  String?                      @map("contract_version_id") @db.Uuid
  defaultSealId      String?                      @map("default_seal_id") @db.Uuid
  defaultSeal        EnterpriseSeal?              @relation(fields: [defaultSealId], references: [id])
  status             SignaturePolicyStatus        @default(DRAFT)
  trigger            SignaturePolicyTrigger       @default(MANUAL)
  executionMode      SignaturePolicyExecutionMode @default(SEQUENTIAL) @map("execution_mode")
  rules              Json
  effectiveFrom      DateTime?                    @map("effective_from") @db.Timestamptz(6)
  effectiveTo        DateTime?                    @map("effective_to") @db.Timestamptz(6)
  createdAt          DateTime                     @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt          DateTime                     @updatedAt @map("updated_at") @db.Timestamptz(6)
  createdBy          String?                      @map("created_by") @db.Uuid
  updatedBy          String?                      @map("updated_by") @db.Uuid
  deletedAt          DateTime?                    @map("deleted_at") @db.Timestamptz(6)
  signingPlans       SigningPlan[]

  @@index([businessType])
  @@index([contractTemplateType])
  @@index([contractVersionId])
  @@index([defaultSealId])
  @@index([status])
  @@index([trigger])
  @@map("signature_policy")
}

model SigningPlan {
  id                 String                       @id @default(uuid()) @db.Uuid
  contractId         String                       @map("contract_id") @db.Uuid
  contract           Contract                     @relation(fields: [contractId], references: [id])
  orderId            String?                      @map("order_id") @db.Uuid
  customerId         String?                      @map("customer_id") @db.Uuid
  policyId           String                       @map("policy_id") @db.Uuid
  policy             SignaturePolicy              @relation(fields: [policyId], references: [id])
  sealId             String?                      @map("seal_id") @db.Uuid
  seal               EnterpriseSeal?              @relation(fields: [sealId], references: [id])
  status             SigningPlanStatus            @default(DRAFT)
  executionMode      SignaturePolicyExecutionMode @map("execution_mode")
  planHash           String                       @map("plan_hash") @db.VarChar(128)
  steps              Json
  decisionSnapshot   Json                         @map("decision_snapshot")
  approvedAt         DateTime?                    @map("approved_at") @db.Timestamptz(6)
  approvedBy         String?                      @map("approved_by") @db.Uuid
  consumedAt         DateTime?                    @map("consumed_at") @db.Timestamptz(6)
  expiresAt          DateTime?                    @map("expires_at") @db.Timestamptz(6)
  createdAt          DateTime                     @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt          DateTime                     @updatedAt @map("updated_at") @db.Timestamptz(6)
  createdBy          String?                      @map("created_by") @db.Uuid
  updatedBy          String?                      @map("updated_by") @db.Uuid
  deletedAt          DateTime?                    @map("deleted_at") @db.Timestamptz(6)

  @@unique([contractId, planHash])
  @@index([contractId])
  @@index([orderId])
  @@index([customerId])
  @@index([policyId])
  @@index([sealId])
  @@index([status])
  @@map("signing_plan")
}
```

Planned relation update:

```prisma
model Contract {
  signingPlans SigningPlan[]
}
```

Backwards compatibility:

```text
existing ContractESignTask rows remain valid
existing Fadada B5 callback/archive logic remains unchanged
no existing contract/order/payment fields are required to be backfilled
new C4 tables can start empty
```

## Policy Engine Contract

Recommended pure engine types:

```ts
export type SignaturePolicyDecisionCode =
  | "ALLOW"
  | "DENY"
  | "REQUIRE_APPROVAL"
  | "REQUIRE_ONBOARDING"
  | "REQUIRE_REALNAME"
  | "REQUIRE_SEAL_AUTHORITY"
  | "REQUIRE_POLICY_SELECTION";

export interface SignaturePolicyEngineInput {
  actor: {
    id: string;
    permissionCodes: string[];
    roleCodes: string[];
  };
  contract: {
    id: string;
    businessType: string;
    contractTemplateType: string;
    contractVersionId: string;
    status: string;
  };
  order?: {
    id: string;
    orderStatus: string;
    customerId: string;
  };
  customerReadiness: {
    signingEligible: boolean;
    state: string;
  };
  policy?: SignaturePolicyView;
  seal?: EnterpriseSealView;
  authorities: SealAuthorityView[];
  source: "ADMIN" | "ORDER" | "PORTAL" | "SYSTEM";
}

export interface SignaturePolicyEngineDecision {
  code: SignaturePolicyDecisionCode;
  reasonCode: string;
  policyId?: string;
  sealId?: string;
  requiresApproval: boolean;
  compileAllowed: boolean;
  auditSummary: Record<string, unknown>;
}
```

Required engine behavior:

```text
if customerReadiness.signingEligible=false -> REQUIRE_ONBOARDING
if no active policy matches -> REQUIRE_POLICY_SELECTION
if policy requires seal and no active seal -> DENY
if actor lacks REQUEST_USE or AUTO_USE authority -> REQUIRE_SEAL_AUTHORITY
if authority requires approval -> REQUIRE_APPROVAL
otherwise -> ALLOW and compileAllowed=true
```

The engine must be pure:

```text
no Prisma calls
no Fadada calls
no B5 calls
no audit writes
no Date.now inside decision logic unless now is passed in input
```

## B5 Integration Contract

C4 should provide constraints to B5 without changing provider execution semantics.

Recommended C4 -> B5 input:

```ts
export interface ApprovedSigningPlanRef {
  signingPlanId: string;
  policyId: string;
  planHash: string;
  executionMode: "PARALLEL" | "SEQUENTIAL";
  steps: Array<{
    stepOrder: number;
    signerRole: "CUSTOMER" | "ENTERPRISE_SEAL" | "INTERNAL_APPROVAL" | "EXTERNAL_PARTY";
    signerType?: "CUSTOMER" | "PLATFORM";
    customerId?: string;
    sealId?: string;
    required: boolean;
  }>;
}
```

Recommended B5 boundary:

```text
ESignService.createSignTask(contractId, actor, context, approvedPlanRef?)
```

B5 rules:

```text
if approvedPlanRef is present:
  copy plan metadata into ContractESignTask.requestSnapshot
  create provider signers only for provider-facing steps
  do not evaluate seal authority
  do not change plan steps

if approvedPlanRef is absent:
  keep current customer signing path until a later C4 enforcement gate makes C4 mandatory
```

C4 enforcement rollout:

```text
phase 1: optional plan reference, no breaking change
phase 2: require plan for enterprise-seal policies
phase 3: require plan for all Fadada production signing
```

## Immutable SigningPlan Rules

Plan immutability:

```text
planHash = sha256(canonicalJson({policyId, sealId, executionMode, steps, decisionSnapshotVersion}))
READY_FOR_B5 plans cannot update steps, policyId, sealId, executionMode, or decisionSnapshot
CONSUMED plans cannot be reused for a different ContractESignTask
new policy decision creates a new SigningPlan
```

Plan steps JSON shape:

```json
[
  {
    "stepOrder": 1,
    "parallelGroup": null,
    "stepType": "CUSTOMER_SIGN",
    "signerType": "CUSTOMER",
    "signerRole": "CUSTOMER",
    "customerIdMasked": "custo...1234",
    "required": true
  },
  {
    "stepOrder": 2,
    "parallelGroup": null,
    "stepType": "ENTERPRISE_SEAL",
    "signerType": "PLATFORM",
    "signerRole": "ENTERPRISE_SEAL",
    "sealIdMasked": "seal-...abcd",
    "required": true
  }
]
```

Audit should store the plan hash and masked summary, not provider raw responses or seal binaries.

## Implementation Tasks

### Task 1: Add Schema And Migration Draft

**Files:**

```text
Modify: apps/api/prisma/schema.prisma
Create: apps/api/prisma/migrations/20260701_enterprise_seal_policy/migration.sql
Test: apps/api/test/enterprise-seal-schema.spec.ts
```

- [ ] **Step 1: Add Prisma enums and models**

Add the enums and models from the "Schema Evolution Plan" section exactly, with relation names adjusted only if Prisma requires them.

- [ ] **Step 2: Generate migration**

Run:

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate dev --name enterprise_seal_policy --create-only --schema prisma/schema.prisma
```

Expected:

```text
migration directory created
no database reset requested
no seed executed
```

- [ ] **Step 3: Validate schema**

Run:

```powershell
pnpm prisma:validate
pnpm prisma:generate
```

Expected:

```text
schema valid
Prisma Client generated
```

- [ ] **Step 4: Commit**

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260701_enterprise_seal_policy
git commit -m "feat: add enterprise seal policy schema"
```

### Task 2: Add Domain Types And Masking Helpers

**Files:**

```text
Create: apps/api/src/esign/enterprise-seal/enterprise-seal.types.ts
Create: apps/api/src/esign/enterprise-seal/enterprise-seal-mask.ts
Test: apps/api/test/enterprise-seal-policy.spec.ts
```

- [ ] **Step 1: Write tests for masking and decision types**

Test names:

```text
masks providerSealId in views and audit summaries
represents policy decisions without provider raw response
```

Assertions:

```ts
expect(maskSealId("fadada-seal-1234567890abcdef")).toBe("fadad...cdef");
expect(JSON.stringify(maskedView)).not.toContain("fadada-seal-1234567890abcdef");
```

- [ ] **Step 2: Implement domain types**

Define:

```ts
export type EnterpriseSealStatus = "DRAFT" | "ACTIVE" | "DISABLED" | "REVOKED";
export type EnterpriseSealType = "COMPANY" | "DEPARTMENT" | "CONTRACT" | "FINANCE" | "HR" | "OTHER";
export type SignaturePolicyDecisionCode =
  | "ALLOW"
  | "DENY"
  | "REQUIRE_APPROVAL"
  | "REQUIRE_ONBOARDING"
  | "REQUIRE_REALNAME"
  | "REQUIRE_SEAL_AUTHORITY"
  | "REQUIRE_POLICY_SELECTION";
```

- [ ] **Step 3: Run targeted tests**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/enterprise-seal-policy.spec.ts
```

Expected:

```text
enterprise seal policy tests pass
```

- [ ] **Step 4: Commit**

```powershell
git add apps/api/src/esign/enterprise-seal apps/api/test/enterprise-seal-policy.spec.ts
git commit -m "feat: add enterprise seal domain types"
```

### Task 3: Implement Pure SignaturePolicyEngine

**Files:**

```text
Create: apps/api/src/esign/enterprise-seal/signature-policy-engine.ts
Modify: apps/api/test/enterprise-seal-policy.spec.ts
```

- [ ] **Step 1: Add failing tests**

Test names:

```text
returns REQUIRE_ONBOARDING when customer signing readiness is false
returns REQUIRE_POLICY_SELECTION when no active policy matches
returns REQUIRE_SEAL_AUTHORITY when actor lacks seal authority
returns REQUIRE_APPROVAL when matched authority requires two person approval
returns ALLOW when policy, seal, readiness, and authority pass
```

- [ ] **Step 2: Implement pure evaluator**

Public API:

```ts
export class SignaturePolicyEngine {
  evaluate(input: SignaturePolicyEngineInput): SignaturePolicyEngineDecision {
    if (!input.customerReadiness.signingEligible) {
      return decision("REQUIRE_ONBOARDING", "CUSTOMER_NOT_SIGNING_READY");
    }
    if (!input.policy || input.policy.status !== "ACTIVE") {
      return decision("REQUIRE_POLICY_SELECTION", "ACTIVE_POLICY_MISSING");
    }
    if (input.policy.requiresEnterpriseSeal && (!input.seal || input.seal.status !== "ACTIVE")) {
      return decision("DENY", "ACTIVE_SEAL_MISSING");
    }
    const authority = input.authorities.find((item) => item.authorityType === "REQUEST_USE" || item.authorityType === "AUTO_USE");
    if (!authority) {
      return decision("REQUIRE_SEAL_AUTHORITY", "SEAL_AUTHORITY_MISSING");
    }
    if (authority.requiresTwoPersonApproval) {
      return decision("REQUIRE_APPROVAL", "SEAL_APPROVAL_REQUIRED", { requiresApproval: true });
    }
    return decision("ALLOW", "POLICY_AUTHORITY_READY", { compileAllowed: true });
  }
}
```

- [ ] **Step 3: Prove engine is side-effect free**

The test must assert that no mocked Prisma, Fadada, or B5 function is passed to or called by the engine.

- [ ] **Step 4: Commit**

```powershell
git add apps/api/src/esign/enterprise-seal/signature-policy-engine.ts apps/api/test/enterprise-seal-policy.spec.ts
git commit -m "feat: add enterprise seal policy engine"
```

### Task 4: Implement Seal And Authority Services

**Files:**

```text
Create: apps/api/src/esign/enterprise-seal/enterprise-seal.service.ts
Create: apps/api/src/esign/enterprise-seal/seal-authority.service.ts
Test: apps/api/test/enterprise-seal-service.spec.ts
```

- [ ] **Step 1: Test active seal lookup**

Expected service behavior:

```text
returns ACTIVE, effective, non-deleted seals
does not return DISABLED or REVOKED seals
returns masked providerSealId
```

- [ ] **Step 2: Test authority validation**

Expected service behavior:

```text
user authority passes by subjectType=USER and subjectId=user.id
role authority passes when user role contains subjectId
MANAGE authority does not imply REQUEST_USE
INACTIVE authority does not pass
```

- [ ] **Step 3: Implement services with Prisma reads only**

No service method should call Fadada or B5.

- [ ] **Step 4: Add audit writes for create/update/disable in management methods**

Audit events:

```text
esign.enterprise_seal.create
esign.enterprise_seal.update
esign.enterprise_seal.disable
esign.seal_authority.grant
esign.seal_authority.revoke
```

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/esign/enterprise-seal apps/api/test/enterprise-seal-service.spec.ts
git commit -m "feat: add enterprise seal authority services"
```

### Task 5: Implement SignaturePolicyService

**Files:**

```text
Create: apps/api/src/esign/enterprise-seal/signature-policy.service.ts
Test: apps/api/test/enterprise-seal-policy.spec.ts
```

- [ ] **Step 1: Test policy resolution**

Test cases:

```text
active policy resolves by businessType + contractTemplateType
contractVersion-specific policy wins over generic policy
disabled policy is ignored
policy outside effective window is ignored
```

- [ ] **Step 2: Implement resolver**

Resolution order:

```text
1. ACTIVE policy with matching contractVersionId
2. ACTIVE policy with matching businessType + contractTemplateType
3. no policy -> null
```

- [ ] **Step 3: Audit policy mutations**

Events:

```text
esign.signature_policy.create
esign.signature_policy.activate
esign.signature_policy.disable
```

- [ ] **Step 4: Commit**

```powershell
git add apps/api/src/esign/enterprise-seal/signature-policy.service.ts apps/api/test/enterprise-seal-policy.spec.ts
git commit -m "feat: add signature policy resolution"
```

### Task 6: Implement SigningPlanCompiler And Plan Hashing

**Files:**

```text
Create: apps/api/src/esign/enterprise-seal/signing-plan-compiler.ts
Create: apps/api/src/esign/enterprise-seal/signing-plan-hash.ts
Test: apps/api/test/enterprise-seal-signing-plan.spec.ts
```

- [ ] **Step 1: Test deterministic plan hash**

Assertions:

```text
same semantic plan -> same hash
different sealId -> different hash
different step order -> different hash
masked values are not part of provider execution refs
```

- [ ] **Step 2: Test customer then enterprise seal plan**

Expected compiled steps:

```json
[
  {"stepOrder":1,"stepType":"CUSTOMER_SIGN","signerType":"CUSTOMER","required":true},
  {"stepOrder":2,"stepType":"ENTERPRISE_SEAL","signerType":"PLATFORM","required":true}
]
```

- [ ] **Step 3: Implement compiler**

Compiler input:

```ts
export interface SigningPlanCompilerInput {
  contractId: string;
  orderId?: string;
  customerId?: string;
  policy: SignaturePolicyView;
  seal?: EnterpriseSealView;
  decision: SignaturePolicyEngineDecision;
}
```

Compiler output:

```ts
export interface CompiledSigningPlan {
  contractId: string;
  policyId: string;
  sealId?: string;
  executionMode: "PARALLEL" | "SEQUENTIAL";
  planHash: string;
  steps: SigningPlanStep[];
  decisionSnapshot: Record<string, unknown>;
}
```

- [ ] **Step 4: Commit**

```powershell
git add apps/api/src/esign/enterprise-seal/signing-plan-compiler.ts apps/api/src/esign/enterprise-seal/signing-plan-hash.ts apps/api/test/enterprise-seal-signing-plan.spec.ts
git commit -m "feat: compile immutable enterprise signing plans"
```

### Task 7: Implement SigningPlanService

**Files:**

```text
Create: apps/api/src/esign/enterprise-seal/signing-plan.service.ts
Test: apps/api/test/enterprise-seal-signing-plan.spec.ts
```

- [ ] **Step 1: Test persistence and immutability**

Test cases:

```text
creates DRAFT plan from compiled plan
marks plan READY_FOR_B5 after approval
rejects step updates after READY_FOR_B5
marks plan CONSUMED once B5 uses it
does not allow same plan for another contract
```

- [ ] **Step 2: Implement service methods**

Methods:

```ts
createDraftPlan(input, actorId)
approvePlan(planId, actorId)
getReadyPlan(planId)
markConsumed(planId, taskId, actorId)
rejectPlan(planId, reason, actorId)
```

- [ ] **Step 3: Audit state transitions**

Events:

```text
esign.signing_plan.compile
esign.signing_plan.approve
esign.signing_plan.reject
esign.signing_plan.consume
```

- [ ] **Step 4: Commit**

```powershell
git add apps/api/src/esign/enterprise-seal/signing-plan.service.ts apps/api/test/enterprise-seal-signing-plan.spec.ts
git commit -m "feat: persist immutable enterprise signing plans"
```

### Task 8: Add Admin API And DTOs

**Files:**

```text
Create: apps/api/src/esign/enterprise-seal/enterprise-seal.controller.ts
Create: apps/api/src/esign/enterprise-seal/enterprise-seal.dto.ts
Modify: apps/api/src/esign/esign.module.ts
Test: apps/api/test/enterprise-seal-controller.spec.ts
```

- [ ] **Step 1: Test route mappings**

Routes:

```text
GET  /api/esign/enterprise-seals
POST /api/esign/enterprise-seals
GET  /api/esign/signature-policies
POST /api/contracts/:id/signing-policy/evaluate
POST /api/contracts/:id/signing-policy/compile-plan
GET  /api/contracts/:id/signing-policy/status
```

- [ ] **Step 2: Implement DTO validation**

Use `class-validator` for:

```text
sealName max 128
provider enum
sealType enum
policyCode max 64
policyName max 128
rules object
```

- [ ] **Step 3: Require permissions**

Use existing permission pattern:

```text
read: contract:view or customer:view for status
write: contract:sign plus future esign policy permissions
management: customer:manage or a new esign permission seed task
```

If new permissions are required, add them in a separate permission-seed task to keep this controller task focused.

- [ ] **Step 4: Commit**

```powershell
git add apps/api/src/esign/enterprise-seal apps/api/src/esign/esign.module.ts apps/api/test/enterprise-seal-controller.spec.ts
git commit -m "feat: add enterprise seal policy admin api"
```

### Task 9: Add Optional C4 Reference To B5

**Files:**

```text
Modify: apps/api/src/esign/esign.service.ts
Modify: apps/api/src/esign/esign.provider.ts
Test: apps/api/test/enterprise-seal-b5-contract.spec.ts
```

- [ ] **Step 1: Test optional plan ref does not change legacy B5**

Expected:

```text
createSignTask without plan ref behaves as today
createSignTask with plan ref stores policy metadata in requestSnapshot
provider-facing signer list is generated from plan steps
B5 does not evaluate seal authority
```

- [ ] **Step 2: Add `ApprovedSigningPlanRef` type**

Place it in:

```text
apps/api/src/esign/enterprise-seal/enterprise-seal.types.ts
```

- [ ] **Step 3: Thread optional ref through B5 request snapshot**

Expected request snapshot addition:

```json
{
  "enterpriseSigningPlan": {
    "signingPlanId": "masked-or-id",
    "policyId": "masked-or-id",
    "planHash": "sha256...",
    "executionMode": "SEQUENTIAL",
    "stepSummary": [
      {"stepOrder":1,"signerRole":"CUSTOMER","required":true},
      {"stepOrder":2,"signerRole":"ENTERPRISE_SEAL","required":true}
    ]
  }
}
```

- [ ] **Step 4: Commit**

```powershell
git add apps/api/src/esign apps/api/test/enterprise-seal-b5-contract.spec.ts
git commit -m "feat: pass enterprise signing plan metadata to b5"
```

### Task 10: Full Verification

**Files:**

```text
Modify: docs/stage-10d-c4-fadada-enterprise-seal-implementation-result.md
```

- [ ] **Step 1: Run targeted tests**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/enterprise-seal-policy.spec.ts test/enterprise-seal-signing-plan.spec.ts test/enterprise-seal-b5-contract.spec.ts
```

Expected:

```text
all enterprise seal targeted tests pass
```

- [ ] **Step 2: Run core gates**

```powershell
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/api test
```

Expected:

```text
lint passed
schema valid
client generated
API typecheck passed
API tests passed
```

- [ ] **Step 3: Run release check**

```powershell
pnpm release:check
```

Expected:

```text
release check passes, or any local-only Prisma migrate status engine issue is recorded with exact output
```

- [ ] **Step 4: Confirm prohibited actions did not occur**

Checklist:

```text
Fadada API calls: no
signUrl generated: no
signing execution: no
Contract / Order mutation outside tests: no
PaymentRecord / PaymentWriteOff creation: no
production deploy: no
production migration: no
seed to production: no
```

- [ ] **Step 5: Commit result docs**

```powershell
git add docs/stage-10d-c4-fadada-enterprise-seal-implementation-result.md
git commit -m "docs: record enterprise seal policy implementation validation"
```

## Rollout Plan

Recommended rollout gates:

```text
1. C4-C local schema/service implementation
2. C4-D local policy engine + signing plan compile validation
3. C4-E optional B5 metadata integration behind feature flag
4. C4-F controlled provider-free end-to-end test
5. C4-G provider-specific Fadada enterprise seal preflight
6. production migration approval
7. production runtime flag approval
```

Suggested flags:

```env
ESIGN_ENTERPRISE_SEAL_POLICY_ENABLED=false
ESIGN_REQUIRE_SIGNING_PLAN_FOR_FADADA=false
FADADA_ENTERPRISE_SEAL_ENABLED=false
```

Default posture:

```text
C4 tables can exist empty
C4 engine can run in dry-run/evaluate-only mode
B5 legacy path remains intact until ESIGN_REQUIRE_SIGNING_PLAN_FOR_FADADA=true
Fadada enterprise seal API remains disabled until separately approved
```

## Risk Controls

Unauthorized seal usage:

```text
SealAuthority REQUEST_USE / APPROVE_USE required
MANAGE does not imply REQUEST_USE
policy decisions audited
```

Policy invading execution:

```text
C4 compiles constraints
B5 executes provider calls
B5 never evaluates authority
```

Signature order bypass:

```text
steps are frozen in SigningPlan
planHash stored before B5
callback handling checks expected signer set in later B5 hardening task
```

Provider coupling:

```text
EnterpriseSeal is provider-neutral
providerSealId is optional and masked
provider-specific data stays sanitized in providerSnapshot
```

Audit leakage:

```text
no seal binary in audit
no provider raw response in audit
no full signUrl in audit
no app secret in audit
no full provider ids in audit
```

## C4-B Conclusion

This plan is ready for C4-C implementation.

The recommended first implementation slice is:

```text
Task 1 schema draft
Task 2 domain types
Task 3 pure SignaturePolicyEngine
```

That slice creates a testable policy core without touching B5 execution or any real provider API.
