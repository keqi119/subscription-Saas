# Stage 1 审计驱动收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本文负责本轮发现的修复边界、任务顺序和验收出口；既有 B1/B3/B5/R2 精确计划继续拥有原任务的实现细节。新增业务修复须先完成对应任务的确定性反例与限域实施说明，不把原“仅测试”批准扩成业务写入批准。

**Goal:** 修复当前实现缺陷、补齐真实服务证据和最小人工发布入口，最终完成指定 Staging 的阶段 1 主线签字。

**Architecture:** 复用既有 Application/Journey/订单/资金/激活/正常结束权威事务、受控 PG suite launcher、build-proof.v1、R1 固定信任与 MS2。业务线和 R2 离线实现可以并行，真实数据库重负载串行；H1/H2/合法副本资料并行准备，最终在同一候选 source/三镜像上汇合。

**Tech Stack:** 现有 NestJS、Next.js、Prisma 7.8、PostgreSQL 17、Node 22 最终 Runner、Vitest/Node test runner、GitHub Actions。当前本机 Node24 离线检查仅作辅助证据，不替代 Node22 最终镜像。

**Spec:** [本轮审计](../../acceptance/2026-09-22-stage1-code-audit.md)、[最小受控发布决策](../specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md)、[S0 权威规格](../specs/2026-09-01-stage1-s0-authority-and-temporary-asset-governance-design.zh-CN.md)、[R1 当前契约](./2026-09-06-stage1-r1-manual-trust-and-authorization-plan.md)、[R2 精确计划](./2026-09-06-stage1-r2-runner-migrate-verify-plan.md)、[90 日前向政策](./2026-09-10-stage1-retention-90-day-sync-plan.md)。原规格的历史 180 日不改写，新执行消费当前 v2/90 日政策。

**状态：** 2026-09-25 用户已批准按本计划推进。审计基线为 `bf057cf1399e6c87c9946f1d4bcd3d2d8bcaee6c`；2026-09-22 审计轮仅交付文档。后续执行结果在原执行索引前向登记；实际外部操作仍遵守下列具体操作单边界。

## Global Constraints

- 主线为 A/B 进件—审核—最终方案/预约—单次确认—签约归档—主动支付/核销—交付激活—周期账单/催收—无争议正常结束。
- All money fields are stored in cents.
- All critical operations must write audit logs.
- 不新增业务模型、枚举、应用权限码或功能开关；不改历史迁移；不扩展 RENT_TO_OWN、换车、续期、提前结束、争议或司法。
- Task 6、29R、30 和 I 系列继续冻结；不改变 Task30 stash、原未跟踪 9 月 9 日调度文档和已保管失败证据。
- 不购买新 VM、云 KMS、付费 Runner、额外数据库或常驻服务；不在生产/预发共用服务器构建或跑全量测试。
- 现有 OSS 210 天 WORM 不变。新执行逻辑保留 90 日不代表缩短旧记录或批准删除。
- 退款独立收尾，不阻断主线；主动付款、核销、通知及正常结束财务事实仍必须验收。
- 不使用 ambient DATABASE_URL/PG 凭证，不复活 P1 已退役 target。实际数据库操作依受控 launcher、干净 source 和该任务准入执行；AGENTS 的数据库 preflight 必须在精确目标获准后完成并记录，不能为审计连接未知数据库。
- 不把原本的 tests-only 批准用于 F1/F2/F3/F6 生产修复。真实 H1/H2/H3、数据、配置、供应商、部署操作分别在其具体操作单就绪后取得对应批准。
- 不从通过数推断业务或发布验收。源码测试、最终镜像、真实渠道、浏览器和人工签字分别保留证据。

## Review Focus

- 确认后价格/额度发生变化：建单金额及权益必须与已确认商业事实一致，不能静默追认新价格；由任务 1/6 覆盖。
- 取消/拒绝与建单交错：只能留下一个合法终态，不得同时存在取消进件和有效新订单；由任务 1/6 覆盖。
- 合法付款与错误金额通知交错：已到账/核销状态不倒退，重复回调不重复收款；由任务 2/7 覆盖。
- 已收 LF 的非法帧头与真正截断流：分别拒绝与保留未知，不能从畸形原件证明 committed；由任务 3/9 覆盖。
- 业务提交成功但 job/调用响应丢失：重放核对完整权威事实，不能双写或缺审计；由任务 8/11/13 覆盖。

---

## 1. 批次与依赖

| 批次 | 工作 | 出口 | 可并行关系 |
| --- | --- | --- | --- |
| 第一批：修复已知问题 | 任务 1–5；任务 8 的审计补写小单元 | F1–F7 各自有修复/反例证据或明确失败记录 | customer.service 两项串行；支付、parser、预检、B3 可分文件并行 |
| 第二批：业务证据与 Runner | 任务 6–9 | B1/B2/B3/B5 聚焦通过，B4/B6 完整入口通过；R2.1–R2.3 离线交付 | 业务与 R2 可并行；catalog/manifest 的修改串行集成 |
| 同步前置：真实输入 | 任务 10；任务 12 的非秘密材料/设计部分 | H1/H2 可执行方案、独立 expected-schema 来源、合法副本资料 | 从第一批开始，避免等代码全完才发现输入缺失 |
| 第三批：真实 Runner 与候选双链 | 任务 11–12 | 两场景 R2.4、同候选 fresh/snapshot/readiness 全量适用集合通过 | DB 重负载串行；H3-B 保持中间人工操作边界 |
| 第四批：Staging 收口 | 任务 13 | 三样本、真实渠道/浏览器、两次维护、恢复演练和签字 | 只在同候选自动化证据完整后实际执行 |

最短依赖路径：

```text
F1/F2 -> B1/B2 ----+
F7 -> B3 ---------+-> B4 -> B6 -----------+
F3 -> B5 ---------+                       |
F4 -> R2.1 -> R2.2 -> R2.3 --------------+-> R2.4 / 最终双链 -> Staging 签字
H1 + H2 producer + main/CI + schema来源 -+
合法副本/隔离盘点 -> R3设计与合成演练 ----+
F5 预检修复 ----------------------------+
```

不作完成百分比或固定日历承诺：真实输入和外部批准未就绪，且 R1.3H 既有完整门禁约需 5 小时 50 分。每个代码单元先跑聚焦反例，收口时完整运行必要集合，集成时再做跨单元门禁。

## 2. 文件与责任分工

| 任务 | 精确主要文件 | 职责 |
| --- | --- | --- |
| 1 | `apps/api/src/customer/customer.service.ts`；`apps/api/test/subscription-journey-order-contract.spec.ts`；新增 `apps/api/test/stage1-application-order-authority.integration.spec.ts` | 两项 P1；新增文件集中真实申请/建单边界，注册到既有 integrity suite |
| 2 | `apps/api/src/payment/payment-order.service.ts`；`apps/api/test/portal-payment.spec.ts`；B5 的 `apps/api/test/payment-authority.integration.spec.ts` | 金额异常不能回退 PAID；和 B5 的新测试文件只设一个 owner |
| 3 | `packages/release-foundation/src/manual-runner-evidence.mjs`；对应 `test/manual-runner-evidence.test.mjs` | 短 header 的 LF 判定及归档恢复反例 |
| 4 | `scripts/stage1-golden-path-production-preflight.mjs`；对应 `.test.mjs` | 移除主线退款额度依赖 |
| 5 | `apps/api/test/stage1-contract-archive.integration.spec.ts`；原 B3 Task3S 指定的新证据文件 | 单行 oracle 修正和原门禁续接 |
| 6 | B1 原计划三份 unit 文件；任务 1 新 PG 文件；`release/contracts/database-test-manifest.v1.json` | B1/B2 真实组合及并发矩阵 |
| 7 | B5 原计划付款/billing 测试、manifest 和本轮记录 | 完整收款核销/正向维护证据 |
| 8 | `apps/api/test/subscription-journey-golden-path.e2e-spec.ts`；`apps/api/test/subscription-journey-failure-recovery.e2e-spec.ts`；`apps/api/test/subscription-expiry-return.integration.spec.ts`；`apps/api/src/subscription-closure/subscription-return-governance.service.ts` | 真激活/真正常结束、审计及恢复 |
| 9 | R2 原计划 R2.1 八文件、R2.2 八文件、R2.3 七文件 | 严格消费已有 R1 接口，不扩大共享契约 |
| 10–13 | 各批准操作单、原索引、独立的 R3/R4 精确计划和验收报告 | 外部输入/执行单独拥有，不向测试任务夹带操作权限 |

