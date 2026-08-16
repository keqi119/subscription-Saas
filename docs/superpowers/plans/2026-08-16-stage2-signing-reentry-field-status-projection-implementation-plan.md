# Stage 2 签署重进与 Field 状态投影 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复客户对同一法大大 Stage 2 签署事务的安全重新进入能力，并让 Field 列表按交接单、电子签和归档事实展示及分组。

**Architecture:** 保留现有资料工单、交接单和电子签状态机，不回填历史状态。API 在法大大适配器中精确识别生产环境的“9999/待签署”，在签署人 `snapshot.portalSigningEntry` 中维护无迁移的 60 秒入口冷却元数据，并由 Field 服务端聚合权威状态为安全展示投影；Portal 和 Field Web 只消费服务端结果。

**Tech Stack:** NestJS 11、Prisma 7/PostgreSQL、Vitest、Next.js 16/React 19、Ant Design 6、TypeScript 6。

**执行状态：** 已完成（2026-08-16）。本轮无需数据库迁移。

## Global Constraints

- 不新增 Prisma migration，不改写历史 `VehicleHandoverWorkOrder.status`。
- 不复用 `ContractESignSigner.lastAttemptAt` 记录 Portal 入口；该字段继续专用于供应商创建和恢复尝试。
- 签署入口冷却固定为 60 秒，首次“去签署”不受限制，刷新、换浏览器和并发请求均不可绕过。
- 只有供应商入口成功生成后才写入 `lastIssuedAt`；请求失败必须释放入口生成权。
- 不持久化签署 URL，不向 Portal/Field 返回供应商响应、账号、事务内部数据、对象存储键或敏感身份字段。
- 完成口径为 Stage 2 已签 PDF 归档完成，不等待 Admin 最终交付确认。
- 保留并验证现有客户回调、状态同步、平台盖章和归档恢复流程。
- 执行前在隔离 worktree 内运行并记录：`git status --short`、`pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma`、`pnpm prisma:validate`；任一迁移检查失败即停止编码。
- 对应批准设计：`docs/superpowers/specs/2026-08-16-stage2-signing-reentry-field-status-projection-design.zh-CN.md`。

---

## File Map

- Create `apps/api/src/handover-work-order/stage2-portal-signing-entry.ts`: 解析、生成和清理 `snapshot.portalSigningEntry`，计算 60 秒冷却窗口。
- Create `apps/api/src/handover-work-order/field-handover-workflow-projection.ts`: 纯函数聚合工单、交接单、电子签、签署人和归档状态。
- Modify `apps/api/src/esign/fadada/fadada-esign.provider.ts`: 精确映射生产环境“9999/待签署”，保留绑定冲突的关闭式失败。
- Modify `apps/api/src/handover-work-order/stage2-handover-esign.service.ts`: 服务端冷却、并发生成权、Portal 安全 DTO 和稳定错误码。
- Modify `apps/api/src/handover-work-order/handover-work-order.service.ts`: 为 Field 列表加载 Stage 2 权威事实并返回展示投影、完成分组和聚合排序。
- Modify `apps/api/test/stage2-esign-provider-mapping.spec.ts`: 法大大生产响应和冲突回显回归测试。
- Modify `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`: 首次进入、冷却、并发、失败释放、已签对账测试。
- Modify `apps/api/test/handover-work-order.spec.ts`: Field 状态映射、历史归档记录、页签分组和排序测试。
- Modify `apps/web/src/lib/portal-handover-review-api.ts`: 增加安全的重新进入时间字段和冷却错误详情类型。
- Modify `apps/web/src/lib/portal-handover-review-view-model.ts`: 区分“去签署/继续签署”并计算倒计时显示。
- Modify `apps/web/src/app/portal/handover-reviews/[id]/page.tsx`: 显示可见但禁用的倒计时按钮，结束后自动恢复。
- Modify `apps/web/src/lib/field-handover-api.ts`: 接收服务端 `displayStatus`、标签、分组和完成时间。
- Modify `apps/web/src/lib/field-handover-view-model.ts`: 删除客户端状态推断，只渲染服务端投影。
- Modify `apps/web/test/portal-handover-review-api.spec.ts`: API 类型和冷却错误解析契约测试。
- Modify `apps/web/test/portal-handover-review-view-model.spec.ts`: 按钮文案和倒计时纯函数测试。
- Modify `apps/web/test/portal-handover-review-pages.spec.ts`: 页面按钮可见性、禁用态和倒计时恢复测试。
- Modify `apps/web/test/field-handover-view-model.spec.ts`: Field 卡片严格使用服务端投影测试。
- Modify `apps/web/test/field-handover-pages.spec.ts`: Active/Ended 页签归类和展示回归测试。

