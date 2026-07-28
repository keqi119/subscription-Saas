# Stage 2 Final Delivery And Fallback Hardening Plan

> **For Codex:** Execute this plan test-first. Keep each task independently
> reviewable and commit after its focused tests pass.

**Goal:** Finish the confirmed Stage 2 rules: signed state is the delivery hard
gate, archive is a recoverable warning, signed state is monotonic, and Admin
fallback is a transactional exception after technical Field unavailability or
15 minutes without progress.

**Architecture:** Keep PostgreSQL as the source of truth. Derive delivery from
the exact current Stage 2 task and H1/H2 signer bindings. Derive fallback
eligibility from the current source `Contract.createdAt`, assigned Field
identity, and task/provider evidence using database time. Revalidate all
fallback predicates while holding the handover lock in the same serializable
transaction that creates the task and audit event.

**Tech Stack:** NestJS, Prisma/PostgreSQL, Next.js/React, Vitest/Jest, pnpm.

---

### Task 1: Separate Signing Completion From Archive Completion

**Files:**
- Modify: `apps/api/src/delivery-handover/delivery-handover.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Test: `apps/api/test/order-delivery.spec.ts`
- Modify: `apps/web/src/lib/admin-stage2-handover-esign.ts`
- Test: `apps/web/test/admin-stage2-handover-esign.spec.ts`
- Test: `apps/web/test/admin-stage2-handover-review.spec.ts`

1. Add failing tests proving exact current H1/H2 `SIGNED` state permits
   authorized delivery even when every signed archive field is null or failed.
2. Add failing tests proving either incomplete signer still blocks delivery.
3. Split signing-complete and archive-complete predicates.
4. Keep archive state visible as a warning/retry capability after delivery.
5. Run the focused API and Web tests and commit.

### Task 2: Make Provider Completion Monotonic

**Files:**
- Modify: `apps/api/src/esign/esign.service.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-esign.service.ts`
- Test: `apps/api/test/esign.spec.ts`
- Test: `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`

1. Add failing callback/query tests showing late `FAILED` or `REJECTED`
   observations cannot downgrade an exact signer that is already signed.
2. Add failing void/reissue tests for terminal local tasks that retain any exact
   provider transaction, claim, or signed evidence.
3. Implement monotonic state guards before any failure transition.
4. Make provider evidence block void/reissue regardless of local terminal
   status.
5. Append one bounded audit event for each successful void/reissue transition.
6. Run focused lifecycle tests and commit.

### Task 3: Implement The 15-Minute Transactional Admin Fallback

**Files:**
- Modify: `apps/api/src/handover-work-order/dto/start-stage2-handover-esign.dto.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.controller.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-esign.service.ts`
- Test: `apps/api/test/stage2-handover-esign.spec.ts`
- Test: `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`
- Modify: `apps/web/src/lib/handover-work-order-api.ts`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Test: `apps/web/test/admin-stage2-handover-review.spec.ts`
- Test: `apps/web/test/admin-stage2-handover-esign.spec.ts`

1. Add failing API tests for immediate technical-unavailability eligibility,
   denial before 15 minutes, eligibility at 15 minutes, stale source
   acknowledgement, missing/bad reason, and no-task/provider-action predicates.
2. Add a race test proving concurrent Field and Admin starts create one task.
3. Extend the Admin request with exact artifact version/hash acknowledgement
   and a bounded reason.
4. Compute the capability from database time. Start the normal timeout at the
   current canonical source PDF `Contract.createdAt`; SMS state is irrelevant.
5. In one serializable transaction, lock and reload the handover, revalidate
   eligibility and source binding, create at most one task, and append exactly
   one bounded `ADMIN_FALLBACK` audit event.
6. Render a compact Admin confirmation dialog with source PDF preview/download,
   required acknowledgement, and required reason. Trust only the authoritative
   API capability.
7. Run focused API/Web tests and commit.

### Task 4: Verify, Review, Publish, And Migrate

1. Run Prisma validate/generate, backfill tests, focused tests, repository lint,
   typecheck, all tests against a fresh PostgreSQL database, build, and
   `git diff --check`.
2. Request an independent code review and resolve every actionable finding.
3. Remove only this task's ignored SDD scratch directory.
4. Push the branch, open a ready PR, wait for CI, and merge.
5. Apply the additive Stage 2 Prisma migration to Staging using the existing
   API image's bundled Prisma CLI without running `pnpm install`.
6. Verify the migration count and latest migration. Do not switch application
   images; deployment remains a separate human step.
