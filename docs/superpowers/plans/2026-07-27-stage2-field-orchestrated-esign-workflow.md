# Stage 2 Field-Orchestrated eSign Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable Stage 2 handover workflow in which customer confirmation generates the source PDF asynchronously, the assigned Field operator reviews and starts eSign, the customer signs in Portal, and the platform automatically seals and archives the final PDF before Admin delivery confirmation.

**Architecture:** PostgreSQL is the durable queue and source of truth. Domain transitions enqueue idempotent `VehicleHandoverWorkflowJob` rows in the same transaction; a leased worker claims due jobs with `FOR UPDATE SKIP LOCKED`, executes focused handlers, and persists retries or terminal exceptions. Existing PDF, typed Stage 2 eSign, Fadada, archive, Field OTP, Portal notification, and Admin order components remain the domain implementations behind the orchestrator.

**Tech Stack:** Node.js 20+, TypeScript 6, NestJS 11, Prisma 7, PostgreSQL 17, Next.js 16 App Router, React 19, Ant Design 6, Vitest 4, pnpm 11.

## Global Constraints

- Do not change Stage 1 runtime behavior; record its reliability gaps only.
- Do not add Redis, BullMQ, a managed queue, or a generic cross-module workflow framework.
- Customer confirmation must return immediately with `PDF_PENDING`; it must not render a PDF inline.
- Internal and external operators both authenticate through the existing Field mobile OTP flow and receive identical task permissions.
- Canonical Field operator name and phone snapshots freeze when customer review starts.
- The Field operator must preview or download the exact source artifact and affirm its artifact version and SHA-256 before starting eSign.
- SMS content must not contain a Field token, Fadada URL, evidence URL, customer data, or vehicle detail.
- Source PDF output must retain four photos per page, video list and key frames, evidence hashes, protected evidence reference, full customer information, full VIN, full Field operator phone, exactly one customer coordinate, exactly one platform coordinate, a 15 MiB target, an 18 MiB internal hard limit, and the Fadada document-size limit.
- Side-effect retry delays are exactly 1 minute, 5 minutes, 15 minutes, 1 hour, and 6 hours, with five failed attempts before `DEAD_LETTER`.
- Provider `SIGNING` observations do not consume attempts; customer polling occurs near 2, 10, and 30 minutes, then every 6 hours while active.
- GET endpoints must not make provider writes or advance business state.
- A callback must return HTTP 200 after its durable next job is committed; it must not wait for platform sealing.
- Only Fadada result code `3000`, bound to the exact local contract, provider customer, transaction, stage, and slot, may advance a signer to signed.
- Platform retries must query the deterministic `H2` transaction before another provider write.
- No workflow handler may write `actualDeliveryAt`, lease dates, billing schedules, bills, payments, accounting records, or depreciation records.
- Delivery confirmation remains an explicit authorized Admin action and remains blocked until signed-PDF archive is complete.
- Feature flags are exactly `STAGE2_HANDOVER_WORKFLOW_ENABLED` and `STAGE2_HANDOVER_WORKER_ENABLED`.
- Business SMS template variables are exactly `ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE` and `ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE`.
- Rollout order is compatible images with flags off, migration, dry-run backfill, apply backfill, workflow flag on, worker flag on at low concurrency, existing-order recovery, then a new complete Staging order.

---

