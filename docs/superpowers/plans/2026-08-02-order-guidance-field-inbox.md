# Order Guidance and Field Inbox Implementation Plan

> **For Codex:** Execute this plan task by task with test-driven development. Keep PR A and PR B independently reviewable. Do not mix unrelated cleanup into either PR.

**Goal:** Remove false order-workspace blocking, prioritize initial billing before handover, repair Portal mobile billing cards, and make Stage 2 notification/receipt and Field task state accurately observable.

**Architecture:** Extend the existing order-workspace contributor model instead of adding a second workflow engine. Reuse existing handover work-order access timestamps plus authenticated audit logs for Field receipt, and keep notification recovery in the existing workflow-job mechanism. Render responsive/mobile behavior through small view-model or component seams that can be tested without browser-only business logic.

**Tech Stack:** NestJS, Prisma, Next.js App Router, React, Ant Design, Vitest, CSS modules.

---

## PR A — Order guidance and Portal billing UI

### Task 1: Correct contract blocking semantics

**Files:**
- Modify: `apps/api/test/order-workspace.spec.ts`
- Modify: `apps/api/src/order/order-workspace.service.ts`

**Step 1: Add failing resolver tests**

Add cases proving:

- `GENERATED` with a normal pending signing task is actionable and `blocking: false`.
- `SIGNING` is actionable and `blocking: false`.
- an authoritative failed contract workflow remains `blocking: true`.

**Step 2: Run the focused test and confirm RED**

```powershell
pnpm --filter @subscription-saas/api test -- order-workspace.spec.ts
```

Expected: the normal unsigned-contract cases fail because `resolveContract()` currently sets `blocking=true`.

**Step 3: Make the smallest resolver change**

Change `OrderWorkspaceResolver.resolveContract()` so only the explicit failure/recovery branch sets `blocking=true`. Preserve existing action codes and authoritative signed/archived behavior.

**Step 4: Run the focused test and confirm GREEN**

```powershell
pnpm --filter @subscription-saas/api test -- order-workspace.spec.ts
```

**Step 5: Commit**

```powershell
git add apps/api/test/order-workspace.spec.ts apps/api/src/order/order-workspace.service.ts
git commit -m "fix: avoid false contract blocking state"
```

### Task 2: Add initial-billing workspace guidance

**Files:**
- Modify: `apps/api/test/order-workspace.spec.ts`
- Modify: `apps/api/src/order/order-workspace.service.ts`
- Modify: `apps/web/test/admin-order-workspace.spec.ts`
- Modify: `apps/web/src/lib/admin-order-workspace.ts`

**Step 1: Add failing API tests**

Cover these cases in resolver/service tests:

- signed contract + positive monthly fee + missing first monthly bill produces `finance.generate_initial_bills`;
- zero deposit does not require a deposit bill;
- non-zero deposit missing its bill keeps the generate action;
- existing unpaid initial bill produces `finance.collect`, not generate;
- settled initial bills remove the finance candidate so handover can become primary;
- the new action is filtered by `BILLING_GENERATE` permission;
- the generate action is selected ahead of `handover.prepare`.

**Step 2: Confirm API RED**

```powershell
pnpm --filter @subscription-saas/api test -- order-workspace.spec.ts
```

**Step 3: Extend finance facts and loader**

In `loadFinance()` fetch the minimal order/contract and initial-bill facts needed to determine whether initial billing is missing. Add a typed initial-billing candidate to `FinanceWorkspaceFacts`, emit `finance.generate_initial_bills`, target the finance tab, and map it to `PermissionCode.BILLING_GENERATE`.

Use the signed/archived contract timestamp for ordering so the newly due billing step outranks a timestamp-less handover preparation suggestion. Do not add a database migration.

**Step 4: Add failing Web presentation tests**

Expect the action-code union and presentation map to support:

```text
finance.generate_initial_bills -> 生成初始账单 / FileAddOutlined
```

Also verify an unknown finance action still fails closed.

**Step 5: Confirm Web RED, implement mapping, confirm GREEN**

```powershell
pnpm --filter @subscription-saas/web test -- admin-order-workspace.spec.ts
```

Update `WorkspaceActionCode` and `WORKSPACE_ACTION_PRESENTATIONS`. The workspace action continues to navigate to the finance tab where the existing button performs generation.

**Step 6: Run both focused suites**

```powershell
pnpm --filter @subscription-saas/api test -- order-workspace.spec.ts
pnpm --filter @subscription-saas/web test -- admin-order-workspace.spec.ts
```

**Step 7: Commit**

