# Stage 2 Media Upload Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Stage 2 walkaround-video uploads reliable up to the existing 300 MiB business limit, remove the uncontrollable in-page mobile video capture path, and reject newly uploaded walkaround videos below 720p with actionable feedback.

**Architecture:** Keep the existing XHR upload, storage, derivative, and evidence-manifest pipeline. Narrow the mobile input contracts to system-camera-then-library upload, extend ffprobe metadata in the existing JSON artifact payload, enforce the resolution rule before persistence, and expose server-detected resolution through the existing evidence DTO. Correct only the Staging API Nginx vhost and preserve historical artifact compatibility.

**Tech Stack:** TypeScript 6, React 19, Next.js 16, Ant Design 6, NestJS 11, Prisma 7 JSON metadata, Vitest 4, ffprobe/ffmpeg, Nginx, Docker Compose, GitHub Actions/GHCR.

## Global Constraints

- Mobile VIDEO upload must not create an `<input capture="environment" accept="video/*">`; PHOTO capture remains available.
- Field copy must instruct operators to use the phone system camera at 720p or higher and then choose the video from the album.
- The application limit remains exactly 300 MiB per video; the Staging API ingress limit is exactly 320 MiB.
- `WALKAROUND_VIDEO` passes only when `min(videoWidthPx, videoHeightPx) >= 720`.
- Frame rate and bit rate are diagnostics only and must not become acceptance gates in this wave.
- New walkaround uploads write `videoQualityStatus: "PASSED"`; legacy `artifactVersion: 1` metadata without new fields remains valid.
- Historical repair runs with `qualityPolicy: "LEGACY_REPAIR"` and must not retroactively reject an existing low-resolution source.
- No Prisma schema change, migration, historical backfill, PDF regeneration, or Production change is allowed.
- Do not change Wave 1 orchestration, SMS, eSign, archive behavior, STG2-007 Field/PDF mapping, or the approved GPS extension boundary.
- Every code task follows red-green-refactor and ends with a focused commit.

---

## File Structure

- Modify `apps/web/src/lib/field-handover-upload.ts`: define the mobile input contracts and operator guidance copy.
- Modify `apps/web/src/components/field-handover-evidence-upload-controls.tsx`: render guidance and remove the unreachable video-capture icon branch.
- Modify `apps/web/src/lib/field-handover-api.ts`: type evidence metadata and map HTTP 413 before JSON parsing.
- Modify `apps/web/src/lib/field-handover-view-model.ts`: derive Field video-resolution display text from server metadata.
- Create `apps/web/src/lib/field-handover-video-quality.ts`: one pure formatter shared by Field and Admin.
- Modify `apps/web/src/app/field/handover/tasks/[id]/page.tsx`: show video-resolution facts in the Field file row.
- Modify `apps/web/src/app/orders/[id]/page.tsx`: show the same server-detected resolution in Admin.
- Modify `apps/web/test/field-handover-upload.spec.ts`: lock the no-direct-video-capture contract and guidance.
- Modify `apps/web/test/field-handover-api.spec.ts`: lock explicit 413 behavior.
- Create `apps/web/test/field-handover-video-quality.spec.ts`: lock resolution formatting and legacy behavior.
- Modify `apps/web/test/field-handover-view-model.spec.ts`: lock Field evidence view integration.
- Modify `apps/api/src/delivery-handover/delivery-handover-evidence-artifact.service.ts`: parse video quality metadata, enforce 720p, and distinguish quality failures from generic processing failures.
- Modify `apps/api/src/handover-work-order/handover-work-order.service.ts`: return the actionable quality message and opt historical repair out of the new gate.
- Modify `apps/api/test/stage2-handover-evidence-artifact.spec.ts`: lock ffprobe parsing, accepted dimensions, rejected dimensions, non-walkaround behavior, and legacy repair.
- Modify `apps/api/test/handover-work-order.spec.ts`: lock public error propagation, zero storage on rejection, and legacy-repair policy.
- Modify `apps/api/test/delivery-evidence.spec.ts`: prove historical artifact metadata without quality fields remains accepted.
- Modify API test harness metadata in `apps/api/test/stage2-handover-e2e.spec.ts` and `apps/api/test/handover-work-order.spec.ts`: satisfy the expanded prepared-artifact type without changing business assertions.
- Modify `docs/acceptance/2026-08-01-stage2-handover-acceptance-issues.md`: record implementation and Staging verification evidence for STG2-004/005.
- No source edit is required in `nginx/staging-subauto.example.conf`; it already contains the approved 320m/1200s/no-buffering contract. The actual BT Nginx file is `/www/server/panel/vhost/nginx/staging-api.subauto.keybox.cloud.conf`.

