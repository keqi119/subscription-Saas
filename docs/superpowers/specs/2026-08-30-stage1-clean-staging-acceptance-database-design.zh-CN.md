# 阶段 1 干净 Staging 验收数据库设计

**日期：** 2026-08-30
**目标版本：** `Staging-20260829-6aee8da` 及其后续仅包含本设计工具的发布版本
**状态：** 已完成对话设计确认，等待规格复核
**适用环境：** `subscription_saas_staging` 的并行验收数据库，不适用于 Production

## 1. 背景与问题

当前 Staging API/Web 镜像、公共健康检查和 124 条 migration 数量均正常，但数据库不满足阶段 1
数据发布门禁：

- 迁移目录和已应用 migration 均为 124 条，checksum 校验仍有 58 个 mismatch，`safe=false`；
- 既有发布手册记录的继承停止证据为 59 个 mismatch，因此当前计数与已保存证据也不一致；
- 当前库还继承非空 datasource/schema drift、rolled-back migration 和历史业务测试残留的停止结论；
- 源事实 dry-run 仅能证明一张订单可执行 `SET_ORDER_DATES`，另外三张 ACTIVE 订单分别存在
  `SIGNED_ARTIFACT_MISMATCH` 或 `ACTIVATION_EVIDENCE_MISSING`，整体 `safeToApply=false`；
- 继续修改 `_prisma_migrations`、接受 checksum、推断合同或激活证据均违反现有发布约束。

因此，不在当前库上重写历史或放宽门禁。本设计建立一套并行、可回滚、最小数据的干净验收数据库，
把当前库保留为只读证据和快速回滚来源。

## 2. 目标与非目标

### 2.1 目标

1. 从当前代码包含的 124 条 migration 从零建立 canonical schema。
2. 保持原 Staging 数据库不变，并保留切换前新鲜备份和配置快照。
3. 仅迁移阶段 1 人工验收所需的最小身份、权限、产品、合同模板和可用车辆基线。
4. 保持 `keqi_119` 管理员、`18616570212` 客户身份及相关 UUID，尽量延续现有登录会话。
5. 不迁移任何历史交易、流程或审计记录；新库中的第一条业务链从新的 Portal 进件开始。
6. 通过 dry-run、独立 apply 批准、replay、候选 API 和蓝绿切换建立可审计证据链。
7. 达到 checksum、schema drift、rolled-back migration、源事实、合同分段、车辆期间和账单阻断均为零的
   阶段 1 人工验收准入状态。

### 2.2 非目标

- 不修复、删除或重写当前 `subscription_saas_staging` 数据库。
- 不把当前历史订单、合同、交接、账单、退车或审计记录复制到新库。
- 不运行 generic `prisma:seed`，不创建默认密码或通用演示客户。
- 不修改历史 migration，不运行 `prisma migrate reset`、`prisma db push` 或
  `prisma migrate resolve`。
- 不改变 Production 数据库、域名、对象存储、短信、电子签或微信支付配置。
- 不以本次基线导入替代新的 golden path 人工验收。

## 3. 方案选择

### 3.1 采用：受控白名单迁移

在现有 PostgreSQL 实例内创建独立数据库，先应用 canonical migrations，再通过专用工具从旧库只读
提取严格白名单记录并在新库原子写入。工具保持 UUID，输出脱敏计数与不可逆摘要，并在目标库建立一条
新的基线导入审计。

该方案同时满足：旧库不变、canonical migration 历史、账号连续性、最小业务数据、可重放和快速回滚。

### 3.2 不采用：generic seed

generic seed 会创建默认用户、默认密码、演示客户、车辆和产品，并清理/改写 seed 自身管理的数据。
它不保留现有身份 UUID，也不满足 Staging 禁止默认凭证和通用演示数据的约束。

### 3.3 不采用：整库复制后清理

整库数据复制会把历史进件、合同、账单、车辆期间、审计和异常关系带入目标库。通过事后 TRUNCATE 或
级联删除证明完全清理的成本和风险高于白名单迁移，且容易再次形成“当前零行但历史证据不明”的状态。

## 4. 运行架构

### 4.1 数据库拓扑

- 旧库：`subscription_saas_staging`，在整个迁移和切换期间保持不变。
- 新库：使用稳定前缀 `subscription_saas_staging_acceptance_` 加 UTC 创建时间，例如
  `subscription_saas_staging_acceptance_20260830t010203z`。
