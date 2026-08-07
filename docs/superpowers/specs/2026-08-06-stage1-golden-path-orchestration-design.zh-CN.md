# 阶段 1 A/B 订阅 Golden Path 持久化编排设计

日期：2026-08-06

状态：已批准设计基线

关联设计：

- [六个月订阅业务自动化设计](./2026-07-29-six-month-subscription-automation-design.zh-CN.md)
- [订阅平台三阶段能力实施路线图](./2026-07-30-three-stage-subscription-capability-roadmap-design.zh-CN.md)
- [Stage 2 Field 编排式电子签工作流](./2026-07-27-stage2-field-orchestrated-esign-workflow-design.md)
- [Staging 微信支付与移动端账单](./2026-08-01-staging-wechat-payment-and-mobile-billing-design.md)

## 1. 背景与决策

当前系统已经具备 A/B 进件、报价和订单快照、合同和电子签、首期与周期应收、微信 JSAPI 主动支付、支付回调与核销、Stage 2 交接、交付证据、Lease 激活、周期账单和通知等领域能力，但这些能力尚未形成从申请到 `ACTIVE` 的单一持久化旅程。

现状中的正常订单仍需要运营人员依次调用建单、生成合同、创建电子签任务、生成首期账单和推进交付等接口。各领域 Worker 分别具备重试或死信能力，但缺少跨域步骤、统一异常、负责人、SLA 和端到端自动化率。更严重的是，主交付路径仍可读取人工维护的“押金已收”和“首期月费已收”布尔值后直接激活订单、车辆和 Lease，形成与账单、支付和核销事实并存的第二套激活权威。

本设计作出以下已确认决策：

1. A 线客户自助申请与 B 线后台代客进件同时纳入首版 Golden Path。
2. 使用轻量、持久化的订阅旅程编排，不使用控制器直接串联，也不把总编排塞入 Billing Automation。
3. 法大大是唯一真实电子签供应商，并使用法大大生产环境完成验收。
4. 支付闭环使用客户 Portal 微信 JSAPI 主动支付。
5. 微信支付委托代扣仍在平台审核阶段，本轮保持关闭，不作为 Golden Path 的验收依赖；审核开通后另行设计接入。
6. Admin 只做增量改造，不重做现有信息架构和业务页面。

## 2. 目标

本设计交付从 A/B 申请到订阅激活的一条可生产验收、可恢复、可追踪的 Golden Path：

1. A/B 两条入口在最终方案确认以后复用同一套订单、合同、支付、交付和激活旅程。
2. 普通订单只保留最终订阅方案、最终车辆分配、交付证据验收三个内部人工决策节点。
3. 客户在 Portal 完成方案确认、法大大签署和微信 JSAPI 支付。
4. 系统自动创建订单、合同、电子签任务、首期应收、交付任务、周期账单计划和初始权益。
5. 合同、支付、交付和激活只读取各自领域的权威事实，不用 Journey 状态或人工勾选替代业务事实。
6. 所有自动步骤具备稳定幂等键、持久化执行、有限重试、超时、死信、人工接管和不可变事件审计。
7. 自动化异常在进入不可自动恢复状态后的 5 分钟内出现在 Admin 订单工作台。
8. 系统可以基于 Journey 事实计算普通订单自动推进率、步骤耗时和异常 SLA。

## 3. 非目标

本次不包含：

- 微信支付委托代扣生产接入、自动签约、自动扣款或 PaymentMandate 上线；
- 履约中换车、多车型套餐、超套餐补差、提前终止或增购；
- 客户积分账本、可购买权益和能源用量闭期；
- Stage 1C 的资产所有权期间、通用资产工单、运营限制和车辆成本账本；
- 通用 BPM/OA、动态流程设计器、用户自定义步骤或可执行脚本；
- 旧订单批量迁移到新 Journey；
- 删除现有领域恢复接口、旧订单读取能力或 `RENT_TO_OWN` 历史兼容字段。

## 4. 方案选择

### 4.1 采用：轻量持久化订阅旅程

新增专用于 `SUBSCRIPTION` A/B 主线的 Journey、Step、Job、ManualTask、Event、Exception 和 Outbox。编排器负责“何时调用哪个既有领域能力”，领域服务继续负责“该能力是否合法以及如何改变业务事实”。

选择原因：

- Worker 重启后可以从数据库继续执行；
- 重复客户请求、供应商回调和任务重放不会产生重复业务对象；
- 可以统一展示跨申请、合同、支付和交付的异常；
- 可以测量自动化率和步骤 SLA；
- 不复制合同、财务、支付和交付规则；
- 后续变更中心和 Stage 1C 可以复用执行模式，但本轮不预建未使用的通用能力。

