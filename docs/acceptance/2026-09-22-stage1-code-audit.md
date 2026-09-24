# Stage 1 当前代码审计与收口差距

审计日期：2026-09-22。结论：**阶段 1 尚不可收口。主流程已有大量实现，但本次发现 2 项 P1 业务一致性问题、4 项 P2 实现问题及 1 项已知测试错误；人工 Runner 接入、真实发布输入和同候选验收仍未闭环。**

本报告只陈述本次可核事实及代码推导，不授权业务修复、数据库、真实身份/密钥、供应商或部署操作。后续顺序见 [收口计划](../superpowers/plans/2026-09-22-stage1-audit-driven-closure-plan.md)。

## 1. 基线与证据边界

- 审计工作树：`D:/Projects/auto-subscription-platform/.worktrees/stage1-s1-execution-infrastructure-20260903`。
- HEAD：`bf057cf1399e6c87c9946f1d4bcd3d2d8bcaee6c`，2026-09-13 的 `feat(release): bind MS2 manual target context`。
- 开始审计时受跟踪文件无修改；保留原有未跟踪的 `docs/superpowers/plans/2026-09-09-stage1-remaining-work-and-acceptance-checkpoints.md`。
- 相对本地 `main`，此分支领先 187 个提交、落后 0 个。未 fetch，不能据此断言远端状态；当前工作树不等于受保护 main 或已部署候选。
- 对照来源：`AGENTS.md`、2026-09-06 最小受控发布决策/覆盖路线图、当前 R1/R2 计划、2026-09-10 的 90 日前向政策、B1/B3/B5 小计划及现有验收记录。后续提交优先于旧文档滞后的状态段。
- 方法：实际生产入口、调用链、事务及测试代码静态审计；主控复核并行审计发现；两个离线契约检查；一个纯内存协议反例；现有 R1.3H 原件摘要和 Git 字节核对。
- 未执行业务单测全套、PostgreSQL、Prisma migrate status、Docker、供应商调用、远端构建或浏览器验收。两项业务 P1 和支付竞态是明确代码时序推导，**不是本轮已完成的真实 PG 复现**。

## 2. 需要修复的发现

### F1 · P1：建单重算实时价格，突破客户已确认的商业快照

位置：`apps/api/src/customer/customer.service.ts:1270`、`:1302`、`:1330`、`:1372`、`:1385`；重算来源 `:3235`。可修改的来源示例：`apps/api/src/product/product.service.ts:723`。

`createOrderFromApplicationInTransaction` 在客户已确认后再次调用 `loadApplicationFinalPlanDetails`，从实时车价及里程/能源/权益包计算月费。新 Quote/Order 使用重算值，但 `finalPlanSnapshot`/`quoteSnapshot` 保留旧确认快照。`assertApplicationCanCreateOrder`（`:3480`）只核状态、审核、押金和确认快照存在，没有将这次重算结果与确认商业哈希比较。

触发顺序：客户确认方案 → 运营修改里程包价格或车辆销售价 → 建单 job 执行。订单金额、额度等事实可能与确认快照不同，且未要求客户确认新修订。修改套餐的接口本身不使该 Application 的已确认 revision 失效。

收口要求：建单不能静默采用未确认的商业事实。先补真实服务反例，再采用既有确认快照作为权威，或在漂移时拒绝建单并走既有新修订/重新确认流程；必须明确一种行为。不得只更新快照使其追认新价格。

### F2 · P1：取消/拒绝与建单存在检查后状态改变的竞争窗口

位置：`apps/api/src/customer/customer.service.ts:2868`、`:2876`、`:2894`；拒绝同型路径 `:2941`、`:2947`、`:2970`。关联建单：`apps/api/src/subscription-journey/subscription-journey.service.ts:1055`。

取消/拒绝先在事务外读取 Application 并检查无订单；进入事务后继续使用旧对象，按 id 更新状态，未在共同锁下重新检查订单。

可达交错：取消读到无订单后暂停 → Journey 建单事务提交订单/合同 → 取消继续。车辆已转 RESERVED，释放函数 `customer.service.ts:3164` 返回 null；Application 仍变 CANCELLED/REJECTED，终止信号取消 Journey/jobs，而订单/合同及车辆占用仍存在。这违反已有“已生成订单禁止处理”的规则。

收口要求：沿现有 Journey/Application/Vehicle 权威锁顺序序列化并在锁内复读；确定性交错测试覆盖取消和拒绝、两个先后顺序。不能只在事务外再查一次，也不能引入相反锁序制造死锁。

