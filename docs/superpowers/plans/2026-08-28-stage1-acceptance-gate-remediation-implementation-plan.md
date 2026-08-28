# Stage 1 Acceptance-Gate Remediation Implementation Plan

> **Execution rule:** The primary agent implements every production change directly. Do not use subagents or parallel implementation workers. Subagents may be used only after implementation for independent code review and acceptance verification. Use test-driven development for every behavior change and verification-before-completion before each PR.

**Goal:** Close the code-level blockers found in the 2026-08-28 acceptance audit so the six recorded Stage 1 issues can pass code inspection, automated browser verification, and then user-led manual acceptance.

**Architecture:** Preserve the existing Journey, contract-change, Closure, billing, payment, file, e-sign, and audit authorities. Repair missing production signals and recovery first, then replace synthetic contract completion with source-bound e-sign, and finally extend `SubscriptionClosureCase` into the approved three-stage return workflow. All new facts are forward-only, revisioned, auditable, and fail closed. Operational completion is separated from financial disposition without rewriting payment history.

**Tech stack:** NestJS 11, Prisma 7, PostgreSQL 17 test runtime, TypeScript 6, Vitest 4, Next.js 16, React 19, Ant Design 6, PDFKit, pnpm workspace.

**Base:** `origin/main@73ae3b580562822637c9d69ff1cb565b59387c51` in isolated worktree `stage1-acceptance-gate-remediation-20260828`.

**Approved designs and plans:**

- `docs/superpowers/specs/2026-08-26-stage1-golden-path-business-wait-and-single-confirmation-design.zh-CN.md`
- `docs/superpowers/specs/2026-08-26-stage1-active-term-contract-change-center-design.zh-CN.md`
- `docs/superpowers/specs/2026-08-26-stage1-return-evidence-contract-pricing-settlement-design.zh-CN.md`
- `docs/superpowers/plans/2026-08-26-stage1-return-evidence-contract-pricing-settlement-implementation-plan.md`

## Binding safety rules

- Do not modify historical migrations, use `prisma db push`, reset a database, or fabricate missing business facts.
- All money remains integer cents and every new status is an enum or a validated finite code set.
- Every critical command requires permission, expected version, idempotency key, immutable receipt, and audit evidence.
- Normal business waits, customer refusal/absence, disputes, and legal collection never become technical dead letters.
- No source-facts, BASE, Stage 1C, return backfill, seed, or historical repair `apply` is authorized by implementation approval. All rollout tools remain dry-run-first with a separate exact apply flag.
- Contract generation and image deployment approvals never authorize data repair.
- Existing `VehicleReturnDamage.photoUrls` remains readable only as unverified legacy history. New managed return commands reject arbitrary external URLs.
- Four contract-change feature flags remain off until code gates, source-facts/BASE/Stage 1C replays, and browser smoke all pass.

## Delivery sequence

The work is split into three reviewable PRs because R2 depends on the corrected Journey/handover facts and R3 depends on the corrected contract-change/Closure boundary.

1. **PR R1 — Golden Path recovery and delivery evidence:** production mutation signals, terminal cleanup, vehicle-registration approval, explicit handover facts, and PDF/evidence manifest.
2. **PR R2 — Contract-change execution safety:** real e-sign, billing dead-letter exclusion, Portal idempotency, managed-other supplements, server-driven UI and rollout guards.
3. **PR R3 — Three-stage return closure:** governed evidence, return manifest, delta and contract pricing, customer response, financial/legal disposition, dual-axis completion, Admin/Portal workspaces, export and rollout tools.

Do not start browser acceptance after R1 or R2. Browser acceptance begins only after R3 is merged, deployed, and all three PR smoke gates pass.

---

## PR R1: Golden Path production signals and handover evidence

### Task R1.0: Capture every audited failure as a RED test

**Files:**

- Modify `apps/api/test/application-review-api.spec.ts`.
- Modify `apps/api/test/portal-application.spec.ts`.
- Modify `apps/api/test/subscription-journey-application.spec.ts`.
- Modify `apps/api/test/subscription-journey-failure-recovery.e2e-spec.ts`.
- Modify `apps/api/test/handover-work-order.spec.ts`.
- Modify `apps/api/test/stage2-handover-esign-readiness.spec.ts`.
- Modify `apps/api/test/delivery-handover-pdf-renderer.service.spec.ts`.
- Modify `apps/web/test/subscription-journey-admin-ui.spec.tsx`.
- Modify the existing Stage 2 Admin handover UI tests.

**RED behaviors:**