新增测试登记只修改目标 suite 的 files，不重写 manifest。新文件使用现有 runtime fixture/context，不新建数据库 launcher 或凭证入口。若最小反例显示必须扩出上表生产文件，先更新该缺陷的限域说明再继续。

## 3. 第一批：修复任务

### 任务 1：关闭确认快照与取消/建单两个 P1

**依赖/接口：** 消费真实 `CustomerService.createOrderFromApplicationInTransaction`、`cancelApplication`、`rejectApplication`、`PortalApplicationService` 确认入口和 `SubscriptionJourneyService.createOrderAndContractJob`。保持 public DTO、业务模型和原事件格式。

- [x] 读取 DEV_SPEC 及现有商业快照/确认契约；记录建单当前 Journey → Application → Vehicle 锁顺序、取消/拒绝路径和直接建单入口，形成仅此缺陷的实施说明。
- [x] 在新增 PG 文件编写两个确定性交错反例：取消/拒绝读取旧状态后让建单提交，再放行旧请求；反向顺序也执行。使用事务 barrier/受控暂停点，不使用随机 sleep。期望非法一方拒绝，Order/Contract/Vehicle/Journey/Application 一致；当前结果原样记录。
- [x] 添加确认后变更车价、里程价、能源价、权益额度再建单的反例，联合读取 Quote/Order/finalPlanSnapshot 和确认 revision/hash。必须断言金额、限额、周期及快照一致，不能只查订单数量。
- [x] 采用保守行为：商业投影漂移时，在写 Quote/Order/车辆终态前拒绝本次建单，保持原确认快照；重新报价只能经现有发布新 revision 和客户确认流程。不得自动替客户确认，也不得静默重写旧快照。实现前在小单元说明中固定既有业务错误/恢复入口，防止把正常待确认变成无穷技术 retry。
- [x] 取消/拒绝在相同权威锁下重读订单和状态；状态条件/锁覆盖真正写入。两项修复分开提交，顺序修改同一 customer 文件，完整保留既有审计与车辆释放语义。
- [x] 跑聚焦 unit 后，在干净批准 source 上用既有 integrity suite 执行包含新文件的全部 fresh 用例，审查回滚和重复调用。

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/subscription-journey-order-contract.spec.ts
node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-integrity.postgres --chain fresh
```

**出口：** 两种竞争顺序无孤立事实；商业漂移不能产生未确认金额/权益。未通过前 B2 不关闭，也不进入最终候选。

2026-09-25 本地限定出口已达到：[F2 证据](../../acceptance/2026-09-25-stage1-application-authority-validation.md)、[F1 证据](../../acceptance/2026-09-25-stage1-commercial-plan-validation.md)。最终 source `35353517` 完整 integrity fresh 31/31、相关 20 文件 unit 324/324，tsc/lint/契约与发现检查通过，独立代码评审 ACCEPT。任务 6 的 B1/B2 全矩阵及最终候选/外部验收未由此关闭。

#### 2026-09-25 任务 1 限域实施说明

用户再次批准实施。先处理 F2 的已确认竞争，再处理 F1 商业投影与恢复；两者分开提交，不能因其中一项通过而关闭整个任务 1。

- F2 反例在原 integrity suite 增加一个文件。使用真实 Prisma、CustomerService、PortalApplicationService、SubscriptionJourneyService、OrderService 和 OrderEntitlementService；测试从已审核事实开始，使用生产快照生成和门户确认。只在测试侧延迟取消/拒绝调用的事务入口，不替换事务内读写，不用 sleep。分别观察建单先提交和取消/拒绝先提交。
- 统一权威锁顺序为存在的 Journey → Application → Vehicle。CustomerService 既有 `lockJourneyApplication` 同步取得 Journey 后再锁 Application；已有调用方持同一 Journey 锁时可重入。取消、拒绝及公开直接建单入口在事务内调用该锁并重读 Application，重新验证访问权、状态和已有订单；审计 before 使用事务内实际读取值。仅外部旧读取不能授权终态写入。
- 精确生产修改仍限于 `apps/api/src/customer/customer.service.ts`。测试先保存当前真实 PG RED；没有运行/准入证据时不改业务代码。当前应用/合同/权益合法正例必须同时通过，不能用全部拒绝实现“无非法订单”。
- F1 进一步核查：现有 `commercialPlanHash` 包含 vehicleSnapshot 等字段；快照中的车辆状态、确认元数据不能被直接当成价格漂移。实现前先固定实际金额、周期、押金、里程/能源/权益及车辆身份的商业投影，保留正常预约状态变化正例。
- F1 恢复缺口：`finalizeApplicationPlan` 和 `decideFinalPlan` 只允许 FINAL_PLAN_DECISION，`allocateVehicle` 只允许 FINAL_VEHICLE_ALLOCATION。ORDER_AND_CONTRACT_CREATION 阶段直接抛非重试错误会进入异常，现有 retry 不会恢复报价入口。因此 F1 不能只加 hash 拒绝就宣布关闭；须单独落实受控回到方案审核/新 revision/客户再次确认的路径，并在扩大生产文件前补充该路径精确说明。

2026-09-25 用户说明：服务器端本系统 Docker 当前全部停止。上述本地验证不依赖线上。后续需要线上连接调试时，先核对本系统 Compose 项目、已部署版本和配置，恢复对应容器并完成健康检查后再调试；具体供应商、付款、数据及发布边界仍按原操作单执行。

2026-09-25 F2 独立审查补充：门户 `confirmFinalPlan` 先更新 Application，再通过 `recordSignal` 更新 Journey，和取消的新锁序构成死锁。为完成同一并发修复，生产范围增加 `apps/api/src/portal/portal-application.service.ts` 的确认事务：更新 Application 之前先锁对应 Journey。新增真实 PG 确认/取消交错，以事务 barrier 和 PostgreSQL 的实际阻塞关系同步；不靠 sleep 或替换业务写入。确认先提交、随后取消应能按顺序完成。既有 `application-review-api.spec.ts` 的 CommonJS/import.meta 编译冲突单独改用 __dirname 路径，保持原 schema 断言，独立提交。

同次锁序排查继续覆盖 CustomerService 的既有 Journey 信号写入方：`reviewApplication` 的补件/资料/资质/产品分支、`reviewMaterialGroup`、`submitApplication` 补件重提交、`needMoreInfo`、`approveApplication`。这些入口首次相关写入前必须取得同一锁，并重读进件后复核原权限/状态/无订单条件，防止终止后旧审核请求复活进件。车辆审核同时使用相同事务内复核。复用原有规则，不增加角色权限或新业务流；审核反例与共同锁序的真实数据库交错一起验证。

18 项 PG 通过后的独立审查发现：资料上传先锁既存资料组，再插入带 Application 外键的文件；资料组审核先锁 Application，再等组记录。新增真实上传/审核交错后，评估把共同 Application 锁收窄到 `FOR NO KEY UPDATE`：业务不更新进件主键，仍与状态写入互斥，同时允许纯外键检查的 KEY SHARE，避免扩写附件上传/删除流程。存储边界仅使用合成 adapter，数据库读写和审核/上传服务均真实执行；本轮不宣称对象存储渠道验收。

#### F1 商业漂移与恢复的精确实施范围（2026-09-25）

- 在既有 CustomerService 两个建单入口比较已确认快照与本次实际写 Quote/Order 的 details 商业投影：押金/规则、周期、全部定价、套餐及额度、车型/车辆身份；只排除车辆 status、assetLocation、currentMileageKm 等运营观测字段及确认时间等顶层元数据。原 commercialPlanHash 协议不变；Journey 的 revision/hash 与快照须一致。检查发生在 Quote/Order/车辆终态写入之前。
- 使用内部可辨识的商业漂移错误，沿用 `FINAL_PLAN_REVISION_STALE` 代码；不能将无关 stale revision、无效商品或基础设施故障全部改判为正常等待。公开直接建单返回明确的业务拒绝。
- 生产范围增加 `subscription-journey.errors.ts`、`subscription-journey-json.ts`、`subscription-journey.repository.ts`、`subscription-journey.service.ts`。真实 bootstrap 捕获此特定漂移，在原事务/权威锁内确认没有订单后，把现有最终方案、车辆分配、客户确认及建单步骤重置为可再次执行状态，创建新的 FINAL_PLAN_DECISION 人工任务和带本次 revision 的幂等事件；旧任务/事件保留。原已确认 Application 快照/确认值不改写。正常业务等待返回可完成 job 的结果，不进入技术 retry/dead-letter。
- 恢复只使用现有 `decideFinalPlan`、门户确认及信号消费：人工发布新 revision 清除旧确认，客户明确确认后才能重新生成 bootstrap job。再次发生漂移仍可重新进入人工任务；旧 job 响应丢失后的重放依据对应恢复事件返回原等待结果，不能扰动新 revision 或重复创建任务。保留原 job lease 供正常完成。
- 不新增 DTO、模型、枚举、权限或 UI 动作；人工待办复用现有入口，恢复事件记录原因、旧 revision/step 和 taskId。测试扩展已有 authority PG 文件及原聚焦 unit：八类事实变更拒绝、运营元数据变化合法、直接建单拒绝、两轮重新报价/确认/最终建单、旧 job 重放及共同终态/权益/审计。
- 独立审查补充：恢复等待时即使外部商业事实恢复成原值，存在 Journey 的公开建单入口仍须在权威锁内校验当前建单步骤，不能绕过人工待办。人工发布请求重放须绑定当次 publication 的事件 sequence 与原 dto.version；跨轮次旧请求明确拒绝为 stale，不能用当前 revision 冒充旧结果。分别补真实 PG 反例后实施。
- 先提交测试并用完整 integrity fresh 保存真实 RED/受控 migrate deploy/status/diff，再改业务；最终同套 fresh、相关 unit、tsc/lint、契约/发现检查及独立审查后单独接回实施分支。F2 原 19 项保持。此项不扩大为 B1/B2 全矩阵或阶段 1 验收。

### 任务 2：保护 PAID 资金事实免于错误金额回调倒退

**接口：** 保持 `PaymentOrderService.handleCallback` 到 `FinanceService.settlePaymentOrder` 的公共路径；错误渠道/验签失败仍不能结算。

- [x] 与 B5 同一测试 owner 使用其 payment-authority 文件，先固定“错误金额读 PENDING → 正常结算提交 → 错误金额继续”的 barrier 反例；读取 PaymentOrder、PaymentRecord、PaymentWriteOff、ReceivableBill 和 CallbackLog。
- [x] 将金额不符分支的状态处理纳入共同支付权威锁或等价 CAS；已经 PAID 时不得写 FAILED。错误 callback 仍留痕并拒绝，不得因保护终态而把金额错误标为合法成功。
- [x] 覆盖正常/错误顺序互换、正常并发重复、非法验签、非成功事件和已关闭支付单的既有合法补回调。资金变化必须由真实 Finance 事务产生。
- [x] 先跑 portal/payment-settlement 聚焦，再按 B5 原批准生命周期执行 billing fresh；生产修复作为明确的独立提交，不能混作原“仅新增测试”的结果。

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/portal-payment.spec.ts test/payment-settlement.spec.ts test/subscription-journey-payment.spec.ts
```

