# Stage 10D-C4-A Enterprise Seal And Multi-Signature Model Design

Stage 10D-C4-A designs the enterprise seal and multi-signature strategy layer for the Fadada e-sign system.

This stage is architecture-only. It does not implement code, modify schema, add migrations, call Fadada, generate sign URLs, trigger signing, mutate Contract / Order, touch payment logic, or deploy production.

## Background

Completed foundation:

```text
B5: signing engine validated
C1: CustomerESignProviderAccount binding complete
C2: real-name lifecycle complete
C3: onboarding orchestration and runtime validation complete
```

The current production-grade signing pipeline answers:

```text
Is the customer ready to sign?
```

C4 adds the enterprise governance question:

```text
Is this contract allowed to be signed with the required enterprise seal and signer policy?
```

## Design Goal

C4 should become a policy layer above B5:

```text
C3 onboarding       -> customer signing readiness
C2 identity         -> real-name status
C1 provider binding -> provider customer_id
C4 seal policy      -> authority, seal, signing order, approval rules
B5 signing engine   -> provider execution
```

C4 must not fork or rewrite the B5 signing engine. It should prepare a normalized signing plan that B5 can execute.

## Design Options

### Option A: Policy Layer Above B5

Model enterprise seals, authorities, and signature policies separately, then compile them into B5 signer/task inputs.

Pros:

```text
clear separation from provider execution
easy to test without Fadada calls
supports future providers
keeps C1/C2/C3 intact
```

Cons:

```text
requires a policy evaluation service before signing
requires a later schema migration
```

Recommendation: **use Option A**.

### Option B: Extend ContractESignTask Directly

Add enterprise seal and multi-sign fields directly to `ContractESignTask` / `ContractESignSigner`.

Pros:

```text
smaller initial model
close to existing B5 tables
```

Cons:

```text
mixes policy with provider execution
harder to reuse across providers
harder to audit pre-sign authority decisions
```

Recommendation: not preferred.

### Option C: Provider-Specific Fadada Enterprise Layer

Model only Fadada enterprise concepts and map them directly to Fadada APIs.

Pros:

```text
fastest if only Fadada is needed
```

Cons:

```text
locks business rules to one provider
harder to support Mock provider and future providers
harder to test without external API semantics
```

Recommendation: avoid as the primary architecture.

## Recommended Architecture

Recommended C4 architecture:

```text
Contract / Order
-> C4 SignaturePolicy resolution
-> C4 SealAuthority validation
-> C4 EnterpriseSeal selection
-> C4 SigningPlan compilation
-> B5 createSignTask execution
```

Core services:

```text
EnterpriseSealService
SealAuthorityService
SignaturePolicyService
SigningPlanCompiler
SigningPolicyAuditService
```

Important boundary:

```text
C4 evaluates whether signing is allowed.
B5 executes signing after C4 produces an approved signing plan.
```

## Conceptual Model

### EnterpriseSeal

Represents a company or department seal that can be used in electronic signing.

Suggested fields for a later schema stage:

```text
id
tenantId / companyId
departmentId optional
provider
providerSealId optional
sealType: COMPANY | DEPARTMENT | CONTRACT | FINANCE | HR | OTHER
sealName
status: DRAFT | ACTIVE | DISABLED | REVOKED
effectiveFrom
effectiveTo
providerSnapshot sanitized
createdBy / updatedBy
createdAt / updatedAt / deletedAt
```

Rules:

```text
only ACTIVE seals can be used
disabled/revoked seals cannot be selected
department seals can be scoped to department-owned policies
providerSealId is masked in responses and audit
```

### SealAuthority

Represents who may use or approve use of a seal.

Suggested authority dimensions:

```text
sealId
subjectType: USER | ROLE | DEPARTMENT | SYSTEM
subjectId
authorityType: REQUEST_USE | APPROVE_USE | AUTO_USE | MANAGE
scopeType: CONTRACT_TYPE | BUSINESS_TYPE | ORDER_AMOUNT | DEPARTMENT | GLOBAL
scopeValue
status: ACTIVE | DISABLED
requiresTwoPersonApproval boolean
createdBy / updatedBy
```

Rules:

```text
REQUEST_USE allows a user or workflow to request seal usage
APPROVE_USE allows approval of a pending seal usage
AUTO_USE is only allowed for explicitly approved low-risk policies
MANAGE is administrative and must not imply signing authority
```

### SignaturePolicy

Defines how a contract type should be signed.

Suggested fields:

```text
id
policyCode
policyName
businessType
contractTemplateType
contractVersionId optional
status: DRAFT | ACTIVE | DISABLED
trigger: MANUAL | ORDER_PENDING_SIGN | PORTAL_REQUEST | SYSTEM_APPROVED
signingMode: CUSTOMER_ONLY | ENTERPRISE_SEAL_ONLY | CUSTOMER_AND_ENTERPRISE | MULTI_PARTY
executionMode: PARALLEL | SEQUENTIAL
effectiveFrom
effectiveTo
rules Json
createdBy / updatedBy
```

