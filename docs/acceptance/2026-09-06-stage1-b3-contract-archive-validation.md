# Stage 1 B3 contract archive validation evidence

## Decision

**BLOCKED_COUNTEREXAMPLE / independent classification required.** At `2026-09-06 23:59:28` (`Asia/Shanghai`; custody timestamps `2026-09-06T15:59:28.741Z`–`15:59:28.754Z`), the controlled fresh B3 suite at source HEAD `16adab178f5d28326cb2f4c3ac13e36d359dcebf` executed all three PostgreSQL characterizations. This report was written on `2026-09-07`. Two tests passed and the archive-first journey convergence case failed on its first signal dispatch. B3 is not complete and this note is not release-promotion evidence. The observed failure is not, by itself, proof that the normal production journey-creation path necessarily fails.

## Commands and current results

Existing mock characterizations:

```text
pnpm --filter @subscription-saas/api exec vitest run --project unit test/esign.spec.ts test/fadada-archive.spec.ts test/subscription-journey-esign.spec.ts test/lease-activation.spec.ts
```

Observed: exit `0`; 4/4 test files passed; 161/161 tests passed; no skipped or todo entries were reported.

Single governed fresh invocation:

```text
node scripts/release/run-database-suite.mjs --suite-id api.stage1-contract-archive.postgres --chain fresh
```

Observed: exit `1`; complete counted report with `terminalStatus=FAILED`; no retry.

## Fresh report identity

| Field                      | Observed value                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Run ID                     | `3597a875-3e3f-4a0a-b25c-55a271060835`                                                                                |
| Operation ID               | `5de6db6b-e0de-4e3f-a92e-3db830c7d519`                                                                                |
| Suite / chain              | `api.stage1-contract-archive.postgres` / `fresh`                                                                      |
| Manifest digest            | `sha256:276e49d1ddf8ff9ee845629179cb4deeda0da67c2394807f81e1ca270bcb5351`                                             |
| Discovery digest           | `sha256:4be3574d1f8b59a54aad9470882f72a8dc2bc4182153febe92c93da5edd7605a`                                             |
| Target database/OID        | `s1ci_e0326b4391f7c560a07d9aa5` / `16386`                                                                             |
| Target fingerprint         | `sha256:5accb3490cc3927e07050b113aaa5fc0c1c9108c7859c16146af5aa577ac32bd`                                             |
| Runtime role attributes    | `superuser=false`, `createdb=false`, `createrole=false`, `bypassrls=false`                                            |
| Runtime ownership boundary | `canCreateSchema=false`, `schemaOwner=false`, `objectOwner=false`                                                     |
| Counts                     | `cancelled=0`, `collected=3`, `executed=3`, `failed=1`, `filtered=0`, `passed=2`, `selected=3`, `skipped=0`, `todo=0` |
| Sanitized-log digest       | `sha256:dd93706f20e0c57da03e0549e3769001d9fb2e9568a54326ca7ff8b5b138e967`                                             |
| Terminal status            | `FAILED`                                                                                                              |

Custody receipt `.release-local/evidence/receipts/ed43e6ed-e06b-458e-b9ba-2eafbea8e1b5.json` binds the canonical 963-byte report at `.release-local/evidence/evidence/623c488b4c59990aa5e283de2318203009694612bcc7e7281d7c7a0f136342e9.json`. Receipt content and readback digests, plus an independent report-file SHA-256, all equal `sha256:623c488b4c59990aa5e283de2318203009694612bcc7e7281d7c7a0f136342e9`. The launcher removed its governed run directory after custody; no independent cleanup was issued.

## Assertion matrix

| Authority assertion                                                                                                                                         | Fresh observation                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Callback-only completion leaves `Contract.status=SIGNED` with null `archivedAt/fileId` and no matching `FileObject`                                         | **PASS** — first characterization passed.                                                                                         |
| Failure-before-success and success-before-late-failure/rejection remain terminal and monotonic                                                              | **PASS** — first characterization passed.                                                                                         |
| Archive admission persists one `ARCHIVED` Contract tuple and resolves its exact PDF `FileObject`, MIME, byte size, object identity, and SHA-256             | **PASS** — second characterization passed. The minimal `%PDF-` fixture is not a renderable or supplier-validated signed document. |
| Duplicate archive short-circuits before additional provider/storage calls; post-archive callbacks do not revoke admission                                   | **PASS** — second characterization passed.                                                                                        |
| ContractVersion and `signedAt` remain unchanged; order remains `PENDING_PAYMENT`                                                                            | **PASS** — second characterization passed.                                                                                        |
| Callback/archive fixtures create no `Lease` or `VehicleSubscriptionPeriod`                                                                                  | **PASS for the first two isolated fixtures.**                                                                                     |
| Archive-first dispatch completes the signing step, advances to `CUSTOMER_JSAPI_PAYMENT`, ignores late task-completed reconciliation, and remains idempotent | **FAIL / not proven.** The first archive dispatch failed before later dispatches and rereads.                                     |
| Third convergence fixture creates no B4 rows                                                                                                                | **NOT REACHED.** The post-dispatch zero-count assertion did not run; no missing post-state is inferred.                           |

## Counterexample

Failed test:

```text
Stage 1 contract archive admission converges archive-first and repeated signal dispatch without a B4 write
```

The sanitized diagnostic identifies a `PrismaClientKnownRequestError` at the first archive-outbox dispatch, with the persistence call at `SubscriptionJourneyRepository.writeEventAndOutbox` (`subscription-journey.repository.ts:1445`), reached through `completeStep` and `SubscriptionJourneyService.dispatchSignalOutbox` (`subscription-journey.service.ts:264`). It does not retain the exact Prisma error code, message, or constraint, so none is asserted here.

Read-only source correlation provides a strong but unconfirmed explanation. The approved B3 fixture explicitly assigns a 36-character UUID as `SubscriptionJourney.id`; combined with the 36-character Contract UUID, the archive completion key is 131 characters, while `SubscriptionJourneyEvent.eventKey` is `VarChar(128)`. The normal `createOrGetForApplication` path does not assign a journey ID and uses the model's approximately 25-character `cuid()` default, producing an approximately 120-character key with a Contract UUID. Because the retained diagnostic contains no exact Prisma code, message, or constraint, the run cannot conclusively distinguish a fixture-representativeness mismatch from a broader supported-identity/key-boundary defect. Independent review must make that classification before selecting any amendment. No test, production, fixture, or schema source was changed during this failed execution.

The existing `subscription-journey-golden-path.e2e-spec.ts` fabricates the archive state directly. It does not call the real callback/archive service boundary and is not this proof.

## Unresolved limits

- The snapshot chain was not run.
- Real Fadada and OSS were not contacted.
- `stage1.esign` remains `must-external-verify`.
- No B4 activation was executed.
- Archive-first/repeated signal convergence remains failed and must not be represented as accepted.
- This evidence does not authorize release promotion, staging, cloud, or production use.
