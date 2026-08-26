# Stage 1 Return Evidence, Contract Pricing, and Settlement Implementation Plan

> **Execution rule:** The primary agent executes this plan directly after PR B is merged and deployed. Do not spawn subagents or parallel implementation workers. Use `superpowers:test-driven-development` for each task and `superpowers:verification-before-completion` before PR C.

**Goal:** Fix `ACC-20260826-05` and `ACC-20260826-06` by replacing damage-photo URL entry with governed evidence uploads and delivering an operable three-stage return flow: physical recovery/evidence, delivery-return delta plus contract pricing, and customer/financial disposition with operational closure independent from unresolved legal receivables.

**Architecture:** Extend the existing `SubscriptionClosureCase` rather than replacing it. Keep `VehicleReturn`, asset work-order evidence, immutable closure document/settlement revisions, receivable bills, payments, approvals, and asset restrictions authoritative in their domains. Add structured checklist/evidence links, immutable condition-delta revisions, contract charge-clause snapshots, charge-line provenance, revision-bound customer responses/disputes, and per-receivable disposition. Add a financial-status axis to the closure projection while retaining the current operational status. Build Admin/Portal command surfaces over backend `allowedActions`.

**Tech stack:** NestJS 11, Prisma 7, PostgreSQL 16, TypeScript 6, Vitest 4, PDFKit, Next.js 16, React 19, Ant Design 6, pnpm workspace.

**Approved design:** `docs/superpowers/specs/2026-08-26-stage1-return-evidence-contract-pricing-settlement-design.zh-CN.md`

**Base:** merged PR B. Rebase a new PR C branch on protected `main`; do not stack on an unmerged PR B.

## Binding invariants

- New return evidence is a governed `FileObject`/asset evidence relation; the new API never accepts arbitrary photo URLs.
- Existing `VehicleReturnDamage.photoUrls` remains readable as unverified legacy history and is never assigned invented hashes or capture timestamps.
- Keys, registration certificate, accessories, mileage, vehicle condition, and customer-attestation mode are explicit facts in the return manifest.
- A charge line must bind to an immutable contract clause, condition delta, evidence, responsibility, and calculation.
- No matching clause or insufficient evidence creates a pricing exception; it never silently uses a default price.
- Customer accept, dispute, and no-response are distinct non-blocking outcomes.
- `LEGAL_COLLECTION` is not payment, waiver, or write-off.
- Vehicle inventory release and order operational completion do not wait for litigation, but every open receivable must have an explicit disposition owner/status.
- `SubscriptionClosureSettlementRevision.stage=SETTLED` remains reserved for true financial settlement.
- Forward-only migrations and append-only revisions; no destructive history rewrite.

---

## Task C0: Establish PR C baseline and RED acceptance tests

**Files:**

- Modify `apps/api/test/subscription-closure.controller.spec.ts`.
- Modify `apps/api/test/subscription-closure.service.spec.ts`.
- Modify `apps/api/test/subscription-closure.settlement.service.spec.ts`.
- Add `apps/api/test/subscription-return-three-stage.e2e-spec.ts`.
- Modify `apps/web/test/admin-order-workspace.spec.ts`.
- Modify `apps/web/test/subscription-closure-view-model.spec.ts`.

**Steps:**

1. Create a clean PR C branch from merged PR B and verify A/B targeted suites remain green.
2. Add RED API tests proving damage input uses evidence IDs, not `photoUrls`, and required return items are validated.
3. Add a RED E2E scenario for physical receipt, delta/contract charge, customer dispute/no-response, legal collection, inventory release, and operational order completion with the receivable still open.
4. Add RED Web tests proving the old “照片 URL” field is absent and the three-stage workspace is present.
5. Run targeted suites and commit RED tests.

## Task C1: Add structured return checklist and governed evidence links

**Files:**

