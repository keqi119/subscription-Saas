# Stage 1 Contract Template Selection Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Stage 1 contract generation selects only the active `SUBSCRIPTION_STANDARD` template, while a missing but generatable contract is shown as actionable rather than blocked.

**Architecture:** Keep template selection at the existing `OrderService.generateContract` persistence boundary and add the missing `ContractTemplateType.SUBSCRIPTION_STANDARD` predicate. Keep Stage 2 handover selection unchanged because it already filters `DELIVERY_HANDOVER`. Correct only the no-contract branch in `OrderWorkspaceResolver`; actual provider failures and dependency blockers retain their existing states.

**Tech Stack:** NestJS, TypeScript, Prisma, Vitest, Next.js/Ant Design, Docker Compose Staging deployment.

## Global Constraints

- Preserve the active `SUBSCRIPTION` product line and do not expose `RENT_TO_OWN`.
- Keep all existing contract status transitions and audit writes.
- Do not add a Prisma migration; this is a query and state-resolution correction.
- Use TDD: each production behavior must fail before the implementation is changed.
- Do not overwrite a generated or signed PDF; cancel and regenerate the affected unsigned contract through supported APIs after deployment.

---

### Task 1: Constrain Stage 1 contract template selection

**Files:**
- Modify: `apps/api/test/order-contract.spec.ts`
- Modify: `apps/api/src/order/order.service.ts`

**Interfaces:**
- Consumes: `ContractTemplateType.SUBSCRIPTION_STANDARD` from `@prisma/client`.
- Produces: `OrderService.generateContract()` always persists a `Contract.contractVersionId` whose `ContractVersion.templateType` is `SUBSCRIPTION_STANDARD`.

- [ ] **Step 1: Write the failing test**

Add a test that generates a Stage 1 contract while the fake repository exposes a newer active `DELIVERY_HANDOVER` template and an older active `SUBSCRIPTION_STANDARD` template. Assert the persisted `contractVersionId`, title, and PDF render model use the standard template.

```ts
it("selects only the active subscription-standard template for Stage 1", async () => {
  const harness = createOrderServiceHarness({
    resolveContractVersion: ({ where }, standardTemplate) =>
      where.templateType === ContractTemplateType.SUBSCRIPTION_STANDARD
        ? standardTemplate
        : newerDeliveryHandoverTemplate
  });

  await harness.service.generateContract(harness.orderId, harness.user, harness.context);

  expect(harness.state.contracts[0]).toMatchObject({
    contractTitle: `${harness.template.templateName} ${harness.template.versionNo}`,
    contractVersionId: harness.template.id
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `pnpm --filter @subscription-saas/api test -- order-contract.spec.ts`

Expected: FAIL because `where.templateType` is absent and the fake repository returns the newer handover template.

- [ ] **Step 3: Implement the minimal query correction**

Import `ContractTemplateType` and add the exact predicate to the existing query:

```ts
where: {
  businessType: BusinessType.SUBSCRIPTION,
  deletedAt: null,
  effectiveFrom: { lte: now },
  OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
  status: ContractVersionStatus.ACTIVE,
  templateType: ContractTemplateType.SUBSCRIPTION_STANDARD
}
```

- [ ] **Step 4: Run the test to verify GREEN**

Run: `pnpm --filter @subscription-saas/api test -- order-contract.spec.ts`

Expected: PASS with the persisted and rendered template equal to the standard template.

### Task 2: Correct the workbench no-contract state

**Files:**
- Modify: `apps/api/test/order-workspace.spec.ts`
- Modify: `apps/api/src/order/order-workspace.service.ts`

**Interfaces:**
- Consumes: an empty `ContractWorkspaceFacts.contracts` array.
- Produces: an `ACTION_REQUIRED` guide item with action `contract.generate` and `blocking=false`.

- [ ] **Step 1: Write the failing state-resolution test**

```ts
it("marks a missing generatable contract as actionable instead of blocked", () => {
  expect(new OrderWorkspaceResolver().resolveContract({ contracts: [] })).toEqual(
    expect.objectContaining({
      actionCode: "contract.generate",
      blocking: false,
      reasonCode: "CONTRACT_REQUIRED",
      state: "ACTION_REQUIRED"
    })
  );
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `pnpm --filter @subscription-saas/api test -- order-workspace.spec.ts`

Expected: FAIL because the current resolver returns `BLOCKED` and `blocking=true`.

- [ ] **Step 3: Implement the minimal resolver correction**

```ts
if (!contract) {
  return guideItem(
    "contract",
    "ACTION_REQUIRED",
    "CONTRACT_REQUIRED",
    "contract.generate",
    null,
    null
  );
}
```

- [ ] **Step 4: Run the test to verify GREEN**

Run: `pnpm --filter @subscription-saas/api test -- order-workspace.spec.ts`

Expected: PASS; true failures and completed contracts retain their prior behavior.

### Task 3: Verify, publish, and remediate the affected Staging order

**Files:**
- No schema changes.
- Deployment updates the Staging API image; the Web image may remain unchanged because presentation already maps `ACTION_REQUIRED` to the existing actionable label.

**Interfaces:**
- Consumes: order `ORD20260731153648G634`, existing unsigned contract `CON202607311537179J5B`, active template `test_001/V1.4`.
- Produces: a replacement generated contract bound to `test_001/V1.4`, a searchable/readable PDF artifact, and an actionable workbench state before generation.

- [ ] **Step 1: Run quality gates**

Run:

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/api test -- order-contract.spec.ts order-workspace.spec.ts contract-pdf-renderer.spec.ts
```

Expected: all commands exit 0.

- [ ] **Step 2: Build and publish the Staging API image**

Build the API image from the reviewed commit using a unique `Staging-20260731-<sha>` tag, push it to `ghcr.io/keqi119/subscription-api`, update only `API_IMAGE` in the Staging deployment environment, and recreate the API/worker services with Docker Compose.

- [ ] **Step 3: Cancel the affected unsigned contract through the supported API**

Before cancellation, assert the contract is still `GENERATED`, has no e-sign task, and belongs to the target order. Cancel it through the contract API so the order returns to `PENDING_CONTRACT` and audit history is retained.

- [ ] **Step 4: Verify the corrected workbench state**

Read the order-workspace API before regeneration and require:

```json
{
  "category": "contract",
  "state": "ACTION_REQUIRED",
  "blocking": false,
  "actionCode": "contract.generate"
}
```

- [ ] **Step 5: Regenerate through the supported API**

Generate the replacement contract and assert the database/API record has `templateName=test_001`, `versionNo=V1.4`, `templateType=SUBSCRIPTION_STANDARD`, and a new PDF `fileId`.

- [ ] **Step 6: Render and inspect the replacement PDF**

Download the replacement PDF, extract text with `pdftotext`/`pypdf`, render all pages with `pdftoppm`, and visually confirm the `test_001 V1.4` header/body and signing sections are present while `车辆交接确认单 V1.0` is absent.

- [ ] **Step 7: Verify Stage 2 selection remains isolated**

Run the Stage 2 handover PDF tests and inspect the live active-template query evidence to confirm `DELIVERY_HANDOVER` still resolves to `车辆交接确认单 V1.0` only when the Stage 2 handover flow is invoked.

- [ ] **Step 8: Record final deployment evidence**

Capture the running API image tag, health status, migration status, replacement contract number/template, PDF verification result, and retained cancelled-contract audit trail.
