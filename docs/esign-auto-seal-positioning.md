# eSign Platform Auto Seal Positioning

Status: backend positioning support only. Production auto seal remains disabled until sandbox validation and go/no-go are completed.

## Purpose

Fadada enterprise auto seal requires an approved signing position. The MVP uses keyword-based positioning and maps it to `extsign_auto.api`.

## Configuration

The approved keyword is configured outside the repository:

- `ESIGN_PLATFORM_SEAL_KEYWORD`

Rules:

- The keyword must be approved by legal/operator.
- The generated signing PDF must contain the keyword.
- Do not commit the real keyword if it is sensitive.
- Do not invent a keyword in code, tests, or runbooks.

## Runtime Behavior

When `ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED` is missing or false, the customer-only signing flow remains compatible and no keyword is required.

When enterprise auto seal is enabled:

1. Customer signing can complete first.
2. Platform auto seal is only attempted if `ESIGN_PLATFORM_SEAL_KEYWORD` is configured.
3. Missing keyword fails before the provider call.
4. Contract stays `SIGNING`.
5. Order stays `PENDING_SIGN`.
6. The platform signer remains non-final and the task records a retryable diagnostic.

## Fadada Mapping

Keyword placement is sent to Fadada auto seal as:

- `position_type=0`
- `sign_keyword=<approved keyword>`

Coordinate placement is intentionally left as a future extension. Do not add coordinate fields until the provider parameter mapping and placement rule are approved for production use.

## Protocol Foundation

Fadada protocol hardening requires provider `transaction_id` values to be 1-32 ASCII letters or digits. Do not use Chinese slot labels, raw keywords, spaces, or punctuation in provider transaction IDs.

For `extsign_auto.api`, success is the documented provider code `1000`. Signing callback result codes such as `3000` are not auto-sign API success codes.

The auto-sign request digest must include the auto-sign `transaction_id` in the endpoint-specific MD5 seed as checked against the local Fadada automatic signing documentation. Unknown or ambiguous auto-sign result payloads must not be treated as success.

Future Stage 1 multi-position mapping target:

- customer side: one `extsign.api` transaction with two `signature_positions`
- platform side: one `extsign_auto.api` transaction with `position_type=1`, two `signature_positions`, and explicit `signature_id`

This document still does not enable full Stage 1 multi-position provider mapping. The mapping remains a future build and must be sandbox-proven before production use.

## Failed Task Boundary

Existing failed tasks should not be manually marked successful. After the PDF template and positioning are corrected, create a new e-sign task so the customer signs the corrected artifact.

## Issue 4A Boundary

This positioning support does not render `ContractVersion.contentTemplate` into PDF, generate the order snapshot appendix, or write `contract.fileId`. Formal PDF artifact generation is handled by Issue 4A.