```powershell
git add apps/api/test/order-workspace.spec.ts apps/api/src/order/order-workspace.service.ts apps/web/test/admin-order-workspace.spec.ts apps/web/src/lib/admin-order-workspace.ts
git commit -m "fix: prioritize initial billing after contract signing"
```

### Task 3: Rebuild Portal bill cards for mobile

**Files:**
- Create: `apps/web/src/app/portal/bills/portal-bill-card.tsx`
- Create: `apps/web/src/app/portal/bills/portal-bill-card.module.css`
- Modify: `apps/web/src/app/portal/bills/page.tsx`
- Create: `apps/web/test/portal-bill-card.spec.ts`

**Step 1: Extract a testable card seam and write failing rendering tests**

Test that a bill card:

- renders the full bill and order numbers in dedicated elements;
- separates metadata from actions;
- renders payment only for payable bills;
- always preserves the details action;
- exposes stable class hooks for the mobile actions row and long identifiers.

**Step 2: Confirm RED**

```powershell
pnpm --filter @subscription-saas/web test -- portal-bill-card.spec.ts
```

**Step 3: Implement responsive card and CSS module**

Use grid/flex with `minmax(0, 1fr)` and `min-width: 0`. At `max-width: 767px`, stack metadata and move actions to a full-width bottom row. Apply `overflow-wrap: anywhere` only to long identifiers, never by squeezing the entire metadata column to a few characters.

Replace the `List.Item` action-column layout in the page with the new card while preserving pagination, filters and navigation.

**Step 4: Confirm GREEN and run nearby Portal tests**

```powershell
pnpm --filter @subscription-saas/web test -- portal-bill-card.spec.ts portal-payment-order.spec.ts
```

**Step 5: Commit**

```powershell
git add apps/web/src/app/portal/bills apps/web/test/portal-bill-card.spec.ts
git commit -m "fix: make portal bill cards mobile responsive"
```

### Task 4: Verify and publish PR A

**Step 1: Run focused and package checks**

```powershell
pnpm --filter @subscription-saas/api test -- order-workspace.spec.ts
pnpm --filter @subscription-saas/web test -- admin-order-workspace.spec.ts portal-bill-card.spec.ts portal-payment-order.spec.ts
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/web lint
git diff --check origin/main...HEAD
```

**Step 2: Run the repository quality gate before completion claim**

```powershell
pnpm quality:gate
```

**Step 3: Push and open PR A**

Push `fix/staging-order-guidance-field-inbox-20260802`, open a PR describing issues 1–3, wait for checks, address review, and merge before creating PR B from the new `origin/main`.

---

## PR B — Notification receipt, Field inbox and evidence prompts

### Task 5: Correct notification copy and add bounded polling

**Files:**
- Modify: `apps/web/test/admin-stage2-handover-esign.spec.ts`
- Modify: `apps/web/src/lib/admin-stage2-handover-esign.ts`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Add or modify the nearest order-page behavior test under `apps/web/test/`

**Step 1: Add failing state-copy tests**

Assert:

- first-attempt `PENDING` means “发送中”;
- retry `PENDING` with a previous failure means “等待系统重试” and includes next-run time;
- `PROCESSING` means “发送中”;
- `COMPLETED` means “已发送”;
- `DEAD_LETTER` exposes the existing resend recovery action.

**Step 2: Confirm RED, implement the pure view-model change, confirm GREEN**

```powershell
pnpm --filter @subscription-saas/web test -- admin-stage2-handover-esign.spec.ts
```

**Step 3: Add a tested bounded polling helper**

Poll only initial `PENDING/PROCESSING` assignment jobs, stop on a terminal state, component unmount, or a fixed attempt/time limit. Do not continuously poll delayed retries.

**Step 4: Run focused tests and commit**

```powershell
pnpm --filter @subscription-saas/web test -- admin-stage2-handover-esign.spec.ts
git add apps/web/src/lib/admin-stage2-handover-esign.ts apps/web/src/app/orders/[id]/page.tsx apps/web/test
git commit -m "fix: reflect field assignment notification state"
```

### Task 6: Persist and expose Field task receipt

**Files:**
- Modify: `apps/api/test/field-operator-auth.spec.ts`
- Modify: `apps/api/test/handover-work-order.spec.ts`
- Modify: `apps/api/src/field-operator/field-operator-auth.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/handover-work-order/dto/...` or the existing Admin response type location
- Modify: the Admin Stage 2 Web view-model/component and its nearest test

**Step 1: Add failing API tests**

