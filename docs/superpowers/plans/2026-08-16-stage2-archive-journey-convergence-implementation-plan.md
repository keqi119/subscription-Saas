# Stage 2 Archive Journey Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage 2 签署文件完成权威归档后，幂等推进交接工单和 Subscription Journey 到交付证据人工复核，并自动补偿既有已归档但未推进的记录。

**Architecture:** 在 `HandoverWorkOrderService` 增加唯一的归档收敛入口：锁定工单与 handover、验证完整归档事实、重新计算证据 manifest、推进运营复核并写入既有 Journey outbox。正常 archive worker 与后台归档重试均即时调用该入口；Stage 2 worker 每轮先执行固定上限的小批量补偿，全部复用同一入口，不直接改 Journey 或业务表状态。

**Tech Stack:** NestJS 11、TypeScript 6、Prisma 7、PostgreSQL、Vitest 4、pnpm workspace。

## Global Constraints

- 仅处理 Stage 2 归档后 Journey 收敛，不改还车、Stage 1、支付或法大大协议字段。
- 不重签或替换已经归档的 PDF，不修改旧归档哈希；旧平台印章仅作验收备注。
- 不跳过 `DELIVERY_EVIDENCE_DECISION` 人工复核，不直接用 SQL 推进业务状态。
- 不新增数据库表、枚举或迁移。
- manifest 只能根据服务端当前证据重新计算，不能信任客户端或旧 metadata 传入的 hash。
- 所有新增行为按 TDD 实施；每个生产代码增量之前必须先看到对应测试以预期原因失败。
- 保留根工作区中用户已有的 `Dockerfile.api`、`Dockerfile.web` 和未跟踪目录，不在本分支触碰。
- 用户已指定 Inline Execution，不使用子代理。

---

## File Structure

- `apps/api/src/handover-work-order/handover-work-order.service.ts`：归档事实校验、单条幂等收敛、严格候选扫描与小批量补偿的唯一领域入口。
- `apps/api/src/handover-work-order/stage2-handover-workflow.service.ts`：archive worker 成功后的即时收敛，并向 worker 暴露补偿委托。
- `apps/api/src/handover-work-order/stage2-handover-esign.service.ts`：后台 archive retry 成功后的即时收敛。
- `apps/api/src/handover-work-order/stage2-handover-workflow.types.ts`：Stage 2 handler 的可选补偿接口。
- `apps/api/src/handover-work-order/stage2-handover-workflow.worker.ts`：每轮领取任务前调用固定上限补偿，不复制领域逻辑。
- `apps/api/test/handover-work-order.spec.ts`：单条收敛、归档门禁、幂等和候选过滤回归测试。
- `apps/api/test/stage2-handover-esign-archive.spec.ts`：两个归档成功入口都即时收敛的回归测试。
- `apps/api/test/stage2-handover-workflow.worker.spec.ts`：worker 每轮有界补偿且补偿失败隔离的回归测试。
- `apps/api/test/subscription-journey-handover.spec.ts`：复跑既有精确信号、第三个人工任务绑定和人工决定测试，不新增第二套 Journey 逻辑。

---

### Task 1: Implement the authoritative archive convergence entry

**Files:**
- Modify: `apps/api/test/handover-work-order.spec.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`

**Interfaces:**
- Consumes: `buildCurrentEvidencePackage(workOrder, undefined, tx)`、`DeliveryEvidenceService.recordJourneyEvidenceReady(tx, input)`、`updateWorkOrderVersioned`、`recordEvent`。
- Produces:

```ts
export interface ArchivedStage2EvidenceReconciliationResult {
  manifestHash: string;
  outcome: "ALREADY_READY" | "SIGNALLED";
  workOrderId: string;
}

reconcileArchivedStage2JourneyEvidence(
  workOrderId: string
): Promise<ArchivedStage2EvidenceReconciliationResult>

reconcileArchivedStage2JourneyEvidenceBatch(
  limit?: number
): Promise<{ failed: number; processed: number; scanned: number }>
```

- [ ] **Step 1: Write the failing single-record convergence tests**

在 `handover-work-order.spec.ts` 的运营复核用例附近新增四个独立测试：