---

### Task 1: 精确识别法大大待签署生产响应

**Files:**
- Modify: `apps/api/src/esign/fadada/fadada-esign.provider.ts`
- Test: `apps/api/test/stage2-esign-provider-mapping.spec.ts`

**Interfaces:**
- Consumes: `querySignResult()` 的 `resultCode`、`resultDesc` 和可选回显身份字段。
- Produces: `querySignerStatus(): ESignProviderSignerStatusResult`，对精确 `9999 + 待签署` 返回 `status: "SIGNING"`。

- [x] **Step 1: 写入生产响应失败测试**

在 `stage2-esign-provider-mapping.spec.ts` 增加 Stage 2 客户签署查询用例，模拟：

```ts
{
  resultCode: "9999",
  resultDesc: "待签署",
  status: "UNKNOWN",
  providerContractId: undefined,
  providerCustomerId: undefined,
  providerTransactionId: undefined
}
```

断言本地 task/signer/客户绑定完全匹配时结果为：

```ts
expect(result).toMatchObject({
  resultCode: "9999",
  resultDescription: "待签署",
  status: "SIGNING"
});
```

同时用表格测试证明 `9999 + 其他描述`、`其他代码 + 待签署`、以及任一已回显但与请求冲突的合同/客户/事务编号仍返回 `UNKNOWN`。

- [x] **Step 2: 运行测试确认当前失败**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/stage2-esign-provider-mapping.spec.ts`

Expected: 新增的精确生产响应测试 FAIL，冲突回显测试保持关闭式行为。

- [x] **Step 3: 实现精确待签映射**

在 provider 内增加仅供本文件使用的判断：

```ts
function isExplicitFadadaPendingSignature(result: {
  resultCode?: string;
  resultDesc?: string;
}) {
  return result.resultCode === "9999" && result.resultDesc?.trim() === "待签署";
}
```

身份规则按以下顺序执行：

1. 先完成既有本地 task、slot、customer、transaction 强绑定校验；
2. 对响应中实际存在的回显字段逐一校验，任一冲突返回 `UNKNOWN`；
3. 回显字段全部缺失时，不伪造字段，允许精确 `9999/待签署` 映射为 `SIGNING`；
4. 其他 `UNKNOWN` 保持关闭式失败。

- [x] **Step 4: 运行映射测试**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/stage2-esign-provider-mapping.spec.ts`

Expected: PASS。

- [x] **Step 5: 提交供应商映射**

```powershell
git add apps/api/src/esign/fadada/fadada-esign.provider.ts apps/api/test/stage2-esign-provider-mapping.spec.ts
git commit -m "fix(esign): map fadada pending signature response"
```

---

### Task 2: 为 Portal 入口增加无迁移的 60 秒服务端冷却

**Files:**
- Create: `apps/api/src/handover-work-order/stage2-portal-signing-entry.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-esign.service.ts`
- Test: `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`

**Interfaces:**
- Consumes: `ContractESignSigner.snapshot`, `updatedAt`,现有 `loadDatabaseNow()` 和 provider `getSignerUrl()`。
- Produces: `reentryAvailableAt: Date | null`、`reentryRemainingSeconds: number`，以及稳定错误 `STAGE2_PORTAL_SIGNING_REENTRY_COOLDOWN`。

- [x] **Step 1: 写纯元数据失败测试和生命周期失败测试**

新增以下测试：

```ts
expect(readPortalSigningEntry(snapshot)).toEqual({
  claimToken: null,
  claimUntil: null,
  lastIssuedAt: null
});
```

以及服务用例：首次调用成功；成功后数据库时间 59 秒再次调用返回：

```ts
{
  code: "STAGE2_PORTAL_SIGNING_REENTRY_COOLDOWN",
  reentryAvailableAt: "2026-07-26T08:01:00.000Z",
  reentryRemainingSeconds: 1
}
```

数据库时间到 60 秒可再次生成；两个并发调用只有一个触发 `getSignerUrl()`；provider 失败后清除 claim 且下一次可立即重试；`alreadySigned` 对账不受冷却阻断。

