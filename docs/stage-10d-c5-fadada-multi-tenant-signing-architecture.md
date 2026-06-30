# Stage 10D-C5-A Multi-Tenant Enterprise Signing Architecture

Stage 10D-C5-A designs the multi-tenant enterprise signing platform above the completed C4 policy runtime and B5 execution engine.

This stage is architecture-only. It does not implement code, modify schema, create migrations, call Fadada, generate sign URLs, execute signing, mutate Contract / Order, touch payment logic, seed data, or deploy production.

## Background

Completed foundation:

```text
B5: provider execution engine validated
C1: Customer -> provider account binding complete
C2: real-name lifecycle complete
C3: onboarding orchestration complete
C4: enterprise seal policy engine and C4 -> B5 runtime integration complete
```

C4 proves that signing can be policy-driven:

```text
C4 decides
SigningPlan freezes the decision
B5 executes the approved reference
```

C5 adds the platform question:

```text
Which tenant owns this customer, policy, seal, plan, and execution?
```

## Design Goal

Move from a single-enterprise signing governance model to a multi-tenant signing governance platform:

```text
Tenant A policy != Tenant B policy
Tenant A seal != Tenant B seal
Tenant A provider account binding != Tenant B provider account binding
Tenant A SigningPlan cannot execute against Tenant B resources
```

The tenant boundary must become part of every C1/C2/C3/C4/B5 decision and audit path.

## Recommended Tenant Model

### Tenant

Represents the top-level isolation boundary for SaaS signing governance.

Suggested later schema fields:

```text
id
tenantCode
tenantName
status: ACTIVE | DISABLED | SUSPENDED
defaultProvider
createdAt / updatedAt
createdBy / updatedBy
deletedAt
```

Rules:

```text
only ACTIVE tenants can start onboarding or signing
disabled/suspended tenants block C3 and C4 before B5
tenantCode is unique and non-PII
tenant id is present in every policy, seal, binding, plan, and audit event
```

### Enterprise

Represents the legal entity or operating company inside a tenant.

Suggested later schema fields:

```text
id
tenantId
enterpriseName
legalEntityCode optional
status: ACTIVE | DISABLED
providerEnterpriseCustomerId optional
createdAt / updatedAt
deletedAt
```

Rules:

```text
one tenant may have multiple enterprises
enterprise seals belong to one enterprise and one tenant
enterprise provider ids are masked in all responses and audit
```

### Workspace

Represents an operating subdivision such as department, city, product line, or brand.

Suggested later schema fields:

```text
id
tenantId
enterpriseId optional
workspaceCode
workspaceName
workspaceType: DEPARTMENT | CITY | PRODUCT_LINE | BRAND | OTHER
status: ACTIVE | DISABLED
```

Rules:

```text
workspace scopes policies and seal authority
workspace does not override tenant isolation
workspace-level policy cannot reference another tenant's seal
```

## Tenant Mapping Across Layers

### C3 Onboarding

C3 owns customer entry and readiness orchestration.

Multi-tenant C3 rule:

```text
Customer -> Tenant -> Onboarding
```

Required checks:

```text
customer belongs to exactly one active tenant for the signing flow
onboarding status is evaluated inside tenant scope
portal/admin/order entry must pass tenant id into C3
cross-tenant onboarding reads return not found, not forbidden details
```

### C2 Real-Name

C2 owns real-name lifecycle mechanics.

Multi-tenant C2 rule:

```text
verification transaction belongs to tenant + customer + provider account
```

Required checks:

```text
verify callback resolves binding by tenant-scoped transaction metadata
VERIFIED status cannot be applied to a binding from another tenant
provider raw response remains sanitized
```

### C1 Provider Binding

C1 owns provider account mapping.

Multi-tenant C1 rule:

```text
CustomerESignProviderAccount uniqueness becomes tenant-scoped
```

Recommended future uniqueness:

```text
unique(tenantId, provider, customerId, accountType)
unique(tenantId, provider, providerOpenId)
unique(tenantId, provider, providerCustomerId)
```

Provider open id v2 should include tenant namespace without exposing tenant secrets:

```text
subauto_person_v2_<sha256(tenantId + ":" + customerId + ":" + namespace).slice(0, 24)>
```

Migration from v1 open ids must be explicit and non-breaking.

### C4 Policy

C4 owns signing governance.

Multi-tenant C4 rule:

```text
TenantScopedSignaturePolicyEngine.evaluate(input)
```

Required input additions for later implementation:

```text
tenant: { id, status }
enterprise?: { id, status }
workspace?: { id, status, type }
```

Policy resolution order:

```text
1. tenant + contractVersion-specific policy
2. tenant + workspace + template policy
3. tenant + enterprise + template policy
4. tenant default template policy
5. no policy -> REQUIRE_POLICY_SELECTION
```

No policy from another tenant may be considered.

### B5 Execution

B5 remains shared infrastructure, but every execution reference is tenant-scoped.

Multi-tenant B5 rule:

```text
B5 executes an ApprovedSigningPlanRef that already includes tenant scope.
```

Recommended future `ApprovedSigningPlanRef` additions:

```text
tenantId
enterpriseId optional
workspaceId optional
signingPlanId
policyId
planHash
executionMode
steps
```

B5 must not infer tenant from provider responses. It should use local task / plan metadata as the source of truth.

## Policy Isolation Model

`TenantScopedSignaturePolicyEngine` should be a thin tenant-aware wrapper around the pure C4 engine:

```text
1. validate tenant active
2. resolve tenant-scoped policy, seal, authority
3. call pure SignaturePolicyEngine.evaluate
4. compile tenant-scoped SigningPlan
```

The pure C4 engine remains deterministic and side-effect free.

Tenant-specific rules:

```text
tenant policy override can narrow but not bypass global safety requirements
tenant cannot disable VERIFIED requirement
tenant cannot bypass ACTIVE customer requirement
tenant cannot use another tenant's seal
tenant cannot consume another tenant's signing plan
```

Suggested global invariants:

```text
REGISTERED + VERIFIED binding is always required
ACTIVE customer is always required
PENDING_SIGN contract is always required
ACTIVE tenant is always required
approved SigningPlan is immutable
```

## Seal Isolation Model

`EnterpriseSeal` must be tenant-owned.

Recommended isolation fields:

```text
tenantId
enterpriseId
workspaceId optional
provider
providerSealId optional
sealType
status
```

Seal selection rules:

```text
only ACTIVE seals can be selected
seal.tenantId must equal contract/order/customer tenantId
workspace-scoped seal can only be selected for matching workspace
enterprise-scoped seal can be selected only inside the owning enterprise
providerSealId remains masked
```

Authority rules:

```text
SealAuthority.tenantId must match seal.tenantId
MANAGE does not imply REQUEST_USE
REQUEST_USE / AUTO_USE are still required
two-person approval remains tenant-scoped
role and department subjects are resolved inside tenant scope
```

## SigningPlan Isolation Model

`SigningPlan` becomes the immutable cross-layer execution contract.

Recommended future plan hash payload:

```text
tenantId
enterpriseId
workspaceId
contractId
policyId
sealId
executionMode
steps
decisionSnapshotVersion
```

Rules:

```text
plan tenantId must match contract/order/customer tenantId
plan tenantId must match policy and seal tenantId
B5 task requestSnapshot must copy tenant-scoped plan metadata
callbacks advance only tasks whose local plan/task tenant context matches
plans cannot be reused across tenants
```

The hash must change when tenant scope changes, even if policy and steps are otherwise identical.

## Product Entry Mapping

### Order Entry

```text
Order -> tenantId -> C3 onboarding -> C4 policy -> B5
```

Order must carry or derive tenant context before onboarding or policy evaluation.

### Portal Entry

```text
Portal session -> tenant scope -> customer -> onboarding status
```

Portal users must not query onboarding, signing plans, or signed artifacts outside their tenant.

### Admin Entry

```text
Admin actor -> tenant memberships / permissions -> C3/C4 operations
```

Admin permissions must become tenant-scoped:

```text
esign:seal:view within tenant
esign:seal:manage within tenant
esign:signature_policy:view within tenant
contract:sign within tenant
```

Super-admin cross-tenant access should be explicit and heavily audited.

## Audit And Observability

Every C1/C2/C3/C4/B5 audit event should include:

```text
tenantId
source: ORDER | PORTAL | ADMIN | SYSTEM
masked customer id
policy id when present
plan hash when present
seal id when present
decision code when present
```

Audit must not include:

```text
full provider customer id
full provider seal id
full customer id in user-facing payloads
app secret
signUrl
provider raw response
PII
seal binary
```

