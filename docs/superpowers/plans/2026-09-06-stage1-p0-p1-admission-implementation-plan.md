# Stage 1 P0/P1 范围交接与受控开发准入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用两个可独立批准的任务建立唯一验收口径和真实本地开发基线，不启动发布平台或业务修复。

**Architecture:** P0 只交接文档/适用性契约；P1 只消费现有隔离 launcher，在无客户数据的本地 PG17 上运行迁移和已有测试。结果进入同一执行索引，失败按证据归属后续小计划，不自动修产品代码。

**Tech Stack:** 现有 PowerShell、Node/pnpm、Docker、按 digest 固定的 PostgreSQL 17、Prisma、node:test/Vitest；不新增依赖或云服务。

**Spec:** [最小受控发布决策](../specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md) §1/2/4.1/5/6；[覆盖路线图](./2026-09-06-stage1-mainline-minimal-release-implementation-plan.md)。

**Status:** 待独立批准，未执行。P0 与 P1 可分别批准；本文不批准 R1–R4 的实现，不以这些包细化完成为前置。

## Global Constraints

- Task 6、29R/30、I 系列冻结；Task 0–5 保留。旧在途计划已独立保管为 `457c0011`，不等于获批。
- 不修改产品代码、数据库业务结构、权限码、开关或历史迁移，不触碰冻结 stash。
- P0 不连接数据库；P1 仅新建无客户数据的本地临时数据库，绝不使用 ambient DATABASE_URL、Staging 或 production。
- 不运行真实签发、来源导出、快照使用、云配置/上传、部署或供应商请求；不生成真实密钥。
- 本计划中的命令均为获批后执行。native command 后必须立即检查 `$LASTEXITCODE`，不能只依赖 `$ErrorActionPreference`。
- P1 本地角色用于开发测试，不作为新人工发布 profile；不得调用未实现的 R 入口或添加绕过参数。
- 不伪造 RED：已存在且通过的行为记录通过证据；已有测试失败先归因，不以补测试数量为目标。
- 数据库失败、未知身份或未应用迁移阻断业务施工；新空临时库仅允许按 P1 明列步骤先 deploy 再 status，不把 pending 报成通过。

## 文件归属与交付接口

| 文件                                                              | P0                               | P1                                  |
| ----------------------------------------------------------------- | -------------------------------- | ----------------------------------- |
| `docs/acceptance/2026-09-06-stage1-mainline-execution-index.md`   | Create：范围、状态、证据索引     | Modify：真实命令/计数/失败/迁移结论 |
| `docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md` | Modify：两项人工决定与新入口声明 | 只读                                |
| `release/contracts/external-validation-applicability.v1.json`     | Modify：明确六项外部/人工要求    | 只读                                |

P0 产出是“范围已交接、测试未运行”，不是验收通过。P1 产出是“本地开发准入通过/失败/阻断 + 原始结果引用”，不是可信构建或发布证明。本计划不创建六个新 Schema、第二套 bundle 或 Runner 模块。

两个任务均读取 AGENTS.md；业务规范只读参照 DEV_SPEC.md。若本轮开始时存在别人未完成修改，使用既有隔离 worktree 或另行隔离；不得 `git add .`，不得提交他人文件。

---

## P0：唯一验收口径与交接索引

**批准范围：** 三个列明文件、静态契约和无外部副作用的现有单元测试。批准引用由用户实际决定产生，不预填伪 ID。

**Interfaces：** 消费已落盘的两旧计划冻结通知、当前代码人工决定、现有 external applicability Schema；产出后续 P1 和 R/B 小计划共用的 Markdown 索引及六项适用性记录。

### P0.1 固定真实工作基线

- [ ] 在 worktree 根执行，只记录 SHA/路径/状态，不输出 secret。

```powershell
$ErrorActionPreference = 'Stop'
git status --short
if ($LASTEXITCODE -ne 0) { throw 'P0_GIT_STATUS_FAILED' }
git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'P0_HEAD_FAILED' }
git branch --show-current
if ($LASTEXITCODE -ne 0) { throw 'P0_BRANCH_FAILED' }
git stash list --format='%H %s'
if ($LASTEXITCODE -ne 0) { throw 'P0_STASH_READ_FAILED' }
```