### 4.2 不采用：在控制器和回调中直接串联服务

直接串联改动最小，但外部回调、数据库提交和下游调用无法形成稳定的恢复边界。任何中途失败都可能需要运营人员判断“上一动作是否已经成功”，无法满足重启续跑、统一异常和 95% 自动化率验收。

### 4.3 不采用：扩展 Billing Automation 承担总编排

Billing Automation 的职责是周期账单及其通知、逾期和扣款任务。把进件、合同、交付和激活塞入该模块会混淆领域边界，也使账单 Worker 成为所有订单流程的单点耦合。本设计保留其现有职责，由 Journey 在激活时调用其公开能力创建 BillingSchedule。

## 5. Golden Path

### 5.1 A/B 入口

A 线：

```text
客户 Portal 提交 SELF_SERVICE Application
  -> 系统执行材料完整性、产品适配、库存和确定性风险规则
  -> 创建或唤醒 SubscriptionJourney
```

B 线：

```text
运营 Admin 创建 SALES_ASSISTED Application
  -> 使用与 A 线相同的字段、快照和确定性规则
  -> 创建或唤醒 SubscriptionJourney
```

材料格式、必填项、产品适配和库存有效性属于确定性检查。普通订单由系统给出通过或阻断结果；规则无法判定、数据冲突或需要风险例外时进入 Exception，不新增第四个普通人工决策节点。

### 5.2 统一下游旅程

```text
APPLICATION_VALIDATION
  -> FINAL_PLAN_DECISION
  -> CUSTOMER_PLAN_CONFIRMATION
  -> FINAL_VEHICLE_ALLOCATION
  -> ORDER_AND_CONTRACT_CREATION
  -> FADADA_SIGNING_AND_ARCHIVE
  -> INITIAL_BILLING
  -> CUSTOMER_JSAPI_PAYMENT
  -> HANDOVER_AND_STAGE2_CREATION
  -> DELIVERY_EVIDENCE_DECISION
  -> AUTHORITATIVE_ACTIVATION
  -> COMPLETED
```

具体顺序：

1. 系统校验申请事实和快照。
2. 人工决策 1：运营确认最终订阅方案、客户等级和押金方案。
3. 客户在 Portal 确认精确的最终方案版本。
4. 人工决策 2：运营确认最终车辆分配。
5. 系统幂等创建 SubscriptionQuote、SubscriptionOrder、合同 PDF 和法大大签署任务。
6. 客户完成法大大实名与签署，平台完成盖章；系统验签回调、主动对账并归档最终 PDF。
7. 合同归档后系统幂等创建押金和首期租金应收。
8. 客户在 Portal 使用微信 JSAPI 支付；系统验签、登记支付并核销应收。
9. 所有必付应收结清后，系统创建交付记录、Stage 1 财务完成事实及 Stage 2 现场交接任务。
10. 人工决策 3：运营审核交付证据。
11. 系统根据合同、应收、支付、核销、Stage 2、现场里程和证据事实，在单事务中激活订单、车辆、Lease、BillingSchedule、初始权益和 Journey。

客户提交申请、确认方案、完成实名/签署和主动付款属于客户履约动作，不计入内部人工决策节点。

## 6. 架构与组件边界

### 6.1 `SubscriptionJourneyService`

职责：

- 为 Application 幂等创建 Journey；
- 根据不可变事件和当前领域事实确定下一 Step；
- 创建 ManualTask、Job 或 Exception；
- 完成、取消或重新唤醒 Journey；
- 不直接实现报价、合同、支付或交付规则。

### 6.2 `SubscriptionJourneyWorker`

职责：

- 以数据库租约领取到期 Job；
- 调用与 Job 类型对应的 Handler；
- 续租、防并发执行、有限重试和死信；
- 对已完成的幂等动作安全返回成功；
- 进程启动后回收过期租约并继续执行。

### 6.3 Handler

每种自动步骤使用独立 Handler，并只依赖所需领域接口：

- `ValidateApplicationHandler`
- `CreateOrderAndContractHandler`
- `StartFadadaSigningHandler`
- `ReconcileFadadaSigningHandler`
- `GenerateInitialBillsHandler`
- `EvaluatePaymentSettlementHandler`
- `CreateHandoverHandler`
- `ActivateSubscriptionHandler`
- `DispatchJourneyNotificationHandler`

