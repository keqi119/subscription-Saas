# eSign Enterprise Auto Seal Backend Foundation

Status: backend foundation only. Production auto seal is not enabled by this change.

## Purpose

Production acceptance found that the signed contract PDF showed only the customer signing mark. The target production behavior is a two-party final PDF:

- customer/user signature
- lessor/company electronic seal

This backend foundation supports that target without enabling production auto seal by default.

## Runtime Guard

Auto seal is disabled unless:

- `ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED=true`
- `ESIGN_PLATFORM_SEAL_KEYWORD` is configured with the approved platform seal keyword
- the active provider supports platform auto seal
- provider configuration is present
- sandbox validation and production go/no-go are completed

Missing or false flag values keep the existing customer signing behavior. When auto seal is enabled but the keyword is missing, the backend fails before the provider call and keeps the contract/order non-final.

## Required Provider Configuration

Values are operator-managed and must not be committed:

- `FADADA_PLATFORM_CUSTOMER_ID`
- `FADADA_PLATFORM_SIGNATURE_ID`
- provider-side enterprise account
- approved company seal/stamp
- auto-sign API permission
- callback endpoint confirmation
- approved seal placement keyword or rule

The generated signing PDF must contain the approved keyword. Contract PDF artifact generation from `ContractVersion.contentTemplate` is tracked separately by Issue 4A.

## State Flow

When enterprise auto seal is enabled:

1. Task creation creates both a `CUSTOMER` signer and a `PLATFORM` signer.
2. Customer signing URL remains tied to the `CUSTOMER` signer.
3. Customer completion marks only the customer signer as signed.
4. Contract remains `SIGNING`.
5. Order remains `PENDING_SIGN`.
6. Platform auto seal is requested through the provider.
7. Only after platform seal success:
   - platform signer is marked signed
   - task is marked completed
   - contract is marked signed
   - order moves to pending payment

If platform auto seal fails, the task remains in a retryable signing state and records a diagnostic snapshot. The contract and order are not finalized.

Provider positioning errors, including a missing or invalid keyword, must not advance the contract or order.

## Final PDF Rule

Signed PDF archive is valid only after the task is completed and all signer rows are signed. This prevents a customer-only signed artifact from being treated as final when a platform signer is required.

## Idempotency

Duplicate customer completion callbacks must not:

- call platform auto seal again after success
- advance the contract twice
- advance the order twice

Retry after failed or pending platform seal remains possible because the task stays in signing state.

## Production Boundary

This foundation does not:

- call production Fadada APIs
- create real provider tasks
- trigger signing
- archive production PDFs
- change production feature flags
- deploy anything
- change legal text
- generate contract PDFs from legal templates
- store provider secrets
