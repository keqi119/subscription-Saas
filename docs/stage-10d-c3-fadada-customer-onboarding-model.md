# Stage 10D-C3-A Fadada Customer Onboarding Model Design

Stage 10D-C3-A designs the customer onboarding / activation model for the production Fadada signing system.

This stage is design-only. It does not implement code, modify schema, add migrations, call Fadada, create contracts/orders, generate sign URLs, trigger signing, or use real customer data.

## Background

Completed foundation:

```text
B5-B: full Fadada signing execution passed
C1-A: CustomerESignProviderAccount binding model
C2: real-name lifecycle automation
C2-B: mocked real-name integration boundary passed
C2-C: production signing gate hardened
```

Production signing is now single-path:

```text
REGISTERED + VERIFIED CustomerESignProviderAccount
```

The remaining gap is an explicit customer onboarding model that moves eligible customers into that state safely and audibly.

## Onboarding Architecture

The C3 onboarding system should orchestrate, not replace, the C1/C2 primitives:

```text
Customer
-> Onboarding eligibility check
-> CustomerESignProviderAccount init
-> provider account registration
-> real-name verification URL
-> verify callback / status refresh
-> apply_cert
-> signing readiness
```

Recommended components:

```text
CustomerESignOnboardingService
CustomerESignOnboardingController
CustomerESignOnboardingPolicy
CustomerESignOnboardingAudit
```

The service should call existing C1/C2 APIs internally:

```text
ensureFadadaPersonalPendingBinding
registerFadadaPersonalAccount
startFadadaPersonalRealNameVerification
handleFadadaVerifyCallback / refreshFadadaRealNameStatus
applyFadadaPersonalCert
```

No signing should be triggered by onboarding. Signing remains a separate contract workflow that checks resolver eligibility.

## State Machine Design

C3 should introduce an onboarding-facing state derived from the provider account fields. A separate table is optional for implementation, but the state contract should be stable.

Draft states:

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

Mapping to existing fields:

```text
NOT_STARTED
  no CustomerESignProviderAccount

ONBOARDING
  provider account row created
  registrationStatus=PENDING
  realNameStatus=UNVERIFIED

ACCOUNT_CREATED
  registrationStatus=REGISTERED
  providerCustomerId present
  realNameStatus=UNVERIFIED

REALNAME_PENDING
  registrationStatus=REGISTERED
  providerCustomerId present
  realNameStatus=PENDING
  verificationSerialNo / verificationTransactionNo present

VERIFIED
  registrationStatus=REGISTERED
  providerCustomerId present
  realNameStatus=VERIFIED

SIGNING_ENABLED
  same as VERIFIED plus policy checks pass
  customer/account not disabled
  provider account not deleted
  production resolver can use binding

FAILED
  registrationStatus=FAILED or realNameStatus=FAILED

DISABLED
  provider account disabled/deleted or customer not eligible
```

Allowed transitions:

```text
NOT_STARTED -> ONBOARDING
ONBOARDING -> ACCOUNT_CREATED
ACCOUNT_CREATED -> REALNAME_PENDING
REALNAME_PENDING -> VERIFIED
VERIFIED -> SIGNING_ENABLED
ONBOARDING -> FAILED
ACCOUNT_CREATED -> FAILED
REALNAME_PENDING -> FAILED
REALNAME_PENDING -> EXPIRED-equivalent retry path
FAILED -> ONBOARDING only by explicit retry
SIGNING_ENABLED -> DISABLED only by explicit admin action / customer eligibility change
```

`VERIFIED` remains provider-account state. `SIGNING_ENABLED` is a policy result, not a field that should silently override real-name status.

## Eligibility Policy

Only eligible customers should enter onboarding.

Recommended eligibility:

```text
Customer exists
Customer is not deleted
Customer status allows contracting
Customer account is active
Customer type is supported by current provider flow
No conflicting Fadada PERSONAL binding
No existing disabled provider account without admin review
Required customer contact fields present for provider request
Operator has customer:manage or customer onboarding permission
```

