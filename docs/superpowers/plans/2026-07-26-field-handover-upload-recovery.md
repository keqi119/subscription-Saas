# Field Handover Upload Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore reliable field evidence upload, preserve unsaved field facts, and provide device-appropriate upload and failure recovery behavior.

**Architecture:** Keep media preparation synchronous and fail-closed, but make its runtime dependencies part of the API image contract. Extend the existing pure upload coordinator so recoverable failures are retained separately from active upload state; the page can then allow other evidence mutations while unresolved failures continue to block final submission.

**Tech Stack:** Docker, NestJS 11, Next.js 16, React 19, Ant Design 6, TypeScript 6, Vitest 4

## Global Constraints

- Every evidence item displays one primary button labelled `资料上传`.
- Desktop opens a file chooser directly; mobile offers capture and library choices.
- Other evidence items are editable after an upload is authoritatively known to have failed.
- Final submission remains blocked until every recoverable failure is retried, replaced, or abandoned.
- An uncertain request outcome keeps all evidence mutation blocked until authoritative refresh succeeds.
- Evidence processing remains fail-closed and writes no partial evidence database records.
- Do not change evidence size limits, checklist requirements, or Stage 2 PDF rules.

---

### Task 1: API Runtime Media Contract

**Files:**
- Modify: `Dockerfile.api`
- Modify: `apps/api/src/delivery-handover/delivery-handover-evidence-artifact.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Create: `apps/api/test/api-runtime-media.spec.ts`
- Modify: `apps/api/test/stage2-handover-evidence-artifact.spec.ts`

**Interfaces:**
- Consumes: `STAGE2_EVIDENCE_ARTIFACT_PROCESSING_FAILED`
- Produces: `isDeliveryEvidenceArtifactProcessingError(error: unknown): boolean`

- [ ] **Step 1: Write failing runtime and error-classification tests**

```ts
it("packages ffmpeg and ffprobe in the API runtime image", () => {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile.api"), "utf8");
  expect(dockerfile).toMatch(/apt-get install[^\\n]*ffmpeg/);
  expect(dockerfile).toContain("command -v ffmpeg");
  expect(dockerfile).toContain("command -v ffprobe");
});

it("classifies normalized media processing errors without exposing internals", async () => {
  const service = new DeliveryHandoverEvidenceArtifactService(undefined, async () => {
    throw new Error("spawn ffmpeg ENOENT");
  });
  const error = await service.prepareUpload(photoInput()).catch((value) => value);
  expect(isDeliveryEvidenceArtifactProcessingError(error)).toBe(true);
});
```

- [ ] **Step 2: Run tests and verify the new expectations fail**

Run:

```bash
pnpm --filter @subscription-saas/api test -- test/api-runtime-media.spec.ts test/stage2-handover-evidence-artifact.spec.ts
```

Expected: FAIL because the image does not install `ffmpeg` and the classifier is not exported.

- [ ] **Step 3: Package binaries and map processing failures safely**

Install `ffmpeg` in the runtime apt layer and add:

```dockerfile
&& command -v ffmpeg >/dev/null \
&& command -v ffprobe >/dev/null \
```

Export a classifier that checks the normalized error prefix. In
`uploadAndAttachFieldAccessibleEvidenceFile`, translate classified failures to:

```ts
throw new UnprocessableEntityException(
  "资料文件处理失败，请重新选择文件后重试。"
);
```

Keep the existing `finally` cleanup and stored-object rollback unchanged.

- [ ] **Step 4: Run focused API tests**

Run:

```bash
pnpm --filter @subscription-saas/api test -- test/api-runtime-media.spec.ts test/stage2-handover-evidence-artifact.spec.ts test/field-evidence-upload-cleanup.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.api apps/api/src/delivery-handover/delivery-handover-evidence-artifact.service.ts apps/api/src/handover-work-order/handover-work-order.service.ts apps/api/test/api-runtime-media.spec.ts apps/api/test/stage2-handover-evidence-artifact.spec.ts
git commit -m "fix(api): package field evidence media processor"
```

### Task 2: Recoverable Upload Coordinator

**Files:**
- Modify: `apps/web/src/lib/field-handover-upload-batch.ts`
- Modify: `apps/web/test/field-handover-upload-reconciliation.spec.ts`
- Modify: `apps/web/test/field-handover-pages.spec.ts`

**Interfaces:**
- Produces: `recoveries: Record<string, FieldEvidenceUploadRecovery<TFile>>`
- Produces: `abandonFieldEvidenceUploadRecovery(state, itemViewId)`
- Produces: `retryFieldEvidenceUploadBatch(state, itemViewId, canEdit, operation)`
- Produces: `canStartFieldEvidenceUploadBatch(state, itemViewId)`
- Produces: `hasFieldEvidenceUploadRecoveries(state)`

- [ ] **Step 1: Write failing recovery-state tests**

```ts
it("authoritatively failed uploads become recoverable without locking other items", async () => {
  const result = await runFieldEvidenceUploadBatch(
    startFieldEvidenceUploadBatch("front", ["front.jpg"], false, snapshot([])),
    {
      getFailureMessage: () => "资料文件处理失败",
      getInterruptionReason: () => "FAILURE",
      refreshDetail: async () => snapshot([]),
      uploadFile: async () => { throw new Error("rejected"); }
    }
  );
  expect(result.status).toBe("IDLE");
  expect(result.recoveries.front?.files).toEqual(["front.jpg"]);
  expect(canStartFieldEvidenceUploadBatch(result, "side")).toBe(true);
  expect(canStartFieldEvidenceUploadBatch(result, "front")).toBe(false);
  expect(canSubmitWithFieldEvidenceUploadBatch(result)).toBe(false);
});