### Task 1: Schema, Migration, And Contract Baseline

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260727120000_stage2_field_orchestrated_workflow/migration.sql`
- Create: `apps/api/test/stage2-handover-workflow-schema.spec.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/.env.production.example`

**Interfaces:**
- Produces: Prisma enums `VehicleHandoverWorkflowJobType` and `VehicleHandoverWorkflowJobStatus`.
- Produces: Prisma model `VehicleHandoverWorkflowJob`.
- Produces: `VehicleHandoverWorkOrder.fieldOperatorName: string | null` and `fieldOperatorPhone: string | null`.
- Produces: `SmsSendLog.idempotencyKey: string | null`.
- Produces: notification enum members `HANDOVER_ESIGN_PENDING` and `HANDOVER_ESIGN_READY`.

- [ ] **Step 1: Write the failing schema contract tests**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(root, "prisma/migrations/20260727120000_stage2_field_orchestrated_workflow/migration.sql"),
  "utf8"
);

describe("Stage 2 durable workflow schema", () => {
  it("defines canonical operator snapshots and the workflow job contract", () => {
    expect(schema).toContain("fieldOperatorName");
    expect(schema).toContain("fieldOperatorPhone");
    expect(schema).toContain("model VehicleHandoverWorkflowJob");
    expect(schema).toContain("idempotencyKey");
    expect(schema).toContain("leaseExpiresAt");
    expect(schema).toContain("DEAD_LETTER");
  });

  it("migrates without dropping legacy assignment or eSign columns", () => {
    expect(migration).toContain("vehicle_handover_workflow_job");
    expect(migration).toContain("field_operator_phone");
    expect(migration).toContain("sms_send_log");
    expect(migration).not.toMatch(/DROP COLUMN/i);
  });
});
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run: `pnpm --filter @subscription-saas/api test -- stage2-handover-workflow-schema.spec.ts`

Expected: FAIL because the migration and workflow model do not exist.

- [ ] **Step 3: Add the Prisma model and SQL migration**

Define the job model with this public shape:

```prisma
model VehicleHandoverWorkflowJob {
  id              String                           @id @default(uuid()) @db.Uuid
  workOrderId     String                           @map("work_order_id") @db.Uuid
  workOrder       VehicleHandoverWorkOrder         @relation(fields: [workOrderId], references: [id])
  handoverId      String?                          @map("handover_id") @db.Uuid
  eSignTaskId     String?                          @map("esign_task_id") @db.Uuid
  jobType         VehicleHandoverWorkflowJobType   @map("job_type")
  jobStatus       VehicleHandoverWorkflowJobStatus @default(PENDING) @map("job_status")
  idempotencyKey  String                           @unique @map("idempotency_key") @db.VarChar(256)
  availableAt     DateTime                         @default(now()) @map("available_at") @db.Timestamptz(6)
  attemptCount    Int                              @default(0) @map("attempt_count")
  maxAttempts     Int                              @default(5) @map("max_attempts")
  leaseToken      String?                          @map("lease_token") @db.Uuid
  leaseExpiresAt  DateTime?                        @map("lease_expires_at") @db.Timestamptz(6)
  payload         Json?
  resultSnapshot  Json?                            @map("result_snapshot")
  lastErrorCode   String?                          @map("last_error_code") @db.VarChar(128)
  lastErrorMessage String?                         @map("last_error_message") @db.VarChar(512)
  startedAt       DateTime?                        @map("started_at") @db.Timestamptz(6)
  completedAt     DateTime?                        @map("completed_at") @db.Timestamptz(6)
  createdAt       DateTime                         @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime                         @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@index([jobStatus, availableAt])
  @@index([workOrderId, createdAt])
  @@index([leaseExpiresAt])
  @@map("vehicle_handover_workflow_job")
}
```

Add `workflowJobs VehicleHandoverWorkflowJob[]` to
`VehicleHandoverWorkOrder`. The migration must add the canonical operator
columns, backfill external rows from legacy fields and internal rows from
`user.name/mobile`, add indexes, add the workflow table, add the SMS
idempotency column and partial unique index, and append enum values without
dropping legacy columns.

- [ ] **Step 4: Add documented environment defaults**

Use safe disabled defaults:

```dotenv
STAGE2_HANDOVER_WORKFLOW_ENABLED=false
STAGE2_HANDOVER_WORKER_ENABLED=false
STAGE2_HANDOVER_WORKER_CONCURRENCY=1
STAGE2_HANDOVER_WORKER_POLL_INTERVAL_MS=5000
STAGE2_HANDOVER_WORKER_LEASE_MS=120000
ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE=<CHANGE_ME>
ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE=<CHANGE_ME>
```

- [ ] **Step 5: Validate and run the schema tests**

Run: `pnpm prisma:validate`

Run: `pnpm prisma:generate`

Run: `pnpm --filter @subscription-saas/api test -- stage2-handover-workflow-schema.spec.ts stage2-esign-schema.spec.ts sms.spec.ts`

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma apps/api/test/stage2-handover-workflow-schema.spec.ts apps/api/.env.example apps/api/.env.production.example
git commit -m "feat(handover): add durable stage2 workflow schema"
```

### Task 2: Durable Queue, Leases, Retry Policy, And Worker

**Files:**
- Create: `apps/api/src/handover-work-order/stage2-handover-workflow.types.ts`
- Create: `apps/api/src/handover-work-order/stage2-handover-workflow.repository.ts`
- Create: `apps/api/src/handover-work-order/stage2-handover-workflow.worker.ts`
- Create: `apps/api/test/stage2-handover-workflow.repository.spec.ts`
- Create: `apps/api/test/stage2-handover-workflow.worker.spec.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.module.ts`

**Interfaces:**
- Consumes: Prisma `VehicleHandoverWorkflowJob`.
- Produces: `Stage2HandoverWorkflowRepository.enqueue(tx, input): Promise<Job>`.
- Produces: `Stage2HandoverWorkflowRepository.claimDue(limit, leaseMs): Promise<ClaimedJob[]>`.
- Produces: `complete(jobId, leaseToken, result)`, `reschedule(...)`, `deadLetter(...)`, `renewLease(...)`, and `cancelPending(...)`.
- Produces: `Stage2HandoverWorkflowHandler.handle(job): Promise<WorkflowHandlerResult>`.

- [ ] **Step 1: Write failing repository tests for enqueue, claim, lease, and reclaim**

Cover these exact cases:

```ts
it("returns the existing row for a duplicate idempotency key");
it("claims a due pending job only once across two workers");
it("does not claim a processing job with a live lease");
it("reclaims a processing job after its lease expires");
it("requires the matching lease token to complete or reschedule");
```

Use the existing Prisma test harness and two parallel `claimDue(1, 120_000)` calls. Assert that only one result contains the job ID.

- [ ] **Step 2: Run the repository tests to verify they fail**

Run: `pnpm --filter @subscription-saas/api test -- stage2-handover-workflow.repository.spec.ts`

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement atomic PostgreSQL claims**

