# Stage 1 正常退车浏览器缺口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已具备受管实物接收事实的正常到期退车样本，能从订单工作区完成关联检查工单，并在正式计价新增账单后刷新结算草案、复用原账单绑定后继收费明细，再发布最终方案。

**Architecture:** 工单动作复用现有 Asset Operations 的受权 GET/transition HTTP 边界，以独立人工操作来源保存事件；不让浏览器冒用 Closure 内部来源或能力。结算只补现有 `PROPOSE_SETTLEMENT` 投影及当前三阶段界面入口；既有 propose/pricing/finalize 服务仍负责不可变修订、账单复用、锁、幂等、快照和审计。两个修复分别形成可复审单元，最后验证同源真实服务/HTTP 组合及浏览器路线。

**Tech Stack:** TypeScript、Next.js 16 / React 19 / Ant Design 6、NestJS、Prisma 7.8、PostgreSQL 17、Vitest；沿用仓库现有依赖，不增加 UI 测试框架或生产依赖。

**Spec:** [DEV_SPEC](../../../DEV_SPEC.md)、[已批准退车三阶段设计 §8/12/15/16](../specs/2026-08-26-stage1-return-evidence-contract-pricing-settlement-design.zh-CN.md)、[审计收口计划任务 8/13](2026-09-22-stage1-audit-driven-closure-plan.md)、[R4 签字计划任务 5](2026-09-22-stage1-r4-staging-signoff-plan.md)。同时消费 [Task 8 既有验证及合成边界](../../acceptance/2026-09-25-stage1-activation-and-operational-closure-validation.md)，不重做其已收口修复。

## Global Constraints

- 本轮仅新增本计划，不提交、不改现有 R4/执行索引、业务代码或运行环境，不执行安装、Prisma、数据库、Docker、网络和服务器操作。基线为 ORIGINAL `7a1d812273470924fa5685e5daa15a8dea28cc1e`；新工作树 `stage1-r4-ui-gap-plan-20260926`。
- 实施仍属用户已批准的阶段 1 审计修复；本稿交独立复审后才施工。真实 PG 只由主控按受控 launcher/精确 fresh 目标编排，不使用 ambient `DATABASE_URL`/PG 凭证，不复活退役目标。AGENTS 的 migrate status preflight 在获准目标内完成，不为本 DOC 任务连接未知数据库。
- `SUBSCRIPTION` 是当前产品；保留 `RENT_TO_OWN`、旧报价和 `ProductPriceRule`。金额存整数分；状态继续用现有枚举，关键动作继续由服务端写审计。不开新权限、菜单、迁移、Schema、工单状态或全局事件类型。
- 本次工单 UI 只覆盖正常到期的 `NORMAL_COMPLETION`、`VOLUNTARY_RETURN`、`RETURN_INBOUND` 无成本确认检查工单；不泛建工单平台，不新增追回/整备/成本确认、分派、取消或 handover-work-order 路线。其余既有能力和守卫保留。
- 不修改 `recordManagedReturnInspection` 的 CLOSED 前提，不跳过真实接收/已归档清单/责任认定；不改结算 resolver/hash、不回填旧 proposal，不重复创建应收，不自动 finalize/settle。客户响应仍绑定最终新 revision/hash。
- 最终证据包维持 R4 已接受的“完成前生成包＋完成后独立读回”；不开发终态导出入口，不重写 R4 冻结文档或历史证据。

## Review Focus

1. Closure 精确工单指针丢失、错 ID/类型、没有最新 version 或角色不足：不提供写动作；任务 1 覆盖 GET/按钮/API 权限反例。
2. 浏览器伪造内部来源、重复点击/超时后换键、并发更新旧版本：新动作保留同次不可变人工命令，版本冲突重新读回并由人重新决定；任务 1 覆盖 HTTP/事件/审计计数。
3. 正额 CUSTOMER FINAL 计价新增 bill，但旧草案财务快照未包含该 bill：显示更新草案入口并暂缓发布；零收费、已有 bill、事实不变不能被错误认定为必需刷新，任务 2 逐例验证。
4. 后继草案重绑收费时改证据/条款/数量/金额、复用旧客户确认或并发出现新账单：既有服务拒绝，不能前端补 hash 或自动循环刷新；任务 2 覆盖账单数、revision/lineage、争议及并发反例。
5. 只通过 source 文本测试、使用合成 PG 事实冒充真实浏览器/供应商：任务 3 分开记录 UI 事件测试、真实 HTTP/服务/PG 和后续 R4 真实窗口证据，任一不能替代另一层。

## 已确认的缺口与合法接口

以下位置按上述基线读取，实施前按方法名复核，行号仅定位线索。