```ts
it("converges a customer-confirmed work order only after a complete authoritative Stage 2 archive", async () => {
  const harness = createConfirmedWorkOrderHarness();
  harness.setCompleteArchivedHandover();

  const result = await harness.service.reconcileArchivedStage2JourneyEvidence(
    "work-order-1"
  );

  expect(result).toEqual({
    manifestHash: expect.any(String),
    outcome: "SIGNALLED",
    workOrderId: "work-order-1"
  });
  expect(harness.state.workOrders[0]).toMatchObject({
    opsReviewStatus: "PENDING",
    status: "OPS_REVIEW_PENDING"
  });
  expect(harness.evidenceService.recordJourneyEvidenceReady).toHaveBeenCalledWith(
    harness.prisma,
    expect.objectContaining({
      handoverId: "handover-1",
      orderId: harness.orderId,
      workOrderId: "work-order-1"
    })
  );
});

it.each([
  ["signedDocumentFileId", null],
  ["signedObjectKey", null],
  ["signedPdfHash", null],
  ["archivedAt", null]
])("rejects archive convergence when %s is missing", async (field, value) => {
  const harness = createConfirmedWorkOrderHarness();
  harness.setCompleteArchivedHandover();
  Object.assign(harness.state.handover, { [field]: value });

  await expect(
    harness.service.reconcileArchivedStage2JourneyEvidence("work-order-1")
  ).rejects.toThrow("STAGE2_HANDOVER_ARCHIVE_INCOMPLETE");
  expect(harness.evidenceService.recordJourneyEvidenceReady).not.toHaveBeenCalled();
});

it.each(["CUSTOMER_OBJECTED", "VOIDED", "FAILED", "CANCELLED"])(
  "rejects archived convergence from %s",
  async (status) => {
    const harness = createConfirmedWorkOrderHarness();
    harness.setCompleteArchivedHandover();
    Object.assign(harness.state.workOrders[0], { status });

    await expect(
      harness.service.reconcileArchivedStage2JourneyEvidence("work-order-1")
    ).rejects.toThrow(BadRequestException);
  }
);

it("replays the stable readiness signal without downgrading an ops-review work order", async () => {
  const harness = createConfirmedWorkOrderHarness();
  harness.setCompleteArchivedHandover();

  const first = await harness.service.reconcileArchivedStage2JourneyEvidence("work-order-1");
  const second = await harness.service.reconcileArchivedStage2JourneyEvidence("work-order-1");

  expect(first.outcome).toBe("SIGNALLED");
  expect(second).toEqual({ ...first, outcome: "ALREADY_READY" });
  expect(harness.eventsOfType("OPS_REVIEW_UPDATED")).toHaveLength(1);
  expect(harness.evidenceService.recordJourneyEvidenceReady).toHaveBeenNthCalledWith(
    2,
    harness.prisma,
    expect.objectContaining({ manifestHash: first.manifestHash })
  );
});
```

测试 harness 的 `setCompleteArchivedHandover()` 必须创建 `status=ARCHIVED`、`archiveStatus=ARCHIVED`、`archivedAt`、`signedDocumentFileId`、`signedObjectKey`、64 位 `signedPdfHash`，并保持 `orderId`/`handoverId` 与工单一致。

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/handover-work-order.spec.ts
```

Expected: FAIL，原因必须是 `reconcileArchivedStage2JourneyEvidence is not a function`；若因 harness 字段错误失败，先修正测试夹具，直到失败明确指向缺失的生产接口。

- [ ] **Step 3: Implement the minimal transactional convergence method**

在 `HandoverWorkOrderService` 中：

1. 使用现有 `runSerializableTransaction`；事务内先以 `FOR UPDATE OF w, h` 锁定 `vehicle_handover_work_order` 与关联 `vehicle_delivery_handover`。
2. 重新读取工单与 handover，要求 ID、订单和绑定完全一致。
3. 用 `hasCompleteStage2HandoverArchive(handover)` 以及 `status/archiveStatus/archivedAt/signedDocumentFileId/signedObjectKey/signedPdfHash` 做完整门禁；不完整时抛出 `ConflictException("STAGE2_HANDOVER_ARCHIVE_INCOMPLETE")`。
4. 允许从 `CUSTOMER_CONFIRMED`、`SIGNING`、`CUSTOMER_SIGNED`、`PLATFORM_SEALED`、`FIELD_COMPLETED`、`OPS_REVIEW_PENDING`、`OPS_REVIEWED` 收敛；拒绝异议和终态。
5. 重新计算 `evidencePackage`。仅当当前不是 `OPS_REVIEW_PENDING/OPS_REVIEWED` 时更新：

```ts
const updated = await this.updateWorkOrderVersioned(workOrder, {
  fieldCompletedAt: workOrder.fieldCompletedAt ?? handover.completedAt ?? handover.archivedAt,
  metadata: mergeMetadata(workOrder.metadata, {
    journeyEvidenceManifestHash: evidencePackage.manifestHash,
    opsReviewRequestedBy: null,
    opsReviewSource: "STAGE2_AUTHORITATIVE_ARCHIVE"
  }),
  opsReviewStatus: "PENDING",
  status: "OPS_REVIEW_PENDING"
}, tx);
```

6. 状态发生变化时只记录一次 `OPS_REVIEW_UPDATED`，actor 为 `SYSTEM`，detail 至少包含 `manifestHash`、`status: "PENDING"`、`source: "STAGE2_AUTHORITATIVE_ARCHIVE"`。
7. 无论首次或重放，都调用 `recordJourneyEvidenceReady`；既有稳定事件键负责 outbox 幂等。
8. 若工单已为 `OPS_REVIEWED`，不得改回 `OPS_REVIEW_PENDING`，只用 metadata 中相同 manifest 做安全重放；manifest 不一致时抛出 `ConflictException("JOURNEY_EVIDENCE_MANIFEST_STALE")`。

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/handover-work-order.spec.ts
```