Handler 不直接访问其他领域的私有表；如果现有服务没有合适的事务内公开方法，实施时提取窄接口，而不是在编排器复制 SQL 和状态规则。

### 6.4 Outbox Dispatcher

外部调用和异步唤醒都从事务 Outbox 发出。Dispatcher 仅传递本地 ID、事件版本和稳定幂等键，不在 payload 中存储完整签署 URL、证件号、支付密钥或供应商密钥。

### 6.5 Admin/Portal Projection

Journey 写模型与 UI 投影分离。Admin 和 Portal 通过只读 Projection 获取当前步骤、客户待办、内部待办、阻断原因、异常状态和时间线，不直接拼装跨域状态。

## 7. 领域模型

### 7.1 枚举

```text
SubscriptionJourneyStatus
  RUNNING
  WAITING_CUSTOMER
  WAITING_MANUAL
  RETRY_SCHEDULED
  PAUSED
  EXCEPTION
  COMPLETED
  CANCELLED

SubscriptionJourneyStepCode
  APPLICATION_VALIDATION
  FINAL_PLAN_DECISION
  CUSTOMER_PLAN_CONFIRMATION
  FINAL_VEHICLE_ALLOCATION
  ORDER_AND_CONTRACT_CREATION
  FADADA_SIGNING_AND_ARCHIVE
  INITIAL_BILLING
  CUSTOMER_JSAPI_PAYMENT
  HANDOVER_AND_STAGE2_CREATION
  DELIVERY_EVIDENCE_DECISION
  AUTHORITATIVE_ACTIVATION

SubscriptionJourneyStepStatus
  PENDING
  RUNNING
  WAITING_CUSTOMER
  WAITING_MANUAL
  RETRY_SCHEDULED
  EXCEPTION
  COMPLETED
  SKIPPED
  CANCELLED

SubscriptionJourneyManualTaskType
  FINAL_PLAN_DECISION
  FINAL_VEHICLE_ALLOCATION
  DELIVERY_EVIDENCE_DECISION

SubscriptionJourneyManualTaskStatus
  OPEN
  COMPLETED
  CANCELLED

SubscriptionJourneyManualTaskDecision
  APPROVED
  REJECTED

SubscriptionJourneyJobType
  VALIDATE_APPLICATION
  CREATE_ORDER_AND_CONTRACT
  START_FADADA_SIGNING
  RECONCILE_FADADA_SIGNING
  GENERATE_INITIAL_BILLS
  EVALUATE_PAYMENT_SETTLEMENT
  CREATE_HANDOVER
  ACTIVATE_SUBSCRIPTION
  DISPATCH_NOTIFICATION

SubscriptionJourneyJobStatus
  PENDING
  PROCESSING
  RETRY_SCHEDULED
  COMPLETED
  DEAD_LETTER
  CANCELLED

SubscriptionJourneyEventType
  JOURNEY_STARTED
  STEP_STARTED
  STEP_WAITING_CUSTOMER
  STEP_WAITING_MANUAL
  STEP_COMPLETED
  STEP_RETRY_SCHEDULED
  STEP_EXCEPTION
  MANUAL_TASK_DECIDED
  DOMAIN_FACT_OBSERVED
  JOURNEY_PAUSED
  JOURNEY_RESUMED
  JOURNEY_CANCELLED
  JOURNEY_COMPLETED
  EXCEPTION_RESOLVED

SubscriptionJourneyExceptionStatus
  OPEN
  ACKNOWLEDGED
  RESOLVED

SubscriptionJourneyOutboxStatus
  PENDING
  PROCESSING
  DELIVERED
  DEAD_LETTER
  CANCELLED
```

所有重要状态均使用 Prisma/PostgreSQL 枚举。Job 类型、Event 类型和 Exception 分类同样使用枚举，不以自由文本控制业务分支。

### 7.2 `SubscriptionJourney`

核心字段：

| 字段                                      | 语义与约束                              |
| ----------------------------------------- | --------------------------------------- |
| `id` / `journeyNo`                        | UUID；业务编号唯一                      |
| `applicationId`                           | 必填且唯一；Journey 的创建根            |
| `orderId`                                 | 建单后写入；非空时唯一                  |
| `applicationSource`                       | `SELF_SERVICE` 或 `SALES_ASSISTED` 快照 |
| `status`                                  | Journey 总状态                          |
| `currentStepCode`                         | 当前未完成步骤                          |
| `version`                                 | 乐观锁版本                              |
| `startedAt/completedAt/cancelledAt`       | 生命周期时间                            |
| `createdAt/updatedAt/createdBy/updatedBy` | 标准审计字段                            |

