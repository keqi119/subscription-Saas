# Field Video Resumable Multipart Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every field-handover video up to 300 MiB reliably uploadable inside the WeChat iOS WebView through resumable 8 MiB API-managed OSS multipart parts.

**Architecture:** Photos keep the existing single-request path. Videos use a database-backed upload session, sequential 8 MiB chunks sent to the existing API origin, server-owned OSS Multipart Upload, and a leased database worker that resumes finalization after disconnects or API restarts. The browser stores only an opaque session id and a file resume fingerprint; OSS identifiers never leave the API.

**Tech Stack:** TypeScript 6, NestJS, Prisma 7/PostgreSQL 17, ali-oss 6.23, Next.js 16/React 19, XMLHttpRequest, Web Crypto SHA-256, Vitest, Ant Design.

## Global Constraints

- The video limit is exactly `300 * 1024 * 1024` bytes; `300 MiB + 1 byte` must be rejected before any OSS session is created.
- The part size is exactly `8 * 1024 * 1024` bytes; a 300 MiB file therefore has 38 parts.
- Video parts upload sequentially with no parallel part requests.
- Photos keep the existing 10 MiB single-request path.
- The browser may receive only an opaque upload-session UUID, safe progress, user-facing status, and expiry; never return OSS bucket, object key, upload id, ETag, credentials, local paths, or stack traces.
- Resume requires the user to reselect the same file after a page/WebView reload; background upload after leaving WeChat is out of scope.
- A valid upload session expires 24 hours after its latest valid activity.
- Replacement becomes visible only after the new video passes FFprobe, 720p validation, derivative generation, and the final database transaction.
- Keep the legacy video endpoint compatible during API-first/Web-second rollout.
- Do not add Redis, a new queue service, client-side compression, or a browser-to-OSS path.
- Do not commit generated large binary fixtures; use sparse/generated files and OSS fakes.
- Use TDD for every task: observe the focused test fail before adding production code, then observe it pass.

---

## File Structure

### API and database

- `apps/api/prisma/schema.prisma`: upload-session enums, session model, part model, relations, and indexes.
- `apps/api/prisma/migrations/20260815010000_field_video_resumable_upload/migration.sql`: additive PostgreSQL schema and partial unique index for one live session per evidence item.
- `apps/api/src/field-operator/field-video-upload.constants.ts`: 8 MiB part size, 300 MiB total size, 24-hour expiry, safe retry constants.
- `apps/api/src/field-operator/field-video-upload.types.ts`: server-internal inputs, safe public snapshots, claimed-session and finalization-stage types.
- `apps/api/src/field-operator/field-video-upload.repository.ts`: all Prisma state transitions, part idempotency, leases, expiry, and terminal-state writes.
- `apps/api/src/field-operator/field-video-upload.service.ts`: authorization-aware create/resume/status/list/part/complete/retry/cancel orchestration.
- `apps/api/src/field-operator/field-video-upload.dto.ts`: validated HTTP request DTOs.
- `apps/api/src/field-operator/field-video-upload-options.ts`: disk-backed Multer options limited to one 8 MiB part.
- `apps/api/src/field-operator/field-video-upload.controller.ts`: guarded upload-session endpoints under `/api/field/handover`.
- `apps/api/src/field-operator/field-video-upload-finalizer.service.ts`: idempotent OSS completion, source download, quality processing, derivative storage, and evidence binding.
- `apps/api/src/field-operator/field-video-upload.worker.ts`: database poller, leases, retry scheduling, and expired-session cleanup.
- `apps/api/src/storage/storage.types.ts`: OSS multipart provider contracts.
- `apps/api/src/storage/oss-storage.provider.ts`: ali-oss multipart adapter.
- `apps/api/src/storage/storage.service.ts`: namespaced field-video multipart operations and internal-key handling.
- `apps/api/src/handover-work-order/handover-work-order.service.ts`: reusable authorization and “attach an already stored, prepared source” boundary.
- `apps/api/src/handover-work-order/handover-work-order.module.ts`: controller/service/repository/finalizer/worker registration.

### Web

- `apps/web/src/lib/field-video-upload.ts`: chunk plan, resume fingerprint, per-part SHA-256, progress, and safe status mapping.
- `apps/web/src/lib/field-video-upload-api.ts`: session API, per-part XHR, completion/status/retry/cancel requests.
- `apps/web/src/lib/field-video-upload-recovery.ts`: versioned localStorage recovery records with 24-hour pruning.
- `apps/web/src/lib/field-video-upload-runner.ts`: sequential missing-part runner, retry/backoff, pause, resume, and finalization polling.
- `apps/web/src/lib/use-field-video-upload.ts`: React state adapter that keeps the existing task page focused on page composition.
- `apps/web/src/components/field-video-upload-progress-card.tsx`: persistent progress, phase, retry, pause, cancel, and mismatch UI.
- `apps/web/src/components/field-video-upload-recovery-alert.tsx`: recovery prompt used by entry, list, and detail pages.
- `apps/web/src/app/field/handover/page.tsx`: recovery alert after login/entry.
- `apps/web/src/app/field/handover/tasks/page.tsx`: active recovery prompt linked to the original task.
- `apps/web/src/app/field/handover/tasks/[id]/page.tsx`: route videos to the new hook while leaving photo batches unchanged.

### Tests and operations

- `apps/api/test/field-video-upload-schema.spec.ts`
- `apps/api/test/field-video-upload-repository.spec.ts`
- `apps/api/test/field-video-upload-api.spec.ts`
- `apps/api/test/field-video-upload-part.spec.ts`
- `apps/api/test/field-video-upload-finalizer.spec.ts`
- `apps/api/test/field-video-upload.worker.spec.ts`
- `apps/api/test/storage.spec.ts`
- `apps/api/test/field-evidence-multipart.spec.ts`
- `apps/api/test/handover-work-order.spec.ts`
- `apps/web/test/field-video-upload.spec.ts`
- `apps/web/test/field-video-upload-api.spec.ts`
- `apps/web/test/field-video-upload-recovery.spec.ts`
- `apps/web/test/field-video-upload-runner.spec.ts`
- `apps/web/test/field-video-upload-ui.spec.tsx`
- `apps/web/test/field-handover-pages.spec.ts`
- `docs/stage2-local-handover-e2e-runbook.md`
- `.env.example`

---

### Task 1: Add the upload-session schema and migration

**Files:**

- Create: `apps/api/prisma/migrations/20260815010000_field_video_resumable_upload/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/test/field-video-upload-schema.spec.ts`

**Interfaces:**

- Produces Prisma models `FieldEvidenceVideoUploadSession` and `FieldEvidenceVideoUploadPart`.
- Produces enum `FieldEvidenceVideoUploadStatus` with `UPLOADING`, `FINALIZE_QUEUED`, `OSS_COMPLETING`, `OBJECT_READY`, `PROCESSING`, `RETRYABLE_FAILED`, `VALIDATION_FAILED`, `COMPLETED`, `CANCELLED`, and `EXPIRED`.
- Later tasks consume the generated Prisma delegates and enum without raw table access.