Recommended event names:

```text
esign.tenant_policy.evaluate
esign.tenant_signing_plan.compile
esign.tenant_signing_plan.approve
esign.tenant_signing_plan.consume
esign.tenant_seal.select
esign.tenant_cross_scope.reject
```

## API Design Draft

Tenant-aware admin APIs:

```text
GET  /api/tenants/:tenantId/esign/enterprise-seals
POST /api/tenants/:tenantId/esign/enterprise-seals
GET  /api/tenants/:tenantId/esign/signature-policies
POST /api/tenants/:tenantId/esign/signature-policies
POST /api/tenants/:tenantId/contracts/:contractId/signing-policy/evaluate
POST /api/tenants/:tenantId/contracts/:contractId/signing-policy/compile-plan
GET  /api/tenants/:tenantId/contracts/:contractId/signing-policy/status
```

Portal APIs should infer tenant from authenticated context:

```text
GET /api/portal/esign/onboarding/status
POST /api/portal/contracts/:contractId/esign/start-readiness-check
```

Do not expose tenant ids in portal URLs unless the portal itself is multi-tenant-selectable.

## Risk Model

### Cross-Tenant Signing Leakage

Risk:

```text
Tenant A customer signs or sees Tenant B contract, plan, seal, or artifact.
```

Controls:

```text
tenant id required in C3/C4/B5 local metadata
all queries filter by tenantId
cross-scope mismatch returns not found
plan hash includes tenantId
signed artifact access checks tenant + customer ownership
```

### Policy Collision

Risk:

```text
same policyCode or template policy resolves across tenants incorrectly.
```

Controls:

```text
unique(tenantId, policyCode)
tenant-scoped policy resolver
no global default unless explicitly copied into tenant context
```

### Seal Mis-Assignment

Risk:

```text
Tenant A policy references Tenant B seal.
```

Controls:

```text
policy.defaultSealId must resolve inside same tenant
seal authority tenantId must match seal tenantId
compile rejects cross-tenant seal
audit esign.tenant_cross_scope.reject
```

### SigningPlan Cross Reference Bug

Risk:

```text
B5 task consumes a plan generated for another tenant or contract.
```

Controls:

```text
ApprovedSigningPlanRef includes tenantId
B5 validates plan metadata against contract/order tenant context before provider call
planHash includes tenantId and contractId
CONSUMED plan cannot be reused
```

### Provider Account Namespace Collision

Risk:

```text
same provider customer id or open id is attached to wrong tenant.
```

Controls:

```text
tenant-scoped unique constraints
providerOpenId v2 includes tenant namespace
manual attach requires tenant-scoped admin permission and audit
```

## Migration And Rollout Strategy

C5-A does not perform migration. Later implementation should be staged:

```text
1. Add tenant model and tenant-scoped read paths in dry-run mode
2. Backfill tenantId for existing single-tenant data
3. Add tenantId to C1 provider bindings
4. Add tenantId to C3 onboarding audit/context
5. Add tenantId to C4 policies/seals/plans
6. Add tenantId metadata to B5 requestSnapshot and task views
7. Enable tenant-scoped policy evaluation in non-production
8. Run controlled single-tenant compatibility validation
9. Add second test tenant isolation validation
10. Production approval for tenant enforcement
```

Recommended flags:

```env
ESIGN_TENANT_SCOPE_ENABLED=false
ESIGN_REQUIRE_TENANT_SCOPED_PLAN=false
ESIGN_ALLOW_CROSS_TENANT_ADMIN=false
```

Default posture:

```text
single-tenant compatibility remains intact
tenant enforcement is disabled until explicitly approved
C4 policy remains provider-free
B5 remains execution-only
Fadada provider APIs remain disabled unless later approved
```

## C5-A Conclusion

Recommended C5 architecture:

```text
Tenant / Enterprise / Workspace
-> C3 tenant-scoped onboarding
-> C2 tenant-scoped real-name lifecycle
-> C1 tenant-scoped provider binding
-> C4 tenant-scoped policy / seal / SigningPlan
-> B5 shared execution engine consuming tenant-scoped ApprovedSigningPlanRef
```

Stage 10D-C5-A is ready for C5-B implementation planning.

Production multi-tenant enterprise signing remains **No-Go** until tenant schema, backfill, dry-run validation, second-tenant isolation tests, and production approval are complete.
