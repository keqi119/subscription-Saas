# Stage 2 Handover Wave 1 Orchestration Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Stage 2 handover path in Staging so Admin clearly exposes the next handover action, external Field assignment and both eSign milestones send the approved SMS templates durably, source PDF v2 passes readiness, and retry/dead-letter state is actionable without making notification delivery a business blocker.

**Architecture:** Keep the existing Stage 2 state machine, authoritative readiness service, durable workflow queue, SMS send log, and permission model. Add one assignment-notification job keyed by the immutable assignment event, make the worker re-read current assignment/vehicle facts before sending, align runtime and offline artifact contracts at v2, and project safe queue state into the Admin workspace. Deploy an additive enum migration first, then compatible images with the worker disabled, run a dry-run, and re-enable a single worker so the current acceptance order recovers through its existing idempotent job.

**Tech Stack:** NestJS 11, Prisma/PostgreSQL, Vitest 4, Next.js 16, React 19, Ant Design 6, Aliyun SMS, Docker Compose, GHCR, PowerShell, SSH.

## Global Constraints

- Scope is only `STG2-001`, `STG2-002`, `STG2-003` verification, and `STG2-006` from `docs/acceptance/2026-08-01-stage2-handover-acceptance-issues.md`.
- Do not change video upload, camera capture, video quality, or PDF/Field inspection-field mapping; those remain Wave 2 and Wave 3.
- Do not update or reapply the WeChat public-account menu. Verify the user-configured `/field/handover` entry read-only.
- Do not make SMS success a prerequisite for assignment, source-PDF readiness, eSign task creation, customer signing, sealing, or archival.
- Do not directly update the current acceptance order, handover, workflow jobs, or SMS logs with SQL. Do not delete queue rows or manufacture send logs.
- Preserve the existing `NOTIFY_FIELD_ESIGN_READY` job for `ORD20260731173351SMF2`; after deployment it must retry with its original idempotency key and send `SMS_510815118` at most once.
- Do not send a retroactive `SMS_511185078` assignment message for the current acceptance order. Validate that template on the next natural external assignment or a separate controlled test case.
- `SMS_511185078` uses exactly `{ name: Vehicle.plateNo }`; `SMS_510815118` and `SMS_510795093` use `{}`.
- Never log a full phone number, provider response body, access token, signing URL, object key, VIN, customer identity value, or SMS credential.
- The migration is additive only. Keep new enum values and durable jobs during rollback.
- Automated tests must use mocks and must not call Aliyun, WeChat, the eSign provider, Staging, or Production.
- Preserve unrelated and untracked user files. Stage and commit only the explicit files named by each task.

---

## File Structure

### Data contract and artifact readiness

- Modify `apps/api/prisma/schema.prisma`: add `FIELD_HANDOVER_ASSIGNED` and `NOTIFY_FIELD_HANDOVER_ASSIGNED` enum values.
- Create `apps/api/prisma/migrations/20260801160000_stage2_field_assignment_notification/migration.sql`: add both PostgreSQL enum values without destructive statements.
- Modify `apps/api/src/handover-work-order/stage2-handover-esign-readiness.service.ts`: compare artifacts with the shared v2 runtime constant.
- Modify `scripts/stage2-handover-workflow-contract.mjs`: align offline/backfill contract with artifact version 2.
- Modify `apps/api/test/stage2-handover-esign-readiness.spec.ts`: prove v2 passes and v1/unknown versions fail.
- Modify `apps/api/test/stage2-handover-workflow-schema.spec.ts`: prove migration safety and runtime/offline version agreement.
- Modify `scripts/stage2-handover-workflow-backfill-core.test.mjs`: prove v2 is selected and v1 is rejected by backfill planning.

### SMS and durable assignment orchestration

- Modify `apps/api/src/sms/sms-provider.ts`: add the assignment purpose to the provider contract.
- Modify `apps/api/src/sms/sms.service.ts`: add `sendStage2FieldAssigned`, validate plate text, and make template parameters purpose-specific.
- Modify `apps/api/src/handover-work-order/handover-work-order.service.ts`: write the assignment event and durable notification job in one serializable transaction; expose safe job timing/error fields.
- Modify `apps/api/src/handover-work-order/stage2-handover-workflow.service.ts`: process and recover assignment notifications from canonical current facts while skipping superseded assignments.
- Modify `apps/api/test/sms.spec.ts`: lock the three approved template parameter shapes and validation behavior.
- Modify `apps/api/test/sms.integration.spec.ts`: add the assignment template to the integration configuration contract.
- Modify `apps/api/test/handover-work-order.spec.ts`: prove transactional enqueue, rollback, and safe job DTO behavior.
- Modify `apps/api/test/stage2-handover-notifications.spec.ts`: prove current-recipient delivery, superseded skip, missing-field failures, and notification/eSign decoupling.
- Modify `apps/api/test/stage2-handover-workflow-recovery.spec.ts`: prove only the canonical current assignment dead letter can be recovered.

### Admin workspace and workflow visibility

- Modify `apps/api/src/order/order-workspace.service.ts`: reuse `delivery-check` and return `handover.prepare` when prerequisites pass and no handover work order exists.
- Modify `apps/api/test/order-workspace.spec.ts`: cover prerequisite gating and `delivery:prepare` permission mapping.
- Modify `apps/web/src/lib/admin-order-workspace.ts`: present `handover.prepare` as “推进车辆交接”.
- Modify `apps/web/src/components/order-workspace/order-transaction-guide.tsx`: render the chosen handover action icon.
- Modify `apps/web/src/lib/admin-stage2-handover-esign.ts`: add assignment-notification timeline state, retry details, and matching dead-letter recovery presentation.
- Modify `apps/web/src/app/orders/[id]/page.tsx`: type and render safe `availableAt`/`lastErrorCode` job information and timeline details.
- Modify `apps/web/test/admin-order-workspace.spec.ts`: prove the next-action label and navigation-only behavior.
- Modify `apps/web/test/admin-stage2-handover-esign.spec.ts`: prove pending, processing, dead-letter, readiness, and non-blocking notification displays.

### Configuration, operations, and evidence

