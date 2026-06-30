# Stage 10D Lease SaaS CPS Compliance System Design

Stage 10D-Lease-SaaS-CPS-Compliance-System-Design upgrades the completed e-sign platform into a production-grade lease contract automation system:

```text
Order -> Contract -> Signing -> Seal -> Lease Fulfillment
```

This stage is architecture-only. It does not implement code, modify schema, add migrations, call Fadada, generate sign URLs, sign contracts, mutate production data, seed data, or deploy production.

## Compliance Input

The design incorporates the user-provided 2026-06-23 Fadada CPS certificate compliance requirement:

```text
Auto-sign / enterprise seal execution must be gated by certificate validity.
Expired or invalid certificates must block auto-sign.
Re-authorization must be explicit.
No automatic certificate renewal is allowed.
```

Public web search during this stage did not locate a reliable public copy of the 2026-06-23 announcement. Implementation must attach the official Fadada / internal compliance notice before enabling the production gate.

Relevant local Fadada document areas to re-check before implementation:

```text
D:\Projects\document\fadada\doc\4.6.6 扩展接口列表_查看&查询&下载_查询证书信息.pdf
D:\Projects\document\fadada\doc\3.7.3 API文档_合同签署_自动签署.pdf
D:\Projects\document\fadada\doc\3.7.2.4 API文档_合同签署_授权自动签_查询授权自动签状态接口.pdf
D:\Projects\document\fadada\doc\3.7.2.1 API文档_合同签署_授权自动签_获取授权自动签页面接口.pdf
```

## Final SaaS Architecture

The target platform is a layered lease automation system:

```text
Product / Admin / Portal Entry
-> Order Intake
-> Contract Generation and Versioning
-> C3 Customer Onboarding
-> C2 Real-name Lifecycle
-> C1 Provider Account Binding
-> C4 Enterprise Signing Policy
-> CPS Compliance Layer
-> B5 Signing Execution Engine
-> Callback / Archive / Evidence
-> Lease Fulfillment Engine
-> Billing / Receivables / Service Entitlements
-> Compliance Audit / Risk Monitoring
```

Layer responsibilities:

| Layer | Responsibility | Must Not Do |
| --- | --- | --- |
| Order Intake | Create the commercial intent, selected vehicle, pricing, customer, and product version | Sign, seal, or activate lease |
| Contract Generation | Produce immutable contract version and PDF artifact | Change financial state |
| C3 Onboarding | Orchestrate customer readiness | Call signing APIs directly |
| C2 Real-name | Drive real-name status and cert binding mechanics | Start signing |
| C1 Provider Binding | Store provider account identifiers and readiness | Evaluate signing policy |
| C4 Policy Engine | Decide signing authority and compile immutable SigningPlan | Call Fadada |
| CPS Compliance Layer | Cert validity and CPS rule enforcement before auto-sign | Auto-renew certificates |
| B5 Execution Engine | Execute approved signing plan against provider | Compute policy or bypass CPS |
| Lease Fulfillment | Activate lease after signed contract and required commercial gates | Create payment records from signing alone |
| Audit / Risk | Append-only traceability, alerts, compliance evidence | Store PII or secrets in logs |

System invariant:

```text
Signing execution is never the same thing as lease activation.
```

A signed contract is a legal prerequisite. Lease activation still depends on configured commercial gates such as payment, vehicle delivery readiness, entitlement setup, and risk review.

## CPS Compliance Layer Design

The CPS layer sits between C4 policy approval and B5 auto-sign execution.

```text
C4 SigningPlan
-> CPSComplianceGate
-> CertificateValidityCheckService
-> ComplianceRuleEngine
-> ApprovedCPSDecisionRef
-> B5 execution
```

### Components

#### CertificateValidityCheckService

Checks the effective certificate status for the planned signer / seal / provider identity.

Inputs:

```text
tenantId
enterpriseId
provider
providerEnterpriseCustomerId
sealId / signatureId
signingPlanHash
operation = AUTO_SIGN | MANUAL_SIGN | ARCHIVE | QUERY
```

