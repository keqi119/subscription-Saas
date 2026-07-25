# Stage 2 Evidence-Bound PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a Stage 2 handover PDF that visibly covers every active photo and video, binds the customer confirmation and PDF to one deterministic manifest hash, and stays within the approved PDF resource limits.

**Architecture:** Upload processing creates immutable source hashes plus private photo previews or video keyframes and stores their IDs in evidence-file metadata. A pure manifest builder validates and canonically orders those records; Portal confirmation and Stage 2 readiness compare the current hash with the confirmed review-attempt snapshot. The PDF renderer reads only small derivatives, streams output through a temporary file, and enforces 15 MiB target, 18 MiB hard, and 100-page limits.

**Tech Stack:** NestJS, TypeScript, Prisma JSON metadata, PDFKit, Node.js crypto/streams/child_process, ffmpeg/ffprobe, Vitest, Poppler.

## Global Constraints

- Customer confirmation covers every active source photo and video in the current evidence manifest.
- Normal PDF target is at most 15 MiB (15,728,640 bytes).
- Internal PDF hard limit is 18 MiB (18,874,368 bytes); Fadada's external absolute limit remains 20MB.
- Verified locally against `3.6.1 API文档_合同上传.pdf`: Fadada accepts PDF documents and requires uploaded files to be `<=20MB`.
- PDF page count must not exceed 100 pages.
- Evidence must never be omitted to meet size limits; derivatives may be recompressed or generation must fail closed.
- Do not embed original video bytes or expose bucket, object key, temporary URL, token, or provider payload.
- Do not modify package manifests, Docker, finance, billing, lease, SMS, WeChat, Fadada/e-sign mapping, staging, production databases, or port 3001.
- Complete PDF visual acceptance before beginning Fadada Stage 2 signing mapping.

---

### Task 1: Deterministic Evidence Manifest

**Files:**
- Create: `apps/api/src/delivery-handover/delivery-handover-evidence-manifest.ts`
- Create: `apps/api/test/stage2-handover-evidence-manifest.spec.ts`
- Modify: `apps/api/src/delivery-evidence/delivery-evidence.service.ts`

**Interfaces:**
- Produces: `buildDeliveryHandoverEvidencePackage(input): DeliveryHandoverEvidencePackage`
- Produces: `assertDeliveryHandoverEvidenceArtifactsReady(package): void`
- Consumes evidence-file metadata fields `sourceSha256`, `sourceSizeBytes`, `processingStatus`, `photoPreviewFileId`, `videoDurationMs`, and `videoFrameFileIds`.

- [x] **Step 1: Write failing manifest tests**