- Modify `.env.example`, `.env.staging.example`, `.env.staging.images.example`, `apps/api/.env.example`, and `apps/api/.env.production.example`: document the assignment template plus Field SMS feature/provider switches.
- Modify `docs/stage2-field-esign-rollout-runbook.md`: document worker-off migration, dry-run, single-worker recovery, current-order constraints, and rollback.
- Modify `apps/web/test/deployment-ops-safety.spec.ts`: lock the three template codes, Staging-only real-SMS configuration, worker ordering, and menu verification boundary.
- Update `docs/acceptance/2026-08-01-stage2-handover-acceptance-issues.md` only after deployment verification: append objective Wave 1 evidence without rewriting the original observed facts.

---

### Task 1: Eliminate Stage 2 artifact-version drift

**Files:**
- Modify: `apps/api/test/stage2-handover-esign-readiness.spec.ts`
- Modify: `apps/api/test/stage2-handover-workflow-schema.spec.ts`
- Modify: `scripts/stage2-handover-workflow-backfill-core.test.mjs`
- Modify: `apps/api/src/handover-work-order/stage2-handover-esign-readiness.service.ts`
- Modify: `scripts/stage2-handover-workflow-contract.mjs`

**Interfaces:**
- Consumes: `STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION` from `stage2-handover-source-artifact.ts` and persisted `DeliveryHandover.artifactVersion`.
- Produces: one authoritative acceptance rule: current version `2` is valid; `1`, `null`, and future unknown values emit `SOURCE_ARTIFACT_VERSION_INVALID`.
- Preserves: all manifest, hash, file-object, contract, template, signer-slot, and Stage 1 readiness checks.

- [ ] **Step 1: Change the readiness fixture to v2 and add explicit stale/future-version failures**

In `apps/api/test/stage2-handover-esign-readiness.spec.ts`, make the canonical fixture use the exported runtime constant and add focused cases equivalent to:

```ts
import { STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION } from "../src/handover-work-order/stage2-handover-source-artifact";

it("accepts the current Stage 2 source artifact version", async () => {
  const harness = createReadinessHarness({
    artifactVersion: STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION
  });

  await expect(harness.service.check(harness.workOrderId, harness.actor)).resolves.toMatchObject({
    blockers: [],
    ready: true
  });
});

it.each([1, 3])("rejects non-current artifact version %s", async (artifactVersion) => {
  const harness = createReadinessHarness({ artifactVersion });

  await expect(harness.service.check(harness.workOrderId, harness.actor)).resolves.toMatchObject({
    blockers: expect.arrayContaining([
      expect.objectContaining({ code: "SOURCE_ARTIFACT_VERSION_INVALID" })
    ]),
    ready: false
  });
});
```

- [ ] **Step 2: Add a runtime/offline drift regression and backfill v2 cases**

In `apps/api/test/stage2-handover-workflow-schema.spec.ts`, import/read both constant sources and assert they resolve to `2`. In `scripts/stage2-handover-workflow-backfill-core.test.mjs`, clone the canonical candidate with `artifactVersion: 1` and assert the planner does not treat it as reusable, then assert version `2` is reusable.

- [ ] **Step 3: Run the focused tests and verify RED**

```powershell
pnpm --filter @subscription-saas/api test -- stage2-handover-esign-readiness.spec.ts stage2-handover-workflow-schema.spec.ts
pnpm stage2-handover-workflow:backfill:test
```

Expected: readiness still rejects v2 and/or the offline constant still reports 1.

- [ ] **Step 4: Replace the readiness literal and update the offline contract**

In `stage2-handover-esign-readiness.service.ts` import the shared runtime constant and use:

```ts
if (handover.artifactVersion !== STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION) {
  addBlocker("SOURCE_ARTIFACT_VERSION_INVALID");
}
```

In `scripts/stage2-handover-workflow-contract.mjs` use:

```js
export const STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION = 2;
```

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
pnpm --filter @subscription-saas/api test -- stage2-handover-esign-readiness.spec.ts stage2-handover-workflow-schema.spec.ts
pnpm stage2-handover-workflow:backfill:test
```

- [ ] **Step 6: Commit the artifact contract fix**

```powershell
git add -- 'apps/api/src/handover-work-order/stage2-handover-esign-readiness.service.ts' 'apps/api/test/stage2-handover-esign-readiness.spec.ts' 'apps/api/test/stage2-handover-workflow-schema.spec.ts' 'scripts/stage2-handover-workflow-contract.mjs' 'scripts/stage2-handover-workflow-backfill-core.test.mjs'
git commit -m "fix(stage2): align handover artifact readiness"
```

---

### Task 2: Add the assignment notification schema and three-template SMS contract

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260801160000_stage2_field_assignment_notification/migration.sql`
- Modify: `apps/api/src/sms/sms-provider.ts`
- Modify: `apps/api/src/sms/sms.service.ts`
- Modify: `apps/api/test/sms.spec.ts`
- Modify: `apps/api/test/sms.integration.spec.ts`
- Modify: `apps/api/test/stage2-handover-workflow-schema.spec.ts`

**Interfaces:**
- Consumes: authoritative `plateNo`, normalized phone, per-purpose idempotency key, existing SMS provider/send-log transaction semantics.
- Produces: `sendStage2FieldAssigned({ idempotencyKey, phone, plateNo })` and provider purpose `FIELD_HANDOVER_ASSIGNED`.
- Preserves: `sendStage2FieldReady`, `sendStage2CustomerReady`, uncertain-send finalization, phone masking, and existing idempotency collision rules.

- [ ] **Step 1: Write failing schema-contract assertions**

Extend `apps/api/test/stage2-handover-workflow-schema.spec.ts` to require:

```ts
expect(schema).toContain("FIELD_HANDOVER_ASSIGNED");
expect(schema).toContain("NOTIFY_FIELD_HANDOVER_ASSIGNED");
expect(assignmentMigration).toContain(
  "ADD VALUE IF NOT EXISTS 'FIELD_HANDOVER_ASSIGNED'"
);
expect(assignmentMigration).toContain(
  "ADD VALUE IF NOT EXISTS 'NOTIFY_FIELD_HANDOVER_ASSIGNED'"
);
expect(assignmentMigration).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
```

- [ ] **Step 2: Write failing SMS parameter-shape and validation tests**

Add to `apps/api/test/sms.spec.ts`:

```ts
it("sends the approved Field assignment template with the full plate as name", async () => {
  const harness = createSmsHarness();

  await harness.service.sendStage2FieldAssigned({
    idempotencyKey: "field-assigned:work-order-1:event-1",
    phone: "13900001111",
    plateNo: "沪DGU580"
  });

  expect(harness.provider.sendTemplate).toHaveBeenCalledWith(
    expect.objectContaining({
      phone: "13900001111",
      purpose: "FIELD_HANDOVER_ASSIGNED",
      templateCode: "SMS_FIELD_ASSIGNED",
      templateParams: { name: "沪DGU580" }
    })
  );
});

it.each(["", " ", "沪A12345678901234567890"])(
  "rejects invalid assignment plate %j before calling the provider",
  async (plateNo) => {
    const harness = createSmsHarness();
    await expect(
      harness.service.sendStage2FieldAssigned({
        idempotencyKey: "field-assigned:work-order-1:event-1",
        phone: "13900001111",
        plateNo
      })
    ).rejects.toThrow("FIELD_HANDOVER_PLATE_NO_INVALID");
    expect(harness.provider.sendTemplate).not.toHaveBeenCalled();
  }
);

it("sends both approved eSign templates without variables", async () => {
  const harness = createSmsHarness();
  await harness.service.sendStage2FieldReady({
    idempotencyKey: "field-ready:work-order-1:2",
    phone: "13900001111"
  });
  await harness.service.sendStage2CustomerReady({
    idempotencyKey: "customer-ready:task-1:transaction-1",
    phone: "13800002222"
  });
  expect(harness.provider.sendTemplate).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ templateParams: {} })
  );
  expect(harness.provider.sendTemplate).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ templateParams: {} })
  );
});
```

Configure the harness with `ALIYUN_SMS_FIELD_HANDOVER_ASSIGNED_TEMPLATE_CODE=SMS_FIELD_ASSIGNED` and add the same configuration to `apps/api/test/sms.integration.spec.ts`.

- [ ] **Step 3: Run the schema/SMS tests and verify RED**

```powershell
pnpm --filter @subscription-saas/api test -- sms.spec.ts sms.integration.spec.ts stage2-handover-workflow-schema.spec.ts
```

Expected: the enum/purpose/method/template code do not exist, and the current methods still send `instruction`.

- [ ] **Step 4: Add the additive enum migration**

Update `schema.prisma` enum blocks and create the migration exactly as:

```sql
ALTER TYPE "customer_verification_code_purpose"
  ADD VALUE IF NOT EXISTS 'FIELD_HANDOVER_ASSIGNED';

ALTER TYPE "vehicle_handover_workflow_job_type"
  ADD VALUE IF NOT EXISTS 'NOTIFY_FIELD_HANDOVER_ASSIGNED';
```

- [ ] **Step 5: Implement explicit per-template SMS parameters**

In `sms-provider.ts` extend the union:

```ts
export type SmsTemplatePurpose =
  | "FIELD_HANDOVER_ASSIGNED"
  | "FIELD_HANDOVER_ESIGN_READY"
  | "CUSTOMER_HANDOVER_ESIGN_READY";
```

In `sms.service.ts`, replace the hard-coded instruction input with an explicit parameter object and add:

```ts
interface SendStage2FieldAssignedInput extends SendBusinessSmsInput {
  plateNo: string;
}

async sendStage2FieldAssigned(input: SendStage2FieldAssignedInput) {
  const plateNo = input.plateNo.trim();
  if (plateNo.length < 1 || plateNo.length > 20) {
    throw new Error("FIELD_HANDOVER_PLATE_NO_INVALID");
  }
  return this.sendBusinessTemplate({
    enabled: this.isSmsEnabled("FIELD_OPERATOR_SMS_ENABLED"),
    input: {
      idempotencyKey: input.idempotencyKey,
      phone: input.phone
    },
    purpose: "FIELD_HANDOVER_ASSIGNED",
    templateCode: this.readRequiredTemplateCode(
      "ALIYUN_SMS_FIELD_HANDOVER_ASSIGNED_TEMPLATE_CODE"
    ),
    templateParams: { name: plateNo }
  });
}
```

Change the private `sendBusinessTemplate` input from `instruction: string` to `templateParams: Record<string, string>`, make the provider input forward `templateParams: input.templateParams`, and extend `readRequiredTemplateCode` with `ALIYUN_SMS_FIELD_HANDOVER_ASSIGNED_TEMPLATE_CODE`. Make the other calls pass `templateParams: {}`. Do not retain the two instruction constants.

- [ ] **Step 6: Generate Prisma and run GREEN tests**

```powershell
pnpm --filter @subscription-saas/api prisma:generate
pnpm --filter @subscription-saas/api test -- sms.spec.ts sms.integration.spec.ts stage2-handover-workflow-schema.spec.ts
pnpm prisma:validate
```

- [ ] **Step 7: Commit the migration and SMS contract**

```powershell
git add -- 'apps/api/prisma/schema.prisma' 'apps/api/prisma/migrations/20260801160000_stage2_field_assignment_notification/migration.sql' 'apps/api/src/sms/sms-provider.ts' 'apps/api/src/sms/sms.service.ts' 'apps/api/test/sms.spec.ts' 'apps/api/test/sms.integration.spec.ts' 'apps/api/test/stage2-handover-workflow-schema.spec.ts'
git commit -m "feat(stage2): add field assignment sms contract"
```

---

### Task 3: Enqueue assignment notification atomically with external assignment

**Files:**
- Modify: `apps/api/test/handover-work-order.spec.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`

**Interfaces:**
- Consumes: external assignment DTO, versioned work order, `EXTERNAL_OPERATOR_ASSIGNED` event, `Stage2HandoverWorkflowRepository.enqueue(tx, input)`.
- Produces: one `NOTIFY_FIELD_HANDOVER_ASSIGNED` job with payload `{ assignmentEventId }` and idempotency key `field-assigned:{workOrderId}:{assignmentEventId}` in the same serializable transaction.
- Preserves: access-token return value, optimistic concurrency, audit event, normalized phone, assignment eligibility, and no synchronous SMS call in the request path.

- [ ] **Step 1: Write failing transaction/enqueue tests**

Add tests to `apps/api/test/handover-work-order.spec.ts` that inject a workflow repository and assert:

```ts
expect(harness.workflowRepository.enqueue).toHaveBeenCalledWith(
  harness.transaction,
  expect.objectContaining({
    handoverId: draft.handoverId,
    idempotencyKey: `field-assigned:${draft.id}:assignment-event-1`,
    jobType: VehicleHandoverWorkflowJobType.NOTIFY_FIELD_HANDOVER_ASSIGNED,
    payload: { assignmentEventId: "assignment-event-1" },
    workOrderId: draft.id
  })
);
```

Also make `recordEvent` throw once and assert no enqueue/committed assignment is returned; make `enqueue` throw once and assert the transaction rejects so assignment/event/job cannot diverge.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
pnpm --filter @subscription-saas/api test -- handover-work-order.spec.ts
```

Expected: assignment returns successfully without invoking the repository.

- [ ] **Step 3: Return the event row from the transaction and enqueue by immutable event id**

Refactor only `assignExternalOperator` to perform its versioned update, event insert, and enqueue within its serializable transaction. Use the persisted event id, not a generated request id:

```ts
const assignmentEvent = await this.recordEvent(
  updated,
  VehicleHandoverEventType.EXTERNAL_OPERATOR_ASSIGNED,
  {
    actorId,
    actorType: VehicleHandoverEventActorType.ADMIN,
    detail: {
      expiresAt: expiresAt.toISOString(),
      operatorName: name,
      phoneMasked: maskPhone(phone)
    }
  },
  tx
);
const assignmentEventId = assignmentEvent
  ? readString(assignmentEvent, "id")
  : null;
if (!assignmentEventId) {
  throw new InternalServerErrorException("HANDOVER_ASSIGNMENT_EVENT_MISSING");
}

const idempotencyKey = `field-assigned:${workOrderId}:${assignmentEventId}`;
await this.requireWorkflowRepository().enqueue(tx, {
  handoverId: updated.handoverId,
  idempotencyKey,
  jobType: VehicleHandoverWorkflowJobType.NOTIFY_FIELD_HANDOVER_ASSIGNED,
  maxAttempts: 6,
  payload: { assignmentEventId },
  workOrderId
});
```

Keep provider delivery outside this transaction. `requireWorkflowRepository()` must throw `HANDOVER_WORKFLOW_REPOSITORY_UNAVAILABLE` if the production dependency is absent; update all direct service test harnesses to provide the fake repository.

- [ ] **Step 4: Run the assignment tests and verify GREEN**

```powershell
pnpm --filter @subscription-saas/api test -- handover-work-order.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

- [ ] **Step 5: Commit the atomic assignment enqueue**

```powershell
git add -- 'apps/api/src/handover-work-order/handover-work-order.service.ts' 'apps/api/test/handover-work-order.spec.ts'
git commit -m "feat(stage2): enqueue assignment notification atomically"
```

---

### Task 4: Process and recover only the canonical assignment notification

**Files:**
- Modify: `apps/api/test/stage2-handover-notifications.spec.ts`
- Modify: `apps/api/test/stage2-handover-workflow-recovery.spec.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-workflow.service.ts`

**Interfaces:**
- Consumes: job payload `assignmentEventId`, latest assignment event, current `operatorType`, current normalized external phone, `order.vehicle.plateNo`, and `SmsService.sendStage2FieldAssigned`.
- Produces: `COMPLETED` delivery, safe `COMPLETED` superseded skip, or retryable/dead-letter error with stable safe code; recovery preserves the original business idempotency key.
- Preserves: existing source-PDF, Field-ready, customer-ready, reconciliation, sealing, and archival handlers.

- [ ] **Step 1: Write failing notification handler tests**

Add to `apps/api/test/stage2-handover-notifications.spec.ts`:

```ts
it("notifies the currently assigned external Field operator with the current vehicle plate", async () => {
  const harness = createNotificationHarness({
    assignmentEventId: "assignment-event-2",
    currentAssignmentEventId: "assignment-event-2",
    externalPhone: "13900001111",
    plateNo: "沪DGU580"
  });

  await harness.run(VehicleHandoverWorkflowJobType.NOTIFY_FIELD_HANDOVER_ASSIGNED);

  expect(harness.sms.sendStage2FieldAssigned).toHaveBeenCalledWith({
    idempotencyKey: "field-assigned:work-order-1:assignment-event-2",
    phone: "13900001111",
    plateNo: "沪DGU580"
  });
});

it("completes a superseded assignment job without sending to the old recipient", async () => {
  const harness = createNotificationHarness({
    assignmentEventId: "assignment-event-1",
    currentAssignmentEventId: "assignment-event-2"
  });

  await expect(
    harness.run(VehicleHandoverWorkflowJobType.NOTIFY_FIELD_HANDOVER_ASSIGNED)
  ).resolves.toMatchObject({ skipped: "ASSIGNMENT_SUPERSEDED" });
  expect(harness.sms.sendStage2FieldAssigned).not.toHaveBeenCalled();
});
```

Add separate missing-phone and missing-plate tests that expect `FIELD_HANDOVER_RECIPIENT_MISSING` and `FIELD_HANDOVER_PLATE_NO_MISSING`, with no provider call. Update existing Field-ready and customer-ready assertions to require `{}` parameters and keep `canStartESign` true when notification jobs fail.

- [ ] **Step 2: Write failing dead-letter recovery tests**

In `apps/api/test/stage2-handover-workflow-recovery.spec.ts`, configure an assignment dead letter and assert recovery creates:

```ts
expect(harness.jobs[1]).toMatchObject({
  idempotencyKey: "recovery:dead-letter-1",
  jobType: VehicleHandoverWorkflowJobType.NOTIFY_FIELD_HANDOVER_ASSIGNED,
  payload: { assignmentEventId: "assignment-event-2" },
  workOrderId: "work-order-1"
});
```

Run the replacement through the handler and assert `sendStage2FieldAssigned` receives the original business key `field-assigned:work-order-1:assignment-event-2`, not the replacement row key `recovery:dead-letter-1`. Then change the canonical latest event to `assignment-event-3` and assert recovery of event 2 is rejected as superseded.

- [ ] **Step 3: Run tests and verify RED**

```powershell
pnpm --filter @subscription-saas/api test -- stage2-handover-notifications.spec.ts stage2-handover-workflow-recovery.spec.ts
```

Expected: the new job type is unsupported and canonical recovery requires post-confirmation PDF/eSign facts.

- [ ] **Step 4: Add canonical assignment loading and handler routing**

