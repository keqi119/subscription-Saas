# Stage 1 Clean Staging Acceptance Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** 提供一套经过测试、可审计、dry-run-first 的受控白名单工具和发布手册，在不修改现有 Staging 数据库的前提下创建阶段 1 干净验收数据库，迁移必要身份/RBAC/产品/合同模板/可用车辆基线，并通过候选 API 与双批准闸门完成可回滚切换。

**Architecture:** 实现层分为纯函数分类与 canonical manifest、只读源快照/目标零行验证、目标库单事务导入、CLI 连接保护和独立 target validator。所有源库读取都在 `REPEATABLE READ, READ ONLY` 中进行；所有目标写入都在 `SERIALIZABLE` 加 advisory lock 的单事务中进行。代码合并和镜像发布不授权数据写入；baseline apply 与正式 API 数据库切换分别等待一次独立人工批准。

**Tech Stack:** Node.js 20+ ESM、Prisma 7、PostgreSQL、Node test runner、pnpm 11、Docker Compose、PowerShell（本地）与 Bash/psql（Staging 服务器）。

**Spec:** `docs/superpowers/specs/2026-08-30-stage1-clean-staging-acceptance-database-design.zh-CN.md`

## Global Constraints

- 只在隔离 worktree 中修改代码；不得改写主工作区的 `Dockerfile.api`、`Dockerfile.web` 或任何未跟踪目录。
- 旧库数据库名必须精确为 `subscription_saas_staging`，在整个执行过程中只读且不做 migration repair、checksum repair、`db push`、`migrate resolve`、backfill 或清理。
- 新库数据库名必须匹配 `^subscription_saas_staging_acceptance_[a-z0-9_]+$`，不得使用旧库作为 PostgreSQL `TEMPLATE`。
- 工具只接受 `STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL` 和 `STAGE1_ACCEPTANCE_TARGET_DATABASE_URL`，不得回退读取通用 `DATABASE_URL`。
- dry-run、apply、replay、validator 的公开 JSON 不得包含密码哈希、手机号、身份证号、地址、VIN、车牌号、对象存储 key、电子签账号标识或数据库连接串。
- 车辆必须通过 `--vehicle-id` 显式选择；未选择、选错、候选为零、选中的车辆不满足完整守卫时都必须 `safeToApply=false`。
- apply 必须同时收到 `STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY=1`、受控 dry-run manifest 文件和该文件的精确 SHA-256；任一条件不满足均不得写入。
- apply 后 replay 预期 `inserted=0`、`updated=0`、`deleted=0`、`auditCreated=0`；任何非零结果阻断候选 API。
- baseline apply 和正式 API 数据库切换是两个独立人工批准点。PR 合并、main CI 全绿、镜像构建、镜像拉取、新库创建、migration deploy、备份或候选 API 只读验证均不视为批准。
- 不在在线 API 容器内运行 pnpm 安装或高内存诊断。迁移与工具通过目标镜像的一次性容器运行。
- 每个代码任务遵循红—绿—重构：先添加失败测试并确认失败原因，再实现最小代码，再运行 focused tests 与 `git diff --check`，最后提交。

---

## Task 1: 建立 canonical manifest、脱敏摘要与连接保护纯函数

**Files:**

- Create: `scripts/stage1-clean-acceptance-baseline-core.mjs`
- Test: `scripts/stage1-clean-acceptance-baseline-core.test.mjs`

### Step 1: 写出失败测试

测试必须覆盖以下公开接口：

```js
export function parseStage1CleanAcceptanceSelection(input)
export function parseStage1AcceptanceDatabaseIdentity(databaseUrl)
export function assertStage1AcceptanceDatabasePair(sourceUrl, targetUrl, options)
export function classifyStage1CleanAcceptanceBaseline(snapshot, selection)
export function buildStage1CleanAcceptanceManifest(classification, context)
export function hashStage1CleanAcceptanceManifest(manifest)
export function isStage1CleanAcceptanceBaselineSafe(classification)
export function redactStage1CleanAcceptanceError(error)
```

`parseStage1CleanAcceptanceSelection` 的返回类型固定为：

```js
{
  adminUsername: "keqi_119",
  customerPhone: "18616570212",
  vehicleIds: ["按字典序排序且去重的 UUID"]
}
```

测试用例至少包括：

- 用户名或手机号与固定验收身份不一致时报 `IDENTITY_SELECTION_NOT_ALLOWED`。
- `vehicleIds` 为零个时分类结果包含 `VEHICLE_SELECTION_REQUIRED`，而不是擅自选择第一辆车。
- 非 UUID、重复 UUID、空白 UUID 被稳定拒绝或去重。
- 源库名不精确等于 `subscription_saas_staging` 时返回 `SOURCE_DATABASE_NOT_ALLOWED`。
- 目标库名不匹配约定前缀时返回 `TARGET_DATABASE_NOT_ALLOWED`。
- 同库、不同主机、端口不同、用户名不同、TLS 策略不同分别返回稳定错误码。
- URL 或密码绝不进入错误消息。
- manifest 对 object key 排序和数组稳定排序，输入顺序不同仍得到相同 SHA-256。
- manifest 摘要使用 `stage1-acceptance:admin:`、`stage1-acceptance:customer:`、`stage1-acceptance:vehicle:` 等固定领域前缀与 manifest 内随机 salt，明文身份、VIN、车牌和对象 key 不出现。
- 任一 exception、ambiguity、目标非空、目标 schema 非 canonical、候选选择不闭包时 `safeToApply=false`。
- 完整且唯一的管理员、客户、产品/模板闭包和显式车辆闭包，且所有目标禁止域为零时 `safeToApply=true`。

运行：

```powershell
node --test scripts/stage1-clean-acceptance-baseline-core.test.mjs
```

预期：因模块或导出不存在而失败。

### Step 2: 实现稳定序列化、摘要和数据库身份保护

实现约束：

- 使用 Node `crypto.createHash("sha256")` 和 `crypto.randomBytes(32)`。
- canonical JSON 递归按 key 排序；数组在进入 manifest 前由各领域的稳定业务 key 排序。
- manifest 根对象固定包含：