---

### Task 1: Remove Direct Mobile Video Capture and Add Operator Guidance

**Files:**
- Modify: `apps/web/test/field-handover-upload.spec.ts`
- Modify: `apps/web/src/lib/field-handover-upload.ts`
- Modify: `apps/web/src/components/field-handover-evidence-upload-controls.tsx`

**Interfaces:**
- Consumes: `FieldEvidenceMediaType[]`, `FieldEvidenceUploadEnvironment`.
- Produces: `getFieldEvidenceUploadGuidance(allowedMediaTypes): string | null`; VIDEO mobile contracts contain only `library`; mixed contracts contain `photo-capture` plus `library`.

- [ ] **Step 1: Replace the mobile video-contract expectations and add guidance tests**

Add these expectations to `apps/web/test/field-handover-upload.spec.ts` and import `getFieldEvidenceUploadGuidance`:

```ts
it("never offers direct video capture on mobile", () => {
  expect(buildFieldEvidenceUploadInputContracts(["VIDEO"], false, "MOBILE")).toEqual([
    {
      accept: "video/*",
      key: "library",
      label: "从相册选择",
      multiple: false
    }
  ]);
  expect(buildFieldEvidenceUploadInputContracts(["PHOTO", "VIDEO"], true, "MOBILE"))
    .toEqual([
      {
        accept: "image/*",
        capture: "environment",
        key: "photo-capture",
        label: "现场拍摄",
        multiple: false
      },
      {
        accept: "image/*,video/*",
        key: "library",
        label: "从相册选择",
        multiple: true
      }
    ]);
});

it("guides video operators to the system camera and keeps photo-only copy empty", () => {
  const guidance = getFieldEvidenceUploadGuidance(["VIDEO"]);
  expect(guidance).toContain("系统相机");
  expect(guidance).toContain("720p");
  expect(guidance).toContain("300MB");
  expect(getFieldEvidenceUploadGuidance(["PHOTO", "VIDEO"])).toContain("系统相机");
  expect(getFieldEvidenceUploadGuidance(["PHOTO"])).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- field-handover-upload.spec.ts
```

Expected: FAIL because `getFieldEvidenceUploadGuidance` does not exist and mobile contracts still include `video-capture`.

- [ ] **Step 3: Implement the minimal input-contract and guidance changes**

In `apps/web/src/lib/field-handover-upload.ts`, remove the mobile VIDEO capture block and add:

```ts
const FIELD_VIDEO_LIBRARY_GUIDANCE =
  "请先使用手机系统相机以 720p 或更高画质录制完整车辆环绕视频，再从相册选择上传。单个视频不超过 300MB。";

export function getFieldEvidenceUploadGuidance(
  allowedMediaTypes: FieldEvidenceMediaType[]
): string | null {
  return allowedMediaTypes.includes("VIDEO") ? FIELD_VIDEO_LIBRARY_GUIDANCE : null;
}
```

In `apps/web/src/components/field-handover-evidence-upload-controls.tsx`:

- import `Typography` and `getFieldEvidenceUploadGuidance`;
- remove `VideoCameraOutlined`;
- render the guidance immediately above the primary upload button;
- use `CameraOutlined` only for `photo-capture`, `FolderOpenOutlined` for `library`, and `UploadOutlined` as the remaining fallback.

```tsx
const guidance = getFieldEvidenceUploadGuidance(allowedMediaTypes);

{guidance ? (
  <Typography.Paragraph style={{ color: "#607086", fontSize: 12, marginBottom: 8 }}>
    {guidance}
  </Typography.Paragraph>
) : null}
```

