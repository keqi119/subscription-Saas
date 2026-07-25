# Field Capture and Upload Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit Field photo/video capture and library upload actions, upload progress/cancel/retry, and enforce 10MB photo and 300MB video limits end to end.

**Architecture:** Keep the existing atomic Field upload-and-bind endpoint and disk-backed API staging. Centralize API limits, add a Field-specific XHR upload client for progress/cancellation, extract browser-side media validation into a focused module, and render separate capture/library controls in the existing mobile task detail page.

**Tech Stack:** Next.js App Router, React, TypeScript, Ant Design, browser `XMLHttpRequest`, NestJS, Multer, Prisma-backed services, Vitest, Nginx.

## Global Constraints

- Do not add dependencies or modify `package.json` or `pnpm-lock.yaml`.
- Photo limit is exactly `10 * 1024 * 1024` bytes.
- Video limit is exactly `300 * 1024 * 1024` bytes.
- Camera capture uses the rear-facing hint `capture="environment"`.
- Camera capture accepts one file per action; library selection preserves `allowsMultiple`.
- Keep the atomic upload-and-bind endpoint and Field session Cookie boundary.
- Do not expose tokens, cookies, object keys, bucket paths, storage paths, or signing URLs.
- Do not change Stage 2 PDF, eSign, delivery confirmation, lease, billing, or objection state transitions.
- Do not implement OSS direct multipart upload or add third-party upload libraries.

---

### Task 1: Centralize and Raise API Upload Limits

**Files:**
- Create: `apps/api/src/handover-work-order/handover-work-order.constants.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/field-operator/field-operator-auth.controller.ts`
- Test: `apps/api/test/handover-work-order.spec.ts`

**Interfaces:**
- Produces: `MAX_FIELD_PHOTO_SIZE_BYTES`, `MAX_FIELD_VIDEO_SIZE_BYTES`, and `MAX_FIELD_EVIDENCE_UPLOAD_SIZE_BYTES`.
- Consumes: existing `uploadAndAttachFieldAccessibleEvidenceFile(...)` validation path and `AnyFilesInterceptor(...)`.

- [ ] **Step 1: Update the boundary test to describe the new limits**

Replace the existing 5MiB/200MiB test with assertions that accept exact boundaries and reject boundary plus one:

```ts
it("enforces 10 MiB photo and 300 MiB video upload limits before storage", async () => {
  const harness = createHandoverWorkOrderHarness();
  // Reuse the existing editable work-order and evidence-item setup.

  await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
    "work-order-visible",
    "13800000000",
    "evidence-item-owned",
    [uploadFile("photo-at-limit.jpg", "image/jpeg", 10 * 1024 * 1024)],
    {},
    "field-session-1"
  );
  await harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
    "work-order-visible",
    "13800000000",
    "evidence-item-owned",
    [uploadFile("video-at-limit.mp4", "video/mp4", 300 * 1024 * 1024)],
    {},
    "field-session-1"
  );
  await expect(/* photo size 10 * 1024 * 1024 + 1 */).rejects.toThrow("图片不能超过 10MB");
  await expect(/* video size 300 * 1024 * 1024 + 1 */).rejects.toThrow("视频不能超过 300MB");
});
```

- [ ] **Step 2: Run the focused API test and verify failure**