- [ ] **Step 1: Write the failing schema contract test**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(path.resolve("prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  path.resolve("prisma/migrations/20260815010000_field_video_resumable_upload/migration.sql"),
  "utf8"
);

describe("field video upload schema", () => {
  it("defines durable upload sessions and idempotent parts", () => {
    expect(schema).toContain("model FieldEvidenceVideoUploadSession");
    expect(schema).toContain("model FieldEvidenceVideoUploadPart");
    expect(schema).toContain("@@unique([sessionId, partNumber])");
    expect(migration).toContain("field_evidence_video_upload_session_one_live_item");
    expect(migration).toContain("WHERE status IN");
  });
});
```

- [ ] **Step 2: Run the test and verify the missing migration fails**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-schema.spec.ts`

Expected: FAIL with `ENOENT` for `20260815010000_field_video_resumable_upload/migration.sql`.

- [ ] **Step 3: Add the Prisma enum, models, relations, and exact SQL migration**

Use this model shape; map every camelCase field to snake_case and UUID foreign keys to `@db.Uuid`:

```prisma
enum FieldEvidenceVideoUploadStatus {
  UPLOADING
  FINALIZE_QUEUED
  OSS_COMPLETING
  OBJECT_READY
  PROCESSING
  RETRYABLE_FAILED
  VALIDATION_FAILED
  COMPLETED
  CANCELLED
  EXPIRED

  @@map("field_evidence_video_upload_status")
}

// Add these values to the existing VehicleHandoverEventType enum.
// The SQL migration must use ALTER TYPE ... ADD VALUE IF NOT EXISTS.
// FIELD_VIDEO_UPLOAD_CREATED
// FIELD_VIDEO_UPLOAD_RESUMED
// FIELD_VIDEO_UPLOAD_CANCELLED
// FIELD_VIDEO_UPLOAD_COMPLETED
// FIELD_VIDEO_UPLOAD_FAILED

model FieldEvidenceVideoUploadSession {
  id                    String                         @id @default(uuid()) @db.Uuid
  workOrderId           String                         @map("work_order_id") @db.Uuid
  evidenceItemId        String                         @map("evidence_item_id") @db.Uuid
  createdBySessionId    String?                        @map("created_by_session_id") @db.Uuid
  originalName          String                         @map("original_name") @db.VarChar(255)
  mimeType              String                         @map("mime_type") @db.VarChar(128)
  sizeBytes             BigInt                         @map("size_bytes")
  lastModifiedMs        BigInt                         @map("last_modified_ms")
  fingerprintHash       String                         @map("fingerprint_hash") @db.Char(64)
  replaceEvidenceFileId String?                        @map("replace_evidence_file_id") @db.Uuid
  chunkSizeBytes        Int                            @map("chunk_size_bytes")
  totalParts            Int                            @map("total_parts")
  status                FieldEvidenceVideoUploadStatus @default(UPLOADING)
  ossUploadId           String?                        @map("oss_upload_id") @db.VarChar(255)
  objectKey             String?                        @map("object_key") @db.VarChar(512)
  objectEtag            String?                        @map("object_etag") @db.VarChar(255)
  failureCode           String?                        @map("failure_code") @db.VarChar(64)
  failureMessage        String?                        @map("failure_message") @db.VarChar(255)
  resumeStage           FieldEvidenceVideoUploadStatus? @map("resume_stage")
  leaseOwner            String?                        @map("lease_owner") @db.VarChar(128)
  leaseExpiresAt        DateTime?                      @map("lease_expires_at") @db.Timestamptz(6)
  expiresAt             DateTime                       @map("expires_at") @db.Timestamptz(6)
  objectCompletedAt     DateTime?                      @map("object_completed_at") @db.Timestamptz(6)
  processingCompletedAt DateTime?                      @map("processing_completed_at") @db.Timestamptz(6)
  completedAt           DateTime?                      @map("completed_at") @db.Timestamptz(6)
  cancelledAt           DateTime?                      @map("cancelled_at") @db.Timestamptz(6)
  version               Int                            @default(0)
  createdAt             DateTime                       @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt             DateTime                       @updatedAt @map("updated_at") @db.Timestamptz(6)
  workOrder             VehicleHandoverWorkOrder       @relation(fields: [workOrderId], references: [id], onDelete: Cascade)
  evidenceItem          VehicleDeliveryEvidenceItem    @relation(fields: [evidenceItemId], references: [id], onDelete: Cascade)
  createdBySession      FieldOperatorSession?           @relation(fields: [createdBySessionId], references: [id], onDelete: SetNull)
  replaceEvidenceFile   VehicleDeliveryEvidenceFile?   @relation(fields: [replaceEvidenceFileId], references: [id], onDelete: SetNull)
  parts                 FieldEvidenceVideoUploadPart[]

  @@index([workOrderId, status])
  @@index([evidenceItemId, status])
  @@index([status, leaseExpiresAt])
  @@index([expiresAt])
  @@map("field_evidence_video_upload_session")
}

model FieldEvidenceVideoUploadPart {
  id          String   @id @default(uuid()) @db.Uuid
  sessionId   String   @map("session_id") @db.Uuid
  partNumber  Int      @map("part_number")
  sizeBytes   Int      @map("size_bytes")
  sha256      String   @db.Char(64)
  ossEtag     String   @map("oss_etag") @db.VarChar(255)
  completedAt DateTime @map("completed_at") @db.Timestamptz(6)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)
  session     FieldEvidenceVideoUploadSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@unique([sessionId, partNumber])
  @@index([sessionId, completedAt])
  @@map("field_evidence_video_upload_part")
}
```

Add the corresponding back-relations to the existing models: `VehicleHandoverWorkOrder.videoUploadSessions`, `VehicleDeliveryEvidenceItem.videoUploadSessions`, `FieldOperatorSession.videoUploadSessions`, and `VehicleDeliveryEvidenceFile.replacementVideoUploadSessions`.

The SQL migration must add foreign keys with `ON DELETE CASCADE` for the work order, evidence item, and part session; use `ON DELETE SET NULL` for the creator session and replacement evidence file. Add this partial unique index:

```sql
CREATE UNIQUE INDEX "field_evidence_video_upload_session_one_live_item"
ON "field_evidence_video_upload_session" ("evidence_item_id")
WHERE "status" IN (
  'UPLOADING', 'FINALIZE_QUEUED', 'OSS_COMPLETING',
  'OBJECT_READY', 'PROCESSING', 'RETRYABLE_FAILED'
);
```

- [ ] **Step 4: Validate Prisma and run the schema test**

Run: `pnpm prisma:validate && pnpm prisma:generate && pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-schema.spec.ts`

Expected: Prisma schema valid; generated client succeeds; 1 test passes.

- [ ] **Step 5: Commit the additive schema**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260815010000_field_video_resumable_upload apps/api/test/field-video-upload-schema.spec.ts
git commit -m "feat: add field video upload sessions"
```

---

### Task 2: Add the server-owned OSS multipart adapter

**Files:**

- Modify: `apps/api/src/storage/storage.types.ts`
- Modify: `apps/api/src/storage/oss-storage.provider.ts`
- Modify: `apps/api/src/storage/storage.service.ts`
- Modify: `apps/api/test/storage.spec.ts`

**Interfaces:**

- Produces `StorageService.beginFieldVideoMultipart(input)`.
- Produces `StorageService.uploadFieldVideoPart(input)`.
- Produces `StorageService.completeFieldVideoMultipart(input)`.
- Produces `StorageService.abortFieldVideoMultipart(input)`.
- Produces `StorageService.downloadFieldVideoUploadSource(input)` and `deleteFieldVideoUploadSource(input)`.
- All returned object/upload identifiers are server-internal types and are never serialized by controllers.

- [ ] **Step 1: Write failing provider tests with an OSS client fake**

```ts
it("owns the complete OSS multipart lifecycle", async () => {
  const client = {
    initMultipartUpload: vi.fn().mockResolvedValue({ uploadId: "oss-upload-1" }),
    uploadPart: vi.fn().mockResolvedValue({ etag: "etag-1" }),
    completeMultipartUpload: vi.fn().mockResolvedValue({
      name: "field-video/session-1/source.mov",
      res: { headers: { etag: "source-etag" } }
    }),
    abortMultipartUpload: vi.fn().mockResolvedValue({})
  };
  const provider = ossProviderWithClient(client);

  const started = await provider.initMultipartUpload({
    contentType: "video/quicktime",
    key: "field-video/session-1/source.mov"
  });
  const part = await provider.uploadPart({
    filePath: "C:/tmp/part-1",
    key: started.key,
    partNumber: 1,
    sizeBytes: 1024,
    uploadId: started.uploadId
  });
  const completed = await provider.completeMultipartUpload({
    key: started.key,
    parts: [part],
    uploadId: started.uploadId
  });

  expect(started.uploadId).toBe("oss-upload-1");
  expect(part).toMatchObject({ etag: "etag-1", partNumber: 1 });
  expect(completed.etag).toBe("source-etag");
});
```

Also add tests that `abortMultipartUpload` treats OSS `NoSuchUpload` as idempotent success and that public `StorageService` snapshots omit bucket, key, uploadId, and ETag.

- [ ] **Step 2: Run the storage tests and observe the missing methods**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/storage.spec.ts`

Expected: FAIL because the multipart methods and types do not exist.

- [ ] **Step 3: Add explicit internal multipart contracts**

```ts
export interface MultipartUploadHandle {
  key: string;
  uploadId: string;
}

export interface MultipartUploadPart {
  etag: string;
  partNumber: number;
  sizeBytes: number;
}

export interface CompletedMultipartObject {
  etag?: string;
  key: string;
  sizeBytes: number;
}

export interface StorageProvider {
  // existing methods stay unchanged
  initMultipartUpload?(input: BeginMultipartUploadInput): Promise<MultipartUploadHandle>;
  uploadPart?(input: UploadMultipartPartInput): Promise<MultipartUploadPart>;
  completeMultipartUpload?(input: CompleteMultipartUploadInput): Promise<CompletedMultipartObject>;
  abortMultipartUpload?(input: AbortMultipartUploadInput): Promise<void>;
}
```

Extend `OssClientLike` with the ali-oss 6.23 signatures. Call `uploadPart(name, uploadId, partNo, filePath, 0, sizeBytes)` so the provider never reads an 8 MiB part into a Node heap buffer.

- [ ] **Step 4: Add namespaced `StorageService` methods**

```ts
async beginFieldVideoMultipart(input: {
  contentType: string;
  originalName: string;
  sessionId: string;
}) {
  this.assertOssDriver();
  const key = this.withOssPrefix(`field-video/upload-sessions/${input.sessionId}/source`);
  return this.ossStorage.initMultipartUpload!({ contentType: input.contentType, key });
}
```

Implement part, complete, abort, download, and delete methods with the same prefix validation. Reject non-OSS storage for resumable videos with safe code `FIELD_VIDEO_MULTIPART_REQUIRES_OSS`.

- [ ] **Step 5: Run the focused storage suite**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/storage.spec.ts`

Expected: all storage tests pass.

- [ ] **Step 6: Commit the storage boundary**

```bash
git add apps/api/src/storage apps/api/test/storage.spec.ts
git commit -m "feat: add controlled OSS multipart storage"
```

---

### Task 3: Implement the durable upload repository and state machine

**Files:**

- Create: `apps/api/src/field-operator/field-video-upload.constants.ts`
- Create: `apps/api/src/field-operator/field-video-upload.types.ts`
- Create: `apps/api/src/field-operator/field-video-upload.repository.ts`
- Create: `apps/api/test/field-video-upload-repository.spec.ts`

**Interfaces:**

- Produces `FieldVideoUploadRepository.createOrResume(input)`.
- Produces `recordPart`, `queueFinalization`, `claimDue`, `advanceClaimed`, `markRetryableFailure`, `markTerminal`, `listActive`, and `expireDue`.
- `FieldVideoUploadSessionSnapshot` is the only repository type returned upward; it includes safe part numbers but retains OSS fields only under an `internal` property unavailable to controller serializers.

- [ ] **Step 1: Write failing repository tests for the state transitions**

Cover all of these named cases:

```ts
it("resumes the same live fingerprint instead of creating another session", async () => {});
it("rejects a different file while the evidence item has a live session", async () => {});
it("records the same part idempotently and rejects different content", async () => {});
it("queues finalization only when every expected part exists", async () => {});
it("claims due finalization with a lease and reclaims an expired lease", async () => {});
it("expires inactive uploading sessions after 24 hours", async () => {});
```

Use a Prisma mock that asserts the transaction predicates, especially `status`, `version`, and `leaseExpiresAt`. Return error codes, not raw Prisma errors.

- [ ] **Step 2: Run the repository test and verify it fails**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-repository.spec.ts`

Expected: FAIL with module-not-found for `field-video-upload.repository`.

- [ ] **Step 3: Add exact constants and safe types**

```ts
export const FIELD_VIDEO_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const MAX_FIELD_VIDEO_SIZE_BYTES = 300 * 1024 * 1024;
export const FIELD_VIDEO_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const FIELD_VIDEO_FINALIZE_LEASE_MS = 5 * 60 * 1000;
export const MAX_FIELD_VIDEO_PARTS = 38;

export type FieldVideoUploadPublicStatus =
  | "UPLOADING"
  | "FINALIZE_QUEUED"
  | "OSS_COMPLETING"
  | "OBJECT_READY"
  | "PROCESSING"
  | "RETRYABLE_FAILED"
  | "VALIDATION_FAILED"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED";

export interface FieldVideoUploadSessionPublicSnapshot {
  chunkSizeBytes: number;
  completedPartNumbers: number[];
  evidenceItemId: string;
  evidenceTitle: string;
  expiresAt: string;
  failure?: { code: string; message: string };
  fileName: string;
  sessionId: string;
  sizeBytes: number;
  status: FieldVideoUploadPublicStatus;
  totalParts: number;
  uploadedBytes: number;
  workOrderId: string;
}

export interface DiskUploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  destination: string;
  filename: string;
  path: string;
  size: number;
}
```

Add a single `toPublicFieldVideoUploadSnapshot` function that explicitly constructs the public object instead of spreading a Prisma record.

- [ ] **Step 4: Implement transactional repository methods**

`recordPart` must follow this decision table:

```ts
if (!existing) createPartAndRefreshExpiry();
else if (existing.sizeBytes === input.sizeBytes && existing.sha256 === input.sha256)
  return existing;
else
  throw new ConflictException({
    code: "CHUNK_CONTENT_CONFLICT",
    message: "分片内容与已上传记录不一致。"
  });
```

`claimDue` must use a transaction with `FOR UPDATE SKIP LOCKED` or an equivalent atomic `UPDATE ... RETURNING` and return a random lease token. Never claim terminal sessions.

- [ ] **Step 5: Run repository tests and Prisma validation**

Run: `pnpm prisma:validate && pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-repository.spec.ts`

Expected: all repository tests pass.

- [ ] **Step 6: Commit the repository state machine**

```bash
git add apps/api/src/field-operator/field-video-upload.constants.ts apps/api/src/field-operator/field-video-upload.types.ts apps/api/src/field-operator/field-video-upload.repository.ts apps/api/test/field-video-upload-repository.spec.ts
git commit -m "feat: add resumable video upload state machine"
```

---

### Task 4: Add guarded create, status, recovery, retry, and cancel APIs

**Files:**

- Create: `apps/api/src/field-operator/field-video-upload.dto.ts`
- Create: `apps/api/src/field-operator/field-video-upload.service.ts`
- Create: `apps/api/src/field-operator/field-video-upload.controller.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.module.ts`
- Create: `apps/api/test/field-video-upload-api.spec.ts`

**Interfaces:**

- Produces the session endpoints defined in the approved design.
- Produces `HandoverWorkOrderService.authorizeFieldVideoUploadMutation(input)` returning `{ evidenceType, itemId, orderId, replaceEvidenceFileId, workOrderId }` after task assignment and editability checks.
- Produces `HandoverWorkOrderService.recordFieldVideoUploadEvent(input)` for the five upload lifecycle event types added in Task 1; metadata is limited to session id, evidence item id, safe status/error code, part count, and elapsed milliseconds.
- `FieldVideoUploadService` consumes the repository and storage boundary from Tasks 2 and 3.

- [ ] **Step 1: Write failing controller/service contract tests**

```ts
it("returns a safe resumable session without OSS fields", async () => {
  const result = await service.createOrResume(workOrderId, itemId, phone, actorSessionId, {
    fileName: "IMG_0284.MOV",
    fingerprintSha256: "a".repeat(64),
    lastModifiedMs: 1_786_700_000_000,
    mimeType: "video/quicktime",
    sizeBytes: 226_900_000
  });
  expect(result).toMatchObject({ chunkSizeBytes: 8 * 1024 * 1024, sessionId: expect.any(String) });
  expect(JSON.stringify(result)).not.toMatch(/oss|bucket|objectKey|etag/i);
});
```

Add tests for `300 MiB + 1`, non-video MIME, cross-task session lookup, current phone no longer assigned, active recovery list, retryable-only retry, and idempotent cancel.
Assert that create, same-file resume, and cancel write `FIELD_VIDEO_UPLOAD_CREATED`, `FIELD_VIDEO_UPLOAD_RESUMED`, and `FIELD_VIDEO_UPLOAD_CANCELLED` exactly once without including phone or OSS identifiers.

- [ ] **Step 2: Run the API test and verify missing modules fail**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-api.spec.ts`

Expected: FAIL with module-not-found for `field-video-upload.service`.

- [ ] **Step 3: Add validated DTOs**

```ts
export class CreateFieldVideoUploadSessionDto {
  @IsString() @MaxLength(255) fileName!: string;
  @Matches(/^[a-f0-9]{64}$/) fingerprintSha256!: string;
  @IsInt() @Min(0) lastModifiedMs!: number;
  @IsString() @MaxLength(128) mimeType!: string;
  @IsOptional() @IsUUID() replaceEvidenceFileId?: string;
  @IsInt() @Min(1) @Max(300 * 1024 * 1024) sizeBytes!: number;
}
```

Use separate empty DTOs only where Nest validation requires a body; do not accept OSS identifiers from clients.

- [ ] **Step 4: Implement authorization-aware session orchestration**

At creation and every mutation:

```ts
const authorized = await this.handoverWorkOrderService.authorizeFieldVideoUploadMutation({
  evidenceItemId: itemId,
  phone,
  replaceEvidenceFileId: dto.replaceEvidenceFileId,
  workOrderId
});
assertSupportedVideoMetadata(dto);
return toPublicFieldVideoUploadSnapshot(
  await this.repository.createOrResume({ ...authorized, actorSessionId, ...dto })
);
```

Create the OSS Multipart handle only after authorization, type, size, and single-live-session checks succeed. If database creation fails after OSS initialization, abort the just-created Multipart in `catch`.

For cancellation, acquire a short cancellation lease by setting `leaseOwner = cancel:<uuid>` only when the current status is non-terminal and `leaseOwner` is null/expired; `recordPart` must require `leaseOwner IS NULL` so no new part can commit during cleanup. Call `abortFieldVideoMultipart` (treating `NoSuchUpload` as success), delete an already-completed but unbound source when present, then persist `CANCELLED`, clear the internal upload/object identifiers and lease, and record the lifecycle event. If storage cleanup fails, clear the cancellation lease, keep the previous status recoverable, and return safe code `VIDEO_UPLOAD_CANCEL_RETRYABLE`; never report `CANCELLED` while cleanup is incomplete.

- [ ] **Step 5: Register guarded routes**

Use controller prefix `field/handover` and `@UseGuards(FieldOperatorAuthGuard)` on the class. Add exact routes:

```ts
@Post("work-orders/:id/evidence/:itemId/video-upload-sessions")
@Get("work-orders/:id/evidence/:itemId/video-upload-sessions/:sessionId")
@Post("work-orders/:id/evidence/:itemId/video-upload-sessions/:sessionId/complete")
@Post("work-orders/:id/evidence/:itemId/video-upload-sessions/:sessionId/retry")
@Delete("work-orders/:id/evidence/:itemId/video-upload-sessions/:sessionId")
@Get("video-upload-sessions/active")
```

- [ ] **Step 6: Run focused API tests**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-api.spec.ts test/field-operator-auth.spec.ts`

Expected: all focused tests pass and old field-operator login/controller behavior remains green.

- [ ] **Step 7: Commit session control APIs**

```bash
git add apps/api/src/field-operator apps/api/src/handover-work-order/handover-work-order.service.ts apps/api/src/handover-work-order/handover-work-order.module.ts apps/api/test/field-video-upload-api.spec.ts
git commit -m "feat: add field video upload session APIs"
```

---

### Task 5: Add disk-backed, hash-verified part upload

**Files:**

- Create: `apps/api/src/field-operator/field-video-upload-options.ts`
- Modify: `apps/api/src/field-operator/field-video-upload.controller.ts`
- Modify: `apps/api/src/field-operator/field-video-upload.service.ts`
- Modify: `apps/api/test/field-evidence-multipart.spec.ts`
- Create: `apps/api/test/field-video-upload-part.spec.ts`

**Interfaces:**

- Produces `FieldVideoUploadService.uploadPart(input)`.
- Consumes `StorageService.uploadFieldVideoPart` and `FieldVideoUploadRepository.recordPart`.
- Accepts one multipart field named `file` plus `X-Chunk-SHA256`; the controller never accepts a client ETag.

- [ ] **Step 1: Write failing option and service tests**

```ts
it("spools one part to disk with an 8 MiB hard limit", () => {
  const options = createFieldVideoPartUploadOptions({ destination: "C:/tmp/video-parts" });
  expect(options.dest).toBe("C:/tmp/video-parts");
  expect(options.limits).toMatchObject({ files: 1, fileSize: 8 * 1024 * 1024 + 1, parts: 1 });
});

it("rejects a part whose SHA-256 header does not match the temp file", async () => {
  await expect(service.uploadPart(inputWithHash("0".repeat(64)))).rejects.toMatchObject({
    response: expect.objectContaining({ code: "CHUNK_HASH_MISMATCH" })
  });
  expect(storage.uploadFieldVideoPart).not.toHaveBeenCalled();
});
```

Also test first/middle/final expected sizes, part numbers `1..totalParts`, total boundary, temp cleanup after success/failure, idempotent duplicate, and conflicting duplicate.

- [ ] **Step 2: Run the tests and observe missing upload support**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/field-evidence-multipart.spec.ts test/field-video-upload-part.spec.ts`

Expected: FAIL because the options and part service do not exist.

- [ ] **Step 3: Add disk-backed Multer options and route**

```ts
export function createFieldVideoPartUploadOptions(input: { destination?: string } = {}) {
  return createUtf8MultipartOptions({
    dest: input.destination ?? path.join(tmpdir(), "subscription-saas-field-video-parts"),
    limits: { fields: 0, files: 1, fileSize: FIELD_VIDEO_CHUNK_SIZE_BYTES + 1, parts: 1 }
  });
}
```

Controller route:

```ts
@Post("work-orders/:id/evidence/:itemId/video-upload-sessions/:sessionId/parts/:partNumber")
@UseInterceptors(FileInterceptor("file", FIELD_VIDEO_PART_UPLOAD_OPTIONS), new FieldEvidenceTempFileCleanupInterceptor())
uploadPart(@Headers("x-chunk-sha256") sha256: string, @UploadedFile() file: DiskUploadedFile) {}
```

- [ ] **Step 4: Implement stream/file hashing and OSS handoff**

Use `createReadStream(file.path)` piped into `createHash("sha256")`; do not call `readFile`. Verify expected part size before OSS. After OSS succeeds, record `{ partNumber, sizeBytes, sha256, ossEtag }`. Always unlink the part in `finally`, including hash mismatch and OSS failure.

- [ ] **Step 5: Run focused part and legacy multipart tests**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-part.spec.ts test/field-evidence-multipart.spec.ts test/field-evidence-upload-cleanup.spec.ts`

Expected: all tests pass; legacy 300 MiB endpoint and cleanup behavior remain compatible.

- [ ] **Step 6: Commit part upload**

```bash
git add apps/api/src/field-operator apps/api/test/field-video-upload-part.spec.ts apps/api/test/field-evidence-multipart.spec.ts
git commit -m "feat: upload verified field video parts"
```

---

### Task 6: Finalize OSS objects and bind evidence through a recoverable worker

**Files:**

- Create: `apps/api/src/field-operator/field-video-upload-finalizer.service.ts`
- Create: `apps/api/src/field-operator/field-video-upload.worker.ts`
- Modify: `apps/api/src/field-operator/field-video-upload.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.module.ts`
- Create: `apps/api/test/field-video-upload-finalizer.spec.ts`
- Create: `apps/api/test/field-video-upload.worker.spec.ts`
- Modify: `apps/api/test/handover-work-order.spec.ts`

**Interfaces:**

- Produces `FieldVideoUploadFinalizerService.finalize(claimed)`.
- Produces `FieldVideoUploadWorker.runOnce()` with one-job default concurrency.
- Produces `HandoverWorkOrderService.attachPreparedFieldVideoFromStoredSource(input)`.
- Consumes ordered repository parts and internal OSS identifiers; controller-facing results remain sanitized.

- [ ] **Step 1: Write failing finalizer state-resume tests**

```ts
it("resumes from OBJECT_READY without completing OSS twice", async () => {
  repository.claimedSession.mockReturnValue(session({ status: "OBJECT_READY" }));
  await finalizer.finalize(repository.claimedSession());
  expect(storage.completeFieldVideoMultipart).not.toHaveBeenCalled();
  expect(handover.attachPreparedFieldVideoFromStoredSource).toHaveBeenCalledOnce();
});

it("keeps the old evidence active when 720p validation fails", async () => {
  artifact.prepareUpload.mockRejectedValue(lowResolutionError(640, 360));
  await finalizer.finalize(session({ replaceEvidenceFileId: oldFileId }));
  expect(handover.attachPreparedFieldVideoFromStoredSource).not.toHaveBeenCalled();
  expect(storage.deleteFieldVideoUploadSource).toHaveBeenCalledOnce();
  expect(repository.markTerminal).toHaveBeenCalledWith(
    expect.objectContaining({ status: "VALIDATION_FAILED" })
  );
});
```

Add tests for `FINALIZE_QUEUED -> OSS_COMPLETING -> OBJECT_READY -> PROCESSING -> COMPLETED`, derivative cleanup, transaction failure, retryable OSS failure, expired lease reclaim, and duplicate worker execution.
Assert `FIELD_VIDEO_UPLOAD_COMPLETED` is recorded exactly once after the evidence transaction, while terminal validation failure records `FIELD_VIDEO_UPLOAD_FAILED` with only a safe error code.

- [ ] **Step 2: Run finalizer tests and observe missing services**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-finalizer.spec.ts test/field-video-upload.worker.spec.ts`

Expected: FAIL with module-not-found for the finalizer and worker.

- [ ] **Step 3: Extract the reusable stored-source attachment boundary**

Refactor the existing `uploadAndAttachFieldAccessibleEvidenceFile` so the final transaction can accept:

```ts
interface AttachPreparedFieldVideoFromStoredSourceInput {
  actorId?: string;
  detectedMimeType: string;
  evidenceItemId: string;
  originalName: string;
  prepared: PreparedDeliveryEvidenceArtifacts;
  replaceEvidenceFileId?: string;
  sizeBytes: number;
  storedSource: { bucket: string; objectKey: string };
  workOrderId: string;
}
```

The old upload method still stores its source first, then calls this common boundary. The multipart finalizer passes its already-completed source, so it never uploads the full video a second time.

- [ ] **Step 4: Implement idempotent finalization**

Finalizer pseudocode must match persisted states:

```ts
switch (session.status) {
  case "FINALIZE_QUEUED":
  case "OSS_COMPLETING":
    await completeOssAndPersistObjectReady(session);
    break;
  case "OBJECT_READY":
  case "PROCESSING":
    await downloadPrepareAttachAndPersistCompleted(session);
    break;
  default:
    return;
}
```

Download the source through `StorageService` into `tmpdir()/subscription-saas-field-video-processing/<sessionId>`. Use pipeline/streams, call existing `prepareUpload`, and clean the full temp file and derivatives in `finally`.

- [ ] **Step 5: Implement the leased poller and expiry cleanup**

Use the existing `Stage2HandoverWorkflowWorker` lifecycle pattern:

```ts
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CONCURRENCY = 1;
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000] as const;
```

Config keys:

```text
FIELD_VIDEO_UPLOAD_WORKER_ENABLED
FIELD_VIDEO_UPLOAD_WORKER_POLL_INTERVAL_MS
FIELD_VIDEO_UPLOAD_WORKER_CONCURRENCY
FIELD_VIDEO_UPLOAD_WORKER_LEASE_MS
```

`runOnce` first finalizes claimed sessions, then expires due sessions. Expiry cleanup must execute in this order: claim the due session, abort the Multipart idempotently, delete any completed but unbound source/derivatives, persist `EXPIRED` while clearing internal identifiers, and record `FIELD_VIDEO_UPLOAD_FAILED` with code `VIDEO_UPLOAD_EXPIRED`. If cleanup fails, release/retry the lease without marking the session terminal. A failed cleanup logs only safe session/work-order/error codes.

- [ ] **Step 6: Run finalizer, worker, and handover regression suites**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-finalizer.spec.ts test/field-video-upload.worker.spec.ts test/handover-work-order.spec.ts test/stage2-handover-evidence-artifact.spec.ts`

