# eSign Platform Auto Seal Positioning

Status: backend positioning and Stage 1 coordinate auto-seal support only. Production auto seal remains disabled until sandbox validation and go/no-go are completed.

## Purpose

Fadada enterprise auto seal requires an approved signing position. Legacy non-slot signing uses keyword-based positioning and maps it to `extsign_auto.api`. Stage 1 multi-slot signing uses generated PDF coordinates.

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

Stage 1 platform coordinate placement is sent to Fadada auto seal as:

- `position_type=1`
- `signature_id=<configured platform signature id>`
- `signature_positions=<JSON array of SearchLocation>`

Those coordinates are sourced from generated PDF artifact diagnostics for the two platform slots. Do not recalculate coordinates, parse the PDF after rendering, or fall back to keyword search for Stage 1 platform placement.

## Protocol Foundation

Fadada protocol hardening requires provider `transaction_id` values to be 1-32 ASCII letters or digits. Do not use Chinese slot labels, raw keywords, spaces, or punctuation in provider transaction IDs.

For `extsign_auto.api`, success is the documented provider code `1000`. Signing callback result codes such as `3000` are not auto-sign API success codes.

The auto-sign request digest must include the auto-sign `transaction_id` in the endpoint-specific MD5 seed as checked against the local Fadada automatic signing documentation. Unknown or ambiguous auto-sign result payloads must not be treated as success.

Stage 1 multi-position mapping target:

- customer side: one `extsign.api` transaction with two `signature_positions`
- platform side: one `extsign_auto.api` transaction with `position_type=1`, two `signature_positions`, and explicit `signature_id`

The local task model supports Stage 1 signing slots behind `ESIGN_STAGE1_MULTI_SLOT_ENABLED`. The flag defaults to false. One provider transaction may cover multiple local slot rows; callbacks update rows by `transaction_id`, and the task completes only after every required slot row is signed.

The customer-side coordinate mapping now builds one `extsign.api` signing URL with two `signature_positions` sourced from generated PDF artifact slot diagnostics. It covers only the two Stage 1 customer slots and must not recalculate coordinates, parse the PDF, or fall back to keyword search.

For coordinate-based customer signing, the `signature_positions` value must be serialized once as compact JSON and reused as the exact request parameter value. The `extsign.api` `msg_digest` must follow the local Fadada manual signing documentation's endpoint-specific formula using the provider `transaction_id`, timestamp, and customer id. Do not use the generic "all business parameters" digest for this page interface.

Platform-side coordinate auto seal mapping now builds one `extsign_auto.api` request with `position_type=1`, explicit `signature_id`, and two `signature_positions` sourced from generated PDF artifact slot diagnostics. The Stage 1 task completes only after both customer slot rows and both platform slot rows are signed. Do not enable production Stage 1 multi-slot signing before the complete customer/platform flow is sandbox-proven.

## Stage 1 V1.4 Sandbox Closeout

The controlled V1.4 sandbox run completed with result `PASS_WITH_NOTES`.

Evidence:

- API image: `ghcr.io/keqi119/subscription-api:Staging-20260713-9580613`
- Web image: `ghcr.io/keqi119/subscription-web:Staging-20260713-9580613`
- ContractVersion: `test_001 / V1.4`
- Order number: `ORD20260713063232YN5L`
- Contract number: `CON202607130633247T8L`
- Provider contract id: `ESG2026071306414027KJ`
- Platform signature id: `1783852637391749`
- Signed PDF SHA256: `01c34bd12db6c3ba03ae4d48c85ca0a32956ca0c94c90e493bf5d16855375808`

The sandbox run proved the Stage 1 platform two-position auto-seal transaction using generated artifact coordinates and explicit platform signature id. Fadada console/log evidence recorded the platform seal operation for provider contract id `ESG2026071306414027KJ` at 2026-07-13 15:18:12.

The first automated visual review was a false negative: the signed PDF uses `/Widget` annotations with `/AP` appearance streams, and the `pdfplumber`/Pillow visual path did not render those annotation appearances. Page 5 contains two `/Widget` annotations with `/AP` appearance and page 6 contains two `/Widget` annotations with `/AP` appearance. Future seal-position validation must use a viewer/rasterizer that renders annotation appearance or include PDF structure checks for `/Widget` annotations with `/AP`.

## Failed Task Boundary

Existing failed tasks should not be manually marked successful. After the PDF template and positioning are corrected, create a new e-sign task so the customer signs the corrected artifact.

The controlled sandbox task `ESG20260711184435WMCD` failed at the Fadada manual signing page with a `msg_digest` validation error. Do not repair or reuse that task; after the manual signing digest/serialization fix is deployed, create a new controlled order, contract, and signing task.

## Issue 4A Boundary

This positioning support does not render `ContractVersion.contentTemplate` into PDF, generate the order snapshot appendix, or write `contract.fileId`. Formal PDF artifact generation is handled by Issue 4A.
