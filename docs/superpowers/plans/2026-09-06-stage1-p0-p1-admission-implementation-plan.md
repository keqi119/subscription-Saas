# Stage 1 P0/P1 范围交接与受控开发准入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用两个可独立批准的任务建立唯一验收口径和真实本地开发基线，不启动发布平台或业务修复。

**Architecture:** P0 只交接文档/适用性契约；P1 只消费现有隔离 launcher，在无客户数据的本地 PG17 上运行迁移和已有测试。结果进入同一执行索引，失败按证据归属后续小计划，不自动修产品代码。

**Tech Stack:** 现有 PowerShell、Node/pnpm、Docker、按 digest 固定的 PostgreSQL 17、Prisma、node:test/Vitest；不新增依赖或云服务。

**Spec:** [最小受控发布决策](../specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md) §1/2/4.1/5/6；[覆盖路线图](./2026-09-06-stage1-mainline-minimal-release-implementation-plan.md)。

**Status:** P0 已按用户对 `5b4cd68d` 的本轮评审独立批准，尚未执行；P1 待局部终审，禁止执行。本文不批准 R1–R4 的实现，不以这些包细化完成为前置。

本次仅修订两项剩余 P1：删除前可审计的串行门禁，以及新目标的完整精确回收。P0 内容与已批准边界不变；不重开路线/安全架构，不启动 P0/P1。P1.0 的实际旧目标退役仍须单独批准。

## Global Constraints

- Task 6、29R/30、I 系列冻结；Task 0–5 保留。旧在途计划已独立保管为 `457c0011`，不等于获批。
- 不修改产品代码、数据库业务结构、权限码、开关或历史迁移，不触碰冻结 stash。
- P0 不连接数据库；P1.0 仅核查并在独立批准后退役列明的旧 Task 0 本地目标，P1.2 才新建无客户数据的临时数据库；绝不使用 ambient DATABASE_URL、Staging 或 production。
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

P0 修改的 external applicability 已纳入 repository contract，会改变 repositoryContractDigest；后续候选必须重新生成可信 build-proof.v1，不能沿用改动前的证明。这不改变运行时业务行为。

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
$stage1LegacyPattern = '三个人工决定|三个内部人工决定|三类且各一次|三个\s+ManualTask|FINAL_VEHICLE_ALLOCATION\s*=\s*1|总计\s*=\s*3'
$stage1LegacyCount = [regex]::Matches($stage1Runbook, $stage1LegacyPattern).Count
if ($stage1LegacyCount -ne 0) { $stage1Problems.Add("LEGACY_THREE_DECISIONS:$stage1LegacyCount") }
if ([regex]::Matches($stage1Runbook, '两个\s+ManualTask').Count -ne 1) { $stage1Problems.Add('TWO_MANUALTASK_EVIDENCE_MISSING_OR_DUPLICATE') }
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

- [ ] 用 apply_patch 修改 Runbook 的“范围/第5节/第6节/第10节证据包/最终核验”五处口径，不删除车辆预约或自动分配动作：
  - 顶部增加“执行入口转 P0/P1；本 Runbook 是后续验收清单，不授权 production/Staging 操作”及相对链接。
  - “三类且各一次”改为两类：`FINAL_PLAN_DECISION`、`DELIVERY_EVIDENCE_DECISION`。
  - 第5节第4步改为“系统基于已确认方案及预约事实完成车辆分配；使用专用非运营车辆，不新增 FINAL_VEHICLE_ALLOCATION 内部批准”。
  - 第6节标题改为“两个人工决定核验”；计数块替换为下面内容；最终“各自只有三个”改为“各自只有两个”。客户确认仍为一次，不计为内部人工决定。
  - 第10节“`三个 ManualTask 的类型、决定结果和审计事件引用`”改为“`两个 ManualTask 的类型、决定结果和审计事件引用`”；不能只改时间线计数而遗漏证据包要求。

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

- [ ] 重跑 P0.2 原样断言，预期 `P0_DOCUMENT_CONTRACT_PASS` 且 `stage1LegacyCount=0`，覆盖第10节 `三个\s+ManualTask` 及所有已知旧“三决定”表达。再核对两个批准代码各一次、allocation 为零、总计2，并保留“两个 ManualTask”证据条目；不能靠删整个计数段/证据条目通过。
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

**批准范围：** 旧 Task 0 目标的限定只读核查、本机 Docker 新隔离合成数据库及其精确回收、已有源码测试/生成产物、索引一文件修改。旧目标删除/凭证归档须 P1.0 单独批准；不包含真实副本、Staging、源库或签发。

**Files：** Modify P0 创建的执行索引；Consume 下列已存在脚本和测试，不创建/修改它们：

- `scripts/release/bootstrap-controlled-postgres.mjs`、`with-controlled-target.mjs`
- `scripts/release/run-database-suite.mjs`、`database-test-launcher-runtime.mjs`
- `release/contracts/postgres-image.v1.json`、`database-test-manifest.v1.json`
- `scripts/release/bootstrap-controlled-postgres.test.mjs`、`database-test-launcher-cli.test.mjs`
- `apps/api/package.json` 的 `test:unit` 与下列五个实际 DB suite

**Interfaces：** bootstrap 生成 `.release-local/controlled-target.v1.json`；wrapper 仅接受现有 migrate/verify/runtime-test。独立 suite launcher 自行 provision/迁移/角色注入/Schema diff/计数/保管/回收，不从 wrapper 借 URL。

本机新增资产仅为 `.release-local/p1-lifecycle.lock`、`p1-operations/<UUID>` 的会话/门禁/checkpoint/回读文件，以及 `p1-retirements/<UUID>` 的登记与五文件归档；全部只在获批执行时生成、保持 Git ignored，不增加产品/Runner/Schema/工作流文件。

### P1 本地记录约定（只用于本次开发会话）

P1 获批后，在 worktree 根的同一个 PowerShell 7 会话定义以下 helper；**不写入仓库脚本，不成为 Runner/Schema/发布入口**。每次命令独立 UUID 目录，固定根 `.release-local/p1-operations`，只保存受控本地输出。原始输出可能包含调试信息，必须 owner-only，不上传、不贴聊天；Git 索引只收脱敏摘要。

- [ ] 确认本机 Docker context 非远端、没有 ambient DB URL/DOCKER_HOST；检查本工作树及 `.release-local` 无重解析点。不因 P1.0 要处理旧目标而清空环境或跳过身份校验。
- [ ] 定义 helper。suite 即使 exit1 也先读回已存在的 FAILED report/receipt，再停止。