Expected: all focused tests pass, including old single-request uploads and 720p checks.

- [ ] **Step 7: Commit finalization**

```bash
git add apps/api/src/field-operator apps/api/src/handover-work-order apps/api/test/field-video-upload-finalizer.spec.ts apps/api/test/field-video-upload.worker.spec.ts apps/api/test/handover-work-order.spec.ts
git commit -m "feat: finalize resumable field videos"
```

---

### Task 7: Add pure Web chunking, fingerprints, API contracts, and recovery storage

**Files:**

- Create: `apps/web/src/lib/field-video-upload.ts`
- Create: `apps/web/src/lib/field-video-upload-api.ts`
- Create: `apps/web/src/lib/field-video-upload-recovery.ts`
- Create: `apps/web/test/field-video-upload.spec.ts`
- Create: `apps/web/test/field-video-upload-api.spec.ts`
- Create: `apps/web/test/field-video-upload-recovery.spec.ts`

**Interfaces:**

- Produces `buildFieldVideoChunkPlan`, `buildFieldVideoResumeFingerprint`, `sha256Blob`, and `formatFieldVideoUploadProgress`.
- Produces typed session API functions and `uploadFieldVideoPart` XHR.
- Produces `saveFieldVideoRecovery`, `listFieldVideoRecoveries`, and `clearFieldVideoRecovery` using storage key `subscription-saas:field-video-upload:v1`.