For self-service customer-initiated onboarding, the policy should additionally require:

```text
current portal customer owns the Customer
customer account is active
rate limit / idempotency key
no admin-only manual attach
```

Enterprise signing should remain out of scope until an enterprise account binding model is designed.

## API Design Draft

The prompt uses `/customer/onboarding/*`. To stay consistent with existing API style, C3 implementation can expose admin and portal variants under the project conventions.

### Admin API

```text
POST /api/customers/:id/esign-onboarding/start
POST /api/customers/:id/esign-onboarding/register-provider
POST /api/customers/:id/esign-onboarding/verify
POST /api/customers/:id/esign-onboarding/apply-cert
GET  /api/customers/:id/esign-onboarding/status
```

Permissions:

```text
read: customer:view
write: customer:manage
```

### Portal API

```text
POST /api/portal/esign-onboarding/start
POST /api/portal/esign-onboarding/verify
GET  /api/portal/esign-onboarding/status
```

Portal API should not expose manual attach or manual status override.

### Endpoint Semantics

`POST /start`

```text
Checks eligibility.
Creates or returns a pending CustomerESignProviderAccount.
Does not call Fadada by default unless register-provider is part of an approved workflow.
Returns onboarding status and masked provider references.
```

`POST /register-provider`

```text
Requires explicit provider registration gate.
Calls account_register through C1 service.
Creates providerCustomerId on success.
Does not start signing.
```

`POST /verify`

```text
Requires REGISTERED provider account.
Calls get_person_verify_url through C2 service.
Returns masked verify URL or a short-lived redirect wrapper.
Does not store PII.
Does not mark VERIFIED directly.
```

`POST /apply-cert`

```text
Requires realNameStatus=VERIFIED.
Calls apply_cert through C2 service.
Returns updated onboarding status.
Does not sign.
```

`GET /status`

```text
Returns derived onboarding state.
Returns masked provider identifiers.
Does not return provider raw response or PII.
```

## Verification Authority Chain

The production authority chain should be:

```text
Provider verify callback
or provider status query
-> realNameStatus=VERIFIED
-> apply_cert success
-> derived SIGNING_ENABLED
```

Manual attach and manual real-name status override remain admin recovery paths only:

```text
admin permission required
audit required
masked before/after snapshots
no silent promotion from portal/customer
operational policy approval required in production
```

The normal onboarding path should never call `markRealNameStatus(VERIFIED)` directly.

## Signing Eligibility Gating

Signing should remain separated from onboarding.

`createSignTask` can proceed only if resolver finds:

```text
CustomerESignProviderAccount
provider=FADADA
accountType=PERSONAL
registrationStatus=REGISTERED
realNameStatus=VERIFIED
providerCustomerId present
```

Production-specific invariant:

```text
FADADA_ENV=production
-> smoke override rejected
-> no fallback provider customer id
```

C3 should add a status endpoint that explains readiness without leaking identifiers:

```json
{
  "state": "SIGNING_ENABLED",
  "provider": "FADADA",
  "accountType": "PERSONAL",
  "registrationStatus": "REGISTERED",
  "realNameStatus": "VERIFIED",
  "providerCustomerId": "fadad...1234"
}
```

## Security Model

### Who Can Start Onboarding

Admin flow:

```text
customer:manage
customer must be eligible
operation audited
```

Portal flow:

```text
authenticated current customer only
active customer account
customer owns target profile
no manual attach
no manual VERIFIED override
rate-limited
```

### Prevent Unauthorized VERIFIED

Rules:

```text
Portal never marks VERIFIED.
Admin onboarding flow never marks VERIFIED directly.
Only C2 callback/status refresh can set VERIFIED in normal flow.
Manual VERIFIED is admin override only and audited.
VERIFIED cannot be downgraded by later failed/expired callback.
```