```js
{
  schemaVersion: 1,
  operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
  gitSha,
  imageRef,
  source: { databaseDigest, migrationCatalogDigest, schemaDigest },
  target: { databaseDigest, migrationCatalogDigest, schemaDigest },
  selection: { adminDigest, customerDigest, vehicleDigests },
  counts,
  rowDigests,
  exceptions,
  safeToApply,
  generatedAt,
  hashSalt
}
```

- `hashSalt` 只存在 root-owned 原始 manifest；公开摘要报告只保留 manifest SHA-256，不回显 salt。
- `assertStage1AcceptanceDatabasePair` 只比较解析后的 protocol、hostname、port、username、TLS 策略和 database name，不输出原 URL。
- `options.allowedHostname` 为服务器预检从现有配置解析出的精确主机名；未提供或不一致必须失败。

### Step 3: 实现领域分类结果

分类结果固定为：

```js
{
  safeToApply,
  selection,
  rows: {
    access,
    customer,
    catalog,
    templates,
    vehicle
  },
  counts,
  rowDigests,
  exceptions: [{ code, domain, subjectDigest }],
  targetForbiddenCounts
}
```

稳定异常码至少包括：

```text
ADMIN_NOT_FOUND
ADMIN_AMBIGUOUS
ADMIN_ROLE_INCOMPLETE
CUSTOMER_NOT_FOUND
CUSTOMER_AMBIGUOUS
CUSTOMER_ESIGN_BINDING_INVALID
CATALOG_ACTIVE_SET_EMPTY
CATALOG_REFERENCE_NOT_CLOSED
CONTRACT_TEMPLATE_AMBIGUOUS
CONTRACT_TEMPLATE_FILE_INVALID
VEHICLE_SELECTION_REQUIRED
VEHICLE_NOT_ELIGIBLE
VEHICLE_REFERENCE_NOT_CLOSED
TARGET_SCHEMA_NOT_CANONICAL
TARGET_NOT_EMPTY
FORBIDDEN_DOMAIN_NOT_EMPTY
MANIFEST_STALE
```

### Step 4: 运行 focused tests

```powershell
node --test scripts/stage1-clean-acceptance-baseline-core.test.mjs
git diff --check
```

预期：全部通过，无空白错误。

### Step 5: 提交

```powershell
git add scripts/stage1-clean-acceptance-baseline-core.mjs scripts/stage1-clean-acceptance-baseline-core.test.mjs
git commit -m "feat: define clean acceptance baseline manifest"
```

---

## Task 2: 实现源快照读取、白名单闭包和目标禁止域版本清单

**Files:**

- Create: `scripts/stage1-clean-acceptance-baseline-snapshot.mjs`
- Test: `scripts/stage1-clean-acceptance-baseline-snapshot.test.mjs`

### Step 1: 写出失败测试

公开接口：

```js
export const STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES
export async function loadStage1CleanAcceptanceSourceSnapshot(tx, selection)
export async function loadStage1CleanAcceptanceTargetSnapshot(tx)
export async function countStage1CleanAcceptanceForbiddenDomains(tx)
```

使用记录调用的 fake Prisma delegates，验证所有查询：

- 只使用显式 `select`，不使用 `include: true` 或原始 `SELECT *`。
- 管理员只按 `username="keqi_119"`、有效且未删除读取；RBAC 读取有效 Role/Permission/Menu 和闭包关联。
- 客户只按 `phone="18616570212"` 对应的唯一有效账号读取，并闭包到 Customer、CustomerIdentity、CustomerProfile、CustomerESignProviderAccount。
- 不读取 CustomerVerificationCode、SmsSendLog、CustomerProfileMaterial、CustomerFollowup、FieldOperatorSession。
- 产品只读取 Portal 当前可售 Product/ProductVersion 及其 DepositRule、VehiclePackage/VehiclePackageModelMember、MileagePackage、EnergyPackage、BenefitPackage、SubscriptionPlan、ProductPriceRule。
- 模板只读取阶段 1、交接、续期、换车、提前结束、受管其他变更对应的唯一有效 ContractVersion 及显式 FileObject。
- 通知模板只读取当前流程会按 template code 访问的有效 NotificationTemplate，不读取 NotificationRecord/NotificationEvent。
- 车辆发现查询使用与运行时代码相同的可用性守卫，不仅检查 `Vehicle.status`；选择后闭包到 AssetOwner、VehicleModelDefinition、VehicleListingProfile/Media/Plan、VehicleDocumentBatch/VehicleDocument、VehicleListingSourceBinding、VehicleInsurancePolicy/Coverage、VehicleSalePriceHistory、VehicleOwnershipPeriod、VehicleAssetCostProfile、VehicleCostLedgerEntry。
- 不读取市场样本、残值预测、折旧任务、工单、事故、交付、退回、订阅期间。

### Step 2: 定义显式禁止域清单

`STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES` 必须按 Prisma delegate 名显式列出，不得使用前缀猜测：