1. Admin `NEED_MORE_INFO`, general supplement request, customer resubmission, reject, and cancel each produce a new versioned Journey fact in the same transaction as the Application mutation.
2. Customer resubmission uses a new event identity/fact version and re-runs validation from `WAITING_CUSTOMER`.
3. Reject/cancel closes the Journey and open tasks, releases the owned vehicle reservation, clears every Application soft-reservation field, and is replay-safe.
4. A missing vehicle registration document blocks sign readiness unless a current, approved exception is bound to the same vehicle/document snapshot.
5. Vehicle condition, keys, registration document, and accessories are independently required and independently projected into the handover PDF/manifest.

Run only these focused tests and confirm failures are missing production behavior rather than fixture/type failures. Commit RED tests separately.

### Task R1.1: Centralize versioned Application fact signaling and terminal cleanup

**Files:**

- Modify `apps/api/src/customer/customer.service.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey-signal.service.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey.service.ts`.
- Modify `apps/api/src/subscription-journey/subscription-journey.repository.ts` only if a terminal receipt/lock helper is required.

**Steps:**

1. Introduce one transaction-scoped helper for every Journey-relevant Application mutation. It increments `journeyFactVersion`, emits an exact target/fact/source-action payload, and returns the committed version.
2. Route material review, supplement request, credit/deposit/product review, customer supplement resubmission, reject, and cancel through that helper.
3. Replace fixed resubmission event identity with version-bound identity; stale or duplicate signals remain no-op successes.
4. Make reject/cancel cleanup one caller-owned transaction: close tasks/jobs, move Journey to the correct business terminal, release only the reservation owned by this Application, clear `softReservedVehicleId/At/ExpiresAt`, and audit before/after facts.
5. Add concurrency tests for approve/reject, repeat reject/cancel, and late fact delivery.

### Task R1.2: Add governed vehicle-registration exception approval

**Files:**

- Modify `apps/api/prisma/schema.prisma` only if the current approval entity cannot bind vehicle/document snapshot immutably.
- Add a new forward migration under a `20260828...` timestamp when schema changes are required.
- Modify `apps/api/src/asset-accounting/asset-accounting.controller.ts` or add a narrowly scoped handover approval controller/service.
- Modify `apps/api/src/handover-work-order/stage2-handover-esign-readiness.service.ts`.
- Modify the Stage 2 Admin handover page/API client.
- Modify permission, seed, menu, and label sources together if a new permission is needed.

**Behavior:**

1. Missing registration evidence produces a stable readiness blocker, not a dead letter.
2. Authorized Admin can create, approve, or reject an exception with reason and exact vehicle/document snapshot hash.
3. Approval for an older document snapshot cannot release a newer blocker.
4. Rejection remains actionable; replacement evidence or a new approval request can continue the flow.
5. Every decision is audited and customer-facing projections reveal no internal approval notes.

### Task R1.3: Add explicit delivery handover facts and signed PDF content

**Files:**

- Modify `apps/api/prisma/schema.prisma` and add a forward migration for explicit immutable handover fact snapshot/fields.
- Modify `apps/api/src/handover-work-order/handover-work-order.dto.ts`.
- Modify `apps/api/src/handover-work-order/handover-work-order.service.ts`.
- Modify `apps/api/src/delivery-handover/delivery-handover-pdf-render-model.ts`.
- Modify `apps/api/src/delivery-handover/delivery-handover-pdf-renderer.service.ts`.
- Modify `apps/api/src/delivery-handover/delivery-handover-evidence-manifest.ts`.
- Modify the Admin/field handover forms and view models.

**Data contract:**

- Vehicle-condition confirmation and remarks.
- Primary/spare key counts and state.
- Registration-document state and governed evidence/approval reference.
- Versioned accessory item list with quantity/state/remark.
- Stable fact snapshot hash included in customer confirmation and PDF generation.

**Steps:**

1. New submissions require all four fact groups; historical free-text `accessoryChecklist` remains read-only compatibility input.
2. A changed fact snapshot invalidates the old customer confirmation/signing artifact through existing source-bound durability rules.
3. Render four distinct sections in the PDF. Never reuse one free-text string for documents and tools.
4. Include fact codes, values, evidence IDs/hashes, revision and manifest hash in the evidence manifest.
5. Render a real PDF fixture and extract text to prove all independent values are present.

### Task R1.4: Verify and merge PR R1

Run focused A/Stage 2 tests, Prisma validate/generate, migration checksum/status on a fresh dedicated database, API/Web typecheck and lint, then full API/Web/shared tests and builds. Review the diff for secrets and unrelated files. PR R1 must have green CI before merge.