### F3 · P2：错误金额回调可能将已到账支付单回退为 FAILED

位置：`apps/api/src/payment/payment-order.service.ts:706`、`:720`、`:722`；正常资金事务 `apps/api/src/finance/finance.service.ts:263`。

错误金额回调读到 PENDING 后，正常回调可以先提交 PAID、确认收款、核销和账单更新；随后错误分支在事务外按 id 无条件写 FAILED。外层 `handleCallback:534` 有渠道、验签和事件检查，但没有覆盖此窗口的共同锁/状态条件。

触发需要一个已通过渠道验签但金额与支付单不符的成功事件，与合法回调交错；不是未验签请求即可改状态。影响是支付单 FAILED 与到账/核销事实矛盾。静态路径已复核，未运行真实 PG 反例。

收口要求：拒绝错误金额不得覆盖已经完成的资金事实；错误记录与状态处理必须受同一支付权威锁或等价 CAS 保护。测试既要断言不多收/多核销，也要断言已完成状态不倒退。

### F4 · P2：带换行的非法短帧头被当成尚未收完的前缀

位置：`packages/release-foundation/src/manual-runner-evidence.mjs:833`。`text.length < 4` 分支检查字符串是 MS1/MS2 的前缀，却未要求 `headerEnd < 0`。

本轮直接调用纯 parser 已复现：

| 输入，ended=false | 实际结果 | 应有语义 |
| --- | --- | --- |
| `M` / `MS2` | pending | 合法未完成前缀 |
| `M\njunk` / `MS2\njunk` | pending，0 个 frame | 已有 LF，header 不可能再补全，应拒绝 |
| `MS2 X\n` | MANUAL_FRAME_INVALID | 拒绝 |

静态影响链：`:1583` 在 original-apply reconcile 的 `allowMissingResult` 模式使用 ended=false；`:1643` 允许最后完整帧为 ACK_RECEIVED；`:2887` 之后在其他迁移事实合格时可返回 SUCCEEDED/committed。非法尾部因此可能逃过原 apply 的协议核验。**本轮复现了 parser 行为；上述完整归档误判是代码路径推导，没有伪称已跑完整 reconcile。**

这是既有共享 decoder 缺陷在 MS2 中继续存在，不据此判定为 bf057cf1 新引入。修复必须覆盖 MS1/MS2、双向流及 ACK_RECEIVED 后的归档反例，同时保留真正未完成前缀与合法 interrupted-apply 的恢复能力。

### F5 · P2：主线预检仍把退款额度作为硬前置

位置：`scripts/stage1-golden-path-production-preflight.mjs:155`；固化旧行为的测试 `scripts/stage1-golden-path-production-preflight.test.mjs:184`。

未提供退款额度或退款额度大于付款额度时，主线预检拒绝。这与当前 Runbook 和执行索引已确定的“退款独立收尾，不阻断主线”冲突。此问题已有历史登记，本次确认仍未修复。

收口要求：只移除主线总预检中的退款依赖；继续严格校验付款额度、专用 payer/资产、渠道、通知、callback 和代扣禁用。独立退款流程的额度和财务核对要求仍有效，不开发退款 API。

### F6 · P2：当前运营完结入口未留下关键操作审计

位置：`apps/api/src/subscription-closure/subscription-return-governance.service.ts:3330`，入口 `apps/api/src/subscription-closure/subscription-closure.controller.ts:428`。

`completeOperations` 更新 Order、Contract、Closure 后在 `:3350` 直接返回，没有 AuditLog/ClosureEvent。检查 controller、全局 interceptor、AuditModule、PrismaService 和迁移后，未发现自动审计补偿。`updatedBy` 不能替代操作前后事实的审计记录，当前行为不满足 AGENTS 对关键操作的要求。

收口要求：复用既有审计设施，在真实正常结束事务中保存操作者、对象、前后状态和幂等关联；重放不重复产生完结事件，失败不能留下成功审计。不以新增模型/权限/通用审计平台解决。

### F7 · P2，测试缺陷：B3 成功归档用例仍期待错误的下一步骤

位置：`apps/api/test/stage1-contract-archive.integration.spec.ts:758`；真实顺序 `apps/api/src/subscription-journey/subscription-journey-state-machine.ts:10`。