| 事实                                                                                           | 当前来源                                                                                                                                                                | 结论                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web 没有 `asset-operations`、`AssetWorkOrder`、`transitionWorkOrder` 调用，订单页只有工单 List | `apps/web/src/app/orders/[id]/page.tsx:5033`；`apps/web/src/lib/subscription-closure-view-model.ts:267`                                                                 | 当前 view 的 workOrders 仅 id/number/status/type，没有 version；不能猜 1/2 或从创建来源拼造更新命令                                                                                     |
| inspection 先检查绑定工单 CLOSED                                                               | `apps/api/src/subscription-closure/subscription-closure.service.ts:3634` 的 `recordManagedReturnInspectionInTransaction`                                                | 缺浏览器写入口是确定缺口；直接点击“确认车况检查完成”不能替代关闭工单                                                                                                                    |
| 通用 HTTP 允许独立人工工单动作                                                                 | `asset-operations.controller.ts:118`、`asset-operations.service.ts:1013/1361`、`asset-operations.repository.ts:470/1079`                                                | AuthGuard/`ASSET_WORK_ORDER_MANAGE` 注入真实 actor；source 三元组用于幂等所有权；服务锁工单及权威关联，核 vehicle/order/contract/customer，不要求沿用创建 source                        |
| 既有人工来源与真实 Closure 工单组合已有两层依据                                                | `apps/api/test/asset-operations.controller.spec.ts:580` 使用 `MANUAL_OPERATION`；`subscription-expiry-return.integration.spec.ts:9501` 经真实 service 关闭 Closure 工单 | 既有测试尚不是这条浏览器→受权 HTTP→真实服务的完整组合，任务 3 必须补；客户端只发自己的人工命令，不发 `physicalSource()` 使用的 `SUBSCRIPTION_CLOSURE`、`SUBSCRIPTION_EXPIRY` 或测试来源 |
| 接收后正常 RETURN_INBOUND 工单无成本确认，实际路线是 IN_PROGRESS→PENDING_ACCEPTANCE→CLOSED     | closure service `normalExpiryAssetCommand` 与实物接收 `transitionCommand:3270`；asset repository `TRANSITIONS`/`assertTransition`；既有 PG helper                       | 两个人工动作分别提交、分别读回；不“一键闭合”越过验收，不进入 PENDING_COST_CONFIRMATION                                                                                                  |
| 当前 PROPOSED 被后端动作投影及 UI 同时排除再次 propose                                         | `subscription-closure.projection.ts:655`；`return-pricing-stage.tsx:399`                                                                                                | 只改其中一层仍不可达                                                                                                                                                                    |
| 正额 CUSTOMER FINAL pricing 新建 bill 后直接返回，没有重新 propose                             | `subscription-return-governance.service.ts:1796–1887`；`return-pricing-stage.tsx:612` 随后可直接 finalize                                                               | 仅这类新财务事实使旧 proposal 发生确定漂移；不是所有计价都失败                                                                                                                          |
| 服务已允许新 PROPOSED，但 finalize 必须匹配当前财务快照                                        | `subscription-closure.service.ts` 的 `assertSettlementPredecessor:9683`；resolver 的 `billInputSnapshot.bills`                                                          | 保留 hash 拒绝。Task 8 已证明 propose→pricing 新账单→repropose→successor line 复用原 bill→finalize，不修改服务来绕过该顺序                                                              |

工单固定接口为 `GET /api/asset-operations/work-orders/:id`（`asset_operations:view`）和 `POST /api/asset-operations/work-orders/:id/transition`（`asset_work_order:manage`）。GET 返回 `{workOrder,events,evidence,restrictions,source,specialistDeepLink}`；只消费 workOrder 的 id/workOrderType/status/version/costConfirmationRequired 及显示字段，`source` 是创建来源，不拿它发更新。POST 现有 body 为 `{source:{type,id,key},occurredAt,expectedVersion,targetStatus,detailSnapshot,closeReason,solution}`，`Idempotency-Key` 必须与 source.key 相等。不发送 actorId、permissions、authoritySnapshot 或内部 capability。通用管理权限并不额外承诺“只能更新某一 Closure 的工单”；本页面必须约束精确指针，detailSnapshot.closureCaseId 仅为人工动作上下文，不能把它当成服务端授权声明或来源证明。

结算固定接口为 `POST /api/subscription-closures/:id/settlements/propose`、`POST .../:id/pricing`、`POST .../:id/settlements/finalize`；三者均沿现有 `SUBSCRIPTION_CLOSURE_SETTLE`，不新增越权捷径。所有调用继续受现有三阶段准入限制。

## 文件所有权与实施顺序

当前只允许写本计划。后续实施精确文件如下，两个任务串行共用文件，不由两个 owner 同时改同一文件：

