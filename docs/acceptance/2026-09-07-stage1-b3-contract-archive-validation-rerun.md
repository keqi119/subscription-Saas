# Stage 1 B3 contract archive validation rerun evidence

## Decision

**BLOCKED_COUNTEREXAMPLE / independent classification required.** This evidence records one complete governed fresh rerun from clean source `d208d33fd77b33d006f53f039a4f01e81597af42`. The rerun executed all three PostgreSQL characterizations and ended `FAILED`: two tests passed and the archive-first journey convergence case failed. No test, database, source fix, or retry was performed after this result. B3 remains incomplete and this note is not release-promotion evidence.

The custody timestamps were `2026-09-06T17:30:40.222Z`–`2026-09-06T17:30:40.233Z` (Shanghai: `2026-09-07 01:30:40.222`–`01:30:40.233`). The launcher performed normal counted-FAILED cleanup; the run directory no longer exists. No manual cleanup was issued.

## Clean source and commands

Clean launch source SHA:

```text
d208d33fd77b33d006f53f039a4f01e81597af42
```

The four commands executed were:

```text
pnpm --filter @subscription-saas/shared build
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec vitest run --project unit test/esign.spec.ts test/fadada-archive.spec.ts test/subscription-journey-esign.spec.ts test/lease-activation.spec.ts
node scripts/release/run-database-suite.mjs --suite-id api.stage1-contract-archive.postgres --chain fresh
```

The shared build and Prisma generation exited `0`. Prisma generated `Prisma Client v7.8.0`; the observed runtime was Node `24.14.0` with pnpm `11.4.0` (not Node 22 final-image evidence). The fixed unit characterization exited `0`: 4 files passed, 161 tests passed, with duration `9.40s`; no skipped or todo entries were reported. The fresh governed command exited `1`.

## Fresh report identity

| Field                      | Observed value                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Run ID                     | `77300999-de9d-40ec-8a90-4bf0bb136e47`                                                                                |
| Operation ID               | `f2e16277-a1ae-4d87-818e-91dd89dfeabb`                                                                                |
| Suite / chain              | `api.stage1-contract-archive.postgres` / `fresh`                                                                      |
| Schema version             | `database-suite-report.v1`                                                                                            |
| Manifest digest            | `sha256:276e49d1ddf8ff9ee845629179cb4deeda0da67c2394807f81e1ca270bcb5351`                                             |
| Discovery digest           | `sha256:4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a`                                             |
| Target database / OID      | `s1ci_b7272f70c80ebb9df495bf89` / `16386`                                                                             |
| Target fingerprint         | `sha256:0e1fa77474fe3b17e58176a298d1a5c689b851275e5b037670aa85f41eff9142`                                             |
| Runtime role attributes    | `superuser=false`, `createdb=false`, `createrole=false`, `bypassrls=false`                                            |
| Runtime ownership boundary | `canCreateSchema=false`, `schemaOwner=false`, `objectOwner=false`                                                     |
| Counts                     | `cancelled=0`, `collected=3`, `executed=3`, `failed=1`, `filtered=0`, `passed=2`, `selected=3`, `skipped=0`, `todo=0` |
| Sanitized-log digest       | `sha256:817727265e35ab1804dd77c0152650da3276d00224244d704f23cec87fe02ff3`                                             |
| Terminal status            | `FAILED`                                                                                                              |

The current report is `.release-local/evidence/evidence/3d81ca096b36c2619cc6e4ef27fcd495e8b55761aadb38dc0ab87b79bbd240ab.json` (963 bytes), with report-file SHA-256 `sha256:3d81ca096b36c2619cc6e4ef27fcd495e8b55761aadb38dc0ab87b79bbd240ab`.

The custody receipt is `.release-local/evidence/receipts/24d18dfc-fb4a-437c-b17e-fbb277f1c43b.json`, with receipt-file SHA-256 `sha256:53ad0418ee000985e002c143a1e41883fdc95282ae489cbb7c5ac388d716ee46`. Receipt ID is `24d18dfc-fb4a-437c-b17e-fbb277f1c43b`; its `contentDigest` and `readbackDigest` both equal `sha256:3d81ca096b36c2619cc6e4ef27fcd495e8b55761aadb38dc0ab87b79bbd240ab`. Its attestation reference is `local-controlled-nonpromotable://77300999-de9d-40ec-8a90-4bf0bb136e47/api.stage1-contract-archive.postgres`.

