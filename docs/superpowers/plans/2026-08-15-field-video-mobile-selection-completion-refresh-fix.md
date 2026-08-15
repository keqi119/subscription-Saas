# Field Video Mobile Selection And Completion Refresh Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make 200–300 MiB walkaround videos usable through a mobile Files route and make completed first-time or replacement uploads refresh in place without false failure messages.

**Architecture:** Keep desktop video selection unchanged. On mobile, generate two explicit file-input contracts for the walkaround item, persist a short-lived “selection pending” marker so a WebView reload can explain an interrupted Photos handoff, and create the resumable session from metadata before reading video bytes. Split upload-session read authorization from mutation validation so a completed replacement remains readable after its old target is archived.

**Tech Stack:** Next.js 16, React 19, Ant Design 6, NestJS 11, Prisma 7, Vitest 4, TypeScript 6.

## Global Constraints

- The server video limit remains exactly `300 * 1024 * 1024` bytes.
- Mobile album guidance uses `200 MB`; the Files route covers `200–300 MB`.
- Desktop keeps one direct “资料上传” file picker and accepts videos up to `300 MiB`.
- The database schema, OSS multipart format, evidence single-file rule, video quality checks, and handover workflow do not change.
- Status reads must enforce task assignment, session scope, and `WALKAROUND_VIDEO` type without revalidating file capacity or the archived replacement target.
- Mutation endpoints keep existing editable-task, capacity, media-type, and replacement-target validation.
- Do not modify or commit the main checkout’s pre-existing Dockerfile and temporary-directory changes.

---

### Task 1: Mobile album and Files selection contracts

**Files:**
- Modify: `apps/web/src/lib/field-handover-upload.ts`
- Modify: `apps/web/src/components/field-handover-evidence-upload-controls.tsx`
- Test: `apps/web/test/field-handover-upload.spec.ts`

**Interfaces:**
- Consumes: `allowedMediaTypes`, `environment`, `evidenceType`, `id`, and `onFiles` already passed to `EvidenceUploadControls`.
- Produces: `buildFieldEvidenceUploadInputContracts(allowedMediaTypes, allowsMultiple, environment, evidenceType?)`, a `video-file` input contract, and storage helpers keyed by evidence control id.

- [ ] **Step 1: Write failing contract and interruption tests**

Add assertions that mobile `WALKAROUND_VIDEO` produces these two contracts while desktop remains unchanged:

```ts
expect(
  buildFieldEvidenceUploadInputContracts(
    ["VIDEO"],
    false,
    "MOBILE",
    "WALKAROUND_VIDEO"
  )
).toEqual([
  {
    accept: "video/*",
    key: "library",
    label: "从相册选择（不超过 200 MB）",
    multiple: false
  },
  {
    accept: ".m4v,.mov,.mp4,.webm",
    key: "video-file",
    label: "从文件选择（200–300 MB）",
    multiple: false
  }
]);
```

Add a storage stub and verify `markFieldVideoSelectionPending`, `clearFieldVideoSelectionPending`, and `consumeInterruptedFieldVideoSelection` use only `subscription-saas:field-video-selection:<id>` and consume the marker once.

- [ ] **Step 2: Run the focused Web test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/field-handover-upload.spec.ts
```

Expected: failure because `video-file` and the marker helpers do not exist.

- [ ] **Step 3: Implement the input contracts and persistent interruption guidance**

Extend the contract key union:

```ts
key: "library" | "photo-capture" | "video-capture" | "video-file";
```

Pass `evidenceType` into `buildFieldEvidenceUploadInputContracts`. Add `video-file` only when `environment === "MOBILE"`, `evidenceType === "WALKAROUND_VIDEO"`, and video is allowed. Keep the album contract for ordinary selection and use the exact labels from Step 1.

Add storage helpers accepting `Pick<Storage, "getItem" | "removeItem" | "setItem">`. In `EvidenceUploadControls`, mark selection pending before opening either walkaround-video picker, clear it on a non-empty selection, and consume it on mount. Render this persistent warning when an earlier selection was interrupted or returned no file:

```text
系统未能读取所选视频。超过 200 MB 请先保存到手机“文件”，再使用“从文件选择”上传。
```

Update the permanent guidance to:

```text
请使用手机系统相机以 720p 或更高画质录制完整车辆环绕视频。200 MB 以内可从相册选择；超过 200 MB 请先保存到手机“文件”后上传。单个视频不超过 300 MB。
```

- [ ] **Step 4: Run the focused Web tests and verify GREEN**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/field-handover-upload.spec.ts test/field-handover-pages.spec.ts
```

Expected: all tests pass and desktop markup still contains one upload input per evidence item.

- [ ] **Step 5: Commit Task 1**

```powershell
git add apps/web/src/lib/field-handover-upload.ts apps/web/src/components/field-handover-evidence-upload-controls.tsx apps/web/test/field-handover-upload.spec.ts
git commit -m "fix: add reliable mobile field video selection"
```

### Task 2: Create the upload session before reading video bytes

**Files:**
- Modify: `apps/web/src/lib/field-video-upload.ts`
- Test: `apps/web/test/field-video-upload.spec.ts`

**Interfaces:**
- Consumes: browser `File` metadata already supplied to `buildFieldVideoResumeFingerprint(file)`.
- Produces: the same 64-character lowercase SHA-256 fingerprint without calling `file.slice()` or `file.arrayBuffer()`.