- [x] **Step 2: 运行生命周期测试确认失败**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/stage2-handover-esign-lifecycle.spec.ts`

Expected: 新增冷却和并发测试 FAIL。

- [x] **Step 3: 实现独立 snapshot 命名空间纯函数**

创建 `stage2-portal-signing-entry.ts`，导出：

```ts
export const STAGE2_PORTAL_SIGNING_REENTRY_COOLDOWN_MS = 60_000;

export interface PortalSigningEntryMetadata {
  claimToken: string | null;
  claimUntil: Date | null;
  lastIssuedAt: Date | null;
}

export function readPortalSigningEntry(snapshot: Prisma.JsonValue | null): PortalSigningEntryMetadata;
export function withPortalSigningEntryClaim(
  snapshot: Prisma.JsonValue | null,
  input: { claimToken: string; claimUntil: Date }
): Prisma.InputJsonValue;
export function withPortalSigningEntryIssued(
  snapshot: Prisma.JsonValue | null,
  input: { claimToken: string; lastIssuedAt: Date }
): Prisma.InputJsonValue;
export function withoutPortalSigningEntryClaim(
  snapshot: Prisma.JsonValue | null,
  claimToken: string
): Prisma.InputJsonValue;
export function getPortalSigningReentryAvailability(
  snapshot: Prisma.JsonValue | null,
  databaseNow: Date
): { availableAt: Date | null; remainingSeconds: number };
```

所有无效日期、未知 JSON 字段和非对象 snapshot 均安全归一化；写入时保留同级已有 snapshot 字段。

- [x] **Step 4: 在服务中以乐观并发取得入口生成权**

在 `startPortalSigning()` 中，完成 ownership/binding/readiness/provider status 校验后执行：

```ts
const databaseNow = await this.loadDatabaseNow(this.prisma);
const claimToken = randomUUID();
const claimUntil = new Date(
  databaseNow.getTime() + STAGE2_PORTAL_SIGNING_REENTRY_COOLDOWN_MS
);
```

读取 snapshot 并先检查 `lastIssuedAt + 60 秒` 与有效 `claimUntil`；使用 `id + taskId + slotId + signerStatus + updatedAt` 的 `updateMany` 乐观条件写入 claim。竞争失败后重新读取：若已有有效 claim 或冷却窗口则返回冷却错误；若只是无关更新且仍无 claim/冷却，则只重试一次 CAS；再次竞争失败返回 Portal-safe 暂不可用错误。不允许第二个 provider 调用。

provider 返回并通过 URL 白名单校验后，再取一次数据库时间，以 `snapshot.portalSigningEntry.claimToken` 精确匹配当前请求，原子写入 `lastIssuedAt`、清除 claim、更新 `signUrlExpiresAt` 和 `SIGNING`。不得更新 `lastAttemptAt`，不得保存 URL。

provider 调用或 URL 校验失败时，仅在 claimToken 匹配时移除本请求 claim；保留其他 snapshot 元数据，然后返回现有 Portal-safe 错误。

- [x] **Step 5: 扩展 Portal 状态 DTO 和错误**

在 `Stage2PortalESignView` 中增加：

```ts
capability: {
  canStartSigning: boolean;
  reentryAvailableAt: Date | null;
  reentryRemainingSeconds: number;
};
```

状态接口用数据库时间计算剩余秒数。冷却不移除业务签署能力，只通过时间字段让客户端禁用；POST 仍必须重复执行服务端检查。错误使用 `ConflictException`，响应体仅含稳定 code、英文安全 message、ISO 时间和整数秒数。

- [x] **Step 6: 运行 API 生命周期测试**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/stage2-handover-esign-lifecycle.spec.ts test/portal-handover-review.spec.ts`

Expected: PASS；现有 URL 不落库、白名单、安全错误和已签对账测试继续通过。

- [x] **Step 7: 提交服务端冷却**

```powershell
git add apps/api/src/handover-work-order/stage2-portal-signing-entry.ts apps/api/src/handover-work-order/stage2-handover-esign.service.ts apps/api/test/stage2-handover-esign-lifecycle.spec.ts
git commit -m "fix(handover): allow guarded stage2 signing reentry"
```

---

### Task 3: Portal 显示“继续签署”和 60 秒倒计时

**Files:**
- Modify: `apps/web/src/lib/portal-handover-review-api.ts`
- Modify: `apps/web/src/lib/portal-handover-review-view-model.ts`
- Modify: `apps/web/src/app/portal/handover-reviews/[id]/page.tsx`
- Test: `apps/web/test/portal-handover-review-api.spec.ts`
- Test: `apps/web/test/portal-handover-review-view-model.spec.ts`
- Test: `apps/web/test/portal-handover-review-pages.spec.ts`