- [ ] 读两旧计划顶部通知并核对 `457c0011` 只保管原 +207/-53；索引记录实际执行 SHA、Task 5 代码 `1f0b0439`、当前批准引用和 stash 指纹。若通知缺失或旧路线仍能作为入口，停止 P0，不修改 Task 6 提案正文。

### P0.2 运行文档 RED 检查

- [ ] 在修改前运行下面只读断言。当前预期失败原因是“索引缺失/登记空表/旧三决定”；如果已经满足则记录已有结果，不伪造失败。

```powershell
$stage1Problems = [System.Collections.Generic.List[string]]::new()
$stage1IndexPath = 'docs/acceptance/2026-09-06-stage1-mainline-execution-index.md'
if (-not (Test-Path -LiteralPath $stage1IndexPath)) { $stage1Problems.Add('EXECUTION_INDEX_MISSING') }
$stage1Runbook = Get-Content -LiteralPath 'docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md' -Raw
if ($stage1Runbook -match '三个人工决定|三个内部人工决定|三类且各一次|FINAL_VEHICLE_ALLOCATION\s*=\s*1|总计\s*=\s*3') {
  $stage1Problems.Add('LEGACY_THREE_DECISIONS')
}
foreach ($stage1CountPattern in @('FINAL_PLAN_DECISION\s*=\s*1(?!\d)', 'FINAL_VEHICLE_ALLOCATION\s*=\s*0(?!\d)', 'DELIVERY_EVIDENCE_DECISION\s*=\s*1(?!\d)', '其他内部人工决定\s*=\s*0(?!\d)', '总计\s*=\s*2(?!\d)')) {
  if ([regex]::Matches($stage1Runbook, $stage1CountPattern).Count -ne 1) { $stage1Problems.Add('DECISION_COUNT_MISSING_OR_DUPLICATE') }
}
$stage1Registry = Get-Content -LiteralPath 'release/contracts/external-validation-applicability.v1.json' -Raw | ConvertFrom-Json
$stage1ExpectedIds = @('stage1.esign', 'stage1.active-payment', 'stage1.notification', 'stage1.admin', 'stage1.portal', 'stage1.normal-expiry')
foreach ($stage1Id in $stage1ExpectedIds) {
  if (@($stage1Registry.records | Where-Object applicabilityId -eq $stage1Id).Count -ne 1) {
    $stage1Problems.Add("APPLICABILITY_MISSING_OR_DUPLICATE:$stage1Id")
  }
}
if ($stage1Problems.Count -gt 0) { throw ($stage1Problems -join ',') }
'P0_DOCUMENT_CONTRACT_PASS'
```

### P0.3 建立单一执行索引

- [ ] 用 apply_patch 创建索引，完整初始内容如下。页首实际执行 SHA/批准引用/日期由 P0.1 的真实输出记录；它们不能预填为未来候选 SHA 或伪证明。