- [ ] **Step 1: Write failing pure-function tests**

```ts
it("plans 38 sequential parts for exactly 300 MiB", () => {
  const parts = buildFieldVideoChunkPlan(300 * 1024 * 1024, 8 * 1024 * 1024);
  expect(parts).toHaveLength(38);
  expect(parts.at(-1)).toMatchObject({ sizeBytes: 4 * 1024 * 1024, partNumber: 38 });
});

it("fingerprints metadata plus at most the first and last MiB", async () => {
  const file = trackedFile(226_900_000);
  const fingerprint = await buildFieldVideoResumeFingerprint(file);
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(file.slices).toEqual([
    [0, 1_048_576],
    [225_851_424, 226_900_000]
  ]);
});
```

Add tests for `300 MiB + 1`, missing part selection, public API response parsing that strips unknown OSS-like fields, recovery expiry, terminal cleanup, and malformed localStorage JSON.

- [ ] **Step 2: Run Web tests and verify missing modules fail**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/field-video-upload.spec.ts test/field-video-upload-api.spec.ts test/field-video-upload-recovery.spec.ts`

Expected: FAIL with module-not-found for `field-video-upload`.

- [ ] **Step 3: Implement memory-bounded fingerprinting and chunk planning**

```ts
export async function buildFieldVideoResumeFingerprint(file: File) {
  const sampleSize = Math.min(1024 * 1024, file.size);
  const first = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer());
  const lastStart = Math.max(sampleSize, file.size - sampleSize);
  const last = new Uint8Array(await file.slice(lastStart, file.size).arrayBuffer());
  const metadata = new TextEncoder().encode(
    `${file.name}\n${file.type}\n${file.size}\n${file.lastModified}\n`
  );
  return sha256Bytes(concatBytes(metadata, first, last));
}
```

The maximum fingerprint allocation is just over 2 MiB, not the full video.

- [ ] **Step 4: Implement typed API and versioned recovery storage**

Use `XMLHttpRequest` only for the part body so per-part progress and cancellation work. JSON create/status/complete/retry/cancel calls use `apiFetch` with credentials. Runtime guards must whitelist response fields rather than cast arbitrary JSON.

Recovery record:

```ts
export interface FieldVideoUploadRecoveryRecord {
  evidenceItemId: string;
  expiresAt: string;
  fileName: string;
  fingerprintSha256: string;
  lastModifiedMs: number;
  sessionId: string;
  sizeBytes: number;
  workOrderId: string;
}
```

- [ ] **Step 5: Run the focused Web tests**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/field-video-upload.spec.ts test/field-video-upload-api.spec.ts test/field-video-upload-recovery.spec.ts`