Use one transaction containing `SELECT ... FOR UPDATE SKIP LOCKED` followed by a guarded update. Return only rows whose lease token was written by that transaction. Reclaim rows where `job_status = 'PROCESSING' AND lease_expires_at <= now()`.

Expose this enqueue input:

```ts
export interface EnqueueStage2WorkflowJobInput {
  availableAt?: Date;
  eSignTaskId?: string;
  handoverId?: string;
  idempotencyKey: string;
  jobType: VehicleHandoverWorkflowJobType;
  maxAttempts?: number;
  payload?: Prisma.InputJsonValue;
  workOrderId: string;
}
```

- [ ] **Step 4: Write failing worker tests**

```ts
it("completes a successful claimed job");
it("uses 1m, 5m, 15m, 1h, and 6h retry delays");
it("moves the fifth failed attempt to DEAD_LETTER");
it("reschedules provider SIGNING without incrementing attemptCount");
it("does not poll when STAGE2_HANDOVER_WORKER_ENABLED is false");
it("never runs more handlers than configured concurrency");
```

- [ ] **Step 5: Run the worker tests to verify they fail**

Run: `pnpm --filter @subscription-saas/api test -- stage2-handover-workflow.worker.spec.ts`

Expected: FAIL because the worker does not exist.

- [ ] **Step 6: Implement the worker loop and bounded logging**

Use `OnModuleInit`/`OnModuleDestroy` with a non-overlapping `setTimeout` loop. Read concurrency, poll interval, and lease duration from `ConfigService`. The handler result contract is:

```ts
export type WorkflowHandlerResult =
  | { kind: "COMPLETED"; result?: Prisma.InputJsonValue }
  | { kind: "OBSERVED_SIGNING"; availableAt: Date; result?: Prisma.InputJsonValue };
```

Sanitize errors to an uppercase bounded code and a 512-character message. Logs may include local IDs, job type, attempt count, and masked provider IDs, but not full mobiles, URLs, digests, or secrets.

- [ ] **Step 7: Run queue tests and typecheck**

Run: `pnpm --filter @subscription-saas/api test -- stage2-handover-workflow.repository.spec.ts stage2-handover-workflow.worker.spec.ts`

Run: `pnpm --filter @subscription-saas/api typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/handover-work-order apps/api/test/stage2-handover-workflow.repository.spec.ts apps/api/test/stage2-handover-workflow.worker.spec.ts
git commit -m "feat(handover): add durable stage2 workflow worker"
```

### Task 3: Canonical Field Operator Identity And Unified OTP Access

**Files:**
- Modify: `apps/api/src/handover-work-order/handover-work-order.dto.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/field-operator/field-operator-auth.service.ts`
- Modify: `apps/api/test/field-operator-auth.spec.ts`
- Create: `apps/api/test/stage2-field-operator-identity.spec.ts`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Modify: `apps/web/test/admin-stage2-handover-review.spec.ts`

**Interfaces:**
- Consumes: `fieldOperatorName` and `fieldOperatorPhone`.
- Produces: assignment writes canonical snapshots for `INTERNAL` and `EXTERNAL`.
- Produces: Field task discovery and authorization by normalized canonical phone, independent of `operatorType`.

- [ ] **Step 1: Add failing identity and authorization tests**

Cover:

```ts
it("snapshots internal User.name and User.mobile during internal assignment");
it("rejects internal assignment when the User has no valid mainland mobile");
it("snapshots registered external name and phone during external assignment");
it("lists both internal and external tasks for the matching canonical phone");
it("does not authorize a legacy phone when the canonical phone differs");
it("rejects reassignment after customerReviewStartedAt is set");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @subscription-saas/api test -- field-operator-auth.spec.ts stage2-field-operator-identity.spec.ts`

Expected: FAIL because internal assignments do not populate canonical identity and discovery still filters external rows.

- [ ] **Step 3: Implement canonical assignment snapshots**

Normalize phone through the existing Field phone helper. Internal assignment must load the selected `User` and copy `name` and `mobile`; external assignment must copy submitted registered values. Update all Field query and authorization predicates to:

```ts
where: {
  fieldOperatorPhone: normalizedPhone,
  deletedAt: null
}
```

Keep `operatorType`, `assignedInternalUserId`, and all external legacy columns for compatibility. Add one guard that rejects assignment mutation once any current review attempt has started customer review.

- [ ] **Step 4: Update Admin assignment form tests and projection**

Ensure the order page renders the canonical name and full phone for both origins and does not imply different Field permissions.

Run: `pnpm --filter @subscription-saas/web test -- admin-stage2-handover-review.spec.ts`

Expected: PASS.

- [ ] **Step 5: Run focused API tests and typechecks**

Run: `pnpm --filter @subscription-saas/api test -- field-operator-auth.spec.ts stage2-field-operator-identity.spec.ts portal-handover-review.spec.ts`

Run: `pnpm --filter @subscription-saas/api typecheck`

Run: `pnpm --filter @subscription-saas/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/test apps/web/src/app/orders/[id]/page.tsx apps/web/test/admin-stage2-handover-review.spec.ts
git commit -m "feat(field): unify stage2 operator identity"
```

