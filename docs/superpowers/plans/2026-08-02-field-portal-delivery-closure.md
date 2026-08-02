# Field and Portal Delivery Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Field 交接页粘性操作栏遮挡，并让 Portal 从申请、合同、支付、交接签署到交付完成形成可访问、可回归的闭环。

**Architecture:** 保留现有订单、交接和电子签状态机，只修正边界投影与页面导航。API 负责把内部 BigInt、归档状态以及跨实体目标转换为安全的 Portal DTO；Web 只消费明确 DTO 并渲染单一下一步入口。已签 PDF 复用现有 Stage 2 归档文件读取能力，通过客户归属校验后的 Portal 流式路由暴露。

**Tech Stack:** NestJS、Prisma、Next.js App Router、React、Ant Design、Vitest、pnpm、PostgreSQL。

## Global Constraints

- 不新增数据库迁移，不修改订单、支付、交接或电子签状态流转规则。
- 金额继续使用内部分值语义；仅在 Portal DTO 边界把 BigInt 转为 Number。
- Portal 已签 PDF 路由必须校验当前客户归属，不暴露对象键、存储桶、供应商任务号或签署 URL。
- Field 提交按钮的显示、禁用、上传拦截与提交行为保持不变。
- API 与 Web 作为同一发布单元部署或回滚。
- 每项生产代码必须先有一个因缺失行为而失败的回归测试。

---

## File Map

- `apps/web/src/app/field/handover/tasks/[id]/page.tsx`：Field 详情页滚动留白和粘性提交栏视觉层叠。
- `apps/web/test/field-handover-pages.spec.ts`：Field 页面布局契约回归。
- `apps/api/src/portal/portal-billing.service.ts`：订单详情的押金摘要 DTO 边界。
- `apps/api/test/portal-order-billing.spec.ts`：无押金台账订单 JSON 序列化回归。
- `apps/api/src/handover-work-order/stage2-handover-esign.service.ts`：Portal Stage 2 终态投影。
- `apps/api/src/portal/portal-handover-review.service.ts`：客户归属校验与已签文件读取。
- `apps/api/src/portal/portal-handover-review.controller.ts`：客户侧已签 PDF 预览路由。
- `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`：完整归档终态无阻塞且返回预览目标。
- `apps/api/test/portal-handover-review.spec.ts`：已签 PDF 文件流、归属隔离与未归档拒绝。
- `apps/web/src/lib/portal-handover-review-api.ts`：Portal 电子签 DTO 与预览 URL 类型。
- `apps/web/src/lib/portal-handover-esign-view-model.ts`：终态 helper 防御性收敛。
- `apps/web/src/app/portal/handover-reviews/[id]/page.tsx`：已签 PDF 按钮。
- `apps/web/test/portal-handover-esign-view-model.spec.ts`：终态不显示阻塞的展示回归。
- `apps/web/test/portal-handover-review-pages.spec.ts`：详情页已签文件入口契约。
- `apps/api/src/portal/portal-application.service.ts`：申请进度的精确 `nextActionTarget` 投影。
- `apps/api/test/portal-application.spec.ts`：合同、支付、交接、交付完成目标回归。
- `apps/web/src/lib/portal-application-next-action-view-model.ts`：申请下一步卡片纯展示模型。
- `apps/web/src/lib/portal-types.ts`：`PortalNextActionTarget` 类型。
- `apps/web/src/app/portal/applications/[id]/page.tsx`：申请页持续引导卡片。
- `apps/web/test/portal-application-next-action-view-model.spec.ts`：引导卡片行为回归。

---

### Task 1: Field 粘性提交栏遮挡

**Files:**
- Modify: `apps/web/test/field-handover-pages.spec.ts`
- Modify: `apps/web/src/app/field/handover/tasks/[id]/page.tsx`

**Interfaces:**
- Consumes: 现有 `submitBarStyle` 和详情页根滚动容器。
- Produces: 不透明、明确高层级且带安全区留白的粘性操作栏。