```powershell
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'P1_POWERSHELL7_REQUIRED' }
$stage1P1Root = [IO.Path]::GetFullPath((Join-Path (Get-Location) '.release-local/p1-operations'))
$stage1Owner = "$env:USERDOMAIN\$env:USERNAME"
if ($stage1Owner -notmatch '^[^\\]+\\[^\\]+$') { throw 'P1_OWNER_UNAVAILABLE' }
$stage1P1Operations = [System.Collections.Generic.List[object]]::new()

function Get-P1LocalPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'P1_LOCAL_PATH_MISSING' }
  $root = [IO.Path]::GetFullPath((Join-Path (Get-Location) '.release-local'))
  $absolute = [IO.Path]::GetFullPath($Path)
  if ($absolute -ne $root -and -not $absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'P1_LOCAL_PATH_ESCAPE' }
  $cursor = $absolute
  while ($cursor.Length -ge $root.Length) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'P1_REPARSE_POINT_FORBIDDEN' }
    $cursor = Split-Path $cursor -Parent
  }
  return $absolute
}

function Invoke-P1Recorded {
  [CmdletBinding(DefaultParameterSetName='Native',PositionalBinding=$false)]
  param([Parameter(Position=0)][string]$Step,
    [Parameter(Mandatory,Position=1,ParameterSetName='Native')][string]$Program,
    [Parameter(Position=2,ParameterSetName='Native')][string[]]$Argv,
    [Parameter(Mandatory,ParameterSetName='LocalAction')][scriptblock]$Action)
  $operationId = [guid]::NewGuid().ToString()
  $dir = Get-P1LocalPath (Join-Path $stage1P1Root $operationId)
  New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null
  icacls $dir /inheritance:r /grant:r ($stage1Owner + ':(OI)(CI)F') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'P1_LOG_ACL_FAILED' }
  $sourceSha = git rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw 'P1_LOG_SOURCE_FAILED' }
  $startedAt = [DateTime]::UtcNow.ToString('o')
  $beforeRuns = @()
  if (Test-Path -LiteralPath '.release-local/runs') {
    $beforeRuns = @(Get-ChildItem -LiteralPath '.release-local/runs' -Directory | Select-Object -ExpandProperty Name)
  }
  if ($PSCmdlet.ParameterSetName -eq 'LocalAction') { $Program='PowerShell-local-plan'; $Argv=@($Action.ToString()) }
  $command = [ordered]@{operationId=$operationId;step=$Step;sourceSha=$sourceSha;program=$Program;argv=$Argv;startedAt=$startedAt;beforeRunIds=$beforeRuns}
  $utf8 = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText((Join-Path $dir 'command.json'), ($command | ConvertTo-Json -Depth 8), $utf8)
  $nativeExit = $null
  $oldNativePreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  Start-Transcript -Path (Join-Path $dir 'session.log') -NoClobber | Out-Null
  try {
    Write-Host "operation=$operationId step=$Step source=$sourceSha start=$startedAt"
    if ($PSCmdlet.ParameterSetName -eq 'LocalAction') {
      & $Action $dir $operationId 1> (Join-Path $dir 'stdout.log') 2> (Join-Path $dir 'stderr.log')
      $nativeExit = 0 # 仅整个同步 block 正常返回；每个 native exit 由 block 当场检查。
    } else {
      & $Program @Argv 1> (Join-Path $dir 'stdout.log') 2> (Join-Path $dir 'stderr.log')
      $nativeExit = $LASTEXITCODE
    }
    Write-Host "nativeExit=$nativeExit"
  } catch {
    if ($PSCmdlet.ParameterSetName -eq 'LocalAction') { $nativeExit=1 }
    Write-Host 'P1_COMMAND_ABORTED'
  } finally {
    $finishedAt = [DateTime]::UtcNow.ToString('o')
    Write-Host "finish=$finishedAt nativeExit=$nativeExit"
    Stop-Transcript | Out-Null
    $PSNativeCommandUseErrorActionPreference = $oldNativePreference
  }
  $afterRuns = @()
  if (Test-Path -LiteralPath '.release-local/runs') {
    $afterRuns = @(Get-ChildItem -LiteralPath '.release-local/runs' -Directory | Select-Object -ExpandProperty Name)
  }
  $hashes = [ordered]@{}
  foreach ($name in @('command.json','stdout.log','stderr.log','session.log')) {
    $file = Join-Path $dir $name
    if (Test-Path -LiteralPath $file) { $hashes[$name] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  $result = [ordered]@{operationId=$operationId;exitCode=$nativeExit;finishedAt=$finishedAt;newRunIds=@($afterRuns | Where-Object { $_ -notin $beforeRuns });fileHashes=$hashes}
  [IO.File]::WriteAllText((Join-Path $dir 'result.json'), ($result | ConvertTo-Json -Depth 8), $utf8)
  $operation = [pscustomobject]@{Directory=$dir;OperationId=$operationId;ExitCode=$nativeExit}
  $stage1P1Operations.Add($operation)
  Write-Host "P1_OPERATION_DIRECTORY=$dir"
  return $operation
}
```

`command.json/result.json` 是普通会话元数据，不带新 Schema、不称 execution proof。本地 operationId 与已有 launcher 报告的 operationId/runId 分开记录。重开终端先根据原目录核对原件；缺 result、exitCode 为 null、硬中断或 transcript 未关闭均记 INTERRUPTED_UNKNOWN，不覆盖/盲重试。

`LocalAction` 只供下文两处共享退役 block 使用，不是仓库 CLI 或任意脚本入口。它与 native 分支共用独立 operation/transcript/退出码记录；部分删除后 block 抛错即使记录 exit1，也仍按处置阶段记 UNKNOWN，不当成“零副作用失败”。

### P1 suite 的只读回读函数

在 P1.5 前定义；只读本次目录和现有 report/receipt，写入本次目录的 `readback.json/readback-error.log`，不修改原件。没有 report 时仅核对前后新增 runId 的**唯一**差集；不递归扫描 runs（其中有 secret），不凭“最新文件”认领旧结果。

```powershell
function Test-P1SuiteReadback {
  param([string]$OperationDirectory)
  $OperationDirectory = Get-P1LocalPath $OperationDirectory
  if ((Split-Path $OperationDirectory -Parent) -ne $stage1P1Root -or (Split-Path $OperationDirectory -Leaf) -notmatch '^[0-9a-f-]{36}$') { throw 'P1_OPERATION_PATH_INVALID' }
  $readbackFile = Join-Path $OperationDirectory 'readback.json'
  $readbackError = Join-Path $OperationDirectory 'readback-error.log'
  if ((Test-Path -LiteralPath $readbackFile) -or (Test-Path -LiteralPath $readbackError)) { throw 'P1_READBACK_OVERWRITE_REFUSED' }
  @'
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalJson, sha256Canonical, sha256Bytes, normalizeDatabaseTestCounts, assertCustodyComplete } from "./packages/release-foundation/src/index.mjs";
const ensure=(ok,code)=>{if(!ok)throw new Error(code);};
try {
  const dir=process.argv[2];
  const command=JSON.parse(await readFile(path.join(dir,"command.json"),"utf8"));
  const result=JSON.parse(await readFile(path.join(dir,"result.json"),"utf8"));
  ensure(command.operationId===path.basename(dir)&&result.operationId===command.operationId,"P1_LOCAL_OPERATION_MISMATCH");
  ensure(command.sourceSha===execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),"P1_SOURCE_CHANGED");
  ensure(command.program==="node"&&command.argv[0]==="scripts/release/run-database-suite.mjs","P1_COMMAND_SCOPE");
  const expectedSuite=command.argv[command.argv.indexOf("--suite-id")+1];
  ensure(command.argv[command.argv.indexOf("--chain")+1]==="fresh","P1_CHAIN_SCOPE");
  for(const name of ["command.json","stdout.log","stderr.log","session.log"]){
    const bytes=await readFile(path.join(dir,name));
    ensure(sha256Bytes(bytes)==="sha256:"+result.fileHashes[name],"P1_TRANSCRIPT_BYTES_CHANGED");
  }
  ensure(Number.isInteger(result.exitCode),"P1_NATIVE_EXIT_UNKNOWN");
  const stdoutBytes=await readFile(path.join(dir,"stdout.log"));
  const decode=b=>b[0]===255&&b[1]===254?b.subarray(2).toString("utf16le"):b.toString("utf8").replace(/^\uFEFF/,"");
  let report;
  try { report=JSON.parse(decode(stdoutBytes).trim()); ensure(report&&typeof report==="object"&&!Array.isArray(report),"P1_REPORT_TYPE"); } catch {
    report=undefined;
    const ids=result.newRunIds;
    const incidentPaths=[];
    if(Array.isArray(ids)&&ids.length===1&&/^[0-9a-f-]{36}$/i.test(ids[0])){
      const file=path.join(".release-local/runs",ids[0],"incident.json");
      try { const b=await readFile(file); const incident=JSON.parse(b); ensure(incident.runId===ids[0],"P1_INCIDENT_RUN_MISMATCH"); incidentPaths.push({file,bytesDigest:sha256Bytes(b),runId:incident.runId,errorCode:incident.errorCode}); }
      catch(e){if(e.code!=="ENOENT")throw e;}
    }
    console.log(JSON.stringify({localOperationId:command.operationId,status:"UNKNOWN_OR_MISSING_REPORT",nativeExit:result.exitCode,newRunIds:ids,incidentPaths}));
    process.exitCode=1;
  }
  if(report){
    ensure(report.schemaVersion==="database-suite-report.v1"&&report.suiteId===expectedSuite&&report.chain==="fresh","P1_REPORT_SCOPE");
    ensure(/^[0-9a-f-]{36}$/i.test(report.runId)&&/^[0-9a-f-]{36}$/i.test(report.operationId),"P1_REPORT_ID");
    const manifest=JSON.parse(await readFile("release/contracts/database-test-manifest.v1.json","utf8"));
    const discovery=JSON.parse(await readFile("release/contracts/database-test-discovery.v1.json","utf8"));
    ensure(report.manifestDigest===sha256Canonical(manifest)&&report.discoveryDigest===sha256Canonical(discovery),"P1_TEST_INPUT_CHANGED");
    const suite=manifest.suites.find(s=>s.suiteId===expectedSuite);
    ensure(suite?.chainApplicability?.fresh?.status==="required","P1_SUITE_NOT_REQUIRED");
    const counts=normalizeDatabaseTestCounts(report.counts,suite.expectedCountPolicy);
    ensure(counts.collected>0,"P1_EMPTY_SUITE");
    const digest=sha256Canonical(report), key="evidence/"+digest.slice(7)+".json";
    const storedPath=path.join(".release-local/evidence",key), stored=await readFile(storedPath);
    ensure(sha256Bytes(stored)===digest&&stored.equals(Buffer.from(canonicalJson(report),"utf8")),"P1_STORED_REPORT_MISMATCH");
    const receiptRoot=".release-local/evidence/receipts", matches=[];
    const attestation="local-controlled-nonpromotable://"+report.runId+"/"+expectedSuite;
    for(const name of await readdir(receiptRoot)){
      if(!/^[0-9a-f-]{36}\.json$/i.test(name))continue;
      const file=path.join(receiptRoot,name), bytes=await readFile(file), receipt=JSON.parse(bytes);
      if(receipt.contentDigest===digest&&receipt.attestationRef===attestation)matches.push({file,bytes,receipt});
    }
    ensure(matches.length===1,"P1_RECEIPT_MISSING_OR_AMBIGUOUS");
    const {file,bytes,receipt}=matches[0];
    assertCustodyComplete(receipt,digest);
    ensure(path.basename(file)===receipt.receiptId+".json"&&receipt.storeRef==="local-controlled-nonpromotable://"+key&&receipt.contentSizeBytes===stored.byteLength,"P1_RECEIPT_BINDING");
    ensure(bytes.equals(Buffer.from(canonicalJson(receipt),"utf8")),"P1_RECEIPT_CANONICAL_BYTES");
    ensure(Date.parse(receipt.uploadedAt)>=Date.parse(command.startedAt)&&Date.parse(receipt.readbackAt)<=Date.parse(result.finishedAt),"P1_RECEIPT_OPERATION_WINDOW");
    const expectedExit=counts.failed===0?0:1;
    ensure(result.exitCode===expectedExit&&report.terminalStatus===(expectedExit===0?"PASSED":"FAILED"),"P1_EXIT_REPORT_MISMATCH");
    console.log(JSON.stringify({localOperationId:command.operationId,readback:"VERIFIED",terminalStatus:report.terminalStatus,nativeExit:result.exitCode,runId:report.runId,operationId:report.operationId,suiteId:expectedSuite,counts,target:report.target,stdoutBytesDigest:sha256Bytes(stdoutBytes),storedPath,reportCanonicalDigest:digest,storedBytesDigest:sha256Bytes(stored),receiptPath:file,receiptBytesDigest:sha256Bytes(bytes),sanitizedLogDigest:report.sanitizedLogDigest,logOriginal:"NOT_GUARANTEED_BY_SUITE_CLI"}));
    if(expectedExit!==0)process.exitCode=1;
  }
} catch(e) { console.error(e.code??(/^P1_[A-Z_]+$/.test(e.message??"")?e.message:"P1_READBACK_FAILED")); process.exitCode=1; }
'@ | node --input-type=module - $OperationDirectory 1> $readbackFile 2> $readbackError
  $readbackExit = $LASTEXITCODE
  Get-FileHash -LiteralPath $readbackFile, $readbackError -Algorithm SHA256 | Out-Host
  return $readbackExit
}
```

