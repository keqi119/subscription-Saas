# Stage 10D-C3-B Fadada Onboarding Orchestration Implementation Plan

Stage 10D-C3-B translates the C3-A customer onboarding model into an implementation blueprint.

This stage is planning-only. It does not implement code, modify schema, add migrations, call Fadada, generate sign URLs, sign, create contracts/orders, modify production data, deploy, or use real customer data.

## Background

Completed foundation:

```text
B5-B: controlled full Fadada signing execution passed
C1-A: CustomerESignProviderAccount formal binding implemented
C2: Fadada real-name lifecycle implemented
C2-B: real-name integration boundary validated
C2-C: production signing gate hardened
C3-A: customer onboarding model designed
```

The production signing invariant remains:

```text
FADADA_ENV=production
-> REGISTERED + VERIFIED CustomerESignProviderAccount required
-> no smoke fallback
-> no implicit provider customer id
```

C3-B defines how the product-facing onboarding layer should orchestrate C1/C2 without weakening that invariant.

## Onboarding Orchestration Architecture

C3 should add a thin orchestration layer on top of the C1/C2 primitives:

```text
CustomerOnboardingController
-> CustomerOnboardingService
-> CustomerOnboardingPolicy
-> CustomerOnboardingStateResolver
-> C1 CustomerESignProviderAccountService
-> C2 Fadada real-name lifecycle methods
```

Recommended implementation units:

```text
apps/api/src/esign/customer-esign-onboarding.controller.ts
apps/api/src/esign/customer-esign-onboarding.service.ts
apps/api/src/esign/customer-esign-onboarding.dto.ts
apps/api/src/esign/customer-esign-onboarding.policy.ts
apps/api/src/esign/customer-esign-onboarding-state.ts
apps/api/test/customer-esign-onboarding.spec.ts
```

The onboarding service should provide workflow-level methods:

```text
getStatus(customerId, actor)
startOnboarding(customerId, actor, idempotencyKey?)
registerProvider(customerId, actor, idempotencyKey?)
startRealNameVerification(customerId, input, actor, idempotencyKey?)
applyCertificate(customerId, actor, idempotencyKey?)
retryOnboardingStep(customerId, step, actor, idempotencyKey?)
evaluateEligibility(customerId, actor)
deriveOnboardingState(binding, eligibility)
```

The orchestration service owns workflow order and eligibility. It must not duplicate provider API signing logic, real-name digest handling, or provider account storage rules.

## State Machine Implementation Strategy

For the first C3-C implementation, the onboarding state should be derived from `CustomerESignProviderAccount` plus eligibility policy.

Single source of truth:

```text
CustomerESignProviderAccount.registrationStatus
CustomerESignProviderAccount.realNameStatus
CustomerESignProviderAccount.providerCustomerId
CustomerESignProviderAccount.deletedAt
Customer eligibility / disabled policy
```

Derived onboarding state:

```text
NOT_STARTED
ONBOARDING
ACCOUNT_CREATED
REALNAME_PENDING
VERIFIED
SIGNING_ENABLED
FAILED
DISABLED
```

Recommended derivation:

```text
NOT_STARTED:
  no binding

ONBOARDING:
  binding exists
  registrationStatus=PENDING
  realNameStatus=UNVERIFIED

ACCOUNT_CREATED:
  registrationStatus=REGISTERED
  providerCustomerId present
  realNameStatus=UNVERIFIED

REALNAME_PENDING:
  registrationStatus=REGISTERED
  providerCustomerId present
  realNameStatus=PENDING

VERIFIED:
  registrationStatus=REGISTERED
  providerCustomerId present
  realNameStatus=VERIFIED

SIGNING_ENABLED:
  VERIFIED plus policy checks pass
  binding not deleted
  customer eligible
  production resolver can use the binding

FAILED:
  registrationStatus=FAILED
  or realNameStatus=FAILED

DISABLED:
  provider account disabled/deleted
  or customer eligibility fails
```

`SIGNING_ENABLED` should be a derived policy result, not a stored status. This avoids dual-write inconsistency between a workflow table and provider-account status.

Future optional persistence:

```text
CustomerESignOnboardingEvent
CustomerESignOnboardingIdempotencyKey
```

These tables can improve audit and replay behavior later, but they should not become the authority for signing readiness.

## C3 To C2 Boundary Design

C3 owns orchestration:

```text
who can start onboarding
which next step is allowed
which response is exposed to Admin / Portal
how retry is requested
how readiness is explained
```

C2 owns mechanics:

```text
provider account registration
real-name verify URL
verify callback
status refresh
apply_cert
realNameStatus state machine
resolver readiness
```

Boundary rules:

```text
C3 may call C1/C2 service methods.
C2 must not import or depend on C3.
C3 must not update provider account fields directly when a C1/C2 service method exists.
C3 must not mark realNameStatus=VERIFIED in normal flow.
C3 must not call signing services.
C3 must not trigger contract upload, sign URL generation, archive, or order advancement.
```

Normal authority chain:

```text
C3 verify request
-> C2 get_person_verify_url
-> provider callback or status refresh
-> C2 realNameStatus=VERIFIED
-> C2 apply_cert
-> C3 derived SIGNING_ENABLED
-> signing resolver uses REGISTERED + VERIFIED binding
```

## API Implementation Blueprint

The API should expose workflow endpoints, not low-level provider operations.

### Admin API

```text
GET  /api/customers/:id/esign-onboarding/status
POST /api/customers/:id/esign-onboarding/start
POST /api/customers/:id/esign-onboarding/register-provider
POST /api/customers/:id/esign-onboarding/verify
POST /api/customers/:id/esign-onboarding/apply-cert
POST /api/customers/:id/esign-onboarding/retry
```

Recommended permissions:

```text
read: customer:view
write: customer:manage
```

### Portal API

```text
GET  /api/portal/esign-onboarding/status
POST /api/portal/esign-onboarding/start
POST /api/portal/esign-onboarding/verify
```

Portal API must not expose:

```text
manual attach
manual VERIFIED override
provider customer id input
raw provider snapshots
admin retry for provider registration
```

### Response Shape

All endpoints should return a masked workflow view:

```json
{
  "state": "REALNAME_PENDING",
  "provider": "FADADA",
  "accountType": "PERSONAL",
  "registrationStatus": "REGISTERED",
  "realNameStatus": "PENDING",
  "signingEligible": false,
  "nextAction": "COMPLETE_REALNAME",
  "providerOpenId": "subauto...abcd",
  "providerCustomerId": "fadad...1234",
  "lastErrorCode": null,
  "lastErrorMessage": null
}
```

Do not return:

```text
full provider customer id
full provider open id if policy treats it as sensitive
full real-name URL
real name
mobile number
ID card number
provider raw response
app secret
```

### Request Schemas

`POST /start`

```json
{
  "provider": "FADADA",
  "accountType": "PERSONAL"
}
```

Behavior:

```text
validate eligibility
create or return PENDING binding
do not call Fadada unless a later explicit step is called
```

`POST /register-provider`

```json
{
  "provider": "FADADA",
  "accountType": "PERSONAL"
}
```

Behavior:

```text
requires eligible binding
calls C1 register method only when the provider registration gate is enabled
returns existing REGISTERED binding idempotently
```

`POST /verify`

```json
{
  "provider": "FADADA",
  "accountType": "PERSONAL",
  "realNameInput": {
    "name": "<request-only>",
    "mobile": "<request-only>",
    "idCardNo": "<request-only>"
  }
}
```

Behavior:

```text
requires REGISTERED binding
calls C2 real-name verification start when the real-name gate is enabled
does not store or return request-only PII
returns masked URL or short-lived redirect wrapper only if product policy approves it
```

`POST /apply-cert`

```json
{
  "provider": "FADADA",
  "accountType": "PERSONAL"
}
```

Behavior:

```text
requires realNameStatus=VERIFIED
calls C2 apply_cert method when enabled
returns updated derived onboarding state
does not sign
```

`POST /retry`

```json
{
  "step": "REGISTER_PROVIDER"
}
```

Allowed steps:

```text
START
REGISTER_PROVIDER
REALNAME_VERIFY
APPLY_CERT
STATUS_REFRESH
```

Retry must be explicit and audited for admin flows.

## Error Model

Recommended C3 error codes:

```text
ESIGN_ONBOARDING_CUSTOMER_NOT_FOUND
ESIGN_ONBOARDING_CUSTOMER_NOT_ELIGIBLE
ESIGN_ONBOARDING_ALREADY_SIGNING_ENABLED
ESIGN_ONBOARDING_PROVIDER_ACCOUNT_REQUIRED
ESIGN_ONBOARDING_PROVIDER_ACCOUNT_CONFLICT
ESIGN_ONBOARDING_PROVIDER_REGISTER_DISABLED
ESIGN_ONBOARDING_REALNAME_VERIFY_DISABLED
ESIGN_ONBOARDING_REALNAME_NOT_VERIFIED
ESIGN_ONBOARDING_CERT_APPLY_REQUIRED
ESIGN_ONBOARDING_STEP_NOT_ALLOWED
ESIGN_ONBOARDING_IDEMPOTENCY_CONFLICT
ESIGN_ONBOARDING_RATE_LIMITED
```