Expected: PASS，且既有 `markOpsReviewPending` 测试仍证明普通 Admin 接口不能从 `CUSTOMER_CONFIRMED` 提前发起运营复核。

- [ ] **Step 5: Commit the domain convergence slice**

```powershell
git add apps/api/src/handover-work-order/handover-work-order.service.ts apps/api/test/handover-work-order.spec.ts
git commit -m "fix: converge archived handover evidence"
```

---

### Task 2: Trigger convergence from both successful archive paths

**Files:**
- Modify: `apps/api/test/stage2-handover-esign-archive.spec.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-workflow.service.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-esign.service.ts`

**Interfaces:**
- Consumes: `HandoverWorkOrderService.reconcileArchivedStage2JourneyEvidence(workOrderId)` from Task 1.
- Produces: every successful automatic or Admin archive path calls the same convergence entry before reporting completion.

- [ ] **Step 1: Write failing archive-hook tests**

扩展 `stage2-handover-esign-archive.spec.ts`：

```ts
it("converges Journey evidence before completing an archived workflow job", async () => {
  const harness = createArchiveWorkflowHarness();

  await harness.service.handle(archiveWorkflowJob());

  expect(harness.workOrder.reconcileArchivedStage2JourneyEvidence)
    .toHaveBeenCalledWith("work-order-1");
  expect(harness.repository.complete).not.toHaveBeenCalled();
});

it("converges Journey evidence after an Admin archive retry succeeds", async () => {
  const harness = createHarness();

  await harness.service.retryArchive("work-order-1", "admin-1");

  expect(harness.workOrder.reconcileArchivedStage2JourneyEvidence)
    .toHaveBeenCalledWith("work-order-1");
});
```

同时增加一个 archive core 返回 `PENDING` 的用例，断言两个路径均不调用收敛入口。

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/stage2-handover-esign-archive.spec.ts
```

Expected: FAIL，调用次数为 0，证明当前归档成功没有推进 Journey。

- [ ] **Step 3: Add the two minimal archive hooks**

- 在 `Stage2HandoverWorkflowService` 的 `ARCHIVE_SIGNED_PDF` 分支中，仅当 `result.archiveStatus === ARCHIVED` 时先执行：

```ts
await this.handoverWorkOrderService.reconcileArchivedStage2JourneyEvidence(
  job.workOrderId
);
```

- 在 `Stage2HandoverESignService` 构造器末尾可选注入 `HandoverWorkOrderService`，`retryArchive` 保存 core 返回值；仅当结果为 `ARCHIVED` 时调用同一方法。依赖缺失时抛出安全的 `STAGE2_HANDOVER_ARCHIVE_CONVERGENCE_UNAVAILABLE`，不能向 Admin 返回虚假成功。
- 归档 core 已经成功时，收敛失败不得删除或回滚归档文件；异常交给现有 worker 重试或 Admin 重试路径处理。

- [ ] **Step 4: Run archive and adjacent Stage 2 tests**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/stage2-handover-esign-archive.spec.ts test/fadada-archive.spec.ts test/stage2-handover-workflow.worker.spec.ts
```

Expected: PASS；归档 core 仍保持文件/哈希幂等，两个外层入口负责业务收敛。

- [ ] **Step 5: Commit the archive-hook slice**

```powershell
git add apps/api/src/handover-work-order/stage2-handover-workflow.service.ts apps/api/src/handover-work-order/stage2-handover-esign.service.ts apps/api/test/stage2-handover-esign-archive.spec.ts
git commit -m "fix: trigger journey convergence after archive"
```