Run:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/handover-work-order.spec.ts
```

Expected: FAIL because the implementation still rejects files above 5MiB/200MiB and returns old error text.

- [ ] **Step 3: Add shared API constants**

Create:

```ts
export const MAX_FIELD_PHOTO_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_FIELD_VIDEO_SIZE_BYTES = 300 * 1024 * 1024;
export const MAX_FIELD_EVIDENCE_UPLOAD_SIZE_BYTES = MAX_FIELD_VIDEO_SIZE_BYTES;
```

Import the constants in `handover-work-order.service.ts`, remove its local 5MiB/200MiB constants, and update the messages:

```ts
if (mediaType === DeliveryEvidenceMediaType.PHOTO && sizeBytes > MAX_FIELD_PHOTO_SIZE_BYTES) {
  throw new BadRequestException("图片不能超过 10MB。");
}
if (mediaType === DeliveryEvidenceMediaType.VIDEO && sizeBytes > MAX_FIELD_VIDEO_SIZE_BYTES) {
  throw new BadRequestException("视频不能超过 300MB。");
}
```

Use the shared hard limit in the controller:

```ts
const FIELD_EVIDENCE_UPLOAD_OPTIONS = {
  dest: path.join(tmpdir(), "subscription-saas-field-evidence"),
  limits: { fileSize: MAX_FIELD_EVIDENCE_UPLOAD_SIZE_BYTES, files: 1 }
};
```

- [ ] **Step 4: Run API upload and cleanup tests**

Run:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/handover-work-order.spec.ts test/field-evidence-upload-cleanup.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the API limit change**

```bash
git add -- apps/api/src/handover-work-order/handover-work-order.constants.ts apps/api/src/handover-work-order/handover-work-order.service.ts apps/api/src/field-operator/field-operator-auth.controller.ts apps/api/test/handover-work-order.spec.ts
git commit -m "feat(field): raise evidence upload limits"
```

---

### Task 2: Add an XHR Upload Client with Progress and Cancellation

**Files:**
- Modify: `apps/web/src/lib/field-handover-api.ts`
- Test: `apps/web/test/field-handover-api.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface FieldEvidenceUploadProgress {
  loadedBytes: number;
  percent: number;
  totalBytes: number;
}

export interface FieldEvidenceUploadOptions {
  onProgress?: (progress: FieldEvidenceUploadProgress) => void;
  replaceEvidenceFileId?: string;
  signal?: AbortSignal;
}
```

- Produces: `uploadAndAttachFieldHandoverEvidenceFile(id, itemId, file, options?)`.
- Consumes: `API_BASE_URL`, `ApiError`, the existing 20-minute upload timeout, and the same atomic upload endpoint.

- [ ] **Step 1: Replace fetch-oriented upload tests with XHR behavior tests**

Add a deterministic `MockXMLHttpRequest` to the test file that records:

```ts
{
  method: "POST",
  url: "http://localhost:3001/api/field/handover/work-orders/work-order-1/evidence/evidence-item-1/upload",
  withCredentials: true,
  timeout: 20 * 60 * 1000
}
```

Cover:

```ts
it("uploads evidence with cookies and reports progress", async () => {
  const onProgress = vi.fn();
  const request = uploadAndAttachFieldHandoverEvidenceFile(
    "work-order-1",
    "evidence-item-1",
    new File(["image"], "front.jpg", { type: "image/jpeg" }),
    { onProgress }
  );
  xhr.emitProgress(5, 10);
  xhr.complete(200, { id: "evidence-item-1", status: "UPLOADED" });
  await expect(request).resolves.toMatchObject({ status: "UPLOADED" });
  expect(onProgress).toHaveBeenCalledWith({ loadedBytes: 5, percent: 50, totalBytes: 10 });
});

it("aborts an evidence upload from the caller signal", async () => {
  const controller = new AbortController();
  const request = uploadAndAttachFieldHandoverEvidenceFile(
    "work-order-1",
    "evidence-item-1",
    new File(["video"], "walkaround.mp4", { type: "video/mp4" }),
    { signal: controller.signal }
  );
  controller.abort();
  await expect(request).rejects.toMatchObject({ message: "上传已取消。", status: 0 });
});
```

Also cover API JSON errors, network errors, and timeout errors without exposing response internals.

- [ ] **Step 2: Run the focused Web API test and verify failure**

Run:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/field-handover-api.spec.ts
```

Expected: FAIL because the current function uses `fetch` and has no progress callback or XHR cancellation behavior.

- [ ] **Step 3: Implement the XHR request**

Change the upload signature to accept `FieldEvidenceUploadOptions`. Build `FormData`, configure `withCredentials`, timeout, progress, and signal cleanup:

```ts
export function uploadAndAttachFieldHandoverEvidenceFile(
  id: string,
  itemId: string,
  file: File,
  options: FieldEvidenceUploadOptions = {}
) {
  const formData = new FormData();
  formData.append("files", file, file.name);
  if (options.replaceEvidenceFileId) {
    formData.append("replaceEvidenceFileId", options.replaceEvidenceFileId);
  }

  return new Promise<FieldHandoverEvidenceItem>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abortFromCaller = () => xhr.abort();
    xhr.open(
      "POST",
      `${API_BASE_URL}/field/handover/work-orders/${encodeURIComponent(id)}/evidence/${encodeURIComponent(itemId)}/upload`
    );
    xhr.withCredentials = true;
    xhr.timeout = FIELD_EVIDENCE_UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (event) => {
      const totalBytes = event.lengthComputable ? event.total : file.size;
      const percent = totalBytes > 0 ? Math.min(100, Math.round((event.loaded / totalBytes) * 100)) : 0;
      options.onProgress?.({ loadedBytes: event.loaded, percent, totalBytes });
    };
    xhr.onload = () => settleFieldEvidenceUpload(xhr, resolve, reject);
    xhr.onerror = () => reject(new ApiError("上传失败，请检查网络后重试。", 0));
    xhr.ontimeout = () => reject(new ApiError("上传超时，请检查网络后重试。", 0));
    xhr.onabort = () => reject(new ApiError("上传已取消。", 0));
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    xhr.onloadend = () => options.signal?.removeEventListener("abort", abortFromCaller);
    xhr.send(formData);
  });
}
```

`settleFieldEvidenceUpload` must parse only the expected JSON response/error message and reject malformed success responses with a safe `ApiError`.

- [ ] **Step 4: Run the focused Web API test**

Run:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/field-handover-api.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the upload client**

```bash
git add -- apps/web/src/lib/field-handover-api.ts apps/web/test/field-handover-api.spec.ts
git commit -m "feat(field): report evidence upload progress"
```

---

### Task 3: Extract Browser Media Validation

**Files:**
- Create: `apps/web/src/lib/field-handover-upload.ts`
- Create: `apps/web/test/field-handover-upload.spec.ts`
- Modify: `apps/web/src/app/field/handover/tasks/[id]/page.tsx`

**Interfaces:**
- Produces:

```ts
export const MAX_FIELD_PHOTO_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_FIELD_VIDEO_SIZE_BYTES = 300 * 1024 * 1024;
export type FieldEvidenceMediaType = "PHOTO" | "VIDEO";
export function resolveFieldEvidenceMediaType(file: File): FieldEvidenceMediaType | null;
export function validateFieldEvidenceFile(
  allowedMediaTypes: FieldEvidenceMediaType[],
  file: File
): string | null;
export function formatUploadBytes(value: number): string;
```

- Consumes: evidence item `allowedMediaTypes` and browser `File`.

- [ ] **Step 1: Add failing validation tests**

Cover exact boundaries and common iPhone formats:

```ts
expect(validateFieldEvidenceFile(["PHOTO"], fileOfSize("photo.jpg", "image/jpeg", 10 * 1024 * 1024))).toBeNull();
expect(validateFieldEvidenceFile(["PHOTO"], fileOfSize("photo.jpg", "image/jpeg", 10 * 1024 * 1024 + 1)))
  .toContain("超过 10MB");
expect(validateFieldEvidenceFile(["VIDEO"], fileOfSize("video.mp4", "video/mp4", 300 * 1024 * 1024))).toBeNull();
expect(validateFieldEvidenceFile(["VIDEO"], fileOfSize("video.mp4", "video/mp4", 300 * 1024 * 1024 + 1)))
  .toContain("超过 300MB");
expect(resolveFieldEvidenceMediaType(fileOfSize("capture.heic", "", 1))).toBe("PHOTO");
expect(resolveFieldEvidenceMediaType(fileOfSize("capture.mov", "", 1))).toBe("VIDEO");
```

- [ ] **Step 2: Run the new test and verify failure**

Run:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/field-handover-upload.spec.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the focused validation module**

Move the MIME/extension detection and size checks out of the page, update the limits to 10MiB/300MiB, and keep allowed media enforcement:

```ts
export function validateFieldEvidenceFile(
  allowedMediaTypes: FieldEvidenceMediaType[],
  file: File
) {
  const mediaType = resolveFieldEvidenceMediaType(file);
  if (!mediaType || !allowedMediaTypes.includes(mediaType)) {
    return "请选择符合要求的图片或视频";
  }
  if (mediaType === "PHOTO" && file.size > MAX_FIELD_PHOTO_SIZE_BYTES) {
    return `图片 ${file.name} 超过 10MB`;
  }
  if (mediaType === "VIDEO" && file.size > MAX_FIELD_VIDEO_SIZE_BYTES) {
    return `视频 ${file.name} 超过 300MB`;
  }
  return null;
}
```