- Modify `apps/api/prisma/schema.prisma`.
- Add `apps/api/prisma/migrations/20260826030000_stage1_return_evidence/migration.sql`.
- Modify `apps/api/test/subscription-closure.schema.spec.ts`.
- Modify `apps/api/test/return-manifest-esign.schema.spec.ts`.
- Modify `apps/api/test/order-return.spec.ts`.

**Schema changes:**

- Add `VehicleReturnChecklistItem` with item code, state (`NORMAL`, `MISSING`, `DAMAGED`, `NOT_APPLICABLE`, `PENDING_VERIFICATION`), quantity/remark, immutable capture revision, and actor/time.
- Add `VehicleReturnEvidenceLink` joining a checklist item or damage to an authoritative `AssetWorkOrderEvidence`/`FileObject` while enforcing exactly one owner target.
- Add return-document attestation mode (`CUSTOMER_SIGNED`, `CUSTOMER_REFUSED`, `CUSTOMER_ABSENT`) and refusal/absence snapshot to the document revision or a strongly linked attestation row.
- Keep `VehicleReturnDamage.photoUrls` nullable for legacy reads; add a database guard preventing new managed-Closure code paths from relying on it.

**Steps:**

1. Write RED schema tests for owner shape, evidence uniqueness, checklist item-code uniqueness per capture revision, and attestation completeness.
2. Add the forward migration with no destructive conversion of legacy URLs.
3. Backfill current return booleans into a legacy checklist revision only when values are unambiguous; mark source as migration.
4. Add append-only/update guards for captured checklist/evidence links.
5. Run Prisma validation/generation, schema tests, and real-PostgreSQL constraint proofs; commit.

## Task C2: Add Admin return evidence upload and item/damage binding APIs

**Files:**

- Modify `apps/api/src/subscription-closure/subscription-closure.dto.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.controller.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.service.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.repository.ts`.
- Reuse `apps/api/src/upload/multipart-upload-options.ts`.
- Reuse `apps/api/src/storage/storage.service.ts`.
- Modify `apps/api/src/handover-work-order/handover-work-order.service.ts` only through an explicit same-transaction evidence capability.
- Modify `apps/api/test/subscription-closure.controller.spec.ts`.
- Add `apps/api/test/subscription-return-evidence-upload.spec.ts`.
- Add `apps/api/test/subscription-return-evidence.integration.spec.ts`.

**Steps:**

1. Add RED tests for multipart upload, MIME/size/count limits, SHA-256, FileObject creation, work-order evidence append, item/damage binding, exact replay, and supersession.
2. Add an authenticated Admin route scoped to Closure Case and checklist/damage target; do not expose a generic unbound upload.
3. Remove `photoUrls` from new `ClosureDamageDto`; require governed evidence for chargeable damage or an approved evidence exception.
4. Store upload and evidence append in a failure-safe sequence; orphan storage objects are cleaned by the existing storage reconciliation pattern, never by deleting committed evidence facts.
5. Ensure customer/internal access separation for file projection.
6. Run upload/evidence tests and commit.

## Task C3: Render and sign the complete return manifest

**Files:**

- Modify `apps/api/src/subscription-closure/subscription-closure.service.ts`.
- Modify `apps/api/src/esign/return-manifest-esign.service.ts`.
- Add `apps/api/src/subscription-closure/subscription-return-manifest-model.ts`.
- Modify `apps/api/test/return-manifest-esign.service.spec.ts`.
- Add `apps/api/test/subscription-return-manifest-content.spec.ts`.
- Add `apps/api/test/subscription-return-manifest-real-render.fixture.ts`.
- Add `apps/api/test/subscription-return-manifest-real-render.spec.ts`.

**Steps:**

