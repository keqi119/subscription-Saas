# Stage 2 Archived Stage 1 Contract PDF Readiness Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Stage 2 handover PDF generation after the related Stage 1 contract has advanced from `SIGNED` to `ARCHIVED` without weakening other readiness gates.

**Architecture:** Keep the existing Stage 2 PDF generation pipeline and change only its local Stage 1 contract-status predicate. Prove the production incident with a focused unit regression, preserve fail-closed behavior for pre-signature states, then use the existing durable workflow retry path to recover the staging order.

**Tech Stack:** TypeScript, NestJS, Prisma, Vitest, PostgreSQL-backed Stage 2 workflow jobs.

## Global Constraints

- Valid completed Stage 1 states for Stage 2 PDF generation are exactly `ContractStatus.SIGNED` and `ContractStatus.ARCHIVED`.
- All other states and a missing Stage 1 contract remain rejected by the existing business error.
- Do not change the database schema, API contract, UI, PDF contents, evidence bindings, Fadada integration, or Stage 1 lifecycle.
- Do not rewrite an archived Stage 1 contract back to `SIGNED`.
- Preserve workflow idempotency and reuse the existing handover, confirmation, and workflow job.

---

### Task 1: Accept Archived Stage 1 Contracts At The Stage 2 PDF Gate

**Files:**
- Modify: `apps/api/test/stage2-handover-pdf.spec.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts:3236-3245`

**Interfaces:**
- Consumes: `ContractStatus`, `HandoverWorkOrderService.ensureStage2HandoverPdf(id, expectedManifestHash, options)` and the existing Stage 2 PDF test harness.
- Produces: a Stage 2 PDF prerequisite that accepts only `SIGNED | ARCHIVED` as completed Stage 1 contract states.

- [ ] **Step 1: Add the archived-contract regression and invalid-state boundary tests**

Add these focused cases beside the existing Stage 2 PDF generation tests:

```ts
it("generates the Stage 2 source PDF when the Stage 1 contract is archived", async () => {
  const harness = createServiceHarness();
  Object.assign(harness.records.handover.stage1Contract, {
    status: ContractStatus.ARCHIVED
  });

  await expect(
    ensureStage2HandoverPdf(
      harness.service,
      "work-order-1",
      harness.currentManifestHash
    )
  ).resolves.toMatchObject({ status: "GENERATED" });
});

it("rejects Stage 2 source PDF generation before the Stage 1 contract is signed", async () => {
  const harness = createServiceHarness();
  Object.assign(harness.records.handover.stage1Contract, {
    status: ContractStatus.GENERATED
  });

  await expect(
    ensureStage2HandoverPdf(
      harness.service,
      "work-order-1",
      harness.currentManifestHash
    )
  ).rejects.toThrow("Stage 1 合同尚未完成签署");
  expect(harness.renderer.renderToFile).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- stage2-handover-pdf.spec.ts
```

Expected: the archived-contract case fails with `Stage 1 合同尚未完成签署`; the invalid-state boundary case passes.

- [ ] **Step 3: Implement the minimal completed-state predicate**

Change only the Stage 1 status check inside
`assertStage2HandoverPdfGenerationPrerequisites`:

```ts
const stage1ContractStatus = readString(stage1Contract, "status");
if (
  !stage1Contract ||
  (
    stage1ContractStatus !== ContractStatus.SIGNED &&
    stage1ContractStatus !== ContractStatus.ARCHIVED
  )
) {
  throw new BadRequestException(
    "Stage 1 合同尚未完成签署，不能生成车辆交接确认单 PDF。"
  );
}
```

Do not modify any downstream rendering, reservation, storage, or workflow code.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- stage2-handover-pdf.spec.ts
```

Expected: the suite passes with 38 tests, including both new cases.

- [ ] **Step 5: Run the API verification subset**

Run:

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/api test -- stage2-handover-pdf.spec.ts stage2-handover-workflow-recovery.spec.ts stage2-handover-esign-readiness.spec.ts
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected: Prisma schema valid, API typecheck passes, all selected tests pass, and all 90 migrations are applied.

- [ ] **Step 6: Commit the production fix**

```powershell
git add -- apps/api/test/stage2-handover-pdf.spec.ts apps/api/src/handover-work-order/handover-work-order.service.ts
git commit -m "fix: allow archived stage1 contract for handover pdf"
```

### Task 2: Recover And Verify The Existing Staging Workflow

**Files:**
- No repository files changed.

**Interfaces:**
- Consumes: deployed API image containing Task 1, workflow job `8002489e-5a55-4bc7-a018-2a20f08aeacc`, work order `034dbf32-b1e4-48fb-9e9e-bda4c9f658b0`, and handover `c7905a85-2c74-4a5e-bf75-bed4aa0351a9`.
- Produces: one generated Stage 2 source artifact and the next durable workflow step for order `ORD20260814085019DMGZ`.

- [ ] **Step 1: Verify the deployed API identity and database state**

Confirm the running API image contains the merged fix commit. Query the workflow job, handover, Stage 1 contract, and related artifact counts before recovery. Expected preconditions:

```text
Stage 1 contract status = ARCHIVED
work order status = CUSTOMER_CONFIRMED
handover source document = absent
GENERATE_SOURCE_PDF job = retryable or dead-lettered
```

- [ ] **Step 2: Reactivate only the existing failed workflow step**

Use the existing Admin retry action or the repository's audited workflow retry service. Do not create another work order, handover, customer confirmation, or workflow identity.

Expected: the existing logical `GENERATE_SOURCE_PDF` operation becomes runnable once.

- [ ] **Step 3: Verify source-PDF completion and idempotency**

Wait for the worker, then verify:

```text
handover status = SOURCE_GENERATED or a later legal state
sourceDocumentFileId = present
handoverContractId = present
manifestHash = the confirmed evidence manifest
GENERATE_SOURCE_PDF = COMPLETED
NOTIFY_FIELD_ESIGN_READY = present or completed
duplicate Stage 2 contract count = 0
duplicate source FileObject count = 0
```

- [ ] **Step 4: Hand off the next Golden Path acceptance action**

Report the exact next user-facing action: field operator PDF review/e-sign initiation, customer Stage 2 signing, platform seal/archive, or Admin final delivery confirmation. Include any remaining blocker without mutating unrelated data.
