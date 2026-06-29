# Stage 10D-C2-C Fadada Real-Name Production Readiness Hardening

Stage 10D-C2-C turns the Fadada real-name lifecycle from an implemented capability into a production signing constraint.

This stage does not call Fadada, does not generate or open sign URLs, does not sign, does not deploy, and does not modify production data.

## Production Signing Rule

Production Fadada signing is binding-only:

```text
provider=FADADA
accountType=PERSONAL
registrationStatus=REGISTERED
realNameStatus=VERIFIED
providerCustomerId present
```

If no binding matches, `createSignTask` fails before:

```text
PDF artifact lookup
uploaddocs.api
extsign_validation.api
signUrl generation
```

## Smoke Override Hardening

The B5 smoke override is now non-production only.

Production behavior:

```text
FADADA_ENV=production
FADADA_FULL_SIGNING_SMOKE=1
-> FADADA_PRODUCTION_SMOKE_OVERRIDE_DISABLED
```

The override is not silently ignored and is not used as a fallback in production. This makes accidental production test-customer signing fail closed.

Non-production behavior remains available for explicitly gated test flows:

```text
FADADA_ENV=sandbox
FADADA_FULL_SIGNING_SMOKE=1
FADADA_TEST_LOCAL_CUSTOMER_ID matches local customer
FADADA_TEST_CUSTOMER_ID present
```

## Resolver Safety

Resolver priority is:

1. Formal `REGISTERED + VERIFIED` binding.
2. Non-production smoke override only when explicitly enabled and customer-scoped.
3. Fail closed.

The formal binding path remains preferred even when smoke variables are present.

## Manual Override Audit

Manual recovery paths remain available but are now audited:

```text
manuallyAttachFadadaPersonalAccount
markRealNameStatus
```

Audit entries include:

```text
module=esign
entityType=customer_esign_provider_account
entityId=<binding id>
action=UPDATE
operatorId=<actor id>
before/after masked account view
overrideType
```

Audit entries must not include:

```text
full provider customer id
mobile number
real name
ID card number
app secret
provider raw response
full real-name URL
```

Manual `VERIFIED` remains an admin override, not the normal lifecycle authority. The normal authority chain is:

```text
get_person_verify_url -> verify callback / status refresh -> apply_cert
```

## Test Coverage

C2-C adds regression coverage for:

```text
production env rejects smoke override before PDF/upload/signUrl
VERIFIED binding still takes priority over smoke variables
missing or unverified binding blocks createSignTask
manual attach writes audit
manual real-name status override writes audit
audit payloads are masked
```

## Safety Boundary

No external or production side effects were performed:

```text
Fadada real API calls: no
uploadDocs: no
extsign_validation: no
extsign_auto: no
signUrl generated/opened: no
signing: no
Contract / Order advancement: no
PaymentRecord / PaymentWriteOff: no
ReceivableBill mutation: no
production DB write: no
production deploy: no
production migration / seed: no
```

## Gate Result

Stage 10D-C2-C result:

```text
production signing path: single-path binding-only
production smoke fallback: disabled / hard rejected
manual override: audited
unrestricted production e-sign launch: still No-Go until onboarding controls are approved
```

Next recommended stage:

```text
Stage 10D-C3 production onboarding / activation design
```