测试仍期待 CUSTOMER_JSAPI_PAYMENT，状态机先进入 INITIAL_BILLING。既有两份 B3 运行报告均为 2/3，后续断言未完整通过。已批准的 Task 3S 一行期待修正仍未进入当前代码。应按原 owner/唯一 fresh 流程续接，保留历史失败；不修改生产状态机迎合旧测试。

## 3. 距离阶段 1 收口的覆盖矩阵

| 范围 | 当前代码及证据 | 仍需交付 |
| --- | --- | --- |
| P0/P1 | 受控开发准入及精确退役已有历史记录 | 不重建已退役目标；最终候选另有自身门禁 |
| B1 进件/等待 | Application/Journey/worker 业务分类存在；Task 1 测试已实现 | Task 2 真实服务组合、Task 3 正常等待与技术重试矩阵、Task 4 当前 fresh；F2 |
| B2 方案/确认/建单 | 行锁、车辆 CAS、revision/hash 确认、订单/合同复用存在 | F1/F2；同车竞争、旧 revision、重复确认/建单及回滚的真实服务 PG 用例 |
| B3 归档 | 实际 ESign/Artifact/Journey + PG 组合存在，provider/storage 为替身 | F7 及 Task 3S 完整 3/3；供应商真实归档另验 |
| B4 激活 | 统一 LeaseActivationEngine 核合同、核销、交付等权威事实并事务写入 | 真实入口 PG 成功/重复/后段回滚/提交后 job ack 失败恢复 |
| B5 支付/账单 | 验签、资金事务、核销、幂等 schedule/job 代码存在 | F3；payment-authority PG 文件与清单登记、正向重复维护、独立本轮报告 |
| B6 正常结束 | 当前 completeOperations 及前置实物接收路径存在 | F6；通过当前入口验证无争议且已清偿的全事实终态及重放 |
| R1/RP/R1.3H | R1.1/E/2、90 日同步、固定 trust reader、MS2 纯契约已提交；R1.3H 245/245 原件匹配 | F4；真实 H1/H2 不由纯模块测试证明 |
| R2 | R2.0 Prisma 固定配置已实现 | R2.1 adapter/observer、R2.2 launcher/entrypoint、R2.3 独立 verifier/真实测试入口均未创建；R2.4 未执行 |
| H1 | loader 硬编码固定 v2 profile/owner binding 并检查主机/ACL | 两个真实非秘密文件当前不存在；真实身份、台账、加密备份/恢复读回 |
| H2 | CI 请求 90 日 artifact；verifier 要求独立 custody receipt 与同 run attestation | 实际权威保管 producer/readback/receipt/attestation/import；不能仅下载 Actions artifact |
| H3 / expected-schema | 两阶段权限与固定目标来源已有详细契约 | 独立预期 Schema 的生成/保管来源；两个合成场景各自 H3-A、迁移、H3-B、只读验证 |
| R3 / A2 | 旧 suite/manifest/隔离能力可复用 | 合法 snapshot 输入、选定隔离边界实测、人工路径适配、最终同候选完整 fresh/snapshot/readiness |
| R4 / A1 / A3 | UI、供应商接口、Runbook 已有 | 固定 digest 提升/恢复演练；同候选 A/B 新订单及成熟正常结束样本；两次有正向对象的维护；真实浏览器/渠道/通知及签字 |

### 当前测试容易被过度解读的地方

- `subscription-journey-golden-path.e2e-spec.ts:95` 直接写 Application/推进状态，`:525` 的激活 adapter 直接写 Lease/Schedule/Order。它不能替代生产服务的 B2/B4 成功与事务竞争证明。
- `subscription-journey-failure-recovery.e2e-spec.ts:46` 主要测试 repository job 恢复，不能证明“业务事务成功、job 完成失败”时真实业务入口的重放。
- 现有 `vehicle-availability.integration.spec.ts` 有真实引擎被限制挡住的反例，不等于已覆盖完整激活成功及后段回滚。
- `subscription-expiry-return.integration.spec.ts:3415` 跑旧 settleManagedSettlement；当前 completeOperations 在测试目录仅有 controller mock，不等价。
- 当前没有 `apps/api/test/payment-authority.integration.spec.ts`。发现清单通过只表示已发现文件均已分类，不表示计划中的测试已经写出或执行。

### 发布路径的实际断点

`apps/release-runner/src/cli.mjs:66` 仍仅使用旧 RUNNER_LAUNCH_ENVELOPE_FILE 路径；未接 manual-stage1 分支。R2 计划中的 manual-command-adapter、manual-target-observer、manual-entrypoint、launch-manual-stage1、verify-manual-runner-result 五个生产文件均不存在。