---

## PR R2: Contract-change execution safety

Create a new worktree/branch from merged R1.

### Task R2.0: Add RED tests for the four audited contract-change failures

**Files:**

- Modify `apps/api/test/subscription-early-termination-change.spec.ts`.
- Add/modify early-termination e-sign E2E tests.
- Modify `apps/api/test/subscription-managed-other.spec.ts`.
- Modify `apps/api/test/portal-subscription-change-routing.spec.ts`.
- Modify `apps/api/test/billing-automation-service.spec.ts`.
- Modify `apps/api/test/billing-automation-worker.spec.ts`.
- Modify affected Web change-center tests.

**RED behaviors:**

1. Early termination cannot reach `SCHEDULED` until a real customer/provider e-sign task is signed and its signed artifact archived.
2. Source and signed documents are renderable contract/PDF artifacts, never synthetic JSON marked complete by an Admin actor.
3. A reconciliation-blocked order cannot enqueue, execute, retry, or dead-letter a billing job while healthy orders continue.
4. Portal confirm/reject for swap and other writes replays the same result for the same idempotency key and rejects payload drift.
5. Managed-other operations that change customer rights can generate, sign, archive and bind a governed supplement without hand-entering an internal contract ID.

### Task R2.1: Reuse one source-bound supplemental-contract/e-sign pipeline

**Files:**

- Add a shared subscription-change supplemental-contract orchestrator or extend the existing source-bound contract services.
- Modify `subscription-early-termination-change.service.ts`.
- Modify `subscription-managed-other.service.ts`.
- Modify `subscription-change.controller.ts`, job service and worker.
- Modify Portal controllers/services/pages for customer signing entry and status.

**Steps:**

1. Generate customer-visible PDF content from the immutable confirmed revision and contract clauses.
2. Start/retry one source-bound e-sign task using the configured provider; provider pending remains business waiting.
3. Accept only provider-confirmed signed artifacts and archive evidence before changing to `SCHEDULED`.
4. Replays return the same contract/task; revision drift supersedes rather than overwrites.
5. Customer reject/cancel before archive restores original performance and releases the active-change slot.

### Task R2.2: Make billing source-fact blockers fail closed before enqueue

**Files:**

- Modify `billing-automation.service.ts` and `billing-automation.worker.ts`.
- Modify billing schedule/audit schema only if a durable pause reason cannot be represented safely today.

**Steps:**

1. Reconciliation produces a durable blocked-order/schedule decision before enqueue.
2. `enqueueDueSchedules` excludes unresolved segment/source-fact blockers in its authoritative query or caller-owned transaction.
3. Existing pending/retry jobs for a newly blocked schedule become governed paused/cancelled facts, not dead letters.
4. Repairing facts and a later successful reconciliation can safely resume the schedule exactly once.
5. Two-order tests prove one bad order cannot block or poison a healthy billing cycle.

### Task R2.3: Complete write idempotency, permissions, flags and server-driven actions

**Files:**

- Modify Portal controller/service and `portal-api.ts` to require/send `Idempotency-Key` plus expected version.
- Synchronize shared auth, seed, menus, backend guards, Web button guards and labels.
- Return feature availability and `allowedActions` from the backend; remove duplicated permissive Web transitions.
- Hide or clearly disable a change type when its exact feature flag is false.

### Task R2.4: Verify and merge PR R2

Run all subscription-change, extension, swap, early-termination, managed-other, e-sign, Closure boundary, billing automation and affected Web suites; then full quality gates and fresh-database migration proofs. Keep all four flags off in deployment examples until R3 and source-fact rollout are verified. Merge only with green CI.

---

## PR R3: Three-stage return evidence, pricing and disposition

Create a new worktree/branch from merged R2. Execute Tasks C0-C14 from `2026-08-26-stage1-return-evidence-contract-pricing-settlement-implementation-plan.md` with the following binding refinements from the audit.

### Task R3.0: RED acceptance spine first

Add the missing API/Web tests named by the approved C plan before production implementation. The first E2E must cover:

1. Governed upload and checklist/damage ownership.
2. Customer-signed and unilateral return-manifest paths.
3. Delivery-return delta and contract-clause charge preview.
4. Customer accept, partial dispute, full dispute and no response.
5. Active payment, manual confirmed payment, waiver/write-off approval and legal collection.
6. Vehicle inventory release and operational order completion while an explicitly owned legal receivable remains open.