Expected: all new tests pass.

- [ ] **Step 6: Commit Web primitives**

```bash
git add apps/web/src/lib/field-video-upload.ts apps/web/src/lib/field-video-upload-api.ts apps/web/src/lib/field-video-upload-recovery.ts apps/web/test/field-video-upload.spec.ts apps/web/test/field-video-upload-api.spec.ts apps/web/test/field-video-upload-recovery.spec.ts
git commit -m "feat: add field video upload primitives"
```

---

### Task 8: Implement sequential upload, pause/resume, retries, and finalization polling

**Files:**

- Create: `apps/web/src/lib/field-video-upload-runner.ts`
- Create: `apps/web/test/field-video-upload-runner.spec.ts`

**Interfaces:**

- Produces `runFieldVideoUpload(input): Promise<FieldVideoUploadRunResult>`.
- Consumes Task 7 chunking/API/recovery functions.
- Calls `onStateChange` with `SELECTED`, `UPLOADING`, `PAUSED`, `FINALIZING`, `PROCESSING`, `COMPLETED`, `RETRYABLE_FAILED`, or `VALIDATION_FAILED`.

- [ ] **Step 1: Write failing runner tests with a fake API**

```ts
it("uploads only missing parts in ascending order", async () => {
  const api = fakeApi({ completedPartNumbers: [1, 3] });
  await runFieldVideoUpload({ api, file: fileOfSize(4 * CHUNK), onStateChange: vi.fn() });
  expect(api.uploadPart.mock.calls.map(([input]) => input.partNumber)).toEqual([2, 4]);
});

it("retries one part three times without restarting completed parts", async () => {
  const api = fakeApiThatFailsPartTwice(2);
  await runFieldVideoUpload({ api, file: fileOfSize(3 * CHUNK), retryDelaysMs: [0, 0, 0] });
  expect(api.uploadPart).toHaveBeenCalledTimes(5);
});
```