```js
export const STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES = Object.freeze([
  "customerVerificationCode",
  "smsSendLog",
  "fieldOperatorOtp",
  "fieldOperatorSession",
  "fieldOperatorAuditLog",
  "customerProfileMaterial",
  "customerFollowup",
  "application",
  "applicationMaterial",
  "applicationMaterialGroup",
  "applicationMaterialFile",
  "applicationActionLog",
  "riskResult",
  "subscriptionQuote",
  "subscriptionOrder",
  "subscriptionJourney",
  "subscriptionJourneyStep",
  "subscriptionJourneyJob",
  "subscriptionJourneyManualTask",
  "subscriptionJourneyEvent",
  "subscriptionJourneyException",
  "subscriptionJourneyOutbox",
  "orderEntitlementAccount",
  "orderEntitlementGrant",
  "orderEntitlementUsage",
  "receivableBill",
  "billingSchedule",
  "subscriptionAutomationJob",
  "paymentMandate",
  "debitAttempt",
  "paymentRecord",
  "paymentOrder",
  "paymentOrderItem",
  "paymentCallbackLog",
  "paymentWriteOff",
  "depositLedger",
  "collectionCase",
  "collectionCaseBill",
  "collectionAction",
  "serviceCase",
  "serviceCaseAttachment",
  "serviceCaseAction",
  "notificationRecord",
  "notificationEvent",
  "lease",
  "vehicleDelivery",
  "vehicleDeliveryHandover",
  "vehicleHandoverWorkOrder",
  "vehicleHandoverWorkflowJob",
  "vehicleHandoverReviewAttempt",
  "vehicleHandoverEvent",
  "vehicleDeliveryEvidenceItem",
  "vehicleDeliveryEvidenceFile",
  "fieldEvidenceVideoUploadSession",
  "fieldEvidenceVideoUploadPart",
  "vehicleInspection",
  "vehicleReturn",
  "vehicleReturnDamage",
  "contract",
  "contractESignTask",
  "contractESignSigner",
  "contractESignCallbackLog",
  "subscriptionChangeOrder",
  "subscriptionExtensionChangeDetail",
  "subscriptionVehicleSwapChangeDetail",
  "subscriptionEarlyTerminationChangeDetail",
  "subscriptionManagedOtherChangeDetail",
  "subscriptionChangeQuote",
  "subscriptionChangeCommand",
  "subscriptionContractSegment",
  "renewalConsideration",
  "renewalReminder",
  "orderChange",
  "subscriptionClosureCase",
  "subscriptionClosureEvent",
  "subscriptionClosureDocumentRevision",
  "subscriptionClosureCurrentDocument",
  "subscriptionClosureSettlementRevision",
  "vehicleReturnChecklistRevision",
  "vehicleReturnChecklistItem",
  "vehicleReturnEvidenceLink",
  "vehicleConditionDeltaRevision",
  "vehicleConditionDeltaItem",
  "contractChargeClauseSnapshot",
  "subscriptionClosureChargeLine",
  "subscriptionClosureCustomerResponse",
  "subscriptionClosureChargeDispute",
  "subscriptionClosureChargeDisputeDecision",
  "subscriptionClosureReceivableDisposition",
  "subscriptionClosureLegalCollectionCase",
  "subscriptionClosureLegalCollectionEvent",
  "subscriptionClosureEvidencePackageExport",
  "subscriptionClosureCommandReceipt",
  "assetAccountingCommandReceipt",
  "vehicleSubscriptionPeriod",
  "vehicleConditionReport",
  "vehicleConditionReportItem",
  "vehicleMileageReading",
  "orderMileageReview",
  "orderMileageReviewEvidence",
  "assetWorkOrder",
  "assetWorkOrderEvent",
  "assetWorkOrderEvidence",
  "vehicleOperationalRestriction",
  "businessExceptionApproval",
  "insuranceClaim",
  "vehicleBaasContract",
  "vehicleBaasContractAttachment",
  "vehicleBaasCostRecord",
  "vehicleDepreciationPolicy",
  "vehicleDepreciationSchedule",
  "vehicleDepreciationRecord",
  "marketPriceImportBatch",
  "vehicleMarketPriceObservation",
  "vehicleResidualCurve",
  "vehicleResidualCurvePoint",
  "vehicleResidualForecast",
  "vehicleResidualForecastPoint",
  "vehicleValuationReview",
  "residualModelRun",
  "residualModelRunOutput",
  "vehicleCapitalEvent",
  "financingInstrument",
  "financingInstrumentVehicle",
  "vehicleAssetPool",
  "vehicleAssetPoolVehicle",
  "revenueRightAssignment",
  "revenueShareRule",
  "auditLog"
]);
```

`auditLog` 的 validator 特例是：apply 前为 0；apply 后只能存在一条 `entityType="stage1_acceptance_baseline"` 且 `action="CREATE"` 的新记录。不得把旧库 AuditLog 复制过来。

### Step 3: 实现 read-only 快照加载器

- 源快照加载器只接收已经进入 read-only 事务的 `tx`。
- 车辆发现结果仅返回 UUID 与脱敏候选诊断所需的业务状态；原始 VIN/车牌只保留内存用于闭包加载，不进入报告。
- 每个闭包数组按主键排序，保证 manifest 重算稳定。
- 明确选择的 `vehicleIds` 必须逐个命中且逐个通过守卫，不允许部分成功。
- 读取目标 `_prisma_migrations` 和 schema 指纹使用参数化 `$queryRaw`；不得写 `_prisma_migrations`。

### Step 4: 运行 focused tests

```powershell
node --test scripts/stage1-clean-acceptance-baseline-snapshot.test.mjs
git diff --check
```

### Step 5: 提交

```powershell
git add scripts/stage1-clean-acceptance-baseline-snapshot.mjs scripts/stage1-clean-acceptance-baseline-snapshot.test.mjs
git commit -m "feat: load clean acceptance whitelist snapshots"
```

---

## Task 3: 实现双库 executor、原子导入和 replay

**Files:**

- Create: `scripts/stage1-clean-acceptance-baseline-executor.mjs`
- Test: `scripts/stage1-clean-acceptance-baseline-executor.test.mjs`

### Step 1: 写出失败测试

公开接口：

```js
export async function executeStage1CleanAcceptanceBaseline(options)
export async function applyStage1CleanAcceptanceBaseline(tx, classification, context)
```

`options` 契约固定为：

```js
{
  mode: ("dry-run" | "apply" | "replay",
    sourcePrisma,
    targetPrisma,
    selection,
    gitSha,
    imageRef,
    generatedAt,
    hashSalt,
    approvedManifest,
    approvedManifestSha256);
}
```

测试至少覆盖：

- source 事务使用 `RepeatableRead` 并首先执行 `SET TRANSACTION READ ONLY`。
- dry-run 对 source 和 target 的 create/update/delete/upsert/$executeRaw 写调用均为零。
- dry-run 对 `AuditLog` 写调用为零。
- apply 缺确认环境变量、manifest 文件、SHA 或 SHA 不匹配时在目标事务开始前失败。
- apply 在 advisory lock 后重新验证目标空库、禁止域、migration/schema 与 manifest；stale manifest 报 `MANIFEST_STALE`。
- apply 目标事务 isolation level 为 `Serializable`。
- 任一中途写入失败会回滚全部白名单记录和 AuditLog。
- 写入顺序满足外键，保留原 UUID、创建/更新时间和密码哈希，但输出对象不包含密码哈希。
- AuditLog 只创建一条，`entityType="stage1_acceptance_baseline"`、`action="CREATE"`，after 字段只含计数、摘要、git/image SHA 和 manifest SHA。
- replay 在相同 manifest 下零写入；如果已有数据与 manifest 不同则失败，不允许 upsert 修补。
- 并发 apply 由 `pg_advisory_xact_lock(hashtext('stage1-clean-acceptance-baseline:apply'))` 串行化。