### Task 4: Transactional Customer Confirmation And Idempotent PDF Generation

**Files:**
- Create: `apps/api/src/handover-work-order/stage2-handover-workflow.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/portal/portal-handover-review.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.module.ts`
- Create: `apps/api/test/stage2-handover-workflow-confirmation.spec.ts`
- Modify: `apps/api/test/stage2-handover-pdf.spec.ts`
- Modify: `apps/api/test/portal-handover-review.spec.ts`

**Interfaces:**
- Consumes: `Stage2HandoverWorkflowRepository.enqueue`.
- Produces: `customerConfirmNoObjection` transactionally writes customer confirmation and `GENERATE_SOURCE_PDF`.
- Produces: `ensureStage2HandoverPdf(workOrderId, expectedManifestHash): Promise<Stage2HandoverPdfArtifactView>`.
- Produces: workflow projection states `PDF_PENDING`, `PDF_READY`, and `WORKFLOW_EXCEPTION`.

- [ ] **Step 1: Write failing confirmation transaction tests**

```ts
it("commits customer confirmation and GENERATE_SOURCE_PDF in one transaction");
it("rolls back both confirmation and job when either write fails");
it("returns PDF_PENDING without invoking the renderer");
it("repeated confirmation returns the same job id");
```

Assert the idempotency key exactly matches:

```ts
`pdf:${workOrderId}:${reviewAttemptId}:${manifestHash}`
```

- [ ] **Step 2: Run confirmation tests to verify they fail**

Run: `pnpm --filter @subscription-saas/api test -- stage2-handover-workflow-confirmation.spec.ts portal-handover-review.spec.ts`

Expected: FAIL because confirmation does not enqueue PDF generation.

- [ ] **Step 3: Implement transactional enqueue behind the workflow flag**

When `STAGE2_HANDOVER_WORKFLOW_ENABLED=false`, preserve the existing response and behavior. When enabled, perform the existing confirmation writes and enqueue through the same Prisma transaction, then return a projection whose workflow state is `PDF_PENDING`.

- [ ] **Step 4: Add failing PDF idempotency tests**

Cover:

```ts
it("reuses a source artifact with the same manifest hash and source PDF hash");
it("does not duplicate Contract, FileObject, or storage object on retry");
it("fails closed when the current manifest differs from the queued hash");
it("enqueues one NOTIFY_FIELD_ESIGN_READY job after source generation");
```

The notification key is:

```ts
`field-notify:${workOrderId}:${artifactVersion}`
```

- [ ] **Step 5: Run PDF tests to verify they fail**

Run: `pnpm --filter @subscription-saas/api test -- stage2-handover-pdf.spec.ts stage2-handover-workflow-confirmation.spec.ts`

Expected: FAIL on duplicate artifact reuse and next-job enqueue.

- [ ] **Step 6: Extract and implement `ensureStage2HandoverPdf`**

Preserve the approved renderer and all document limits. Check the persisted artifact version, manifest hash, source hash, Contract, and FileObject before rendering. After a successful artifact transaction, enqueue `NOTIFY_FIELD_ESIGN_READY` in that same transaction.

- [ ] **Step 7: Run PDF, Portal, and readiness tests**

Run: `pnpm --filter @subscription-saas/api test -- stage2-handover-pdf.spec.ts stage2-handover-evidence-artifact.spec.ts stage2-handover-evidence-manifest.spec.ts stage2-handover-workflow-confirmation.spec.ts portal-handover-review.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/handover-work-order apps/api/src/portal apps/api/test
git commit -m "feat(handover): automate stage2 source PDF generation"
```

### Task 5: Idempotent Field And Customer Notifications

**Files:**
- Modify: `apps/api/src/sms/sms-provider.ts`
- Modify: `apps/api/src/sms/sms.service.ts`
- Modify: `apps/api/src/sms/aliyun-sms.provider.ts`
- Modify: `apps/api/src/sms/mock-sms.provider.ts`
- Modify: `apps/api/src/notification/notification.service.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-workflow.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.module.ts`
- Modify: `apps/api/test/sms.spec.ts`
- Create: `apps/api/test/stage2-handover-notifications.spec.ts`

**Interfaces:**
- Produces: `SmsProvider.sendTemplate(input): Promise<SmsSendResult>`.
- Produces: `SmsService.sendStage2FieldReady(input)` and `sendStage2CustomerReady(input)`.
- Produces: idempotent customer in-app notification at `/portal/handover-reviews/:workOrderId`.

- [ ] **Step 1: Write failing business SMS tests**

Cover:

```ts
it("uses the Field business template and contains only a login instruction");
it("uses the customer business template and contains only a Portal login instruction");
it("returns the existing SENT log for a duplicate SMS idempotency key");
it("retries only a failed SMS channel");
it("does not serialize a task token, provider URL, evidence URL, name, mobile, VIN, or plate");
```

- [ ] **Step 2: Run SMS tests to verify they fail**

Run: `pnpm --filter @subscription-saas/api test -- sms.spec.ts stage2-handover-notifications.spec.ts`

Expected: FAIL because the SMS provider supports OTP templates only.

- [ ] **Step 3: Implement business-template SMS**