| 任务                 | 生产文件                                                                                                                                                                                                                                                                                                           | 测试文件                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 工单入口           | 修改 `apps/web/src/lib/subscription-closure-view-model.ts`、`apps/web/src/lib/subscription-closure-api.ts`、`apps/web/src/components/subscription-closure/return-pricing-stage.tsx`、`apps/web/src/app/orders/[id]/page.tsx`；新增 `apps/web/src/components/subscription-closure/return-inspection-work-order.tsx` | 修改 `apps/web/test/subscription-closure-view-model.spec.ts`、`apps/web/test/subscription-return-three-stage.spec.tsx`；新增 `apps/web/test/subscription-return-browser-actions.spec.tsx` |
| 2 草案刷新           | 修改 `apps/api/src/subscription-closure/subscription-closure.projection.ts`；继续修改任务 1 的 API helper/pricing 组件                                                                                                                                                                                             | 修改 `apps/api/test/subscription-closure.projection.spec.ts`；继续任务 1 新增的行为测试                                                                                                   |
| 3 真实组合与独立验证 | 不增加生产文件                                                                                                                                                                                                                                                                                                     | 修改既有 `apps/api/test/subscription-expiry-return.integration.spec.ts`、`apps/api/test/asset-operations.controller.spec.ts`；不增加 suite/manifest/测试连接器                            |

生产共 6 文件（5 既有＋1 新），测试共 6 文件（5 既有＋1 新）。其余 closure/governance/asset controller/service/repository、DTO、shared auth/seed/menus、数据库定义和依赖文件只读。若实际验证出现这些范围外生产缺陷，保留精确 RED 交所属 owner，独立限域后再处理，不能直接扩大本单元。任务 3.1 的 preflight 是任务 1.3/2.2 生产修改的前置，不能因为写在验证章节就延后；测试-only 准备和离线 RED 可先进行。各生产单元独立复审，最终任务 3.5/3.6 使用二者集成后的同一干净 source。

## Task 1：让正常检查工单在订单工作区可完成

**Interfaces:** `AdminSubscriptionClosureView` 新增 nullable `returnAssetWorkOrderId`，仅从服务返回 `aggregate.closureCase.returnAssetWorkOrderId` 映射，不能按数组首项推断。`ReturnPricingStage` 接收从订单页现有 permissions 集合派生的 `canViewAssetWorkOrder`、`canManageAssetWorkOrder` 两 boolean；不改变既有 inspect/settle capabilities。新增组件消费此精确 id、closure 当前状态/类型/物理控制、workOrders 列表及两权限。API helper 增加 `loadReturnInspectionWorkOrder(workOrderId)` 和 `transitionReturnInspectionWorkOrder(workOrderId, command)`，都复用 apiFetch 的 Cookie/错误模型。两个新异步动作另消费页面提供的 `reloadClosure(): Promise<AdminSubscriptionClosureView>` 和 `onClosureReadback(view): Promise<void> | void`：前者用既有 `loadAdminSubscriptionClosureByOrder(orderId, permissions)` 实际读回，缺案/错案/错误须 reject；后者在核对当前页面绑定后只发布此已读回 view。不得把当前会吞掉刷新异常的 `loadOrder()/refreshSubscriptionClosure()` 的 fulfilled Promise 当作读回成功。旧 `onChanged` 继续供原有动作使用；新 controller 的 onChanged 明确绑定 onClosureReadback，不调用旧 loadOrder，避免它在 await 后把旧订单的结果写入新页面。

- [ ] **1.1 写 UI/transport RED。** 在新行为测试中直接导入实际组件的无 hooks 按钮视图 `ReturnInspectionWorkOrderActions(props)`，用现有 `renderToStaticMarkup` 只检查可见性、禁用与文案。另调用下面生产容器实际消费的异步 controller；只在 `apiFetch` transport 层以 deferred Promise 控制真实 API helper 的完成顺序，不能 mock controller/helper 整体，不能用注入 onClick spy 的成功当作异步流程证明。

**任务 1 的窄状态接缝。** 在本次新增的 `return-inspection-work-order.tsx` 同文件导出 `createReturnInspectionController({reloadClosure,onChanged,onState})`，返回 `bind(context)`、`reload()`、`submit(input)`、`retry()`、`dispose()`、`getSnapshot()`。context 只包含当前 closureCaseId/workOrderId、上述已核页面条件及两权限；input 只含人填的 occurredAt/solution/closeReason 和当前允许的 targetStatus。controller 内实际调用 `loadReturnInspectionWorkOrder` / `transitionReturnInspectionWorkOrder`，自行生成 MANUAL_OPERATION 来源并冻结命令；snapshot 保存详情、pending 的精确目标和完整 command、busy/错误/读回状态。React 容器用 ref 持有该 controller，按钮直接调用其方法，state 仅订阅其 snapshot；不能另保留一套组件内部 pending/busy 算法让测试绕过真实实现。onState 是渲染通知，onChanged(view) 是向页面发布严格读回后的 view；二者都不是凭空提供已完成事实的回调。

`bind` 在 case/workOrder、有效性或权限改变时递增 generation、使旧结果失效；相同 props 的普通 rerender 保留同一次 pending。每次 reload 另有递增 read sequence，同 generation 内后发 GET 的结果优先，旧 GET 晚到不能覆盖。submit 在第一个 await 前设置同步 busy latch，防止同一事件循环双击；每个 await 后都核 generation/目标及权限。dispose 使在途回调失效，不能把旧 finally 的 busy=false 或旧成功状态写进新绑定。旧 pending 只能属于原目标，不因 bind 更换 id/版本后重新包装提交。