### Step 2: 实现事务边界

执行顺序必须是：

1. source `RepeatableRead` + `SET TRANSACTION READ ONLY` 加载快照并分类；
2. target 只读加载 migration、schema、禁止域和基线表计数；
3. 生成 canonical manifest；dry-run 到此返回；
4. apply/replay 验证批准文件 SHA 和重算 manifest 完全一致；
5. target `Serializable` 事务内获取 advisory lock；
6. 再次验证 target；
7. apply 按显式顺序写入；replay 只比较，不写入；
8. apply 创建唯一 AuditLog；
9. 事务提交后再次运行 target snapshot，生成脱敏结果。

源和目标是两个数据库，无法建立跨库原子事务。因此 source 快照在目标事务前关闭，manifest 指纹是跨库一致性边界；目标库写入本身必须原子。

### Step 3: 实现显式写入顺序

不得使用通用表复制器。固定顺序：

1. Permission、Menu、Role、RolePermission、RoleMenu、User、UserRole；
2. Customer、CustomerAccount、CustomerIdentity、CustomerProfile、CustomerESignProviderAccount；
3. DepositRule、Product、ProductVersion、VehicleModelDefinition；
4. VehiclePackage、VehiclePackageModelMember、MileagePackage、EnergyPackage、BenefitPackage、SubscriptionPlan、ProductPriceRule；
5. FileObject、ContractVersion、NotificationTemplate；
6. AssetOwner、Vehicle；
7. VehicleListingProfile、VehicleListingMedia、VehicleListingPlan、VehicleListingSourceBinding；
8. VehicleDocumentBatch、VehicleDocument、VehicleInsurancePolicy、VehicleInsuranceCoverage；
9. VehicleSalePriceHistory、VehicleOwnershipPeriod、VehicleAssetCostProfile、VehicleCostLedgerEntry；
10. AuditLog。

对于数据库默认值与审计字段，优先复制原始显式值，避免新默认值改变摘要。每个 `createMany` 前必须由分类器证明其引用闭包完整。

### Step 4: 实现 replay 不变量

replay 不调用任何 Prisma writer。它只重新加载目标允许表、计算目标行摘要并与 approved manifest 的 `rowDigests`、`counts` 对比，同时验证禁止域为零和 AuditLog 精确为一条。报告固定包含：

```js
{
  mode: "replay",
  inserted: 0,
  updated: 0,
  deleted: 0,
  auditCreated: 0,
  safe: true,
  manifestSha256
}
```

### Step 5: 运行 focused tests

```powershell
node --test scripts/stage1-clean-acceptance-baseline-executor.test.mjs
git diff --check
```

### Step 6: 提交

```powershell
git add scripts/stage1-clean-acceptance-baseline-executor.mjs scripts/stage1-clean-acceptance-baseline-executor.test.mjs
git commit -m "feat: execute atomic clean acceptance baseline"
```

---

## Task 4: 实现 CLI、受控证据文件和独立 target validator

**Files:**

- Create: `scripts/stage1-clean-acceptance-baseline.mjs`
- Create: `scripts/stage1-clean-acceptance-target-validator.mjs`
- Create: `scripts/stage1-clean-acceptance-cli-core.mjs`
- Test: `scripts/stage1-clean-acceptance-baseline.test.mjs`
- Test: `scripts/stage1-clean-acceptance-target-validator.test.mjs`

### Step 1: 写出 CLI 失败测试

baseline CLI 契约：

```text
node scripts/stage1-clean-acceptance-baseline.mjs --dry-run --output D:\evidence\dry-run.json --vehicle-id 11111111-1111-4111-8111-111111111111
node scripts/stage1-clean-acceptance-baseline.mjs --apply --output D:\evidence\apply.json --vehicle-id 11111111-1111-4111-8111-111111111111 --approved-manifest D:\evidence\dry-run.json --approved-manifest-sha256 64位小写十六进制摘要
node scripts/stage1-clean-acceptance-baseline.mjs --replay --output D:\evidence\replay.json --vehicle-id 11111111-1111-4111-8111-111111111111 --approved-manifest D:\evidence\dry-run.json --approved-manifest-sha256 64位小写十六进制摘要
```

测试要求：

- `--dry-run`、`--apply`、`--replay` 必须且只能选择一个。
- `--output` 必填且父目录必须已经存在、不是 repo 内路径、Windows/Unix 权限检查可注入测试。
- `--vehicle-id` 可重复但至少一个；另提供 `--discover-vehicles`，它只输出候选摘要并稳定返回 `VEHICLE_SELECTION_REQUIRED`，不能与 apply/replay 同用。
- apply/replay 的 manifest 文件与 SHA 必填。
- dry-run 生成新的 `generatedAt` 和 `hashSalt`；apply/replay 必须从已批准 manifest 读取并复用这两个值后重算，不接受命令行覆盖，否则必然报 `MANIFEST_STALE`。
- 未设置专用双 URL 或误设置通用 `DATABASE_URL` 时不能回退。
- stdout 只输出模式、safe、manifest SHA、报告路径和稳定错误码。
- SIGINT、连接失败和 JSON 写入失败都在 finally 中断开两个 PrismaClient。
- JSON 使用临时文件 + rename 原子落盘，权限目标为 Unix `0600`；证据目录由 runbook 预先设置 `0700`。

validator CLI 契约：

```text
node scripts/stage1-clean-acceptance-target-validator.mjs --output D:\evidence\target-validator.json --approved-manifest D:\evidence\dry-run.json --approved-manifest-sha256 64位小写十六进制摘要
```

validator 只连接 `STAGE1_ACCEPTANCE_TARGET_DATABASE_URL`，检查 migration/schema 指纹、允许表摘要、身份/RBAC、catalog/template/vehicle 闭包、禁止域零行和唯一 baseline AuditLog。

### Step 2: 实现 CLI core

`scripts/stage1-clean-acceptance-cli-core.mjs` 公开：

```js
export function parseStage1CleanAcceptanceArgs(argv)
export function assertControlledEvidencePath(outputPath, repoRoot)
export async function writeControlledJsonFile(outputPath, value, fsApi)
export function buildPublicStage1AcceptanceSummary(result)
```