C3 should translate lower-level C1/C2 errors into workflow-level errors while preserving sanitized `lastErrorCode` for support.

## Idempotency And Retry Model

All mutating onboarding endpoints should accept:

```text
Idempotency-Key: <client-generated-key>
```

MVP idempotency can be state-derived:

```text
start:
  if binding already exists, return current status

register-provider:
  if already REGISTERED with providerCustomerId, return current status
  if FAILED, require retry endpoint or explicit force policy

verify:
  if realNameStatus=PENDING and verification refs exist, return current pending status
  if VERIFIED, return SIGNING_ENABLED / VERIFIED status without provider call

apply-cert:
  if already VERIFIED and cert apply has no separate persisted marker, return current status unless C2 requires a provider-side reconcile

retry:
  allowed only from FAILED / PENDING / EXPIRED-equivalent states
  forbidden from SIGNING_ENABLED unless operation is STATUS_REFRESH
```

If product or mobile clients need strict replay semantics, C3-C can add an idempotency persistence layer. Until then, state-derived idempotency keeps the first implementation migration-free.

Retry policy:

```text
provider timeout:
  do not advance state
  store sanitized last error through C1/C2 service
  allow explicit retry

real-name pending:
  keep REALNAME_PENDING
  expose status refresh action
  do not auto-upgrade

duplicate callback:
  C2 remains idempotent
  C3 status derives latest account state

manual recovery:
  admin-only
  audited
  never available to Portal
```

## Failure Recovery Strategy

### Registration Timeout

State:

```text
ONBOARDING or FAILED
```

Recovery:

```text
admin retry register-provider
no duplicate provider account overwrite
providerCustomerId conflicts fail closed
```

### Real-Name URL Generated But User Does Not Complete

State:

```text
REALNAME_PENDING
```

Recovery:

```text
status refresh
new verify request if provider transaction expired
no signing until VERIFIED
```

### Verify Callback Delayed

State:

```text
REALNAME_PENDING
```

Recovery:

```text
status refresh calls C2 provider status query when gate enabled
callback remains idempotent when it arrives later
```

### Provider Returns FAILED / EXPIRED

State:

```text
FAILED or ACCOUNT_CREATED with retry action
```

Recovery:

```text
admin or portal retry verify depending on policy
do not downgrade VERIFIED
do not sign
```

### Manual Attach / Manual VERIFIED Needed

State:

```text
admin recovery path only
```

Recovery:

```text
use C1/C2 audited admin methods
capture masked before/after snapshots
optionally require production two-person approval outside code
```

## Audit And Observability Model

C3 should emit audit entries for workflow actions:

```text
esign.onboarding.start
esign.onboarding.register_provider
esign.onboarding.verify_start
esign.onboarding.apply_cert
esign.onboarding.retry
esign.onboarding.status_refresh
esign.onboarding.manual_recovery_requested
```

Audit payload should include:

```text
actor id
actor type
customer id masked or internal id reference according to existing audit policy
provider
accountType
previous derived state
next derived state
registrationStatus before/after
realNameStatus before/after
lastErrorCode
idempotencyKey hash
timestamp
request source: admin / portal / system
```

Audit payload must not include:

```text
real name
mobile number
ID card number
full provider customer id
full provider open id if sensitive
full verify URL
provider raw response
app secret
PDF binary
```

Operational logs should use correlation identifiers:

```text
onboardingRequestId
providerAccountId
verificationTransactionNo masked
```

Metrics to add later:

```text
onboarding started count
provider registration success/failure count
real-name pending duration
real-name success/failure count
apply_cert success/failure count
signing-enabled count
```

## Production Guardrails

C3 should become the product-facing onboarding entry. Direct C1/C2 endpoints should remain restricted recovery or internal orchestration surfaces.

Guardrails:

```text
Portal can only use C3 endpoints.
Admin UI should prefer C3 workflow endpoints.
Manual attach remains admin-only and audited.
Manual VERIFIED remains admin override only and audited.
Normal onboarding cannot write VERIFIED directly.
Provider registration and real-name provider calls remain env-gated.
Production signing resolver remains binding-only.
Smoke override remains rejected in production.
C3 must never add a test-customer fallback.
C3 must never trigger createSignTask.
```

