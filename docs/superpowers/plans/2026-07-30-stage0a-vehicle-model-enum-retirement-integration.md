# 阶段0A：VehicleModel枚举退役整合实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将GitHub PR #223基于最新主干重新整合，在独立新数据库验证枚举到字符串的迁移，并交付不依赖Prisma/PostgreSQL `VehicleModel`枚举的阶段0A代码。

**Architecture:** 保留#223的字符串兼容字段作为阶段0A中间态，不在这个PR中删除API兼容列。以#223现有分支为基线创建本地整合分支，先合入最新`main`，再通过全新数据库迁移、种子、无枚举守卫和完整回归证明该中间态可作为阶段0B输入。

**Tech Stack:** NestJS、Prisma、PostgreSQL、Next.js、TypeScript、Vitest、Node test runner、pnpm、PowerShell、Git。

## Global Constraints

- 执行前使用`superpowers:using-git-worktrees`创建隔离工作树。
- 阶段0A代码基线为现有PR #223的`refactor/vehicle-model-enum-retirement`，不得直接在`main`实现。
- 不强推、不改写#223已有20个提交；通过合入最新`main`保留可审计历史。
- 不修改、删除或压缩任何已提交迁移。
- 不运行`prisma db push`或`prisma migrate reset`。
- 当前测试数据库只读隔离；数据库验证使用明确命名的新库`subscription_saas_stage0a_verify`。
- 阶段0A保留字符串型`vehicleModel`、`legacyVehicleModel`兼容字段；物理删除只属于阶段0B。
- 不修改财务、账单、Lease、电子签、交付或支付行为。
- 不新增依赖，不修改锁文件。
- 不推送分支或更新GitHub PR，直到用户明确要求发布。

---

### Task 1: 建立#223整合工作树并合入最新主干

**Files:**
- Verify: repository and branch state only

**Interfaces:**
- Consumes: current local `main` including approved design commits; remote `refactor/vehicle-model-enum-retirement`.
- Produces: isolated local integration worktree based on the #223 head, with latest `main` merged.

- [ ] **Step 1: 记录主工作区状态**

Run:

```powershell
git status --short --branch
git log -8 --oneline
git remote -v
```

Expected: only known untracked local directories may appear; no tracked modification exists.

- [ ] **Step 2: 获取远端引用**

Run:

```powershell
git fetch origin main refactor/vehicle-model-enum-retirement
git rev-parse main
git rev-parse origin/refactor/vehicle-model-enum-retirement
```

Expected: both revisions resolve successfully.

- [ ] **Step 3: 使用工作树技能创建#223工作树**

Create the worktree from `origin/refactor/vehicle-model-enum-retirement` with local branch:

```text
stage0a/vehicle-model-enum-retirement-integration
```

Do not manually construct or delete a worktree outside the skill workflow.

- [ ] **Step 4: 合入本地主干**

Inside the new worktree:

```powershell
git merge --no-ff main
```

Expected: merge completes or reports explicit conflicts. Resolve only overlapping files, preserve current-main behavior unrelated to vehicle-model governance, then continue the merge.

- [ ] **Step 5: 审核整合差异**

Run:

```powershell
git diff --check main...HEAD
git diff --name-status main...HEAD
git diff -- package.json pnpm-lock.yaml
```

Expected: no whitespace errors; no dependency or lockfile changes.

- [ ] **Step 6: 提交冲突修复（仅在确有冲突时）**

Stage explicit resolved files and commit:

```powershell
git commit -m "merge: integrate latest main into vehicle model enum retirement"
```

If the merge generated its own merge commit without manual follow-up, do not create an empty commit.

### Task 2: 验证#223的Schema和迁移静态契约

**Files:**
- Verify: `apps/api/prisma/schema.prisma`
- Verify: `apps/api/prisma/migrations/20260724170000_vehicle_model_enum_to_string/migration.sql`
- Verify: `apps/api/test/vehicle-model-enum-string-schema.spec.ts`
- Verify: `scripts/check-vehicle-model-no-enum.mjs`
- Verify: `scripts/check-vehicle-model-no-enum.test.mjs`