```ts
const sourceId = "10000000-0000-4000-8000-000000000001";
const command = {
  source: { type: "MANUAL_OPERATION", id: sourceId, key: `return-inspection:${sourceId}` },
  occurredAt: "2026-09-26T08:00:00.000Z",
  expectedVersion: 4,
  targetStatus: "PENDING_ACCEPTANCE" as const,
  detailSnapshot: { closureCaseId: "20000000-0000-4000-8000-000000000002" },
  closeReason: null,
  solution: null
};
await transitionReturnInspectionWorkOrder(workOrderId, command);
expect(apiFetch).toHaveBeenCalledWith(`/asset-operations/work-orders/${workOrderId}/transition`, {
  method: "POST",
  headers: { "Idempotency-Key": command.source.key },
  body: JSON.stringify(command)
});
```

测试 UUID/时间仅离线输入，不是运行样本。增加参数化断言：正常 IN_PROGRESS 只显示“提交检查验收”，PENDING_ACCEPTANCE 且 `costConfirmationRequired === false` 只显示“验收并关闭工单”；CLOSED 为只读成功，其他状态/未知 boolean/错误工单类型/指针不在本案列表/缺最新 detail/version 均不显示写按钮。缺 view 时 GET=0；有 view 无 manage 可以读详情但 POST=0；manage 有而 view 无也不得猜版本发 POST。正常页能看到实际按钮，追回/整备/旧三阶段关闭页面保持原行为。

在同一新增行为测试文件放测试专用 `deferred<T>()`，并至少执行下列真实 controller/真实 helper 序列；不是只测工厂返回形状：

```ts
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
// apiFetch 的 POST 返回此 promise；submit 使用真实 helper，busy 在 await 前落定。
const pendingPost = deferred<unknown>();
```

1. 同一合法详情下连续两次 submit，deferred POST 尚未 resolve 时只发送一次；busy 始终为 true，提交后不能编辑 pending body。
2. POST 丢响应/timeout，独立 GET 尚未结束时不能开启下一动作；读回仍不能证明本次完成则维持未决。人工 retry 经过原 helper 发同一路径、同 key、逐字相同 body（包括 occurredAt/expectedVersion），不会生成新 UUID；若读回事件已与本次 source 三元组/目标状态相符并完成当前案读回则只刷新，不再 POST。只有工单碰巧处于目标状态不足以宣称本次请求成功。
3. 两次 GET 后发先到，旧 GET 晚到不恢复旧 version；提交期间切换 case 或 workOrder，旧 GET/POST/closure reload 的成功、失败及 finally 都不能更新新 snapshot，retry 不能把旧 pending 发到新 id。权限撤销和 dispose 同样断言。
4. POST 已知成功后 GET、严格 reloadClosure 或 onChanged 失败，snapshot 标为刷新未完成，下一动作仍禁用；重试刷新只发读请求/重新调用 onChanged，不再发 POST，不把后台可能已提交报成已回滚。真实 reloadClosure 测试回调也须通过 `loadAdminSubscriptionClosureByOrder` 和 deferred apiFetch 取数据，不直接返回手写成功 view。

- [ ] **1.2 聚焦跑 RED 并保留原因。** 运行下文对应 Web 测试，预期新增 helper/组件/精确指针尚不存在或动作缺失；记录实际断言，不把编译、依赖或连接问题算业务 RED。现有 API 权限测试先 characterization，不能为正确后端制造失败。
- [ ] **1.3 实现精确读回及两个独立动作。** 仅在三阶段启用、`NORMAL_COMPLETION`＋`VOLUNTARY_RETURN`＋`RETURN_INSPECTION`，且允许检查的工作区挂载新组件。匹配精确 returnAssetWorkOrderId 和本案 workOrders 后，GET 最新 detail；再次核 id、`workOrderType === "RETURN_INBOUND"`、version 为非负整数和 `costConfirmationRequired === false`。缺项/404/无权限/类型不符显示明确阻断，不能 fallback 到其他工单。服务端 GET 中的创建来源完全不进提交 body。

```ts
// 在新组件内决定正常检查工单的按钮；服务端仍裁定最终状态迁移。
const targetStatus =
  detail?.status === "IN_PROGRESS"
    ? "PENDING_ACCEPTANCE"
    : detail?.status === "PENDING_ACCEPTANCE" && detail.costConfirmationRequired === false
      ? "CLOSED"
      : null;
// 每次用户确认生成一个 operationId；仅写 MANUAL_OPERATION。
const source = {
  type: "MANUAL_OPERATION",
  id: operationId,
  key: `return-inspection:${operationId}`
};
```

首次动作填写实际检查完成说明/发生时间；关闭动作填写验收结论和关闭原因，沿现有长度限制（solution≤4000、closeReason≤1000），不自动写“通过”。command.expectedVersion 取刚读到的 detail.version，source/时间/说明/目标状态一经提交保持不变；前端只保留本组件本次非秘密操作，不新建全局命令平台。

