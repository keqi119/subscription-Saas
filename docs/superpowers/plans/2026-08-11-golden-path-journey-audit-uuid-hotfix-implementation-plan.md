# Golden Path Journey Audit UUID Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Journey 管理操作把 CUID 写入 UUID 审计列所导致的事务回滚，使 staging 上“重试失败步骤”能够成功提交并继续 Golden Path。

**Architecture:** 保留 `AuditLog.entityId` 的 UUID 类型和 `subscription_journey` 实体类型，在共享的 `writeAdminAudit` 边界统一使用 Journey 的 `applicationId` 作为审计索引，同时在审计快照中保留 Application UUID 与 Journey CUID。所有 Journey 管理动作继续复用同一审计方法，不引入 schema、migration、状态机或 Web 变更。

**Tech Stack:** TypeScript、NestJS、Prisma、PostgreSQL、Vitest、pnpm、Docker/Compose、GitHub Container Registry。

## Global Constraints

- 仅修改 `subscription-journey-recovery.spec.ts`、`subscription-journey.service.ts` 以及本计划的勾选状态；不得修改 Prisma schema 或 migration。
- 严格测试先行：先增加会因当前错误映射而失败的断言，确认红灯后再修改生产代码。
- `AuditLog.entityId` 必须写 `journey.applicationId`；不得写 CUID、`null` 或改变全局审计表类型。
- `after` 快照必须同时包含 `applicationId` 和 `journeyId`；`before` 快照保持现有字段。
- 不通过直接 SQL 推进当前 Journey；部署后仍由管理员再次点击“重试失败步骤”。
- 只构建和部署 API 镜像；Web 镜像继续使用当前 staging 版本。
- 主 agent 直接执行，不委派子代理。

---

## Task 1: Add a Regression Test for the Audit Identifier Contract

**Files:**

- Modify: `apps/api/test/subscription-journey-recovery.spec.ts:101-119`
- Reference: `apps/api/src/subscription-journey/subscription-journey.service.ts:1452-1483`

- [ ] **Step 1: Extend the existing retry test with the required audit contract**

在 `retries only a DEAD_LETTER job backed by an OPEN exception` 测试中，保留现有任务和异常状态断言，并增加：

```ts
expect(harness.auditService.write).toHaveBeenCalledWith(
  expect.objectContaining({
    after: expect.objectContaining({
      applicationId: "application-1",
      journeyId: "journey-1",
      operation: "RETRY"
    }),
    entityId: "application-1",
    entityType: "subscription_journey"
  }),
  harness.tx
);
```

该断言刻意区分 Application ID 与 Journey ID，从而同时覆盖索引键和可追溯快照。