Also test pause aborts only the active XHR, resume continues missing parts, 401 preserves recovery, mismatched fingerprint stops before uploading, complete returns to polling, retryable finalization, validation failure, and terminal recovery cleanup.

- [ ] **Step 2: Run the runner test and verify module-not-found**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/field-video-upload-runner.spec.ts`

Expected: FAIL with module-not-found for `field-video-upload-runner`.

- [ ] **Step 3: Implement the sequential state machine**

```ts
for (const part of missingParts) {
  const blob = file.slice(part.startByte, part.endByte);
  const sha256 = await sha256Blob(blob);
  await retryPart(
    () => api.uploadPart({ blob, partNumber: part.partNumber, sessionId, sha256 }),
    [1_000, 2_000, 4_000],
    signal
  );
  onStateChange(progressAfterPart(part));
}
await api.complete(sessionId);
return pollUntilTerminal(sessionId, { intervalMs: 2_000, signal });
```

Do not impose a client hard deadline on `FINALIZING`/`PROCESSING`; each poll has a request timeout, and the user can leave and recover later.

- [ ] **Step 4: Run runner and primitive tests**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/field-video-upload-runner.spec.ts test/field-video-upload.spec.ts test/field-video-upload-api.spec.ts test/field-video-upload-recovery.spec.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit the runner**

```bash
git add apps/web/src/lib/field-video-upload-runner.ts apps/web/test/field-video-upload-runner.spec.ts
git commit -m "feat: run resumable field video uploads"
```

---

### Task 9: Integrate persistent mobile UI and recovery prompts

**Files:**

- Create: `apps/web/src/lib/use-field-video-upload.ts`
- Create: `apps/web/src/components/field-video-upload-progress-card.tsx`
- Create: `apps/web/src/components/field-video-upload-recovery-alert.tsx`
- Modify: `apps/web/src/app/field/handover/page.tsx`
- Modify: `apps/web/src/app/field/handover/tasks/page.tsx`
- Modify: `apps/web/src/app/field/handover/tasks/[id]/page.tsx`
- Create: `apps/web/test/field-video-upload-ui.spec.tsx`
- Modify: `apps/web/test/field-handover-pages.spec.ts`
- Modify: `apps/web/test/field-handover-upload.spec.ts`

**Interfaces:**

- `useFieldVideoUpload` owns runner state and exposes `selectFile`, `pause`, `resume`, `cancel`, `retryFinalization`, `barrierActive`, and `view`.
- `FieldVideoUploadProgressCard` is presentational and receives the hook view/actions.
- `FieldVideoUploadRecoveryAlert` receives safe recovery records and links to `/field/handover/tasks/:workOrderId`.
- The existing task page still owns facts, photo batches, evidence submission, and detail reload.

- [ ] **Step 1: Write failing UI behavior tests**

```tsx
it("shows durable progress instead of relying on a toast", () => {
  render(
    <FieldVideoUploadProgressCard
      view={uploadingView({ completedParts: 18, totalParts: 29 })}
      {...actions}
    />
  );
  expect(screen.getByText("18/29")).toBeInTheDocument();
  expect(screen.getByText("上传中")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "暂停上传" })).toBeEnabled();
});