Outputs:

```text
certificateStatus
validFrom
validTo
lastCheckedAt
source = PROVIDER_QUERY | CACHED_PROJECTION | ADMIN_ATTESTATION
providerEvidenceRef masked
```

Rules:

```text
UNKNOWN is not allowed for auto-sign
EXPIRED blocks auto-sign
REAUTH_REQUIRED blocks auto-sign
EXPIRING follows tenant / region policy
VALID can proceed only when all other policy checks pass
```

#### CPSComplianceGate

Creates the execution gate decision for `extsign_auto.api` or any equivalent enterprise auto-seal operation.

Decision shape:

```text
decision = ALLOW | WARN | BLOCK | REAUTH_REQUIRED
ruleVersion
certificateStatus
reasonCode
signingPlanHash
auditEventId
expiresAt
```

B5 may execute an auto-sign step only if it receives an `ALLOW` decision bound to the same `signingPlanHash`.

#### ReAuthTriggerFlow

Handles explicit re-authorization.

Required behavior:

```text
expired certificate -> block auto-sign
block result -> create re-auth required event
admin / authorized operator starts re-auth
provider re-auth URL or workflow is generated only under explicit gate
successful callback / query marks REAUTHORIZED
projection refresh returns VALID
auto-sign can be retried idempotently
```

The system must not renew or re-authorize certificates automatically.

#### CertificateStatusProjection

Maintains the latest known certificate status for dashboards and preflight.

Projection is not the legal source of truth for final auto-sign. The last-mile `CPSComplianceGate` must still produce a bounded decision before B5 calls `extsign_auto.api`.

#### ComplianceRuleEngine

Evaluates CPS and future regional compliance rules.

Rule domains:

```text
CPS certificate validity
tenant-level policy
region-level rules
provider capability rules
enterprise seal authority
signing plan consistency
evidence retention rules
```

## Certificate Lifecycle Model

Minimum lifecycle:

```text
UNKNOWN
-> VALID
-> EXPIRING
-> EXPIRED
-> REAUTH_REQUIRED
-> REAUTH_PENDING
-> REAUTHORIZED
-> VALID
```

Additional terminal / control states:

```text
DISABLED
REVOKED
SUSPENDED
```

### State Definitions

| State | Meaning | Auto-sign |
| --- | --- | --- |
| UNKNOWN | No verified certificate status is available | Block |
| VALID | Certificate is verified and inside validity window | Allow if all policy rules pass |
| EXPIRING | Certificate is still valid but within warning window | Warn or block by tenant / region rule |
| EXPIRED | Certificate validity ended | Block |
| REAUTH_REQUIRED | System requires explicit re-authorization | Block |
| REAUTH_PENDING | Re-authorization has started but is not confirmed | Block |
| REAUTHORIZED | Provider re-authorization has completed, pending projection refresh | Block until refreshed to VALID |
| DISABLED | Admin or compliance officer disabled use | Block |
| REVOKED | Provider / CA revoked certificate | Block |
| SUSPENDED | Temporary compliance hold | Block |

### Transition Rules

```text
UNKNOWN -> VALID: provider query or approved onboarding confirms cert status
VALID -> EXPIRING: system clock enters warning window
EXPIRING -> EXPIRED: validity window passes
VALID / EXPIRING -> REAUTH_REQUIRED: policy requires renewal before auto-sign
EXPIRED -> REAUTH_REQUIRED: auto-sign attempted or scheduled with expired cert
REAUTH_REQUIRED -> REAUTH_PENDING: authorized operator starts re-auth
REAUTH_PENDING -> REAUTHORIZED: provider confirms re-auth success
REAUTHORIZED -> VALID: certificate projection refresh confirms new validity
any active state -> DISABLED / SUSPENDED: admin compliance action
any active state -> REVOKED: provider or compliance evidence indicates revocation
```