Add:

```ts
export interface SendSmsTemplateInput {
  idempotencyKey: string;
  phone: string;
  purpose: "FIELD_HANDOVER_ESIGN_READY" | "CUSTOMER_HANDOVER_ESIGN_READY";
  templateCode: string;
  templateParams?: Record<string, string>;
}
```

Insert the `SmsSendLog` before sending with the unique idempotency key. On conflict, load and return the existing row. Keep OTP sending unchanged.

- [ ] **Step 4: Write failing dual-channel customer notification tests**

Cover:

```ts
it("creates one customer SMS and one IN_APP notification");
it("uses /portal/handover-reviews/:workOrderId as the in-app URL");
it("retries the missing channel without duplicating the successful channel");
it("marks NOTIFY_CUSTOMER_ESIGN_READY complete only after both channels succeed");
```

- [ ] **Step 5: Implement notification handlers**

Use deterministic channel keys:

```ts
`customer-sms:${eSignTaskId}:${customerTransactionId}`
`customer-in-app:${eSignTaskId}:${customerTransactionId}`
```

Create a handover-specific notification type/event. The Field handler sends one SMS and records its bounded provider outcome. The customer handler independently reconciles SMS and in-app records on every retry.

- [ ] **Step 6: Run notification tests and typecheck**

Run: `pnpm --filter @subscription-saas/api test -- sms.spec.ts notification.spec.ts stage2-handover-notifications.spec.ts`

Run: `pnpm --filter @subscription-saas/api typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/sms apps/api/src/notification apps/api/src/handover-work-order apps/api/test
git commit -m "feat(handover): notify stage2 operators and customers"
```

### Task 6: Field PDF Review Gate And eSign Initiation

**Files:**
- Modify: `apps/api/src/handover-work-order/handover-work-order.dto.ts`
- Modify: `apps/api/src/field-operator/field-operator-auth.controller.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-esign.service.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-workflow.service.ts`
- Create: `apps/api/test/stage2-field-esign-initiation.spec.ts`
- Modify: `apps/api/test/stage2-handover-esign-readiness.spec.ts`
- Modify: `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`

**Interfaces:**
- Produces: `GET /api/field/handover/work-orders/:id/pdf/preview`.
- Produces: `GET /api/field/handover/work-orders/:id/pdf/download`.
- Produces: `POST /api/field/handover/work-orders/:id/esign`.
- Consumes request `{ acknowledgement: true, artifactVersion: number, sourcePdfHash: string }`.
- Produces idempotent active typed Stage 2 eSign task and customer notification/reconciliation jobs.

- [ ] **Step 1: Write failing Field authorization and review tests**

Cover:

```ts
it("keeps a customer-confirmed task visible but makes facts and evidence read-only");
it("allows only the canonical assigned phone to preview and download the PDF");
it("rejects eSign initiation without acknowledgement");
it("rejects a stale artifact version or source hash");
it("rejects a PDF that no longer matches the current manifest");
it("returns the same active task for repeated initiation");
it("records the Field session, canonical identity, artifact version, hash, and timestamp");
```

- [ ] **Step 2: Run Field tests to verify they fail**

Run: `pnpm --filter @subscription-saas/api test -- stage2-field-esign-initiation.spec.ts stage2-handover-esign-readiness.spec.ts`

Expected: FAIL because Field has no PDF or eSign routes.

- [ ] **Step 3: Add the Field DTO and routes**

```ts
export class StartFieldStage2ESignDto {
  @Equals(true)
  acknowledgement!: true;

  @IsInt()
  @Min(1)
  artifactVersion!: number;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  sourcePdfHash!: string;
}
```

The controller delegates to methods that first authorize the canonical phone. Preview/download use the same secure object-storage streaming pattern as Field evidence.

- [ ] **Step 4: Refactor Stage 2 creation for Field actor identity**

Change creation to accept:

```ts
interface Stage2ESignInitiator {
  actorId?: string;
  actorType: "ADMIN" | "FIELD_OPERATOR";
  fieldOperatorSessionId?: string;
  fieldOperatorPhone?: string;
}
```

For the workflow happy path, allow only `FIELD_OPERATOR`. Preserve existing Admin methods behind the feature flag for compatibility and exception handling.

- [ ] **Step 5: Enqueue customer notification and reconciliation**

In the same transaction that finalizes a successfully created typed task, enqueue:

```ts
`customer-notify:${taskId}:${customerTransactionId}`
`customer-reconcile:${taskId}:${customerTransactionId}`
```

The first reconciliation run is available two minutes after initiation.

- [ ] **Step 6: Run focused lifecycle tests**

Run: `pnpm --filter @subscription-saas/api test -- stage2-field-esign-initiation.spec.ts stage2-handover-esign-readiness.spec.ts stage2-handover-esign-lifecycle.spec.ts field-operator-auth.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/field-operator apps/api/src/handover-work-order apps/api/test
git commit -m "feat(field): initiate stage2 esign after PDF review"
```

### Task 7: Provider Reconciliation, Expired Entry Recovery, Auto-Seal, And Archive