---

### Task 3: Add bounded crash-gap and historical compensation

**Files:**
- Modify: `apps/api/test/handover-work-order.spec.ts`
- Modify: `apps/api/test/stage2-handover-workflow.worker.spec.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-workflow.types.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-workflow.service.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-workflow.worker.ts`

**Interfaces:**
- Consumes: Task 1 single-record convergence method.
- Produces:

```ts
interface Stage2HandoverWorkflowHandler {
  reconcileArchivedStage2Evidence?(
    limit: number
  ): Promise<{ failed: number; processed: number; scanned: number }>;
}
```

- [ ] **Step 1: Write failing strict-candidate and batch-isolation tests**

在 `handover-work-order.spec.ts` 添加：

```ts
it("scans only complete archived handovers stranded at the Stage 2 Journey step", async () => {
  const harness = createArchivedReconciliationBatchHarness();

  const result = await harness.service.reconcileArchivedStage2JourneyEvidenceBatch(10);

  expect(harness.prisma.vehicleHandoverWorkOrder.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      select: { id: true },
      take: 10,
      where: expect.objectContaining({
        handoverType: "DELIVERY_OUTBOUND",
        status: { in: expect.arrayContaining(["CUSTOMER_CONFIRMED", "OPS_REVIEW_PENDING"]) }
      })
    })
  );
  expect(result).toEqual({ failed: 0, processed: 1, scanned: 1 });
});

it("continues bounded reconciliation after one candidate fails", async () => {
  const harness = createArchivedReconciliationBatchHarness(["bad-id", "good-id"]);
  vi.spyOn(harness.service, "reconcileArchivedStage2JourneyEvidence")
    .mockRejectedValueOnce(new Error("bad archive"))
    .mockResolvedValueOnce({
      manifestHash: "a".repeat(64),
      outcome: "SIGNALLED",
      workOrderId: "good-id"
    });

  await expect(
    harness.service.reconcileArchivedStage2JourneyEvidenceBatch(2)
  ).resolves.toEqual({ failed: 1, processed: 1, scanned: 2 });
});
```

候选 `where` 必须同时表达：完整 `ARCHIVED/ARCHIVED` handover、所有归档字段非空、未完成 Journey 的 `currentStepCode=HANDOVER_AND_STAGE2_CREATION`、工单非异议/终态，以及 outbound handover。

- [ ] **Step 2: Write the failing worker invocation test**

在 `stage2-handover-workflow.worker.spec.ts` 添加：

```ts
it("runs a ten-record archive convergence batch before claiming due jobs", async () => {
  const order: string[] = [];
  const handler: Stage2HandoverWorkflowHandler = {
    handle: vi.fn(async () => ({ kind: "COMPLETED" })),
    reconcileArchivedStage2Evidence: vi.fn(async (limit) => {
      order.push(`reconcile:${limit}`);
      return { failed: 0, processed: 0, scanned: 0 };
    }),
    supportedJobTypes: [VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF]
  };
  const harness = createWorkerHarness({ handler });
  harness.repository.claimDue.mockImplementation(async () => {
    order.push("claim");
    return [];
  });

  await harness.worker.runOnce();

  expect(order).toEqual(["reconcile:10", "claim"]);
});
```

- [ ] **Step 3: Run both focused tests and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/handover-work-order.spec.ts test/stage2-handover-workflow.worker.spec.ts
```

Expected: FAIL，分别指向缺少 batch 方法和 worker 未调用补偿接口。

- [ ] **Step 4: Implement strict bounded candidate selection and per-item isolation**

`reconcileArchivedStage2JourneyEvidenceBatch(limit = 10)`：

- 将 limit 约束为 `1..10` 的安全整数；
- 使用 Prisma `findMany`，`take` 等于安全 limit，`orderBy: [{ updatedAt: "asc" }, { id: "asc" }]`；
- `where` 严格限定完整归档 handover、outbound 工单、未完成且仍在 `HANDOVER_AND_STAGE2_CREATION` 的 Journey；
- 逐条调用单记录方法；单条失败仅记录 `{ operation, workOrderId }` 和通用错误码，不记录对象键、文件名或提供商数据；
- 返回 `scanned/processed/failed` 计数，绝不编写第二套状态更新。

- [ ] **Step 5: Wire the bounded batch into the existing worker**

- `Stage2HandoverWorkflowService.reconcileArchivedStage2Evidence(limit)` 只委托 `handoverWorkOrderService.reconcileArchivedStage2JourneyEvidenceBatch(limit)`。
- `Stage2HandoverWorkflowWorker.runOnce()` 在 `claimDue` 前执行可选 handler 方法，固定传入 `10`。
- 单条失败已由 batch 隔离；若候选查询整体失败，`runOnce` 失败并由现有 poll 外层记录通用 `WORKFLOW_ERROR`，本轮不领取新任务，避免在数据库不可用时继续部分执行。

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/handover-work-order.spec.ts test/stage2-handover-workflow.worker.spec.ts test/stage2-handover-esign-archive.spec.ts test/subscription-journey-handover.spec.ts test/delivery-evidence.spec.ts
```