- [ ] **Step 4: Run the focused Web test and verify GREEN**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- field-handover-upload.spec.ts
```

Expected: PASS; rendered markup contains the guidance and contains no “现场录像”.

- [ ] **Step 5: Commit the mobile capture contract**

```powershell
git add -- apps/web/src/lib/field-handover-upload.ts apps/web/src/components/field-handover-evidence-upload-controls.tsx apps/web/test/field-handover-upload.spec.ts
git commit -m "fix: route field video capture through system camera"
```

---

### Task 2: Map Upload Gateway 413 to an Actionable Error

**Files:**
- Modify: `apps/web/test/field-handover-api.spec.ts`
- Modify: `apps/web/src/lib/field-handover-api.ts`

**Interfaces:**
- Consumes: XHR `status` and `responseText`.
- Produces: HTTP 413 `ApiError` with status 413 and the exact approved Chinese message.

- [ ] **Step 1: Add the failing 413 test**

Add to `apps/web/test/field-handover-api.spec.ts`:

```ts
it("maps an HTML gateway 413 to the configured upload-limit message", async () => {
  const xhrMock = installMockXmlHttpRequest();
  const request = uploadAndAttachFieldHandoverEvidenceFile(
    "work-order-1",
    "walkaround-item",
    new File(["video"], "walkaround.mov", { type: "video/quicktime" })
  );

  xhrMock.latest().complete(413, "<html>request entity too large</html>");

  await expect(request).rejects.toMatchObject({
    message: "文件过大，单个视频不得超过 300MB。若文件未超过限制，请联系管理员检查上传网关配置。",
    status: 413
  });
});
```

- [ ] **Step 2: Run the focused API-client test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- field-handover-api.spec.ts
```

Expected: FAIL with the current generic upload failure message.

- [ ] **Step 3: Implement status-first 413 handling**

In `apps/web/src/lib/field-handover-api.ts`, add:

```ts
const FIELD_EVIDENCE_UPLOAD_TOO_LARGE_MESSAGE =
  "文件过大，单个视频不得超过 300MB。若文件未超过限制，请联系管理员检查上传网关配置。";
```

At the start of the non-2xx branch in `settleFieldEvidenceUpload`:

```ts
if (xhr.status === 413) {
  reject(new ApiError(FIELD_EVIDENCE_UPLOAD_TOO_LARGE_MESSAGE, 413));
  return;
}
```

Do not change network, timeout, cancellation, JSON business-error, or malformed-success behavior.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- field-handover-api.spec.ts
```

Expected: PASS, including all existing upload error cases.

- [ ] **Step 5: Commit the gateway error mapping**

```powershell
git add -- apps/web/src/lib/field-handover-api.ts apps/web/test/field-handover-api.spec.ts
git commit -m "fix: explain field upload gateway limits"
```

---

### Task 3: Probe Video Quality and Enforce the 720p Walkaround Gate

**Files:**
- Modify: `apps/api/test/stage2-handover-evidence-artifact.spec.ts`
- Modify: `apps/api/src/delivery-handover/delivery-handover-evidence-artifact.service.ts`

**Interfaces:**
- Consumes: ffprobe `width`, `height`, `avg_frame_rate`, `r_frame_rate`, stream/container `bit_rate`; `PrepareDeliveryEvidenceUploadInput.qualityPolicy`.
- Produces: metadata fields `videoWidthPx`, `videoHeightPx`, `videoFrameRate`, `videoBitRateBps`, `videoQualityStatus`; `DeliveryEvidenceVideoQualityError`; `getDeliveryEvidenceVideoQualityPublicMessage(error): string | null`.

- [ ] **Step 1: Add accepted-metadata, rejection, non-walkaround, and legacy-repair tests**

Update the existing successful walkaround probe fixture to:

```ts
format: { bit_rate: "9000000", duration: "20.5", format_name: "mov,mp4" },
streams: [{
  avg_frame_rate: "30000/1001",
  bit_rate: "8000000",
  codec_name: "h264",
  codec_type: "video",
  height: 1080,
  r_frame_rate: "30/1",
  width: 1920
}]
```

Assert:

```ts
expect(prepared.metadata).toMatchObject({
  videoBitRateBps: 8_000_000,
  videoFrameRate: 29.97002997002997,
  videoHeightPx: 1080,
  videoQualityStatus: "PASSED",
  videoWidthPx: 1920
});
```

Add table-driven acceptance for `1280×720` and `720×1280`, plus these cases:

```ts
it("rejects a 480x360 walkaround before creating keyframes", async () => {
  const runner = videoRunner({ height: 360, width: 480 });
  const service = new DeliveryHandoverEvidenceArtifactService(undefined, runner);
  const error = await service.prepareUpload(walkaroundVideoInput()).catch((value) => value);

  expect(getDeliveryEvidenceVideoQualityPublicMessage(error)).toBe(
    "车辆环绕视频清晰度不足，检测到 480×360，请使用系统相机以 720p 或更高画质重新录制后上传。"
  );
  expect(runner).toHaveBeenCalledTimes(1);
});