Cover deterministic ordering, stable SHA-256 output when query order changes, one entry per active file, photo/video artifact validation, and rejection of missing hashes or derivatives.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api test -- stage2-handover-evidence-manifest.spec.ts
```

Expected: FAIL because the manifest module does not exist.

- [x] **Step 3: Implement canonical manifest construction**

Use explicit schema fields, fixed evidence-type order, uploaded-time and evidence-file-ID tie breakers, stable JSON serialization, and `sha256:<64 lowercase hex>` output. Extend checklist file views to include metadata for internal consumers.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the Task 1 test command and expect all manifest tests to pass.

### Task 2: Upload-Time Media Artifacts

**Files:**
- Create: `apps/api/src/delivery-handover/delivery-handover-evidence-artifact.service.ts`
- Create: `apps/api/test/stage2-handover-evidence-artifact.spec.ts`
- Modify: `apps/api/src/storage/storage.service.ts`
- Modify: `apps/api/src/delivery-evidence/delivery-evidence.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.module.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`

**Interfaces:**
- Produces: `prepareUpload(input): Promise<PreparedDeliveryEvidenceArtifacts>`
- Produces: photo preview JPEG with a maximum long edge of 1600px and bounded output size.
- Produces: four ordered frames for `WALKAROUND_VIDEO`, two for other videos, plus duration.
- Persists derivative `FileObject` IDs and processing metadata on `VehicleDeliveryEvidenceFile.metadata`.

- [x] **Step 1: Write failing processor tests**

Test the known SHA-256 vector, controlled child-process arguments, 4/2 frame selection, timeout/invalid/empty-output failure, and cleanup.

- [x] **Step 2: Run the focused tests and verify RED**

```bash
pnpm --filter @subscription-saas/api test -- stage2-handover-evidence-artifact.spec.ts
```

Expected: FAIL because the artifact service does not exist.

- [x] **Step 3: Implement the controlled processor and storage integration**

Use `spawn` with argument arrays, disabled stdin, configured `FFMPEG_PATH`/`FFPROBE_PATH` defaults, per-process timeout, request-specific temporary directories, and `finally` cleanup. Store the original and every derivative privately before binding them in one serializable database transaction; delete stored objects on rollback.

- [x] **Step 4: Run processor and upload tests**

```bash
pnpm --filter @subscription-saas/api test -- stage2-handover-evidence-artifact.spec.ts handover-work-order.spec.ts delivery-evidence.spec.ts
```

Expected: PASS with no partial evidence metadata.

### Task 3: Manifest-Bound Portal Confirmation and Readiness

**Files:**
- Modify: `apps/api/src/portal/portal-handover-review.dto.ts`
- Modify: `apps/api/src/portal/portal-handover-review.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/test/portal-handover-review.spec.ts`
- Modify: `apps/api/test/stage2-handover-e2e.spec.ts`
- Modify: `apps/web/src/lib/portal-handover-review-api.ts`
- Modify: `apps/web/src/lib/portal-handover-review-view-model.ts`
- Modify: `apps/web/src/app/portal/handover-reviews/[id]/page.tsx`
- Modify: related web tests under `apps/web/test/`

**Interfaces:**
- Portal detail returns `evidencePackage.manifestHash`, counts, readiness, and all-file confirmation text.
- Confirmation request requires `{ acknowledgement: true, manifestHash: "sha256:..." }`.
- Latest successful `VehicleHandoverReviewAttempt.evidenceSnapshot` stores the full manifest and hash.

- [x] **Step 1: Write failing API and UI tests**

Cover missing/stale hashes, all-file confirmation copy, successful snapshot persistence, and readiness invalidation after any evidence metadata or lifecycle change.

- [x] **Step 2: Run the focused tests and verify RED**

```bash
pnpm --filter @subscription-saas/api test -- portal-handover-review.spec.ts stage2-handover-e2e.spec.ts
pnpm --filter @subscription-saas/web test -- portal-handover-review-api.spec.ts portal-handover-review-pages.spec.ts portal-handover-review-view-model.spec.ts
```

Expected: FAIL because manifest-bound confirmation is not implemented.

- [x] **Step 3: Implement confirmation and readiness comparison**

Rebuild the current package server-side, compare it with the submitted hash, refresh the successful attempt snapshot, and require the latest confirmed snapshot hash to equal the current hash before Stage 2 PDF generation.

- [x] **Step 4: Run focused API and web tests**

Run the Task 3 commands and expect all tests to pass.

### Task 4: Full Evidence PDF and Resource Gates

**Files:**
- Modify: `apps/api/src/delivery-handover/delivery-handover-pdf-render-model.ts`
- Modify: `apps/api/src/delivery-handover/delivery-handover-pdf-renderer.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/storage/storage.service.ts`
- Modify: `apps/api/test/stage2-handover-pdf.spec.ts`

**Interfaces:**
- Render model includes package ID, schema version, manifest hash, counts, stable protected package URL, and every manifest file.
- Renderer option `loadAsset(fileId)` resolves only derivative IDs.
- Production renderer writes a temporary PDF path and returns byte size/page count diagnostics.

- [x] **Step 1: Write failing PDF tests**

Assert all photos have visible preview calls, all videos have 4/2 ordered frames, every source ID/hash appears exactly once in its attachment entry, signature text references the manifest, original video IDs are never loaded as assets, and size/page gates reject output.

- [x] **Step 2: Run the focused tests and verify RED**

```bash
pnpm --filter @subscription-saas/api test -- stage2-handover-pdf.spec.ts
```

Expected: FAIL because the renderer has no evidence-package attachments or 18 MiB/100-page gates.

- [x] **Step 3: Implement streamed rendering**

Render the declaration, 14-row summary with appendix references, two-up photo pages, video frame grids, protected evidence-package URL, and manifest-bound signature area. Load one derivative at a time, write to a dedicated temporary file, validate `%PDF-`, byte size, and page count, upload from path, and clean up on every exit.

- [x] **Step 4: Run focused PDF and regression tests**

```bash
pnpm --filter @subscription-saas/api test -- stage2-handover-pdf.spec.ts delivery-handover.spec.ts
```

Expected: PASS without e-sign calls.

### Task 5: Verification and Visual Acceptance

**Files:**
- Create or update only test fixtures/scripts needed under `tmp/pdfs/` and `output/pdf/`; do not commit generated binaries.

- [x] **Step 1: Run API and web verification**

```bash
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
```

- [x] **Step 2: Generate representative and 32-file stress PDFs**

Record elapsed time, final bytes, page count, and memory delta. Require output at most 18 MiB and 100 pages, with normal representative output at most 15 MiB.

Result: the no-visible-damage representative contains 12 files and rendered to 5,438,618 bytes / 11 pages in 559 ms. The damage stress case contains 32 files (including 20 damage closeups) and rendered to 12,613,175 bytes / 21 pages in 729 ms. Both stayed below the 15 MiB target; observed RSS delta stayed below 41 MB.

- [x] **Step 3: Render every PDF page with Poppler**

```bash
pdftoppm -png output/pdf/stage2-handover-evidence-acceptance.pdf tmp/pdfs/stage2-handover-evidence-acceptance/page
pdfinfo output/pdf/stage2-handover-evidence-acceptance.pdf
```

Inspect every page for clipped text, incorrect rotation, stretched media, missing frames, orphan headings, overlapping signature areas, and unreadable hashes.

Result: Poppler rendered all 32 pages successfully. Contact-sheet and full-page inspection found no clipping, overlap, missing media, blank page, or signature-area collision.

- [x] **Step 4: Verify extracted content**

Use PDF text extraction to confirm package ID, manifest hash, every evidence-file ID, and every source SHA-256 are present. Confirm no bucket, object key, temporary URL, token, or original video byte load appears.

Result: both PDFs parsed successfully; every expected evidence-file ID, original name, and source SHA-256 was present, each source SHA appeared exactly once, and no storage identifier or duplicated status text was found.

- [x] **Step 5: Commit locally**

Commit implementation and tests locally only. Do not push, open a PR, or begin Fadada Stage 2 signing mapping.