```markdown
# Stage 1 主线执行索引

状态：P0 交接中；未经 P1 批准不启动本地数据库。真实来源/签发/部署仍未授权。

范围：A/B进件—审核—方案/预约—单次确认—签约归档—主动支付/核销—交付激活—账单/催收—无争议正常结束。

历史代码基线：Task 5 1f0b0439。Task 6 提案保管：457c0011，不代表批准。
Task 6/29R/30/I 系列冻结，Task 30 stash 不变。
执行入口：../superpowers/plans/2026-09-06-stage1-p0-p1-admission-implementation-plan.md

| 项目                                     | 初始状态          | 证据/限制                                                               |
| ---------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| 本轮执行 SHA、批准引用、日期、stash 指纹 | P0.1 实际记录     | 只填真实观察                                                            |
| 两项人工决定                             | 待口径核对        | FINAL_PLAN_DECISION、DELIVERY_EVIDENCE_DECISION；车辆分配不另加内部批准 |
| PG17 身份/迁移状态                       | NOT_RUN           | P1                                                                      |
| Schema validate / 实际 DB diff           | NOT_RUN           | 二者分别记录，不互相替代                                                |
| unit / 五项主线 DB suite                 | NOT_RUN           | P1，非候选全量证明                                                      |
| 合法副本及读取/使用授权                  | INPUT_UNAVAILABLE | 当前未找到；只读盘点后更新                                              |
| WSL/LUKS/宿主分页/备份排除               | NOT_VERIFIED      | 不等于已允许获取数据                                                    |
| 唯一可信 CI build proof                  | NOT_RUN           | R1/A2，不创建本地候选替代                                               |
| 人工 launch authorization                | NOT_IMPLEMENTED   | R1/R2                                                                   |
| Admin/Portal 浏览器                      | NOT_RUN           | A1/A3                                                                   |
| 电子签/主动支付/通知                     | NOT_RUN           | 外部验证独立登记                                                        |
| 成熟正常结束/两次有效维护                | NOT_RUN           | B5/B6/A1/A3                                                             |
| Stage 1 签字                             | BLOCKED           | 以上实际验收条件未完成                                                  |

私密原件只记录受控索引和脱敏 digest；不入库原始 URL、凭证、客户/订单标识或合同。

每次运行记录：执行 SHA、命令、时间、精确退出码、测试计数、非秘密目标身份、原件位置/digest、失败阶段、下一责任包。没有输出就保留 NOT_RUN，不根据历史测试数填通过。
```

### P0.4 对齐既有 Runbook

- [ ] 用 apply_patch 修改 Runbook 的“范围/第5节/第6节/最终核验”四处口径，不删除车辆预约或自动分配动作：
  - 顶部增加“执行入口转 P0/P1；本 Runbook 是后续验收清单，不授权 production/Staging 操作”及相对链接。
  - “三类且各一次”改为两类：`FINAL_PLAN_DECISION`、`DELIVERY_EVIDENCE_DECISION`。
  - 第5节第4步改为“系统基于已确认方案及预约事实完成车辆分配；使用专用非运营车辆，不新增 FINAL_VEHICLE_ALLOCATION 内部批准”。
  - 第6节标题改为“两个人工决定核验”；计数块替换为下面内容；最终“各自只有三个”改为“各自只有两个”。客户确认仍为一次，不计为内部人工决定。

```text
FINAL_PLAN_DECISION         = 1
FINAL_VEHICLE_ALLOCATION    = 0
DELIVERY_EVIDENCE_DECISION  = 1
其他内部人工决定            = 0
总计                        = 2
```

### P0.5 填入外部适用性要求

- [ ] 按已有 Schema 替换空 records；若运行时已经有别的记录，保留并按 applicabilityId 合并，不覆盖。以下是要求，不是执行结果；owner 是当前验收责任人，日期为本轮需求基线日期，执行日另记索引。

```json
{
  "schemaVersion": "external-validation-applicability.v1",
  "records": [
    {
      "applicabilityId": "stage1.esign",
      "relatedSuiteId": "api.subscription-journey-golden-path.postgres",
      "status": "must-external-verify",
      "owner": "keqi119",
      "reason": "真实电子签与归档文件联通不能由模拟 provider 证明",
      "reviewDate": "2026-09-06"
    },
    {
      "applicabilityId": "stage1.active-payment",
      "relatedSuiteId": "api.billing-automation.postgres",
      "status": "must-external-verify",
      "owner": "keqi119",
      "reason": "真实主动支付、回调与核销需独立许可和到账证据",
      "reviewDate": "2026-09-06"
    },
    {
      "applicabilityId": "stage1.notification",
      "relatedSuiteId": "api.billing-automation.postgres",
      "status": "must-external-verify",
      "owner": "keqi119",
      "reason": "主线通知及催收投递需实际供应商或渠道结果",
      "reviewDate": "2026-09-06"
    },
    {
      "applicabilityId": "stage1.admin",
      "relatedSuiteId": "api.subscription-journey-golden-path.postgres",
      "status": "must-human-verify",
      "owner": "keqi119",
      "reason": "Admin 权限、等待和交付页面需浏览器及人工验收",
      "reviewDate": "2026-09-06"
    },
    {
      "applicabilityId": "stage1.portal",
      "relatedSuiteId": "api.subscription-journey-golden-path.postgres",
      "status": "must-human-verify",
      "owner": "keqi119",
      "reason": "Portal A 线及单次客户确认需真实界面验收",
      "reviewDate": "2026-09-06"
    },
    {
      "applicabilityId": "stage1.normal-expiry",
      "relatedSuiteId": "api.subscription-expiry-return.postgres",
      "status": "must-human-verify",
      "owner": "keqi119",
      "reason": "完整来源成熟样本的无争议正常结束与两次有效维护需签字",
      "reviewDate": "2026-09-06"
    }
  ]
}
```