实际存储根为 `.release-local/evidence`，所以报告文件是 `evidence/evidence/<reportCanonicalDigest去前缀>.json`，receipt 是 `evidence/receipts/<receiptId>.json`，不是 runs 下的 receipt。canonical UTF-8 原字节必须与 contentDigest/readbackDigest 一致；stdout.log 可能有编码/换行，其文件 hash **不要求**等于 report canonical digest。receipt 文件自己的字节 digest 另列，不把 receipt 的 contentDigest 误当 receipt 自身 hash。

成功日志的 sanitizedLogDigest 原件当前不保证落盘；stderr 如有 sanitized diagnostic，保存在本次 stderr.log，但不虚构成功日志原件。正常 PASSED/FAILED 在返回前都可删除 runs/<runId>，因此成功回读不要求目录差集仍有 runId；绑定本次 stdout 原件 hash、report UUID、receipt 的内容/attestation/时间窗。只有缺 report 的异常分支才用目录差集定位 incident。启动早期失败、硬中断也可能无 incident：保留 transcript/result/差集并记 UNKNOWN/原件不足，不假设目标已删或必然保留，不盲目重试/cleanup。

### P1 共享资源登记与 pre-retirement 门禁

以下是本计划的本地同步操作块，不创建仓库模块/Schema。P1.0 与 P1.6 必须调用同一块，不得拆出删除命令手工续跑。`Invoke-P1Recorded -Action` 生成一次全新的 pre-retirement operation；其 `pre-retirement.json`、digest、删除/移动进度、终态和 transcript 共同证明删除前的实际观察。

固定 `.release-local/p1-lifecycle.lock` 使用 `FileShare.None`，从最后复核持续持有到完整回收读回；P1.2 创建/登记也使用同一锁。它只串行化遵守本计划的本地执行，**不是 Docker/数据库跨资源原子事务**。owner 必须先暂停全部潜在消费者和 record 写入者，确认停用窗口覆盖完整操作；无法保证窗口即 BLOCKED。操作中不等待人工批准、不交给后台、不跨会话消费旧 PASS。删除期间另以 `FileShare.Read` 固定 record，允许现有 cleanup 重读，拒绝写入/替换；释放后只做精确归档。

- [ ] 定义以下只读登记 helper。所有新文件用 CreateNew、flush 和读回，禁止覆盖。仅 `database.migrationHead` 可在 P1.3 的批准迁移步骤变化，其余字段必须与初始副本一致；初始 hash 和最终 hash 分开保管。

```powershell
function Write-P1NewJson {
  param([string]$Path, $Value)
  $Path=Get-P1LocalPath $Path
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 30))
  $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Open-P1LifecycleGuard {
  $file=Get-P1LocalPath '.release-local/p1-lifecycle.lock'
  $guard=[IO.File]::Open($file,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {
    icacls $file /inheritance:r /grant:r ($stage1Owner + ':F') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'P1_GUARD_ACL_FAILED' }
    return $guard
  } catch { $guard.Dispose(); throw }
}
function Get-P1StableRecord {
  param([string]$Path)
  $record=Get-Content -LiteralPath (Get-P1LocalPath $Path) -Raw | ConvertFrom-Json -AsHashtable
  $record.database.Remove('migrationHead') | Out-Null
  return ($record | ConvertTo-Json -Depth 20 -Compress)
}
function Get-P1TargetMount {
  param($Record)
  if (Test-Path Env:DOCKER_HOST) { throw 'P1_DOCKER_HOST_OVERRIDE_PRESENT' }
  if ($Record.container.id -notmatch '^[0-9a-f]{64}$') { throw 'P1_CONTAINER_ID_INVALID' }
  $identity=docker inspect --format '{{.Id}}|{{.Config.Image}}|{{index .Config.Labels "subscription-s1-controlled"}}|{{index .Config.Labels "subscription-s1-controlled.run-id"}}' $Record.container.id
  if ($LASTEXITCODE -ne 0) { throw 'P1_CONTAINER_INSPECT_FAILED' }
  if ($identity -ne ($Record.container.id+'|'+$Record.image.repository+'@'+$Record.image.resolvedDigest+'|v1|'+$Record.container.runId)) { throw 'P1_CONTAINER_IDENTITY_CHANGED' }
  $mountJson=docker inspect --format '{{json .Mounts}}' $Record.container.id
  if ($LASTEXITCODE -ne 0) { throw 'P1_MOUNTS_FAILED' }
  $mount=@(($mountJson | ConvertFrom-Json) | Where-Object Destination -eq '/var/lib/postgresql/data')
  if ($mount.Count -ne 1 -or $mount[0].Type -ne 'volume' -or $mount[0].Name -notmatch '^[0-9a-f]{64}$' -or $mount[0].RW -ne $true) { throw 'P1_VOLUME_SCOPE_INVALID' }
  $owners=@(docker ps -aq --no-trunc --filter ("volume="+$mount[0].Name))
  if ($LASTEXITCODE -ne 0) { throw 'P1_VOLUME_OWNERS_UNKNOWN' }
  if ($owners.Count -ne 1 -or $owners[0] -ne $Record.container.id) { throw 'P1_VOLUME_NOT_EXCLUSIVE' }
  $context=docker context show
  if ($LASTEXITCODE -ne 0) { throw 'P1_CONTEXT_UNKNOWN' }
  $endpoint=docker context inspect --format '{{(index .Endpoints "docker").Host}}'
  if ($LASTEXITCODE -ne 0 -or $endpoint -notmatch '^(npipe|unix)://') { throw 'P1_LOCAL_ENDPOINT_REQUIRED' }
  return [ordered]@{identity=$identity;volume=$mount[0].Name;mount=$mount[0];owners=$owners;context=$context;endpoint=$endpoint}
}
function Save-P1TargetRegistration {
  param([string]$OriginRef)
  if ([string]::IsNullOrWhiteSpace($OriginRef)) { throw 'P1_TARGET_ORIGIN_REQUIRED' }
  $dir=Get-P1LocalPath (Join-Path '.release-local/p1-retirements' ([guid]::NewGuid().ToString()))
  New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null
  icacls $dir /inheritance:r /grant:r ($stage1Owner + ':(OI)(CI)F') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'P1_RETIREMENT_ACL_FAILED' }
  $source=Get-P1LocalPath '.release-local/controlled-target.v1.json'
  $hash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  Copy-Item -LiteralPath $source -Destination (Join-Path $dir 'record-initial.json') -ErrorAction Stop
  if ((Get-FileHash -LiteralPath (Join-Path $dir 'record-initial.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'P1_INITIAL_RECORD_CHANGED' }
  $record=Get-Content -LiteralPath $source -Raw | ConvertFrom-Json
  $mount=Get-P1TargetMount $record
  $digest=Write-P1NewJson (Join-Path $dir 'target-registration.json') ([ordered]@{originRef=$OriginRef;initialRecordHash=$hash;target=$record;docker=$mount})
  Write-Host "P1_TARGET_REGISTRATION=$dir digest=$digest"
  return [pscustomobject]@{Directory=$dir;Digest=$digest}
}
```