it("rejects a walkaround whose dimensions cannot be identified", async () => {
  const error = await serviceWithProbe({ codec_name: "h264", codec_type: "video" })
    .prepareUpload(walkaroundVideoInput())
    .catch((value) => value);
  expect(getDeliveryEvidenceVideoQualityPublicMessage(error)).toContain(
    "无法识别视频分辨率"
  );
});

it("records low resolution for non-walkaround video without enforcing the gate", async () => {
  const prepared = await serviceWithProbe({ height: 360, width: 480 }).prepareUpload({
    ...walkaroundVideoInput(),
    evidenceType: "WHEEL_CLOSEUP_FRONT_LEFT"
  });
  expect(prepared.metadata).toMatchObject({
    videoHeightPx: 360,
    videoQualityStatus: null,
    videoWidthPx: 480
  });
  await prepared.cleanup();
});

it("allows legacy repair to process an existing low-resolution walkaround", async () => {
  const prepared = await serviceWithProbe({ height: 360, width: 480 }).prepareUpload({
    ...walkaroundVideoInput(),
    qualityPolicy: "LEGACY_REPAIR"
  });
  expect(prepared.metadata.videoQualityStatus).toBeNull();
  await prepared.cleanup();
});
```

Define test helpers in this file with complete valid duration/format/codec fixture data; the command runner must create distinct fake JPEGs for ffmpeg calls.

- [ ] **Step 2: Run the artifact test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- stage2-handover-evidence-artifact.spec.ts
```

Expected: FAIL because dimensions are not probed, quality metadata and the public-message function do not exist, and low-resolution walkarounds are accepted.

- [ ] **Step 3: Expand the artifact types and ffprobe request**

Add to `DeliveryEvidenceArtifactMetadata`:

```ts
videoBitRateBps: number | null;
videoFrameRate: number | null;
videoHeightPx: number | null;
videoQualityStatus: "PASSED" | null;
videoWidthPx: number | null;
```

Add to `PrepareDeliveryEvidenceUploadInput`:

```ts
qualityPolicy?: "ENFORCE_CURRENT" | "LEGACY_REPAIR";
```

Change ffprobe entries to:

```ts
"stream=codec_name,codec_type,width,height,avg_frame_rate,r_frame_rate,bit_rate:format=duration,format_name,bit_rate"
```

Parse positive safe integer dimensions/bit rate and finite positive rational frame rate. Prefer `avg_frame_rate`, fall back to `r_frame_rate`; prefer stream bit rate, fall back to format bit rate.

- [ ] **Step 4: Add a typed quality failure and enforce it before frame extraction**

Export a domain error carrying nullable dimensions together with the safe public-message formatter:

```ts
export class DeliveryEvidenceVideoQualityError extends Error {
  constructor(
    readonly widthPx: number | null,
    readonly heightPx: number | null
  );
}

export function getDeliveryEvidenceVideoQualityPublicMessage(
  error: unknown
): string | null;
```

The function returns the exact detected-resolution message or the exact unrecognized-resolution message. `normalizeProcessingError` must preserve this error instead of converting it to generic processing failure.

Immediately after probe parsing:

```ts
const enforceWalkaroundQuality =
  evidenceType === "WALKAROUND_VIDEO" && qualityPolicy !== "LEGACY_REPAIR";
if (enforceWalkaroundQuality && !meetsWalkaroundMinimum(parsed.widthPx, parsed.heightPx)) {
  throw new DeliveryEvidenceVideoQualityError(parsed.widthPx, parsed.heightPx);
}
```

Set `videoQualityStatus` to `"PASSED"` only for an enforced, accepted walkaround. PHOTO fields are all `null`; non-walkaround and legacy-repair video status is `null`.