**Interfaces:**
- Consumes: merged #223 migration and guard.
- Produces: evidence that all eight former enum columns are strings and the PostgreSQL enum is dropped after conversion.

- [ ] **Step 1: 检查迁移只修改已知8列**

Run:

```powershell
Get-Content -Raw apps/api/prisma/migrations/20260724170000_vehicle_model_enum_to_string/migration.sql
```

Confirm conversion of:

```text
vehicle_package.vehicle_model
product_price_rule.vehicle_model
vehicle.vehicle_model
vehicle_model_definition.legacy_vehicle_model
subscription_quote.vehicle_model
subscription_quote.legacy_vehicle_model_snapshot
subscription_order.vehicle_model
subscription_order.legacy_vehicle_model_snapshot
```

Confirm `DROP TYPE "vehicle_model"` occurs after all conversions inside one transaction.

- [ ] **Step 2: 运行Schema契约测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-enum-string-schema.spec.ts
```

Expected: PASS.

- [ ] **Step 3: 运行无枚举守卫测试**

Run:

```powershell
node --test scripts/check-vehicle-model-no-enum.test.mjs
node scripts/check-vehicle-model-no-enum.mjs
```

Expected: both commands pass and report no runtime Prisma enum dependency.

- [ ] **Step 4: 验证Prisma生成**

Run:

```powershell
pnpm prisma:validate
pnpm prisma:generate
```

Expected: both pass.

### Task 3: 在独立全新数据库演练完整迁移链

**Files:**
- Verify: `apps/api/prisma/migrations/**`
- Verify: `apps/api/prisma/seed.mjs`
- Evidence: command output retained in the task log

**Interfaces:**
- Consumes: approved database name `subscription_saas_stage0a_verify` and existing secret-managed PostgreSQL credentials.
- Produces: fresh migrated and seeded Stage0A verification database.

- [ ] **Step 1: 通过数据库管理入口创建验证库**

Create exactly:

```text
subscription_saas_stage0a_verify
```

Set the worktree process `DATABASE_URL` through the existing secret-management mechanism to this database. Do not print credentials and do not point at `subscription_saas`.

- [ ] **Step 2: 确认目标数据库为空**

Run:

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected: the command targets `subscription_saas_stage0a_verify` and reports migrations not yet applied.

- [ ] **Step 3: 部署完整迁移链**

Run:

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected: all migrations, including `20260724170000_vehicle_model_enum_to_string`, apply and status is up to date.

- [ ] **Step 4: 验证最终数据库类型**

Run this read-only SQL through the approved PostgreSQL client:

```sql
SELECT EXISTS (
  SELECT 1 FROM pg_type WHERE typname = 'vehicle_model'
) AS vehicle_model_enum_exists;

SELECT table_name, column_name, data_type, character_maximum_length
FROM information_schema.columns
WHERE (table_name, column_name) IN (
  ('vehicle_package', 'vehicle_model'),
  ('product_price_rule', 'vehicle_model'),
  ('vehicle', 'vehicle_model'),
  ('vehicle_model_definition', 'legacy_vehicle_model'),
  ('subscription_quote', 'vehicle_model'),
  ('subscription_quote', 'legacy_vehicle_model_snapshot'),
  ('subscription_order', 'vehicle_model'),
  ('subscription_order', 'legacy_vehicle_model_snapshot')
)
ORDER BY table_name, column_name;
```

Expected:

```text
vehicle_model_enum_exists = false
all eight columns are character varying(64)
```

- [ ] **Step 5: 运行受控种子**

Run:

```powershell
pnpm --filter @subscription-saas/api exec prisma db seed
```

Expected: seed completes and a second run is idempotent.

- [ ] **Step 6: 再次运行种子**

Run the same command again.

Expected: PASS without duplicate model definitions or model-code conflicts.

### Task 4: 验证车型主数据和兼容中间态

**Files:**
- Verify: `apps/api/src/common/vehicle-model-resolver.ts`
- Verify: `apps/api/src/common/vehicle-model-snapshot.ts`
- Verify: `apps/api/src/vehicle-model-definition/vehicle-model-definition.service.ts`
- Test: `apps/api/test/vehicle-model-resolver.spec.ts`
- Test: `apps/api/test/quote-order-model-snapshot.spec.ts`
- Test: `apps/api/test/vehicle-model-definition.spec.ts`
- Test: `apps/api/test/vehicle-model-integration.spec.ts`
- Test: `apps/api/test/portal-catalog.spec.ts`
- Test: `apps/api/test/report.spec.ts`

**Interfaces:**
- Consumes: Stage0A string compatibility model and `VehicleModelDefinition.modelCode`.
- Produces: verified modelDefinitionId-first writes and readable string compatibility output for Stage0B input.

- [ ] **Step 1: 运行解析和快照测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-resolver.spec.ts test/quote-order-model-snapshot.spec.ts test/vehicle-model-definition.spec.ts test/vehicle-model-integration.spec.ts
```

Expected: PASS, including a canonical code not present in the former enum.

- [ ] **Step 2: 运行产品、Portal和报表测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/product-components.spec.ts test/portal-catalog.spec.ts test/report.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/product-center-access.spec.ts
```

Expected: PASS.

- [ ] **Step 3: 验证modelCode不可修改**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-definition.spec.ts -t "modelCode"
```

Expected: create accepts a valid unique code; update rejects changing the code.

- [ ] **Step 4: 记录阶段0B仍需删除的字段**

Run:

```powershell
rg -n "vehicleModel|legacyVehicleModel|legacyVehicleModelSnapshot|legacyVehicleModelCodeSnapshot" apps/api/prisma/schema.prisma apps/api/src apps/web/src packages/shared/src
```

Expected: only governed string compatibility references remain. Do not delete them in Stage0A.

### Task 5: 运行完整质量门和数据库连接发布检查

**Files:**
- Verify all #223 changed files
- Create: `docs/stage-0a-vehicle-model-enum-retirement-verification.md`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: merge-ready Stage0A branch and reproducible verification evidence.

- [ ] **Step 1: 运行API门禁**

Run:

```powershell
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/api build
```

Expected: all pass.

- [ ] **Step 2: 运行Web门禁**

Run:

```powershell
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/web build
```

Expected: all pass.

- [ ] **Step 3: 运行车型治理**

Run:

```powershell
node scripts/check-vehicle-model-no-enum.mjs
pnpm vehicle-model:removal-readiness:test
pnpm vehicle-model:contract-governance
```

Expected:

```text
no-enum guard passes
enum dependency count is zero
hardRemovalReady may remain false because Stage0B has not removed compatibility fields
```

- [ ] **Step 4: 运行数据库连接发布检查**

Keep `DATABASE_URL` pointed to `subscription_saas_stage0a_verify`, then run:

```powershell
pnpm release:check
```

Expected: PASS. This closes the missing DB-connected verification explicitly listed in #223.

- [ ] **Step 5: 运行最终安全检查**

Run:

```powershell
git diff --check main...HEAD
git status --short --branch --untracked-files=all
git diff --name-status main...HEAD
git diff main...HEAD -- package.json pnpm-lock.yaml
git diff main...HEAD -- apps/api/src/finance apps/api/src/billing apps/api/src/lease apps/api/src/esign
```

Expected: no whitespace, dependency, lockfile, finance, billing, lease, or eSign changes.

- [ ] **Step 6: 生成本地验收记录**

Create `docs/stage-0a-vehicle-model-enum-retirement-verification.md` with:

```text
integration base SHA
PR head SHA
fresh database name
migration status
enum SQL result
seed first/second run
focused and full test counts
release:check result
known Stage0B compatibility remainder
```

Do not include credentials or full environment-variable values.

- [ ] **Step 7: 提交验收记录**

Stage `docs/stage-0a-vehicle-model-enum-retirement-verification.md` and commit:

```powershell
git commit -m "docs(vehicle): record stage0a enum retirement verification"
```

Do not push until requested.