### Avoid Manual Attach Abuse

Controls:

```text
customer:manage permission
audit log with before/after masked snapshots
reject providerCustomerId conflicts
do not expose full providerCustomerId in responses
optional two-person approval for production manual VERIFIED
manual attach unavailable in portal API
```

### Prevent Smoke Override Regression

Controls already in C2-C:

```text
FADADA_ENV=production rejects FADADA_FULL_SIGNING_SMOKE
production signing is binding-only
tests cover production smoke rejection
```

C3 should preserve that invariant and never add onboarding fallback to test env customer IDs.

## Risk Analysis

### Provider Customer ID Leakage

Risk:

```text
providerCustomerId could be treated as sensitive provider account reference.
```

Mitigation:

```text
store only in binding table
mask in API responses
mask in audit snapshots
do not commit real ids in docs/tests
do not include full id in logs
```

### VERIFIED Mis-Upgrade

Risk:

```text
operator or bug marks customer VERIFIED without provider verification.
```

Mitigation:

```text
normal onboarding cannot call manual VERIFIED
manual override audited
production policy can require approval
status endpoint exposes source/lastUpdatedBy if implemented
tests assert callback/status path
```

### Smoke Override Residual Risk

Risk:

```text
test fallback re-enters production signing.
```

Mitigation:

```text
C2-C hard reject in production
documentation labels smoke as non-production only
release tests cover production smoke rejection
production env keeps FADADA_FULL_SIGNING_SMOKE=0
```

### Callback Spoofing

Risk:

```text
attacker posts fake verify callback to mark account VERIFIED.
```

Mitigation:

```text
digest verification before lookup/update
invalid digest returns handled=false / UNVERIFIED
callback updates only provider account state
no Contract / Order advancement
idempotency with terminal VERIFIED rule
status refresh can reconcile provider truth
```

### PII Retention

Risk:

```text
name, mobile, or ID card fields leak into provider snapshot, audit, logs, or docs.
```

Mitigation:

```text
request-only DTO fields
sanitized provider snapshots
masked audit
no full verify URL stored/returned
tests assert PII absence
```

## Relation To C2 System

C2 provides mechanics:

```text
provider account binding
verify URL
verify callback
status refresh
apply_cert
resolver readiness
```

C3 adds orchestration and policy:

```text
who can start
when provider registration is allowed
how state is exposed
how retry works
how manual override is governed
when signing readiness is visible
```

C3 should not duplicate C2 logic. It should compose the C2 service methods and expose a workflow-level contract.

## Transition Plan From C2 To C3

1. Add derived onboarding status service.
2. Add admin status endpoint for internal visibility.
3. Add admin start/register/verify/apply-cert orchestration endpoints.
4. Add portal status/start/verify endpoints if customer self-onboarding is approved.
5. Add rate limiting and idempotency for portal initiation.
6. Add production policy for manual override approval.
7. Add operational runbook for support teams.
8. Run controlled production real-name onboarding test for one tester.
9. Only after success, consider opening onboarding to a limited customer cohort.

## C3-B Implementation Readiness

The system is ready for C3-B implementation design if the following are accepted:

```text
onboarding state is derived from CustomerESignProviderAccount for the first implementation
portal flow excludes manual attach and manual VERIFIED override
provider registration and real-name provider calls remain gated
production signing remains binding-only
```

C3-B implementation blueprint:

```text
docs/stage-10d-c3-fadada-onboarding-orchestration-implementation-plan.md
```

Stage 10D-C3-B keeps C3 as the product-facing onboarding layer while C1/C2 remain lower-level binding and real-name mechanics. The first C3-C implementation can remain migration-free if it derives onboarding state from `CustomerESignProviderAccount`, uses existing audit infrastructure, and keeps idempotency state-derived.

Unrestricted production e-sign remains **No-Go** until C3 onboarding controls, operational policy, and limited-cohort validation are complete.