**Files:**
- Modify: `apps/api/src/esign/esign.provider.ts`
- Modify: `apps/api/src/esign/mock-esign.provider.ts`
- Modify: `apps/api/src/esign/fadada/fadada-esign.provider.ts`
- Modify: `apps/api/src/esign/fadada/fadada-api.client.ts`
- Modify: `apps/api/src/esign/esign.service.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-esign.service.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-workflow.service.ts`
- Modify: `apps/api/src/esign/fadada/fadada-signed-artifact.service.ts`
- Create: `apps/api/test/stage2-handover-provider-reconciliation.spec.ts`
- Modify: `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`
- Modify: `apps/api/test/stage2-handover-esign-archive.spec.ts`
- Modify: `apps/api/test/fadada-api-client.spec.ts`

**Interfaces:**
- Produces: `ESignProvider.querySignerStatus(input): Promise<ESignProviderSignerStatusResult>`.
- Produces: `SIGNED | SIGNING | FAILED | UNKNOWN`.
- Produces: shared idempotent Stage 2 customer and platform completion transitions.
- Produces: refreshed customer URL for the same Fadada contract/customer/transaction/coordinate.

- [ ] **Step 1: Write failing exact-query tests**

```ts
it("queries the locally bound provider contract, customer, and signer transaction");
it("maps only resultCode 3000 to SIGNED");
it("maps active provider states to SIGNING without consuming an attempt");
it("fails closed on a mismatched transaction, customer, slot, or unknown result");
```

- [ ] **Step 2: Run provider tests to verify they fail**

Run: `pnpm --filter @subscription-saas/api test -- fadada-api-client.spec.ts stage2-handover-provider-reconciliation.spec.ts`

Expected: FAIL because `ESignProvider` has no status-query contract.

- [ ] **Step 3: Add exact provider query support**

```ts
export interface QuerySignerStatusInput {
  contractId: string;
  providerCustomerId: string;
  providerTaskId: string;
  providerTransactionId: string;
  signerId: string;
  slotId: ESignSlotId;
  taskId: string;
}

export interface ESignProviderSignerStatusResult {
  resultCode?: string;
  resultDescription?: string;
  status: "SIGNED" | "SIGNING" | "FAILED" | "UNKNOWN";
}
```

Fadada must call the existing `querySignResult` client and compare exact identifiers before returning `SIGNED`.

- [ ] **Step 4: Write failing callback/query race and URL refresh tests**

Cover:

```ts
it("customer callback and query converge on one customer-signed transition");
it("writes AUTO_SEAL_PLATFORM in the same transaction as customer completion");
it("returns HTTP 200 before the platform provider call runs");
it("cancels obsolete customer reconciliation jobs after completion");
it("refreshes an expired URL without re-uploading or creating a new transaction");
it("returns an already-signed projection instead of a URL when provider reports 3000");
```

- [ ] **Step 5: Implement shared Stage 2 customer completion**

Move Stage 2 callback advancement behind one method:

```ts
reconcileCustomerSigned(input: {
  completedAt: Date;
  eSignTaskId: string;
  providerTransactionId: string;
  source: "CALLBACK" | "QUERY";
}): Promise<void>
```

The serializable transaction validates stage, document type, customer slot, and exact transaction; marks only the customer signer signed; updates the handover to `PENDING_PLATFORM_SEAL`; enqueues `platform-seal:${taskId}:${platformTransactionId}`; and cancels pending customer checks.

- [ ] **Step 6: Write failing auto-seal and archive tests**

Cover:

```ts
it("queries H2 before retrying an ambiguous platform operation");
it("does not issue another seal when H2 is already signed");
it("enqueues RECONCILE_PLATFORM_SEAL for a pending provider result");
it("enqueues ARCHIVE_SIGNED_PDF after platform completion");
it("archives idempotently under the deterministic signed artifact identity");
it("does not advance delivery, lease, billing, payment, accounting, or depreciation");
```

- [ ] **Step 7: Implement worker handlers**

Implement handlers for:

```text
RECONCILE_CUSTOMER_SIGNATURE
AUTO_SEAL_PLATFORM
RECONCILE_PLATFORM_SEAL
ARCHIVE_SIGNED_PDF
```

Use customer due intervals of 2m, 10m, 30m, then 6h. Derive the deterministic
platform transaction with the existing `buildTransactionId(task.taskNo,
"H2")` helper. On ambiguous platform output, query before any repeated write.
On archive success, set `ARCHIVED`; on bounded failure, leave the last
confirmed business state and allow the job to dead-letter.

- [ ] **Step 8: Run lifecycle, archive, callback, and isolation tests**

Run: `pnpm --filter @subscription-saas/api test -- stage2-handover-provider-reconciliation.spec.ts stage2-handover-esign-lifecycle.spec.ts stage2-handover-esign-archive.spec.ts stage2-handover-e2e.spec.ts esign.spec.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/esign apps/api/src/handover-work-order apps/api/test
git commit -m "feat(esign): reconcile and auto-complete stage2 signing"
```

### Task 8: Portal, Field, And Admin Workflow UI