- [ ] **1.4 保留并发与失败语义。** busy 时禁同一动作；响应成功后独立 GET 工单、严格 reloadClosure，并 `await onChanged(view)` 发布当前 closure，才展示下一动作。timeout/断网先读回，保留原 command/key 供明确重试，不新键连续写；有版本冲突/状态冲突先刷新，禁把旧说明静默套到新 version。组件卸载后不宣称操作失败回滚；重新进入先读当前状态，不能自动重发。服务端同 key 同内容重放、同 key 改内容拒绝、不同 key 同 expectedVersion 仅一个成功的语义保持。
- [ ] **1.5 保持前后环节分离。** 工单 CLOSED 不等于已完成 closure inspection；仍由用户生成 delta、完成必要责任确认，再点击原“确认车况检查完成”。未 CLOSED 时该 inspection 按钮禁用并说明原因；新组件的独立详情成功/关闭读回通知 pricing 容器，不能仅靠本地乐观状态放行。后台仍保留 CLOSED 校验。
- [ ] **1.6 跑聚焦 GREEN、权限/失败矩阵和类型检查，独立审查精确提交。** 原 List 及历史标签保留；原 source 文本检查可作补充，不能取代新事件/transport 测试。由主控审查后提交任务 1 文件，暂不宣称真实浏览器已验收。

## Task 2：只对已确定的新账单事实提供草案刷新

**Interfaces:** 沿用 `governedAllowedActions(closureCase, governed): string[]` 与现有 `PROPOSE_SETTLEMENT`，不加新 action/权限/DTO。新增准入仅为 PENDING_SETTLEMENT 的当前 PROPOSED：当前 revision 的正额 CUSTOMER FINAL chargeLine 绑定一个仍有效实际 bill，而 currentSettlement.billInputSnapshot.bills 没有该 billId。新 predicate 仅识别已确认缺口，不代替 resolver 的完整财务 hash 校验。

- [ ] **2.1 写 projection RED 与现有服务 characterization。** 在既有 projection test 直接调用真实 `governedAllowedActions`：

```ts
const closureCase = {
  status: "PENDING_SETTLEMENT",
  currentSettlementRevision: {
    id: "proposal-1",
    stage: "PROPOSED",
    billInputSnapshot: { bills: [] }
  }
};
const governed = {
  deltaRevisions: [{ id: "delta-1", items: [] }],
  chargeLines: [
    {
      settlementRevisionId: "proposal-1",
      status: "FINAL",
      responsibility: "CUSTOMER",
      amountCents: "200",
      billId: "bill-1"
    }
  ],
  receivableBills: [{ id: "bill-1", billStatus: "PENDING", amount: "200", remainingAmount: "200" }]
};
expect(governedAllowedActions(closureCase, governed)).toContain("PROPOSE_SETTLEMENT");
```

反例逐一固定：零额、非 CUSTOMER、PREVIEW/PRICING_EXCEPTION、其他 revision 的 line、null/不存在/CANCELLED bill、snapshot 已含相同 bill、无 delta、非 PENDING_SETTLEMENT、FINALIZED 没有已接受争议、SETTLED/COMPLETED 均不因新增条件放开。原首个草案/争议后继路径原断言保留。PG characterization 保存直接 finalize 触发 `SETTLEMENT_FACT_DRIFT` 的真实结果，而非把该正确守卫改绿。

- [ ] **2.2 最小改变投影。** 在现有 PROPOSE 条件加入如下独立窄分支，保留旧条件；完整 predicate 放同一既有 projection 文件私有函数内，不创建共享规则包：

```ts
const capturedBillIds = new Set(
  asRecordArray(asRecord(currentSettlement.billInputSnapshot).bills).map((bill) => bill.id)
);
const liveBillIds = new Set(
  receivableBills.filter((bill) => bill.billStatus !== "CANCELLED").map((bill) => bill.id)
);
const needsPricingProposalRefresh =
  status === "PENDING_SETTLEMENT" &&
  settlementStage === "PROPOSED" &&
  asRecordArray(governed.chargeLines).some(
    (line) =>
      line.settlementRevisionId === currentSettlement.id &&
      line.status === "FINAL" &&
      line.responsibility === "CUSTOMER" &&
      nonNegativeBigInt(line.amountCents) > 0n &&
      typeof line.billId === "string" &&
      liveBillIds.has(line.billId) &&
      !capturedBillIds.has(line.billId)
  );
// 原 delta/旧条件保持，新增 needsPricingProposalRefresh 分支。
```

缺/坏 snapshot 不能当作“财务未变”的证明；有上述真实正额 line/bill 时显示刷新，最终是否合法仍由原 propose/finalize 服务重读。金额比较用现有 bigint helper，不转浮点数。不把该提示扩成任意财务变化自动重新草拟或自动重新发布。