Hard invariants:

```text
No state transition may store identity document numbers, full mobile numbers, secrets, full provider raw responses, or sign URLs.
No automatic renewal.
No auto-sign from UNKNOWN, EXPIRED, REAUTH_REQUIRED, REAUTH_PENDING, REVOKED, DISABLED, or SUSPENDED.
```

## Auto-Sign Execution Flow

The auto-sign path is only for enterprise seal / platform-side automatic signing. Customer manual signing remains governed by C1/C2/C3/C4 readiness and B5 execution.

Recommended flow:

```text
1. Order and Contract reach signing-ready state.
2. C3 confirms customer onboarding readiness.
3. C4 evaluates policy and compiles immutable SigningPlan.
4. SigningPlan includes enterprise seal step requiring CPS gate.
5. B5 receives ApprovedSigningPlanRef but does not execute yet.
6. CPSComplianceGate checks certificate status and compliance rules.
7. If ALLOW: B5 may call provider auto-sign operation for that exact plan hash.
8. If WARN: B5 may proceed only if policy permits warning execution; audit must include warning.
9. If BLOCK / REAUTH_REQUIRED: no provider auto-sign call is made.
10. ReAuthTriggerFlow starts only after explicit authorized action.
11. After re-auth and VALID projection, retry uses the same contract/task idempotency rules.
```

### `extsign_auto.api` Pre-Gate

Before any call equivalent to `extsign_auto.api`, B5 must require:

```text
ApprovedSigningPlanRef present
ApprovedCPSDecisionRef present
decision = ALLOW
decision.signingPlanHash = signingPlan.hash
decision.notExpired
certificateStatus = VALID
sealAuthority active
tenant / region rules pass
```

If any condition fails:

```text
return CPS_AUTO_SIGN_BLOCKED
do not call provider
do not create signUrl
do not mutate Contract / Order into signed states
do not activate lease
write audit event
```

### Expiring Certificate Policy

Default recommendation:

```text
EXPIRING within warning window -> WARN for dashboards and preflight
EXPIRING inside strict block window -> BLOCK
EXPIRED -> BLOCK
```

The warning and strict block windows must be versioned compliance rules, not hard-coded provider assumptions.

## Lease Fulfillment Engine Design

Lease fulfillment starts after signing is legally complete and post-signing artifacts are archived. It must not be driven by signUrl generation or task creation.

### Fulfillment State Machine

Recommended states:

```text
ORDER_CREATED
QUOTE_CONFIRMED
CONTRACT_GENERATED
SIGNING_READY
SIGNING_IN_PROGRESS
SIGNED
SIGNED_PDF_ARCHIVED
LEASE_ACTIVATION_PENDING
PAYMENT_GATE_PENDING
DELIVERY_GATE_PENDING
LEASE_ACTIVE
BILLING_SCHEDULED
SERVICE_ENTITLEMENTS_ACTIVE
FULFILLMENT_BLOCKED
SUSPENDED
TERMINATED
CANCELLED
```

### Activation Gates

Lease activation requires all configured gates:

```text
contract.status = SIGNED
signedDocumentObjectKey present
signing task completed and verified
CPS gate passed if enterprise auto-seal was required
initial payment / deposit gate satisfied if product policy requires it
vehicle delivery / handover readiness confirmed
receivable schedule generated
risk / compliance hold absent
```

Signing completion can move an order to a commercial next state such as `PENDING_PAYMENT`, but it must not by itself:

```text
create PaymentRecord
create PaymentWriteOff
mark receivables paid
activate vehicle entitlement
start billing without lease activation gates
```

### Fulfillment Services

Recommended services:

| Service | Responsibility |
| --- | --- |
| LeaseFulfillmentService | Owns state transition from signed contract to active lease |
| FulfillmentGateEvaluator | Evaluates payment, delivery, compliance, artifact, and risk gates |
| LeaseActivationService | Performs the final idempotent activation when gates pass |
| BillingScheduleService | Creates receivable schedule after activation approval |
| EntitlementActivationService | Enables customer entitlements after lease activation |
| FulfillmentAuditService | Records transition source, actor, and evidence refs |

