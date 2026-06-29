# Stage 10D-C3-F Fadada Onboarding Runtime Validation

Stage 10D-C3-F validates the customer onboarding runtime paths after product entry wiring.

This stage is validation-only. It does not add product features, does not call Fadada, does not generate sign URLs, does not upload contracts, does not sign, does not mutate Contract / Order business state, does not touch payment logic, does not add schema, does not add migrations, and does not deploy production.

## Validation Target

Validated runtime path:

```text
Order / Portal / Admin
-> CustomerESignOnboardingService
-> C2 real-name service boundary
-> C1 provider binding source-of-truth fields
```

This validates the control plane only. The signing engine remains separate:

```text
onboarding runtime validation != createSignTask
onboarding runtime validation != uploadDocs
onboarding runtime validation != extsign_validation
onboarding runtime validation != callback/archive/payment
```

## Entry Path Validation

### Admin

Validated admin source:

```text
customers/:id/esign-onboarding/start
customers/:id/esign-onboarding/retry
customers/:id/esign-onboarding/verify
customers/:id/esign-onboarding/status
source=ADMIN
```

Result:

```text
admin start/retry/status paths call CustomerESignOnboardingService
source=ADMIN is written to onboarding audit payload
no signing path is invoked
```

### Order

Validated order source:

```text
orders/:id/esign-onboarding/start
source=ORDER
```

Result:

```text
order entry reads SubscriptionOrder.id/customerId only
order entry delegates to startOnboarding(customerId)
source=ORDER is written to onboarding audit payload
no SubscriptionOrder update/updateMany is invoked
```

### Portal

Validated portal source:

```text
portal/esign-onboarding/status
source=PORTAL
```

Result:

```text
portal entry returns derived onboarding status for authenticated customer
source=PORTAL is written to onboarding audit payload
portal status does not start onboarding
portal status does not trigger real-name verification
portal status does not trigger signing
```

## State Consistency

C3 state remains derived from C1/C2 fields:

```text
CustomerESignProviderAccount.registrationStatus
CustomerESignProviderAccount.realNameStatus
CustomerESignProviderAccount.providerCustomerId
eligibility policy
```

Validated mapping:

```text
no binding                                  -> NOT_STARTED
PENDING + UNVERIFIED                       -> ONBOARDING
REGISTERED + customer_id + UNVERIFIED      -> ACCOUNT_CREATED
REGISTERED + customer_id + PENDING         -> REALNAME_PENDING
REGISTERED + customer_id + VERIFIED        -> SIGNING_ENABLED
DISABLED                                   -> DISABLED
```

No duplicate onboarding state table is introduced.

## C3 -> C2 -> C1 Integrity

Validated C3 real-name boundary:

```text
CustomerESignOnboardingService.startRealNameVerification
-> CustomerESignProviderAccountService.startFadadaPersonalRealNameVerification
-> returned CustomerESignProviderAccountView
-> derived C3 state
```

Result:

```text
C2 service boundary is invoked only when FADADA_ONBOARDING_REALNAME_C2_ENABLED=true
providerCallExecuted=false in the C3 validation response
mockOnly=false for the real C2 boundary
state=REALNAME_PENDING after C2 returns PENDING
```

This validation uses mocked C1/C2 services and does not call a real Fadada API.

## Side-effect Validation

Validated as not called:

```text
ESignService.createSignTask
uploadDocs
extsign_validation
SubscriptionOrder.update
SubscriptionOrder.updateMany
Contract.update
Contract.updateMany
PaymentRecord.create
PaymentWriteOff.create
ReceivableBill.update
ReceivableBill.updateMany
applyFadadaPersonalCert
```

The validation also confirms:

```text
no signUrl generated
no signing triggered
no contract/order advancement
no payment creation
no receivable write-off
no archive/download action
```

## Audit Validation

Validated audit sources:

```text
ADMIN
ORDER
PORTAL
```

Validated masked boundaries:

```text
full customer id: not present
full provider customer id: not present
mobile number: not present
real name: not present
ID card number: not present
```

Audit payloads contain only masked customer/provider identifiers and derived onboarding status.

## Verification Commands

Executed:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/customer-esign-onboarding-runtime-validation.spec.ts
pnpm --filter @subscription-saas/api exec vitest run test/customer-esign-onboarding.spec.ts test/customer-esign-onboarding-runtime-validation.spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm prisma:validate
pnpm -r lint
pnpm --filter @subscription-saas/api test
pnpm release:check
```

Result:

```text
C3-F runtime validation spec: 1 file / 4 tests passed
Onboarding targeted specs: 2 files / 16 tests passed
API typecheck: passed
Prisma schema validate: passed
Workspace lint: passed
API tests: 65 files / 875 tests passed
```

`pnpm release:check` passed Prisma validate/generate, vehicle/model snapshot script checks, workspace lint, API typecheck, Web typecheck, and API tests. It then stopped at local `prisma migrate status` with a Prisma schema engine error against the local configured database. This stage adds no migration and does not touch production DB.

## Production Impact

```text
schema change: no
new migration: no
production DB change: no
production deploy: no
seed: no
Fadada API call: no
signing: no
```

## C4 Readiness

C3-F validates that the onboarding platform can be exercised through product entry points without leaking signing, order, contract, or payment side effects.

The system can proceed to C4 enterprise seal / multi-sign strategy design when the wider local verification gate is accepted.

Unrestricted production e-sign remains **No-Go** until the remaining production activation and business rollout gates are approved separately.