Rules should express:

```text
required signer roles
required seal type
whether enterprise seal is manual or automatic
signature order
timeout / expiry
rejection behavior
fallback behavior
```

### SignaturePolicyStep

If normalized steps are preferred over a large JSON policy, a later schema can add policy steps:

```text
policyId
stepOrder
stepType: CUSTOMER_SIGN | ENTERPRISE_SEAL | INTERNAL_APPROVAL | EXTERNAL_PARTY_SIGN
actorRole: CUSTOMER | PLATFORM_OPERATOR | FINANCE_MANAGER | LEGAL_MANAGER | SYSTEM
requiredAccountType: PERSONAL | ENTERPRISE
sealType optional
parallelGroup optional
required boolean
timeoutHours optional
```

The initial implementation can start with `rules Json` and compile to typed internal steps, then normalize into tables if policy complexity grows.

## Multi-Signature Model

Supported signing plans:

```text
customer-only
customer then enterprise seal
enterprise seal then customer
parallel customer + enterprise seal
multi-customer / guarantor / co-signer
internal approval before external signing
```

Recommended planning model:

```text
SigningPlan
  contractId
  policyId
  executionMode
  steps[]

SigningPlanStep
  order
  parallelGroup
  signerType
  signerRole
  customerId optional
  userId optional
  sealId optional
  providerAccountId optional
  required
```

C4 should compile a `SigningPlan` before B5 creates a provider task.

For B5 compatibility:

```text
CUSTOMER_SIGN steps map to ContractESignSigner signerType=CUSTOMER
ENTERPRISE_SEAL steps map to signerType=PLATFORM or a future ENTERPRISE signer type
internal approval steps do not map to provider signers
```

## Signing Policy Engine

Policy evaluation inputs:

```text
contract
order
customer onboarding status
customer provider binding
contract version/template type
business type
requested trigger source
operator / portal actor
available active seals
seal authority grants
```

Policy decisions:

```text
ALLOW
DENY
REQUIRE_APPROVAL
REQUIRE_ONBOARDING
REQUIRE_REALNAME
REQUIRE_SEAL_AUTHORITY
REQUIRE_POLICY_SELECTION
```

Example rule:

```text
If contract template type is SUBSCRIPTION_STANDARD
and customer is SIGNING_ENABLED
and company subscription seal is ACTIVE
and operator has REQUEST_USE authority
then compile CUSTOMER_AND_ENTERPRISE signing plan
with executionMode=SEQUENTIAL
and customer step before enterprise seal step.
```

## C4 State Machine

Recommended C4-facing states:

```text
NOT_EVALUATED
POLICY_SELECTED
AUTHORITY_PENDING
AUTHORITY_APPROVED
PLAN_COMPILED
READY_FOR_B5
BLOCKED
REJECTED
EXPIRED
```

State meaning:

```text
NOT_EVALUATED       no C4 policy decision yet
POLICY_SELECTED     active policy matched contract/order
AUTHORITY_PENDING   seal use needs human approval
AUTHORITY_APPROVED  required authority approval complete
PLAN_COMPILED       signing plan produced and frozen
READY_FOR_B5        B5 may create provider signing task
BLOCKED             missing onboarding, seal, policy, or authority
REJECTED            authority or policy approval rejected
EXPIRED             approval window expired
```

`READY_FOR_B5` must require:

```text
customer signing readiness passes C3
required seal is ACTIVE
required authority is present or approved
policy is ACTIVE
signing plan is immutable for the B5 task
```

## Integration With B5

C4 sits above B5:

```text
C4 SigningPlanCompiler
-> B5 createSignTask input
-> provider upload/signUrl/callback/archive
```

C4 does not:

```text
call uploadDocs
call extsign_validation
open signUrl
handle provider callback
archive signed PDF
advance Contract / Order directly
```

B5 remains responsible for:

```text
provider task creation
provider signer creation
provider callback verification
idempotency
signed PDF archive
contract/order advancement after verified signing
```

C4 should attach policy metadata to B5 request snapshots in a later implementation:

```text
policyId
signingPlanHash
sealId masked
authorityApprovalId
executionMode
step summary
```

This enables audit without changing provider execution semantics.

## Integration With C3/C2/C1

Layer responsibilities:

```text
C3 -> onboarding and signing readiness
C2 -> real-name lifecycle and verification status
C1 -> provider account binding
C4 -> enterprise seal authority and signing policy
B5 -> signing execution
```

C4 should call C3 readiness APIs rather than reading C1/C2 internals directly when possible.

Recommended C4 readiness check:

```text
customerSigningReady = CustomerESignOnboardingService.getOnboardingStatus(customerId).signingEligible
```

If not ready:

```text
C4 decision = REQUIRE_ONBOARDING or REQUIRE_REALNAME
B5 createSignTask is not called
```