同一 Application 最多一个 Journey，同一 Order 最多一个 Journey。Journey 不保存“合同已签”或“账单已付”的可写布尔值。

### 7.3 `SubscriptionJourneyStep`

每个 Journey 对每个 StepCode 恰有一条当前记录，`(journeyId, stepCode)` 唯一。字段包括状态、首次开始时间、完成时间、最近错误分类、重试次数、输入引用快照和结果引用快照。快照只保存本地业务 ID、版本和摘要，领域表仍是事实来源。

### 7.4 `SubscriptionJourneyJob`

字段包括 `jobType`、`stepId`、全局唯一 `idempotencyKey`、状态、`availableAt`、`attemptCount`、`maxAttempts`、租约持有人、租约到期时间、最近错误分类和脱敏错误摘要。

领取任务使用 `FOR UPDATE SKIP LOCKED` 或等价 Prisma 原生事务；只有租约持有人可以完成或重排任务。等待客户签署或付款不占用 Job，也不消耗重试次数。

### 7.5 `SubscriptionJourneyManualTask`

只允许三种 ManualTaskType。字段包括所属 Journey/Step、状态、分配角色、决定、决定理由、决定人和决定时间。同一 Journey、任务类型和业务版本最多一个活动任务。

普通审批决定完成后不可原地修改；需要修订方案时取消当前版本、记录 Event，并创建新版本任务。任何 ManualTask 都不能写入合同签署、支付核销或交付完成事实。

### 7.6 `SubscriptionJourneyEvent`

Event 是追加式、不可变记录，保存唯一 `eventKey`、事件类型、Journey/Step、关联实体类型和 ID、事实发生时间、记录时间、来源、载荷摘要和关联 ID。纠错使用新的补偿 Event，不更新旧 Event。

### 7.7 `SubscriptionJourneyException`

字段包括异常分类、严重度、Journey/Step、首次和最近发生时间、负责人、SLA 截止时间、状态、可执行恢复动作、解决人、解决原因和解决时间。同一 Journey/Step/异常指纹最多一个活动异常，重复失败更新计数和最近时间，不制造重复工单。

### 7.8 `SubscriptionJourneyOutbox`

字段包括唯一 `idempotencyKey`、事件类型、聚合 ID、载荷、状态、可投递时间、尝试次数和投递结果。创建或改变关键领域事实时，在同一数据库事务中写 Outbox；外部发送成功后再标记已投递。

## 8. 权威事实与激活约束

### 8.1 合同权威

合同可进入后续账单步骤必须同时满足：

- 使用法大大 Provider；
- 客户身份和签署人匹配；
- 所有必需签署动作完成；
- 平台盖章完成；
- 回调验签通过或主动查询得到等价终态；
- 最终签后 PDF 已下载、校验 SHA-256 并归档；
- 本地 Contract 指向该归档对象。

Journey 的 `FADADA_SIGNING_AND_ARCHIVE` 完成状态不能单独证明合同完成。

### 8.2 资金权威

删除或废弃 `PrepareDeliveryDto` 中可写的 `depositReceivedConfirmed` 和 `firstMonthlyFeeReceivedConfirmed`。为了旧数据兼容，数据库旧字段可以在过渡期只读展示，但新写路径不得更新，也不得作为交付或激活条件。

激活前必须在同一事务内锁定并重新读取：

- 当前订单要求的押金应收；
- 当前订单要求的首期租金应收；
- 每张应收的有效 WriteOff 总额；
- 已撤销、退款或冲正的支付影响；
- 合同及交付事实。

零金额或明确豁免必须由应收/押金规则中的正式事实表示，不能以勾选替代。任何账单未足额核销都返回稳定错误码并保持 Journey 在 `CUSTOMER_JSAPI_PAYMENT`。

### 8.3 交付权威

交付完成以 Stage 2 双方签署、归档、Field 现场里程、必需证据上传及人工证据决策通过为准。`Delivery` 的整备、身份核验和文件准备字段继续作为运营事实，但不能替代合同或资金条件。

### 8.4 原子激活

权威激活 Handler 必须复用或收敛到一个激活引擎，并在单一数据库事务中：

1. 锁定 Journey、Order、Vehicle、Lease、应收和交付门禁记录；
2. 重新校验合同、资金、车辆、保险、交接和证据事实；
3. 更新 Order 为 `ACTIVE`；
4. 更新 Vehicle 为 `LEASED`；
5. 创建或更新 Lease 为 `ACTIVE`；
6. 幂等创建或恢复 BillingSchedule；
7. 幂等生成初始权益；
8. 完成激活 Step 和 Journey；
9. 写 Audit、JourneyEvent 和 Outbox。