- [ ] **Step 5: Run the artifact test and verify GREEN**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- stage2-handover-evidence-artifact.spec.ts
```

Expected: PASS; a low-resolution walkaround invokes only ffprobe and creates no keyframes.

- [ ] **Step 6: Commit the media quality core**

```powershell
git add -- apps/api/src/delivery-handover/delivery-handover-evidence-artifact.service.ts apps/api/test/stage2-handover-evidence-artifact.spec.ts
git commit -m "feat: enforce stage2 walkaround video quality"
```

---

### Task 4: Propagate Quality Failures and Preserve Historical Repair

**Files:**
- Modify: `apps/api/test/handover-work-order.spec.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/test/stage2-handover-e2e.spec.ts`

**Interfaces:**
- Consumes: `getDeliveryEvidenceVideoQualityPublicMessage` and `qualityPolicy` from Task 3.
- Produces: Field upload HTTP 422 with actionable quality message; historical artifact repair passes `qualityPolicy: "LEGACY_REPAIR"`.

- [ ] **Step 1: Add workflow-level failing tests**

In `apps/api/test/handover-work-order.spec.ts`, make the artifact-service mock reject a walkaround upload with the exported domain error, then assert:

```ts
harness.artifactService.prepareUpload.mockRejectedValueOnce(
  new DeliveryEvidenceVideoQualityError(480, 360)
);
await expect(
  harness.service.uploadAndAttachFieldAccessibleEvidenceFile(
    "work-order-visible",
    "13800000000",
    walkaroundItem.id,
    [uploadFile("low.mov", "video/quicktime")],
    {},
    "field-session-1"
  )
).rejects.toMatchObject({
  response: {
    message: expect.stringContaining("检测到 480×360")
  },
  status: 422
});
expect(harness.storageService.putDeliveryEvidenceFile).not.toHaveBeenCalled();
expect(harness.storageService.putDeliveryEvidenceFileFromPath).not.toHaveBeenCalled();
expect(harness.evidenceService.attachEvidenceFile).not.toHaveBeenCalled();
```

Extend the historical repair assertion:

```ts
expect(harness.artifactService.prepareUpload).toHaveBeenCalledWith(
  expect.objectContaining({ qualityPolicy: "LEGACY_REPAIR" })
);
```

- [ ] **Step 2: Run the workflow test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- handover-work-order.spec.ts
```

Expected: FAIL because the quality error is converted to the generic processing message and repair does not pass a policy.

- [ ] **Step 3: Implement quality-message propagation and repair policy**

Import `getDeliveryEvidenceVideoQualityPublicMessage`. In the upload catch block:

```ts
const qualityMessage = getDeliveryEvidenceVideoQualityPublicMessage(error);
if (qualityMessage) {
  throw new UnprocessableEntityException(qualityMessage);
}
if (isDeliveryEvidenceArtifactProcessingError(error)) {
  throw new UnprocessableEntityException(
    "资料文件处理失败，请重新选择文件后重试。"
  );
}
```

In `prepareExistingEvidenceFileArtifacts`, pass:

```ts
qualityPolicy: "LEGACY_REPAIR"
```

Update prepared-artifact mocks in `handover-work-order.spec.ts` and `stage2-handover-e2e.spec.ts` with the five new metadata fields. Use 1920×1080 and `"PASSED"` only for new `WALKAROUND_VIDEO`; use `null` values for photos and other video types.

- [ ] **Step 4: Run workflow and Stage 2 E2E tests and verify GREEN**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- handover-work-order.spec.ts stage2-handover-e2e.spec.ts
```

Expected: PASS; the generic processing path remains unchanged and historical repair explicitly bypasses the new gate.

- [ ] **Step 5: Commit workflow integration**

```powershell
git add -- apps/api/src/handover-work-order/handover-work-order.service.ts apps/api/test/handover-work-order.spec.ts apps/api/test/stage2-handover-e2e.spec.ts
git commit -m "fix: surface stage2 video quality failures"
```

---

### Task 5: Show Server-Detected Resolution in Field and Admin

**Files:**
- Create: `apps/web/src/lib/field-handover-video-quality.ts`
- Create: `apps/web/test/field-handover-video-quality.spec.ts`
- Modify: `apps/web/src/lib/field-handover-api.ts`
- Modify: `apps/web/src/lib/field-handover-view-model.ts`
- Modify: `apps/web/src/app/field/handover/tasks/[id]/page.tsx`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Modify: `apps/web/test/field-handover-view-model.spec.ts`
- Modify: `apps/api/test/delivery-evidence.spec.ts`

**Interfaces:**
- Consumes: evidence file `mediaType` and untrusted JSON `metadata` returned by the existing DTO.
- Produces: `formatFieldEvidenceVideoQuality(mediaType, metadata): string | null`; Field view `videoQualityText`.

- [ ] **Step 1: Add pure formatter and integration tests**

Create `apps/web/test/field-handover-video-quality.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatFieldEvidenceVideoQuality } from "../src/lib/field-handover-video-quality";

