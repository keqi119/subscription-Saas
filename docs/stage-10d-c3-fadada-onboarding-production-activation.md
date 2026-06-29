# Stage 10D-C3-E Fadada Onboarding Production Activation Wiring

Stage 10D-C3-E connects the customer onboarding orchestration control plane to product entry surfaces.

This stage is production-entry wiring only. It does not call Fadada, does not generate sign URLs, does not upload contracts, does not sign, does not modify Contract / Order business status, does not touch payment logic, does not add schema, does not add migrations, and does not deploy production.

## Scope

Implemented entry points:

```text
Admin customer action -> customers/:id/esign-onboarding/*
Order action          -> orders/:id/esign-onboarding/start
Portal customer flow  -> portal/esign-onboarding/status
```

The onboarding service remains the only orchestration entry point:

```text
Order / Portal / Admin
-> CustomerESignOnboardingService
-> CustomerESignProviderAccountService
-> C1/C2 source-of-truth fields
```

Signing remains separate:

```text
CustomerESignOnboardingService does not call ESignService.createSignTask
CustomerESignOnboardingService does not call uploadDocs / extsign_validation
CustomerESignOnboardingService does not update Contract / Order / Payment
```

## Product Entry Hooks

### Order

Added an admin order entry:

```text
POST /api/orders/:id/esign-onboarding/start
permission: order:confirm_final_plan
```

The service reads only:

```text
SubscriptionOrder.id
SubscriptionOrder.customerId
```

It then starts onboarding for the order customer with:

```text
source=ORDER
```

It does not call `OrderService.confirmCustomerOrder`, does not update order status, and does not mutate contract or payment state.

### Portal

Added a customer portal status entry:

```text
GET /api/portal/esign-onboarding/status
guard: CustomerAuthGuard
```

The portal endpoint returns the derived onboarding status for the authenticated portal customer with:

```text
source=PORTAL
```

It is read-only. It does not create bindings, start real-name verification, or trigger signing.

### Admin

Existing admin onboarding endpoints now mark audit source explicitly:

```text
source=ADMIN
```

This applies to status reads, start, verify, and retry entry points.

## Gating Model

`CustomerESignOnboardingService.canStartOnboarding(customerId)` now gates start actions before creating a pending binding.

Blocked states:

```text
SIGNING_ENABLED -> ESIGN_ONBOARDING_ALREADY_SIGNING_ENABLED
DISABLED        -> ESIGN_ONBOARDING_CUSTOMER_DISABLED
```

Allowed states remain derived from C1/C2 binding data:

```text
NOT_STARTED
ONBOARDING
ACCOUNT_CREATED
REALNAME_PENDING
FAILED
```

No onboarding state table was added.

## Audit Model

Audit payloads include:

```text
event
source
masked customer id
previous onboarding status when applicable
next onboarding status
```

Entry sources:

```text
ADMIN
ORDER
PORTAL
```

Audit payloads do not include:

```text
real name
mobile number
ID card number
full customer id
full provider customer id
full provider open id
verify URL
provider raw response
app secret
signUrl
PDF binary
```

## Side-effect Boundary

This stage did not add dependencies from C3 to:

```text
ESignService
FadadaESignProvider
uploadDocs
extsign_validation
signed PDF archive
OrderService status mutation methods
Payment services
ReceivableBill write paths
```

The only order-related read is a guarded customer lookup for the order entry hook.

## Test Coverage

Added / updated targeted tests:

```text
start onboarding writes source-aware masked audit
already SIGNING_ENABLED customers cannot start onboarding again
order entry starts onboarding from order customer without mutating the order
admin endpoints pass source=ADMIN
portal status entry passes source=PORTAL and does not start onboarding
```

Verification executed:

```text
pnpm --filter @subscription-saas/api exec vitest run test/customer-esign-onboarding.spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm -r lint
pnpm prisma:validate
pnpm --filter @subscription-saas/api test
pnpm release:check
```

Current result:

```text
targeted onboarding tests: 12 passed
API typecheck: passed
workspace lint: passed
Prisma schema validate: passed
API tests: 64 files / 871 tests passed
```

`pnpm release:check` passed Prisma validate/generate, script syntax/tests, workspace lint, API typecheck, Web typecheck, and API tests, then stopped at local `prisma migrate status` with a Prisma schema engine error against the local configured database. This stage adds no migration and does not touch production DB.

## Risk Analysis

### Can C3-E Trigger Signing?

No.

C3-E does not call any signing provider, create sign task, upload contract, generate sign URL, open sign URL, callback handler, archive service, or contract status advancement path.

### Can C3-E Mutate Orders?

No order mutation path was added.

The order activation hook reads `customerId` only and delegates to onboarding start.

### Can C3-E Call Fadada?

No direct provider call was added.

The existing C2 real-name wiring remains behind:

```env
FADADA_ONBOARDING_REALNAME_C2_ENABLED=false
FADADA_REALNAME_VERIFY_ENABLED=false
```

### Can Portal Bypass Admin Controls?

No.

The portal endpoint added in this stage is status-only. It does not start onboarding, retry, verify, register provider accounts, or mark real-name state.

## Migration Impact

```text
schema change: no
new migration: no
production DB change: no
seed: no
```

## Stage 10D-C3-F Readiness

The system is ready for a later controlled activation test if all of the following remain true:

```text
1. C3 entry hooks are enabled only through approved product surfaces.
2. C2 real-name and provider traffic gates remain disabled unless separately approved.
3. Portal remains read-only until a customer-facing start policy is approved.
4. Signing remains gated by REGISTERED + VERIFIED binding.
5. No production launch occurs without a separate activation plan.
```

Unrestricted production e-sign remains **No-Go**.