1. Add RED tests requiring vehicle identity, pickup time/location, mileage, condition, key counts, registration certificate, charging equipment, accessories, damages, evidence index, customer comments, attestation mode, revision, manifest hash, and evidence-manifest hash.
2. Build a deterministic render model from immutable checklist/evidence facts, not mutable UI JSON.
3. Normal mode requires customer/platform signing and archive.
4. Refused/absent modes create a clearly labelled unilateral evidence artifact with reason, notifications, field witnesses, and supplemental evidence; never synthesize a customer signature.
5. Facts changing after generation supersede the document and invalidate/recreate the sign task through existing durability rules.
6. Run PDF/e-sign/content tests and commit.

## Task C4: Create immutable delivery-return condition delta revisions

**Files:**

- Modify `apps/api/prisma/schema.prisma`.
- Add `apps/api/prisma/migrations/20260826031000_stage1_return_condition_delta/migration.sql`.
- Add `apps/api/src/subscription-closure/subscription-return-delta.service.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.module.ts`.
- Add `apps/api/test/subscription-return-delta.schema.spec.ts`.
- Add `apps/api/test/subscription-return-delta.service.spec.ts`.
- Add `apps/api/test/subscription-return-delta.integration.spec.ts`.

**Data contract:**

- `VehicleConditionDeltaRevision`: case, monotonic revision, delivery/return document revisions and hashes, result hash, source, actor/time, supersedes.
- `VehicleConditionDeltaItem`: item code, delivery/return states, quantity difference, wear classification, responsibility, evidence references, and decision reason.
- Current-revision pointer on the Closure Case or a dedicated current projection.

**Steps:**

1. Write RED schema/service tests for exact source artifacts, deterministic comparison, normal wear, missing/damaged accessories, supersession, and immutability.
2. Resolve the delivery baseline from archived/signed Stage 2 handover facts and manifest hash.
3. Resolve the return side from the current immutable return manifest/checklist.
4. Generate a proposed delta; authorized responsibility confirmation creates a successor revision rather than updating items.
5. Reject cross-order/vehicle/document references.
6. Run delta tests and commit.

## Task C5: Snapshot executable contract charge clauses

**Files:**

- Modify `apps/api/prisma/schema.prisma`.
- Add `apps/api/prisma/migrations/20260826032000_stage1_contract_charge_clause_snapshot/migration.sql`.
- Add `apps/api/src/contract/contract-charge-clause.ts`.
- Modify `apps/api/src/order/order.service.ts` at contract creation.
- Modify `apps/api/src/subscription-change/subscription-extension-contract.service.ts`.
- Modify `apps/api/src/subscription-change/subscription-vehicle-swap-contract.service.ts`.
- Modify `apps/api/src/subscription-change/subscription-early-termination-change.service.ts`.
- Modify `apps/api/src/contract/contract-pdf-render-model.ts` only to keep displayed clauses aligned.
- Add `apps/api/test/contract-charge-clause.spec.ts`.
- Modify `apps/api/test/subscription-journey-order-contract.spec.ts`.
- Modify extension/swap/early-termination contract tests.

**Data contract:**

- Immutable `ContractChargeClauseSnapshot` keyed by contract and clause code/version, including charge type, unit, price tiers, cap, exemption/wear rules, required evidence, rounding/currency, and source text locator/hash.

**Steps:**

1. Add RED tests for deterministic clause compilation from the signed contract snapshot and parity with customer-visible rendered terms.
2. Compile and persist clauses in the same transaction as contract creation; do not infer clauses later from mutable product configuration.
3. Fail contract generation when a displayed charge term cannot be represented safely; do not create a silent default.
4. For historical contracts, provide a dry-run classifier: deterministic backfill only when the signed snapshot includes exact inputs; otherwise mark `MANUAL_CLAUSE_REVIEW_REQUIRED`.
5. Run contract and migration tests; commit.

## Task C6: Add charge-line provenance and contract-based pricing

**Files:**