对外 summary 不得包含 manifest `hashSalt` 或 `rowDigests` 原文；root-owned 报告文件允许包含执行重算所需的完整 canonical manifest，但仍不得包含业务明文。

### Step 3: 实现 Prisma 客户端创建与退出码

- 使用 `@prisma/adapter-pg` 创建 source/target 两个独立 client，日志级别不包含 query。
- 退出码：成功 0；输入/批准失败 2；分类/门禁失败 3；连接/执行失败 4；报告写入失败 5。
- 错误序列化只保留 `{ code, domain, subjectDigest }`。
- `--discover-vehicles` 生成报告但退出码为 3，确保不能被流水线误判为可 apply。

### Step 4: 运行 focused tests

```powershell
node --test scripts/stage1-clean-acceptance-baseline.test.mjs scripts/stage1-clean-acceptance-target-validator.test.mjs
git diff --check
```

### Step 5: 提交

```powershell
git add scripts/stage1-clean-acceptance-baseline.mjs scripts/stage1-clean-acceptance-target-validator.mjs scripts/stage1-clean-acceptance-cli-core.mjs scripts/stage1-clean-acceptance-baseline.test.mjs scripts/stage1-clean-acceptance-target-validator.test.mjs
git commit -m "feat: add clean acceptance baseline cli"
```

---

## Task 5: 增加真实 PostgreSQL 双库集成测试

**Files:**

- Create: `scripts/stage1-clean-acceptance-baseline-postgres.integration.test.mjs`
- Modify: `package.json`

### Step 1: 写出集成测试并确认在缺测试数据库时安全跳过

集成测试只读取 `STAGE1_ACCEPTANCE_INTEGRATION_ADMIN_DATABASE_URL`。未设置时使用 Node test runner 的 skip，不得读取 Staging 或通用 `DATABASE_URL`。

设置时测试流程：

1. 创建两个随机后缀临时数据库，名称分别为 `subscription_saas_test_stage1_source_...` 和 `subscription_saas_test_stage1_target_...`；
2. 对两个库执行当前 124 条 canonical migrations；
3. 在 source 插入完整最小夹具，在 target 保持业务表空；
4. dry-run 并断言双库业务计数零变化；
5. apply 并断言目标允许闭包、UUID/密码哈希保留、禁止域零行和一条 AuditLog；
6. replay 并断言零写；
7. 人为加入 forbidden row、stale manifest、FK 中途失败、并发 apply，分别验证阻断或完整回滚；
8. 在 `after` 中通过同一 PostgreSQL 连接逐个 `DROP DATABASE ... WITH (FORCE)`，目标只允许本测试生成且前缀精确匹配的数据库。

生产 CLI 数据库名保护不能因测试而放宽；executor 注入 Prisma clients，数据库名保护在 CLI 层单测覆盖。

### Step 2: 增加 package scripts

在根 `package.json` 添加：

```json
{
  "stage1:clean-acceptance:dry-run": "node scripts/stage1-clean-acceptance-baseline.mjs --dry-run",
  "stage1:clean-acceptance:apply": "node scripts/stage1-clean-acceptance-baseline.mjs --apply",
  "stage1:clean-acceptance:replay": "node scripts/stage1-clean-acceptance-baseline.mjs --replay",
  "stage1:clean-acceptance:validate": "node scripts/stage1-clean-acceptance-target-validator.mjs",
  "stage1:clean-acceptance:test": "node --test scripts/stage1-clean-acceptance-baseline-core.test.mjs scripts/stage1-clean-acceptance-baseline-snapshot.test.mjs scripts/stage1-clean-acceptance-baseline-executor.test.mjs scripts/stage1-clean-acceptance-baseline.test.mjs scripts/stage1-clean-acceptance-target-validator.test.mjs scripts/stage1-clean-acceptance-baseline-postgres.integration.test.mjs"
}
```

### Step 3: 运行测试

```powershell
pnpm stage1:clean-acceptance:test
git diff --check
```

未配置集成数据库时，单元测试通过且 PostgreSQL 用例明确显示 skip；在专用测试 PostgreSQL 上必须再运行一次并全部通过，证据只保存数据库前缀和计数，不保存 URL。

### Step 4: 提交

```powershell
git add package.json scripts/stage1-clean-acceptance-baseline-postgres.integration.test.mjs
git commit -m "test: cover clean acceptance baseline on postgres"
```

---

## Task 6: 将工具打包进 API runtime 镜像

**Files:**

- Modify: `Dockerfile.api`
- Modify: `apps/api/test/api-runtime-media.spec.ts`

### Step 1: 先扩展失败测试

在 `apps/api/test/api-runtime-media.spec.ts` 中要求 API runtime `/app/scripts` 包含：

```text
stage1-clean-acceptance-baseline-core.mjs
stage1-clean-acceptance-baseline-snapshot.mjs
stage1-clean-acceptance-baseline-executor.mjs
stage1-clean-acceptance-cli-core.mjs
stage1-clean-acceptance-baseline.mjs
stage1-clean-acceptance-target-validator.mjs
prisma-migration-checksums.mjs
```

先运行：

```powershell
pnpm --filter @subscription-saas/api test -- api-runtime-media.spec.ts
```

预期：新工具尚未被 runtime stage COPY，测试失败。

### Step 2: 修改 Dockerfile.api

只修改仓库版本的 `Dockerfile.api`，在 runtime stage 明确 COPY 上述生产 `.mjs` 文件；不要 COPY 测试、报告或本地临时目录。保留 main 当前 registry/install 行，不引入个人镜像源改动。

### Step 3: 验证 runtime

```powershell
pnpm --filter @subscription-saas/api test -- api-runtime-media.spec.ts
docker build --file Dockerfile.api --tag subscription-saas-api:stage1-clean-acceptance-local .
docker run --rm subscription-saas-api:stage1-clean-acceptance-local node /app/scripts/stage1-clean-acceptance-baseline.mjs --help
git diff --check
```

`--help` 必须只显示参数名和稳定约束，不打印环境值。

### Step 4: 提交

```powershell
git add Dockerfile.api apps/api/test/api-runtime-media.spec.ts
git commit -m "build: package clean acceptance database tools"
```

---

## Task 7: 编写可执行发布、候选验证、切换和回滚手册

**Files:**