Update the page to call `validateFieldEvidenceFile(item.allowedMediaTypes ?? [], file)` and remove its local size constants and validation helpers.

- [ ] **Step 4: Run validation and existing Field page tests**

Run:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/field-handover-upload.spec.ts test/field-handover-pages.spec.ts
```

Expected: PASS after updating old source assertions for the extracted helper.

- [ ] **Step 5: Commit media validation**

```bash
git add -- apps/web/src/lib/field-handover-upload.ts apps/web/test/field-handover-upload.spec.ts apps/web/src/app/field/handover/tasks/[id]/page.tsx apps/web/test/field-handover-pages.spec.ts
git commit -m "refactor(field): centralize evidence validation"
```

---

### Task 4: Add Capture, Library, Progress, Cancel, and Retry UI

**Files:**
- Modify: `apps/web/src/app/field/handover/tasks/[id]/page.tsx`
- Modify: `apps/web/test/field-handover-pages.spec.ts`
- Modify: `apps/web/test/field-handover-api.spec.ts`

**Interfaces:**
- Consumes: `FieldEvidenceUploadOptions`, `FieldEvidenceUploadProgress`, and validation helpers from Tasks 2 and 3.
- Produces page-local state:

```ts
interface EvidenceUploadState {
  fileCount: number;
  fileIndex: number;
  fileName: string;
  itemId: string;
  loadedBytes: number;
  percent: number;
  totalBytes: number;
}

interface RetryEvidenceUpload {
  files: File[];
  itemViewId: string;
}
```

- [ ] **Step 1: Add failing page contract assertions**

Update `field-handover-pages.spec.ts` to require:

```ts
expect(source).toContain('capture="environment"');
expect(source).toContain("现场拍照");
expect(source).toContain("现场录像");
expect(source).toContain("从相册选择");
expect(source).toContain("从相册/文件选择");
expect(source).toContain("上传进度");
expect(source).toContain("取消上传");
expect(source).toContain("重试上传");
expect(source).toContain("multiple={false}");
expect(source).toContain("multiple={multiple}");
```

- [ ] **Step 2: Run the Field page test and verify failure**

Run:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/field-handover-pages.spec.ts
```

Expected: FAIL because the page still renders one generic upload input and no progress controls.

- [ ] **Step 3: Add upload batch state and cancellation**

Add `useRef` and state:

```ts
const uploadAbortControllerRef = useRef<AbortController | null>(null);
const [uploadState, setUploadState] = useState<EvidenceUploadState | null>(null);
const [retryUpload, setRetryUpload] = useState<RetryEvidenceUpload | null>(null);
```

For each selected file:

```ts
const controller = new AbortController();
uploadAbortControllerRef.current = controller;
await uploadAndAttachFieldHandoverEvidenceFile(params.id, item.id, file, {
  onProgress: ({ loadedBytes, percent, totalBytes }) => {
    setUploadState({
      fileCount: selectedFiles.length,
      fileIndex: index + 1,
      fileName: file.name,
      itemId: item.id,
      loadedBytes,
      percent,
      totalBytes
    });
  },
  replaceEvidenceFileId: index === 0 ? replaceEvidenceFileId : undefined,
  signal: controller.signal
});
```

On failure or cancellation, retain only `selectedFiles.slice(index)` for retry, reload detail after a partial success, and clear the controller in `finally`.

- [ ] **Step 4: Replace the single upload control with explicit media actions**

Render hidden inputs and icon buttons:

```tsx
{allowedMediaTypes.includes("PHOTO") ? (
  <CaptureInput
    accept="image/*"
    capture="environment"
    label="现场拍照"
    multiple={false}
    onFiles={onFiles}
  />
) : null}
{allowedMediaTypes.includes("VIDEO") ? (
  <CaptureInput
    accept="video/*"
    capture="environment"
    label="现场录像"
    multiple={false}
    onFiles={onFiles}
  />
) : null}
<CaptureInput
  accept={accept}
  label={allowedMediaTypes.length === 1 && allowedMediaTypes[0] === "PHOTO"
    ? "从相册选择"
    : "从相册/文件选择"}
  multiple={multiple}
  onFiles={onFiles}
/>
```

While an item uploads, show Ant Design `Progress`, current file index/name, transferred bytes, a `取消上传` button, and after failure a `重试上传` button.