**Files:**
- Modify: `apps/web/src/lib/portal-handover-review-api.ts`
- Modify: `apps/web/src/lib/portal-handover-review-view-model.ts`
- Modify: `apps/web/src/app/portal/handover-reviews/[id]/page.tsx`
- Modify: `apps/web/src/app/portal/contracts/page.tsx`
- Modify: `apps/web/src/app/portal/contracts/[id]/page.tsx`
- Modify: `apps/web/src/lib/field-handover-api.ts`
- Modify: `apps/web/src/lib/field-handover-view-model.ts`
- Modify: `apps/web/src/app/field/handover/tasks/[id]/page.tsx`
- Modify: `apps/web/src/lib/admin-stage2-handover-esign.ts`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Modify: `apps/web/test/portal-handover-review-view-model.spec.ts`
- Modify: `apps/web/test/portal-handover-review-pages.spec.ts`
- Modify: `apps/web/test/portal-handover-esign-view-model.spec.ts`
- Modify: `apps/web/test/field-handover-pages.spec.ts`
- Modify: `apps/web/test/field-handover-api.spec.ts`
- Modify: `apps/web/test/admin-stage2-handover-esign.spec.ts`
- Modify: `apps/web/test/stage2-handover-ui-flow.spec.ts`

**Interfaces:**
- Consumes: API workflow projection, Field PDF metadata/capabilities, and Admin dead-letter actions.
- Produces: dedicated Stage 2 Portal signing entry, Field review dialog, and Admin timeline.

- [ ] **Step 1: Add failing Portal state tests**

Assert exact visible states:

```text
交接确认单生成中
等待经办人发起签署
待客户签署
平台盖章处理中
签署已完成
```

Assert Stage 2 rows in generic contracts navigate to `/portal/handover-reviews/:workOrderId` and never call the generic Stage 1 signing endpoint.

- [ ] **Step 2: Run Portal tests to verify they fail**

Run: `pnpm --filter @subscription-saas/web test -- portal-handover-review-view-model.spec.ts portal-handover-review-pages.spec.ts portal-handover-esign-view-model.spec.ts`

Expected: FAIL on new workflow states and contract redirect behavior.

- [ ] **Step 3: Implement Portal projections**

Keep confirmation success visible while polling the local workflow projection. Enable "去签署" only for `PENDING_CUSTOMER_SIGNATURE`. Treat an already-signed provider projection as success. Do not expose provider URLs in renderable state after navigation.

- [ ] **Step 4: Add failing Field page tests**

Assert the customer-confirmed task remains visible, evidence controls are disabled, PDF metadata and preview/download are shown, and "发起电子签" opens a confirmation dialog. The submit request must include the displayed artifact version and hash.

- [ ] **Step 5: Implement Field API and page**

Use one primary action with a confirmation checkbox/text. Disable it while the request is in flight and preserve idempotent retry. Show notification status without exposing a mobile number. Keep mobile and desktop controls within stable responsive tracks.

- [ ] **Step 6: Add failing Admin timeline and exception tests**

Assert normal rows omit manual PDF/eSign/seal/archive buttons. Assert a `DEAD_LETTER` row shows only the action mapped to its job type. Assert delivery confirmation remains disabled until `ARCHIVED`.

- [ ] **Step 7: Implement Admin workflow presentation**

Render one compact timeline from customer confirmation through archive. Keep existing permission checks for all exception POST actions. Keep void/reissue unavailable after provider signing has completed.

- [ ] **Step 8: Run all focused Web tests, lint, and typecheck**

Run: `pnpm --filter @subscription-saas/web test -- portal-handover-review-view-model.spec.ts portal-handover-review-pages.spec.ts portal-handover-esign-view-model.spec.ts field-handover-pages.spec.ts field-handover-api.spec.ts admin-stage2-handover-esign.spec.ts stage2-handover-ui-flow.spec.ts`

Run: `pnpm --filter @subscription-saas/web lint`

Run: `pnpm --filter @subscription-saas/web typecheck`

Expected: PASS.

- [ ] **Step 9: Verify responsive layout in a browser**

Run the Web app and inspect:

```text
390x844  Field task and Portal handover review
1440x900 Field task, Portal handover review, and Admin order detail
```