describe("field handover video quality", () => {
  it("formats server-detected video dimensions", () => {
    expect(formatFieldEvidenceVideoQuality("VIDEO", {
      videoHeightPx: 1080,
      videoQualityStatus: "PASSED",
      videoWidthPx: 1920
    })).toBe("视频清晰度：1920×1080（符合环绕视频最低要求）");
  });

  it("labels legacy video metadata without inventing dimensions", () => {
    expect(formatFieldEvidenceVideoQuality("VIDEO", { artifactVersion: 1 }))
      .toBe("视频清晰度：历史资料未记录");
  });

  it("does not add a video row to photos", () => {
    expect(formatFieldEvidenceVideoQuality("PHOTO", { videoWidthPx: 1920 })).toBeNull();
  });
});
```

Add metadata to the sample walkaround file in `field-handover-view-model.spec.ts` and expect `videoQualityText`. The shared formatter test is the executable contract used by both Field and Admin; Admin page wiring is verified by typecheck and the Staging acceptance step rather than by inspecting source text.

In `delivery-evidence.spec.ts`, attach a VIDEO using the existing legacy `artifactVersion: 1` fixture without any quality fields and assert it remains accepted. This test proves the API source compatibility contract rather than changing `assertEvidenceArtifactsReady`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- field-handover-video-quality.spec.ts field-handover-view-model.spec.ts
pnpm --filter @subscription-saas/api test -- delivery-evidence.spec.ts
```

Expected: Web tests FAIL because the formatter and metadata types do not exist; the API legacy test should PASS before and after implementation.

- [ ] **Step 3: Implement the shared safe formatter and DTO types**

Create `apps/web/src/lib/field-handover-video-quality.ts` with record guards that accept only positive safe integer dimensions:

```ts
export function formatFieldEvidenceVideoQuality(
  mediaType: null | string | undefined,
  metadata: unknown
): string | null {
  if (mediaType !== "VIDEO") return null;
  const record = isRecord(metadata) ? metadata : null;
  const width = positiveInteger(record?.videoWidthPx);
  const height = positiveInteger(record?.videoHeightPx);
  if (!width || !height) return "视频清晰度：历史资料未记录";
  const suffix = record?.videoQualityStatus === "PASSED"
    ? "（符合环绕视频最低要求）"
    : "";
  return `视频清晰度：${width}×${height}${suffix}`;
}
```

Add `metadata?: Record<string, unknown> | null` to `FieldHandoverEvidenceFile` and Admin `HandoverEvidenceFile`. Add `videoQualityText: string | null` to `FieldHandoverEvidenceFileView` and populate it with the formatter.

- [ ] **Step 4: Render the resolution in both pages**

In the Field file row, directly below `sizeText`:

```tsx
{file.videoQualityText ? (
  <Typography.Text style={{ color: "#718096", display: "block", fontSize: 12 }}>
    {file.videoQualityText}
  </Typography.Text>
) : null}
```