it("asks the operator to reselect the original file after reload", () => {
  render(<FieldVideoUploadRecoveryAlert records={[recovery({ fileName: "IMG_0284.MOV" })]} />);
  expect(screen.getByText(/重新选择同一文件后可继续/)).toBeInTheDocument();
});
```

Add page source tests proving videos call `selectFile`, photos still call the existing `uploadEvidence`, session expiration preserves recovery before redirect, and submit/delete/duplicate upload are disabled only for the active evidence item.

- [ ] **Step 2: Run UI tests and verify missing components fail**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/field-video-upload-ui.spec.tsx test/field-handover-pages.spec.ts test/field-handover-upload.spec.ts`

Expected: FAIL with missing progress/recovery components.

- [ ] **Step 3: Implement the hook and presentational components**

The progress component must always render the current phase and persistent error inside the evidence card:

```tsx
<Progress percent={view.percent} status={view.errorMessage ? "exception" : "active"} />
<Typography.Text>{view.completedParts}/{view.totalParts}</Typography.Text>
<Typography.Text>{view.phaseLabel}</Typography.Text>
{view.errorMessage ? <Alert type="error" message={view.errorMessage} showIcon /> : null}
```

Pause preserves server and local recovery state. Cancel opens `Modal.confirm`, calls the API only after confirmation, and then clears local recovery.

- [ ] **Step 4: Route video selection without disturbing photo batches**

In the existing `onFiles` boundary:

```ts
const firstFile = files[0];
if (firstFile && resolveFieldEvidenceMediaType(firstFile) === "VIDEO") {
  void fieldVideoUpload.selectFile(item, firstFile);
  return;
}
void uploadEvidence(item.id, files);
```

Include `fieldVideoUpload.barrierActive` in the existing submit/mutation barrier. Do not add multipart logic directly to the 1,400-line page.

- [ ] **Step 5: Add recovery prompts to all three pages**