- Modify `apps/api/prisma/schema.prisma`.
- Add `apps/api/prisma/migrations/20260826033000_stage1_closure_charge_line/migration.sql`.
- Add `apps/api/src/subscription-closure/subscription-closure-pricing.service.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.settlement-resolver.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.service.ts`.
- Add `apps/api/test/subscription-closure-pricing.spec.ts`.
- Modify `apps/api/test/subscription-closure.settlement-resolver.spec.ts`.
- Modify `apps/api/test/subscription-closure.settlement.service.spec.ts`.

**Data contract:**

- Immutable `SubscriptionClosureChargeLine` binds settlement revision, delta revision/item, contract/clause snapshot, quantity, unit price, calculation snapshot/hash, responsibility, evidence set, exception approval, and receivable bill.

**Steps:**

1. Add RED tests for mileage, damage, missing key/document/accessory, cleaning, repair, early termination, tier/cap/exemption, and integer-cent rounding.
2. Produce a preview without bills; finalize only authorized responsibility/price facts.
3. Generate each formal bill from immutable charge lines and preserve line-to-bill links.
4. Missing clause/evidence creates a pricing-exception task. Price override requires an exact approval snapshot and creates a new settlement revision.
5. Remove legacy direct damage-fee generation from the managed Closure UI/API or make it a compatibility façade that cannot bypass charge provenance.
6. Run pricing/settlement tests and commit.

## Task C7: Add revision-bound customer response and dispute flows

**Files:**

- Modify `apps/api/prisma/schema.prisma`.
- Add `apps/api/prisma/migrations/20260826034000_stage1_closure_customer_response/migration.sql`.
- Modify `apps/api/src/subscription-closure/subscription-closure.dto.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.controller.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.service.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.projection.ts`.
- Modify `apps/api/src/portal/portal-billing.controller.ts`.
- Add `apps/api/src/portal/portal-subscription-closure.service.ts`.
- Add `apps/api/test/subscription-closure-customer-response.spec.ts`.
- Add `apps/api/test/portal-subscription-closure-response.spec.ts`.

**Data contract:**

- `SubscriptionClosureCustomerResponse`: exact final settlement revision/hash, status (`PENDING`, `ACCEPTED`, `PARTIALLY_DISPUTED`, `DISPUTED`, `NO_RESPONSE`), actor/time, delivery/notification snapshot.
- `SubscriptionClosureChargeDispute`: charge line, customer reason/evidence, platform decision/evidence, resolution, and immutable timeline.

**Steps:**

1. Add RED tests for exact revision acceptance, per-line dispute, duplicate submission, stale revision, new revision supersession, and deadline-driven no-response.
2. Add customer-scoped Portal commands and Admin dispute resolution commands.
3. Amount changes always create a successor settlement revision; never update a disputed charge line.
4. No-response records notification attempts and never maps to acceptance.
5. Prove all three outcomes leave physical/inventory commands available.
6. Run customer-response tests and commit.

## Task C8: Add per-receivable disposition and legal-collection facts

**Files:**

- Modify `apps/api/prisma/schema.prisma`.
- Add `apps/api/prisma/migrations/20260826035000_stage1_closure_receivable_disposition/migration.sql`.
- Add `apps/api/src/subscription-closure/subscription-closure-financial.service.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.service.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.settlement-resolver.ts`.
- Modify `apps/api/src/finance/finance.service.ts` through existing payment/write-off capabilities.
- Modify `apps/api/src/payment/payment-order.service.ts` only for closure-line selection/idempotency.
- Add `apps/api/test/subscription-closure-financial.spec.ts`.
- Add `apps/api/test/subscription-closure-legal-collection.spec.ts`.
- Modify `apps/api/test/portal-payment.spec.ts`.
- Modify `apps/api/test/payment-settlement.spec.ts`.

**Data contract:**