Confirm no overlapping controls, no clipped hash/identifier text, and no layout shift when loading or polling.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "feat(web): expose field-orchestrated stage2 workflow"
```

### Task 9: Exception APIs, Backfill, Rollout, And End-To-End Verification

**Files:**
- Modify: `apps/api/src/handover-work-order/handover-work-order.controller.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.dto.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-workflow.service.ts`
- Create: `apps/api/test/stage2-handover-workflow-recovery.spec.ts`
- Create: `scripts/stage2-handover-workflow-backfill-core.mjs`
- Create: `scripts/stage2-handover-workflow-backfill.mjs`
- Create: `scripts/stage2-handover-workflow-backfill-core.test.mjs`
- Modify: `package.json`
- Create: `docs/stage2-field-esign-rollout-runbook.md`
- Modify: `docs/stage-10d-c2-fadada-integration-test.md`

**Interfaces:**
- Produces: permission-guarded Admin dead-letter recovery endpoints.
- Produces: `pnpm stage2-handover-workflow:backfill:dry-run`.
- Produces: `pnpm stage2-handover-workflow:backfill:apply`.
- Produces: idempotent recovery for order `ORD20260726073922TFHF`.

- [ ] **Step 1: Write failing Admin recovery tests**

Cover:

```ts
it("rejects recovery without the delivery-confirm permission");
it("rejects recovery for a non-dead-letter job");
it("maps each dead-letter type to only its relevant retry action");
it("writes an audit event and creates one replacement pending job");
it("does not allow void/reissue after provider completion");
```

- [ ] **Step 2: Implement explicit recovery endpoints**

Use:

```text
POST /api/handover-work-orders/:id/workflow-jobs/:jobId/retry
POST /api/handover-work-orders/:id/workflow/reconcile-customer
```

The first clones only a matching dead-letter job with a recovery idempotency key. The second enqueues only the exact active typed customer transaction. Both use existing Admin auth and delivery-confirm permission enforcement and append an audit event.

- [ ] **Step 3: Write failing backfill core tests**

Cover:

```js
it("backfills internal and external canonical operator snapshots");
it("reports internal users without a valid mobile");
it("creates GENERATE_SOURCE_PDF after confirmed review without a source artifact");
it("creates NOTIFY_FIELD_ESIGN_READY for a ready source artifact without an eSign task");
it("creates RECONCILE_CUSTOMER_SIGNATURE for an active typed customer transaction");
it("creates AUTO_SEAL_PLATFORM when customer is signed and platform is pending");
it("creates ARCHIVE_SIGNED_PDF when both signers are signed but archive is incomplete");
it("creates no job for cancelled, voided, terminal failed, or archived work");
it("is idempotent across repeated dry-run and apply evaluation");
```

- [ ] **Step 4: Run backfill tests to verify they fail**

Run: `node --test scripts/stage2-handover-workflow-backfill-core.test.mjs`

Expected: FAIL because the backfill scripts do not exist.

- [ ] **Step 5: Implement dry-run/apply backfill**

The core module accepts plain records and returns canonical snapshot updates, exceptions, and exact job candidates. The executable loads `.env`, uses Prisma, prints counts and local IDs only, and requires exactly one of `--dry-run` or `--apply`.

Add scripts:

```json
"stage2-handover-workflow:backfill:dry-run": "node scripts/stage2-handover-workflow-backfill.mjs --dry-run",
"stage2-handover-workflow:backfill:apply": "node scripts/stage2-handover-workflow-backfill.mjs --apply",
"stage2-handover-workflow:backfill:test": "node --test scripts/stage2-handover-workflow-backfill-core.test.mjs"
```

- [ ] **Step 6: Document exact Staging rollout and rollback**

The runbook must list:

```text
1. Deploy compatible API/Web images with both flags false.
2. Run prisma migrate deploy without pnpm install inside the runtime container.
3. Run and capture the dry-run backfill report.
4. Run apply and repeat dry-run to prove zero new changes.
5. Set STAGE2_HANDOVER_WORKFLOW_ENABLED=true.
6. Set STAGE2_HANDOVER_WORKER_ENABLED=true with concurrency 1.
7. Confirm ORD20260726073922TFHF gets RECONCILE_CUSTOMER_SIGNATURE.
8. Confirm provider 3000 advances customer, H2 platform seal completes, and signed PDF archives.
9. Execute one new internal-operator and one new external-operator handover.
10. Disable the worker flag first for rollback; do not delete queued jobs.
```

- [ ] **Step 7: Run focused recovery and backfill tests**

Run: `pnpm --filter @subscription-saas/api test -- stage2-handover-workflow-recovery.spec.ts stage2-handover-e2e.spec.ts`

Run: `pnpm stage2-handover-workflow:backfill:test`

Expected: PASS.

- [ ] **Step 8: Run the full verification gate**

Run: `pnpm prisma:validate`

Run: `pnpm prisma:generate`

Run: `pnpm -r lint`

Run: `pnpm -r typecheck`

Run: `pnpm -r test`

Run: `pnpm -r build`

Expected: PASS. If `prisma:migrate:status` cannot run without a configured local database, record that environmental limitation and verify migration SQL through schema tests.

- [ ] **Step 9: Review the diff for scope and secrets**

Run: `git diff --check`

Run: `git diff --stat main...HEAD`

Run: `git grep -n -E "(signUrl|accessToken|digest|secret|password)" -- apps/api/src/handover-work-order apps/api/src/sms scripts/stage2-handover-workflow-backfill.mjs`

Expected: no whitespace errors, no Stage 1 runtime edits, and no logs or payloads containing provider URLs, tokens, digests, secrets, OTP values, or full mobile numbers.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/handover-work-order apps/api/test scripts package.json docs
git commit -m "feat(handover): add stage2 workflow recovery and rollout"
```

- [ ] **Step 11: Request code review, publish the branch, and merge**

Use `superpowers:requesting-code-review`, resolve all actionable findings, rerun the full verification gate, then use the GitHub publishing workflow to push `feat/stage2-field-esign-workflow`, open a PR against `main`, wait for required checks, and merge only after they pass.

After merge, stop before deployment. Human operations will publish and switch the new API/Web images, apply the migration, and return the task for Staging recovery and acceptance.