任一动作失败必须整体回滚。现有 `confirmDelivery` 不再直接调用无门禁的 Lease persistence helper。

## 9. A/B 规则与人工决策

### 9.1 自动校验

以下检查自动执行：

- 申请必填资料和文件类型/状态完整；
- 客户与申请未删除、未被禁止；
- ProductVersion、SubscriptionPlan 和组件有效；
- 车型、车辆、套餐和业务类型适配；
- 车辆没有被其他活动申请或订单占用；
- 客户等级、押金规则和金额计算一致；
- 报价金额、车辆销售价和套餐快照可重算且一致。

自动校验不能确定时进入 Exception，由运营处理数据或规则后重放，不通过“审核通过”覆盖失败事实。

### 9.2 三个人工决策

`FINAL_PLAN_DECISION`：确认最终套餐、期限、价格、客户等级和押金方案。若与客户意向不同，必须在客户确认页面清晰展示差异。

`FINAL_VEHICLE_ALLOCATION`：确认唯一车辆。提交时重新校验车辆状态和占用，并完成 `REVIEW_RESERVED/AVAILABLE -> RESERVED` 的并发安全转换。

最终方案确认的是车型、套餐、期限、价格和押金，不承诺尚未完成最终分配的唯一 VIN。最终车辆的车型、价格基础或其他合同事实与客户已确认方案不一致时，不得继续生成合同；系统创建新方案 revision，并回到客户确认步骤。

`DELIVERY_EVIDENCE_DECISION`：审核交付证据集合。决定绑定精确 evidence manifest 版本；新增或替换证据后必须重新审核。

### 9.3 客户动作

客户确认最终方案时提交精确方案 revision；过期 revision 返回冲突并刷新页面。A/B 客户都使用 Portal 完成确认、法大大实名/签署和微信 JSAPI 支付。

## 10. 法大大生产电子签

### 10.1 Provider 与配置

- `ESIGN_PROVIDER=fadada`；
- `FADADA_ENABLED=true`；
- `FADADA_ENV=production`；
- 生产环境发现 `ESIGN_PROVIDER=mock`、缺少 AppId/AppSecret、平台客户 ID、签章 ID或回调 URL时启动失败；
- 密钥只从部署 Secret 注入，不写入数据库、日志、Event 或 Outbox；
- 回调地址使用生产 API HTTPS 域名。

### 10.2 签署流程

系统复用现有 Fadada Provider、客户账户绑定、实名准备、签署状态查询和签后文件归档能力。Journey 负责自动调用和推进：

1. 生成正式 Subscription Contract PDF；
2. 校验客户法大大账户 readiness，未完成实名时向 Portal 发出实名入口；
3. 上传合同并创建签署任务；
4. 向客户提供短期签署 URL；
5. 验证客户完成回调；
6. 发起或确认平台盖章；
7. 下载、校验和归档最终 PDF；
8. 以归档完成事件唤醒 Journey。

签署 URL 过期只重新签发入口，不重复创建业务合同。回调先完成验签和去重，再持久化 Event/Job并尽快返回成功响应；下游步骤由 Worker 异步执行。

### 10.3 回调丢失与对账

签署发起 5 分钟后进行第一次主动查询，30 分钟后进行第二次查询，其后每 6 小时查询一次，直至签署完成、拒签、取消或合同有效期结束。进行中的正常签署状态不消耗失败重试；Provider 返回 `Retry-After` 时在不超过 6 小时的范围内优先遵从。回调丢失时，等价的 Provider 查询终态可以完成本地状态收敛。签名错误、签署人不匹配或 Provider 合同 ID 冲突立即进入 Exception。

## 11. 首期应收与微信 JSAPI 支付

### 11.1 首期应收

合同归档事件触发首期应收 Handler。Handler 复用 Finance 的初始账单能力，以 `initial-bills:<orderId>` 为幂等键创建：

- 押金应收；
- 首期租金应收；
- 明确属于首期的其他正式费用，仅在既有报价/合同快照中存在时创建。

重复执行返回同一组账单，不覆盖金额或账单快照。账单创建成功后向 Portal 和真实通知 Provider 发布待支付消息。

### 11.2 Portal JSAPI

Portal 展示当前客户可支付的未结清账单。客户选择应收后创建或刷新 PaymentOrder，并通过微信 JSAPI 拉起支付。PaymentOrder 必须绑定客户、账单、金额、OpenId、过期时间和稳定业务幂等键。