- Closure financial status: `DRAFT`, `AWAITING_CUSTOMER`, `PARTIALLY_PAID`, `DISPUTED`, `COLLECTION_PENDING`, `LEGAL_COLLECTION`, `SETTLED`, `WRITTEN_OFF`.
- Per-bill/charge disposition: `OPEN`, `PAID`, `MANUAL_PAYMENT_CONFIRMED`, `WAIVED`, `WRITTEN_OFF`, `LEGAL_COLLECTION`.
- Legal collection case/link with transferred amount, evidence-package hash, owner, external reference, judgment/settlement/execution events.

**Steps:**

1. Add RED tests for self-payment, partial payment, duplicate callback, manual payment with proof, deposit application/refund, waiver, write-off, and legal transfer.
2. Derive financial status from authoritative bills/payments/approvals/dispositions; clients cannot set it directly.
3. `LEGAL_COLLECTION` keeps bill remaining amount and never increments paid/write-off totals.
4. Actual court execution receipt uses the normal payment/write-off allocation path with legal source facts.
5. Keep `SettlementRevision.SETTLED` limited to no-open-debt outcomes.
6. Run finance/payment/closure tests and commit.

## Task C9: Separate operational completion from financial settlement

**Files:**

- Modify `apps/api/src/subscription-closure/subscription-closure.domain.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.service.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.repository.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.projection.ts`.
- Modify `apps/api/test/subscription-closure.domain.spec.ts`.
- Modify `apps/api/test/subscription-closure.service.spec.ts`.
- Modify `apps/api/test/subscription-closure.settlement.service.spec.ts`.
- Modify `apps/api/test/subscription-expiry-return.integration.spec.ts`.
- Modify `apps/api/test/subscription-closure.early-termination.service.spec.ts`.

**Steps:**

1. Add RED tests for operational completion with every open receivable explicitly assigned to collection/dispute/legal ownership, even when not financially settled.
2. Keep physical receipt, occupancy close, vehicle inspection/restriction, and availability evaluation unchanged.
3. Change completion gates from “every debt extinguished” to “every debt extinguished or explicitly governed by a non-terminal financial disposition”.
4. Complete/terminate order and contract based on closure type while preserving open receivable and financial status.
5. Prevent operational completion when a charge/bill is orphaned, unowned, or in an ambiguous payment state.
6. Prove later financial resolution does not reopen or rewrite the completed operational timeline.
7. Run Closure integration tests and commit.

## Task C10: Build the Admin three-stage workspace and governed upload UI

**Files:**

- Modify `apps/web/src/lib/subscription-closure-api.ts`.
- Modify `apps/web/src/lib/subscription-closure-view-model.ts`.
- Add `apps/web/src/components/subscription-closure/return-evidence-stage.tsx`.
- Add `apps/web/src/components/subscription-closure/return-pricing-stage.tsx`.
- Add `apps/web/src/components/subscription-closure/return-settlement-stage.tsx`.
- Add `apps/web/src/lib/subscription-return-upload.ts` by adapting the proven Field Handover upload state machine.
- Reuse/adapt `apps/web/src/components/field-handover-evidence-upload-controls.tsx` without coupling Admin auth to Field tokens.
- Modify `apps/web/src/app/orders/[id]/page.tsx`.
- Modify `apps/web/test/subscription-closure-view-model.spec.ts`.
- Add `apps/web/test/subscription-return-upload.spec.ts`.
- Add `apps/web/test/subscription-return-three-stage.spec.tsx`.
- Modify `apps/web/test/admin-order-workspace.spec.ts`.

**Steps:**

1. Add RED UI tests for checklist states, key/document/accessory quantities, direct file selection, progress/retry/preview/supersede, damage evidence binding, and the absence of URL text fields.
2. Render three stage cards with backend `allowedActions`, completion timestamps, blockers, and current financial status.
3. Implement pricing preview with contract clause, evidence, calculation, exception approval, and bill linkage.
4. Implement customer response, payment/manual/legal disposition panels with semantically distinct labels.
5. Preserve existing read-only timelines/audit links and make historical URLs visibly unverified.
6. Run Web tests, typecheck, lint, and commit.