### P0.6 GREEN、独立审查和精确提交

- [ ] 重跑 P0.2 原样断言，预期 `P0_DOCUMENT_CONTRACT_PASS`。再核对两个批准代码各一次、allocation 为零、总计2；不能靠删整个计数段通过。
- [ ] 只运行以下已有测试/静态门禁。禁止执行同名不带 `--test` 的 production preflight。

```powershell
pnpm release:contracts:verify
if ($LASTEXITCODE -ne 0) { throw 'P0_CONTRACTS_FAILED' }
pnpm release:database-tests:discover
if ($LASTEXITCODE -ne 0) { throw 'P0_APPLICABILITY_DISCOVERY_FAILED' }
node --test scripts/stage1-golden-path-production-preflight.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'P0_PREFLIGHT_UNIT_FAILED' }
pnpm exec prettier --write docs/acceptance/2026-09-06-stage1-mainline-execution-index.md docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md release/contracts/external-validation-applicability.v1.json
if ($LASTEXITCODE -ne 0) { throw 'P0_FORMAT_FAILED' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'P0_DIFF_FAILED' }
```

- [ ] 独立审查只核对三文件、两决定、六记录、旧入口冻结和“未运行不标绿”。记录本地数据库/迁移**未运行**。通过后只暂存这三个文件，并核对 cached diff；存在其他 staged 文件则停止，不替别人提交。

```powershell
git add -- docs/acceptance/2026-09-06-stage1-mainline-execution-index.md docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md release/contracts/external-validation-applicability.v1.json
if ($LASTEXITCODE -ne 0) { throw 'P0_STAGE_FAILED' }
git diff --cached --name-only
if ($LASTEXITCODE -ne 0) { throw 'P0_SCOPE_FAILED' }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'P0_STAGED_DIFF_FAILED' }
git commit -m "docs: align Stage1 acceptance scope and execution index"
if ($LASTEXITCODE -ne 0) { throw 'P0_COMMIT_FAILED' }
```

### P0.7 立即并行启动只读材料盘点

- [ ] P0 提交后，不等 P1/R2，向 owner 确认已有私密副本/授权的**索引位置**；不要求发送密钥。只对 owner 指定且允许读取的元数据核对来源、digest、扫描/期限、读取与使用许可。未提供就保留 INPUT_UNAVAILABLE，不自行搜索秘密或导出。
- [ ] 只读列出本机 WSL、加密工具和宿主保护材料是否存在；未知状态记 NOT_VERIFIED，不 sudo、不改 swap、不重启、不挂载/格式化、不读取 raw payload。盘点人员只交回报告，主控是执行索引的唯一写入者，与 P1 更新串行合入并独立文档提交；不能让“盘点通过”授权 R3 获取数据。

---

## P1：受控本地 PG17 与主线测试基线

**批准范围：** 本机 Docker 的新隔离合成数据库及其精确回收；已有源码测试/生成产物；索引一文件修改。不包含真实副本、Staging、源库或签发。

**Files：** Modify P0 创建的执行索引；Consume 下列已存在脚本和测试，不创建/修改它们：