客户关闭支付页、JSAPI 取消或 PaymentOrder 超时不把应收标记失败；客户可重新发起。新 PaymentOrder 不创建新 ReceivableBill。

### 11.3 回调与核销

微信回调必须完成平台签名验证、商户/应用/金额匹配和 Provider 交易号幂等校验。支付登记、应收锁定、WriteOff、PaymentOrder 终态、Audit 和 Journey Outbox 在同一事务提交。重复或乱序回调返回既有结果，不重复核销。

所有必付应收足额结清后才唤醒 `HANDOVER_AND_STAGE2_CREATION`。本轮 `AUTO_DEBIT_ENABLED=false`、`PAYMENT_MANDATE_PROVIDER=disabled`；不存在 Mandate 不得阻塞主动支付或旅程推进。

## 12. 交付、证据和激活

资金门禁满足后，系统幂等创建交付记录、Stage 2 handover 和 Field work order，并通过真实通知渠道发送对应待办。生产 Golden Path 使用 `NOTIFICATION_PROVIDER=wechat_official_account` 和 Portal 站内记录；关键通知的短信降级继续使用现有模板和渠道配置。生产环境使用 mock Notification Provider 时预检失败。运营不需要手动调用“创建交接单”推进正常订单。

Stage 2 继续复用既有持久化轮询、签署、证据 manifest、现场里程和归档能力。所有必需证据完成后创建 `DELIVERY_EVIDENCE_DECISION` ManualTask。决定通过后唤醒权威激活 Handler；拒绝时保持订单未激活并列出需要补充的 evidence item，提交新 manifest 后生成新版本任务。

激活成功后发布合同生效、订阅已开始和下一账期信息，并由现有 Billing Automation 管理后续 D-3 出账、主动支付提醒、逾期和催收。委托代扣任务不创建。

## 13. 幂等、事务和并发

稳定幂等键至少包括：

```text
journey:create:<applicationId>
order:create:<applicationId>:<finalPlanRevision>
contract:create:<orderId>:<contractVersion>
esign:start:<contractId>:<contractVersion>
initial-bills:<orderId>
payment-settlement:<provider>:<providerTransactionId>
handover:create:<orderId>
activate:<orderId>
notification:<journeyId>:<eventType>:<eventVersion>
```

并发控制规则：

- Journey 通过 version 乐观锁防止两个事件同时推进；
- Job 通过数据库租约和 `SKIP LOCKED` 防止多 Worker 重复执行；
- 建单、合同、账单、交接和激活同时依赖业务唯一约束；
- 支付回调锁定 PaymentOrder 和 ReceivableBill；
- 配车锁定 Vehicle 及占用订单；
- 激活锁定 Journey、Order、Vehicle、Lease、账单和 Delivery 门禁；
- 领域事实已成功但 Step 尚未完成时，重放 Handler读取既有事实并补齐 Step/Event，不重复领域动作。

## 14. 重试、异常和人工接管

### 14.1 失败分类

可重试：网络超时、Provider 429/5xx、数据库死锁、租约丢失和暂时性存储失败。

等待：客户未确认、未完成实名/签署、未付款或尚未提交现场证据。等待不消耗重试次数。

不可自动恢复：签名验证失败、主体不匹配、金额不匹配、业务唯一性冲突、非法状态转换、快照重算不一致和必需配置缺失。

### 14.2 重试策略

自动任务默认最多执行 5 次，失败后的基础重排间隔依次为 30 秒、2 分钟、10 分钟和 30 分钟，并增加不超过基础间隔 20% 的随机抖动。Provider 明确返回 `Retry-After` 时，在 2 小时上限内优先遵从。特定 Job 如需不同策略，必须在类型常量中显式声明并以测试固定，不接受客户端覆盖。重试耗尽或出现不可恢复错误时，在同一事务中把 Step/Journey 标为 `EXCEPTION`、创建或更新 JourneyException，并写 Admin 通知 Outbox。

Exception 必须在不可自动恢复状态形成后的 5 分钟内可见。监控同时检查 Dispatcher 堆积、Worker 最后心跳、最老可执行 Job 和超过 SLA 的 Exception。

`PAUSED` 只暂停新的自动 Job 领取，不撤销合同、账单、支付或交付事实，也不阻止法大大和微信回调被安全验签及落库。回调形成的 Event 保留，恢复 Journey 后重新评估；暂停和恢复均要求权限、原因和审计。

### 14.3 恢复动作

Admin 首版只提供：