**Interfaces:**
- Consumes: API `customerSigner.status`、`capability.canStartSigning`、`reentryAvailableAt`、`reentryRemainingSeconds`。
- Produces: `signingButtonText`、`signingButtonDisabled` 和倒计时自动恢复行为。

- [x] **Step 1: 写按钮状态失败测试**

覆盖：

```ts
PENDING + 无冷却 => "去签署" / enabled
SIGNING + 无冷却 => "继续签署" / enabled
SIGNING + 42 秒 => "请等待 42 秒后重新进入" / disabled
SIGNED => 无签署按钮
```

页面测试使用假定时器将 1 秒冷却推进到 0，断言按钮无需刷新自动恢复为“继续签署”。

- [x] **Step 2: 运行 Portal 测试确认失败**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/portal-handover-review-api.spec.ts test/portal-handover-review-view-model.spec.ts test/portal-handover-review-pages.spec.ts`

Expected: 新文案、禁用态和自动恢复测试 FAIL。

- [x] **Step 3: 扩展 API 类型和安全错误解析**

将 capability 类型更新为：

```ts
capability: {
  canStartSigning: boolean;
  reentryAvailableAt: string | null;
  reentryRemainingSeconds: number;
};
```

`getPortalHandoverESignErrorMessage()` 对冷却错误显示“请等待 X 秒后重新进入签署页面”，不得回显原始 provider message。

- [x] **Step 4: 在 view-model 统一计算按钮模型**

扩展 `PortalHandoverWorkflowView`：

```ts
signingButtonDisabled: boolean;
signingButtonText: string;
signingReentryAvailableAt: string | null;
```

纯函数接收当前时间或剩余秒数，保证组件不复制状态映射。

- [x] **Step 5: 页面实现倒计时**

组件保留按钮可见，以 1 秒定时器根据 `reentryAvailableAt` 更新本地剩余秒数；到 0 自动启用。请求发出时继续使用既有 `signingStartInFlight` 防抖；冷却错误后立即刷新 eSign 投影，使服务端时间重新成为权威值。

- [x] **Step 6: 运行 Portal 测试**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/portal-handover-review-api.spec.ts test/portal-handover-review-view-model.spec.ts test/portal-handover-review-pages.spec.ts`

Expected: PASS。

- [x] **Step 7: 提交 Portal 交互**

```powershell
git add apps/web/src/lib/portal-handover-review-api.ts apps/web/src/lib/portal-handover-review-view-model.ts 'apps/web/src/app/portal/handover-reviews/[id]/page.tsx' apps/web/test/portal-handover-review-api.spec.ts apps/web/test/portal-handover-review-view-model.spec.ts apps/web/test/portal-handover-review-pages.spec.ts
git commit -m "fix(portal): expose stage2 signing reentry countdown"
```

---

### Task 4: API 生成 Field Stage 2 聚合状态投影

**Files:**
- Create: `apps/api/src/handover-work-order/field-handover-workflow-projection.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Test: `apps/api/test/handover-work-order.spec.ts`

**Interfaces:**
- Consumes: raw work-order status、`VehicleDeliveryHandover.status/archiveStatus/archivedAt`、当前 Stage 2 task status、H1/H2 signer status。
- Produces: `displayStatus`、`displayStatusLabel`、`taskGroup`、`completedAt`，不暴露 provider 数据。

- [x] **Step 1: 写状态矩阵失败测试**

增加表格测试：

```ts
[
  ["CUSTOMER_CONFIRMED + no source", "HANDOVER_PDF_GENERATING", "ACTIVE"],
  ["SOURCE_GENERATED + no task", "ESIGN_INITIATION_PENDING", "ACTIVE"],
  ["PENDING_CUSTOMER_SIGNATURE", "CUSTOMER_SIGNATURE_PENDING", "ACTIVE"],
  ["PENDING_PLATFORM_SEAL", "PLATFORM_SEAL_PENDING", "ACTIVE"],
  ["SIGNED + archive pending", "ARCHIVE_PENDING", "ACTIVE"],
  ["archive failed", "ARCHIVE_FAILED", "ACTIVE"],
  ["ARCHIVED + archived artifact", "COMPLETED", "ENDED"],
  ["terminal failed/cancelled/voided", "FAILED/CANCELLED/VOIDED", "ENDED"],
  ["contradictory state", "INCONSISTENT", "ACTIVE"]
]
```

历史回归用例必须模拟 raw work order 仍为 `CUSTOMER_CONFIRMED`，但 handover/archive/task/signers 全部完成，断言返回 `已完成` 和 `ENDED`。

- [x] **Step 2: 运行 Field API 测试确认失败**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/handover-work-order.spec.ts`