The receipt's `retainUntil` is local custody metadata only; it is not evidence of private-cloud WORM storage or a real 180-day retention guarantee.

## Assertion matrix

| Authority assertion                                                                                                                          | Rerun observation                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callback-only completion leaves Contract `SIGNED` with null archive admission facts                                                          | **PASS** — first characterization passed.                                                                                                                                                                                                 |
| Failure-before-success and success-before-late-failure/rejection remain terminal and monotonic                                               | **PASS** — first characterization passed.                                                                                                                                                                                                 |
| Archive admission persists one `ARCHIVED` Contract tuple and resolves its exact PDF `FileObject`                                             | **PASS** — second characterization passed. The minimal `%PDF-` fixture is not renderable or supplier-validated signed-document proof.                                                                                                     |
| Duplicate archive short-circuits provider/storage calls; post-archive callbacks do not revoke admission                                      | **PASS** — second characterization passed.                                                                                                                                                                                                |
| ContractVersion and `signedAt` remain unchanged; order remains `PENDING_PAYMENT`                                                             | **PASS** — second characterization passed.                                                                                                                                                                                                |
| Callback/archive fixtures create no `Lease` or `VehicleSubscriptionPeriod`                                                                   | **PASS for all fixtures in the first two characterizations.**                                                                                                                                                                             |
| Archive-first dispatch completes the signing step, advances to `CUSTOMER_JSAPI_PAYMENT`, ignores late reconciliation, and remains idempotent | **FAIL / not proven.** At `stage1-contract-archive.integration.spec.ts:758:42`, expected `CUSTOMER_JSAPI_PAYMENT` but observed `INITIAL_BILLING`. All later signing-step, event-count, and reconcile-job assertions were **NOT_REACHED**. |
| Third convergence fixture creates no B4 rows                                                                                                 | **NOT_REACHED.** The B4 zero-count assertion was not reached.                                                                                                                                                                             |

## Counterexample and diagnostic limits

The complete failed test was:

```text
Stage 1 contract archive admission converges archive-first and repeated signal dispatch without a B4 write
```

The sanitized diagnostic identifies an assertion failure at `stage1-contract-archive.integration.spec.ts:758:42`: expected `CUSTOMER_JSAPI_PAYMENT`, actual `INITIAL_BILLING`. The first two cases passed within this scope; the third case did not meet the expected transition. No exact Prisma error code, message, or constraint is asserted for this rerun.

The fixture identity correction removed the explicit Journey UUID and returned Prisma's created Journey ID. This rerun advanced past the prior first-dispatch Prisma failure point, consistent with the static fixture correlation, but does not establish the precise original root cause or that normal production journey creation fails. No production edit is proposed or made under this closeout.

## Immutable first-run history

The first fresh run remains immutable failed history: run ID `3597a875-3e3f-4a0a-b25c-55a271060835`, operation ID `5de6db6b-e0de-4e3f-a92e-3db830c7d519`, counts `collected=3`, `executed=3`, `passed=2`, `failed=1`, and terminal status `FAILED`.

Its canonical report remains `.release-local/evidence/evidence/623c488b4c59990aa5e283de2318203009694612bcc7e7281d7c7a0f136342e9.json`, with SHA-256 `sha256:623c488b4c59990aa5e283de2318203009694612bcc7e7281d7c7a0f136342e9`; its receipt remains `.release-local/evidence/receipts/ed43e6ed-e06b-458e-b9ba-2eafbea8e1b5.json`, with file SHA-256 `sha256:200f9d312b26d5076070d8719b43af263bdc6853642dcb40085b006f69744110`. The original acceptance note remains `docs/acceptance/2026-09-06-stage1-b3-contract-archive-validation.md`. These first-run files were preserved byte-for-byte.

## Unresolved limits

- No real Fadada or OSS provider was contacted; the minimal PDF fixture is not renderable or supplier-validation proof.
- The snapshot chain was not run.
- No B4 activation was executed; no Lease or VehicleSubscriptionPeriod claim is made for the unreached third-case assertion.
- `stage1.esign` remains `must-external-verify`.
- This evidence does not authorize release promotion, staging, cloud, production, or real-provider use.