- 重新读取并评估当前领域事实；
- 重新查询法大大状态；
- 重新签发实名或签署入口；
- 重新创建微信 JSAPI PaymentOrder；
- 重放当前安全幂等步骤；
- 暂停、恢复或取消 Journey。

所有动作要求权限、原因和 Audit。系统不提供“强制合同已签”“强制账单已付”“强制证据通过”或“强制激活”。

### 14.4 取消边界

- 客户拒绝最终方案或在正式订单创建前放弃时，取消 Journey 并安全释放 `REVIEW_RESERVED` 车辆；
- 最终配车后、合同尚未完成签署归档前取消时，复用现有订单/合同取消规则，只有不存在其他占用时才释放 `RESERVED` 车辆；
- 合同已经签署归档后，不允许通过 Journey 的普通取消动作撤销业务事实，必须进入正式合同终止流程；该终止流程不属于本设计；
- 取消不删除 Application、Quote、Order、Contract、Payment 或 Event，所有对象保留历史状态和审计记录。

## 15. Admin 与 Portal 改造

### 15.1 Admin

不新增一级导航，不重做订单详情。现有订单工作台增加：

- Journey 总状态、当前步骤和启动/更新时间；
- A/B 来源和自动化进度；
- 三个人工任务的待办、决定和历史；
- 客户待办：方案确认、实名/签署、支付；
- 最近事件、重试和当前异常；
- 受权限控制的恢复动作。

申请/订单列表只增加 Journey 状态、异常徽标和筛选项。现有正常推进按钮在 Journey 开启的订单上隐藏；出现 Exception 时按允许恢复动作显示。旧订单继续显示原按钮。

### 15.2 Portal

Portal 在现有申请/账单页面增加统一的“当前待办”：

- 确认最终方案；
- 完成法大大实名；
- 打开或刷新法大大签署入口；
- 查看押金和首期租金应收；
- 发起微信 JSAPI 支付；
- 查询支付、合同和激活结果。

Portal 不显示内部 Job、重试堆栈或供应商敏感错误；面向客户提供稳定、可行动的中文状态和刷新入口。

## 16. 权限、审计和安全

新增权限按既有五处同步规则实施：shared auth、seed、menus、后端 guard 和前端可见性。至少区分 Journey 查看、最终方案决定、最终车辆分配、交付证据决定、异常恢复和 Journey 取消。`ADMIN` 拥有全部权限，其他角色按职责最小授权；seed 或 JWT 权限改变后要求用户重新登录。

以下操作必须写 Audit 和 JourneyEvent：

- Journey 创建、步骤转换、暂停、恢复、取消和完成；
- 三个人工决定；
- 自动建单、合同创建和法大大任务创建；
- Provider 回调验签结果和主动对账收敛；
- 首期账单创建、支付、核销和退款/冲正影响；
- 交付任务创建、证据决定和激活；
- Exception 创建、分配、恢复和解决。

日志、Event、Exception 和 Outbox 禁止保存证件号、完整手机号、签署 URL、微信支付密钥、法大大密钥、原始回调密文或未脱敏 Provider 响应。

## 17. 发布与兼容

新增 `SUBSCRIPTION_JOURNEY_ENABLED` 总开关和受控放量规则。发布顺序：

1. 部署 Schema、Worker 和只读 Projection，开关关闭；
2. 运行迁移状态、Schema、类型、单元和集成测试；
3. 在生产配置法大大真实 Provider、微信支付和真实通知 Provider，执行 fail-closed 预检；
4. 仅对生产验收 Application/Customer allowlist 开启；
5. A/B 各完成一条受控 Golden Path；
6. 对所有新 A/B Application 开启；
7. 旧订单继续原流程，不批量补 Journey；
8. 观察自动化率、异常 SLA、Job 堆积和回调对账后再移除新订单的正常推进按钮。

开关关闭时不得创建 Journey，不影响既有申请、订单和 Worker。开关开启后只对新的、满足准入条件的 Application 创建 Journey；同一 Application 不会因开关抖动创建重复 Journey。

## 18. 生产验收数据治理

法大大生产环境和微信支付生产商户均产生真实外部记录。验收必须使用已授权的内部测试签署人、专用测试客户、专用不可运营车辆和专用合同模板。合同正文明确写明“系统验收测试，不构成真实车辆租赁合同或车辆交付承诺”，并使用与正式模板不同的模板编号。

支付使用业务和渠道允许的受控最小金额。支付成功后按正式退款流程完成退款，并保留 Payment、WriteOff、Refund、Audit 和 JourneyEvent。验收记录不得直接删除或修改为不存在；应以验收批次标识、合同模板和客户标识从正常运营筛选中排除。任何生产执行前必须完成参与人授权、金额、车辆、模板、回调 URL 和回滚/停止条件复核。