- [ ] **Step 1: Keep the failing no-binary-read regression test**

The test must use a tracked `File` and assert:

```ts
const fingerprint = await buildFieldVideoResumeFingerprint(file);
expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
expect(file.slices).toEqual([]);
```

- [ ] **Step 2: Verify the test fails against the original implementation**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/field-video-upload.spec.ts
```

Expected original failure: the tracked file records reads of the first and last MiB.

- [ ] **Step 3: Hash metadata only**

Implement:

```ts
export async function buildFieldVideoResumeFingerprint(file: File) {
  const metadata = new TextEncoder().encode(
    `${file.name}\n${file.type}\n${file.size}\n${file.lastModified}\n`
  );
  return sha256Bytes(metadata);
}
```

Remove unused sample and byte-concatenation helpers. Keep per-part `sha256Blob` unchanged.

- [ ] **Step 4: Run upload primitive and runner tests**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/field-video-upload.spec.ts test/field-video-upload-runner.spec.ts test/field-video-upload-recovery.spec.ts
```

Expected: all tests pass, including mismatched-file recovery protection.

- [ ] **Step 5: Commit Task 2**

```powershell
git add apps/web/src/lib/field-video-upload.ts apps/web/test/field-video-upload.spec.ts
git commit -m "fix: create field video recovery before binary reads"
```

### Task 3: Read completed sessions without revalidating archived replacement targets

**Files:**
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/field-operator/field-video-upload.service.ts`
- Test: `apps/api/test/field-video-upload-api.spec.ts`

**Interfaces:**
- Produces: `HandoverWorkOrderService.authorizeFieldVideoUploadAccess({ evidenceItemId, phone, workOrderId })`.
- Consumes: existing `getFieldAccessibleWorkOrderRecord`, `assertEvidenceItemBelongsToWorkOrder`, session scope fields, and `DeliveryEvidenceType.WALKAROUND_VIDEO`.

- [ ] **Step 1: Keep the failing completed-replacement status test**

Use a `COMPLETED` session whose `replaceEvidenceFileId` is already archived. Make mutation authorization reject, make read authorization resolve, and assert `getStatus` returns `COMPLETED` without invoking mutation authorization.

- [ ] **Step 2: Verify the API test fails against the original implementation**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-api.spec.ts
```

Expected original failure: `getStatus` propagates the stale replacement-target validation error.

- [ ] **Step 3: Add read-only authorization and use it only for status reads**

Implement `authorizeFieldVideoUploadAccess` so it checks task access, item ownership, and exact evidence type, but does not call `validateEvidenceFileMutation` or `assertFieldSessionEditable`.

Extend `getScopedSession` with:

```ts
access: "MUTATE" | "READ" = "MUTATE"
```

Call it with `"READ"` only from `getStatus`; leave part upload, complete, retry, cancel, and active mutation recovery on the existing mutation path.

- [ ] **Step 4: Run focused API tests**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-api.spec.ts test/field-video-upload-part.spec.ts test/field-video-upload.worker.spec.ts test/field-video-upload-finalizer.spec.ts
```

Expected: all tests pass; completed status responses expose no OSS internals.

- [ ] **Step 5: Commit Task 3**

```powershell
git add apps/api/src/handover-work-order/handover-work-order.service.ts apps/api/src/field-operator/field-video-upload.service.ts apps/api/test/field-video-upload-api.spec.ts
git commit -m "fix: refresh completed field video uploads"
```

### Task 4: Verification, PR, merge, and staging deployment

**Files:**
- Verify only: repository, API/Web images, staging controlled configuration.

**Interfaces:**
- Consumes: commits produced by Tasks 1–3 and the existing staging image deployment workflow.
- Produces: merged `main`, matching immutable staging API/Web images, and a manual acceptance handoff.

- [ ] **Step 1: Run repository quality gates**

Run:

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
git diff --check origin/main...HEAD
```

Expected: all commands exit `0`.

- [ ] **Step 2: Confirm migration state**

Load `DATABASE_URL` from the main checkout’s controlled local `.env` without printing it, then run Prisma migration status from the worktree. Expected: `90 migrations found` and `Database schema is up to date`; this fix creates no migration.

- [ ] **Step 3: Push, open PR, review, and merge**

Push `fix/field-video-completion-state-20260815`, open a PR summarizing both observed false errors and the mobile selection route, wait for required checks, then merge without including unrelated main-checkout changes.

- [ ] **Step 4: Build and publish immutable images from merged main**

Use the merged commit SHA to build matching API/Web tags. Verify each published image exists and record its digest before deployment.

- [ ] **Step 5: Deploy staging without overlay images**

Back up `/opt/subscription-saas/.env.staging.images`, update only the controlled API/Web image references, pull, and force-recreate API/Web. Do not build or commit inside the server checkout. Verify each running container’s configured image, immutable image ID, health, worker settings, and public health endpoints.

- [ ] **Step 6: Hand off manual acceptance**

Ask the user to verify:

1. PC 216.2 MB first upload finishes and refreshes in place.
2. Mobile upload drawer shows both album and Files entries.
3. Mobile Files route uploads a 200–300 MB video.
4. First upload and replacement no longer show false capacity or stale-target errors.
5. No return-to-list/re-enter step is required.