Entry and list pages load safe active sessions after authentication and merge them with non-expired local recovery records. The detail page highlights only records for its work order. A `401` route replacement must leave the local record intact; successful completion, terminal validation failure, confirmed cancellation, and expiry clear it.

- [ ] **Step 6: Run UI and existing handover suites**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/field-video-upload-ui.spec.tsx test/field-video-upload-runner.spec.ts test/field-handover-pages.spec.ts test/field-handover-upload.spec.ts test/field-handover-api.spec.ts test/field-handover-view-model.spec.ts`

Expected: all focused Web tests pass.

- [ ] **Step 7: Commit the mobile UI**

```bash
git add apps/web/src/lib/use-field-video-upload.ts apps/web/src/components/field-video-upload-progress-card.tsx apps/web/src/components/field-video-upload-recovery-alert.tsx apps/web/src/app/field/handover apps/web/test
git commit -m "feat: show resumable field video progress"
```

---

### Task 10: Lock security, operations, rollout, and end-to-end verification

**Files:**

- Modify: `.env.example`
- Modify: `docs/stage2-local-handover-e2e-runbook.md`
- Modify: `docs/acceptance/2026-08-01-stage2-handover-acceptance-issues.md`
- Modify: `apps/api/test/field-video-upload-api.spec.ts`
- Modify: `apps/api/test/field-video-upload-finalizer.spec.ts`
- Modify: `apps/web/test/field-video-upload-runner.spec.ts`

**Interfaces:**

- Documents exact worker settings and API-first/Web-second deployment.
- Adds a security regression that serializes every public response and rejects internal storage field names.
- Produces the final automated and Staging acceptance checklist.

- [ ] **Step 1: Add failing security and restart-resume regressions**

```ts
it.each(["ossUploadId", "objectKey", "objectEtag", "bucket", "etag", "leaseOwner"])(
  "never exposes internal field %s",
  async (field) => {
    const publicResponses = await allPublicUploadResponses();
    expect(JSON.stringify(publicResponses)).not.toContain(`"${field}"`);
  }
);
```

Add a finalizer test that starts in each recoverable stage and reaches `COMPLETED` exactly once, plus a Web test that reconstructs a runner after reload and uploads only missing parts.

- [ ] **Step 2: Run the new regressions and observe any leaks or missing recovery cases**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-api.spec.ts test/field-video-upload-finalizer.spec.ts && pnpm --filter @subscription-saas/web exec vitest run test/field-video-upload-runner.spec.ts`

Expected: newly added assertions fail until every response/state path is sanitized and recoverable.

- [ ] **Step 3: Close the security/recovery gaps only**

Use explicit public mappers everywhere; never fix a leak by deleting needed internal repository fields. Ensure retry/expiry logs contain `sessionId`, `workOrderId`, `evidenceItemId`, safe `errorCode`, stage, and elapsed milliseconds, but not phone, original object key, uploadId, or ETag.

- [ ] **Step 4: Add exact worker and deployment documentation**

Add to `.env.example`:

```dotenv
FIELD_VIDEO_UPLOAD_WORKER_ENABLED=false
FIELD_VIDEO_UPLOAD_WORKER_POLL_INTERVAL_MS=5000
FIELD_VIDEO_UPLOAD_WORKER_CONCURRENCY=1
FIELD_VIDEO_UPLOAD_WORKER_LEASE_MS=300000
```

The Staging controlled configuration must set `FIELD_VIDEO_UPLOAD_WORKER_ENABLED=true`. Document deployment order: migration, API, OSS multipart preflight, Web, iPhone/WeChat acceptance. Preserve Nginx `320m/1200s` even though new parts are under 9 MiB because the legacy endpoint remains compatible.

- [ ] **Step 5: Run formatting, lint, type checks, Prisma checks, and all focused suites**

Run:

```bash
pnpm exec prettier --check apps/api/src/field-operator apps/api/src/storage apps/web/src/lib apps/web/src/components docs/superpowers/specs/2026-08-15-field-video-resumable-multipart-upload-design.zh-CN.md docs/superpowers/plans/2026-08-15-field-video-resumable-multipart-upload.md
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec vitest run test/field-video-upload-schema.spec.ts test/field-video-upload-repository.spec.ts test/field-video-upload-api.spec.ts test/field-video-upload-part.spec.ts test/field-video-upload-finalizer.spec.ts test/field-video-upload.worker.spec.ts test/storage.spec.ts test/field-evidence-multipart.spec.ts test/handover-work-order.spec.ts test/stage2-handover-evidence-artifact.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/field-video-upload.spec.ts test/field-video-upload-api.spec.ts test/field-video-upload-recovery.spec.ts test/field-video-upload-runner.spec.ts test/field-video-upload-ui.spec.tsx test/field-handover-pages.spec.ts test/field-handover-upload.spec.ts test/field-handover-api.spec.ts test/field-handover-view-model.spec.ts
git diff --check
```

Expected: every command exits 0; no lint, type, Prisma, test, formatting, or whitespace errors.

- [ ] **Step 6: Run broad API and Web test suites**

Run: `pnpm --filter @subscription-saas/api test && pnpm --filter @subscription-saas/web test`

Expected: all non-database unit tests pass. Any integration suite requiring an unavailable local PostgreSQL instance must be reported separately with its exact environment error and must not be presented as a product failure.

- [ ] **Step 7: Commit operations and verification coverage**

```bash
git add .env.example docs/stage2-local-handover-e2e-runbook.md docs/acceptance/2026-08-01-stage2-handover-acceptance-issues.md apps/api/test apps/web/test
git commit -m "test: verify resumable field video uploads"
```

- [ ] **Step 8: Prepare the Staging acceptance handoff**

After merge and deployment, instruct the user to perform these exact checks:

1. Upload `IMG_0284` (about 226.9 MB) in the WeChat iOS WebView.
2. Pause/close at about 40%, reopen the original task, reselect the same file, and confirm progress resumes above 0%.
3. Re-login once during upload and confirm the recovery prompt returns to the task.
4. Confirm file name, size, resolution, key frames, evidence state, and event audit after completion.
5. Attempt a sub-720p replacement and confirm the old video remains active.
6. Confirm no orphan Multipart upload, unbound source object, part temp file, or processing temp file remains.

Expected: all six checks pass with no silent redirect, no full restart, and no internal OSS field exposed.

---

## Implementation Completion Criteria

- Migration is additive, deployable, and reported up to date on Staging.
- API and Web images are built from the same merged `main` commit.
- Staging API container exactly matches the new immutable API image; Staging Web exactly matches the new immutable Web image.
- API, Admin, Portal, and field handover routes are healthy.
- Automated exact-limit and over-limit tests pass.
- The real `IMG_0284` WeChat iOS upload and interrupted resume scenario pass.
- Existing photo upload, legacy video endpoint, evidence review, PDF evidence manifest, and handover submission regressions remain green.