In the Admin file row, call the same formatter and render the returned text next to file size. Do not render a quality label for photos.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- field-handover-video-quality.spec.ts field-handover-view-model.spec.ts
pnpm --filter @subscription-saas/api test -- delivery-evidence.spec.ts
```

Expected: PASS; legacy VIDEO reads “历史资料未记录”, new accepted walkaround displays exact dimensions, and PHOTO adds no row.

- [ ] **Step 6: Commit resolution visibility and compatibility proof**

```powershell
git add -- apps/web/src/lib/field-handover-video-quality.ts apps/web/src/lib/field-handover-api.ts apps/web/src/lib/field-handover-view-model.ts "apps/web/src/app/field/handover/tasks/[id]/page.tsx" "apps/web/src/app/orders/[id]/page.tsx" apps/web/test/field-handover-video-quality.spec.ts apps/web/test/field-handover-view-model.spec.ts apps/api/test/delivery-evidence.spec.ts
git commit -m "feat: display stage2 video resolution evidence"
```

---

### Task 6: Run Quality Gates and Record the Release Candidate

**Files:**
- Modify: `docs/acceptance/2026-08-01-stage2-handover-acceptance-issues.md`

**Interfaces:**
- Consumes: all Tasks 1–5.
- Produces: a clean release candidate with recorded automated evidence and no migration.

- [ ] **Step 1: Run all focused regression tests together**

```powershell
pnpm --filter @subscription-saas/web test -- field-handover-upload.spec.ts field-handover-api.spec.ts field-handover-video-quality.spec.ts field-handover-view-model.spec.ts
pnpm --filter @subscription-saas/api test -- stage2-handover-evidence-artifact.spec.ts handover-work-order.spec.ts delivery-evidence.spec.ts stage2-handover-e2e.spec.ts
```

Expected: all selected tests PASS.

- [ ] **Step 2: Run required static and Prisma gates**

```powershell
$env:DATABASE_URL='postgresql://validation:validation@127.0.0.1:5432/subscription_saas?schema=public'
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/web lint
```

Expected: all commands exit 0. The placeholder URL is used only for schema parsing and is not contacted.

- [ ] **Step 3: Re-run migration status against the actual Staging PostgreSQL container**

Use the temporary SSH-forward procedure already verified in this worktree: resolve the Staging PostgreSQL container IP, obtain `DATABASE_URL` from `subauto-staging-api-1` without printing it, rewrite only host/port to `127.0.0.1:55439`, start hidden `ssh.exe -N -L`, run:

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected:

```text
73 migrations found in prisma/migrations
Database schema is up to date!
```

Always stop the exact temporary SSH process in `finally`.

- [ ] **Step 4: Update the acceptance report with release-candidate evidence**

For STG2-004/005, record:

- root cause confirmed;
- code behavior implemented;
- focused tests and static gates passed;
- no database migration;
- Staging Nginx and device acceptance still pending in Task 7;
- direct mobile video capture removed by approved solution B;
- GPS/evidence-session design remains a non-implemented extension.

- [ ] **Step 5: Check and commit the release candidate documentation**

```powershell
git diff --check
git status --short
git add -- docs/acceptance/2026-08-01-stage2-handover-acceptance-issues.md
git commit -m "docs: record stage2 media quality release candidate"
```

Expected: only intentional Wave 2 files are changed and the commit succeeds.

---

### Task 7: Review, Build, Correct Staging Ingress, Deploy, and Accept

**Files:**
- Modify after acceptance: `docs/acceptance/2026-08-01-stage2-handover-acceptance-issues.md`
- Remote operational file: `/www/server/panel/vhost/nginx/staging-api.subauto.keybox.cloud.conf`
- Remote deployment env: `/opt/subscription-saas/.env.staging.images`

**Interfaces:**
- Consumes: clean release-candidate commit and GitHub Actions workflow `.github/workflows/docker-images.yml`.
- Produces: immutable API/Web images, corrected Staging ingress, verified Stage 2 uploads, and merge-ready PR.

- [ ] **Step 1: Perform self-review and request code review without delegation**

Run:

```powershell
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Review every changed file against the design spec. Confirm no Production, PDF mapping, GPS implementation, Prisma schema, or migration file changed.

- [ ] **Step 2: Push the feature branch and open a PR**

```powershell
git push -u origin fix/staging-stage2-media-upload-quality-20260802
gh pr create --base main --head fix/staging-stage2-media-upload-quality-20260802 --title "fix: harden stage2 media upload quality" --body-file docs/superpowers/specs/2026-08-02-stage2-media-upload-quality-design.zh-CN.md
```

Expected: a PR URL is returned. Wait for required checks and inspect failures before continuing.

- [ ] **Step 3: Build immutable Staging images from the reviewed branch**

```powershell
$shortSha = (git rev-parse --short=7 HEAD).Trim()
$imageTag = "Staging-20260802-$shortSha"
gh workflow run docker-images.yml --ref fix/staging-stage2-media-upload-quality-20260802 -f registry=ghcr.io -f namespace=keqi119 -f imageTag=$imageTag -f apiBaseUrl=https://staging-api.subauto.keybox.cloud/api -f environment=staging
```