it("abandons a recovery and restores submission", () => {
  const abandoned = abandonFieldEvidenceUploadRecovery(failedState(), "front");
  expect(abandoned.recoveries).toEqual({});
  expect(canSubmitWithFieldEvidenceUploadBatch(abandoned)).toBe(true);
});
```

- [ ] **Step 2: Run reconciliation tests and verify they fail**

Run:

```bash
pnpm --filter @subscription-saas/web test -- test/field-handover-upload-reconciliation.spec.ts
```

Expected: FAIL because upload failures currently remain in the globally locked
`RETRY_PENDING` status.

- [ ] **Step 3: Extend the pure coordinator**

Add recoveries to `FieldEvidenceUploadBatchState`:

```ts
export interface FieldEvidenceUploadRecovery<TFile> {
  errorMessage: string;
  files: TFile[];
  itemViewId: string;
  operation: FieldEvidenceUploadOperation;
  baseline: FieldEvidenceUploadSnapshot;
}

export interface FieldEvidenceUploadBatchState<TFile> {
  batch: FieldEvidenceUploadBatch<TFile> | null;
  fileIndex: number;
  recoveries: Record<string, FieldEvidenceUploadRecovery<TFile>>;
  refreshTarget?: "IDLE" | "RECOVERABLE";
  status: "IDLE" | "REFRESH_FAILED" | "REFRESHING" | "UPLOADING";
}
```

When reconciliation proves remaining files did not commit, move them into
`recoveries[itemViewId]` and return to `IDLE`. Preserve the global lock for
`REFRESH_FAILED`. Retry moves one recovery back to the active batch; abandon
removes it. Submission requires both `status === "IDLE"` and an empty recovery
map, while ordinary evidence mutation requires only `status === "IDLE"`.

- [ ] **Step 4: Run coordinator and page contract tests**

Run:

```bash
pnpm --filter @subscription-saas/web test -- test/field-handover-upload-reconciliation.spec.ts test/field-handover-pages.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/field-handover-upload-batch.ts apps/web/test/field-handover-upload-reconciliation.spec.ts apps/web/test/field-handover-pages.spec.ts
git commit -m "fix(web): make failed evidence uploads recoverable"
```

### Task 3: Device-Aware Upload Contracts

**Files:**
- Modify: `apps/web/src/lib/field-handover-upload.ts`
- Modify: `apps/web/test/field-handover-upload.spec.ts`
- Modify: `apps/web/src/app/field/handover/tasks/[id]/page.tsx`

**Interfaces:**
- Produces: `detectFieldEvidenceUploadEnvironment(signals): "DESKTOP" | "MOBILE"`
- Produces: `buildFieldEvidenceUploadInputContracts(types, multiple, environment)`

- [ ] **Step 1: Write failing desktop and mobile contract tests**

```ts
it("uses one direct library contract on desktop", () => {
  expect(buildFieldEvidenceUploadInputContracts(["PHOTO"], true, "DESKTOP"))
    .toEqual([{ accept: "image/*", key: "library", label: "资料上传", multiple: true }]);
});