## Task C11: Add Portal return response and active-payment UI

**Files:**

- Modify `apps/web/src/app/portal/orders/[id]/page.tsx`.
- Add `apps/web/src/app/portal/orders/[id]/return-settlement-panel.tsx`.
- Modify `apps/web/src/lib/subscription-closure-api.ts`.
- Modify `apps/web/src/lib/subscription-closure-view-model.ts`.
- Reuse the existing Portal payment-order entry.
- Add `apps/web/test/portal-subscription-return.spec.tsx`.
- Modify `apps/web/test/stage1-active-payment-portal.spec.tsx`.

**Steps:**

1. Add RED tests for manifest/document viewing, customer-visible evidence, clause/calculation display, accept, per-line dispute with upload, no internal approval leakage, and active payment.
2. Bind accept/dispute to exact settlement revision/hash.
3. Let the customer pay all or an allowed undisputed subset through the current active-payment flow.
4. After payment callback, refresh remaining due and response/disposition without duplicate confirmation.
5. Run Portal/Web tests and commit.

## Task C12: Add litigation-ready evidence-package export

**Files:**

- Add `apps/api/src/subscription-closure/subscription-closure-evidence-package.service.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.controller.ts`.
- Modify `apps/api/src/subscription-closure/subscription-closure.module.ts`.
- Add `apps/api/test/subscription-closure-evidence-package.spec.ts`.
- Add `apps/api/test/subscription-closure-evidence-package.integration.spec.ts`.

**Steps:**

1. Add RED tests for a deterministic package manifest containing contract/clauses, delivery/return signed artifacts, original files/hashes, delta/responsibility/charge revisions, notifications/customer responses, bills/payments/dispositions, and audit timeline.
2. Generate a read-only ZIP or manifest-backed bundle through authenticated storage; export must not mutate business state.
3. Hash each artifact and the package manifest; record the exported package version/hash only when attached to a legal-collection event.
4. Exclude internal secrets, provider credentials, and unrelated customer PII.
5. Run export tests and commit.

## Task C13: Add compatibility/backfill scripts and rollout controls

**Files:**

- Add `scripts/stage1-return-closure-backfill-core.mjs`.
- Add `scripts/stage1-return-closure-backfill.mjs`.
- Add `scripts/stage1-return-closure-backfill.test.mjs`.
- Modify `package.json`.
- Modify deployment/readiness documentation without secrets.

**Steps:**

1. Dry-run existing VehicleReturns/Closure Cases for legacy URLs, missing checklist items, missing delivery baseline, missing contract clause snapshots, and financial-status derivation.
2. Convert legacy URLs only to `LEGACY_EXTERNAL_REFERENCE` records with no fabricated checksum/capture metadata.
3. Backfill deterministic checklist/financial projections; report ambiguous clause/delta cases for manual review.
4. Add explicit `--apply`, exact counts, transaction batching, replay safety, and script tests.
5. Run dry-run against the dedicated test database and commit.

## Task C14: Full verification and PR C

**Steps:**

1. Run all Closure, return, handover evidence/PDF/e-sign, finance, payment, active-payment, contract, delta/pricing, legal-collection, and affected Admin/Portal suites.
2. Run Prisma validate/generate, migration checksum/status, API/Web/shared typecheck and lint.
3. Run backfill dry-run and verify no fixture residue or unintended writes.
4. Run `pnpm test` and `pnpm build`.
5. Recompute sample manifest/evidence-package hashes and inspect rendered return PDFs.
6. Verify failure injection for upload, payment unknown, inventory release retry, dispute revision, and legal transfer.
7. Update `ACC-20260826-05/06` with commits/test evidence, but close only after Staging verification.
8. Push PR C, require CI green, merge, deploy, then notify the user that the six-item manual acceptance may resume only after all A/B/C Staging smoke checks pass.