Add the new enum to the supported job set/switch. Parse payload strictly:

```ts
private assignmentEventId(payload: Prisma.JsonValue): string {
  const record = asRecord(payload);
  const assignmentEventId = nonEmptyString(record?.assignmentEventId);
  if (!assignmentEventId) {
    throw new Error("FIELD_HANDOVER_ASSIGNMENT_EVENT_MISSING");
  }
  return assignmentEventId;
}
```

Load the work order with `order.vehicle.plateNo` and assignment events ordered newest-first. Before sending, require current `operatorType === EXTERNAL`, current phone, current plate, and exact equality with the newest assignment event id. If a later assignment exists, return `{ skipped: "ASSIGNMENT_SUPERSEDED" }` and let the worker complete the job.

- [ ] **Step 5: Special-case canonical recovery before post-confirmation readiness**

In `buildCanonicalRecoveryExpectation`, branch before `requireCanonicalRecoveryContext`:

```ts
if (sourceJob.jobType === VehicleHandoverWorkflowJobType.NOTIFY_FIELD_HANDOVER_ASSIGNED) {
  return this.buildFieldAssignmentRecoveryExpectation(workOrder, sourceJob);
}

const context = this.requireCanonicalRecoveryContext(workOrder);
```

`buildFieldAssignmentRecoveryExpectation` must compare the source payload event id with the newest canonical external-assignment event, use the current handover id, preserve `field-assigned:{workOrderId}:{assignmentEventId}`, and reject superseded sources. Do not require `CUSTOMER_CONFIRMED`, a source PDF, or an eSign task for this job type.

- [ ] **Step 6: Run notification/recovery tests and verify GREEN**

```powershell
pnpm --filter @subscription-saas/api test -- stage2-handover-notifications.spec.ts stage2-handover-workflow-recovery.spec.ts handover-work-order.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

- [ ] **Step 7: Commit the worker and recovery path**

```powershell
git add -- 'apps/api/src/handover-work-order/stage2-handover-workflow.service.ts' 'apps/api/test/stage2-handover-notifications.spec.ts' 'apps/api/test/stage2-handover-workflow-recovery.spec.ts'
git commit -m "feat(stage2): deliver recoverable assignment notifications"
```

---

### Task 5: Expose “推进车辆交接” from authoritative delivery readiness

**Files:**
- Modify: `apps/api/test/order-workspace.spec.ts`
- Modify: `apps/api/src/order/order-workspace.service.ts`
- Modify: `apps/web/test/admin-order-workspace.spec.ts`
- Modify: `apps/web/src/lib/admin-order-workspace.ts`
- Modify: `apps/web/src/components/order-workspace/order-transaction-guide.tsx`

**Interfaces:**
- Consumes: `OrderService.getDeliveryCheck(orderId, actor)`, delivery status, and current handover work-order facts.
- Produces: workspace action `{ actionCode: "handover.prepare", requiredPermission: "delivery:prepare" }` when prerequisites are satisfied and no active handover work order exists.
- Preserves: work-order creation in the handover module, the existing “分配交接任务” action after preparation, and all server-side permission checks.

- [ ] **Step 1: Write failing API resolver/service tests**

Add cases to `apps/api/test/order-workspace.spec.ts`:

```ts
expect(
  resolver.resolveHandover({
    asOf: AS_OF,
    canPrepareDelivery: true,
    deliveryStatus: null,
    workOrders: []
  })
).toMatchObject({
  actionCode: "handover.prepare",
  reasonCode: "HANDOVER_PREPARATION_REQUIRED",
  state: "ACTION_REQUIRED",
  targetRecordId: null,
  targetTab: "handover"
});

expect(
  filterWorkspaceActionByPermission(
    resolver.resolveHandover({
      asOf: AS_OF,
      canPrepareDelivery: true,
      deliveryStatus: null,
      workOrders: []
    }),
    workspaceUser([PermissionCode.DELIVERY_PREPARE])
  ).actionCode
).toBe("handover.prepare");
```

Add a paired `canPrepareDelivery: false`/`deliveryStatus: null` case that remains `NOT_STARTED` with no action, plus a prepared `deliveryStatus: "READY"` case that still offers the handover action. At the service boundary, mock `orderService.getDeliveryCheck` and prove the resolver receives its authoritative boolean/status instead of duplicating payment/contract rules.

- [ ] **Step 2: Run API workspace tests and verify RED**

```powershell
pnpm --filter @subscription-saas/api test -- order-workspace.spec.ts
```

- [ ] **Step 3: Load delivery readiness and add the action mapping**

Extend the handover facts:

```ts
interface HandoverWorkspaceFacts {
  asOf: string;
  canPrepareDelivery: boolean;
  deliveryStatus: string | null;
  workOrder?: HandoverWorkOrderFacts | null;
  workOrders?: HandoverWorkOrderFacts[];
}
```

Use `Promise.all` in `loadHandover` to load `getDeliveryCheck` and work-order facts; consume `deliveryCheck.deliveryStatus` rather than issuing a duplicate delivery query. In `resolveHandover`, before the existing empty-work-order result, return:

```ts
const workOrders = facts.workOrders ?? (facts.workOrder ? [facts.workOrder] : []);
if (
  workOrders.length === 0 &&
  (facts.canPrepareDelivery || facts.deliveryStatus === "READY")
) {
  return guideItem(
    "handover",
    "ACTION_REQUIRED",
    "HANDOVER_PREPARATION_REQUIRED",
    "handover.prepare",
    null,
    null
  );
}
```

Add `"handover.prepare": PermissionCode.DELIVERY_PREPARE` to `ACTION_PERMISSION`; permission filtering remains fail-closed.

- [ ] **Step 4: Add the failing Web presentation test**

In `apps/web/test/admin-order-workspace.spec.ts`, assert `getOrderWorkspaceActionPresentation("handover.prepare")` has label `推进车辆交接`, and assert the guide action navigates to the existing handover domain/tab without directly calling a create-work-order API.

- [ ] **Step 5: Run the Web test and verify RED**

```powershell
pnpm --filter @subscription-saas/web test -- admin-order-workspace.spec.ts
```

- [ ] **Step 6: Add the presentation and icon**

Extend `OrderWorkspaceActionCode` and `ACTION_PRESENTATIONS`:

```ts
"handover.prepare": {
  icon: "CarOutlined",
  label: "推进车辆交接"
}
```

Map `car` to Ant Design `CarOutlined` in `order-transaction-guide.tsx`. Route the action through the current order page’s handover-tab navigation; do not invoke a mutation.

- [ ] **Step 7: Run API/Web tests and commit**

```powershell
pnpm --filter @subscription-saas/api test -- order-workspace.spec.ts
pnpm --filter @subscription-saas/web test -- admin-order-workspace.spec.ts
git add -- 'apps/api/src/order/order-workspace.service.ts' 'apps/api/test/order-workspace.spec.ts' 'apps/web/src/lib/admin-order-workspace.ts' 'apps/web/src/components/order-workspace/order-transaction-guide.tsx' 'apps/web/test/admin-order-workspace.spec.ts'
git commit -m "feat(stage2): expose handover preparation next action"
```

---

### Task 6: Show safe workflow retry, readiness, and recovery state without blocking eSign

**Files:**
- Modify: `apps/api/test/handover-work-order.spec.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/web/test/admin-stage2-handover-esign.spec.ts`
- Modify: `apps/web/src/lib/admin-stage2-handover-esign.ts`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`