- [ ] 定义唯一退役 block。调用前的四个绑定值是本次保管的 registration、最终 record hash、真实批准引用和 owner 停用窗口引用；赋值不构成授权。登记目录只保管本目标。先检查五文件归档条件，门禁通过后连续删除精确容器、精确卷并归档五文件，不能只调用旧 cleanup 就宣布成功。

```powershell
$stage1RetirementAction = {
  param($operationDir,$operationId)
  $guard=$null; $recordGuard=$null; $phase='PREFLIGHT'; $gateHash=$null; $failure=$null
  $moved=[Collections.Generic.List[string]]::new()
  try {
    $guard=Open-P1LifecycleGuard
    if ([string]::IsNullOrWhiteSpace($stage1RetirementApprovalRef) -or [string]::IsNullOrWhiteSpace($stage1OwnerWindowRef)) { throw 'P1_RETIREMENT_APPROVAL_REQUIRED' }
    $archive=Get-P1LocalPath $stage1TargetRegistration.Directory
    if ((Split-Path $archive -Parent) -ne (Get-P1LocalPath '.release-local/p1-retirements') -or (Split-Path $archive -Leaf) -notmatch '^[0-9a-f-]{36}$') { throw 'P1_ARCHIVE_SCOPE_INVALID' }
    $registrationFile=Join-Path $archive 'target-registration.json'
    if ((Get-FileHash -LiteralPath $registrationFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $stage1TargetRegistration.Digest) { throw 'P1_REGISTRATION_CHANGED' }
    $registration=Get-Content -LiteralPath $registrationFile -Raw | ConvertFrom-Json
    $recordPath=Get-P1LocalPath '.release-local/controlled-target.v1.json'
    $recordGuard=[IO.File]::Open($recordPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $initial=Get-P1LocalPath (Join-Path $archive 'record-initial.json')
    if ((Get-FileHash -LiteralPath $initial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $registration.initialRecordHash) { throw 'P1_INITIAL_ARCHIVE_CHANGED' }
    if ((Get-P1StableRecord $initial) -ne (Get-P1StableRecord $recordPath)) { throw 'P1_RESOURCE_IDENTITY_CHANGED' }
    if ((Get-FileHash -LiteralPath $recordPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $stage1FinalRecordHash) { throw 'P1_FINAL_RECORD_CHANGED' }
    $record=Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    $names=@('bootstrap.json','migrate.json','verify.json','runtime-test.json')
    $secretRoot=Get-P1LocalPath '.release-local/secrets'
    $entries=@(Get-ChildItem -LiteralPath $secretRoot -Force)
    if ($entries.Count -ne 4 -or @($entries | Where-Object { $_.PSIsContainer -or $_.Name -notin $names }).Count -ne 0) { throw 'P1_SECRET_SCOPE_MISMATCH' }
    $pairs=@([pscustomobject]@{Source=$recordPath;Target=(Get-P1LocalPath (Join-Path $archive 'controlled-target.v1.json'))})
    foreach ($name in $names) {
      $source=Get-P1LocalPath (Join-Path $secretRoot $name)
      if ((Get-P1LocalPath $record.secretFiles.($name.Replace('.json',''))) -ne $source) { throw 'P1_SECRET_REFERENCE_MISMATCH' }
      $pairs += [pscustomobject]@{Source=$source;Target=(Get-P1LocalPath (Join-Path $archive $name))}
    }
    foreach ($pair in $pairs) {
      if (-not (Test-Path -LiteralPath $pair.Source -PathType Leaf) -or (Test-Path -LiteralPath $pair.Target)) { throw 'P1_ARCHIVE_PRESTATE_INVALID' }
    }
    # 重新连接真实目标，不复用批准前的 observation。verify 不改写 record。
    $observerOutput=@(& node scripts/release/with-controlled-target.mjs --profile verify -- pnpm --filter @subscription-saas/api exec node --input-type=module -e $stage1Observer)
    if ($LASTEXITCODE -ne 0) { throw 'P1_CONSUMER_OR_DATABASE_IDENTITY_CHANGED' }
    $observation=($observerOutput -join "`n") | ConvertFrom-Json -NoEnumerate
    if ($observation -isnot [pscustomobject] -or @($observation.PSObject.Properties).Count -ne 1 -or ($observation.other_sessions -isnot [int] -and $observation.other_sessions -isnot [long]) -or $observation.other_sessions -ne 0) { throw 'P1_CONSUMERS_PRESENT_OR_OBSERVATION_INVALID' }
    $actual=Get-P1TargetMount $record
    if (($actual | ConvertTo-Json -Depth 20 -Compress) -ne ($registration.docker | ConvertTo-Json -Depth 20 -Compress)) { throw 'P1_DOCKER_OR_VOLUME_CHANGED' }
    $gate=[ordered]@{operationId=$operationId;status='PASS';checkedAt=[DateTime]::UtcNow.ToString('o');approvalRef=$stage1RetirementApprovalRef;ownerWindowRef=$stage1OwnerWindowRef;registrationDigest=$stage1TargetRegistration.Digest;finalRecordHash=$stage1FinalRecordHash;observation=$observation;docker=$actual}
    $gateFile=Join-Path $operationDir 'pre-retirement.json'
    $gateHash=Write-P1NewJson $gateFile $gate
    if ((Get-FileHash -LiteralPath $gateFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $gateHash) { throw 'P1_GATE_READBACK_FAILED' }
    Write-Host "pre-retirement operation=$operationId digest=$gateHash PASS"
    # 同一前台操作/锁内立即消费门禁，以下之前没有删除；此后不等待人工输入。
    $phase='CONTAINER_DELETE_REQUESTED'
    & node scripts/release/bootstrap-controlled-postgres.mjs --cleanup $recordPath
    if ($LASTEXITCODE -ne 0) { throw 'P1_CONTAINER_RETIREMENT_UNKNOWN' }
    $containers=@(docker ps -aq --no-trunc)
    if ($LASTEXITCODE -ne 0 -or $record.container.id -in $containers) { throw 'P1_CONTAINER_READBACK_UNKNOWN' }
    $phase='CONTAINER_REMOVED'
    $owners=@(docker ps -aq --no-trunc --filter ("volume="+$actual.volume))
    if ($LASTEXITCODE -ne 0 -or $owners.Count -ne 0) { throw 'P1_VOLUME_STILL_REFERENCED_OR_UNKNOWN' }
    $phase='VOLUME_DELETE_REQUESTED'
    & docker volume rm $actual.volume
    if ($LASTEXITCODE -ne 0) { throw 'P1_VOLUME_RETIREMENT_UNKNOWN' }
    $volumes=@(docker volume ls -q)
    if ($LASTEXITCODE -ne 0 -or $actual.volume -in $volumes) { throw 'P1_VOLUME_READBACK_UNKNOWN' }
    $phase='VOLUME_REMOVED'
    $recordGuard.Dispose(); $recordGuard=$null
    foreach ($pair in $pairs) {
      $source=Get-P1LocalPath $pair.Source; $destination=Get-P1LocalPath $pair.Target
      if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or (Test-Path -LiteralPath $destination)) { throw 'P1_MOVE_PRESTATE_CHANGED' }
      Move-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
      $moved.Add((Split-Path $destination -Leaf)); Write-Host ('moved='+$moved[-1])
    }
    if (@(Get-ChildItem -LiteralPath $secretRoot -Force).Count -ne 0) { throw 'P1_SECRET_DIRECTORY_NOT_EMPTY' }
    Remove-Item -LiteralPath $secretRoot -ErrorAction Stop # 非递归，只删已空目录。
    foreach ($pair in $pairs) {
      if ((Test-Path -LiteralPath $pair.Source) -or -not (Test-Path -LiteralPath $pair.Target -PathType Leaf)) { throw 'P1_ARCHIVE_READBACK_FAILED' }
      icacls $pair.Target /inheritance:r /grant:r ($stage1Owner + ':F') | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'P1_ARCHIVE_ACL_FAILED' }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $archive 'controlled-target.v1.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $stage1FinalRecordHash) { throw 'P1_ARCHIVED_RECORD_CHANGED' }
    $phase='COMPLETE'
  } catch {
    $failure=if ($_.Exception.Message -match '^P1_[A-Z_]+$') { $_.Exception.Message } else { 'P1_RETIREMENT_OPERATION_FAILED' }
    throw
  } finally {
    try {
      $status=if ($phase -eq 'COMPLETE') { 'COMPLETE' } elseif ($phase -eq 'PREFLIGHT') { 'BLOCKED' } else { 'UNKNOWN' }
      $digest=Write-P1NewJson (Join-Path $operationDir 'retirement-result.json') ([ordered]@{operationId=$operationId;status=$status;phase=$phase;errorCode=$failure;deletionAttempted=($phase -ne 'PREFLIGHT');preRetirementDigest=$gateHash;moved=$moved.ToArray();finishedAt=[DateTime]::UtcNow.ToString('o')})
      Write-Host "retirement-result digest=$digest status=$status phase=$phase"
    } finally {
      if ($null -ne $recordGuard) { $recordGuard.Dispose() }
      if ($null -ne $guard) { $guard.Dispose() }
    }
  }
}
```

门禁不通过须 `BLOCKED/deletionAttempted=false`；发出第一个删除请求后失败、硬中断或终态文件缺失一律 UNKNOWN，不自动补删、从头重跑或 bootstrap。成功后独立读回本 operation 的 gate/result/transcript/hash、五文件存在性和 owner-only ACL、源 record/secrets 消失、精确容器/卷不存在。归档仅是本地凭证隔离保管，不是删除字节或密码学销毁；按 GUID 保留，CreateNew 和目标不存在断言禁止覆盖，当前入口不再引用归档路径。

- [ ] 定义可重复用于新旧目标的只读核验方法；每个 operation 的回读文件只能首次创建。下面不读取 secret 内容，ACL 验证有其他主体的 Allow 项即失败；归档文件不合格时不能假报 COMPLETE。

```powershell
function Test-P1RetirementReadback {
  param($Operation,$Registration)
  $dir=Get-P1LocalPath $Operation.Directory
  if ((Split-Path $dir -Parent) -ne $stage1P1Root -or (Split-Path $dir -Leaf) -ne $Operation.OperationId) { throw 'P1_RETIREMENT_OPERATION_PATH' }
  $command=Get-Content -LiteralPath (Join-Path $dir 'command.json') -Raw | ConvertFrom-Json
  $result=Get-Content -LiteralPath (Join-Path $dir 'result.json') -Raw | ConvertFrom-Json
  $retired=Get-Content -LiteralPath (Join-Path $dir 'retirement-result.json') -Raw | ConvertFrom-Json
  $gate=Get-Content -LiteralPath (Join-Path $dir 'pre-retirement.json') -Raw | ConvertFrom-Json
  foreach ($value in @($command,$result,$retired,$gate)) {
    if ($value.operationId -ne $Operation.OperationId) { throw 'P1_RETIREMENT_OPERATION_MISMATCH' }
  }
  if ($result.exitCode -ne 0 -or $null -eq $result.exitCode -or $retired.status -ne 'COMPLETE' -or $retired.phase -ne 'COMPLETE' -or $gate.status -ne 'PASS') { throw 'P1_RETIREMENT_NOT_COMPLETE' }
  foreach ($name in @('command.json','stdout.log','stderr.log','session.log')) {
    if ((Get-FileHash -LiteralPath (Join-Path $dir $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $result.fileHashes.$name) { throw 'P1_RETIREMENT_LOG_CHANGED' }
  }
  $gateHash=(Get-FileHash -LiteralPath (Join-Path $dir 'pre-retirement.json') -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($gateHash -ne $retired.preRetirementDigest -or $gate.registrationDigest -ne $Registration.Digest) { throw 'P1_RETIREMENT_DIGEST_MISMATCH' }
  $archive=Get-P1LocalPath $Registration.Directory
  if ((Get-FileHash -LiteralPath (Join-Path $archive 'target-registration.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Registration.Digest) { throw 'P1_REGISTRATION_READBACK_CHANGED' }
  $target=Get-Content -LiteralPath (Join-Path $archive 'target-registration.json') -Raw | ConvertFrom-Json
  if (Test-Path Env:DOCKER_HOST) { throw 'P1_DOCKER_HOST_OVERRIDE_PRESENT' }
  $context=docker context show
  if ($LASTEXITCODE -ne 0 -or $context -ne $target.docker.context) { throw 'P1_READBACK_CONTEXT_CHANGED' }
  $endpoint=docker context inspect --format '{{(index .Endpoints "docker").Host}}'
  if ($LASTEXITCODE -ne 0 -or $endpoint -ne $target.docker.endpoint) { throw 'P1_READBACK_ENDPOINT_CHANGED' }
  $containers=@(docker ps -aq --no-trunc)
  if ($LASTEXITCODE -ne 0 -or $target.target.container.id -in $containers) { throw 'P1_RETIRED_CONTAINER_PRESENT_OR_UNKNOWN' }
  $volumes=@(docker volume ls -q)
  if ($LASTEXITCODE -ne 0 -or $target.docker.volume -in $volumes) { throw 'P1_RETIRED_VOLUME_PRESENT_OR_UNKNOWN' }
  if ((Test-Path -LiteralPath '.release-local/controlled-target.v1.json') -or (Test-Path -LiteralPath '.release-local/secrets')) { throw 'P1_RETIRED_SOURCE_PATH_PRESENT' }
  $names=@('bootstrap.json','migrate.json','verify.json','runtime-test.json','controlled-target.v1.json')
  if ($retired.moved.Count -ne 5 -or @($names | Where-Object { $_ -notin $retired.moved }).Count -ne 0) { throw 'P1_ARCHIVE_FILE_SET_INCOMPLETE' }
  $ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach ($name in $names) {
    $file=Get-P1LocalPath (Join-Path $archive $name)
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'P1_ARCHIVE_FILE_MISSING' }
    $acl=Get-Acl -LiteralPath $file
    $allows=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object AccessControlType -eq 'Allow')
    if (-not $acl.AreAccessRulesProtected -or $allows.Count -eq 0 -or @($allows | Where-Object { $_.IdentityReference.Value -ne $ownerSid }).Count -ne 0) { throw 'P1_ARCHIVE_NOT_OWNER_ONLY' }
  }
  $recordHash=(Get-FileHash -LiteralPath (Join-Path $archive 'controlled-target.v1.json') -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($recordHash -ne $gate.finalRecordHash) { throw 'P1_RETIRED_RECORD_DIGEST_MISMATCH' }
  $readbackDigest=Write-P1NewJson (Join-Path $dir 'retirement-readback.json') ([ordered]@{operationId=$Operation.OperationId;status='VERIFIED';registrationDigest=$Registration.Digest;preRetirementDigest=$gateHash;retirementResultDigest=(Get-FileHash -LiteralPath (Join-Path $dir 'retirement-result.json') -Algorithm SHA256).Hash.ToLowerInvariant();finalRecordHash=$recordHash;containerAbsent=$true;volumeAbsent=$true;sourcePathsAbsent=$true;archiveFiles=$names;ownerOnly=$true})
  Write-Host "P1_RETIREMENT_READBACK=$dir digest=$readbackDigest"
}
```

### P1.0 原 Task 0 目标的核查、独立批准与精确退役

本次只读核查确认 record 和容器仍在。下列是**退役提案基线，不是已批准删除**：

| 项目                     | 固定核查值                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| source SHA               | `f8ed944030646bb697c4724e9071b1151e64e5ef`                                                   |
| container ID             | `8ad87116924cdf709f9c40df94a32bc4a06cd3f832e177523501a6ef724a1ea8`                           |
| runId                    | `ba53ccd1-5814-4e4a-aa47-2077ea4a9908`                                                       |
| database / OID           | `s1dev_f16ae0ba9f509196ff67fb93` / `16387`                                                   |
| record 中 migration head | `20260901010000_stage1_schema_drift_convergence`，本轮未查询数据库重新证明                   |
| record 字节 SHA256       | `423fd2117c2e819afd84760013617b22d793b10911eca9873fa89faeba27f380`                           |
| PGDATA 匿名 volume       | `04fe0d650f040d1d5f91d66bf1a58ab31980f6a4165d478112b5f034e356c84e`                           |
| secret 文件              | `bootstrap.json`、`migrate.json`、`verify.json`、`runtime-test.json`；仅核查存在，未输出内容 |

- [ ] 原 Task 0 owner 以实施记录/交接确认该目标归属、仅为可丢弃开发数据、无保留需求，并暂停所有可能连接该目标的本地任务。记录 owner、交接引用和无消费者声明。仅“当前连接数为0”不能证明没有稍后启动的消费者；不明即 BLOCKED，不自动停其他任务。
- [ ] 核对 record SHA256、source/run/container/DB/OID/marker/image 与上述基线；`docker inspect --format` 只输出 Id、标签、镜像和 Mounts，不输出 Config.Env。记录实际 PGDATA volume 及关联容器清单。任一变化均停止并重新限定目标，不能按旧常量删除新对象。
- [ ] P1 核查获批后，用已有 wrapper 的 verify profile 做只读连接计数；wrapper 先核对实际 DB OID/marker/角色/PG版本。下面 SQL 不读业务行或迁移表；迁移头仍标“原记录值”。

```powershell
$stage1Observer = 'import pg from "pg"; const c=new pg.Client({connectionString:process.env.DATABASE_URL,application_name:"p1-retirement-observer"}); try { await c.connect(); await c.query("BEGIN READ ONLY"); const r=await c.query("SELECT count(*)::int AS other_sessions FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND (datid IS NOT NULL OR backend_type = ANY($1::text[]))", [["client backend","walsender"]]); console.log(JSON.stringify(r.rows[0])); if(r.rows[0].other_sessions!==0) process.exitCode=1; await c.query("ROLLBACK"); } catch { console.error("P1_OLD_TARGET_OBSERVATION_FAILED"); process.exitCode=1; } finally { await c.end(); }'
$stage1OldObservation = Invoke-P1Recorded 'P1.0-observe' 'node' @('scripts/release/with-controlled-target.mjs','--profile','verify','--','pnpm','--filter','@subscription-saas/api','exec','node','--input-type=module','-e',$stage1Observer)
if ($null -eq $stage1OldObservation.ExitCode -or $stage1OldObservation.ExitCode -ne 0) { throw 'P1_BLOCKED_OLD_TARGET_CONSUMER_OR_IDENTITY' }
```

- [ ] **停止并单独申请退役批准**。批准绑定 container/run/DB/record digest、实际 PGDATA volume、owner 无保留/无消费者记录，并明确包含“删除该容器及其专属 volume，归档旧 record 与四个凭证文件”。未获批准时 P1 保持 BLOCKED；计划获批、路线原则认可或只读核查成功都不代替删除批准。
- [ ] 获批后填写真实 `stage1RetirementApprovalRef` 和 `stage1OwnerWindowRef`。后者引用 owner 已暂停所有消费者及 record 写入者、覆盖至归档读回结束的停用窗口；变量赋值不构成批准。先在固定锁内按已批准的旧 record hash 登记实际目标及专属卷，再由共享 block 在**新的 pre-retirement operation** 内重做全部实际检查；禁止沿用批准前 observation。

```powershell
if ([string]::IsNullOrWhiteSpace($stage1RetirementApprovalRef) -or [string]::IsNullOrWhiteSpace($stage1OwnerWindowRef)) { throw 'P1_RETIREMENT_APPROVAL_REQUIRED' }
$stage1Guard=Open-P1LifecycleGuard
try {
  $stage1FinalRecordHash='423fd2117c2e819afd84760013617b22d793b10911eca9873fa89faeba27f380'
  if ((Get-FileHash -LiteralPath (Get-P1LocalPath '.release-local/controlled-target.v1.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $stage1FinalRecordHash) { throw 'P1_OLD_RECORD_CHANGED' }
  $stage1TargetRegistration=Save-P1TargetRegistration $stage1RetirementApprovalRef
  $stage1Registered=Get-Content -LiteralPath (Join-Path $stage1TargetRegistration.Directory 'target-registration.json') -Raw | ConvertFrom-Json
  if ($stage1Registered.initialRecordHash -ne $stage1FinalRecordHash -or $stage1Registered.target.container.id -ne '8ad87116924cdf709f9c40df94a32bc4a06cd3f832e177523501a6ef724a1ea8' -or $stage1Registered.docker.volume -ne '04fe0d650f040d1d5f91d66bf1a58ab31980f6a4165d478112b5f034e356c84e') { throw 'P1_OLD_APPROVAL_TARGET_MISMATCH' }
} finally { $stage1Guard.Dispose() }
$stage1Retire=Invoke-P1Recorded -Step 'P1.0-pre-retirement-and-exact-cleanup' -Action $stage1RetirementAction
if ($null -eq $stage1Retire.ExitCode -or $stage1Retire.ExitCode -ne 0) { throw 'P1_OLD_RETIREMENT_BLOCKED_OR_UNKNOWN' }
Test-P1RetirementReadback $stage1Retire $stage1TargetRegistration
$stage1OldRegistration=$stage1TargetRegistration
$stage1OldOwnerWindowRef=$stage1OwnerWindowRef
$stage1OwnerWindowRef=$null; $stage1NewOwnerWindowRef=$null # 新目标必须重新取得窗口。
```

- [ ] 按共享门禁末尾的独立读回要求核验新 operation；非秘密索引登记 registration/gate/result 的精确位置和 SHA256、批准/停用窗口引用、容器/卷不存在、五文件归档及源 record/secrets 不存在。没有独立读回不能进入新建。没有删卷批准不能运行本 block；不会使用 prune、通配、递归移动或 `docker rm -v`。部分完成只沿原 operation 人工核对，不另开 operation 覆盖或补删。

P1.0 成功才允许 P1.1 的“旧路径不存在”断言和 P1.2 新建空库。新容器/runId/数据库名/PGDATA volume 须区别于旧目标，禁止重挂旧 volume。OID 要重新读取并绑定新集群，跨集群数值相同不等于同一个数据库。

### P1.1 准入与环境拒绝条件

- [ ] 确认 P0 提交及 P1 明确批准，读取索引/AGENTS.md。执行 git status/HEAD/stash 并立即核对退出码，记录本次 SHA。除索引盘点更新外存在不明修改则停止；不消除他人修改。
- [ ] 下列仅检查环境**名称**，不输出值。P1.0 未完成，或仍存在 controlled record/secrets 时保持 BLOCKED，返回 P1.0 核对，不覆盖、不清空。Docker 不可用不自动更换远程 host。

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
$stage1Op = Invoke-P1Recorded 'P1_LAUNCHER_UNIT' 'node' @('--test','scripts/release/bootstrap-controlled-postgres.test.mjs','scripts/release/database-test-launcher-cli.test.mjs')
if ($null -eq $stage1Op.ExitCode -or $stage1Op.ExitCode -ne 0) { throw 'P1_LAUNCHER_UNIT_FAILED' }
```

- [ ] P1 明确批准包含本步所建目标的完整生命周期：精确容器和专属卷删除、record 与四个 secret 归档，无需再借用旧目标退役批准。将实际 P1 批准引用存为 `stage1P1ApprovalRef`，后续不得用 P0 批准替代。
- [ ] 在固定锁内新建受控临时目标，**创建成功后立即登记实际 PGDATA volume**，成功保管后才进入 P1.3。保存 bootstrap operationId、初始 record 字节/hash、全部非秘密身份、实际镜像/标签/挂载/卷专属性及 Docker context；必须为 PG17、初始 migrationHead 为 null。卷与旧目标不同，不允许挂载旧卷。登记失败保留创建 operation/资源，记 UNKNOWN，不重复 bootstrap。

```powershell
if ([string]::IsNullOrWhiteSpace($stage1P1ApprovalRef)) { throw 'P1_APPROVAL_REQUIRED' }
$stage1Guard=Open-P1LifecycleGuard
try {
  # 与 P1.1 不能分离：锁内再次拒绝旧路径，防止 bootstrap 覆盖。
  if ((Test-Path -LiteralPath '.release-local/controlled-target.v1.json') -or (Test-Path -LiteralPath '.release-local/secrets')) { throw 'P1_BOOTSTRAP_OVERWRITE_REFUSED' }
  $stage1Op = Invoke-P1Recorded 'P1_CONTROLLED_BOOTSTRAP' 'node' @('scripts/release/bootstrap-controlled-postgres.mjs','--output','.release-local/controlled-target.v1.json')
  if ($null -eq $stage1Op.ExitCode -or $stage1Op.ExitCode -ne 0) { throw 'P1_CONTROLLED_BOOTSTRAP_UNKNOWN' }
  $stage1TargetRegistration=Save-P1TargetRegistration ('bootstrap-operation:'+ $stage1Op.OperationId)
  $stage1NewRegistration=$stage1TargetRegistration
  $stage1Registered=Get-Content -LiteralPath (Join-Path $stage1NewRegistration.Directory 'target-registration.json') -Raw | ConvertFrom-Json
  $stage1Old=Get-Content -LiteralPath (Join-Path $stage1OldRegistration.Directory 'target-registration.json') -Raw | ConvertFrom-Json
  $stage1Sha=git rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw 'P1_BOOTSTRAP_SOURCE_UNKNOWN' }
  if ($stage1Registered.target.sourceSha -ne $stage1Sha -or $null -ne $stage1Registered.target.database.migrationHead -or [int]$stage1Registered.target.cluster.serverVersionNum -lt 170000 -or [int]$stage1Registered.target.cluster.serverVersionNum -ge 180000) { throw 'P1_NEW_TARGET_BASELINE_INVALID' }
  if ($stage1Registered.target.container.id -eq $stage1Old.target.container.id -or $stage1Registered.target.container.runId -eq $stage1Old.target.container.runId -or $stage1Registered.target.database.name -eq $stage1Old.target.database.name -or $stage1Registered.docker.volume -eq $stage1Old.docker.volume) { throw 'P1_RETIRED_RESOURCE_REUSE_FORBIDDEN' }
} finally { $stage1Guard.Dispose() }
```

把新 registration 的精确路径/digest 和 bootstrap operationId 当场写入本地执行记录；该 GUID 目录后续只允许添加终态/归档文件，不覆盖初始记录。OID 只需绑定新集群，不要求跨集群数值不同。

### P1.3 迁移身份自检与源码 Schema 校验

当前 bootstrap 的 verify 仅有 CONNECT，没有 `_prisma_migrations` SELECT。因此本 P1 明确沿用现有 suite launcher 的做法，由 migrate 身份执行 status/diff，**仅称迁移身份自检，不称独立只读 verify**。不为开发基线增加临时授权修复，也不借此放宽 R2/候选的独立只读角色门禁；该门禁仍未完成。

- [ ] 只在上述**新空临时库**执行迁移；migrate profile 成功后 wrapper 更新 migration head。失败即停止，保留目标身份，不继续用 validate 宣称通过。

```powershell
$stage1Op = Invoke-P1Recorded 'P1_MIGRATION_DEPLOY' 'node' @('scripts/release/with-controlled-target.mjs','--profile','migrate','--','pnpm','--filter','@subscription-saas/api','exec','prisma','migrate','deploy','--schema','prisma/schema.prisma')
if ($null -eq $stage1Op.ExitCode -or $stage1Op.ExitCode -ne 0) { throw 'P1_MIGRATION_DEPLOY_FAILED' }
```

- [ ] 使用 migrate profile 核对 status 与实际 DB diff；它们是只读操作但使用迁移身份，与前一步为不同调用。status 非0/pending 或 diff 非0均停止，不运行 migrate reset。

```powershell
$stage1Op = Invoke-P1Recorded 'P1_MIGRATION_STATUS' 'node' @('scripts/release/with-controlled-target.mjs','--profile','migrate','--','pnpm','--filter','@subscription-saas/api','exec','prisma','migrate','status','--schema','prisma/schema.prisma')
if ($null -eq $stage1Op.ExitCode -or $stage1Op.ExitCode -ne 0) { throw 'P1_MIGRATION_STATUS_FAILED' }
$stage1Op = Invoke-P1Recorded 'P1_DATABASE_SCHEMA_DIFF' 'node' @('scripts/release/with-controlled-target.mjs','--profile','migrate','--','pnpm','--filter','@subscription-saas/api','exec','prisma','migrate','diff','--from-config-datasource','--to-schema','prisma/schema.prisma','--exit-code')
if ($null -eq $stage1Op.ExitCode -or $stage1Op.ExitCode -ne 0) { throw 'P1_DATABASE_SCHEMA_DIFF_FAILED' }
```

- [ ] 最后一次成功 migrate profile（上面的 diff）后，立即锁内保存最终 record 副本及 checkpoint。wrapper 在 deploy/status/diff 成功后都会重写 migrationHead；初始 hash 只证明来源，不能拿来拒绝合法迁移结果。P1.4–P1.6 不再允许 migrate profile；若需要重跑迁移，停止并重新核定 checkpoint，不覆盖。

```powershell
$stage1Guard=Open-P1LifecycleGuard
$stage1RecordGuard=$null
try {
  $stage1Record=Get-P1LocalPath '.release-local/controlled-target.v1.json'
  $stage1RecordGuard=[IO.File]::Open($stage1Record,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  if ((Get-P1StableRecord $stage1Record) -ne (Get-P1StableRecord (Join-Path $stage1NewRegistration.Directory 'record-initial.json'))) { throw 'P1_RESOURCE_IDENTITY_CHANGED' }
  $stage1FinalRecordHash=(Get-FileHash -LiteralPath $stage1Record -Algorithm SHA256).Hash.ToLowerInvariant()
  $stage1FinalRecordPath=Get-P1LocalPath (Join-Path $stage1Op.Directory 'record-after-migrate.json')
  if (Test-Path -LiteralPath $stage1FinalRecordPath) { throw 'P1_RECORD_CHECKPOINT_EXISTS' }
  Copy-Item -LiteralPath $stage1Record -Destination $stage1FinalRecordPath -ErrorAction Stop
  if ((Get-FileHash -LiteralPath $stage1FinalRecordPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $stage1FinalRecordHash) { throw 'P1_RECORD_CHECKPOINT_CHANGED' }
  $stage1CheckpointPath=Get-P1LocalPath (Join-Path $stage1Op.Directory 'record-checkpoint.json')
  $stage1CheckpointDigest=Write-P1NewJson $stage1CheckpointPath ([ordered]@{afterOperationId=$stage1Op.OperationId;afterResultDigest=(Get-FileHash -LiteralPath (Join-Path $stage1Op.Directory 'result.json') -Algorithm SHA256).Hash.ToLowerInvariant();registrationDigest=$stage1NewRegistration.Digest;finalRecordPath=$stage1FinalRecordPath;finalRecordHash=$stage1FinalRecordHash})
} finally {
  if ($null -ne $stage1RecordGuard) { $stage1RecordGuard.Dispose() }
  $stage1Guard.Dispose()
}
```

- [ ] verify profile 下只运行源码 Schema validate；不把它称为对迁移表或业务事实的独立验证。

```powershell
$stage1Op = Invoke-P1Recorded 'P1_SCHEMA_VALIDATE' 'node' @('scripts/release/with-controlled-target.mjs','--profile','verify','--','pnpm','prisma:validate')
if ($null -eq $stage1Op.ExitCode -or $stage1Op.ExitCode -ne 0) { throw 'P1_SCHEMA_VALIDATE_FAILED' }
```

- [ ] 保存本 P1.3 实际会话输出、退出码及 migration head，明确为开发自检原始记录，不伪造 execution proof。validate 只校验源码 Schema；P1.5 的 suite 内也执行迁移/Schema 检查，但当前不会单独持久化其原始输出，不声称存在该类原件。

### P1.4 构建依赖并跑 unit 基线

- [ ] Shared build 完成后，在 wrapper 下 generate；禁止裸 Prisma 命令读取仓库 `.env`。

```powershell
$stage1Op = Invoke-P1Recorded 'P1_SHARED_BUILD' 'pnpm' @('--filter','@subscription-saas/shared','build')
if ($null -eq $stage1Op.ExitCode -or $stage1Op.ExitCode -ne 0) { throw 'P1_SHARED_BUILD_FAILED' }
$stage1Op = Invoke-P1Recorded 'P1_PRISMA_GENERATE' 'node' @('scripts/release/with-controlled-target.mjs','--profile','verify','--','pnpm','prisma:generate')
if ($null -eq $stage1Op.ExitCode -or $stage1Op.ExitCode -ne 0) { throw 'P1_PRISMA_GENERATE_FAILED' }
```

- [ ] 用当前真实 `test:unit`，而非 API `test`（后者会连带 source-gate）。wrapper 会清理继承 DB 环境并设置 `STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV=1`；不得改为共享 public URL。

```powershell
$stage1Op = Invoke-P1Recorded 'P1_API_UNIT' 'node' @('scripts/release/with-controlled-target.mjs','--profile','verify','--','pnpm','--filter','@subscription-saas/api','test:unit')
if ($null -eq $stage1Op.ExitCode -or $stage1Op.ExitCode -ne 0) { throw 'P1_API_UNIT_FAILED' }
```

记录真实 passed/failed/skipped/todo/cancelled 及失败文件；缺日志不填历史数字。未通过则提交失败审计/最小修复建议供批准，不在 P1 直接修改服务或测试。

### P1.5 全仓发现与五个主线 fresh suite

- [ ] 运行全仓发现门禁，失败就列出漏分类/漏选文件，不删测试或增加 skip 以通过。

```powershell
$stage1Op = Invoke-P1Recorded 'P1_TEST_DISCOVERY' 'pnpm' @('release:database-tests:discover')
if ($null -eq $stage1Op.ExitCode -or $stage1Op.ExitCode -ne 0) { throw 'P1_TEST_DISCOVERY_FAILED' }
```

- [ ] 逐套运行下列真实 launcher。它们各自创建独立测试集群/数据库并注入分离角色；**不要**再套 with-controlled-target，不传 `--profile localdev`、`--output` 或 ambient URL。

```powershell
$stage1Suites = @(
  'api.subscription-journey-golden-path.postgres',
  'api.subscription-journey-integrity.postgres',
  'api.subscription-journey-failure-recovery.postgres',
  'api.billing-automation.postgres',
  'api.subscription-expiry-return.postgres'
)
foreach ($stage1Suite in $stage1Suites) {
  $stage1Op = Invoke-P1Recorded 'P1.5-suite' 'node' @('scripts/release/run-database-suite.mjs','--suite-id',$stage1Suite,'--chain','fresh')
  # 非0也先回读本次已有 FAILED report/receipt，不能先抛错丢失证据。
  $stage1ReadbackExit = Test-P1SuiteReadback $stage1Op.Directory
  if ($null -eq $stage1Op.ExitCode -or $stage1Op.ExitCode -ne 0 -or $stage1ReadbackExit -ne 0) {
    throw 'P1_STOP_AFTER_RECORDED_SUITE_FAILURE'
  }
}

```

每套结束再开始下一套，失败/UNKNOWN 即停止当前串行批次；其他尚未运行项保留 NOT_RUN。禁止共用失败目标、手动宽泛 cleanup 或自动重试。

- [ ] 逐套核对输出及 `.release-local` 中实际生成的 suite report/custody/incident：`collected = selected = executed = passed > 0`，failed/skipped/todo/filtered/cancelled 均0；只登记实际报告中的目标、角色边界、日志摘要和 custody readback。当前 suite 模式的迁移/Schema/PG版本观察并非独立保管原件，只能说明受审 launcher 在执行时做过这些检查；不得从内存摘要补造证明。控制台 exit0而缺应有报告/计数仍不通过。正常返回的 PASSED/FAILED report 都可能已由 launcher 精确回收；异常是否留目标须凭实际 incident/身份核对，不假设一律保留或一律删除，不另外扫库清理。

这五套只构成主线开发基线，不是候选全量清单；golden-path 的确定性 provider 也不是供应商联通或浏览器证明。

### P1.6 结果保管、精确回收与交付

- [ ] 退出码为0也必须独立打开本次目录核对字节 hash，不能只看 helper 的返回值。下面遍历 helper 在当前会话保存的全部实际 operation 目录；每步同时输出了精确目录，须抄入非秘密执行索引，不接受按“最新时间”搜索其他目录。检查 command.json 的 step/sourceSha/argv 与对应命令一致；原件是会话记录，不是 release proof。会话丢失先根据已留目录引用核对，不能把重置后的空列表当作完成。

```powershell
if ($stage1P1Operations.Count -eq 0) { throw 'P1_OPERATION_INDEX_MISSING' }
foreach ($stage1Op in $stage1P1Operations) {
$stage1AuditDir = Get-P1LocalPath $stage1Op.Directory
$stage1Command = Get-Content -LiteralPath (Join-Path $stage1AuditDir 'command.json') -Raw | ConvertFrom-Json
$stage1Result = Get-Content -LiteralPath (Join-Path $stage1AuditDir 'result.json') -Raw | ConvertFrom-Json
if ($stage1Command.operationId -ne (Split-Path $stage1AuditDir -Leaf) -or $stage1Result.operationId -ne $stage1Command.operationId) { throw 'P1_LOG_OPERATION_MISMATCH' }
foreach ($stage1LogName in @('command.json','stdout.log','stderr.log','session.log')) {
  $stage1FileHash = (Get-FileHash -LiteralPath (Join-Path $stage1AuditDir $stage1LogName) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($stage1FileHash -ne $stage1Result.fileHashes.$stage1LogName) { throw 'P1_LOG_READBACK_MISMATCH' }
}
Get-Content -LiteralPath (Join-Path $stage1AuditDir 'command.json') -Raw
Get-FileHash -LiteralPath (Join-Path $stage1AuditDir 'result.json') -Algorithm SHA256
if ($null -eq $stage1Result.exitCode -or $stage1Result.exitCode -ne 0) { throw 'P1_RECORDED_COMMAND_FAILED_OR_UNKNOWN' }
}
```

stdout/stderr 原件只在受控本地读取，不在公开输出中展示。P1.5 则逐套使用 Test-P1SuiteReadback；把其 `readback.json` 字节 hash、report/receipt 路径与双方 digest 一并登记，引用实际文件，而非从报告摘要编造原始日志。独立审查者按相同只读方法复算；本机普通文件不宣称不可篡改保管。

- [ ] 在索引记录每个实际命令、退出码、身份/迁移结论、计数和非秘密证据引用。原件从现有 launcher 的实际输出位置独立读回并计算 SHA256；无原件的 unit 控制台记录标为“会话日志”，不能伪造 execution proof。禁止把 secrets/raw URL/订单数据提交 Git。
- [ ] 只在证据已读回、所有本 P1 消费者已退出并由 owner 确认停用窗口后回收。核对 P1.2 登记及 P1.3 checkpoint 的原件，不在清理时临时编造最终 migrationHead/hash。未完成 P1.3、会话丢失或记录不匹配时保持 BLOCKED，保留精确资源引用，不自动走成功路径。

```powershell
if ((Get-FileHash -LiteralPath (Get-P1LocalPath $stage1CheckpointPath) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $stage1CheckpointDigest) { throw 'P1_CHECKPOINT_CHANGED' }
$stage1Checkpoint=Get-Content -LiteralPath $stage1CheckpointPath -Raw | ConvertFrom-Json
$stage1CheckpointDir=Get-P1LocalPath (Split-Path $stage1CheckpointPath -Parent)
if ((Split-Path $stage1CheckpointDir -Parent) -ne $stage1P1Root -or (Split-Path $stage1CheckpointDir -Leaf) -notmatch '^[0-9a-f-]{36}$' -or (Split-Path $stage1CheckpointDir -Leaf) -ne $stage1Checkpoint.afterOperationId) { throw 'P1_CHECKPOINT_OPERATION_PATH' }
$stage1CheckpointCommand=Get-Content -LiteralPath (Join-Path $stage1CheckpointDir 'command.json') -Raw | ConvertFrom-Json
$stage1CheckpointResult=Get-Content -LiteralPath (Join-Path $stage1CheckpointDir 'result.json') -Raw | ConvertFrom-Json
if ($stage1CheckpointCommand.operationId -ne $stage1Checkpoint.afterOperationId -or $stage1CheckpointResult.operationId -ne $stage1Checkpoint.afterOperationId -or $stage1CheckpointCommand.step -ne 'P1_DATABASE_SCHEMA_DIFF' -or $null -eq $stage1CheckpointResult.exitCode -or $stage1CheckpointResult.exitCode -ne 0) { throw 'P1_CHECKPOINT_SUCCESS_BINDING' }
if ((Get-FileHash -LiteralPath (Join-Path $stage1CheckpointDir 'result.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $stage1Checkpoint.afterResultDigest) { throw 'P1_CHECKPOINT_RESULT_CHANGED' }
if ($stage1Checkpoint.registrationDigest -ne $stage1NewRegistration.Digest -or $stage1Checkpoint.finalRecordHash -ne $stage1FinalRecordHash) { throw 'P1_CHECKPOINT_BINDING_CHANGED' }
if ((Get-FileHash -LiteralPath (Get-P1LocalPath $stage1Checkpoint.finalRecordPath) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $stage1FinalRecordHash) { throw 'P1_FINAL_RECORD_ARCHIVE_CHANGED' }
$stage1TargetRegistration=$stage1NewRegistration
$stage1RetirementApprovalRef=$stage1P1ApprovalRef
# stage1NewOwnerWindowRef 从本次实际 owner 确认填入，不复用旧引用。
if ([string]::IsNullOrWhiteSpace($stage1NewOwnerWindowRef) -or $stage1NewOwnerWindowRef -eq $stage1OldOwnerWindowRef) { throw 'P1_NEW_OWNER_WINDOW_REQUIRED' }
$stage1OwnerWindowRef=$stage1NewOwnerWindowRef
$stage1Retire=Invoke-P1Recorded -Step 'P1.6-pre-retirement-and-exact-cleanup' -Action $stage1RetirementAction
if ($null -eq $stage1Retire.ExitCode -or $stage1Retire.ExitCode -ne 0) { throw 'P1_NEW_RETIREMENT_BLOCKED_OR_UNKNOWN' }
Test-P1RetirementReadback $stage1Retire $stage1NewRegistration
```

该调用必须完整回收**登记的容器和专属 volume**，并将 record/四个 secret 逐个移入 P1.2 已分配的 owner-only GUID 目录；固定 record 和 secrets 源路径必须消失。不再允许“只删容器、原地隔离保留”。归档不称密码学销毁；目录不可复用/覆盖，后续 bootstrap 必须在固定锁内检查源路径不存在。

- [ ] 上面 `Test-P1RetirementReadback` 实际完成 command/result/log hash、gate/result 身份与 digest、五文件及 owner-only ACL、容器/卷和源路径消失的核验，CreateNew 保管 `retirement-readback.json`。独立审查者按精确文件路径复算回读 digest，并核对其中 finalRecordHash 等于 P1.3 checkpoint.finalRecordHash。缺任一原件/断言则 P1 不完成，不重建覆盖。只读回当前明确列出的路径和 ID，不递归扫描 secrets、不用 prune 或通配删除。

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
- P1 独立通过：P1.0 所有权/身份/无消费者已核对且旧目标退役获批完成；无 ambient、控制脚本通过、PG17身份和迁移侧 status/diff 明确、unit 与五项 suite 的实际报告齐全、operation 原件/report/receipt 可读回；新旧目标均有成功 pre-retirement、完整处置及独立读回，精确容器/卷和固定 record/secrets 源路径消失，五文件按目标归档且最终 record hash 匹配。仅容器删除、部分回收或 UNKNOWN 均不通过；不等于业务完成或独立 DB verify。后者仍由 R2/最终候选真实证明。
- 任一失败：记录具体反例、缺失材料、受影响出口和下一责任包；不把本地基础设施失败误报产品回归，不暗自修复。
- 通过后只**申请**首批 B1/B3/B5 与 R1/R2 小计划审批，不自动施工；P0 后的副本可用性盘点已并行，不再等 R2 才发现缺输入。
- 真实副本、本机安全改动、密钥、Staging、外部服务及旧路线仍各自阻断；OSS/210 天 WORM 不动。