**出口：** 合法到账只有一笔，错误通知不造成终态回退或账单/支付单矛盾。

#### F3 限域实施说明（2026-09-25）

- 已读现有回调与 Finance 权威事务。错误金额分支无条件写 FAILED；若错误先提交，现有 Payment/Finance 对 FAILED 的拒绝也会阻挡后来的正确付款。单纯增加 PAID CAS 不能满足两种到达顺序。
- 生产范围仍仅 `payment-order.service.ts`：金额校验移到已付款幂等短路之前；金额错误总是通过原 handleCallback catch 记录 callback 错误并拒绝，不把错误 callback 标为 handled。不更新 PaymentOrder 的 status、errorSnapshot 或 updatedAt：不匹配金额不是该支付单终态事实，后续合法回调仍可进入真实 Finance 事务；已 PAID 事实不被覆盖。callbackLog 已绑定支付单、金额 payload 与错误原因。
- 这是当前已批准任务 2 的生产修复，覆盖原 B5 仅测试计划中“金额错误应为 FAILED”的旧预期；保留原 B5 文档作历史，不改写它来伪称原 tests-only 批准允许生产修改。退款、代扣、Finance 账务规则、合法 CLOSED 补回调和供应商协议均不改。
- 测试：沿原 B5 fixture/受控 billing suite 增加 `payment-authority.integration.spec.ts`，只有 manifest 对应 files 变动。真实 PaymentOrderService → FinanceService → 审计/账单/核销，provider 使用合成边界。旧 PENDING 读取暂停后让合法付款先提交再放行错误回调；反向顺序、已 PAID 后错误金额、正常并发重复、非法验证、非成功事件、CLOSED 合法到账一并覆盖。
- unit 先记录 RED，真实 fresh 先保存反例与 migrate/status/diff 后才写生产修复。B5 当前准备基线已在干净 checkout 执行 shared build、Prisma generate、三文件 unit 36/36。后续沿原 B5 精确 preflight/函数生命周期保管结果，最终 Task7 仍需正向账单维护及两套同 source 门禁。
- 独立方案审查确认：即使仅写 PaymentOrder.errorSnapshot，也会改变 @updatedAt，可能被 refreshProviderPayment 误判为创建期间关单并关闭远端交易。因此错误诊断只留 callbackLog，真实 PG 同时断言 PaymentOrder.updatedAt 不变。既有 portal-payment unit 基线本身不满足 Prettier；本轮不夹带整文件格式重写，保持既有格式并做 ESLint/diff 检查，新 PG 文件按原 B5 Prettier 门禁执行。

### 任务 3：修复非法短帧头，完成 R2 之前的纯契约回归

- [x] 在现有 evidence test 写入下列回归；当前 LF 输入应出现 RED，真正未完成 prefix 仍应合法。

```javascript
test("short protocol headers terminated by LF are invalid", () => {
  for (const direction of ["parent-to-child", "child-to-parent"]) {
    for (const text of ["M\njunk", "MS1\njunk", "MS2\njunk", "\njunk"]) {
      assert.throws(
        () => parseManualRunnerFrames({ direction, bytes: Buffer.from(text), ended: false }),
        { code: "MANUAL_FRAME_INVALID" }
      );
    }
  }
});
```