- [ ] **Step 1: 写入失败回归测试**

在 Field 页面测试中增加布局契约：提交栏必须具有不透明背景、`zIndex`、上边界/阴影，页面底部必须预留大于操作栏高度的 `calc(... + env(safe-area-inset-bottom))` 空间。

```ts
it("keeps form controls below the opaque sticky submit bar", () => {
  const source = read(detailPagePath);
  expect(source).toContain('background: "#f5f8fc"');
  expect(source).toContain("zIndex: 20");
  expect(source).toContain('borderTop: "1px solid #d9e2ef"');
  expect(source).toContain("boxShadow:");
  expect(source).toContain("calc(104px + env(safe-area-inset-bottom))");
});
```

- [ ] **Step 2: 验证测试因旧半透明、无层级实现而失败**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/field-handover-pages.spec.ts`

Expected: 新用例在不透明背景、`zIndex` 和底部预留断言处失败。

- [ ] **Step 3: 写入最小布局修复**

将页面底部留白改为操作栏高度加安全区，并把 `submitBarStyle` 改为：

```ts
const submitBarStyle: CSSProperties = {
  background: "#f5f8fc",
  borderTop: "1px solid #d9e2ef",
  bottom: 0,
  boxShadow: "0 -8px 18px rgba(15, 23, 42, 0.08)",
  padding: "8px 0 max(8px, env(safe-area-inset-bottom))",
  position: "sticky",
  zIndex: 20
};
```

- [ ] **Step 4: 验证 Field 聚焦测试通过**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/field-handover-pages.spec.ts`

Expected: PASS。

- [ ] **Step 5: 提交 Task 1**

```bash
git add apps/web/src/app/field/handover/tasks/[id]/page.tsx apps/web/test/field-handover-pages.spec.ts
git commit -m "fix: isolate field handover sticky submit bar"
```

---

### Task 2: Portal 订单无押金台账 500

**Files:**
- Modify: `apps/api/test/portal-order-billing.spec.ts`
- Modify: `apps/api/src/portal/portal-billing.service.ts`

**Interfaces:**
- Consumes: `emptyDepositAccount(orderId)` 与 `toPlainDepositAccount(account)`。
- Produces: `getOrder()` 的 `depositSummary` 永远只含 JSON 可序列化 Number。

- [ ] **Step 1: 写入失败回归测试**

让测试夹具支持 `ledgers: []`，调用真实 `getOrder()` 并断言：

```ts
it("serializes order detail when no confirmed deposit ledger exists", async () => {
  const harness = createPortalBillingHarness({ ledgers: [] });
  const result = await harness.service.getOrder(
    "order_a",
    harness.currentCustomer("customer_a")
  );

  expect(() => JSON.stringify(result)).not.toThrow();
  expect(result.depositSummary).toEqual(expect.objectContaining({
    collectedAmount: 0,
    deductedAmount: 0,
    frozenAmount: 0,
    refundedAmount: 0,
    remainingAmount: 0,
    status: "NONE"
  }));
});
```

- [ ] **Step 2: 验证测试因 BigInt 序列化失败**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/portal-order-billing.spec.ts`

Expected: FAIL，`JSON.stringify` 抛出 `Do not know how to serialize a BigInt`。

- [ ] **Step 3: 在 DTO 边界转换空账户**

```ts
return buildDepositOverview(ledgers).accounts[0] ??
  toPlainDepositAccount(emptyDepositAccount(orderId));
```

- [ ] **Step 4: 验证订单聚焦测试通过**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/portal-order-billing.spec.ts`

Expected: PASS。

- [ ] **Step 5: 提交 Task 2**

```bash
git add apps/api/src/portal/portal-billing.service.ts apps/api/test/portal-order-billing.spec.ts
git commit -m "fix: serialize empty portal deposit summary"
```

---

### Task 3: Stage 2 终态 helper 与已签 PDF