The implementation should avoid a hard deletion of C1/C2 admin endpoints in C3-C. Those endpoints are still useful for controlled support operations. Instead, product UI and Portal flows should route through C3, while low-level recovery endpoints stay permissioned and audited.

## Risk Analysis

### Bypass Into C1/C2

Risk:

```text
product UI or operator workflow calls low-level C1/C2 endpoints and skips onboarding policy.
```

Mitigation:

```text
route Portal and normal Admin UI through C3
keep low-level endpoints admin-only
audit manual/recovery paths
document C3 as product-facing contract
```

### Provider Customer Reference Leakage

Risk:

```text
provider account references leak through API, audit, logs, or docs.
```

Mitigation:

```text
masked response DTOs
masked audit snapshots
no raw provider snapshot in C3 responses
tests assert no full provider identifiers in response fixtures
```

### VERIFIED Mis-Upgrade

Risk:

```text
bug or operator action marks customer VERIFIED without provider authority.
```

Mitigation:

```text
normal C3 flow never calls manual status override
C2 callback/status refresh owns automatic VERIFIED
manual override admin-only and audited
production policy can require approval outside code
```

### Idempotency Replay

Risk:

```text
replayed mutating requests duplicate provider calls or create conflicting states.
```

Mitigation:

```text
state-derived idempotency in MVP
Idempotency-Key accepted for future strict replay persistence
duplicate REGISTERED / VERIFIED states return current status
explicit retry required from FAILED states
```

### Callback Spoofing

Risk:

```text
fake verify callback attempts to mark an account VERIFIED.
```

Mitigation:

```text
C2 verifies digest before lookup/update
invalid callback returns handled=false / UNVERIFIED
callback never touches Contract / Order / Payment
C3 only reads derived state
```

### PII Retention

Risk:

```text
real-name request fields are accidentally stored.
```

Mitigation:

```text
request-only DTO fields
no provider raw response in C3
masked audit
tests for sanitized response/log fixtures
```

### Pending Forever

Risk:

```text
customers stay REALNAME_PENDING without operator visibility.
```

Mitigation:

```text
status endpoint exposes pending state
support view can filter pending duration
status refresh / retry action
future metric on pending age
```

## Relation To C2 System

C2 remains the lifecycle engine:

```text
account_register
get_person_verify_url
verify callback
status refresh
apply_cert
resolver readiness
```

C3 adds product workflow:

```text
eligibility
state explanation
workflow sequencing
portal/admin surface
retry policy
audit and observability
```

C3-C should not rewrite C2. It should compose C2 through service boundaries and add product-safe APIs.

## Migration Impact Assessment

C3-C MVP can be implemented without a new migration if:

```text
onboarding state is derived from CustomerESignProviderAccount
audit uses the existing audit log mechanism
idempotency is state-derived
```

Potential future migrations:

```text
CustomerESignOnboardingEvent
CustomerESignOnboardingIdempotencyKey
```

These are not required for the first implementation unless product requirements demand strict replay history or a dedicated onboarding event stream.

No production migration should be executed as part of C3-B.

## C3-C Implementation Readiness

The system is ready for C3-C implementation if the following decisions are accepted:

```text
1. C3 state is derived from CustomerESignProviderAccount for MVP.
2. C3 is the product-facing onboarding API.
3. C1/C2 direct endpoints remain admin/internal recovery surfaces only.
4. Portal has no manual attach or manual VERIFIED override.
5. Provider registration and real-name calls remain env-gated.
6. Production signing remains REGISTERED + VERIFIED binding-only.
7. Strict replay persistence is deferred unless product clients require it.
```

Recommended C3-C scope:

```text
service + policy + state resolver
admin status/start/register/verify/apply-cert/retry endpoints
portal status/start/verify endpoints only if self-onboarding is approved
tests for state derivation, permissions, idempotency, retry, and PII masking
docs update
no production deploy
no real Fadada integration test until separately approved
```

C3-C MVP implementation result:

```text
docs/stage-10d-c3-fadada-onboarding-orchestration-mvp.md
```

The first implementation intentionally keeps the scope smaller than the full blueprint:

```text
admin status/start/retry endpoints only
derived state only
existing audit_log only
REALNAME_VERIFY retry is mock/control-plane only
no provider registration call
no real-name provider call
no schema migration
```

Unrestricted production e-sign remains **No-Go** until C3-C implementation, limited-cohort real-name onboarding validation, and operational approval are complete.