- [ ] **2.3 增加实际按钮及稳定新动作。** pricing 页面当前 PROPOSED 且 serverActions 含 PROPOSE_SETTLEMENT、settle capability 为 true 时显示“更新结算草案”，说明“正式收费已生成账单，请更新草案后重新绑定收费清单”。这时暂禁“发布最终结算方案”。更新成功严格 reloadClosure 后调用新 controller 的 onChanged(view)，展示新 revision；操作者再次点击原正式收费动作，由旧 createPricing 为新 revision 追加 successor line、复用旧 bill。既有零收费或事实未变路线不要求额外 propose；新 revision 再绑定后 bill 已在 snapshot，刷新提示消失，原发布按钮恢复。

为检查显示，允许仅把此小组无 hooks 按钮提为同文件导出的 `ReturnSettlementProposalActions({mode,busy,onPropose})`；mode 精确取 `initial | refresh | dispute | hidden`，只供当前组件显示文案，不是业务状态 enum。SSR 仅验四态/权限/disabled，不证明 pending、超时或刷新逻辑。actual helper 保持兼容，新增可选第三参数：

```ts
advanceSubscriptionClosureSettlement(
  closureCaseId: string,
  action: "propose" | "finalize" | "settle",
  command?: Readonly<{ idempotencyKey: string; occurredAt: string }>
)
```

新 refresh 按钮确认时冻结该两字段，并对同次不确定结果保留/重试原值；旧调用不传参数继续现有行为。测试真正 helper 在重试时发送相同 body，禁止 mock 掉整个操作函数。更新前后不直接改 local proposal hash、bill、chargeLine 或客户响应，不隐藏失败通知。网络结果不明时先重新读本案，不静默自动 propose→pricing→finalize。

**任务 2 的窄状态接缝。** 在既有 `return-pricing-stage.tsx` 内导出 `createReturnSettlementRefreshController({reloadClosure,onChanged,onState})`，返回 `bind({closureCaseId,settlementRevisionId,canRefresh})`、`refresh()`、`retry()`、`reload()`、`dispose()`、`getSnapshot()`。只服务新增“更新草案”动作，不重写通用 run 或其他计价操作。真实按钮调用该 controller，busy 与旧 busy 共同禁用冲突操作；pending 固定原 case/revision、key、occurredAt，实际调用 `advanceSubscriptionClosureSettlement(caseId,"propose",command)`。同样使用同步 busy、generation 和 read sequence；当前 revision 改变即使 case 不变，也不能把旧 pending/返回值套给新 revision。成功响应不能代替严格 reloadClosure；有响应时读回 revision 必须对应返回的 proposal，另人已推进时显示冲突并更新事实，不自动追加新草案。页面严格 reader 与 onClosureReadback 在返回/发布 React view 前也核捕获的 orderId/case 和页面 binding generation（包括 A→B→A），防旧 case 的 readback 写回新页面；onClosureReadback 不调用会吞错或自行写旧结果的 loadOrder。新增 page 接缝只供这两个动作，不改其他页面通用刷新策略。

同一新增行为测试以 deferred apiFetch 驱动真实 advance helper 和真实 closure loader，直接调用此生产 controller：双击仅一个 propose；丢响应后先读回、仍未决时 retry 的 body/key/occurredAt 完全不变；原 case A 的 propose/GET 在 bind 到 B 后返回不能设置 B 的成功/发布状态；同 case 从 revision R1 切到 R2 时原 pending 不能重发到 R2；旧 GET 晚于新 GET 不能降回 R1；POST 成功但 reloadClosure/onChanged 抛错仍不可发布且只重试刷新；权限变更/dispose 后旧 finally 不能解锁新请求。丢响应后仅发现新 revision 不能证明本次命令成功，记录“状态已变化，需核对”，发布读回事实但不自动重提旧命令；不为取得此证明新增后端收据接口。测试只为只读 UI 通知注入 spy，实际异步 handler、状态与 API helper 不替换。新增接口都留在已有 6 个生产文件内，无新文件/依赖或测试专用生产 flag。

- [ ] **2.4 跑 GREEN 与后继收费回归。** 验新 revision 的 currentFinalLines 初始为空，必须通过真实原 pricing 动作绑定；返回旧数据或 onChanged 失败时不误显可发布。拒绝反例按下表构造合法前置并断言实际最先触发的 guard，不把所有变更统一记为 active-bill 分支；已接受争议仍使用既有后继调整路线，FINALIZED 无争议不能因本次按钮放开。财务后来又变化时原 finalize hash 拒绝，保留现场让人核对，不自动循环生成 revision。

