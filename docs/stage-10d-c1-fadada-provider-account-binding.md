# Stage 10D-C1-A Fadada Provider Account Binding

Stage 10D-C1-A starts the move from the controlled B5-B test signer override to a formal customer-provider account binding model.

## Background

Stage 10D-B5-B proved the controlled real Fadada signing path:

- `uploaddocs.api` passed;
- `extsign_validation.api` returned the signing page URL;
- the controlled tester completed signing;
- callback verification and idempotency passed;
- contract/order advancement passed;
- signed PDF archive and Admin/Portal PDF streams passed;
- finance side effects were unchanged.

The validation used a controlled runtime override:

```text
FADADA_FULL_SIGNING_SMOKE=1
FADADA_TEST_LOCAL_CUSTOMER_ID
FADADA_TEST_CUSTOMER_ID
```

Stage 10D-B5-C closed that override in production. Broad customer e-sign remains gated because ordinary customers do not yet have a formal Fadada `customer_id` binding or real-name status flow.

## Model

Stage 10D-C1-A adds `CustomerESignProviderAccount`:

```text
Customer -> CustomerESignProviderAccount
provider=FADADA
accountType=PERSONAL
providerOpenId
providerCustomerId
registrationStatus
realNameStatus
source
```

New enums:

```text
ESignProviderAccountType: PERSONAL, ENTERPRISE
ESignProviderAccountStatus: PENDING, REGISTERED, FAILED, DISABLED
ESignRealNameStatus: UNVERIFIED, PENDING, VERIFIED, FAILED, EXPIRED
ESignProviderAccountSource: SYSTEM_REGISTER, MANUAL
```

Migration:

```text
20260629090000_customer_esign_provider_accounts
```

The migration only creates the binding table, enums, indexes, and the Customer foreign key. It does not backfill customer rows, register provider accounts, seed provider IDs, or modify production data.

## providerOpenId v1

Fadada personal `open_id` is generated from a stable non-PII namespace:

```text
subauto_person_v1_<sha256("subauto:fadada:personal-provider-open-id:v1:" + customerId).slice(0, 24)>
```

Properties:

- deterministic for the same `Customer.id`;
- distinct for different customers;
- does not use mobile, name, ID card number, or `CustomerAccount`;
- uses only lowercase ASCII, underscores, and hex characters.

## Service Behavior

`CustomerESignProviderAccountService` supports:

- list customer provider accounts;
- get the Fadada personal binding;
- initialize an idempotent `PENDING` binding;
- register a Fadada personal account;
- retry a failed registration;
- manually attach an existing Fadada personal provider customer id;
- mark real-name status.

Read responses return masked identifiers and status fields. They do not return full provider customer IDs or provider snapshots.

## account_register Gate

Real Fadada account registration is guarded by:

```env
FADADA_ACCOUNT_REGISTER_ENABLED=false
```

Default behavior is disabled. When disabled, register/retry returns:

```text
FADADA_ACCOUNT_REGISTER_DISABLED
```

and no Fadada transport call is made. Manual attach does not call Fadada.

## Resolver Integration

Fadada signing now resolves the signer customer id in this order:

1. Formal binding:
   - `provider=FADADA`
   - `accountType=PERSONAL`
   - `registrationStatus=REGISTERED`
   - `realNameStatus=VERIFIED`
   - `providerCustomerId` present
2. Controlled smoke override only in non-production environments when `FADADA_FULL_SIGNING_SMOKE=1` and the local customer id matches `FADADA_TEST_LOCAL_CUSTOMER_ID`.
3. Otherwise fail before PDF loading, upload, or sign URL creation:
   - `FADADA_SIGNER_CUSTOMER_ID_MISSING`

The formal binding path is preferred over the smoke override.

Production invariant:

```text
FADADA_ENV=production
-> REGISTERED + VERIFIED binding is required
-> FADADA_FULL_SIGNING_SMOKE is rejected even if set
-> no silent fallback to test customer env is allowed
```

## Admin API

Stage 10D-C1-A adds API-only admin endpoints:

```text
GET /api/customers/:id/esign-provider-accounts
GET /api/customers/:id/esign-provider-accounts/fadada
POST /api/customers/:id/esign-provider-accounts/fadada/init
POST /api/customers/:id/esign-provider-accounts/fadada/register
POST /api/customers/:id/esign-provider-accounts/fadada/retry
POST /api/customers/:id/esign-provider-accounts/fadada/manual-attach
PATCH /api/customers/:id/esign-provider-accounts/fadada/real-name-status
```

Permissions:

```text
read: customer:view
write: customer:manage
```

The backend UI is intentionally left for a later C1-B stage.

## PII and Secret Boundary

The binding model and API must not store or return:

- ID card number;
- ID card photos;
- real name;
- full mobile;
- app secret;
- full real-name URL;
- full provider raw response.

Allowed fields include:

- provider openId;
- provider customerId;
- registration status;
- real-name status;
- verification serial/transaction references;
- sanitized provider snapshot;
- sanitized error code/message.

## Explicit Non-Goals

Stage 10D-C1-A does not:

- call real Fadada APIs by default;
- call `get_person_verify_url.api`;
- call `person_three_ele_auth.api`;
- call `apply_cert.api`;
- upload contracts;
- generate sign URLs;
- sign;
- auto-register ordinary customers during signing;
- bulk backfill existing customers;
- seed provider customer IDs;
- deploy production;
- apply production migrations.

## Next Stage

Stage 10D-C2 should add the real-name verification flow:

- `get_person_verify_url.api`;
- real-name verification callback handling;
- automatic `realNameStatus` updates;
- certificate application if required;
- customer/operator workflows for retry and audit.

Until C2 is complete, unrestricted production e-sign remains **No-Go**.

## Stage 10D-C2 Follow-Up

Stage 10D-C2 adds the automated real-name lifecycle on top of this binding model without adding a new migration:

```text
get_person_verify_url.api
verify callback: /api/esign/callback/fadada/verify
find_personCertInfo.api status refresh
apply_cert.api
FADADA_REALNAME_VERIFY_ENABLED=false by default
```

The signing resolver still requires `REGISTERED + VERIFIED` formal binding before ordinary Fadada signing can start. C2 does not upload contracts, generate sign URLs, sign, advance Contract/Order, or mutate payment state.

## Stage 10D-C2-C Production Hardening

Stage 10D-C2-C hardens the production contract:

- production signing is binding-only;
- `FADADA_FULL_SIGNING_SMOKE` is non-production only and hard-rejected in production;
- manual provider customer id attach and manual real-name status override are audited;
- audit snapshots use masked account views and must not include PII or full provider customer ids.

This keeps the C1-A manual recovery path available for controlled operations while making it traceable.