- 两个数据库使用当前 PostgreSQL 实例和现有数据库角色；不增加第二个常驻 PostgreSQL 容器，避免在
  2C/2G 主机上新增 512 MiB 常驻内存占用。
- API 的数据库路径只在最终切换时改变；Web、域名、JWT、短信、电子签和 OSS 配置不变。

### 4.2 组件

1. `stage1-clean-acceptance-baseline` CLI：双连接、dry-run-first 的白名单分类和导入工具。
2. manifest：记录源库指纹、目标库标识、候选类别计数、行摘要和整体 SHA-256，不包含敏感明文。
3. target validator：验证迁移、schema diff、禁止表零行、白名单引用闭包、UUID 和业务不变量。
4. candidate API：使用新库、备用 loopback 端口运行的临时 API，用于切换前健康和鉴权验证。
5. rollout runbook：定义备份、审批、apply/replay、候选验证、切换、观察与回滚命令。

CLI、validator 和运行手册必须进入代码评审、PR、main CI，并显式打包进后续 API runtime 镜像。

## 5. 数据白名单

### 5.1 系统身份与 RBAC

迁移全部有效 `role`、`permission`、`menu` 及其有效 `role_permission`、`role_menu`，但 `user` 仅迁移
唯一、有效、未删除的 `keqi_119`，`user_role` 仅迁移该用户的有效授权。管理员必须持有唯一有效
`ADMIN` 角色，且该角色覆盖全部有效权限和菜单；否则阻断。

迁移管理员原 UUID 和密码哈希，但密码哈希不得进入 stdout、报告、日志或 manifest。历史登录时间可以
保留，用户创建/更新审计不迁移。

### 5.2 客户身份

仅迁移手机号 `18616570212` 对应的唯一有效：

- `customer`；
- `customer_account`；
- `customer_identity`；
- `customer_profile`；
- `customer_esign_provider_account`，前提是其身份与客户严格一致且状态可重用。

不迁移验证码、Portal 材料文件、客户附件、会话表、进件或旧订单。客户和账号 UUID 保持不变，以便现有
JWT 在签名和有效期仍合法时继续工作；切换验收仍必须验证实际 token，而不能把 UUID 一致视为成功。

手机号、身份证号、住址、电子签账户标识和密码/令牌均不得出现在公开报告。manifest 只保存带领域前缀
和随机 salt 的 SHA-256 摘要。

### 5.3 产品、规则与合同模板

迁移以下最小引用闭包：

- 当前有效押金规则；
- Portal 可售的活动 `Product`、`ProductVersion`；
- 其活动 `VehiclePackage`、`VehiclePackageModelMember`、`MileagePackage`、`EnergyPackage`、
  `BenefitPackage` 和 `SubscriptionPlan`；
- 阶段 1、交接、续期、换车、提前结束和其他受管变更需要的唯一有效 `ContractVersion`；
- 这些合同模板显式引用且仍有效的 `FileObject`；
- 流程会读取的有效通知模板。

只迁移被所选活动计划和模板引用的依赖。存在多个同时有效但业务键冲突的规则/模板、跨产品引用、缺失
组件、无效期限、未批准合同模板或文件引用不完整时阻断，不采用“最新一条”猜测。

### 5.4 可用车辆与资产事实

只迁移至少一辆明确满足下列条件的车辆及其最小引用闭包：

- 当前状态和销售价状态满足现有可用车辆守卫；
- 有 Portal 可见 listing/profile/plan；
- 无未删除的订单引用、Review reservation、正式 reservation、开放 Lease、交付、退车、开放车辆订阅
  期间、活动工单或运营限制；
- 行驶证、保险和车辆展示资料满足新 golden path 的当前读取要求；
- 车型定义和套餐车型成员一致；
- 如存在平台权属、成本档案或不可变成本台账，则其事实完整且引用闭合。

目标闭包允许的资产表包括：车辆、车型定义、listing/profile/media/plan、车辆文件批次与文件、listing
来源绑定、保险及 coverage、当前有效销售价历史、平台 `AssetOwner`、车辆权属期间，以及通过校验的必要
成本档案/成本台账。市场样本、残值预测、折旧任务、服务工单、事故、交付、退车和任何订阅期间不迁移。

车辆筛选不得只依赖 `Vehicle.status`。候选为零或多辆时，dry-run 输出脱敏候选摘要并阻断，必须在批准
中明确选定一个或一组 vehicle UUID 后重新生成 manifest。

### 5.5 明确禁止迁移的数据