Expected: 新投影测试 FAIL。

- [x] **Step 3: 实现纯状态投影函数**

创建：

```ts
export type FieldHandoverDisplayStatus =
  | "HANDOVER_PDF_GENERATING"
  | "ESIGN_INITIATION_PENDING"
  | "CUSTOMER_SIGNATURE_PENDING"
  | "PLATFORM_SEAL_PENDING"
  | "ARCHIVE_PENDING"
  | "ARCHIVE_FAILED"
  | "COMPLETED"
  | "CANCELLED"
  | "VOIDED"
  | "FAILED"
  | "INCONSISTENT"
  | "FIELD_WORK_PENDING"
  | "CUSTOMER_REVIEW_PENDING";

export function projectFieldHandoverWorkflow(
  input: FieldHandoverWorkflowFacts
): FieldHandoverWorkflowProjection;
```

使用明确优先级：终止事实 → 完整归档 → 归档失败 → 已签待归档 → 平台盖章 → 客户签署 → 待发起 → PDF 生成 → 原资料流程。任一不可成立的倒置组合返回 `INCONSISTENT/ACTIVE`，不猜测完成。

- [x] **Step 4: 服务读取权威事实并返回安全 DTO**

为列表投影查询交接单时不得沿用排除 `FAILED/CANCELLED` 的 PDF helper；使用只读 select 获取：

```ts
{
  archiveStatus: true,
  archivedAt: true,
  handoverESignTaskId: true,
  signedDocumentFileId: true,
  status: true,
  updatedAt: true
}
```

电子签只 select 当前权威 Stage 2 task 的 `taskStatus` 和 H1/H2 `slotId/signerStatus/signedAt`。`toFieldTaskListItem()` 合并投影，不返回 transactionId、provider response 或 signUrl。

先生成所有投影再排序：Active 按下一动作优先级和预约时间；Ended 按 `completedAt` 从近到远。详情复用同一投影，避免列表与详情标签分叉。

- [x] **Step 5: 运行 Field API 测试**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/handover-work-order.spec.ts test/stage2-field-esign-initiation.spec.ts`

Expected: PASS；原资料采集、权限和脱敏测试继续通过。

- [x] **Step 6: 提交服务端 Field 投影**

```powershell
git add apps/api/src/handover-work-order/field-handover-workflow-projection.ts apps/api/src/handover-work-order/handover-work-order.service.ts apps/api/test/handover-work-order.spec.ts
git commit -m "fix(field): project stage2 handover workflow status"
```

---

### Task 5: Field Web 严格消费服务端投影

**Files:**
- Modify: `apps/web/src/lib/field-handover-api.ts`
- Modify: `apps/web/src/lib/field-handover-view-model.ts`
- Modify: `apps/web/test/field-handover-view-model.spec.ts`
- Modify: `apps/web/test/field-handover-pages.spec.ts`

**Interfaces:**
- Consumes: Task 4 的 `displayStatus`、`displayStatusLabel`、`taskGroup`、`completedAt`。
- Produces: 正确卡片标签、颜色和 Active/Ended 页签，不再从 raw `status` 推断 Stage 2 结果。

- [x] **Step 1: 写客户端投影消费失败测试**

构造 raw `status: "CUSTOMER_CONFIRMED"` 同时服务端投影：

```ts
{
  displayStatus: "COMPLETED",
  displayStatusLabel: "已完成",
  taskGroup: "ENDED"
}
```

断言卡片显示“已完成”、绿色并进入已完成页签；另断言 `INCONSISTENT` 显示“状态异常，请联系运营”、红色并留在进行中页签。

- [x] **Step 2: 运行 Field Web 测试确认失败**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/field-handover-view-model.spec.ts test/field-handover-pages.spec.ts`

Expected: 新服务端投影消费测试 FAIL。

- [x] **Step 3: 扩展 Field API 类型**

```ts
displayStatus?: FieldHandoverDisplayStatus;
displayStatusLabel?: string;
completedAt?: string | null;
taskGroup: "ACTIVE" | "ENDED";
```

保留 raw `status` 仅供资料编辑权限兼容，不再用于卡片总流程标签和页签分组。