## Compliance Rule Engine

The compliance rule engine is provider-neutral and tenant-aware.

Decision model:

```text
ruleSetId
ruleVersion
subjectType = SIGNING_PLAN | AUTO_SIGN | LEASE_ACTIVATION | ARCHIVE | PROVIDER_BINDING
decision = ALLOW | WARN | BLOCK | REAUTH_REQUIRED | MANUAL_REVIEW
reasonCodes[]
evidenceRefs[]
effectiveAt
expiresAt
```

### CPS Enforcement Rules

Minimum CPS rules:

```text
CPS_CERT_STATUS_REQUIRED
CPS_CERT_VALID_FOR_AUTO_SIGN
CPS_CERT_NOT_EXPIRED
CPS_CERT_REAUTH_NOT_PENDING
CPS_CERT_SOURCE_ACCEPTED
CPS_DECISION_BOUND_TO_PLAN_HASH
```

### Region-Based Future Rules

Future-ready rule inputs:

```text
customerRegion
vehicleRegistrationRegion
contractGoverningLawRegion
tenantOperatingRegion
providerDataResidencyRegion
```

Future examples:

```text
region requires manual enterprise seal
region requires extra evidence retention
region blocks auto-sign for specific contract types
region requires localized consent text
```

### Audit Traceability

Every rule decision must record:

```text
tenantId masked
customerId masked
contractId masked
orderId masked
signingPlanHash
certificateStatus
ruleVersion
decision
reasonCodes
actor / system source
createdAt
```

No audit event may include:

```text
appSecret
full provider customer_id
full identity number
full mobile
full provider raw response
full signUrl
PDF binary
```

## Integration With Existing C1-C4-B5 System

### C1 Provider Binding

C1 remains the source for:

```text
Customer -> provider customer_id
registrationStatus
realNameStatus
providerOpenId
```

For CPS, C1 can later be extended or linked to enterprise provider certificate metadata, but personal provider binding must not be overloaded with enterprise seal certificate state.

### C2 Real-name Lifecycle

C2 proves the identity/account readiness. CPS certificate state is adjacent but distinct:

```text
C2 realNameStatus = identity readiness
CPS certificateStatus = enterprise auto-sign certificate validity
```

Both must pass before enterprise auto-sign can proceed.

### C3 Onboarding

C3 remains the product entry and readiness orchestrator.

C3 should expose:

```text
customer signing readiness
provider account readiness
real-name readiness
compliance readiness summary
```

C3 must not call `extsign_auto.api`.

### C4 Policy Engine

C4 compiles the immutable SigningPlan.

New C4 plan fields for later implementation:

```text
requiresCpsGate: boolean
autoSignSteps[]
sealAuthorityRef
certificateSubjectRef
complianceRuleSetId
```

C4 does not query provider certificate state directly during design. It declares the requirement; CPS gate evaluates it before B5 execution.

### B5 Execution Engine

B5 must execute only:

```text
ApprovedSigningPlanRef
+ ApprovedCPSDecisionRef for auto-sign steps
```

B5 must not:

```text
compute policy
select seal
ignore expired cert
auto-renew cert
activate lease
create payment records
```

### Lease Fulfillment

Lease fulfillment consumes signing outcomes:

```text
callback verified
task completed
contract signed
signed PDF archived
compliance gates satisfied
```

It does not call signing provider APIs.

## Risk Analysis