it("offers capture and library contracts on mobile", () => {
  expect(buildFieldEvidenceUploadInputContracts(["PHOTO"], true, "MOBILE"))
    .toEqual([
      { accept: "image/*", capture: "environment", key: "photo-capture", label: "现场拍摄", multiple: false },
      { accept: "image/*", key: "library", label: "从相册选择", multiple: true }
    ]);
});
```

- [ ] **Step 2: Run upload helper tests and verify they fail**

Run:

```bash
pnpm --filter @subscription-saas/web test -- test/field-handover-upload.spec.ts
```

Expected: FAIL because the helper always returns capture controls.

- [ ] **Step 3: Implement environment detection and one primary action**

Use `navigator.userAgentData?.mobile` when available, mobile user-agent
matching, and a coarse-pointer plus narrow-viewport fallback. Default to
`DESKTOP` before hydration.

Render hidden inputs for the contracts. The visible `资料上传` button directly
clicks the desktop library input. On mobile it opens an Ant Design bottom
`Drawer` containing the contract choices and their existing icons.

- [ ] **Step 4: Run helper and page tests**

Run:

```bash
pnpm --filter @subscription-saas/web test -- test/field-handover-upload.spec.ts test/field-handover-pages.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/field-handover-upload.ts apps/web/test/field-handover-upload.spec.ts apps/web/src/app/field/handover/tasks/[id]/page.tsx
git commit -m "fix(web): adapt field evidence upload to device"
```

### Task 4: Page Recovery Actions and Draft Preservation

**Files:**
- Modify: `apps/web/src/app/field/handover/tasks/[id]/page.tsx`
- Modify: `apps/web/test/field-handover-pages.spec.ts`
- Modify: `apps/web/test/field-handover-view-model.spec.ts`

**Interfaces:**
- Consumes: recovery coordinator functions from Task 2
- Consumes: device-aware upload contracts from Task 3

- [ ] **Step 1: Write failing page contract tests**

Assert the page:

```ts
expect(source).toContain("preserveFacts: true");
expect(source).toContain("重试原文件");
expect(source).toContain("重新选择");
expect(source).toContain("放弃本次上传");
expect(source).toContain("hasFieldEvidenceUploadRecoveries");
```

Add a view-model regression proving `resolveFieldHandoverFactsAfterRefresh`
returns the local draft after damage-state refresh.

- [ ] **Step 2: Run focused web tests and verify they fail**

Run:

```bash
pnpm --filter @subscription-saas/web test -- test/field-handover-pages.spec.ts test/field-handover-view-model.spec.ts
```

Expected: FAIL because damage refresh does not preserve the draft and the
recovery actions do not exist.

- [ ] **Step 3: Wire the confirmed page behavior**

Call `loadDetail({ preserveFacts: true })` after both damage-state actions.
Render recovery details on the failed item, including its error and first
remaining filename. Wire retry to move the recovery into the active batch,
reselect to replace that item's recovery with the selected files, and abandon
to remove it. Disable a failed item's primary upload action while leaving
other items available. Select the submission blocker text from active,
uncertain, or recoverable state.

- [ ] **Step 4: Run all field handover web tests**

Run:

```bash
pnpm --filter @subscription-saas/web test -- test/field-handover-upload.spec.ts test/field-handover-upload-reconciliation.spec.ts test/field-handover-view-model.spec.ts test/field-handover-pages.spec.ts test/field-handover-api.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/field/handover/tasks/[id]/page.tsx apps/web/test/field-handover-pages.spec.ts apps/web/test/field-handover-view-model.spec.ts
git commit -m "fix(web): preserve field drafts and expose upload recovery"
```

### Task 5: Full Verification and Staging Delivery

**Files:**
- Verify only; modify tests or implementation only for failures directly
  attributable to Tasks 1-4.

**Interfaces:**
- Consumes: complete branch implementation
- Produces: merged staging image with verified evidence upload

- [ ] **Step 1: Run static and unit verification**

Run:

```bash
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/api build
pnpm --filter @subscription-saas/web build
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 2: Build the API runtime image**

Run:

```bash
docker build -f Dockerfile.api -t subscription-api:field-upload-recovery .
docker run --rm --entrypoint sh subscription-api:field-upload-recovery -lc "ffmpeg -version >/dev/null && ffprobe -version >/dev/null"
```

Expected: image build succeeds and both commands exit 0.

- [ ] **Step 3: Review, push, merge, and wait for staging images**

Commit any verification-only corrections, push
`fix/field-handover-upload-recovery`, open a PR, wait for required checks,
merge, and obtain the immutable API and web image tags for the merge SHA.

- [ ] **Step 4: Deploy only staging API and web**

Update `/opt/subscription-saas/.env.staging.images` with the new image tags and
recreate only `subauto-staging-api-1` and `subauto-staging-web-1`. Verify both
containers become healthy and production containers remain unchanged.

- [ ] **Step 5: Run staging field handover verification**

For work order `a16d72dd-a2b6-44fb-a15e-d558db6fddd3`:

1. Confirm PC Chrome shows one `资料上传` action and opens the file chooser.
2. Enter unsaved field facts, switch damage state, and confirm values remain.
3. Upload a small JPEG to evidence item
   `62323d74-c9f3-476a-bae9-191405f1b586`.
4. Confirm the API returns 2xx, the item has one active evidence file, and its
   artifact metadata includes `processingStatus: "READY"` and a preview file.
5. Exercise a controlled failed upload and confirm retry, reselect, and abandon
   recovery without locking unrelated evidence items.

- [ ] **Step 6: Record verification**

Add a final commit only if durable verification documentation is required by
the repository. Otherwise report the image tags, health checks, focused
database assertions, and any Chrome verification limitation to the user.