下列领域在目标库必须为零：进件及资料审核、报价、正式订单、合同实例与签署任务、Golden Path、车辆
预留/交付/交接、Lease、合同分段、车辆订阅期间、账单/支付/催收/核销、合同变更、退车/Closure、服务
工单、通知发送、历史审计、任务队列、命令 receipt、callback 和 idempotency 记录。

validator 必须以版本化的明确表清单断言零行，不能依赖名称前缀或“除白名单外全部为空”的动态猜测。

## 6. 安全契约与执行模式

### 6.1 连接约束

工具只接受两个专用环境变量：

- `STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL`：数据库名必须精确为当前 Staging 旧库；
- `STAGE1_ACCEPTANCE_TARGET_DATABASE_URL`：数据库名必须匹配
  `^subscription_saas_staging_acceptance_[a-z0-9_]+$`。

源库和目标库必须位于批准的 Staging PostgreSQL 主机且数据库名不同。任何 URL 缺失、同库、非预期
主机、非 TLS/内网连接策略或目标库非空均在连接后、写入前失败。公开错误只输出稳定错误码。

### 6.2 dry-run

- 源库在 `REPEATABLE READ, READ ONLY` 事务中读取显式字段。
- 目标库只读取 migration catalog、schema 指纹和零行门禁。
- 输出候选类别计数、异常码、引用闭包计数、目标数据库不可逆指纹、manifest SHA-256 和
  `safeToApply`。
- dry-run 不写源库、目标库、审计或本地 repo；原始 manifest 仅写入服务器 root-owned `0700` 证据目录。
- 任一 exception、ambiguity、目标非空、迁移异常、schema drift 或候选数量异常使退出码非零。

### 6.3 apply

apply 同时要求：

- 精确环境确认值 `STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY=1`；
- `--approved-manifest-sha256 <sha256>` 与刚生成的 dry-run manifest 完全一致；
- 当前源/目标重新分类得到相同 manifest；
- 目标库仍满足零行和 canonical schema 门禁。

源库保持只读。目标库取得 advisory lock，在单个 `SERIALIZABLE` 事务中按引用顺序写入所有白名单记录，
然后创建且仅创建一条 `stage1_acceptance_baseline` 导入审计。任一写入、审计或约束失败整批回滚。

### 6.4 replay

apply 后立即在相同审批范围内 replay。预期新增、更新、删除和审计数量均为零，UUID、业务键和 manifest
摘要不变。随后运行 target validator。任何非零写入或不变量失败停止切换。

## 7. 新库建立与迁移门禁

1. 验证磁盘、PostgreSQL 连接数和当前 API 健康；不在在线 API 容器中启动 pnpm 包装诊断。
2. 创建新数据库，不使用旧库 TEMPLATE，不复制 `_prisma_migrations`。
3. 使用与目标 Git SHA 完全一致的 API 镜像，在一次性容器内执行 `prisma migrate deploy`。
4. 使用直接 Prisma CLI 运行 migrate status，并运行专用 checksum verifier。
5. 使用 `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` 验证零 drift。
6. 只读查询 `_prisma_migrations`，要求：124 条完成、0 rolled-back、0 pending/failed、0 duplicate。
7. 在任何白名单 apply 前创建新鲜旧库备份、目标空库备份和 SHA-256；报告目录及备份权限为 `0700`。

任一门禁非零立即停止；不得通过 `migrate resolve`、修改 checksum 或手工建表继续。

## 8. 候选 API、切换与回滚

### 8.1 候选验证

基线 replay 和 validator 通过后，以新库环境启动临时候选 API：

- 使用独立容器名和未公开的 loopback 备用端口；
- 不连接 Nginx，不接收公网写流量；
- Billing、journey 和其他 worker 在候选容器中关闭；
- 验证 health、`keqi_119` 鉴权、`18616570212` Portal 鉴权、菜单权限、产品/车辆只读列表和空订单列表；
- 不在候选验证中创建进件或订单。

失败时删除候选容器，保留目标库和证据供诊断，当前公网 API 不受影响。

### 8.2 正式切换

1. 保存 `.env.staging.images` 的 root-only 备份和 SHA-256。
2. 进入短维护窗口，停止新的 Staging 人工操作并等待在途请求完成。
3. 只修改 `DATABASE_URL` 的数据库路径，不打印或重写其他凭证。
4. 只重建 API 容器；Web、PostgreSQL 和 Nginx 不重建。
5. 等待 API healthy，执行公共 health、管理员/Portal 只读鉴权和 target validator。
6. 验证 worker flags，再退出维护窗口。