## 19. 测试与验收

### 19.1 自动测试层次

单元测试：

- Step 转换和不可达状态；
- 幂等键；
- 重试分类和退避；
- 资金门禁；
- 法大大和微信回调验签映射；
- Projection 和客户文案。

数据库集成测试：

- Journey/Application/Order 唯一约束；
- Job 租约和并发领取；
- Outbox 与领域事务原子性；
- 重复/乱序回调；
- 配车并发；
- 未付账单拒绝激活；
- 激活整体回滚；
- Worker 重启和过期租约回收。

API/UI 测试：

- A/B 入口、三个 ManualTask 和客户动作；
- Admin Journey 卡片、异常恢复和权限；
- Portal 方案确认、法大大入口、账单和 JSAPI 状态刷新；
- 旧订单兼容。

生产验收：

1. A 线从客户自助申请到 `ACTIVE`；
2. B 线从后台代客进件到 `ACTIVE`；
3. 两条路径均真实通过法大大生产签署、平台盖章和 PDF 归档；
4. 两条路径均真实通过 Portal 微信 JSAPI 支付和核销；
5. 押金或首租任一未核销时拒绝激活；
6. 法大大回调丢失时由主动查询恢复；
7. 重复/乱序法大大和微信回调不产生重复事实；
8. 客户关闭支付页后可重新发起；
9. Worker 在自动步骤后重启并继续；
10. 外部服务失败重试耗尽后 5 分钟内出现在 Admin；
11. 人工恢复包含操作人、原因和前后状态；
12. `AUTO_DEBIT_ENABLED=false` 且不存在 Mandate 时仍完成整个旅程。

### 19.2 Golden Path Definition of Done

- A/B 两条生产受控订单均到达 `OrderStatus.ACTIVE`；
- 正常路径只有三个内部 ManualTask；
- 法大大生产签署、盖章和归档全部有 Provider 与本地证据；
- Portal 微信 JSAPI 支付、回调、Payment 和 WriteOff 可互相追溯；
- 无任何接口、角色或恢复动作可以绕过必付账单核销；
- 激活原子完成 Order、Vehicle、Lease、BillingSchedule、初始权益和 Journey；
- 失败在 5 分钟内进入统一异常视图；
- 重复请求、重复回调、乱序回调和 Worker 重启不会产生重复业务事实；
- 全链路可以从 JourneyEvent 还原；
- 新 A/B 普通订单自动推进率可计算，作为后续达到 95% 出关指标的统计基础。

## 20. 开发波次

### Wave 1：资金权威与 Journey 骨架

建立模型、迁移、Worker、Outbox、Projection 和功能开关；收敛激活入口，废弃人工收款放行，并先证明未付不能激活、重启可恢复。

### Wave 2：A/B 进件统一

自动执行确定性检查，建立最终方案和最终车辆 ManualTask，支持客户确认精确方案 revision，并自动创建报价和订单。

### Wave 3：法大大生产闭环

自动创建主合同和签署任务，补齐生产 fail-closed、客户 readiness、回调、主动对账、平台盖章、最终 PDF 归档及真实通知。

### Wave 4：JSAPI 收款至交付激活

自动创建首期应收，串联 Portal JSAPI、回调核销、交付/Stage 2、证据 ManualTask 和权威原子激活。委托代扣保持禁用。

### Wave 5：Admin 可观察与恢复

在订单工作台增加 Journey Projection、异常标识、重试/暂停/恢复/取消，以及自动化率、步骤耗时和异常 SLA 指标。

### Wave 6：生产验收与渐进放量

完成预检、受控 A/B 生产验收、失败注入、回调乱序和 Worker 重启场景；通过后只对新申请逐步放量，旧订单不迁移。

## 21. 基线与实施前置条件

本设计在 `origin/main@761e2533b1d1487157994a3be1b5f6166474aefb` 上形成。设计文档创建前，`pnpm prisma:validate` 通过；新隔离工作树没有注入 `DATABASE_URL`，因此 `prisma migrate status` 报告 Prisma config 缺少 `datasource.url`，尚未证明数据库迁移状态。

实施任何 Schema 或业务代码前必须提供目标开发数据库的有效 `DATABASE_URL`，重新执行并通过：

```powershell
git status --short
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm prisma:validate
```

如果迁移状态失败或存在待执行迁移，停止业务代码施工并先处理基线，不运行 `prisma migrate reset`。