**Files:**
- Modify: `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`
- Modify: `apps/api/test/portal-handover-review.spec.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-esign.service.ts`
- Modify: `apps/api/src/portal/portal-handover-review.service.ts`
- Modify: `apps/api/src/portal/portal-handover-review.controller.ts`
- Modify: `apps/web/test/portal-handover-esign-view-model.spec.ts`
- Modify: `apps/web/test/portal-handover-review-pages.spec.ts`
- Modify: `apps/web/src/lib/portal-handover-review-api.ts`
- Modify: `apps/web/src/lib/portal-handover-esign-view-model.ts`
- Modify: `apps/web/src/app/portal/handover-reviews/[id]/page.tsx`

**Interfaces:**
- Produces API DTO: `signedDocumentPreviewUrl: string | null`。
- Produces service method: `previewSignedDocument(id, currentCustomer)`，返回现有 Stage 2 文件描述和流。
- Produces route: `GET /portal/handover-reviews/:id/esign/signed-document/preview`。

- [ ] **Step 1: 写 API 终态失败测试**

在完整归档夹具中让 readiness 仍包含 `STAGE2_SIGNING_NOT_AVAILABLE`，断言 Portal 结果：

```ts
expect(status).toMatchObject({
  blockers: [],
  capability: { canStartSigning: false },
  signedArtifactAvailable: true,
  signedDocumentPreviewUrl:
    "/portal/handover-reviews/work-order-1/esign/signed-document/preview"
});
```

- [ ] **Step 2: 验证 API 终态测试失败**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/stage2-handover-esign-lifecycle.spec.ts`

Expected: FAIL，旧响应仍含阻塞且没有预览地址。

- [ ] **Step 3: 写客户文件路由失败测试**

覆盖三种行为：本人完整归档得到文件流描述；其他客户得到 NotFound；未完整归档沿用现有不可用异常。控制器断言 `inline`、`Content-Type`、`Content-Length` 与 UTF-8 文件名。

- [ ] **Step 4: 验证客户文件测试失败**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/portal-handover-review.spec.ts`

Expected: FAIL，服务方法和路由尚不存在。

- [ ] **Step 5: 实现 API 终态与预览路由**

- `getPortalStatus()` 先计算 `signedArtifactAvailable`，完整归档时返回空 blockers。
- 完整归档时返回相对 `signedDocumentPreviewUrl`，否则为 `null`。
- Portal 服务先调用 `findOwnedReviewOrThrow()`，再调用 `downloadStage2SignedHandoverPdf(id)`。
- 控制器用 `StreamableFile` 与 `inline` 响应头返回文件。

- [ ] **Step 6: 验证 API 两组测试通过**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/stage2-handover-esign-lifecycle.spec.ts test/portal-handover-review.spec.ts`

Expected: PASS。

- [ ] **Step 7: 写 Web 失败测试**

扩展 `Stage2PortalESignView` 夹具；终态输入即使携带旧阻塞，也必须输出空 blockers 和预览入口：

```ts
const view = buildPortalHandoverESignView(createStatus({
  archiveStatus: "ARCHIVED",
  blockers: [{ code: "STAGE2_SIGNING_NOT_AVAILABLE", message: "internal" }],
  signedArtifactAvailable: true,
  signedDocumentPreviewUrl:
    "/portal/handover-reviews/review-1/esign/signed-document/preview",
  status: "COMPLETED"
}));
expect(view.blockers).toEqual([]);
expect(view.signedDocumentPreviewUrl).toContain("signed-document/preview");
```

- [ ] **Step 8: 验证 Web 测试失败**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/portal-handover-esign-view-model.spec.ts test/portal-handover-review-pages.spec.ts`

Expected: FAIL，旧模型保留 helper 且页面没有已签 PDF 按钮。

- [ ] **Step 9: 实现 Web 终态展示**

- 类型增加 `signedDocumentPreviewUrl`。
- 完整归档展示模型强制 `blockers: []`。
- 详情页用现有 Portal API 基地址安全打开预览地址，并只在文件可用且地址存在时渲染“查看已签署交接确认单”。