Prove that authenticated task viewing:

- initializes `firstAccessedAt` once;
- updates `lastAccessedAt` every time;
- writes `TASK_VIEWED` audit in the same transaction.

Prove that the Admin summary returns `OPENED` with first/last times and falls back to the earliest/latest authenticated audit record for historical rows whose access columns are null.

**Step 2: Confirm RED**

```powershell
pnpm --filter @subscription-saas/api test -- field-operator-auth.spec.ts handover-work-order.spec.ts
```

**Step 3: Implement without a migration**

Update `recordTaskViewed()` transactionally and add a safe receipt projection to the existing Admin DTO. Do not expose the Field phone, session or token in the receipt object.

**Step 4: Add Web tests and display**

Render “Field 尚未打开任务” or “Field 已接收任务 / 首次打开时间”. Keep SMS delivery and Field receipt as separate lines.

**Step 5: Run focused suites and commit**

```powershell
pnpm --filter @subscription-saas/api test -- field-operator-auth.spec.ts handover-work-order.spec.ts
pnpm --filter @subscription-saas/web test -- admin-stage2-handover-esign.spec.ts
git commit -m "fix: expose authenticated field task receipt"
```

### Task 7: Build Active/Ended Field inbox with stable sorting

**Files:**
- Modify: `apps/api/test/handover-work-order.spec.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/web/test/field-handover-view-model.spec.ts`
- Modify: `apps/web/test/field-handover-pages.spec.ts`
- Modify: `apps/web/src/lib/field-handover-view-model.ts`
- Modify: `apps/web/src/app/field/handover/tasks/page.tsx`

**Step 1: Add failing API sort/history tests**

Assert that active tasks prioritize actionable statuses and then newest assignment/creation, while ended tasks include completed/reviewed/cancelled/voided/failed and sort by latest update. Assert ended tasks remain readable but mutations still fail through existing editability guards.

**Step 2: Confirm RED and implement API behavior**

Remove the blanket hiding of ended assigned tasks. Return enough status/time data for deterministic grouping and ordering; do not let the Web page re-sort by scheduled time.

**Step 3: Add failing Web view-model/page tests**

Cover Active/Ended grouping, empty states, preserved API order, and badge tones for active/waiting/completed/failed/cancelled states.

**Step 4: Implement tabs and badge tones**

Use Ant Design `Tabs`, keep active as the default, show counts, and make ended task details read-only.

**Step 5: Run focused suites and commit**

```powershell
pnpm --filter @subscription-saas/api test -- handover-work-order.spec.ts
pnpm --filter @subscription-saas/web test -- field-handover-view-model.spec.ts field-handover-pages.spec.ts
git commit -m "fix: organize field handover task inbox"
```

### Task 8: Scope upload guidance to the walkaround item

**Files:**
- Modify: `apps/web/test/field-handover-upload.spec.ts`
- Modify: `apps/web/test/field-handover-pages.spec.ts`
- Modify: `apps/web/src/lib/field-handover-upload.ts`
- Modify: `apps/web/src/components/field-handover-evidence-upload-controls.tsx`
- Modify: `apps/web/src/app/field/handover/tasks/[id]/page.tsx`
- Add an API manifest-order assertion to the nearest delivery-evidence test if absent

**Step 1: Add failing prompt and order tests**

Assert that only `WALKAROUND_VIDEO` receives video-quality guidance; wheel closeups preserve photo/video inputs without that guidance. Assert walkaround precedes static damage closeup and the upload drawer still offers the approved capture/library entries.

**Step 2: Confirm RED, implement the type-aware guidance, confirm GREEN**

Pass evidence type into the upload controls or pass explicit guidance. Do not narrow server-side wheel media compatibility.

**Step 3: Commit**

```powershell
git commit -m "fix: scope handover media guidance by evidence type"
```

### Task 9: Verify and publish PR B

Run all focused suites from Tasks 5–8, API/Web typecheck and lint, then the full `pnpm quality:gate`. Push a new branch created from the post-PR-A `origin/main`, open PR B, wait for checks and review, and merge.

## Final staging verification

After both PRs merge and the new images deploy, verify against a new or safely repeatable staging order:

- no false contract block;
- initial billing is the primary next step after contract signing;
- mobile Portal bill cards remain readable;
- assignment changes automatically from sending to sent;
- Field opening changes the receipt from unopened to received;
- resend is present only for terminal notification failure;
- newest active Field task is easy to find and ended history remains readable;
- wheel prompts and evidence order match the accepted workflow;
- 1080P/720P video upload regression remains green.
