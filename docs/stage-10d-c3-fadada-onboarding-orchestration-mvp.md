# Stage 10D-C3-C Fadada Onboarding Orchestration MVP

Stage 10D-C3-C implements the minimal control-plane onboarding orchestration layer described in C3-A/C3-B.

This stage does not call Fadada, does not generate or open sign URLs, does not sign, does not upload contracts, does not advance Contract / Order, does not touch payment logic, does not add schema, does not add migrations, and does not deploy production.

## Implementation Summary

Implemented files:

```text
apps/api/src/esign/customer-esign-onboarding.service.ts
apps/api/src/esign/customer-esign-onboarding.controller.ts
apps/api/src/esign/customer-esign-onboarding.dto.ts
apps/api/test/customer-esign-onboarding.spec.ts
```

Updated module wiring:

```text
apps/api/src/esign/esign.module.ts
```

The MVP exposes a product-facing orchestration layer while keeping C1/C2 as lower-level mechanics.

## Service Structure

`CustomerESignOnboardingService` includes:

```text
getOnboardingStatus(customerId)
startOnboarding(customerId, actorId?)
retryOnboarding(customerId, input, actorId?)
triggerRealNameFlow(customerId, actorId?)
evaluateEligibility(account)
resolveState(account)
```

`startOnboarding` calls only:

```text
CustomerESignProviderAccountService.ensureFadadaPersonalPendingBinding
```

It does not call:

```text
registerFadadaPersonalAccount
startFadadaPersonalRealNameVerification
refreshFadadaRealNameStatus
applyFadadaPersonalCert
createSignTask
```

## State Machine Implementation

The MVP derives state from the existing `CustomerESignProviderAccount` view.

Implemented states:

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

Current derivation:

```text
no binding
-> NOT_STARTED

registrationStatus=PENDING
-> ONBOARDING

registrationStatus=REGISTERED
providerCustomerId present
realNameStatus=UNVERIFIED
-> ACCOUNT_CREATED

registrationStatus=REGISTERED
providerCustomerId present
realNameStatus=PENDING
-> REALNAME_PENDING

registrationStatus=REGISTERED
providerCustomerId present
realNameStatus=VERIFIED
-> SIGNING_ENABLED

registrationStatus=FAILED
or realNameStatus=FAILED / EXPIRED
-> FAILED

registrationStatus=DISABLED
or eligibility fails
-> DISABLED
```

`SIGNING_ENABLED` remains a derived policy result, not a persisted state.

## API Routes

Admin/internal API routes added:

```text
GET  /api/customers/:id/esign-onboarding/status
POST /api/customers/:id/esign-onboarding/start
POST /api/customers/:id/esign-onboarding/retry
```

Permissions:

```text
status: customer:view
start/retry: customer:manage
```

Portal onboarding endpoints are not added in this MVP.

## C3 To C2 Boundary

C3-C composes C1/C2 but does not trigger provider-side real-name or signing operations.

`retryOnboarding(..., step=REALNAME_VERIFY)` is explicitly mock/control-plane only:

```json
{
  "realNameFlow": {
    "mockOnly": true,
    "providerCallExecuted": false
  }
}
```

This verifies the C3 entry point shape without invoking:

```text
get_person_verify_url.api
find_personCertInfo.api
apply_cert.api
uploaddocs.api
extsign_validation.api
extsign_auto.api
```

## Audit Model

The MVP uses the existing `AuditService` / `audit_log` mechanism. No new `onboarding_event_log` table is added because this stage explicitly forbids schema changes and migrations.

Audit events:

```text
esign.onboarding.start
esign.onboarding.realname_mock
```

Audit entity:

```text
entityType=customer_esign_onboarding
module=esign
```

Payloads include:

```text
masked customerId
state
nextAction
registrationStatus
realNameStatus
masked providerOpenId / providerCustomerId
actor
timestamp from audit_log
```

Payloads do not include:

```text
full customer id
full provider customer id
real name
mobile
ID card number
provider raw response
verify URL
app secret
signUrl
PDF binary
```

## Safety Boundary

Stage 10D-C3-C does not:

```text
call real Fadada APIs
call real-name provider APIs
generate signUrl
create ContractESignTask
upload contract PDFs
open signUrl
sign
advance Contract / Order
archive signed PDFs
create PaymentRecord
create PaymentWriteOff
mutate ReceivableBill
modify schema
add migration
run seed
deploy production
```

## Test Coverage

Added targeted tests:

```text
NOT_STARTED status does not create binding or call provider mechanics
startOnboarding creates/returns pending binding and writes masked audit
REGISTERED + VERIFIED binding derives SIGNING_ENABLED
REALNAME_VERIFY retry is mock-only and does not invoke C2 provider methods
controller methods delegate to service with actor id
```

Verification executed:

```text
pnpm --filter @subscription-saas/api exec vitest run test/customer-esign-onboarding.spec.ts
pnpm prisma:validate
pnpm -r lint
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/api test
```

Result:

```text
targeted onboarding tests: 5 passed
Prisma schema validate: passed
workspace lint: passed
API typecheck: passed
API tests: 64 files / 864 tests passed
```

`pnpm release:check` was also attempted. It passed validate, generate, script syntax/tests, lint, API typecheck, Web typecheck, and API tests, then stopped at local `prisma migrate status` with a Prisma schema engine error against the local configured database. No production database was touched, and this stage did not add a migration.

## Migration Impact

Migration impact:

```text
new migration: no
schema change: no
production DB change: no
```

The MVP keeps onboarding state derived from `CustomerESignProviderAccount`.

Future optional migrations remain:

```text
CustomerESignOnboardingEvent
CustomerESignOnboardingIdempotencyKey
```

They are not required for this control-plane MVP.

## Risk Assessment

### Signing Chain Trigger

Risk:

```text
C3 start/retry accidentally invokes createSignTask or provider signing APIs.
```

Current result:

```text
not triggered
```

The MVP service has no dependency on `ESignService` or Fadada signing provider classes.

### C2 External Provider Trigger

Risk:

```text
C3 real-name retry calls get_person_verify_url or apply_cert.
```

Current result:

```text
not triggered
```

The real-name retry path is mock/control-plane only and returns `providerCallExecuted=false`.

### PII Leakage

Risk:

```text
customer/provider identifiers leak through status or audit payloads.
```

Current mitigation:

```text
status DTO masks customerId, providerOpenId, and providerCustomerId
audit payloads use masked status DTOs
tests assert full identifiers are absent from response/audit fixtures
```

### Bypass Into C1/C2

Risk:

```text
future product UI calls lower-level C1/C2 endpoints directly.
```

Current mitigation:

```text
C3 product-facing status/start/retry endpoints exist
C1/C2 remain admin/recovery surfaces
Portal endpoints are intentionally deferred until self-onboarding policy is approved
```

## C3-D Readiness

The system is ready for Stage 10D-C3-D integration wiring if the following are accepted:

```text
1. C3-C MVP remains control-plane only.
2. Real Fadada registration / real-name APIs remain disabled unless separately approved.
3. Portal onboarding is still deferred.
4. C3-D can wire controlled provider registration / real-name calls behind existing env gates.
5. C3-D must keep signing separate from onboarding.
```

Unrestricted production e-sign remains **No-Go** until C3 onboarding is wired, validated with a controlled customer, and operational approval is granted.