### 8.3 回滚

若 API 未 healthy、鉴权失败、validator 非零、出现 P0/P1 日志或白名单数量不符：

1. 恢复旧 `.env.staging.images`；
2. 只重建 API；
3. 确认公共 health 和旧库只读指纹；
4. 保留新库，不删除、不重跑 apply；
5. 记录失败时间、镜像 SHA、配置/manifest/备份 SHA 和脱敏错误码。

回滚不得把新库产生的数据合并回旧库，也不得清理审计或运行 migration history repair。

## 9. 切换后准入门槛

切换后必须同时满足：

- API/Web/PostgreSQL healthy，公网 Admin、Portal、API health 均为 HTTP 200；
- migration status、checksum、schema drift、rolled-back/pending/failed/duplicate 均为零异常；
- `keqi_119` 为唯一迁移管理员并持有完整 ADMIN 权限；
- `18616570212` Portal 登录和 profile 正常，订单/进件列表为空；
- 至少一个活动订阅计划、所需合同模板和至少一辆通过完整可用性守卫的 Portal 车辆；
- 所有禁止交易领域表为零，审计仅有本次基线导入记录；
- `SUBSCRIPTION_EXTENSION_ENABLED`、`SUBSCRIPTION_VEHICLE_SWAP_ENABLED`、
  `SUBSCRIPTION_EARLY_TERMINATION_ENABLED`、`SUBSCRIPTION_MANAGED_OTHER_ENABLED` 在 Staging 精确为
  小写 `true`；
- 连续两个账单维护周期 `blockedCount=0`，无 `ERROR`、`FATAL`、Unhandled、Prisma known error 或 5xx；
- 浏览器视觉复验无历史应用/订单污染、入口缺失、原始枚举泄漏或控制台 error/warn。

门槛通过后才通知用户从 Portal 新建第一张阶段 1 验收进件。新进件产生的日期、BASE 分段、车辆订阅
期间、账单计划和审计必须由当前正常业务写路径建立，不运行历史 backfill。

## 10. 测试与发布

### 10.1 自动化测试

- manifest 解析、canonical hash、脱敏和稳定排序单元测试；
- 用户/RBAC、客户身份、产品/模板、车辆闭包的正反分类测试；
- 双连接保护、目标数据库名、同库拒绝和非空目标拒绝测试；
- dry-run 零写入、apply 原子回滚、stale manifest、并发 advisory lock 和 replay 幂等测试；
- 临时 PostgreSQL 集成测试：从 124 条 migration 建库，导入最小夹具并证明禁止表零行；
- runtime image packaging 测试；
- rollout runbook 的命令/确认值/停止点静态契约测试。

### 10.2 质量门禁

完成 focused tests 后运行 Prisma validate/generate、API/Web/shared lint、typecheck、全量 tests 和 build，
`git diff --check` 必须通过。PR CI 和合并后 main CI 必须全绿。代码/PR/镜像批准不等于任何数据库 apply
或切换批准。

### 10.3 独立审批点

实施阶段至少保留以下独立人工批准：

1. 白名单 baseline apply；
2. 正式 Staging API 数据库切换。

新库创建、migration deploy、dry-run、备份和候选 API 只读验证不扩大为上述两个写入/切换批准。

## 11. 证据与保留

同一 root-owned 证据目录保存：目标 Git/image SHA、旧/新数据库不可逆指纹、migration/status/checksum/
drift 报告、dry-run/apply/replay manifest 及 SHA-256、备份及环境配置 SHA-256、候选 API 结果、切换与
回滚时间线、两周期日志摘要和浏览器验收截图。

报告不得进入 Git。数据库备份、完整 manifest 和包含身份数据的原始证据仅留在服务器受控目录；对外
报告只发布计数、稳定错误码和不可逆摘要。

## 12. 已确认决策

- 采用并行干净验收数据库，不修复当前库历史。
- 采用受控白名单迁移，不使用 generic seed 或整库复制后清理。
- 保留 `keqi_119` 和 `18616570212` 身份/必要 profile，排除历史交易和审计。
- 使用同一 PostgreSQL 实例内的新数据库，避免新增常驻容器资源。
- 使用 dry-run/apply/replay、候选 API、独立切换批准和可逆 API 配置切换。
- 完整阶段 1 人工验收从新进件开始。
