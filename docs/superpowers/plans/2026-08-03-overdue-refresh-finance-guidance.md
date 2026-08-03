# Overdue Refresh and Finance Guidance Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface future-due unsettled bills as non-blocking collection guidance and make formal overdue refresh auditing UUID-safe and transactionally atomic.

**Architecture:** Keep the existing order-workspace contributor model and change only the representation of future-due receivables. Extend the shared audit writer so callers may supply a Prisma transaction client, then move overdue-refresh summary and collection-case audit writes into the same transaction as bill and case mutations. Preserve dry-run behavior, due-date semantics, permissions, bill maturity, and all database schemas.

**Tech Stack:** NestJS, TypeScript, Prisma 7, PostgreSQL, Vitest, pnpm.

---

## Preconditions and scope guard

- Work only in branch `fix/staging-overdue-refresh-finance-guidance-20260803` and its isolated worktree.
- The design is approved in `docs/superpowers/specs/2026-08-03-overdue-refresh-finance-guidance-design.md`.
- Do not add a Prisma migration or change T+5 bill maturity.
- Do not change frontend components: existing `WAITING_EXTERNAL` and `finance.collect` rendering is reused.
- Keep overdue eligibility as `dueDate < asOfDate`; the due date itself remains non-overdue.

### Task 1: Add future-due finance guidance with a regression test

**Files:**
- Modify: `apps/api/test/order-workspace.spec.ts`
- Modify: `apps/api/src/order/order-workspace.service.ts`

**Step 1: Write the failing workspace resolver test**

Add a focused test beside the existing finance representative tests. It must pass a `PENDING` bill whose `dueDate` is later than `asOf` and assert all of these fields:

```ts
expect(item).toEqual(
  expect.objectContaining({
    actionCode: "finance.collect",
    blocking: false,
    reasonCode: "FINANCE_PAYMENT_NOT_DUE",
    state: "WAITING_EXTERNAL",
    targetRecordId: "future-bill"
  })
);
```

Use an explicit `updatedAt` and also assert that it remains the representative timestamp. This protects the existing sorting behavior.

**Step 2: Run the focused test and confirm RED**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- test/order-workspace.spec.ts -t "keeps a future-due unsettled bill visible as non-blocking payment guidance"
```

Expected failure: current output is `state: "COMPLETED"` with `actionCode: null`.

**Step 3: Implement the smallest resolver change**

In `resolveFinanceContributor`, keep the current `due` calculation and reason codes. For receivables:

```ts
state: due ? "ACTION_REQUIRED" : "WAITING_EXTERNAL"
actionCode: "finance.collect"
```

Do not alter the due/overdue branch, record target, or timestamp selection.

**Step 4: Run focused and complete workspace tests**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- test/order-workspace.spec.ts -t "keeps a future-due unsettled bill visible as non-blocking payment guidance"
pnpm --filter @subscription-saas/api test -- test/order-workspace.spec.ts
```

Expected: both commands pass; existing due and overdue finance tests remain green.

**Step 5: Commit Task 1**

```powershell
git add apps/api/test/order-workspace.spec.ts apps/api/src/order/order-workspace.service.ts
git commit -m "fix: surface pending finance collection guidance"
```

### Task 2: Make overdue-refresh auditing UUID-safe and atomic

**Files:**
- Modify: `apps/api/test/finance-billing.spec.ts`
- Modify: `apps/api/src/audit/audit.service.ts`
- Modify: `apps/api/src/finance/finance.service.ts`

**Step 1: Strengthen the finance test transaction harness**

Update the in-memory `$transaction` mock to snapshot the mutable finance state before invoking the callback and restore it if the callback throws. Include bills, collection cases, collection-case bill links, payments, write-offs, ledgers, automation jobs, returns, and the order record so the fake exhibits the rollback guarantee the production test is about. Expose the callback client on the returned harness as `transactionClient` for an explicit audit-boundary assertion.

This is test infrastructure only; run the existing finance suite after the change to ensure the stronger fake does not alter successful paths.

**Step 2: Write failing overdue-refresh tests**

Add these focused cases under `overdue collection backend loop`:

1. `uses a UUID refresh audit id and writes refresh audits through the transaction client`
   - Create one overdue bill and execute a formal refresh.
   - Locate the `overdue_refresh` audit call.
   - Assert `entityId` matches the canonical UUID shape.
   - Assert the second argument is `harness.transactionClient`.
   - Also assert created collection-case audit writes use the same client.

2. `rolls back overdue mutations when an in-transaction audit write fails`
   - Create one overdue bill.
   - Make `auditService.write` reject with `new Error("audit failed")`.
   - Assert formal refresh rejects.
   - Assert the source bill is still `PENDING` and collection cases / links are empty.

