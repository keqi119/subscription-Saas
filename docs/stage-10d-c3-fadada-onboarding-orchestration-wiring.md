# Stage 10D-C3-D Fadada Onboarding Orchestration Integration Wiring

Stage 10D-C3-D wires the C3 onboarding orchestration layer to the C1/C2 service boundaries while keeping external provider calls and signing disabled by default.

This stage does not call Fadada, does not generate sign URLs, does not upload contracts, does not sign, does not advance Contract / Order, does not touch payment logic, does not add schema, does not add migrations, and does not deploy production.

## Integration Architecture

Implemented integration path:

```text
CustomerESignOnboardingController
-> CustomerESignOnboardingService
-> CustomerESignProviderAccountService
   -> C1 binding read / pending binding creation
   -> C2 real-name lifecycle service methods
```

C3 remains an orchestration layer:

```text
C3 owns: API entry, workflow sequencing, derived onboarding state, audit, guardrails
C2 owns: real-name verify URL, callback/status lifecycle, apply_cert
C1 owns: provider account binding source of truth
```

C3 still has no dependency on:

```text
ESignService
FadadaESignProvider
uploadDocs
extsign_validation
signUrl generation
archive/download services
payment services
```

## Wiring Strategy

Stage C3-C had a mock-only `REALNAME_VERIFY` retry.

Stage C3-D adds a real C3 -> C2 method:

```text
CustomerESignOnboardingService.startRealNameVerification(customerId, input, actorId)
```

It calls:

```text
CustomerESignProviderAccountService.startFadadaPersonalRealNameVerification(customerId, input, actorId)
```

The route added in C3-C is extended with:

```text
POST /api/customers/:id/esign-onboarding/verify
```

This endpoint requires:

```text
customer:manage
```

The request includes real-name fields as request-only data:

```text
name
mobile
idCardNo
```

The C3 response does not return those values.

## Runtime Gates

C3-D adds explicit separation between real wiring and mock retry behavior.

### C2 wiring gate

```env
FADADA_ONBOARDING_REALNAME_C2_ENABLED=false
```

Default behavior:

```text
startRealNameVerification -> ESIGN_ONBOARDING_REALNAME_C2_DISABLED
```

When enabled, C3 invokes the C2 service boundary. C2 still controls provider calls through its own gate:

```env
FADADA_REALNAME_VERIFY_ENABLED=false
```

Therefore C3-D can be wired to C2 without enabling external provider traffic by default.

### Test-only mock gate

```env
NODE_ENV=test
FADADA_ONBOARDING_MOCK_REALNAME_ENABLED=true
```

Only under those conditions can `retryOnboarding(step=REALNAME_VERIFY)` return the mock/control-plane real-name response.

Production behavior:

```text
NODE_ENV=production
FADADA_ONBOARDING_MOCK_REALNAME_ENABLED=true
-> ESIGN_ONBOARDING_REALNAME_INPUT_REQUIRED
```

Production never uses mock onboarding as a fallback.

## State Derivation Model

C3 status remains derived from C1/C2 data:

```text
CustomerESignProviderAccount.registrationStatus
CustomerESignProviderAccount.realNameStatus
CustomerESignProviderAccount.providerCustomerId
CustomerESignProviderAccount.deletedAt
eligibility policy
```

C3 does not persist a duplicate onboarding state.

Real-name C2 invocation returns a C2 account view. C3 immediately derives onboarding status from that returned binding:

```text
C2 account.realNameStatus=PENDING
-> C3 state=REALNAME_PENDING
-> nextAction=WAIT_REALNAME_CALLBACK
```

`SIGNING_ENABLED` remains derived from:

```text
registrationStatus=REGISTERED
realNameStatus=VERIFIED
providerCustomerId present
eligibility pass
```

## Service Coupling Design

C3 calls C1/C2 through `CustomerESignProviderAccountService` only.

Allowed C3 -> C1/C2 calls:

```text
getFadadaPersonalBinding
ensureFadadaPersonalPendingBinding
startFadadaPersonalRealNameVerification
```

Not called by C3-D:

```text
registerFadadaPersonalAccount
refreshFadadaRealNameStatus
applyFadadaPersonalCert
ESignService.createSignTask
```

This keeps C3-D scoped to wiring and state derivation. Provider registration, status refresh, and apply_cert remain later integration decisions.

## Audit Expansion

C3-D writes an audit entry for C3 -> C2 real-name invocation:

```text
event=esign.onboarding.c2.realname_start
entityType=customer_esign_onboarding
module=esign
action=UPDATE
```

The audit entry includes masked previous/next onboarding state.

Audit payloads do not include:

```text
real name
mobile number
ID card number
full provider customer id
full provider open id
verify URL
provider raw response
app secret
signUrl
PDF binary
```

## Risk Analysis

### Can C3-D Trigger Signing?

No.

The implementation does not depend on `ESignService`, Fadada signing provider, upload/sign URL services, archive services, contract services, order services, or payment services.

### Can C3-D Trigger External Fadada Calls?

Not by default.

C3 requires:

```text
FADADA_ONBOARDING_REALNAME_C2_ENABLED=true
```

Then C2 still requires:

```text
FADADA_REALNAME_VERIFY_ENABLED=true
```

This stage did not enable those flags or run any external provider call.

### Can C3-D Bypass C2?

No.

C3 does not mutate `realNameStatus` directly. It delegates real-name start to the C2 service method and derives state from the returned account view.

### Can C3-D Corrupt VERIFIED State?

No normal path writes `VERIFIED`.

`VERIFIED` remains controlled by C2 callback/status refresh or audited admin override from C1/C2 recovery paths.

### Is State Duplication Eliminated?

Yes for this MVP.

C3 does not add an onboarding status table. It derives state from `CustomerESignProviderAccount`.

## Test Strategy

Added / updated targeted tests:

```text
C3 startRealNameVerification calls C2 service boundary and derives REALNAME_PENDING
C3 real-name C2 wiring is disabled unless FADADA_ONBOARDING_REALNAME_C2_ENABLED=true
production rejects mock REALNAME_VERIFY retry even if mock flag is set
test-mode mock REALNAME_VERIFY remains available only with explicit flag
controller maps /verify to service.startRealNameVerification
```

The tests use mocked C1/C2 services and do not make Fadada HTTP calls.

Verification executed:

```text
pnpm --filter @subscription-saas/api exec vitest run test/customer-esign-onboarding.spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm -r lint
pnpm --filter @subscription-saas/api test
pnpm prisma:validate
pnpm release:check
```

Result:

```text
targeted onboarding tests: 8 passed
API typecheck: passed
workspace lint: passed
API tests: 64 files / 867 tests passed
Prisma schema validate: passed
```

`pnpm release:check` passed validate, generate, script syntax/tests, lint, API typecheck, Web typecheck, and API tests, then stopped at local `prisma migrate status` with the same Prisma schema engine error observed in C3-C against the local configured database. This stage adds no migration and does not touch production DB.

## Migration Impact

```text
schema change: no
new migration: no
production DB change: no
seed: no
```

## Stage 10D-C3-E Readiness

The system is ready for Stage 10D-C3-E production activation wiring if the following are accepted:

```text
1. C3 has a real C2 service wiring point.
2. C3 real-name wiring is disabled by default.
3. Mock onboarding is test-only and cannot be used in production.
4. C3 state remains derived from C1/C2 source-of-truth fields.
5. C3 still does not trigger signing or payment side effects.
```

Recommended C3-E scope:

```text
define controlled activation env values
run C3 -> C2 real-name start against a controlled non-production/mock transport
verify callback/status refresh integration
keep signing separate
no production launch until separate approval
```

Unrestricted production e-sign remains **No-Go**.