- [x] 在 `decodeFrame` 的 `text.length < 4` 分支先要求 `headerEnd < 0`；沿用 FRAME 错误，不调整大小/版本/权限限制，不添加协议。
- [x] 用原 interrupted-apply fixture 分别构造 MS1/MS2：ACK_RECEIVED 后短 header 含 LF + 正确重算 RawRef/process。完整 reconcile 必须不能 SUCCEEDED/committed；合法 EOF/UTF-8 截断与真实提交归因继续按原契约通过。
- [x] 先执行新增名称的聚焦门禁；此两文件单元收口时执行原完整四文件 gate 一次，保存 stdout/stderr/actual close、计数、字节摘要及独立审查。不要把本轮原 245/245 移作修复后结果。

```powershell
node --test --test-name-pattern="short protocol headers" packages/release-foundation/test/manual-runner-evidence.test.mjs
node --test packages/release-foundation/test/manual-runner-evidence.test.mjs packages/release-foundation/test/manual-stage1-session.test.mjs packages/release-foundation/test/manual-stage1-contracts.test.mjs packages/release-foundation/test/execution-state-machine.test.mjs
```

**出口：** F4 反例拒绝、兼容与恢复不退化，R2 继续消费同一共享 parser。

#### F4 完整门禁恢复限域说明（2026-09-25）

- 原两文件 parser 修复已独立审查、聚焦 4/4；原完整门禁 248/249 的唯一失败是 Prisma 版本探测 30 秒超时，随后串行运行中断且无 close，仍不算通过。保留所有原件，不改判历史。
- 只读定位 `validateContract` 每次 `createRegistry` 重编全部 68 份 Schema。三个相同源码、未注册 ID 的探针分别耗时约 3919/3203/1563ms；历史 MS2 单例超过 3296 秒。先解决重复编译开销，再运行完整四文件门禁，不删慢用例、不降低断言、不盲目调大版本探测超时。
- 追加非业务范围仅 `packages/release-foundation/src/schema-registry.mjs` 与其既有测试：缓存最近一组已成功编译的 registry；每次仍重新枚举排序文件并读取精确内容，以 root、文件路径及内容共同判定复用。任何新增、删除、改名、内容变化或 root 切换均重新编译；不依赖 mtime/size、不缓存 payload 验证结果、不导出 mutable cache，不累计多个 root 的常驻缓存。
- `compileAllSchemas` 继续强制完整编译。复用仅省去相同 schema bytes 的重复编译，所有注册/文件名/重复 ID/无效 Schema/未知版本/输入错误检查仍生效；不改 Schema、协议、错误码、角色、凭证、状态权威或受控数据库 launcher。
- 独立审查发现 Ajv 的 error.params 内 const/enum 值会引用编译 Schema；调用方改写它可能污染下一次复用。返回错误时深拷贝 params，保持形状、值及调用方可变性；增加嵌套错误详情污染回归。缓存比较精确 Buffer bytes，编译消费同一次读取的快照，失败不得回退旧结果；仅成功完整编译才发布缓存。
- TDD 先证明相同内容的连续验证仍重复调用真实 Ajv compile；同时增加相同 size/mtime 的内容替换、目录增删/无关坏 Schema、不同 root、输入变化和失败后恢复的回归。随后独立评审、完整 schema 回归及原四文件 gate；真实版本探测必须仍运行，任何剩余失败继续分类。
- 本轮沿用刚完成的受控 fresh migrate/status/diff 和源码 validate 证据；上述修正不涉及业务或数据库，禁止为此访问已经退役的 target。原件与 Node24/最终 Node22 的边界继续保留。

2026-09-25：限定 F4 完整关闭。最终 source `fc1b1806`，原四文件 249/249、exit 0；Schema 回归 17/17，独立代码与原件审查 ACCEPT。见[完整门禁记录](../../acceptance/2026-09-25-stage1-parser-full-gate-validation.md)。历史失败与中断原件保留；R2、最终 Node22 与阶段 1 验收继续开放。

### 任务 4：两文件预检对齐

- [x] 在现有 preflight test 中增加以下用例，并移除/替换旧退款 blocker 断言；先记录当前 RED。

```javascript
test("mainline preflight does not require independent refund funding", () => {
  const env = validEnv();
  delete env.STAGE1_ACCEPTANCE_MAX_REFUND_FEN;
  const result = validateStage1GoldenPathPreflight(env);
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});
```

- [x] 从主线 validator 移除 refundLimit 必填/与 paymentLimit 比较。保留付款额度、专用资产、payer、真实渠道/通知和禁止代扣全部断言；退款值缺失或高于付款值均不能单独阻断主线。
- [x] 只运行离线 test，独立审查/提交这两个文件；原索引和 Runbook 的“未实施差异”仅在代码通过后前向更新。不要运行真实 preflight CLI。

```powershell
node --test scripts/stage1-golden-path-production-preflight.test.mjs
```

### 任务 5：续接 B3 Task 3S