- [ ] **Step 10: 验证 Web 两组测试通过**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/portal-handover-esign-view-model.spec.ts test/portal-handover-review-pages.spec.ts`

Expected: PASS。

- [ ] **Step 11: 提交 Task 3**

```bash
git add apps/api/src/handover-work-order/stage2-handover-esign.service.ts apps/api/src/portal/portal-handover-review.service.ts apps/api/src/portal/portal-handover-review.controller.ts apps/api/test/stage2-handover-esign-lifecycle.spec.ts apps/api/test/portal-handover-review.spec.ts apps/web/src/lib/portal-handover-review-api.ts apps/web/src/lib/portal-handover-esign-view-model.ts apps/web/src/app/portal/handover-reviews/[id]/page.tsx apps/web/test/portal-handover-esign-view-model.spec.ts apps/web/test/portal-handover-review-pages.spec.ts
git commit -m "feat: expose archived handover PDF to portal"
```

---

### Task 4: “我的申请”持续引导至交付完成

**Files:**
- Modify: `apps/api/test/portal-application.spec.ts`
- Modify: `apps/api/src/portal/portal-application.service.ts`
- Create: `apps/web/src/lib/portal-application-next-action-view-model.ts`
- Create: `apps/web/test/portal-application-next-action-view-model.spec.ts`
- Modify: `apps/web/src/lib/portal-types.ts`
- Modify: `apps/web/src/app/portal/applications/[id]/page.tsx`

**Interfaces:**
- Produces API DTO:

```ts
interface PortalNextActionTarget {
  label: string;
  url: string;
}
```

- `PortalApplicationProgress.nextActionTarget` 为该类型或 `null`。
- `buildPortalApplicationNextActionCard(progress, nextStepHint)` 输出可空 `{ label, message, tone, url }`。

- [ ] **Step 1: 写 API 动作目标失败测试**

用字面量断言关键阶段：

```ts
expect(contractProgress.nextActionTarget).toEqual({
  label: "去签署合同",
  url: "/portal/contracts/contract-1"
});
expect(paymentProgress.nextActionTarget).toEqual({
  label: "去支付",
  url: "/portal/bills?orderId=order-1"
});
expect(deliveryProgress.nextActionTarget).toEqual({
  label: "处理车辆交接",
  url: "/portal/handover-reviews/work-order-1"
});
expect(activeProgress.nextActionTarget).toEqual({
  label: "查看已交付订单",
  url: "/portal/orders/order-1"
});
```

另断言交接工单尚未进入客户可见状态时目标退化为订单详情，而不是不可访问的交接详情。

- [ ] **Step 2: 验证 API 动作目标测试失败**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/portal-application.spec.ts`

Expected: FAIL，旧响应没有 `nextActionTarget`。

- [ ] **Step 3: 实现精确动作投影**

- 扩展订单 select：`contractId` 和最新交付出库 `handoverWorkOrders` 的 `id/status/handoverType`。
- 新增 `buildPortalNextActionTarget(application, nextAction)`，所有 URL 使用 `encodeURIComponent`。
- `GO_CONTRACT` 精确指向主合同；`GO_PAYMENT` 按订单过滤账单；`WAIT_DELIVERY` 仅在客户可见状态直达交接任务，否则指向订单；`ACTIVE/COMPLETED` 指向订单。
- 将目标加入 `toPortalApplicationProgress()`。