The existing dry-run test continues to assert that no audit is written.

**Step 3: Run focused tests and confirm RED**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- test/finance-billing.spec.ts -t "uses a UUID refresh audit id"
pnpm --filter @subscription-saas/api test -- test/finance-billing.spec.ts -t "rolls back overdue mutations when an in-transaction audit write fails"
```

Expected failures before production changes:

- Refresh audit `entityId` is `overdue-refresh-YYYY-MM-DD`, not a UUID, and no transaction client is passed.
- Audit rejection occurs after the transaction has committed, so mutated bills/cases remain in the fake store.

**Step 4: Allow audit writes to use a transaction client**

In `apps/api/src/audit/audit.service.ts`, define a narrow client type:

```ts
type AuditWriteClient = Pick<Prisma.TransactionClient, "auditLog">;
```

Change `write` to accept an optional second parameter defaulting to the root Prisma service:

```ts
async write(input: WriteAuditLogInput, client: AuditWriteClient = this.prisma) {
  await client.auditLog.create(...);
}
```

All existing one-argument callers must remain source-compatible.

**Step 5: Move formal refresh audit writes into the business transaction**

In `apps/api/src/finance/finance.service.ts`:

- Import `randomUUID` from `node:crypto`.
- Generate one `refreshAuditEntityId` after the dry-run early return and before entering the formal transaction.
- After bill/case/link mutations but before returning from the transaction callback, write:
  - the `overdue_refresh` summary audit with `entityId: refreshAuditEntityId`;
  - one CREATE audit for every created collection case;
  - one UPDATE audit for every updated collection case.
- Pass `tx` as the second argument to every audit write.
- Preserve `asOfDate`, `billIds`, `dryRun`, and `overdueBillCount` in the refresh audit snapshot.
- Remove the equivalent post-transaction audit block.

If any audit insert fails, the callback throws and Prisma rolls back bill, case, link, and audit writes together.

**Step 6: Run focused and complete finance tests**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- test/finance-billing.spec.ts -t "uses a UUID refresh audit id"
pnpm --filter @subscription-saas/api test -- test/finance-billing.spec.ts -t "rolls back overdue mutations when an in-transaction audit write fails"
pnpm --filter @subscription-saas/api test -- test/finance-billing.spec.ts
```

Expected: all pass, including existing dry-run, due-day exclusion, idempotent case update, action, and close tests.

**Step 7: Commit Task 2**

```powershell
git add apps/api/test/finance-billing.spec.ts apps/api/src/audit/audit.service.ts apps/api/src/finance/finance.service.ts
git commit -m "fix: make overdue refresh auditing atomic"
```

### Task 3: Run repository gates and review the final diff

**Files:**
- Verify only; no expected source changes.

**Step 1: Run targeted regression together**

```powershell
pnpm --filter @subscription-saas/api test -- test/finance-billing.spec.ts test/order-workspace.spec.ts
```

**Step 2: Run API static checks**

```powershell
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api lint
```

**Step 3: Run Prisma and migration gates**

Reuse the configured staging-development `DATABASE_URL` only in process memory and run:

```powershell
pnpm prisma:validate
pnpm prisma:migrate:status
```

Expected: Prisma schema is valid and no migration is pending. No migration file should appear in the diff.

**Step 4: Run the complete API test suite**

```powershell
pnpm --filter @subscription-saas/api test
```

If this is materially longer than expected, continue to provide concise progress updates; do not replace it with only targeted tests.

**Step 5: Inspect scope and commits**

```powershell
git status --short
git diff main...HEAD --stat
git diff main...HEAD --check
git log --oneline --decorate main..HEAD
```

Confirm:

- no secret or environment file is tracked;
- no database schema or migration changed;
- only the approved design, plan, tests, audit boundary, finance refresh, and workspace resolver changed;
- the future-due bill is non-blocking but actionable;
- the formal overdue refresh audit ID is a UUID and audit failure rolls back the business transaction.

**Step 6: Request code review and address only evidence-backed findings**

Use the repository review workflow after all gates pass. If review finds a defect, reproduce it with a failing test before changing production code, rerun the relevant gates, and commit the correction separately.

**Step 7: Final handoff**

Report the branch, commits, changed files, exact test/gate results, migration status, and staging acceptance sequence:

1. Deploy the new API/Web images with migration-before-health ordering.
2. Before 2026-08-08, verify bill `BIL202608030253554RWU` appears in the finance tab as waiting/non-blocking with collection entry.
3. Verify dry run on 2026-08-08 still finds no overdue bill.
4. Verify formal refresh on 2026-08-09 succeeds and creates/updates the collection case without HTTP 500.