- [x] **Step 4: 修改卡片 view-model**

`buildFieldHandoverTaskCard()` 使用 `displayStatusLabel`、`displayStatus` 颜色映射和服务端 `taskGroup`。服务端投影缺失时只提供向后兼容的原资料状态显示，不在 Web 重建电子签组合规则。

- [x] **Step 5: 运行 Field Web 测试**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/field-handover-view-model.spec.ts test/field-handover-pages.spec.ts test/field-handover-api.spec.ts`

Expected: PASS。

- [x] **Step 6: 提交 Field Web**

```powershell
git add apps/web/src/lib/field-handover-api.ts apps/web/src/lib/field-handover-view-model.ts apps/web/test/field-handover-view-model.spec.ts apps/web/test/field-handover-pages.spec.ts
git commit -m "fix(field): render authoritative handover projection"
```

---

### Task 6: 全量验证、文档同步和交付准备

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-stage2-signing-reentry-field-status-projection-design.zh-CN.md`（仅在实现接口与批准设计产生必要的命名同步时）
- Modify: `docs/superpowers/plans/2026-08-16-stage2-signing-reentry-field-status-projection-implementation-plan.md`（勾选执行结果）

**Interfaces:**
- Consumes: Tasks 1–5 完成的 API/Web 行为。
- Produces: 可推送、可评审、无需迁移的修复分支。

- [x] **Step 1: 运行聚焦回归集**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/stage2-esign-provider-mapping.spec.ts test/stage2-handover-esign-lifecycle.spec.ts test/portal-handover-review.spec.ts test/handover-work-order.spec.ts test/stage2-field-esign-initiation.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/portal-handover-review-api.spec.ts test/portal-handover-review-view-model.spec.ts test/portal-handover-review-pages.spec.ts test/field-handover-view-model.spec.ts test/field-handover-pages.spec.ts test/field-handover-api.spec.ts
```

Expected: 全部 PASS。

- [x] **Step 2: 运行类型和构建验证**

```powershell
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api build
pnpm --filter @subscription-saas/web build
```

Expected: 全部 exit 0。

- [x] **Step 3: 运行 Prisma 和仓库质量检查**

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/web lint
git diff --check
git status --short
```

Expected: schema valid、数据库 schema up to date、lint 与 diff check 通过；状态中只包含本计划文件和批准范围内改动，不包含根工作区的 Dockerfile 或临时目录。

- [x] **Step 4: 检查无迁移与无敏感数据回归**

Run: `git diff --name-only origin/main...HEAD`

Expected: 不包含 `apps/api/prisma/migrations/`；搜索响应 DTO 和测试快照不得出现 `signUrl` 持久化、provider secret、完整身份证、完整手机号或对象存储键。

- [x] **Step 5: 提交文档执行记录**

```powershell
git add docs/superpowers/specs/2026-08-16-stage2-signing-reentry-field-status-projection-design.zh-CN.md docs/superpowers/plans/2026-08-16-stage2-signing-reentry-field-status-projection-implementation-plan.md
git commit -m "docs: record stage2 signing reentry implementation"
```

- [x] **Step 6: 本地验收口径复核**

确认以下证据均可由自动测试或本地 API/Web 展示证明：

1. 首次“去签署”成功；60 秒内按钮可见但禁用；第 60 秒自动恢复“继续签署”。
2. 第二次进入沿用同一 task/transaction，不创建新合同或新电子签任务。
3. 法大大精确 `9999/待签署` 可重进，其他 UNKNOWN 仍失败关闭。
4. raw 工单仍是 `CUSTOMER_CONFIRMED` 的已归档记录显示“已完成”并进入已完成页签。
5. 待发起、待客户签署、平台盖章、归档中、归档异常和不一致状态均显示正确。

## 执行验证记录

- 聚焦回归：API 274 项、Web 80 项，全部通过。
- 完整 Web 回归：88 个测试文件、785 项，全部通过。
- API 非数据库回归：235 个测试文件、2885 项通过；另有 1 个被 Vitest 错误归入 unit 项目的数据库测试因工作树未注入 `DATABASE_URL` 未运行。
- API 完整命令中的数据库集成套件因本地测试数据库凭据不可用而未运行；该环境限制与本轮代码无关。
- API/Web 类型检查、lint、生产构建均通过。
- Prisma schema 校验通过；本地数据库共 90 个迁移且状态为最新。
- 差异范围不含 Prisma migration、环境配置、Dockerfile 或签署 URL 持久化。