- Create: `docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md`
- Create: `scripts/stage1-clean-acceptance-runbook-contract.test.mjs`
- Modify: `package.json`

### Step 1: 先写静态契约测试

测试必须断言手册含有：

- 旧库只读与禁止 repair 的醒目停止条款；
- 两个独立 `STOP FOR HUMAN APPROVAL` 标记，分别命名 `BASELINE_APPLY_APPROVAL` 和 `API_DATABASE_SWITCH_APPROVAL`；
- 新库从零创建且不使用 TEMPLATE；
- 与目标 Git SHA 相同镜像的一次性 migration deploy；
- `migrate status`、checksum verifier、真实 `migrate diff --exit-code` 和 `_prisma_migrations` 124/0 rolled-back/0 pending/0 failed/0 duplicate；
- 旧库和空新库 apply 前备份、SHA-256、`0700` 目录和 `0600` 文件；
- `--discover-vehicles`、显式 vehicle UUID dry-run、manifest SHA、apply、replay、validator；
- candidate API 使用 loopback 备用端口、不接 Nginx、禁用 workers、不创建业务数据；
- `.env.staging.images` root-only 备份、只替换 `DATABASE_URL` database path、只重建 API；
- 回滚恢复旧 env、只重建 API、保留新库；
- 两个连续 billing maintenance cycle、日志门禁和浏览器验收；
- 不允许在在线 API 容器运行 pnpm 诊断。

先运行并确认失败：

```powershell
node --test scripts/stage1-clean-acceptance-runbook-contract.test.mjs
```

### Step 2: 编写服务器预检与证据目录命令

手册固定使用：

```bash
set -euo pipefail
umask 077
readonly COMPOSE_FILE="/opt/subscription-saas/docker-compose.staging.images.yml"
readonly ENV_FILE="/opt/subscription-saas/.env.staging.images"
readonly API_CONTAINER_ID="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q api)"
test -n "$API_CONTAINER_ID"
readonly RELEASE_SHA="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$API_CONTAINER_ID")"
readonly RUN_UTC="$(date -u +%Y%m%dT%H%M%SZ)"
readonly EVIDENCE_DIR="/opt/subscription-saas/reports/stage1-clean-acceptance-${RUN_UTC}"
readonly TARGET_DB="subscription_saas_staging_acceptance_${RUN_UTC,,}"
install -d -m 0700 "$EVIDENCE_DIR"
```

compose 文件路径和 `api` service 必须先通过只读 `docker compose config --services` 与 `docker compose ps` 确认；不满足时停止，不修改上述变量去猜测其他运行对象。预检记录磁盘、内存、连接数、容器 health、Git/image SHA；不得输出环境文件内容。

### Step 3: 编写新库、migration 和备份命令

手册使用 `psql` 的 identifier 参数和 `format('%I', ...)` 创建数据库，先验证目标名 regex，再执行：

```bash
psql "$STAGE1_ACCEPTANCE_ADMIN_DATABASE_URL" \
  --set=target_db="$TARGET_DB" \
  --set=owner_role="$STAGE1_ACCEPTANCE_DATABASE_OWNER" <<'SQL'
SELECT format(
  'CREATE DATABASE %I OWNER %I TEMPLATE template0 ENCODING %L',
  :'target_db',
  :'owner_role',
  'UTF8'
) \gexec
SQL
```

`TARGET_DB` 由受控 shell 变量经 PostgreSQL identifier quoting 传入，不做 shell SQL 字符串拼接。管理员 URL 和 owner role 只从 root-owned shell 环境读取，不写入报告。随后用目标 API 镜像的一次性容器运行 migration deploy/status/checksum/diff；任何非零立即停止。

真实 drift 命令必须保留 Prisma 原始退出码，并在 API 包目录运行：

```bash
set +e
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  --env DATABASE_URL="$STAGE1_ACCEPTANCE_TARGET_DATABASE_URL" api \
  sh -lc 'cd /app/apps/api && pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code'
DRIFT_EXIT="$?"
set -e
readonly DRIFT_EXIT
test "$DRIFT_EXIT" -eq 0
```

退出码 2 表示存在 drift，退出码 1 表示命令失败；两者都必须停止，不得被管道或 workspace wrapper 归一化。

备份顺序：旧库 fresh backup、空新库 backup、各自 `sha256sum`。备份前后不得对旧库执行写事务。

### Step 4: 编写 discovery、dry-run 和批准停点

手册先运行 `--discover-vehicles`，将候选摘要交由执行者选择 UUID；随后以显式 UUID 生成正式 dry-run。正式 dry-run 必须：

- `safeToApply=true`；
- exceptions 为空；
- 目标禁止域全部 0；
- manifest SHA 与单独 `sha256sum` 证据一致；
- 文件权限 0600。

此处输出 `BASELINE_APPLY_APPROVAL` 停点，报告 SHA、脱敏计数和车辆摘要，等待用户明确批准。不得因为此前已同意设计、计划、PR 或部署而继续。

### Step 5: 编写 apply、replay、validator 和 candidate API

获批后 apply 一次，立即 replay 和 validator。candidate API：

- 使用独立容器名和 `127.0.0.1` 备用端口；
- `DATABASE_URL` 指向新库；
- 明确设置 `SUBSCRIPTION_JOURNEY_ENABLED=false`、`SUBSCRIPTION_JOURNEY_WORKER_ENABLED=false`、`BILLING_AUTOMATION_WORKER_ENABLED=false`、`FIELD_VIDEO_UPLOAD_WORKER_ENABLED=false`、`STAGE2_HANDOVER_WORKER_ENABLED=false`、`MILEAGE_REVIEW_WORKER_ENABLED=false`；对无关闭 flag 的定时入口必须从 Nest bootstrap/module 注册路径证明候选容器不会执行，无法证明则停止；
- 不连接 Nginx；
- 只验证 `/health`、admin/portal 现有 token、RBAC 菜单、产品/车辆列表和空进件/订单列表；
- 不提交进件、不锁车、不签合同、不触发短信、电子签或支付。

### Step 6: 编写数据库 URL 单字段切换和回滚

手册在服务器用受控脚本：