`.github/workflows/docker-images.yml:470`、`:483` 已为 90 天；`:518` 明确检查 `authorityCustody=INPUT_REQUIRED` 和 `promotionEligible=false`。因此旧调度表的“180 天 YAML 未同步”已经过时，但 H2 并未完成。`manual-stage1-trust.mjs:785` 要求固定 receipt 文件，`:866` 单独验 receipt attestation，`:873` 比较同 workflow/source/run/attempt；当前 delivery-only 工作流没有提供这条链的 producer。**H2 是需要独立收敛的实现/运行输入缺口，不能排成最后临时补一份 JSON。**

H1 的真实 profile/sidecar 必须纳入 contract、合入受保护 main 后再构建。R2.0/R1.3H 的本地提交不能直接成为可提升候选。H3 已采用 migration 与 readonly verification 两阶段，中间存在真实迁移表产生后的独立权限操作；不能合并成一条自动执行命令。

## 4. 本轮检查结果

| 检查 | 本轮结果 | 证明边界 |
| --- | --- | --- |
| `node scripts/release/verify-contracts.mjs` | exit 0；126 migrations、174 contract files、68 schemas、13 commands | 本地 Node v24.14.0 离线契约一致性 |
| `node scripts/release/discover-database-tests.mjs --mode verify` | exit 0；93 candidates、37 manifested、56 excepted、0 unclassified | 文件发现/分类，不是 37 个 suite 已运行 |
| parser 最小反例 | 非法 `M\njunk`/`MS2\njunk` 被接受为 pending | F4 的纯函数动态证据 |
| N1rVMx 历史完整输出 | 245/245、exit 0、无 signal/spawnError，stdout 52390 B，stderr 0 B；本轮摘要复算一致 | 9 月 13 日 Node22 四文件门禁，不是本轮重跑或产品全量 |
| pDbgEy 历史诊断 | 244/245、exit 1；stdout 53822 B，摘要一致；唯一失败为 RESULT fixture | 保留为失败，不追认为通过 |
| R1.3H 四文件 | 当前 SHA-256 与原验收记录匹配，worktree Git blob 与 HEAD blob 一致 | 当前提交确实保存了被测四文件 |

当前 repository contract digest：`sha256:26b157cd47d54fff3547ada6d03a6209ed50a4cba87bae2fc9fe52ca4b7799f4`。

R1.3H 原件根：`C:/Users/keqi_119/AppData/Local/Temp/r13h-local-validation-20260913-4b22be65be57497490c01e26ae6165b8/runs/`，各 snapshot 下 `r13h-final/actualclose.json`、`stdout.bin`、`stderr.bin`。N1rVMx stdout SHA-256 为 `53e68a2b4a53b37286af634a2fada0b549b3c6b6146f3780f403efdc2ee4979d`；pDbgEy 为 `f1277b64a8365face7a835fe95fb05b3b9dd0e9d325580cefc383df5fd526536`。两次 close 均记录输入和 27 项冻结资产不变；本轮没有另行枚举秘密目录或重验所有外部资产。

N1rVMx 记录 elapsedMs=20975425.97975，约 5 小时 50 分。它说明全套测试成本高，不证明生产每次执行同样慢。后续使用聚焦反例定位，每个独立修复单元收口时运行完整必要门禁；不得每次小改重复全套，也不得删除/跳过失败用例以省时。

## 5. 状态治理与最终出口

`docs/acceptance/2026-09-06-stage1-mainline-execution-index.md:20` 仍写“未写 R1 代码”，覆盖路线图还写“尚无执行计划”。这些是滞后的状态描述。后续在原索引追加前向登记，将 R1/RP/R1.3H 记为本地实现交付、F4 记为本次新发现，R2/H1/H2/H3/最终验收分别标状态，不改历史失败原件。

阶段 1 的出口仍为：已解决阻断性实现问题 + 当前生产入口证据完整 + 唯一可信候选与合法副本双链通过 + 指定 Staging 的 A/B/成熟结束三样本、真实签约/主动支付/通知、两次有意义维护、恢复演练和人工签字。退款独立收尾；Task 6/29R/30/I、换车/续期/提前结束/争议/司法及 RENT_TO_OWN 不因本次审计恢复。

本次未修改生产代码、测试代码或历史验收记录，未创建提交。新增本报告与后续计划供评审。