Expected: PASS；第三个人工任务仍由既有 Journey outbox 逻辑创建且绑定精确 `workOrderId/manifestHash`。

- [ ] **Step 7: Commit the bounded compensation slice**

```powershell
git add apps/api/src/handover-work-order/handover-work-order.service.ts apps/api/src/handover-work-order/stage2-handover-workflow.types.ts apps/api/src/handover-work-order/stage2-handover-workflow.service.ts apps/api/src/handover-work-order/stage2-handover-workflow.worker.ts apps/api/test/handover-work-order.spec.ts apps/api/test/stage2-handover-workflow.worker.spec.ts
git commit -m "fix: recover stranded archived handovers"
```

---

### Task 4: Verify the complete Golden Path boundary and prepare integration

**Files:**
- Modify only if test-driven corrections are required by failures in files already listed above.
- Verify: `docs/superpowers/specs/2026-08-16-stage2-archive-journey-convergence-design.md`
- Verify: `docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a clean, reviewed branch ready for PR; no deployment or database mutation in this task.

- [ ] **Step 1: Run the complete Stage 2 and Journey regression set**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/handover-work-order.spec.ts test/delivery-evidence.spec.ts test/fadada-archive.spec.ts test/stage2-handover-esign-archive.spec.ts test/stage2-handover-workflow.worker.spec.ts test/stage2-handover-workflow-recovery.spec.ts test/stage2-handover-provider-reconciliation.spec.ts test/subscription-journey-handover.spec.ts test/subscription-journey-golden-path.e2e-spec.ts
```

Expected: all selected files PASS, zero unhandled rejection and zero snapshot drift.

- [ ] **Step 2: Run API static checks**

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api build
```

Expected: all commands exit 0.

- [ ] **Step 3: Run the full API suite**

```powershell
pnpm --filter @subscription-saas/api test
```

Expected: all API tests PASS. If a baseline test fails, reproduce it on `origin/main` before changing this branch; only fix failures caused by this change.

- [ ] **Step 4: Reconfirm schema and migration boundaries**

```powershell
pnpm prisma:migrate:status
git diff --name-only origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: database schema is up to date; no file under `apps/api/prisma/migrations/` or `apps/api/prisma/schema.prisma` changed; diff check is clean.

- [ ] **Step 5: Review state-machine safety before integration**

确认：

- Admin 原 `markOpsReviewPending` 仍不能从未归档 `CUSTOMER_CONFIRMED` 提前推进；
- 只有完整权威归档才允许系统收敛；
- `OPS_REVIEWED` 不会回退；
- 同 manifest 的 outbox event key 稳定；
- 不创建 PaymentMandate 或 DebitAttempt；
- 不修改或重签旧 Stage 2 PDF；
- 当前订单会由 worker 补偿，而不是人工 SQL。

- [ ] **Step 6: Commit any verification-only corrections**

仅当步骤 1–5 发现由本分支引入的问题并以新失败测试重现后，提交修正：

```powershell
git add apps/api/src/handover-work-order apps/api/test/handover-work-order.spec.ts apps/api/test/stage2-handover-esign-archive.spec.ts apps/api/test/stage2-handover-workflow.worker.spec.ts
git commit -m "test: harden stage2 archive convergence"
```

- [ ] **Step 7: Record the Staging acceptance handoff**

PR 合并并由用户部署新 API 镜像后，按以下顺序验收：

1. 等待 Stage 2 worker 对 `ORD20260814085019DMGZ` 执行补偿；
2. Admin Golden Path 出现“交付证据复核 · 等待人工”；
3. 核对 manifest 后点击“通过证据”；
4. 确认 Journey=`COMPLETED`、Order=`ACTIVE`、Delivery=`DELIVERED`、Vehicle=`LEASED`、Lease=`ACTIVE`、BillingSchedule 已激活；
5. 确认三类 ManualTask 各一条，且没有新增 PaymentMandate 或 DebitAttempt。