Wait for the dispatched run and verify both GHCR images exist:

```text
ghcr.io/keqi119/subscription-api:<imageTag>
ghcr.io/keqi119/subscription-web:<imageTag>
```

- [ ] **Step 4: Back up and correct only the Staging API Nginx vhost**

On `root@139.196.227.195`, create a timestamped backup beside the exact file. Replace:

```nginx
client_max_body_size 20m;
```

with:

```nginx
client_max_body_size 320m;
client_body_timeout 1200s;
```

Inside `location /`, add:

```nginx
proxy_request_buffering off;
```

and change both proxy timeouts from `300s` to `1200s`. Then run:

```text
nginx -t
```

Expected: syntax successful. Only then reload Nginx and verify `nginx -T` shows 320m, 1200s, and buffering off for `staging-api.subauto.keybox.cloud`. Confirm `staging-admin` remains 20m.

- [ ] **Step 5: Deploy only the new Staging API/Web images**

Back up `/opt/subscription-saas/.env.staging.images`, update only `API_IMAGE` and `WEB_IMAGE` to the Task 7 image tag, then run from `/opt/subscription-saas`:

```text
docker compose --env-file .env.staging.images -f docker-compose.staging.images.example.yml pull api web
docker compose --env-file .env.staging.images -f docker-compose.staging.images.example.yml up -d api web
docker compose --env-file .env.staging.images -f docker-compose.staging.images.example.yml ps
```

Expected: `subauto-staging-api-1` and `subauto-staging-web-1` are healthy on the new tags; PostgreSQL image/container ID is unchanged. Verify Production container IDs are unchanged.

- [ ] **Step 6: Execute automated and manual Staging acceptance**

Verify:

1. Health endpoint returns 2xx.
2. Mobile Field drawer has no “现场录像”; photo “现场拍摄” remains.
3. A 480×360 walkaround returns the exact 720p re-recording message and creates no evidence file.
4. A system-camera 720p or 1080p walkaround uploads and Field/Admin display actual dimensions.
5. `IMG_0203.mov` at approximately 191.6 MiB completes upload and derivative processing.
6. A file over 300 MiB is rejected before upload with the existing client-size message.
7. A forced 413 displays the gateway-limit message, not a network error.
8. API logs contain no new ERROR/FATAL events for successful cases.

- [ ] **Step 7: Record acceptance evidence and merge**

Update STG2-004/005 in the acceptance report with image tags/digests, Nginx effective values, tested file sizes/resolutions, timestamps, and results. Commit and push:

```powershell
git add -- docs/acceptance/2026-08-01-stage2-handover-acceptance-issues.md
git commit -m "docs: close stage2 media upload acceptance"
git push
```

Wait for the updated PR checks, then merge the PR. Verify `origin/main` contains the accepted tree.

- [ ] **Step 8: Preserve rollback evidence**

Record the previous API/Web image IDs and the Nginx backup path. Rollback, if required, is exactly:

- restore the timestamped Nginx backup, run `nginx -t`, then reload;
- restore the previous two image values in `.env.staging.images`;
- run Docker Compose pull/up for API/Web;
- do not touch PostgreSQL because this wave has no migration.

---

## Self-Review Record

- Spec coverage: all approved Wave 2 requirements map to Tasks 1–7; the GPS location-proof extension is explicitly excluded from implementation.
- Placeholder scan: the plan contains no incomplete code steps or unspecified error handling.
- Type consistency: `qualityPolicy`, `videoWidthPx`, `videoHeightPx`, `videoFrameRate`, `videoBitRateBps`, `videoQualityStatus`, `getDeliveryEvidenceVideoQualityPublicMessage`, `formatFieldEvidenceVideoQuality`, and `videoQualityText` are named consistently across producers and consumers.
- Compatibility: historical `artifactVersion: 1` remains accepted, historical repair uses `LEGACY_REPAIR`, and no manifest/PDF/database behavior changes.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-02-stage2-media-upload-quality.md`.

Execution will use **Inline Execution** with `superpowers:executing-plans`, because the user asked to continue the current implementation and no subagent delegation was requested. Checkpoints occur after Tasks 2, 5, and 7.