- `scripts/release/bootstrap-controlled-postgres.mjs`、`with-controlled-target.mjs`
- `scripts/release/run-database-suite.mjs`、`database-test-launcher-runtime.mjs`
- `release/contracts/postgres-image.v1.json`、`database-test-manifest.v1.json`
- `scripts/release/bootstrap-controlled-postgres.test.mjs`、`database-test-launcher-cli.test.mjs`
- `apps/api/package.json` 的 `test:unit` 与下列五个实际 DB suite

**Interfaces：** bootstrap 生成 `.release-local/controlled-target.v1.json`；wrapper 仅接受现有 migrate/verify/runtime-test。独立 suite launcher 自行 provision/迁移/角色注入/Schema diff/计数/保管/回收，不从 wrapper 借 URL。

### P1.1 准入与环境拒绝条件

- [ ] 确认 P0 提交及 P1 明确批准，读取索引/AGENTS.md。执行 git status/HEAD/stash 并立即核对退出码，记录本次 SHA。除索引盘点更新外存在不明修改则停止；不消除他人修改。
- [ ] 下列仅检查环境**名称**，不输出值。已存在 controlled record/secrets 时停止，不覆盖、不清空；先另行核验原任务及生命周期。Docker 不可用不自动更换远程 host。

```powershell
$ErrorActionPreference = 'Stop'
$stage1Ambient = @(Get-ChildItem Env: | Where-Object {
  $_.Name -match 'DATABASE_URL$|^(PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGSERVICE)$'
})
if ($stage1Ambient.Count -gt 0) { throw 'P1_AMBIENT_DATABASE_ENV_PRESENT' }
if (Test-Path Env:DOCKER_HOST) { throw 'P1_DOCKER_HOST_OVERRIDE_PRESENT' }
if ((Test-Path -LiteralPath '.release-local/controlled-target.v1.json') -or
    (Test-Path -LiteralPath '.release-local/secrets')) { throw 'P1_EXISTING_TARGET_REQUIRES_RECONCILIATION' }
docker context show
if ($LASTEXITCODE -ne 0) { throw 'P1_DOCKER_CONTEXT_FAILED' }
$stage1DockerEndpoint = docker context inspect --format '{{(index .Endpoints "docker").Host}}'
if ($LASTEXITCODE -ne 0) { throw 'P1_DOCKER_ENDPOINT_FAILED' }
if ($stage1DockerEndpoint -notmatch '^(npipe|unix)://') { throw 'P1_REMOTE_DOCKER_FORBIDDEN' }
docker info --format '{{.Name}} {{.OSType}}'
if ($LASTEXITCODE -ne 0) { throw 'P1_DOCKER_UNAVAILABLE' }
git check-ignore .release-local/controlled-target.v1.json
if ($LASTEXITCODE -ne 0) { throw 'P1_PRIVATE_OUTPUT_NOT_IGNORED' }
```

确认 context 指向本机 Docker，而非 SSH/TCP 远端；无法证明即停止。不得因为测试环境错误而改产品代码。

### P1.2 先测已有控制入口，再建唯一临时目标

- [ ] 运行 bootstrap/launcher CLI 单元测试，预期失败/skip/cancel 为0；这里不新增测试、不伪造 RED。

```powershell
node --test scripts/release/bootstrap-controlled-postgres.test.mjs scripts/release/database-test-launcher-cli.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'P1_LAUNCHER_UNIT_FAILED' }
```

- [ ] 建受控临时目标，记录实际 image digest、serverVersionNum、容器/runId/marker、数据库名/OID和角色。必须为 PG17；不要输出 `.release-local/secrets`。

```powershell
node scripts/release/bootstrap-controlled-postgres.mjs --output .release-local/controlled-target.v1.json
if ($LASTEXITCODE -ne 0) { throw 'P1_CONTROLLED_BOOTSTRAP_FAILED' }
```

### P1.3 迁移身份自检与源码 Schema 校验

当前 bootstrap 的 verify 仅有 CONNECT，没有 `_prisma_migrations` SELECT。因此本 P1 明确沿用现有 suite launcher 的做法，由 migrate 身份执行 status/diff，**仅称迁移身份自检，不称独立只读 verify**。不为开发基线增加临时授权修复，也不借此放宽 R2/候选的独立只读角色门禁；该门禁仍未完成。