| Risk | Failure Mode | Control |
| --- | --- | --- |
| Auto-sign failure due to expired cert | Provider rejects `extsign_auto.api`, contract remains partially signed | CPS pre-gate blocks before provider call; re-auth workflow; idempotent retry |
| Signing bypass without CPS check | Legacy B5 path calls auto-sign directly | B5 requires `ApprovedCPSDecisionRef` for auto-sign steps; tests enforce no direct auto-sign |
| Compliance drift | CPS rules change but system still uses old assumptions | Rule versioning, announcement evidence register, scheduled compliance review |
| Audit incompleteness | Cannot prove why auto-sign was allowed or blocked | Append-only compliance decision events linked to signingPlanHash |
| Certificate status stale | Cached VALID used after expiry | Bounded decision TTL; final gate before provider call; expiry checked by system clock |
| Re-auth misuse | Operator re-authorizes wrong enterprise/seal | permission gate, two-person approval for production, masked audit, tenant/enterprise binding checks |
| Tenant leakage | Tenant A seal used for Tenant B contract | tenant-scoped policy, seal, certificate, SigningPlan, and CPS decision |
| Lease activation too early | Signed contract activates lease before payment or delivery gates | fulfillment gate evaluator separates signed state from active lease |
| Payment side effects | Signing callback creates payment records | signing callback only advances signing/contract state; fulfillment/payment gates own billing |
| Provider outage | Certificate query unavailable blocks all auto-sign | fail closed for auto-sign; queue retry; manual review path |
| Public compliance evidence missing | Requirement source cannot be audited later | attach official 2026-06-23 notice before implementation; keep compliance register |

## Production Readiness Assessment

Current platform foundation:

| Capability | Status |
| --- | --- |
| B5 real signing execution | Validated |
| Signed PDF archive | Validated |
| C1 provider binding | Implemented |
| C2 real-name lifecycle | Implemented |
| C3 onboarding orchestration | Implemented and validated |
| C4 policy engine and B5 integration | Implemented and validated |
| Multi-tenant signing architecture | Designed |
| CPS certificate validity gate | Design only |
| `extsign_auto.api` production enablement | No-Go |
| Lease fulfillment engine | Design only |
| Broad production auto-seal | No-Go |
| Lease automation production launch | No-Go |

Recommended feature flags for later implementation:

```env
FADADA_AUTO_SIGN_ENABLED=false
FADADA_CPS_COMPLIANCE_ENABLED=false
FADADA_AUTO_SIGN_CPS_GATE_REQUIRED=true
LEASE_FULFILLMENT_ENGINE_ENABLED=false
LEASE_ACTIVATION_AFTER_SIGNING_ENABLED=false
COMPLIANCE_REGION_RULES_ENABLED=false
```

Production Go conditions:

```text
official 2026-06-23 CPS notice attached and reviewed
CPS certificate query behavior confirmed against Fadada docs/support
certificate lifecycle persisted with audit
extsign_auto.api hard-gated by CPS decision
B5 direct auto-sign bypass removed or impossible
lease fulfillment state machine implemented idempotently
payment side effects isolated from signing callback
non-production CPS rehearsal passed
production rollout approved with rollback and re-auth runbook
```

Until those conditions are met:

```text
manual customer signing can remain supported through existing guarded path
enterprise auto-seal remains disabled
lease activation remains non-automatic
```

## Recommended Next Stages

```text
Stage 10D-CPS-A: official CPS announcement evidence register and Fadada certificate API confirmation
Stage 10D-CPS-B: certificate lifecycle schema and service implementation plan
Stage 10D-CPS-C: CPS gate MVP with provider-free tests
Stage 10D-CPS-D: controlled certificate query integration test
Stage 10D-Lease-A: lease fulfillment state machine design to implementation plan
Stage 10D-Lease-B: signed-contract to lease-activation MVP without payment side effects
```

## Stage Result

Stage 10D-Lease-SaaS-CPS-Compliance-System-Design is a design-only architecture stage.

Result:

```text
final SaaS architecture: designed
CPS compliance layer: designed
certificate lifecycle model: designed
auto-sign execution gate: designed
lease fulfillment engine: designed
compliance rule engine: designed
risk model: documented
C1-C4-B5 integration: mapped
production readiness: No-Go for auto-sign / lease automation until CPS and fulfillment implementation stages complete
```