## API Design Draft

### Admin Seal Management

```text
GET  /api/esign/enterprise-seals
POST /api/esign/enterprise-seals
GET  /api/esign/enterprise-seals/:id
PATCH /api/esign/enterprise-seals/:id
POST /api/esign/enterprise-seals/:id/disable
```

Permissions:

```text
esign:seal:view
esign:seal:manage
```

### Seal Authority

```text
GET  /api/esign/enterprise-seals/:id/authorities
POST /api/esign/enterprise-seals/:id/authorities
PATCH /api/esign/seal-authorities/:id
POST /api/esign/seal-authorities/:id/disable
```

Permissions:

```text
esign:seal_authority:view
esign:seal_authority:manage
```

### Signature Policies

```text
GET  /api/esign/signature-policies
POST /api/esign/signature-policies
GET  /api/esign/signature-policies/:id
PATCH /api/esign/signature-policies/:id
POST /api/esign/signature-policies/:id/activate
POST /api/esign/signature-policies/:id/disable
```

Permissions:

```text
esign:signature_policy:view
esign:signature_policy:manage
```

### Contract Policy Evaluation

```text
POST /api/contracts/:id/signing-policy/evaluate
POST /api/contracts/:id/signing-policy/compile-plan
GET  /api/contracts/:id/signing-policy/status
```

Permissions:

```text
contract:view
contract:sign
esign:signature_policy:view
```

These APIs should not call Fadada or B5 by default. They only evaluate policy and prepare/freeze a plan.

## Audit Model

Audit events:

```text
esign.enterprise_seal.create
esign.enterprise_seal.update
esign.enterprise_seal.disable
esign.seal_authority.grant
esign.seal_authority.revoke
esign.signature_policy.create
esign.signature_policy.activate
esign.signature_policy.disable
esign.signing_policy.evaluate
esign.signing_plan.compile
esign.signing_plan.approve
esign.signing_plan.reject
```

Audit payload boundaries:

```text
mask providerSealId
mask provider customer ids
do not store seal image/binary in audit
do not store app secret
do not store full signUrl
do not store provider raw response
include policy version/hash
include actor, source, decision, reason codes
```

## Risk Model

### Unauthorized Seal Usage

Risk:

```text
operator uses company seal without authority
```

Controls:

```text
active SealAuthority required
approval required for high-risk policy
MANAGE permission does not imply seal use
all seal-use decisions audited
```

### Signature Order Bypass

Risk:

```text
enterprise seal happens before required customer signature, or a required signer is skipped
```

Controls:

```text
compile immutable SigningPlan
store signingPlanHash
provider callbacks checked against expected step
policy engine rejects missing required steps
```

### Multi-Signer Inconsistency

Risk:

```text
local signer state and provider signer state drift
```

Controls:

```text
B5 idempotency remains source for provider execution
C4 plan is frozen before B5 task creation
callback handler only advances expected signers
duplicate/unknown callbacks remain safe
```

### Audit Trail Integrity

Risk:

```text
seal authority changes are not traceable
```

Controls:

```text
append audit entry on every policy/seal/authority mutation
include before/after masked snapshots
do not allow hard delete for active historical policies
```

### Provider Coupling

Risk:

```text
Fadada-specific seal behavior leaks into business policy
```

Controls:

```text
business policy uses provider-neutral seal and signer concepts
provider-specific fields stay in providerSnapshot or adapter mapping
Mock provider must support the same C4 policy tests
```

## Implementation Staging Proposal

### C4-B: Schema And Service Plan

Design exact migrations and service boundaries:

```text
EnterpriseSeal
SealAuthority
SignaturePolicy
SigningPlan / SigningPlanStep or JSON snapshot
```

### C4-C: Policy Evaluation MVP

Implement provider-free evaluation:

```text
policy matching
seal authority validation
signing plan compile
no B5 execution
```

### C4-D: B5 Integration

Connect approved signing plan to B5:

```text
compile plan -> createSignTask
persist plan hash in requestSnapshot
ensure callbacks match expected signer set
```

### C4-E: Fadada Enterprise Seal Validation

Only after C4-C/D pass locally:

```text
controlled provider-side enterprise seal preflight
no broad production launch
no auto-seal unless separately approved
```

## C4-A Conclusion

Recommended C4 architecture:

```text
EnterpriseSeal + SealAuthority + SignaturePolicy
-> SigningPolicyEngine
-> immutable SigningPlan
-> B5 signing execution
```

This keeps C4 as an enterprise governance layer above the already validated B5 engine and the C1/C2/C3 readiness stack.

Stage 10D-C4-B schema and policy engine implementation planning is recorded in `docs/stage-10d-c4-fadada-enterprise-seal-implementation-plan.md`.

Unrestricted enterprise seal or auto-seal production launch remains **No-Go** until later C4 implementation, validation, and production approval stages are complete.