- [ ] 只在上述**新空临时库**执行迁移；migrate profile 成功后 wrapper 更新 migration head。失败即停止，保留目标身份，不继续用 validate 宣称通过。

```powershell
node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
if ($LASTEXITCODE -ne 0) { throw 'P1_MIGRATION_DEPLOY_FAILED' }
```

- [ ] 使用 migrate profile 核对 status 与实际 DB diff；它们是只读操作但使用迁移身份，与前一步为不同调用。status 非0/pending 或 diff 非0均停止，不运行 migrate reset。

```powershell
node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
if ($LASTEXITCODE -ne 0) { throw 'P1_MIGRATION_STATUS_FAILED' }
node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
if ($LASTEXITCODE -ne 0) { throw 'P1_DATABASE_SCHEMA_DIFF_FAILED' }
```

- [ ] verify profile 下只运行源码 Schema validate；不把它称为对迁移表或业务事实的独立验证。

```powershell
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:validate
if ($LASTEXITCODE -ne 0) { throw 'P1_SCHEMA_VALIDATE_FAILED' }
```

- [ ] 保存本 P1.3 实际会话输出、退出码及 migration head，明确为开发自检原始记录，不伪造 execution proof。validate 只校验源码 Schema；P1.5 的 suite 内也执行迁移/Schema 检查，但当前不会单独持久化其原始输出，不声称存在该类原件。

### P1.4 构建依赖并跑 unit 基线

- [ ] Shared build 完成后，在 wrapper 下 generate；禁止裸 Prisma 命令读取仓库 `.env`。

```powershell
pnpm --filter @subscription-saas/shared build
if ($LASTEXITCODE -ne 0) { throw 'P1_SHARED_BUILD_FAILED' }
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:generate
if ($LASTEXITCODE -ne 0) { throw 'P1_PRISMA_GENERATE_FAILED' }
```

- [ ] 用当前真实 `test:unit`，而非 API `test`（后者会连带 source-gate）。wrapper 会清理继承 DB 环境并设置 `STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV=1`；不得改为共享 public URL。

```powershell
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm --filter @subscription-saas/api test:unit
if ($LASTEXITCODE -ne 0) { throw 'P1_API_UNIT_FAILED' }
```

记录真实 passed/failed/skipped/todo/cancelled 及失败文件；缺日志不填历史数字。未通过则提交失败审计/最小修复建议供批准，不在 P1 直接修改服务或测试。

### P1.5 全仓发现与五个主线 fresh suite

- [ ] 运行全仓发现门禁，失败就列出漏分类/漏选文件，不删测试或增加 skip 以通过。

```powershell
pnpm release:database-tests:discover
if ($LASTEXITCODE -ne 0) { throw 'P1_TEST_DISCOVERY_FAILED' }
```

- [ ] 逐套运行下列真实 launcher。它们各自创建独立测试集群/数据库并注入分离角色；**不要**再套 with-controlled-target，不传 `--profile localdev`、`--output` 或 ambient URL。

```powershell
node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-golden-path.postgres --chain fresh
if ($LASTEXITCODE -ne 0) { throw 'P1_GOLDEN_PATH_FAILED' }
node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-integrity.postgres --chain fresh
if ($LASTEXITCODE -ne 0) { throw 'P1_INTEGRITY_FAILED' }
node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-failure-recovery.postgres --chain fresh
if ($LASTEXITCODE -ne 0) { throw 'P1_FAILURE_RECOVERY_FAILED' }
node scripts/release/run-database-suite.mjs --suite-id api.billing-automation.postgres --chain fresh
if ($LASTEXITCODE -ne 0) { throw 'P1_BILLING_AUTOMATION_FAILED' }
node scripts/release/run-database-suite.mjs --suite-id api.subscription-expiry-return.postgres --chain fresh
if ($LASTEXITCODE -ne 0) { throw 'P1_EXPIRY_RETURN_FAILED' }
```