- [ ] **Step 2: Run the focused test and verify that it fails for the intended reason**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- subscription-journey-recovery.spec.ts
```

Expected: 测试失败；实际审计参数仍为 `entityId: "journey-1"`，且 `after.applicationId` 缺失。若失败原因不同，先修正测试装配，不修改生产代码。

- [ ] **Step 3: Inspect the diff before implementation**

Run:

```powershell
git diff -- apps/api/test/subscription-journey-recovery.spec.ts
```

Expected: 只有上述审计契约断言，无快照大面积改写或无关格式变化。

## Task 2: Fix the Shared Journey Audit Mapping

**Files:**

- Modify: `apps/api/src/subscription-journey/subscription-journey.service.ts:1452-1483`
- Test: `apps/api/test/subscription-journey-recovery.spec.ts:101-132`

- [ ] **Step 1: Change the shared audit payload**

把 `writeAdminAudit` 的审计负载改为：

```ts
after: {
  applicationId: journey.applicationId,
  journeyId: journey.id,
  operation,
  version: journey.version + 1,
  ...after
},
before: {
  currentStepCode: journey.currentStepCode,
  status: journey.status,
  version: journey.version
},
entityId: journey.applicationId,
entityType: "subscription_journey",
```

不得改变调用点、事务参数 `tx`、`operatorId`、IP、User-Agent 或其他快照语义。

- [ ] **Step 2: Re-run the focused recovery test**

Run:

```powershell
pnpm --filter @subscription-saas/api test -- subscription-journey-recovery.spec.ts
```

Expected: 该文件全部测试通过，当前基线为 11 个测试。

- [ ] **Step 3: Review the exact production diff**

Run:

```powershell
git diff -- apps/api/src/subscription-journey/subscription-journey.service.ts apps/api/test/subscription-journey-recovery.spec.ts
```

Expected: 生产代码仅增加 `after.applicationId` 并把 `entityId` 从 `journey.id` 改成 `journey.applicationId`；测试仅增加回归断言。

- [ ] **Step 4: Commit the tested hotfix**

Run:

```powershell
git add apps/api/src/subscription-journey/subscription-journey.service.ts apps/api/test/subscription-journey-recovery.spec.ts
git commit -m "fix: use application uuid for journey audits"
```

Expected: 单一实现提交，不夹带依赖锁文件、生成物或无关文件。

## Task 3: Run API and Repository Quality Gates

**Files:**

- Verify: `apps/api/src/subscription-journey/subscription-journey.service.ts`
- Verify: `apps/api/test/subscription-journey-recovery.spec.ts`
- Verify: `prisma/schema.prisma`

- [ ] **Step 1: Validate Prisma without generating a migration**

Run:

```powershell
pnpm prisma:validate
```

Expected: schema valid；`git status` 不出现 schema 或 migration 变更。

- [ ] **Step 2: Run API type checking**

Run:

```powershell
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
```

Expected: exit code 0。

- [ ] **Step 3: Run lint and API tests**

Run:

```powershell
pnpm -r lint
pnpm --filter @subscription-saas/api test
```

Expected: lint 和 API 测试全部通过；若存在与本分支无关的环境性失败，记录精确命令和错误，但不得据此宣称热修已完成。

- [ ] **Step 4: Check migration status read-only against staging**

通过已有的受控 SSH 隧道向 staging PostgreSQL 运行：

```powershell
pnpm prisma migrate status --schema prisma/schema.prisma
```

Expected: `Database schema is up to date!`；不得执行 `migrate dev`、`db push` 或任何写库命令。

- [ ] **Step 5: Verify a clean intentional diff**

Run:

```powershell
git diff --check
git status --short
git log -3 --oneline
```

Expected: 无空白错误；实现和文档均已提交；无依赖缓存、镜像产物或临时文件待提交。

## Task 4: Publish and Merge the Hotfix

**Files:**

- Publish branch: `fix/golden-path-journey-audit-uuid-20260811`
- Base branch: `main`

- [ ] **Step 1: Push the feature branch**

Run:

```powershell
git push -u origin fix/golden-path-journey-audit-uuid-20260811
```

Expected: 远端分支指向本地已验证提交。

- [ ] **Step 2: Open a pull request**

PR 标题：

```text
fix: use application UUID for Journey audits
```

PR 正文必须包含：根因、方案 A、无 migration/Web 变更、已运行的精确验证命令、staging 手工恢复步骤。

- [ ] **Step 3: Confirm checks and merge**

确认必需检查通过且 PR diff 仅含设计、计划、测试与两行生产语义变更后，使用仓库既定合并方式合入 `main`。记录 merge commit SHA，随后重新获取 `origin/main` 验证该 SHA 可达。

## Task 5: Build and Deploy the Staging API Image

**Files:**

- Build context: repository root
- Deployment target: staging API service only
- Unchanged deployment: staging Web service

- [ ] **Step 1: Build and publish an immutable API image from the merged commit**

镜像标签采用仓库现有 staging 规则，并包含合并提交短 SHA。构建前确认代码处于合并后的 `main` 提交，构建成功后推送到服务器当前 compose 配置引用的镜像仓库。

Expected: 远端仓库存在唯一、不可变的 API 标签；不创建 overlay 镜像。

- [ ] **Step 2: Deploy exactly that API image**

更新 staging 受控配置中的 API 镜像标签，只重建 API 容器。部署后检查容器的 `Config.Image` 与期望标签一对一一致；Web 容器及其镜像保持不变。

- [ ] **Step 3: Run post-deployment safety checks**

验证：

```text
API health = healthy
Prisma migration status = up to date
API container image = newly published immutable tag
Web container image = previous unchanged tag
```

检查 API 启动日志没有 Prisma、审计或依赖初始化错误。

## Task 6: Recover and Verify the Current Golden Path Journey

**Files:**

- Staging application: `APP20260811071250MC2M`
- Expected Application UUID: `bfa9e3bf-3ac1-418d-bc53-a0ce758488b3`
- Expected Journey CUID: `cmsobpjav000001p19v68hers`

- [ ] **Step 1: Capture pre-retry state read-only**

确认应用仍为人工审核通过状态，Journey 仍停在 `APPLICATION_VALIDATION / EXCEPTION`，开放异常和 dead-letter job 尚存在。不得直接更新数据库状态。

- [ ] **Step 2: Ask the administrator to retry from the UI**

管理员刷新申请详情，点击“订阅 Golden Path”板块的“重试失败步骤”。

Expected: 接口不再返回 `Internal server error`，操作显示成功。

- [ ] **Step 3: Verify Journey progression**

通过 API/数据库只读查询确认：失败任务进入 `RETRY_SCHEDULED` 后被 worker 消费，原异常变为 `RESOLVED`，`APPLICATION_VALIDATION` 完成，Journey 推进到 `FINAL_PLAN_DECISION / WAITING_MANUAL`。

- [ ] **Step 4: Verify the audit record**

查询本次 `RETRY` 审计记录，确认：

```text
entityType = subscription_journey
entityId = bfa9e3bf-3ac1-418d-bc53-a0ce758488b3
after.applicationId = bfa9e3bf-3ac1-418d-bc53-a0ce758488b3
after.journeyId = cmsobpjav000001p19v68hers
after.operation = RETRY
```

不得要求 `entityId` 等于 Journey CUID。

- [ ] **Step 5: Hand off Golden Path acceptance**

向用户报告新 API 镜像标签、merge SHA、健康与迁移状态、Journey 当前节点、审计校验结果，并通知可以继续人工验收。若 Journey 在后续独立业务事实处等待，准确报告等待事实，不把它误判为本热修失败。