1. `cp --preserve=mode,ownership,timestamps .env.staging.images` 到证据目录；
2. 对备份生成 SHA-256；
3. 解析现有 `DATABASE_URL`，只替换 pathname 中 database name，保留 protocol/host/port/user/password/query；
4. 写入同目录临时文件，`chmod 600`，原子 rename；
5. 只运行 API service 的 compose recreate；
6. 不打印旧/新 URL。

切换前输出 `API_DATABASE_SWITCH_APPROVAL` 停点并等待独立明确批准。

回滚命令只恢复 env 备份并重建 API，随后验证公共 health 和旧库指纹。新库与证据保留，不 DROP、不合并回旧库。

### Step 7: 添加 package script 并运行测试

添加：

```json
{
  "stage1:clean-acceptance:runbook:test": "node --test scripts/stage1-clean-acceptance-runbook-contract.test.mjs"
}
```

运行：

```powershell
pnpm stage1:clean-acceptance:runbook:test
pnpm exec prettier --check docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md scripts/stage1-clean-acceptance-runbook-contract.test.mjs package.json
git diff --check
```

### Step 8: 提交

```powershell
git add docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md scripts/stage1-clean-acceptance-runbook-contract.test.mjs package.json
git commit -m "docs: add clean staging acceptance rollout"
```

---

## Task 8: 完成代码级质量门禁、代码审查、PR 和 main CI

**Files:**

- Modify only if failures reveal a defect in files introduced by Tasks 1–7.

### Step 1: 运行 focused suite

```powershell
pnpm stage1:clean-acceptance:test
pnpm stage1:clean-acceptance:runbook:test
pnpm --filter @subscription-saas/api test -- api-runtime-media.spec.ts
```

配置专用 PostgreSQL 测试 URL 后，再运行一次包含真实双库集成的 suite，并保存脱敏退出码、测试数和持续时间。