| fixture 中唯一破坏点及需成立的前置                                                                                                                                                                             | 当前最先真实拒绝（`subscription-return-governance.service.ts`）                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前 revision 已有 FINAL，修改同版本请求的证据/条款/数量/人工价等既有内容                                                                                                                                      | `CLOSURE_PRICING_IDEMPOTENCY_CONFLICT`（约1541）；不能声称进入后继旧 bill 比较                                                                                                    |
| 后继 revision 无 FINAL，证据不属于当前案，其他基础输入有效                                                                                                                                                     | `CLOSURE_PRICING_EVIDENCE_MISMATCH`（约1559）；属于本案但不在当前 delta 证据快照的证据也由后续 evidence guard 拒绝                                                                |
| 后继 revision 无 FINAL，合法本案证据/合同条款与责任，quantity 或 chargeType 不符合当前 delta 的受管事实                                                                                                        | `CLOSURE_PRICING_DELTA_MISMATCH`（约1629）；不篡改 delta 来迫使测试进入旧 bill 分支                                                                                               |
| 正式人工计价的条款/输入满足形状要求，但审批缺失、过期或不绑定当前价格/revision                                                                                                                                 | `CLOSURE_PRICING_APPROVAL_REQUIRED`（`requireCurrentPricingApproval` 约3755）；若更早连人工条款/输入形状都缺失，实际为 `CLOSURE_PRICING_EXECUTABLE_CLAUSE_REQUIRED`，分开 fixture |
| 后继 revision 无 FINAL，所有证据/条款/delta/数量/必要审批都合法，当前 delta 有两份合法证据而选用的子集相较 prior line 改变，或改用同合同/同 chargeType 的另一有效条款；且 prior FINAL 关联的 bill 未 CANCELLED | 才期望 `CLOSURE_PRICING_ACTIVE_BILL_REPLACEMENT_REQUIRED`（约1661–1682）；此例证明不能借刷新草案改现有有效账单，不将任意金额变更都归到此分支                                      |

每个拒绝同时断言账单/chargeLine/revision 不新增或覆盖。保持服务现有检查顺序，不改正确 service 迎合测试预期；若实际前置先触发另一 guard，保留运行原件、修正 fixture 分类后再验证目标分支。

- [ ] **2.5 独立审查精确提交。** 生产不修改 closure/governance service、resolver、账单模型、audits 或审批。审查者核正额新增 bill 的闭合条件、前后双层入口、零收费和争议兼容；通过后交任务 3 同源门禁。

## Task 3：受控 preflight、真实 HTTP/服务组合与交接

**Interfaces:** 原 `scripts/release/run-database-suite.mjs`、`requiredReleaseDatabaseTestContext`、manifest 中 `api.subscription-expiry-return.postgres` / `api.asset-operations.postgres`；不读取 ambient 连接，不改变 suite 文件集合。API 单元已有 controller test 的 Nest HTTP harness 使用本机随机端口及测试 AuthService；真实组合复用同样 AuthGuard/PermissionsGuard/ValidationPipe，替换为该 fresh suite 创建的真实 service/repository/AuditService/PrismaService。