- [x] 向原 B3 执行 owner 核对是否已有未整合的唯一 Task3S 原件/提交；已有则接收并核对，不重复运行。
- [x] 若仍是本轮基线，只将 `stage1-contract-archive.integration.spec.ts:758` 的 CUSTOMER_JSAPI_PAYMENT 期待改为 INITIAL_BILLING；保留后续事件唯一性和无 B4 写入断言。
- [x] 完整执行 [B3 计划 Task3S](./2026-09-06-stage1-b3-contract-archive-validation-plan.md) 的六文件 unit、干净 SHA、唯一 fresh、custody/readback 和独立审查；不缩减原步骤。

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/esign.spec.ts test/fadada-archive.spec.ts test/subscription-journey-esign.spec.ts test/lease-activation.spec.ts test/subscription-journey-state-machine.spec.ts test/subscription-journey-payment.spec.ts
node scripts/release/run-database-suite.mjs --suite-id api.stage1-contract-archive.postgres --chain fresh
```

**出口：** 当前三个 PG case 全部达到后续断言并通过，其余失败/跳过/过滤/取消为 0；两份旧 2/3 失败永久保留。

2026-09-25：任务 4/F5 的离线 16/16 与独立代码审查已完成（`c99a2ce9`），本 Runbook 与索引已前向对齐，未运行真实预检。任务 5/B3 的原 Task3S 已完整执行，六文件 171/171、唯一 fresh 3/3、custody/readback/退役及独立审查通过，见[实际记录](../../acceptance/2026-09-07-stage1-b3-contract-archive-transition-validation.md)。历史失败与真实渠道边界不变。

## 4. 第二批：补齐业务事实证据

### 任务 6：B1 后续与 B2 真实服务矩阵

- [x] 按 [B1 已有计划](./2026-09-06-stage1-b1-intake-and-business-wait-validation-plan.md) Task2/3 组合真实 CustomerService 与 Journey；加入 A/B、补件、人工等待、拒绝/取消和技术错误。worker 对正常等待完成 job，对真正技术错误才 retry/dead-letter。
- [x] 扩展任务 1 的真实 PG 文件：两 Application 争同一车；同 Application 重复确认；旧 revision/hash；重复 CREATE_ORDER_AND_CONTRACT；合同后段失败回滚；确认后商业漂移；取消/拒绝竞争。结果必须联合查 Application、Vehicle、Quote、Order、Contract、Journey、job/event。
- [x] 不替换原 golden-path 全部 fixture；在新增切片调用真实服务成功路径，原覆盖继续保留。测试 identity 从 suite context 取得，不从 retired P1 record 取连接。
- [x] 按 B1 Task4 运行本轮 golden-path fresh，并运行包含新文件的 integrity fresh。分别报告 suite 自己的覆盖，不将 fixture 成功夸大为生产入口并发验证。
- [x] 在原执行索引追加本轮 B1/B2 状态、source、计数、原件引用和未覆盖外部事项。

**出口：** B1/B2 当前生产路径与反例闭环；F1/F2 关闭。

2026-09-25：限定 B1 已完成，Task2 `5c9223ca`、Task3/最终 source `7ad53559`，四文件 unit 112/112、ESLint/API tsc 通过，原 golden-path fresh 1/1、custody/readback/退役及独立终审 ACCEPT。[本轮 B1 记录](../../acceptance/2026-09-25-stage1-intake-business-wait-validation.md)说明两文件既有 Prettier 基线例外；原 fixture 收敛不替代真实服务矩阵，B2 及任务 6 其余步骤继续开放。

#### B2 真实服务矩阵与门户确认回读限域（2026-09-25）

- 在现有 `stage1-application-order-authority.integration.spec.ts` 扩展已审核边界 fixture，SELF_SERVICE 和 SALES_ASSISTED 均从对应 Application 来源开始，消费真实快照生成、门户确认和建单/合同/权益服务。B 线方案发布使用已有 Journey FINAL_PLAN_DECISION 入口，不把 A 线成功结果重标成 B 线证据。
- 已发现 `PortalApplicationService.confirmFinalPlan` 的 owned read 和 updateMany 使用统一 portalApplicationSourceScope，而事务最后的 findFirstOrThrow 硬编码 SELF_SERVICE；有 Journey 的 B 线可能在确认及信号写入后被回读排除、整笔回滚。现有 unit 的 findFirstOrThrow fixture 未检查来源，无法暴露此差异。先记录真实 PG 反例，再将最终回读对齐既有 scope，保留 customerId、deletedAt、id、锁序、revision/hash、状态/无订单条件。仅此生产入口修正，不扩展无 Journey 的销售进件访问权限。
- 门户 unit 增强已有 B 线确认测试的查询契约，并验证无 Journey 的非自助进件及其他客户仍拒绝；不修改其他门户动作的来源策略。
- 继续补两 Application 争同车、同进件重复确认、旧 revision/hash、重复 CREATE_ORDER_AND_CONTRACT、真实合同写入后受控异常的整笔回滚与重试。所有断言联合读取 Application、Vehicle、Quote、Order、Contract、Journey、job/event；现有 F1/F2 漂移/取消/拒绝用例保持。
- 合同失败仅在测试侧调用真实合同服务完成事务内写入后抛确定异常；竞争通过真实事务与 barrier/数据库阻塞观测，不依赖随机 sleep、不替换 Prisma 写入或伪造终态。
- 本轮继续使用原 integrity fresh suite 和 suite context，不添加 manifest 文件或数据库接口。准备期已完成 B1 的 Prisma validate 及唯一 fresh 内 migrate/status/diff；数据库输入/生成准备未变，不访问退役目标。每次后续 fresh 均独立干净 SHA、完整报告/custody/readback 与受控退役，失败记录保留；只复用已审核的非秘密捕获/回读函数，不复用任何数据库身份。

2026-09-25 前向登记：上述 B2 矩阵已补齐，最终 source `a92b2f66` 的 integrity fresh 38/38、API tsc/owned ESLint 均通过，代码、原件及记录独立终审 ACCEPT。首轮 37/38 是 DRAFT 车辆夹具前置失败，原件保留且不当作业务 RED。[矩阵记录](../../acceptance/2026-09-25-stage1-application-order-matrix-validation.md)说明真实入口及 fixture 边界；B1 原 Task4 golden-path 1/1 保留其独立 source，不重标成当前 SHA。

### 任务 7：B5 完整付款/账单验证

- [x] 接任务 2，按 [B5 原计划](./2026-09-06-stage1-b5-payment-and-billing-validation-plan.md) Task1/2 补验证失败/非成功/部分金额/并发重复回调，真实 FinanceService 联合断言 PaymentOrder → Callback → PaymentRecord → WriteOff → Bill。
- [x] Task3 增加真实 due schedule 两次扫描：确有正向应处理对象、只入队一次、金额和应付状态正确；原暂停/唯一性测试保留。
- [x] Task4 同一干净 SHA 顺序调用原 `Invoke-B5FreshSuite 'api.billing-automation.postgres'` 和 `Invoke-B5FreshSuite 'api.database.release'`，使用原计划函数及 preflight，保管完整结果后再推进下一套。不因最后写报告重复运行同一输入。
- [x] 创建原计划指定 `docs/acceptance/2026-09-06-stage1-b5-payment-and-billing-validation-record.md`，按实际执行日期与 source 记录；任何新生产反例单列限域修复，不在报告中改判为通过。

**出口：** 当前资金链与维护正向/重放有自己的证据；不宣称真实微信或两个自然月运营通过。

2026-09-25：任务 2/F3 与任务 7/B5 限定验收完成。独立生产提交 `86b1de50`；最终测试 source `46e8f95a` 两套 fresh 17/17、15/15，unit 64/64、API tsc/Lint 与 custody/readback 均通过，独立审查 ACCEPT。详见[原计划指定的本轮记录](../../acceptance/2026-09-06-stage1-b5-payment-and-billing-validation-record.md)。维护事实套件中的业务响应和 release/image 为合成边界，不扩称真实维护、渠道、Node22 镜像或阶段 1 收口。


### 任务 8：B4 真激活、B6 真正常结束及审计

- [x] 在 golden-path/failure-recovery 的既有 PG 环境加入真实 `activateSubscriptionJob`/LeaseActivationEngine 路径，保留前置合同归档、收款核销和 Stage2 事实。至少覆盖成功、完整重复、缺事实拒绝、BASE/Period 后事务失败回滚、业务提交后 job ack 失败再恢复。
- [x] 每例联合核 Delivery、Order、Vehicle、Lease、BASE Segment、Period、Schedule、Entitlement、Journey 和 Audit；不只看 replay helper 或手工 fixture 终态。
- [x] 对 F6 建立独立生产修复单元：`completeOperations` 复用既有事务审计写法，记录本次操作者、Closure/Order/Contract 前后状态和 idempotencyKey；新完成一次审计、重复不重复、事务失败没有成功审计。
- [x] 在 expiry-return PG 用当前 `SubscriptionReturnGovernanceService.completeOperations` 跑 NORMAL_EXPIRY、无争议、应收清偿样本。沿真实实物接收读 Lease/Period；旧 settleManagedSettlement 用例保留但不替代当前入口。
- [x] 补客户未确认/责任异议、尚有未归口应收、重复请求、写入中途失败；区分“正常结束必须已清偿”的验收样本与通用入口已有合法催收/法催归口，不能为正常样本删除其他既有业务规则。
- [x] 联合读取 Order/Contract/Closure/Lease/Period/Vehicle/Bill/PaymentRecord/WriteOff/Audit；解除占用与可上架分开断言。按当前套件完整顺序执行，不静默筛选旧复杂域测试。

```powershell
node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-golden-path.postgres --chain fresh
node scripts/release/run-database-suite.mjs --suite-id api.subscription-journey-failure-recovery.postgres --chain fresh
node scripts/release/run-database-suite.mjs --suite-id api.subscription-expiry-return.postgres --chain fresh
```

**出口：** B4/B6 有当前界面实际入口证据，F6 关闭，样本准备可以绑定完整事实。

2026-09-25：任务8本地范围完成，独立终审ACCEPT。最终同一干净source `0e9d966d` 顺序五套fresh分别3/3、29/29、90/90、14/14、59/59，共195/195；集成unit178/178、API tsc/owned Lint/Prisma validate通过，报告/receipt独立读回和五目标退役完成。真实服务激活、ACK恢复、正常运营完成/审计、重放与争议守卫及两条前向约束兼容均有本轮证据。详见[完整验收与历史失败记录](../../acceptance/2026-09-25-stage1-activation-and-operational-closure-validation.md)。存储/签署/已归档人工输入仍有合成边界，不替代最终Node22、真实渠道、候选双链或阶段1签字。

#### B4 激活与 ACK 恢复验证限域（2026-09-25）

- 新增仅供两份既有 PG 文件复用的 `apps/api/test/helpers/stage1-activation-fixture.ts`。该 helper 接收 suite 已创建的 PrismaService，不读取环境/连接、不创建目标/launcher；准备已归档合同、实际到账核销、完整 Stage2 文件元数据/客户确认/人工审核及待激活 Journey，所有激活写入调用真实 LeaseActivationEngine 和既有依赖。文件字节/供应商及激活前的人工事实是明确 fixture 边界。
- golden-path 新增 A/B 真实激活成功和完整重放切片，不替换原收敛 fixture。failure-recovery 新增缺前置事实拒绝、真实 BASE 与 Period 写后失败回滚，以及真实 worker 在业务提交后 ACK 事务失败、调度重放与最终 ACK 的恢复；联合读取权威事实与 job/event/audit。
- 静态发现 `claimJobs` 排除所有 COMPLETED Journey，可能使激活事务已提交但 ACK 失败的任务无法再领取。先用完整真实激活和 ACK 后写入异常验证，不把手工终态构造当成唯一证明。若确定 RED，生产范围仅扩至 `subscription-journey.repository.ts` 的领取准入与其精确回归：只允许与已完成权威激活 step、该 Journey/order 对齐的 ACTIVATE_SUBSCRIPTION 重放；其他终态/暂停/取消/过期计划不放开，不改通用重试策略、不重激活业务事实。实现前独立审查精确条件，保留旧 handler 与锁/lease 语义。
- B6 诊断运行时保持其 source 不变，本单元在独立 `stage1-b4-activation-20260925` worktree 准备测试；集成后串行受控 PG，不并发数据库重负载。最终仍按任务 8 原三套顺序同 source 完整验证。

#### F6 关单审计限域实施（2026-09-25）
- 2026-09-25 争议场景衔接限域：真实定价新增应收后必须再次 propose 捕获新账单，再以真实 createPricing 复用旧 bill、追加后继 chargeLine，才能 finalize，禁止回填 proposal 摘要。该合法路径及同版本重放静态发现两处 evidenceIds 数组误传对象根 canonical 函数；聚焦真实 createPricing 单测已得到 8/12、四项 TypeError 反例。独立修正仅把两处比较双方包为 `{ evidenceIds }` 对象，排序、全部字段对比及同键改证据/活跃账单禁止直接改价条件保持，不改通用序列化函数。新增 B6 样本同时走真实四项证据上传、清单版本/hash 绑定的受管实物接收，外观责任未定在 inspection 前拒绝；真实责任确认/定价/最终发布/客户争议与平台接受后分别验证当前完成入口拒绝。未定责任与合法 FINALIZED 不能沿当前链同时存在，PG 证明其前置守卫，complete 内该分支由独立 unit 隔离。
- 第六轮 source `c5b8ef21` 全量 88 执行、82 通过：原 80 项全过，新增两项业务拒绝通过；正常完成与回滚后重试明确触发 `terminal closure requires the case current FINAL settlement revision at SETTLED stage`，即旧延迟提交约束尚未兼容运营完成。另以独立前向迁移修正该函数：仍要求本案、最新指针、FINAL 类型，仅增加“FINALIZED 且本案 operational_completed_at 已记录”的替代；旧未记录运营完成的路径仍强制 SETTLED。补 schema 级 PROPOSED 即使有运营时间仍拒绝、FINALIZED 只有结清时间仍拒绝、FINALIZED 加运营时间可行及原 SETTLED 兼容断言；不回写结清、余额或历史迁移。缺两类时间的负例须先满足 version 递增规则，避免被其他约束提前截住。上一轮旧 Task9 异常未复现，原因仍未知，不抹去历史失败。

- B6 完成入口的数据库衔接修正另立单元：第五轮 source `c976d863` 已通过两项业务拒绝断言，正常完成、清单重放后完成及审计回滚切片进入真实状态写入后出现数据库 DriverAdapterError（原件摘要截断，未直接确认具体约束）；静态定位旧 `subscription_closure_case_terminal_shape_chk` 强制 settled_at 非空，而现行入口只写 operational_completed_at。按已批准的 2026-08-26 三阶段规格，运营完成必须可保留真实未结债权。新增一个前向迁移，只将该终态 CHECK 的“结清时间存在”改为“结清或运营完成时间存在”，保留终态与 final_disposition、closed_at 及物理控制全部旧约束；不改旧迁移、不补 settled_at、不改结算修订/应收余额。新 PG 覆盖未归口拒绝、实际 COLLECTION_PENDING 归口后运营完成且余额保持、没有两类完成时间的终态仍被拒绝，并验证旧结清路径兼容。迁移只在 Launcher 新建本地目标验证；最终除原三套外追加现有 closure repository/schema 门禁，线上应用仍属于后续发布环节。

- B6 第二轮真实 PG 在 source `613d3350` 执行 85/85（80 通过、5 失败），新增正常签署场景均被 `vehicle_return_checklist_revision_attestation_check` 拒绝。`captureChecklist` 对 CUSTOMER_SIGNED 写 Prisma.JsonNull，而既有 SQL 约束要求 SQL NULL；这是真实生产入口反例，不是首轮的夹具状态错误。新增限域只将该空分支改为 Prisma.DbNull，并在原 PG 切片独立查询 `attestation_snapshot IS NULL`；拒签/缺席的证据对象、校验及数据库约束保持。该前置修正单独提交，继续原套件，不绕过真实清单入口。
- 清单重放另立修正单元：当前直接以数组调用只接受对象根的 canonicalSubscriptionClosureJson；数据库 items 还带有 id、revisionId 和时间等元数据。先用真实 capture 首写→同键同内容重放取得 unit/PG 反例，再仅将已存 items 投影为规范化输入相同的五个业务字段、以 `{ items }` 对象比较。保持 manifestHash 对完整输入的绑定与同键改内容拒绝，不放宽签署锁定和证据约束，不改通用序列化函数。

- `SubscriptionReturnGovernanceService.completeOperations` 当前对 Closure、Order、Contract 的终态更新处于同一事务，却没有成功审计。仅在该方法已有锁与所有准入校验之后读取 Order/Contract 当前状态，保留 Closure 的事务内原状态，在三项更新成功后用 `tx.auditLog.create` 写一次 UPDATE；记录 operatorId、Closure/Order/Contract 的 id/前后状态、财务状态及本次 idempotencyKey。沿用 module `subscription_closure`、entityType `subscription_closure_case`，不引入新模型/权限/事件。
- 已完成/已终止的早返回保持，不为重放补写或重复写审计；任一状态更新或审计失败必须让原事务失败。不改客户响应、争议、实物接收、库存释放、合法催收/法催归口或金额规则，也不补造历史审计。
- 新增 unit 文件 `apps/api/test/subscription-return-completion.spec.ts`，先取得“真实方法成功返回但无审计”的确定 RED，覆盖完成及现有终止分支的准确旧状态、单次审计/重放、业务写入失败和审计失败传播。unit transaction double 只证明调用顺序/事务归属；数据库回滚由任务 8 原 expiry-return suite 中的真实 `completeOperations` 切片独立验证。
- 生成输入/数据库接口不变。准备期复核 Prisma validate；migrate status/deploy/diff 继续仅在每次新受控 fresh 内执行，不连接 ambient 或退役目标。记录独立生产提交，聚焦 unit、相关 closure 单测、owned ESLint、API tsc；最终按任务 8 原三套完整 fresh 与 custody/readback 顺序验收。

## 5. 发布与真实验收路径

### 任务 9：按 R2.1 → R2.2 → R2.3 实施离线接入

依赖任务 3，R1.3/RP/R1.3H 既有实现不重新开发。严格使用 [R2 原计划](./2026-09-06-stage1-r2-runner-migrate-verify-plan.md) 的三份 Files 清单和接口。

- [x] R2.1：创建 manual-command-adapter/target-observer 及测试；按原计划为 applyMigration 增加受约束 executionIdentity 接缝。observer 真实查询的字段/角色/一致性快照由受控 connector double 测试；保存完整迁移行，不用过滤后的成功行伪造前缀。
- [x] R2.1 出口：错 system identifier/endpoint/DB OID/role/TLS 时 handler=0，合法迁移后 catalog/权限变化不被旧 H3-A 错挡；旧 handler 兼容。

2026-09-26：R2.1限定本地范围已收口，最终实际测试source `ba57efea` 八文件343/343、exit0、独立终审ACCEPT。新增适配器/observer、MS2真实工具schedule及最终观察ACK绑定修复均纳入；见[完整原件与限制](../../acceptance/2026-09-26-stage1-r21-offline-integration-validation.md)。R2.2/3仍待实施，任务9整体未关闭。

同日后续：R2.2 已在独立 `stage1-r22-launcher-20260926` 开始实施。metadata/CLI WIP `d29519e5` 的两处异步校验窗口经真实 4 RED→4 GREEN 修复，精确后继提交 `83e91242`、完整组合72/72、exit0及六输入摘要已独立复审 ACCEPT。该切片只证明固定 metadata 写入/读回和入口拒绝；child 授权、凭证、H3/expected 输入、工具 collector 与父子闭环仍在实施，尚未整合主候选，R2.2/任务9不收口。原67/68及新反例失败原件保留，不能与重叠测试累加。

- [ ] R2.2：创建 launch-manual-stage1/manual-entrypoint 及测试，接 cli manual 分支；唯一 selector 为 operationRef。固定 H3 来源、prepare/index、真实 child/工具 raw、PREPARED→readback→ACK→spawn、最后关闭全部按原计划实现。
- [ ] R2.2 出口：真实临时 Node 管道组合通过；非法 CLI/替代路径/错 nonce/H3/ACK/版本在 secret/DB 前拒绝。manual stdout 无额外 JSON 尾写；旧入口字节行为保持。
- [ ] R2.3：创建 verify-manual-runner-result、两个 test/manual 真实阶段文件；登记精确 discovery exceptions。verifier 只读固定 index/build/H3/raw，全链证据不接受 caller success flag。
- [ ] R2.3 出口：两个 frozen scenario 单独判定；正常链和 apply-interrupted 各需自己的原件，缺 H3-B/close/权限/过程证据不能 PASS。默认 Runner tests 不选入外部真实门禁；两份真实测试此时标 NOT_RUN。
- [ ] 每单元执行原计划规定完整离线门禁和契约/发现检查，独立提交/审查；catalog/manifest 与业务测试登记串行集成。

### 任务 10：提前解决 H1/H2 与 expected-schema 的实际输入

**现在可交付的部分：** 非秘密材料和具体操作单/实现说明。实际身份、主机、云、构建及导入另按原边界执行。

2026-09-26：[可信构建输入准备方案](./2026-09-25-stage1-trusted-build-input-preparation-plan.md)已完成 DOC-only 独立审查并整合。真实 owner/host、私密 writer/独立 reader、H1 文件、H2/expected producer 和同源 CI 原件仍未就绪；以下实际输入门槛及任务10整体保持开放。

- [ ] H1：列出 owner、host/principal、五 roots、独立加密备份与恢复读回、key 遗失处置。生成 profile/批准/sidecar 的顺序保持 R1 H1；真实 `manual-stage1-profile.v2.json` 和 `manual-stage1-owner-binding.v1.json` 纳入 manifest 并经审查进入候选 source。
- [ ] H2：先交付窄范围 producer 方案，消费当前 build-proof/material，明确现有受批私密存储、最小读取权限、真实对象 readback/期限、retention90 receipt 生产及独立 attestation。以 `.github/workflows/docker-images.yml` 和现有 custody 接口为对照，不恢复 Task6/I 系列。
- [ ] H2 方案必须解决同 workflow/source/run/attempt 的 proof 与 receipt 绑定；当前两份 Actions delivery artifact 本身不满足。没有已批准保管能力则保持 INPUT_UNAVAILABLE，并将需要的具体选择提交用户，不自动购建平台或伪造本地 receipt。
- [ ] expected-schema：制定同 source/build 的独立预期 Schema 原始脚本生成与保管方法。明确命令/config、Node/Prisma/PG版本、raw/canonical摘要、生成基线及复现；禁止从待验目标实际态生成脚本再用它自证。完成其来源方案后才能准备 R2.4 请求。
- [ ] 整合本地工作到受保护 main 的步骤独立进行：核对远端实际基线、PR/CI、冲突与必要回归，保留四类证据边界。187 个本地提交领先只是整合提醒，不执行整树自动合并。
- [ ] H1/代码/contract 完成后才冻结 source 并做可信三镜像构建；H2 验两份 attestation、真实 run 成功、receipt/storage 读回及固定 raw import。缺一项不创建 H3 目标。

**出口：** 固定 loader、build verifier 的真实输入全部有来源，`verifyManualBuild` 实际读回通过；仍不等于 Staging 可提升。

### 任务 11：R2.4 两场景、两阶段真实门禁

- [ ] 在 R2.1–R2.3 和 H1/H2 完成后，按 R2 原计划为 normal 与 apply-interrupted 分别冻结独立 operationRef/run/目标。两场景不互借 baseline/结果。
- [ ] 每场景先完成 H3-A 精确资源、TLS、PG17、四角色和 creation/readback 批准与实际读回；只运行该场景 migration 阶段。
- [ ] 迁移表真实产生且原 Runner 退出后，按同 ref/目标/table OID 的具体操作单完成独立 H3-B 授权、权限读回、provision 撤权/退出，再运行 verification 阶段。
- [ ] normal 要求 observe、非空迁移 dry-run/apply、verify、readonly replay；apply-interrupted 要求真实中断和原身份的 readonly reconcile，不先制造成功 apply、不盲目重试写入。
- [ ] 独立 verifier 读取固定原件；保存工具版本/PID/raw/close/角色/Schema/TLS/迁移行与结果。未知状态按原幂等身份调查，保留失败和现场。
- [ ] 仅按精确批准回收该场景资源，核对无消费者；不复用 P1 旧资源。完整两个场景、两个阶段都关闭才登记 R2 实测通过。

### 任务 12：R3 最小副本/最终镜像双链方案与执行

**新增计划文件：** `docs/superpowers/plans/2026-09-22-stage1-r3-final-image-dual-chain-plan.md`。先交付方案并评审，再执行真实数据阶段。

- [x] 从当前 manifest 完整列出最终 fresh/snapshot 适用集合、现有 handler/launcher 的接口、人工授权与最终 Runner 缺少的最小适配文件；禁止因为 R2 仅 migrate/verify 就假定其他命令已接好。
- [ ] 列出合法副本受控索引、来源/用途、digest、扫描、读取/解密/使用许可和有效期；没有材料仍记 INPUT_UNAVAILABLE，不搜索秘密或自行导出。
- [ ] 先设计并执行获批的合成 LUKS 演练，再准入真实输入。专用 WSL、swap、宿主分页/转储、临时路径、备份排除及异常销毁均沿既定边界；不能拿普通 Docker volume 或 TEMP 代替。
- [ ] 把 source-read/export、restore、sanitize、scan、candidate-use 分为独立 capability/凭证/operation；明确每步失败保管、后验/回收和最终只读验收。
- [ ] 方案必须给出精确可写文件、公共接口、运行命令、目标身份、counts契约和独立 readback；不得含任意 shell/SQL、第二套 proof/parser 或旧 full-RC 伪装。
- [ ] 在业务包与 R2 完成、合法输入可用后，绑定一个可信候选 source 和 api/web/runner platform digest 执行完整适用 fresh/snapshot/readiness；`collected=selected=executed=passed` 且 fail/skip/filter/cancel/todo 均为 0。

**出口：** 同候选的真实双链可独立读回；此前 P1 104/104 和 R1.3H 245/245 均不能替代。

2026-09-26：[R3 方案](./2026-09-22-stage1-r3-final-image-dual-chain-plan.md)已通过 DOC-only 独立审查。确认两链各需全部37个 suite，六 batch 仅覆盖30个；最终入口覆写为同一 DB、现有普通卷/明文副本链与新版本外层 consumer 均有明确缺口。新宿主 launcher 的精确实现切片尚未定义，GitHub-hosted fresh/snapshot 的实际 owner/profile/H3 准入、加密边界及合法输入尚未提供。方案接受不等于这些接口已实现或真实双链已执行，任务12整体开放。

### 任务 13：R4/A1/A3，形成指定 Staging 的签字证据

**新增计划文件：** `docs/superpowers/plans/2026-09-22-stage1-r4-staging-signoff-plan.md`；消费现有 Runbook/外部适用登记，先精确方案再实际操作。

- [ ] 提前整理 Admin/Portal 浏览器动作与三样本事实：A 自助新订单、B 辅助新订单、成熟正常到期样本；用真实服务准备完整合同/期间/账单/收款/实物接收事实，不能只改日期。
- [ ] 列出 Staging 资源和三类 callback/notify 的唯一消费者、专用 signer/payer/非运营车辆、五通知模板、窗口/职责、资金额度、执行/复核/回滚操作单。
- [ ] 在 task12 同候选双链通过后，取得精确备份/恢复/部署/必要 DDL-DML/供应商操作批准；按三镜像固定 digest 提升，独立核实际 source/配置/API base/角色/健康与数据身份。
- [ ] 浏览器实际走两个新订单和成熟结束路径，核两个人工决定、一次商业确认、法大大有效归档、JSAPI 付款/核销、通知和权威激活/结束。合成 provider 与旧截图不计该项通过。
- [ ] 两次维护均有应处理对象，核 due/enqueued/结果、无重复遗漏且 blockedCount=0；两个空跑不能签字。
- [ ] 完成恢复演练并说明外部付款/签署事实不能随 DB 回滚撤销；所有失败/UNKNOWN 有可核终态或仍是阻断。
- [ ] 在原执行索引前向汇总 exact source/build proof/三镜像、双链、浏览器/供应商、维护、恢复和签字。独立退款另列状态；不称生产发布或完整 S1/Task30 完成。

2026-09-26：[R4 方案](./2026-09-22-stage1-r4-staging-signoff-plan.md)已通过 DOC-only 独立审查。成熟结束动作按当前代码修正为工单 CLOSED、delta、inspection、提案/定价及必要的重新提案、finalize，最终经放行和 completeOperations 完成；证据包在完成前导出，完成后终态另行独立读回。工单关闭和定价后重新提案的实际浏览器入口，以及如需包含终态的最终包入口，仍须核实可达，缺失时停止该验收并交接实现。未恢复线上 Docker、部署或执行供应商/资金/浏览器验收，任务13整体开放。

同日后续静态审查已确认：当前 Web 缺检查工单关闭入口；正额 CUSTOMER FINAL 计价新增账单后，当前 PROPOSED 缺重新提案入口。两项已形成独立审查通过的[正常退车浏览器修复计划](./2026-09-26-stage1-return-browser-gap-plan.md)，仅六个生产文件与六个测试文件，复用现有受权 HTTP、人工幂等来源和结算服务，不放宽 CLOSED/hash/权限守卫。实施前 source `5c57416e` 的受控 asset-operations fresh 33/33、独立读回/退役及 skip-dotenv Prisma validate 已通过；这是新开发轮基线，不是修复后的验收或真实浏览器证据。两个实现单元及 R4 实测仍开放。

浏览器修复后续实施记录：独立 `stage1-return-browser-fixes-20260926` 的工单入口单元 `4568006b` 已通过限定复审，冻结八文件的 Web 聚焦65/65、最终Web类型及 owned lint exit0。HTTP/服务组合测试提交 `acf75c4f` 已静态复审，controller单测57/57、两测试文件 lint/格式通过；其中鉴权身份为测试替身，工单 HTTP guards/DTO/service/repository/audit 为真实实现，结算段直接调用真实 controller/service，不声称经过 HTTP 或浏览器。计价后草案刷新单元仍在施工，完整同源离线门禁、expiry/asset两套fresh和真实浏览器均未执行；这两个提交尚未整合主候选，不把开发前33/33记为开发后验证。

## 6. 每个单元的统一验收与交接

- [ ] 施工前记录实际 HEAD/status、任务文件范围、批准/冻结边界；业务修改遵守 DEV_SPEC 和受控数据库 preflight。存在未明确归属的改动先交接，不回滚他人内容。
- [ ] 新确证 bug 先保存 RED；既有正确行为补 characterization 时不制造失败。每个单元先聚焦定位，独立收口执行所需完整集合。
- [ ] 报告包含代码/测试文件、实际命令/source/runtime/目标、计数、exit/signal、原件与摘要、失败历史、当前局限；不得在 raw readback/提交实际发生前预写完成。
- [ ] 新 contract/manifest 登记后跑两个离线检查；不以通过替代真实数据库验证。
- [ ] 各单元独立审查、精确提交；不一次混合客户事务、付款、协议和外部执行。无关库/目录/冻结资产不进入提交。
- [ ] 每批仅在原执行索引追加前向状态并链接证据，不另造批准台账，不重写历史 180 日/失败报告。

## 7. 覆盖自检

| 要求/本次发现 | 负责任务 | 收口凭据 |
| --- | --- | --- |
| F1/F2 商业确认与并发 | 1、6 | 真实服务 PG 反例、合法正例和联合终态 |
| F3 资金状态不倒退 | 2、7 | 并发回调、到账/核销/账单一致性 |
| F4 畸形帧不恢复成功 | 3、9、11 | MS1/MS2 parser/archive 反例、真实管道与恢复 |
| F5 退款退出主线预检 | 4、13 | 离线配置矩阵、最终主线预检 |
| F6 完结审计 | 8 | 真 completeOperations、事务审计及重放 |
| F7 B3 oracle/后续断言 | 5 | 唯一 Task3S 3/3 原件 |
| B1–B6 全主线 | 5–8、13 | 当前服务切片与三样本 |
| R1/R2/H1/H2/H3 | 3、9–11 | 既有契约消费、固定输入和真实两阶段 |
| 合法副本与最终双链 | 12 | 精确合法输入、隔离、同候选全量报告 |
| 浏览器/渠道/维护/恢复/签字 | 13 | 独立外部证据和签字 |
| 冻结域、90 日、历史、无新增环境 | Global Constraints、10–13 | 每步来源/作用域审查，不靠删除历史满足 |

推荐先启动任务 1 的两个 P1 反例与限域修复说明，同时推进任务 3–5 的独立小单元和任务 10 的 H2/expected-schema 方案；随后按上述依赖推进。R3/R4 方案任务本身有明确文件和出口，必须形成精确实施单元后才能执行真实数据/环境操作。