### Step 2: 运行仓库全量门禁

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
git diff --check
git status --short --branch
```

不得把测试生成的报告、临时数据库信息、`.env`、数据库 URL 或密码加入 Git。

### Step 3: 按规格逐条自审

建立规格覆盖矩阵，至少逐条核对：

- 旧库只读；
- minimal identity/RBAC；
- customer/e-sign binding；
- catalog/template closure；
- vehicle eligibility and closure；
- forbidden domains；
- dry-run/apply/replay；
- redaction；
- connection guards；
- target validator；
- runtime packaging；
- candidate API；
- baseline apply approval；
- API switch approval；
- rollback；
- post-switch gates。

扫描实现和文档中的未完成标记：

```powershell
rg -n "TO[D]O|TB[D]|FIXM[E]|待[定]|待[补]" scripts/stage1-clean-acceptance-* docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md
```

预期无输出。

### Step 4: 请求独立代码审查并修复发现

使用 `superpowers:requesting-code-review`。审查重点：数据最小化、PII 泄漏、跨库竞态、transaction isolation、外键顺序、replay 零写、禁止域完整性、运行时打包和手册停止点。发现问题时先添加回归测试，再修复并重跑相关门禁。

### Step 5: 提交最终修复

如果发生修复：

```powershell
git add scripts docs package.json Dockerfile.api apps/api/test/api-runtime-media.spec.ts
git commit -m "fix: harden clean acceptance rollout safety"
```

若无修复则不创建空提交。

### Step 6: 创建 PR 并等待 CI

- PR 标题：`feat: add clean staging acceptance database rollout`
- PR 描述包含规格、计划、测试证据、数据安全边界和两个未授权的操作停点。
- 确认所有 required checks 全绿后合并。
- 合并后再次确认 main required checks 全绿。
- 代码合并不触发 Staging 数据库操作。

### Step 7: 通知用户制作并拉取镜像

提供合并 commit SHA，并按 `Staging-${UTC_DATE}-${SHORT_SHA}` 规则生成实际建议标签，等待用户确认 API 镜像已制作并在服务器拉取。Web 无代码变更时不要求重建 Web；如果 CI/实际 diff 显示 Web 发生变化，再明确列出原因。

---

## Task 9: Staging 只读预检、新库创建、canonical migration 与正式 dry-run

**Prerequisites:** Task 8 已完成，用户已确认目标 API 镜像在服务器可用。本任务不授权 baseline apply。

### Step 1: 执行只读预检

**2026-08-30 binding remediation (supersedes the Task 9 execution notes below):** use only `/opt/subscription-saas/docker-compose.staging.images.example.yml` with project `subauto-staging`. Read and record the current online API only; every Task 9 migration, baseline, JSON, and URL one-shot operation uses the separately root-approved `APPROVED_API_IMAGE`, whose immutable repo digest and exact 40-lowercase-hex `org.opencontainers.image.revision` must equal `APPROVED_RELEASE_SHA`. Do not rely on host `psql`, `pg_dump`, `node`, or `jq`; use the compose `postgres` service for database commands and the approved target image for URL/JSON work. Require all three public HTTP 200 checks before creating the database.

The required order is: preflight; create a brand-new `template0` target and prove zero user tables; source fresh backup then empty-target pre-migration backup; approved-target migration and canonical gates; exact zero counts for every public business table except `_prisma_migrations`; discovery; explicit UUID; formal dry-run asserting `safe`, `safeToApply`, empty exceptions, zero forbidden counts, and independent canonical manifest SHA equality; then stop at `BASELINE_APPLY_APPROVAL`. Source must be exactly `subscription_saas_staging`; target must not exist and source/target URLs preserve protocol, host, port, user, password, and query while changing only pathname. Preserve root-owned non-link `0700`/create-once `0600` evidence and never emit secrets or raw identities.

按 runbook 核对：

- 当前公共 API/Admin/Portal 健康；
- 当前镜像、目标镜像与 Git SHA；
- 主机磁盘、内存、PostgreSQL 连接余量；
- 源库名和目标库名保护；
- 旧库未发生任何修复或写入。

### Step 2: 创建新库并应用 canonical migrations

创建由 runbook 中 `TARGET_DB="subscription_saas_staging_acceptance_${RUN_UTC,,}"` 计算出的数据库，从 `template0` 开始。使用目标镜像一次性容器运行 `prisma migrate deploy`，不使用当前在线 API 容器。

### Step 3: 验证数据库门禁

必须全部满足：

- migration 目录 124，已完成 124；
- rolled-back、pending、failed、duplicate 均为 0；
- checksum mismatch 为 0；
- datasource→schema drift 为 0，真实命令退出码为 0；
- 目标业务表为空。

### Step 4: 创建 apply 前备份

创建旧库 fresh backup 与空新库 backup；记录 SHA-256、权限、大小和 UTC 时间。旧库 backup 是回滚证据，不用于新库 restore。

### Step 5: 运行 vehicle discovery 和正式 dry-run

先生成候选车辆脱敏清单，再由执行者明确选择 UUID。正式 dry-run 重跑并验证 `safeToApply=true`、exceptions 为空、目标禁止域为零、manifest SHA 稳定。

### Step 6: 停止并请求第一次人工批准

向用户报告：

- 目标 Git/image SHA；
- 新库不可逆摘要；
- migration/checksum/drift 结果；
- 白名单各领域计数；
- 选定车辆脱敏摘要；
- forbidden counts；
- dry-run manifest SHA；
- 备份 SHA；
- 明确说明旧库零写、新库尚未导入业务基线。

然后停止，等待用户明确批准 `BASELINE_APPLY_APPROVAL`。

---

## Task 10: 获批后执行 baseline apply、replay 和 target validator

**Prerequisite:** 用户在 Task 9 证据之后明确批准 baseline apply。

### Step 1: 精确设置 apply 确认并执行一次

设置 `STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY=1`，传入 Task 9 受控 manifest 文件和精确 SHA。执行一次 apply；不因失败自动重试。

### Step 2: 立即 replay

同一 manifest 和 SHA 运行 replay，要求所有写计数为 0、manifest SHA 不变。

### Step 3: 运行 target validator 与数据库门禁

再次验证 migration/checksum/drift、允许闭包、禁止域零行、唯一 baseline AuditLog。任何失败都停止，不启动 candidate API，不修补数据。

### Step 4: 报告 apply 证据

报告脱敏计数、apply/replay/validator SHA 和退出码。保留原始证据在服务器受控目录，不把报告提交 Git。

---

## Task 11: 启动 candidate API 并请求第二次人工批准

**Prerequisite:** Task 10 全绿。本任务在获得批准前不修改正式 API 配置。

### Step 1: 启动隔离 candidate API

使用目标镜像、新库、独立容器名和 loopback 备用端口。确认不接 Nginx，worker flags 有代码级依据且均关闭。

### Step 2: 执行只读候选验证

验证：

- `/health` 200；
- `keqi_119` 现有管理员登录态或重新登录有效，ADMIN 菜单完整；
- `18616570212` Portal 登录态或重新登录有效，profile/e-sign binding 可读；
- 产品/套餐/合同模板/车辆列表可读；
- application/order/contract/billing/change/return 列表为空；
- 未产生新 AuditLog、业务行、短信、电子签、支付或 worker job。

### Step 3: 停止并请求第二次人工批准

向用户报告 candidate API 只读结果、target validator、日志扫描、正式 API 仍指向旧库和回滚准备情况。然后停止，等待用户明确批准 `API_DATABASE_SWITCH_APPROVAL`。

---

## Task 12: 获批后切换 API、观察、浏览器复验并交付人工验收

**Prerequisite:** 用户在 Task 11 证据之后明确批准正式 API 数据库切换。

### Step 1: 进入短维护窗口并切换

暂停新的 Staging 人工操作，保存 `.env.staging.images` root-only 备份与 SHA，只替换 `DATABASE_URL` database path，原子落盘，只重建 API service。

### Step 2: 即时门禁

验证：

- API/Admin/Portal 公共 health 200；
- API restart count 无异常增长；
- admin/portal 鉴权、RBAC、profile、产品、车辆和空历史列表；
- target validator 全绿；
- worker flags 与四个合同变更 feature flags 精确为预期值；
- 日志无 ERROR、FATAL、Unhandled、Prisma known error、5xx 和 PII 输出。

任何 P0/P1、health、auth、validator 或日志失败立即按 runbook 回滚旧 env 并只重建 API。

### Step 3: 观察两个 billing maintenance cycle

等待两个实际调度周期，逐次记录开始/结束时间、`blockedCount=0`、无意外 job/outbox/notification/bill 写入和无错误日志。不得用手工写表模拟周期通过。

### Step 4: 浏览器视觉复验

使用 admin 与 portal 现有测试账号进行只读视觉验收：

- Admin：首页、客户、产品/套餐、车辆、进件、订单页面；
- Portal：profile、选车、产品计划、进件/订单空态；
- 无历史订单污染、入口缺失、原始枚举、错误 helper、明显布局问题和控制台 error/warn；
- 不创建新进件，直到所有自动门禁报告完成。

保存截图和控制台摘要到服务器/本地受控证据目录，不提交 Git。

### Step 5: 提供阶段 1 人工验收清单

最终通知必须包含：

- 运行版本与切换 UTC；
- 新/旧数据库不可逆摘要；
- migration/checksum/drift；
- baseline apply/replay/validator；
- candidate 与正式 API health/auth；
- 两个 billing cycle；
- 浏览器视觉报告；
- 回滚备份与观察窗口状态；
- 明确允许用户从 Portal 新建第一张阶段 1 验收进件。

人工验收清单按全新数据 journey 编排：Portal 选车进件 → 管理员材料/风控/押金与一次性最终方案 → 客户一次确认 → 车辆软锁 → 合同制作/签署/归档 → 交付前证据驳回恢复 → field handover 增量确认与 PDF → 起租/账单/主动支付与催收 → 租期内续期/换车/提前结束/其他变更 → 退车取回/差异计费/争议与核销 → 合同正常闭环。

---

## Completion Definition

本计划仅在以下条件全部满足时完成：

1. 所有新增工具、测试和 runbook 已合并到 main，PR 与 main required CI 全绿；
2. 目标镜像包含生产工具且与 merge SHA 一致；
3. 新库 canonical migration/checksum/drift 门禁全绿；
4. baseline apply 已单独批准并成功，replay 零写，validator 全绿；
5. candidate API 只读验证全绿；
6. 正式数据库切换已单独批准并成功，或失败后已完整回滚；
7. 两个 billing maintenance cycle 与浏览器视觉复验全绿；
8. 用户已收到可开始“完整阶段 1 人工验收”的明确通知和清单。

如果任一条件未满足，只报告当前证据与阻断点，不宣称阶段 1 已具备人工验收条件。