**Interfaces:**
- Consumes: safe workflow jobs, readiness blockers, recovery capabilities, eSign business status.
- Produces: whitelisted `availableAt` and `lastErrorCode`, an assignment-notification timeline step, retry/processing details, and “重发交接任务通知” for authorized recoverable dead letters.
- Preserves: provider payload redaction, Field-first/Admin-fallback rules, and eSign availability whenever readiness itself is true.

- [ ] **Step 1: Write failing safe-DTO tests**

In `apps/api/test/handover-work-order.spec.ts`, assert the Admin summary exposes only:

```ts
expect(summary.workflowJobs[0]).toEqual({
  attemptCount: 2,
  availableAt: "2026-08-01T06:10:00.000Z",
  createdAt: "2026-08-01T06:00:00.000Z",
  id: "workflow-job-1",
  jobStatus: "PENDING",
  jobType: "NOTIFY_FIELD_HANDOVER_ASSIGNED",
  lastErrorCode: "SMS_PROVIDER_NOT_CONFIGURED",
  maxAttempts: 6,
  updatedAt: "2026-08-01T06:05:00.000Z"
});
expect(JSON.stringify(summary.workflowJobs[0])).not.toMatch(
  /phone|payload|provider|message|objectKey|token|url/i
);
```

- [ ] **Step 2: Write failing Web timeline tests**

Add to `apps/web/test/admin-stage2-handover-esign.spec.ts`:

```ts
expect(
  getAdminStage2HandoverWorkflowDisplay(
    detailWithJob({
      availableAt: "2026-08-01T06:10:00.000Z",
      jobStatus: "PENDING",
      jobType: "NOTIFY_FIELD_HANDOVER_ASSIGNED",
      lastErrorCode: "SMS_PROVIDER_NOT_CONFIGURED"
    })
  ).steps
).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      detail: expect.stringContaining("2026-08-01"),
      key: "FIELD_ASSIGNMENT_NOTIFICATION",
      status: "PROCESS"
    })
  ])
);
```

Add PROCESSING and DEAD_LETTER cases, and a case where `NOTIFY_FIELD_ESIGN_READY` is pending/dead but readiness is `ready: true`; assert `startAvailable` remains true. Assert the assignment dead letter’s recovery label is `重发交接任务通知`.

- [ ] **Step 3: Run tests and verify RED**

```powershell
pnpm --filter @subscription-saas/api test -- handover-work-order.spec.ts
pnpm --filter @subscription-saas/web test -- admin-stage2-handover-esign.spec.ts
```

- [ ] **Step 4: Whitelist timing/error-code fields in the API summary**

Extend `listSafeStage2WorkflowJobs` to map dates to ISO strings and only expose the stable error code:

```ts
return jobs.map((job) => ({
  attemptCount: job.attemptCount,
  availableAt: job.availableAt.toISOString(),
  createdAt: job.createdAt.toISOString(),
  id: job.id,
  jobStatus: job.jobStatus,
  jobType: job.jobType,
  lastErrorCode: job.lastErrorCode ?? null,
  maxAttempts: job.maxAttempts,
  updatedAt: job.updatedAt.toISOString()
}));
```

Do not add `lastErrorMessage`, `payload`, `notificationIdempotencyKey`, `leaseOwner`, or provider fields.

- [ ] **Step 5: Add the assignment notification step and safe detail text**

In `admin-stage2-handover-esign.ts`, add:

```ts
type AdminStage2HandoverWorkflowStepKey =
  | "FIELD_ASSIGNMENT_NOTIFICATION"
  | "CUSTOMER_CONFIRMATION"
  | "SOURCE_PDF"
  | "FIELD_INITIATION"
  | "CUSTOMER_SIGNATURE"
  | "PLATFORM_SEAL"
  | "ARCHIVE";

const WORKFLOW_JOB_STEP = {
  NOTIFY_FIELD_HANDOVER_ASSIGNED: "FIELD_ASSIGNMENT_NOTIFICATION",
  GENERATE_SOURCE_PDF: "SOURCE_PDF",
  NOTIFY_FIELD_ESIGN_READY: "FIELD_INITIATION",
  NOTIFY_CUSTOMER_ESIGN_READY: "CUSTOMER_SIGNATURE",
  RECONCILE_CUSTOMER_SIGNATURE: "CUSTOMER_SIGNATURE",
  AUTO_SEAL_PLATFORM: "PLATFORM_SEAL",
  RECONCILE_PLATFORM_SEAL: "PLATFORM_SEAL",
  ARCHIVE_SIGNED_PDF: "ARCHIVE"
} satisfies Record<AdminStage2HandoverWorkflowJobType, AdminStage2HandoverWorkflowStepKey>;
```

Render PENDING as “等待系统重试，下次运行：{availableAt}”, PROCESSING as “系统正在处理”, safe readiness codes through the existing blocker labels, and assignment dead letters with `重发交接任务通知`. Treat a completed downstream customer confirmation as historical proof that assignment notification cannot gate progress, while retaining its audit display.

- [ ] **Step 6: Render timeline details on the order page**

Add `availableAt`/`lastErrorCode` to the page’s safe job type and render `step.detail` below the step label. The eSign button’s disabled state must continue to use the API readiness/capability result, not notification status.