- [ ] **Step 5: Run focused Web tests**

Run:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/field-handover-pages.spec.ts test/field-handover-api.spec.ts test/field-handover-upload.spec.ts test/field-handover-view-model.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the Field UI**

```bash
git add -- apps/web/src/app/field/handover/tasks/[id]/page.tsx apps/web/test/field-handover-pages.spec.ts apps/web/test/field-handover-api.spec.ts
git commit -m "feat(field): add camera capture upload controls"
```

---

### Task 5: Align Nginx Examples and Stage 2 Runbooks

**Files:**
- Modify: `nginx/staging-subauto.example.conf`
- Modify: `nginx/production-subauto.example.conf`
- Modify: `docs/stage2-local-handover-e2e-runbook.md`
- Modify: `docs/stage2-delivery-handover-signing.md`

**Interfaces:**
- Produces: deploy-time request body and timeout guidance matching the application.
- Consumes: API upload timeout of 20 minutes and limits from Task 1.

- [ ] **Step 1: Update the API virtual-host examples**

For the API server blocks only:

```nginx
client_max_body_size 320m;

location / {
    proxy_request_buffering off;
    proxy_read_timeout 1200s;
    proxy_send_timeout 1200s;
}
```

Do not raise the Admin/Web server block from 20MB because browser uploads go directly to the public API origin.

- [ ] **Step 2: Update Stage 2 operational documentation**

Replace 5MB/200MB/210m text with:

```text
Field evidence accepts photos up to 10MB and videos up to 300MB.
The API Nginx virtual host must set client_max_body_size 320m or higher,
proxy_read_timeout/proxy_send_timeout to 1200s, and proxy_request_buffering off.
```

Keep the disk-backed temp-file and cleanup explanation.

- [ ] **Step 3: Verify configuration and documentation consistency**

Run:

```bash
rg -n "5MB|200MB|210m|10MB|300MB|320m|proxy_request_buffering" \
  nginx/staging-subauto.example.conf \
  nginx/production-subauto.example.conf \
  docs/stage2-local-handover-e2e-runbook.md \
  docs/stage2-delivery-handover-signing.md
```

Expected: Field upload guidance uses 10MB/300MB and API Nginx examples use 320m with buffering disabled.

- [ ] **Step 4: Commit deployment guidance**

```bash
git add -- nginx/staging-subauto.example.conf nginx/production-subauto.example.conf docs/stage2-local-handover-e2e-runbook.md docs/stage2-delivery-handover-signing.md
git commit -m "docs(field): align large upload deployment limits"
```

---

### Task 6: Full Verification and Safety Review

**Files:**
- Verify all files changed in Tasks 1-5.

**Interfaces:**
- Produces: a release-ready local branch with no dependency, schema, migration, signing, delivery, lease, or billing changes.

- [ ] **Step 1: Run Web checks**

```bash
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/web build
```

Expected: PASS.

- [ ] **Step 2: Run API checks**

```bash
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api exec vitest run test/handover-work-order.spec.ts test/field-evidence-upload-cleanup.spec.ts test/field-operator-auth.spec.ts
pnpm --filter @subscription-saas/api build
```

Expected: PASS.

- [ ] **Step 3: Inspect the final diff**

```bash
git status --short --branch --untracked-files=all
git diff --name-status origin/main...HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git diff origin/main...HEAD -- package.json pnpm-lock.yaml apps/api/prisma/schema.prisma apps/api/prisma/migrations
```

Expected:

- Only Field upload code/tests, Nginx examples, design, plan, and Stage 2 docs changed.
- No dependency, Prisma schema, migration, PDF/eSign, delivery confirmation, lease, or billing changes.
- No secrets or real customer data.

- [ ] **Step 4: Confirm browser acceptance checklist**

Record manual follow-up requirements:

- iPhone Safari camera/photo library and video/library paths.
- WeChat embedded browser camera/photo library and video/library paths.
- Edge file-picker fallback.
- 9MB photo accepted and 11MB photo rejected.
- Near-300MB video accepted and over-300MB video rejected.
- Progress, cancel, retry, delete, replace, and multi-damage closeups.
- No orphan records or storage internals displayed.

- [ ] **Step 5: Commit any final test-only correction**

Stage only explicitly changed test or implementation files and use a narrowly scoped commit message. Do not use `git add .` or `git add -A`.