### Task R3.1: Forward schema foundation

Use new migrations ordered after all existing migrations; do not reuse the historical `2026082603...` example timestamps in the older plan. Implement:

- structured checklist and governed evidence owner links;
- return attestation and immutable manifest revision facts;
- immutable condition-delta revision/items;
- executable contract charge-clause snapshots;
- immutable charge lines and bill provenance;
- revision-bound customer responses/disputes;
- closure financial status, receivable dispositions and legal-collection facts.

Each migration gets schema assertions, PostgreSQL constraint proofs, checksum verification and forward-only compatibility behavior.

### Task R3.2: Governed return evidence and manifest

Implement Closure-scoped multipart upload using existing storage limits and file authority. New commands reject `photoUrls`. Evidence binds to exactly one checklist item or damage and supports immutable supersession. Render a readable return PDF with checklist, keys, registration, accessories, damage evidence index, attestation mode, document revision, manifest hash and evidence-manifest hash. Refused/absent customers use a labelled unilateral artifact and never a synthesized signature.

### Task R3.3: Delta, executable contract clauses and formal pricing

Resolve delivery baseline only from archived/signed handover facts. Generate immutable delta revisions. Compile charge clauses in the same transaction as every new/changed contract. Formal charge lines must bind exact delta item, clause, evidence, responsibility, calculation, exception approval and bill. Disable the legacy direct damage-fee path for managed Closure cases. Missing clause/evidence creates a pricing exception and cannot create a formal bill.

### Task R3.4: Customer response, active payment and financial/legal disposition

Add Portal/Admin commands bound to exact settlement revision/hash. A changed amount always creates a successor revision. Active payment may select only allowed undisputed lines. Manual payment requires governed proof and review. Payment allocation, waiver, write-off and legal collection remain separate commands, permissions and audit events. `LEGAL_COLLECTION` preserves outstanding receivable and never increases paid/write-off totals.

### Task R3.5: Separate operational and financial completion

The operational closure gate accepts only debts with an explicit authoritative disposition owner. Vehicle physical control, inspection/reconditioning, inventory release, order/contract terminal state and change-order completion do not wait for litigation. `SettlementRevision.SETTLED` remains limited to zero open debt. Later receipts or dispositions must not reopen or rewrite the operational timeline.

### Task R3.6: Build Admin/Portal three-stage workspaces

Admin displays backend-driven stages/actions/blockers for evidence, pricing and disposition. Portal displays authorized evidence, clauses/calculations, exact-revision accept/dispute, and active payment without internal approval/legal notes. Reuse the proven Field upload state machine; no URL text field may remain in the managed return workflow. Historical URLs are read-only and visibly unverified.

### Task R3.7: Evidence export, dry-run backfill and rollout controls

Produce deterministic evidence manifest/package export without mutating business state. Add dry-run-first compatibility tooling for historical URLs/checklists/clauses/financial projection with exact apply confirmation and fail-closed ambiguity reporting. Package scripts and Docker runtime media must include every rollout tool. No Staging apply is performed without separate approval.

### Task R3.8: Verify and merge PR R3

Run every C-plan focused suite, real PDF render/text/hash checks, Prisma validate/generate, fresh-database migration deploy/status/checksum, API/Web/shared typecheck/lint/test/build, dry-run/replay tools, and security review for PII/object-key/credential leakage. Merge only with green CI.

---

## Post-merge deployment and acceptance gates

1. Build one immutable API/Web tag from merged R3 `main`; verify both registry manifests and digests before changing Staging.
2. Create a fresh database backup with SHA-256.
3. Pull images, run migration deploy/status/checksum, start API/Web and wait for healthy/public 200.
4. Run source-facts, BASE, Stage 1C and return compatibility dry-runs only. Stop for separately named apply approvals.
5. Keep contract-change flags off until authorized repairs/replays are clean. Enable one flag at a time for automated smoke and retain a rollback value.
6. Run Stage 1 code audit again. Any P0/P1 or unconsumed state stops the release.
7. Run browser visual acceptance for Admin and Portal entry visibility, helper text, enabled/disabled reasons, file upload/preview/retry, document viewing, four change types, three return stages, customer response and payment.
8. Only after code and browser reports pass, notify the user to begin manual acceptance with the six recorded issues.

## Completion evidence

Each PR report must record changed files, behavior, RED/GREEN tests, focused/full counts, migration count/status/checksum, known limitations, CI URL/SHA, Staging image digest, dry-run reports and explicit non-actions. An implementation is not “complete” merely because code compiles or a UI entry renders.