- [ ] **Step 7: Run focused tests and commit**

```powershell
pnpm --filter @subscription-saas/api test -- handover-work-order.spec.ts stage2-handover-notifications.spec.ts
pnpm --filter @subscription-saas/web test -- admin-stage2-handover-esign.spec.ts admin-order-workspace.spec.ts field-handover-api.spec.ts
git add -- 'apps/api/src/handover-work-order/handover-work-order.service.ts' 'apps/api/test/handover-work-order.spec.ts' 'apps/web/src/lib/admin-stage2-handover-esign.ts' 'apps/web/src/app/orders/[id]/page.tsx' 'apps/web/test/admin-stage2-handover-esign.spec.ts'
git commit -m "feat(stage2): surface handover workflow recovery state"
```

---

### Task 7: Complete configuration, runbook, and repository-wide verification

**Files:**
- Modify: `.env.example`
- Modify: `.env.staging.example`
- Modify: `.env.staging.images.example`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/.env.production.example`
- Modify: `docs/stage2-field-esign-rollout-runbook.md`
- Modify: `apps/web/test/deployment-ops-safety.spec.ts`

**Interfaces:**
- Consumes: environment-variable names read by `SmsService`, Compose `env_file`, Stage 2 worker flags, approved Staging template codes.
- Produces: a reproducible worker-off/worker-on rollout and a regression-checked Staging configuration contract.
- Preserves: secrets outside Git, Production defaults, and `PORTAL_SMS_ENABLED` as the customer-SMS feature boundary.

- [ ] **Step 1: Write failing deployment-safety tests**

Extend `apps/web/test/deployment-ops-safety.spec.ts` to read all environment examples and the runbook. Assert the Staging examples contain exactly:

```dotenv
FIELD_OPERATOR_SMS_ENABLED=true
FIELD_OPERATOR_SMS_PROVIDER=aliyun
ALIYUN_SMS_FIELD_HANDOVER_ASSIGNED_TEMPLATE_CODE=SMS_511185078
ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510815118
ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510795093
```

Assert generic/Production examples default `FIELD_OPERATOR_SMS_ENABLED=false`, contain no Aliyun credential values, and the runbook says the public-account menu is verification-only.

- [ ] **Step 2: Run the deployment-safety test and verify RED**

```powershell
pnpm --filter @subscription-saas/web test -- deployment-ops-safety.spec.ts
```

- [ ] **Step 3: Update examples and rollout runbook**

Add the five non-secret keys to the examples. In the runbook, make the order explicit:

```text
1. Record current images/env checksum; verify PORTAL_SMS_ENABLED remains true.
2. Set STAGE2_HANDOVER_WORKER_ENABLED=false and recreate API.
3. Run additive Prisma migrate deploy from the new API image.
4. Deploy compatible API/Web images while the worker remains disabled.
5. Bind-mount the release-matched backfill scripts read-only and run dry-run.
6. Set STAGE2_HANDOVER_WORKER_ENABLED=true and concurrency=1; recreate API.
7. Observe existing jobs through Admin/API-safe state; never update queue rows directly.
8. Verify /field/handover without changing the WeChat menu.
```

Document the current-order constraints: no assignment backfill, preserve the old Field-ready job/idempotency key, and only allow customer-ready SMS after a natural Field eSign initiation.

- [ ] **Step 4: Run focused and full quality gates**

Before `quality:gate`, load the existing local root `.env` only into the command process if the worktree does not contain it; do not copy or commit the file.

```powershell
pnpm stage2-handover-workflow:backfill:test
pnpm --filter @subscription-saas/api test -- stage2-handover-esign-readiness.spec.ts stage2-handover-notifications.spec.ts stage2-handover-workflow-recovery.spec.ts order-workspace.spec.ts handover-work-order.spec.ts sms.spec.ts sms.integration.spec.ts stage2-handover-workflow-schema.spec.ts
pnpm --filter @subscription-saas/web test -- admin-order-workspace.spec.ts admin-stage2-handover-esign.spec.ts field-handover-api.spec.ts deployment-ops-safety.spec.ts
pnpm quality:gate
pnpm -r build
git diff --check
```

Expected: all migrations validate, all focused tests and repository tests pass, API/Web typecheck, lint, and builds pass, and no external SMS is sent.

- [ ] **Step 5: Commit configuration and operations documentation**

```powershell
git add -- '.env.example' '.env.staging.example' '.env.staging.images.example' 'apps/api/.env.example' 'apps/api/.env.production.example' 'docs/stage2-field-esign-rollout-runbook.md' 'apps/web/test/deployment-ops-safety.spec.ts'
git commit -m "docs(stage2): define field sms rollout controls"
```

---

### Task 8: Review, merge, build from the merge commit, and deploy Staging safely

**Files:**
- No source-code changes before review; any review fix repeats its focused test and Task 7 gates.
- Update after successful acceptance: `docs/acceptance/2026-08-01-stage2-handover-acceptance-issues.md`

**Interfaces:**
- Consumes: green branch, GitHub PR checks, merged `main` commit, GHCR, Staging SSH access, release-matched scripts, existing Staging environment.
- Produces: merged PR, immutable API/Web image tags built from the merge commit, migrated Staging deployment, naturally recovered current order, and objective acceptance evidence.
- Preserves: old image tags/env backup, current queue rows, additive migration, and rollback capability.

- [ ] **Step 1: Perform pre-PR branch verification and inspect scope**

```powershell
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Confirm no Wave 2/Wave 3 files, secrets, provider responses, live phone values, or direct data-repair scripts entered the diff.

- [ ] **Step 2: Request code review, resolve findings with TDD, and rerun gates**

Use `superpowers:requesting-code-review`. For every valid finding: add/adjust a failing test, run it RED, make the smallest fix, run it GREEN, then rerun the Task 7 quality gates. Do not weaken the design’s transaction, idempotency, privacy, or notification/eSign-decoupling guarantees.

- [ ] **Step 3: Push, open the PR, wait for checks, and merge**

Use `github:yeet` for the publish flow. The PR description must list the three SMS semantics, additive migration, current-order no-backfill rule, successful test commands, and controlled Staging rollout. Merge only after required GitHub checks and review are green.

- [ ] **Step 4: Build and push immutable images from the merged commit**