每套结束再开始下一套，失败/UNKNOWN 即停止当前串行批次；其他尚未运行项保留 NOT_RUN。禁止共用失败目标、手动宽泛 cleanup 或自动重试。

- [ ] 逐套核对输出及 `.release-local` 中实际生成的 suite report/custody/incident：`collected = selected = executed = passed > 0`，failed/skipped/todo/filtered/cancelled 均0；只登记实际报告中的目标、角色边界、日志摘要和 custody readback。当前 suite 模式的迁移/Schema/PG版本观察并非独立保管原件，只能说明受审 launcher 在执行时做过这些检查；不得从内存摘要补造证明。控制台 exit0而缺应有报告/计数仍不通过。成功 launcher 已自行按精确身份回收；失败资源保留供有范围的 reconcile，不另外扫库删除。

这五套只构成主线开发基线，不是候选全量清单；golden-path 的确定性 provider 也不是供应商联通或浏览器证明。

### P1.6 结果保管、精确回收与交付

- [ ] 在索引记录每个实际命令、退出码、身份/迁移结论、计数和非秘密证据引用。原件从现有 launcher 的实际输出位置独立读回并计算 SHA256；无原件的 unit 控制台记录标为“会话日志”，不能伪造 execution proof。禁止把 secrets/raw URL/订单数据提交 Git。
- [ ] 只在证据已读回、没有消费者、与本 P1 创建记录完全匹配时回收 P1.2 临时目标；这是本 P1 明列的本地合成目标回收，不适用于别的任务/数据。

```powershell
node scripts/release/bootstrap-controlled-postgres.mjs --cleanup .release-local/controlled-target.v1.json
if ($LASTEXITCODE -ne 0) { throw 'P1_EXACT_CLEANUP_FAILED' }
```

cleanup 不代表私密文件已删除。保留受保护 record/incident/证据以便复核，不声称原始敏感数据已销毁（本 P1 不含真实敏感数据）。任何失败回收只写 BLOCKED 和精确目标指纹，不使用通配删除。

- [ ] 独立审查索引与原件，确认无生产代码改动、无 stash 变化；区分“开发准入通过”“发布/真实双链/人工验收未运行”。只对索引格式和 diff 验证并提交。

```powershell
pnpm exec prettier --write docs/acceptance/2026-09-06-stage1-mainline-execution-index.md
if ($LASTEXITCODE -ne 0) { throw 'P1_INDEX_FORMAT_FAILED' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'P1_DIFF_FAILED' }
git status --short
if ($LASTEXITCODE -ne 0) { throw 'P1_STATUS_FAILED' }
git add -- docs/acceptance/2026-09-06-stage1-mainline-execution-index.md
if ($LASTEXITCODE -ne 0) { throw 'P1_STAGE_FAILED' }
git diff --cached --name-only
if ($LASTEXITCODE -ne 0) { throw 'P1_SCOPE_FAILED' }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'P1_STAGED_DIFF_FAILED' }
```

确认 cached 仅索引一文件后执行：

```powershell
git commit -m "docs: record controlled Stage1 development baseline"
if ($LASTEXITCODE -ne 0) { throw 'P1_COMMIT_FAILED' }
```

## 批准与交付判定

- P0 独立通过：三文件口径一致、静态门禁通过、真实 DB/供应商/签字仍标未运行。
- P1 独立通过：无 ambient、控制脚本通过、PG17身份和迁移侧 status/diff 明确、unit 与五项 suite 的实际报告齐全、证据可读回、精确回收有结果；不等于业务完成或独立 DB verify。后者仍由 R2/最终候选真实证明。
- 任一失败：记录具体反例、缺失材料、受影响出口和下一责任包；不把本地基础设施失败误报产品回归，不暗自修复。
- 通过后只**申请**首批 B1/B3/B5 与 R1/R2 小计划审批，不自动施工；P0 后的副本可用性盘点已并行，不再等 R2 才发现缺输入。
- 真实副本、本机安全改动、密钥、Staging、外部服务及旧路线仍各自阻断；OSS/210 天 WORM 不动。