- [ ] **Step 4: 验证 API 申请测试通过**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/portal-application.spec.ts`

Expected: PASS。

- [ ] **Step 5: 写 Web 展示模型失败测试**

```ts
expect(buildPortalApplicationNextActionCard({
  nextAction: "WAIT_DELIVERY",
  nextActionTarget: {
    label: "处理车辆交接",
    url: "/portal/handover-reviews/work-order-1"
  }
}, "订单已完成签约支付，等待车辆交付。")).toEqual({
  label: "处理车辆交接",
  message: "订单已完成签约支付，等待车辆交付。",
  tone: "info",
  url: "/portal/handover-reviews/work-order-1"
});
```

覆盖等待无跳转、待合同、待支付、待交接和已交付成功语义。

- [ ] **Step 6: 验证 Web 展示模型测试失败**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/portal-application-next-action-view-model.spec.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 7: 实现 Web 引导卡片**

- 增加类型与纯展示模型。
- 申请页根据模型渲染一个 Alert；有目标时按钮调用 `router.push(card.url)`，无目标时仅展示阶段提示。
- 保留最终方案确认和材料补充的原有页内动作，不重复渲染两个同义 CTA。

- [ ] **Step 8: 验证 Web 申请测试通过**

Run: `pnpm --filter @subscription-saas/web exec vitest run test/portal-application-next-action-view-model.spec.ts`

Expected: PASS。

- [ ] **Step 9: 提交 Task 4**

```bash
git add apps/api/src/portal/portal-application.service.ts apps/api/test/portal-application.spec.ts apps/web/src/lib/portal-application-next-action-view-model.ts apps/web/src/lib/portal-types.ts apps/web/src/app/portal/applications/[id]/page.tsx apps/web/test/portal-application-next-action-view-model.spec.ts
git commit -m "feat: guide portal applications through delivery"
```

---

### Task 5: 集成验证、审查与发布准备

**Files:**
- Modify only if verification finds a regression in files already listed above.

**Interfaces:**
- Consumes: Tasks 1–4 的提交。
- Produces: 可发布的 API/Web 分支和明确的 staging 验收证据。

- [ ] **Step 1: 运行数据库安全检查**

Run:

```powershell
$line = Get-Content D:\Projects\auto-subscription-platform\.env | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
$env:DATABASE_URL = $line.Substring('DATABASE_URL='.Length).Trim('"')
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm --filter @subscription-saas/api exec prisma validate --schema prisma/schema.prisma
```

Expected: 迁移无漂移、schema valid，且没有生成新迁移。

- [ ] **Step 2: 运行所有聚焦回归测试**

Run:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/portal-order-billing.spec.ts test/portal-application.spec.ts test/stage2-handover-esign-lifecycle.spec.ts test/portal-handover-review.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/field-handover-pages.spec.ts test/portal-handover-esign-view-model.spec.ts test/portal-handover-review-pages.spec.ts test/portal-application-next-action-view-model.spec.ts
```

Expected: 全部 PASS，0 failures。

- [ ] **Step 3: 运行 API/Web lint、typecheck 与构建**

Run:

```bash
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api build
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web build
```

Expected: 所有命令 exit 0。

- [ ] **Step 4: 检查变更范围与敏感信息**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- . ':!docs/superpowers'
```

Expected: 仅计划范围文件变化，无密钥、对象键、供应商载荷或无关用户改动。

- [ ] **Step 5: 按 finishing-a-development-branch 完成分支**

先读取并遵循 `superpowers:finishing-a-development-branch`，再按用户已授权的发布流程创建 PR、合并、构建同一 SHA 的 API/Web 镜像、部署 staging，并验证：

- 订单 `2afc7002-7f35-4c7e-93be-2d4c87efa51a` 详情接口返回 200。
- 交接终态无错误 helper，可打开已签 PDF。
- “我的申请”能直达当前交接任务及已交付订单。
- iPhone 微信内置浏览器滚动 Field 页面时操作栏不再被表单控件覆盖。

---

## Self-Review

- Spec coverage: Field 遮挡、订单 500、终态 helper、已签 PDF、申请持续引导分别由 Task 1–4 覆盖；Task 5 覆盖集成与 staging 验收。
- Placeholder scan: 没有占位描述；每个生产变更都有明确失败测试、命令、预期和提交边界。
- Type consistency: API 与 Web 统一使用 `nextActionTarget`、`signedDocumentPreviewUrl`；交接预览 URL 与控制器路由完全一致。
- Mutation check: 去掉 BigInt 转换、恢复终态 blocker、移除客户归属校验、返回错误交接 ID、移除粘性层级时均至少有一个聚焦测试失败。