Create a clean detached release worktree at the merged `origin/main` commit. Let `$stage2ShortSha` be `git rev-parse --short=7 HEAD` in that worktree and tag both images `Staging-20260801-$stage2ShortSha`:

```powershell
docker build -f Dockerfile.api -t "ghcr.io/keqi119/subscription-api:Staging-20260801-$stage2ShortSha" .
docker build -f Dockerfile.web -t "ghcr.io/keqi119/subscription-web:Staging-20260801-$stage2ShortSha" .
docker push "ghcr.io/keqi119/subscription-api:Staging-20260801-$stage2ShortSha"
docker push "ghcr.io/keqi119/subscription-web:Staging-20260801-$stage2ShortSha"
```

Record the full merge SHA and both image digests. Never build release images from an unmerged feature-branch commit.

- [ ] **Step 5: Preflight and disable the Staging worker before migration**

On `root@139.196.227.195`, resolve `/opt/subscription-saas`, `docker-compose.staging.images.example.yml`, project `subauto-staging`, and `.env.staging.images`. Record current API/Web image values and SHA-256 of the environment file, then create a timestamped backup under `/opt/subscription-saas/backups/`. Set `STAGE2_HANDOVER_WORKER_ENABLED=false`, recreate only API, and confirm health before changing images or schema.

- [ ] **Step 6: Configure images/SMS, migrate, and deploy with worker still disabled**

Update only these non-secret values after confirming `PORTAL_SMS_ENABLED=true` remains present:

```dotenv
API_IMAGE=ghcr.io/keqi119/subscription-api:Staging-20260801-$stage2ShortSha
WEB_IMAGE=ghcr.io/keqi119/subscription-web:Staging-20260801-$stage2ShortSha
FIELD_OPERATOR_SMS_ENABLED=true
FIELD_OPERATOR_SMS_PROVIDER=aliyun
ALIYUN_SMS_FIELD_HANDOVER_ASSIGNED_TEMPLATE_CODE=SMS_511185078
ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510815118
ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510795093
STAGE2_HANDOVER_WORKER_ENABLED=false
```

Pull images, run Prisma migration from the new API image, then recreate API/Web:

```bash
docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images pull api web
docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images run --rm --no-deps --workdir /app/apps/api --entrypoint /app/apps/api/node_modules/.bin/prisma api migrate deploy --schema prisma/schema.prisma
docker compose -p subauto-staging -f docker-compose.staging.images.example.yml --env-file .env.staging.images up -d --force-recreate api web
```

Check API health, Web health, container image digests, migration status, and safe presence—not values—of required secret variables.

- [ ] **Step 7: Run the release-matched backfill dry-run before enabling one worker**

Upload these exact files from the merged release worktree to a release-specific server directory and bind-mount them read-only into the API container:

```text
scripts/stage2-handover-workflow-backfill.mjs
scripts/stage2-handover-workflow-backfill-core.mjs
scripts/stage2-handover-workflow-contract.mjs
```

Run dry-run only and save the non-sensitive summary. It must not update the current handover artifact from v2 to v1, insert a retroactive assignment notification, delete jobs, or modify SMS logs. Then set `STAGE2_HANDOVER_WORKER_ENABLED=true`, retain concurrency `1`, and recreate API.

- [ ] **Step 8: Verify the current acceptance order through supported interfaces**

For `ORD20260731173351SMF2` / work order `69952e92-4a86-445d-9663-d8692716ec37`:

1. Open Admin and confirm `SOURCE_ARTIFACT_VERSION_INVALID` is absent.
2. Confirm the Field “发起电子签” action is enabled by readiness, regardless of notification status.
3. Observe the existing `NOTIFY_FIELD_ESIGN_READY` task reach `COMPLETED` or present an authorized recovery action; do not edit it directly.
4. Ask the user to confirm one `SMS_510815118` was received. Do not send `SMS_511185078` for this historical assignment.
5. Open the existing public-account `/field/handover` entry, sign in with the assigned phone, and confirm only authorized tasks are visible.
6. After the user naturally initiates Stage 2 eSign, ask the customer to confirm one `SMS_510795093` and verify the Portal pending-sign entry.
7. Confirm Admin/Field/Portal agree on the same workflow progress and the order workspace no longer shows an undifferentiated blocked state.

- [ ] **Step 9: Exercise the new assignment template on a natural assignment only**

On the next approved external Field assignment, confirm exactly one durable assignment job is created and exactly one `SMS_511185078` arrives with `name` equal to that work order’s full authoritative plate. Reassignment must notify only the current recipient; a superseded queued job must complete without contacting the former recipient.

- [ ] **Step 10: Record acceptance evidence and rollback readiness**

Append a Wave 1 results section to `docs/acceptance/2026-08-01-stage2-handover-acceptance-issues.md` containing the PR, merge SHA, image tags/digests, migration name, test commands, safe job outcomes, and user-confirmed SMS results. Do not include phone numbers or provider payloads. Commit and publish this evidence through the normal PR path if the branch has already merged.

If rollback is needed: disable the worker first, restore the backed-up env/image values, recreate API/Web, and retain the additive enum values plus every workflow/SMS row. After the cause is fixed, use dry-run and authorized dead-letter recovery; never use queue deletion or direct SQL status changes.

---

## Requirements Traceability

- `STG2-001` Admin next action: Task 5, verified again in Task 8 Step 8.
- `STG2-002` assignment notification: Tasks 2–4, configured in Task 7, live-tested only on a natural assignment in Task 8 Step 9.
- `STG2-003` `/field/handover`: no code/menu mutation; read-only verification in Task 8 Step 8.
- `STG2-006` v2 readiness and eSign unblock: Tasks 1 and 6, current-order recovery in Task 8 Step 8.
- `SMS_511185078` `{ name: plateNo }`: Tasks 2–4 and Task 8 Step 9.
- `SMS_510815118` `{}`: Tasks 2 and 4; current existing job recovery in Task 8 Step 8.
- `SMS_510795093` `{}`: Tasks 2 and 4; natural post-eSign verification in Task 8 Step 8.
- Notification/eSign decoupling: Tasks 4 and 6.
- Additive migration, worker-off rollout, dry-run, rollback: Tasks 2, 7, and 8.
- Wave 2/3 exclusions: Global Constraints and Task 8 scope inspection.