- [ ] **3.1 实施前由主控记录精确 preflight。** 读取当前 HEAD/status/文件归属，保留本稿基线后的他人前向改动。无数据库的编译/单测准备仅用既有依赖；需准备依赖时由主控按现有离线 frozen-lockfile/ignore-scripts 规则处理。本任务不改变生成输入。Prisma validate/generate 使用已审离线准备路径；业务生产修改前，由主控给新的受控 fresh 执行窗口，launcher 真实完成 migrate deploy/status/diff、身份/权限读回并保管；pending/失败/目标未知就停止该开发轮生产修改，不能直接运行 AGENTS 中连接 ambient 的命令。测试-only source 先提交干净再进 launcher，预先批准的数据准备/迁移仅适用于该 fresh 目标。
- [ ] **3.2 增加真实 HTTP 组合 characterization。** 在既有 expiry PG 文件使用真实 setupFocusedPhysicalReceipt 创建正常 Closure 和关联工单；服务事实不直接改 CLOSED。test 内建立现有 controller 的 Nest app，端口只绑定 127.0.0.1:0，AuthService test identity 返回该 fixture actor 和明确权限，其他业务依赖全部真实。用 GET 读精确 id/version，再两次 POST（MANUAL_OPERATION 来源、真实 actor、独立稳定键），中间独立 GET；证明 closure-created 工单合法接受独立人工命令来源。新增 helper 留在此既有 PG 文件，不复制 provider/DB launcher。服务鉴权为测试身份边界，不能称真实 JWT/角色验收。
- [ ] **3.3 联合断言保护条件。** 相同 key/body 重放不新增事件/审计；相同 key 改 body 为 `ASSET_OPERATION_SOURCE_CONFLICT`；不同 key 同 version 并发只有一条新事件，另一冲突；缺对应权限的 GET/POST 403 且没有业务调用/写入，伪 actor/permissions 被 HTTP 边界丢弃；不存在的 ID/失效权威关联/未来发生时间/越级 CLOSED/成本确认分支均不能成功。另一有效工单的 id 在本页面精确指针核对时应使 POST=0，不给现有通用 HTTP 虚构按 Closure 限定的授权规则。成功时工单 version 只按真实步骤增长，事件与 UPDATE/CREATE 审计的 operatorId 都来自 auth actor，Closure/Order/Contract 不被工单接口提前完结。沿既有 unit audit failure 与 PG 事务断言保留失败回滚，不新增成功日志。
- [ ] **3.4 对接正额收费的实际路线。** 在既有 Task 8 正额样本附近用真实投影读 allowedActions，并经已有 closure controller/真实 service 依次：propose→pricing 新 bill→旧 draft finalize 拒绝→投影允许 refresh→propose 后继→pricing 复用原 bill→finalize。原 proposal/hash 和旧 line 不变；后继 supersedes 指针准确、原 billId 保持、bill 总数只第一次增加 1；同命令重放零新增。新 FINALIZED 的客户响应使用新 revision/hash，旧响应不能自动套用。另保留零收费不刷新可发布、事实未变/已有 bill、不定责任/无条款/错证据/权限不足/旧版本/并发账单变化的反例。正确后端行为记 characterization，不伪造缺陷 RED。
- [ ] **3.5 跑离线门禁。** 下列命令从最终同源 workspace 执行，当前 DOC 轮不执行；聚焦 RED/GREEN 之后只在有新变更/失败时重跑。先各自单测，再一次同源组合，实际计数/exit/raw 路径写 ignored `node_modules/.cache/sdd/stage1-return-browser-gap/`，不预填通过数。

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/subscription-return-browser-actions.spec.tsx test/subscription-closure-view-model.spec.ts test/subscription-return-three-stage.spec.tsx
pnpm --filter @subscription-saas/api exec vitest run --project unit test/subscription-closure.projection.spec.ts test/asset-operations.controller.spec.ts test/asset-operations.service.spec.ts test/subscription-closure.controller.spec.ts test/subscription-closure.settlement.service.spec.ts test/subscription-return-governance-gate.spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
git diff --check
```

对实际修改的上述 TS/TSX 文件运行 owned ESLint 和 Prettier 检查，原大文件已存在的格式差异只记录，不整文件格式化。若 test helper 新增 Node API，遵循现有 test globals 配置，不修改仓库 lint policy 让失败消失。

- [ ] **3.6 同一干净 source 串行运行两个完整 fresh suite。** 准入/秘密/目标生命周期仅由原 launcher 和主控已审捕获流程负责。先 expiry 组合再 asset 基础回归，不并发 PG；无 filter/skip/only，不直接对 PG 文件跑 vitest 绕过 manifest。命令来源为现有 `run-database-suite.mjs` 和 manifest；不能把源码中的 argv 改成外部目标。

```powershell
node scripts/release/run-database-suite.mjs --suite-id api.subscription-expiry-return.postgres --chain fresh
node scripts/release/run-database-suite.mjs --suite-id api.asset-operations.postgres --chain fresh
```

记录实际 `collected=selected=executed=passed`，failed/skipped/filtered/cancelled/todo 为 0，exit/signal、report/receipt、独立 raw readback 与每个目标精确退役。任一失败保存原件，不能换 fixture/强制成功后覆盖记录。这里不复跑 Task 8 不相关 activation/golden-path 套件，不修改 manifest；最终 R3 同候选完整双链另有原门禁。

- [ ] **3.7 验实际浏览器可达并交回 R4。** 先在获准本地受控业务环境用真实 UI 点开 `/orders/{真实orderId}` 的退车三阶段工作区，按角色验证看到/看不到按钮及请求；若暂无获准 Web/API 环境，此项明确未执行，不拿 SSR 代替。R4 真实 Staging 样本仍必须等同候选双链、对应已停 Docker 环境恢复及原操作批准后执行，不在本任务随意启服务。记录精确工单 id/version、两个人工命令键、HTTP 结果、fresh readback/事件/审计；随后 delta→必要 confirmDelta→inspection→propose→正额 pricing→更新草案→重新绑定收费→finalize。真实外部事实全部来自 R4 样本，不用直接 API/手改日期冒充浏览器。
- [ ] **3.8 独立审查与冻结。** 将两任务精确提交、最终 source、diff、真实测试计数/原件、失败历史及仍未执行的浏览器/外部项交 reviewer。复审通过才由主控集成到 ORIGINAL 的前向候选，不用其他 worktree 整树覆盖。R4/index 当前不改；主控在后续证据收口时按原规则前向引用本单元，不改旧签字计划 hash，不提前宣称阶段 1 或 R4 完成。

## 本 DOC 交付检查

- [ ] 独立复核 Generic transition 的角色、来源、权威锁、version 与幂等；没有规划浏览器伪造内部 domain source。
- [ ] 工单列表缺 version 已显式采用固定 GET，精确 return 指针来源与缺项拒绝清楚。
- [ ] 正额新增 bill 与零收费/已有 bill 分开；repropose 后 successor line 复用 bill 与原 hash 检查均保留。
- [ ] 每个 Review Focus 有具体事件/HTTP/PG 断言；只读 DOC 检查与未来需获准窗口的执行命令明确分开。
- [ ] 仅本文件新增；格式和 diff 检查通过后交主控独立复审，所有实施/真实验收 checkbox 保持未完成。
