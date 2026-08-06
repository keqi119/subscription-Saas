# 阶段 1B 合同续期与续订考虑期设计

日期：2026-08-05

状态：已批准设计基线

关联设计：

- [六个月订阅业务自动化设计](./2026-07-29-six-month-subscription-automation-design.zh-CN.md)
- [订阅平台三阶段能力实施路线图](./2026-07-30-three-stage-subscription-capability-roadmap-design.zh-CN.md)

## 1. 背景与现状

阶段 1A 已覆盖新合同签署、交付、起租和首次收款，阶段 1B 已覆盖周期账单、主动支付、授权代扣基础、逾期催收、月度里程复核及退车里程档案。当前仍缺少可审计、可自动执行的正式续期能力。

现有 `OrderChange` 模型只有单层审批与执行状态，无法表达报价版本、客户确认、补充协议签署、未来生效、失败重试和合同分段；现有 `OrderChangeType.EXTENSION` 也不能安全承载完整续期。现有 `SubscriptionOrder.endDate`、`monthlyFeeAmount` 与 `finalPlanSnapshot` 是原订单事实，若原地覆盖会破坏原合同、账单、权益和历史报表的可追溯性。

现有账单协调器直接以 `SubscriptionOrder.endDate` 判断是否停止生成月租账单，合同模板仅有 `SUBSCRIPTION_STANDARD` 和 `DELIVERY_HANDOVER`，电子签也没有续期补充协议的专用签署阶段和文档类型。若只延长订单日期，会造成模板误选、历史合同被篡改、续期价格无法分段、账单计划提前结束等问题。

业务规则进一步明确为：续订必须在当前合同到期前完成；到期后不得短期留车，也不允许以“仍在协商”为由延续原合同。系统应在到期前一个月进入续订考虑期，通过三次渐进提醒要求客户作出决定。未在期限内完成续期补充协议签署并归档的，按原合同到期结束并启动退车。

## 2. 目标

本设计交付阶段 1B 的首个正式合同变更纵切：协议延长（续期），并补齐续订考虑期。

目标包括：

1. 原合同及原订单快照不可变，以合同分段表示连续履约期。
2. 支持当前版本价格、原价格和已审批折扣三种续期定价方式。
3. 支持报价、客户确认、专用补充协议、电子签、归档和未来生效完整闭环。
4. 续期后，月租账单、权益续发、支付与代扣继续使用正确分段事实。
5. 到期前 D-30、D-14、D-3 提醒客户；未完成续期时无缝转入退车，不产生留车状态。
6. 所有自动任务可重试、可人工接管、幂等且有审计记录。
7. 旧 `OrderChange` 历史继续可读，但不再允许通过旧接口创建新的 `EXTENSION`。

## 3. 非目标

本次不包含：

- 提前解约、换车、套餐变更、所有权转移或买断；
- 到期后补签、追溯生效、宽限留车或自动续约；
- 退车损伤、违章、清洁和超期占用费用结算；
- 自动撤销已签续期合同；已签合同的后续调整必须进入新的正式变更；
- 自动解除微信或其他支付委托代扣授权；
- 阶段 1C 车辆整备、维修和资产处置工作单；
- 合同外协商记录系统。协商可在线下进行，但只有本设计内的正式事实影响履约。

## 4. 方案选择

### 4.1 采用：新增 V2 合同变更域

新增 `SubscriptionChangeOrder`、`SubscriptionChangeQuote`、`SubscriptionContractSegment` 和 `RenewalConsideration`，复用现有合同、电子签、通知、账单、权益、退车和审计底座。

选择原因：

- 原合同事实不被覆盖；
- 报价、签约和生效可分别审计；
- 后续可在同一边界扩展套餐变更、换车和提前结束；
- 失败不会污染正在履约的原订单。

### 4.2 不采用：扩充旧 `OrderChange`

旧模型缺少不可变报价、合同关联、执行任务、并发版本和客户动作，继续叠加会使既有简单变更语义失真。旧表保留只读历史；旧创建接口收到 `EXTENSION` 时返回 409 和迁移提示。

### 4.3 不采用：直接修改 `SubscriptionOrder.endDate`

直接修改会破坏合同及账单历史，也无法处理续期前后价格和套餐不同的情况。`SubscriptionOrder.endDate` 永远表示原始主合同结束日。

## 5. 领域模型

### 5.1 枚举

新增以下枚举：

```text
SubscriptionChangeType
  EXTENSION

SubscriptionChangeStatus
  DRAFT
  QUOTED
  CUSTOMER_CONFIRMED
  SIGNING_OR_PAYMENT
  SCHEDULED
  EXECUTING
  COMPLETED
  CANCELLED
  FAILED
  MANUAL_TAKEOVER

SubscriptionChangePricingMode
  CURRENT_VERSION
  ORIGINAL_PRICE
  APPROVED_DISCOUNT

SubscriptionChangeQuoteStatus
  DRAFT
  FORMAL
  SUPERSEDED
  CUSTOMER_CONFIRMED
  CUSTOMER_REJECTED
  EXPIRED

ContractSegmentType
  BASE
  EXTENSION

ContractSegmentStatus
  SCHEDULED
  ACTIVE
  COMPLETED
  CANCELLED

RenewalConsiderationStatus
  PENDING_DECISION
  RENEWAL_REQUESTED
  EXPIRY_CONFIRMED
  EXTENSION_IN_PROGRESS
  EXTENDED
  EXPIRED
  CANCELLED

RenewalDecision
  RENEW
  EXPIRE

RenewalReminderSlot
  D30
  D14
  D3

RenewalReminderStatus
  PENDING
  SENT
  FAILED
  SKIPPED_DECIDED
  SKIPPED_EXTENDED
  SKIPPED_LATE_ENROLLMENT
  CANCELLED
```

扩充现有枚举：

```text
OrderStatus
  + PENDING_RETURN

LeaseStatus
  + RETURN_DUE

ContractTemplateType
  + SUBSCRIPTION_EXTENSION

ESignSigningStage
  + STAGE3_SUBSCRIPTION_EXTENSION

ESignDocumentType
  + SUBSCRIPTION_EXTENSION_AGREEMENT
```

`PENDING_RETURN` 表示合同已到期、客户必须归还车辆；`RETURN_DUE` 表示租赁履约期已结束但实物车辆尚未完成退回。车辆仍保持 `VehicleStatus.LEASED`，直至退车确认，不能被重新分配。

### 5.2 `SubscriptionChangeOrder`

核心字段：

| 字段 | 约束与语义 |
| --- | --- |
| `id` / `changeNo` | UUID；业务编号唯一 |
| `orderId` | 关联原订单，必填 |
| `changeType` | 首批只允许 `EXTENSION` |
| `status` | 使用 V2 生命周期 |
| `sourceSegmentId` | 发起续期时的当前末段，必填 |
| `renewalConsiderationId` | 由考虑期发起时关联，可空但一对一 |
| `extensionMonths` | 正整数，首批由运营选择 |
| `pricingMode` | 三种定价模式之一 |
| `currentQuoteId` | 当前正式报价；只指向本变更的报价 |
| `confirmedQuoteId` | 客户确认的精确报价版本；确认后不可替换 |
| `contractId` | 续期补充协议；同一变更最多一份有效合同 |
| `targetStartDate` / `targetEndDate` | 日期；开始日必须为源分段结束日次日 |
| `completionDeadlineAt` | 到期边界，即目标开始日当地 00:00 |
| `priceOverrideReason` | 原价/折扣模式必填 |
| `priceOverrideApprovedBy/At` | 原价/折扣审批记录 |
| `cancelReason` / `failureCode` / `failureMessage` | 终止原因 |
| `manualTakeoverReason/By/At` | 人工接管记录 |
| `version` | 乐观锁版本 |
| `createdBy/updatedBy/createdAt/updatedAt` | 标准审计字段 |

数据库约束：

- 同一订单只能存在一个活动变更。活动状态为 `DRAFT`、`QUOTED`、`CUSTOMER_CONFIRMED`、`SIGNING_OR_PAYMENT`、`SCHEDULED`、`EXECUTING`、`MANUAL_TAKEOVER`；通过 PostgreSQL 部分唯一索引保证。
- `targetEndDate >= targetStartDate`，`extensionMonths > 0`。
- `confirmedQuoteId` 一旦写入不得更新。
- `SCHEDULED` 之前不得存在续期分段；`SCHEDULED` 必须同时有关联的已归档合同和分段。

### 5.3 `SubscriptionChangeQuote`

报价采用追加式版本，不覆盖旧快照。任何重新报价都会创建新记录，并把旧正式报价标记为 `SUPERSEDED`。

核心字段：

| 字段 | 约束与语义 |
| --- | --- |
| `id` / `quoteNo` | UUID；业务编号唯一 |
| `changeOrderId` | 所属变更 |
| `revision` | 从 1 递增；`(changeOrderId, revision)` 唯一 |
| `status` | 报价状态 |
| `pricingMode` | 定价模式快照 |
| `productId/productVersionId/subscriptionPlanId` | 报价所用主数据引用，可为空但快照必填 |
| `monthlyFeeAmount/depositAmount` | 分为单位；续期默认不新增押金，金额为 0，除非将来另行设计 |
| `mileageLimitKm/overMileageFeeAmount` | 套餐事实快照 |
| `energyLimitKwh/energyLimitCount` | 套餐事实快照 |
| `planSnapshot` / `priceRuleSnapshot` / `quoteSnapshot` | 完整不可变 JSON 快照 |
| `validUntil` | 不得晚于完成期限 |
| `formalizedAt/confirmedAt/rejectedAt` | 状态时间 |
| `createdBy/createdAt` | 审计字段；记录不软删除 |

规则：

- 客户确认请求必须携带 `quoteId` 和客户端看到的 `revision`。
- `confirmedQuoteId` 必须指向 `CUSTOMER_CONFIRMED` 报价；确认后不允许重新报价，只能取消本变更并新建。
- 所有金额以分存储，前后端均不得使用浮点金额。

### 5.4 `SubscriptionContractSegment`

合同分段是账单、权益和有效履约结束日的权威事实。

核心字段：

| 字段 | 约束与语义 |
| --- | --- |
| `id` / `segmentNo` | UUID；业务编号唯一 |
| `orderId` | 原订单 |
| `segmentType` | `BASE` 或 `EXTENSION` |
| `sequenceNo` | 从 1 递增；`(orderId, sequenceNo)` 唯一 |
| `status` | 分段状态 |
| `startDate/endDate` | 含首尾的日期区间 |
| `sourceContractId` | BASE 指主合同，EXTENSION 指补充协议 |
| `sourceChangeOrderId` | EXTENSION 必填且唯一 |
| `productId/productVersionId/subscriptionPlanId` | 当时主数据引用 |
| `monthlyFeeAmount` | 分段月租金额快照 |
| `mileageLimitKm/overMileageFeeAmount` | 分段里程权益快照 |
| `energyLimitKwh/energyLimitCount` | 分段能源权益快照 |
| `planSnapshot/quoteSnapshot/contractSnapshot` | 不可变业务快照 |
| `activatedAt/completedAt/cancelledAt` | 生命周期时间 |
| `createdAt/createdBy` | 审计字段；已生效分段不软删除 |

约束：

- 一个订单恰有一个 `BASE` 分段；首次进入续期域时从原订单及主合同幂等引导创建。
- BASE 使用原订单 `startDate/endDate`、月租和最终套餐快照。原日期缺失或主合同事实不一致时不得猜测，创建数据一致性异常并进入人工接管。
- 相邻有效分段必须连续：下一段 `startDate = previous.endDate + 1 day`；不得重叠或留空档。
- 同一订单同一日期最多命中一个非取消分段；使用事务锁、相邻校验和数据库排斥/唯一约束组合保障。
- EXTENSION 仅在补充协议签署并归档成功的同一事务内创建。

`resolveEffectiveServiceEndDate(orderId)` 返回该订单最新非取消分段的 `endDate`；尚未引导创建 BASE 时只读兼容回退到 `SubscriptionOrder.endDate`，写流程必须先完成 BASE 引导。

### 5.5 `RenewalConsideration` 与提醒记录

每个有效合同分段唯一对应一个续订考虑期：

| 字段 | 语义 |
| --- | --- |
| `id` / `considerationNo` | 主键与业务编号 |
| `orderId` / `segmentId` | 订单与当前末段；`segmentId` 唯一 |
| `status` | 考虑期状态 |
| `decision` / `decidedAt` | 客户决定 |
| `changeOrderId` | 选择续订后创建/关联的 V2 变更 |
| `considerationStartAt` | 分段结束前 30 天当地 09:00 |
| `completionDeadlineAt` | 分段结束日次日当地 00:00 |
| `expiredAt/cancelledAt` | 终态时间 |
| `version` | 乐观锁 |

`RenewalReminder` 以 `(considerationId, slot)` 唯一，保存计划时间、状态、通知事件、模板代码快照、发送结果及失败原因。站内信与短信分别记录渠道结果，不以其中一个渠道成功掩盖另一个渠道失败。

### 5.6 自动任务关联

复用现有 `SubscriptionAutomationJob` 的租约、重试和幂等执行底座，并新增可空外键 `changeOrderId`、`contractSegmentId`、`renewalConsiderationId`。每个任务必须至少关联 `orderId`，并按任务类型关联相应的变更、分段或考虑期；不能只在无约束 JSON payload 中保存业务对象 ID。

新增索引：

- `(changeOrderId, createdAt)`；
- `(contractSegmentId, createdAt)`；
- `(renewalConsiderationId, createdAt)`；
- 保留全局唯一 `idempotencyKey` 和现有 `(jobStatus, availableAt)` 调度索引。

任务 payload 仅保存执行输入快照，不作为当前状态真相。执行前必须通过外键重新读取领域对象并重新校验状态和期限。

## 6. 时间、期限与日界线

- 业务时区固定为 `Asia/Shanghai`，日期字段使用 PostgreSQL `date`，任务时间使用 `timestamptz`。
- 某分段 `endDate = 2026-09-02` 时，客户可履约至 2026-09-02 23:59:59.999（上海时间）。
- 续期生效日是 2026-09-03，完成期限是 2026-09-03 00:00:00（上海时间）。
- “续期完成”要求在期限前同时满足：所有必需签署方完成签署、平台盖章完成、签后文件下载并归档成功、EXTENSION 分段事务提交成功。仅取得签名但未归档不算完成。
- 到期处理任务与电子签回调竞争时，二者必须锁定同一 `SubscriptionChangeOrder`、`RenewalConsideration` 和末分段，并按数据库提交顺序判定。期限前已经成功提交归档事务的续期获胜；期限时仍未提交的，到期任务将变更标为 `FAILED`、考虑期标为 `EXPIRED`。其后迟到回调只归档为证据，不得创建分段或重新激活订单。
- 所有边界比较使用服务器生成的当前时间，不接收客户端传入“当前时间”。

## 7. 生命周期与状态转换

### 7.1 续期变更

正常路径：

```text
DRAFT
  -> QUOTED
  -> CUSTOMER_CONFIRMED
  -> SIGNING_OR_PAYMENT
  -> SCHEDULED
  -> EXECUTING
  -> COMPLETED
```

说明：

- `DRAFT`：运营已选择月份、套餐和定价模式。
- `QUOTED`：正式报价已生成且在有效期内。
- `CUSTOMER_CONFIRMED`：客户确认精确报价版本。
- `SIGNING_OR_PAYMENT`：生成补充协议并进入电子签。首批续期无新增押金或提前收款，但保留状态名称以兼容后续有支付条件的变更。
- `SCHEDULED`：补充协议签署归档完成，未来 EXTENSION 分段已创建。
- `EXECUTING`：到达生效日，执行账单/权益/状态衔接。
- `COMPLETED`：衔接任务全部完成。

异常路径：

- 客户拒绝、运营撤回或在允许阶段取消：`CANCELLED`。
- 超过期限、合同拒签或不可恢复校验失败：`FAILED`。
- 数据不一致或自动任务达到最大重试次数：`MANUAL_TAKEOVER`；人工只能重试既有安全动作或取消，不能绕过签署与期限。
- `SCHEDULED` 后不得直接取消。需另行创建正式合同变更，本次不实现。

### 7.2 续订考虑期

```text
PENDING_DECISION
  -> RENEWAL_REQUESTED -> EXTENSION_IN_PROGRESS -> EXTENDED
  -> EXPIRY_CONFIRMED -> EXPIRED
  -> EXPIRED（未答复或续期未按期完成）
```

- 客户点击“申请续订”时，以幂等事务创建或关联 V2 续期变更，状态转为 `RENEWAL_REQUESTED`，形成正式报价后转为 `EXTENSION_IN_PROGRESS`。
- 客户点击“到期结束”时转为 `EXPIRY_CONFIRMED`，取消尚未发送的提醒并提前准备退车；合同仍正常履行至原到期日。
- EXTENSION 分段归档创建后转为 `EXTENDED`，取消到期和退车预备任务。
- 未答复，或已申请但补充协议未在期限前归档，均转为 `EXPIRED`。

## 8. 续期定价

### 8.1 当前版本价格 `CURRENT_VERSION`

- 运营选择当前处于 ACTIVE 的产品版本和订阅套餐。
- 复用现有正式报价计算器和价格规则。
- 车辆已出租不参与可售库存校验，但车型、业务类型和套餐适配仍必须通过。
- 报价快照记录规则、输入、输出和版本。

### 8.2 原价格 `ORIGINAL_PRICE`

- 使用当前合同末分段的月租、权益和套餐快照，即使原套餐主数据已经停用也可以读取快照。
- 必须填写原因并由具有 `subscription_change:price_override_approve` 权限的用户审批。
- 审批人不得与报价提交人相同；服务端强制职责分离。

### 8.3 已审批折扣 `APPROVED_DISCOUNT`

- 先按当前版本规则计算基准价，再输入折后月租。
- 折后金额必须大于 0 且不高于当前报价基准金额。
- 必须填写原因并经过同样的价格例外审批和职责分离。

三种模式都不得修改已确认报价；改变月份、套餐或金额必须在客户确认前生成新 revision。

## 9. 合同与电子签

- 新增并强制使用 `ContractTemplateType.SUBSCRIPTION_EXTENSION`，模板管理、审批和有效期规则沿用现有机制。
- 续期合同生成器只查询业务类型匹配、模板类型为 `SUBSCRIPTION_EXTENSION`、状态 ACTIVE 且在生成日有效的版本。不得回退到主合同或交接确认单模板。
- 合同快照至少包含原合同编号、订单编号、原到期日、续期起止日期、续期月数、定价模式、月租、套餐及权益摘要、双方信息和确认报价编号。
- 新合同继续保存到现有 `Contract` 表，但通过 `SubscriptionChangeOrder.contractId` 和专用模板类型明确归属；不得更新 `SubscriptionOrder.contractId`。
- 电子签使用 `STAGE3_SUBSCRIPTION_EXTENSION` 和 `SUBSCRIPTION_EXTENSION_AGREEMENT`，签署者、平台盖章、回调验签和文件归档复用现有底座。
- 只有合同状态为 `ARCHIVED` 且签后文件对象可读取，才能在同一数据库事务中创建 EXTENSION 分段并将变更置为 `SCHEDULED`。
- 重复回调依赖现有 `(provider, payloadHash)` 唯一约束，并增加“一个 change 只能创建一个 segment”的唯一约束。
- 迟到回调保存签名和文件证据，合同可标注“逾期归档/不生效”，但不得改变已到期业务状态。

## 10. 账单、权益、支付与代扣衔接

### 10.1 月租账单

- 替换账单协调器中直接读取 `order.endDate` 和 `order.monthlyFeeAmount` 的逻辑。
- 每个账期按 `periodStart` 命中唯一有效合同分段，并从该分段读取月租和套餐快照。
- 不允许一个月租账期跨越两个分段。因为续期开始日紧接原分段结束日且现有月度锚点不变，若历史日期导致账期跨段则进入人工接管，不做按日拆分。
- 已因原合同结束而 `COMPLETED` 的 BillingSchedule，在续期归档时可预排恢复任务；到生效日安全恢复为 ACTIVE，保留 `nextCycleNo` 和月度锚点，不重生成历史账单。
- 月租账单 `sourceKey` 和任务幂等键继续包含订单、cycle、periodStart；同时在账单快照记录 `contractSegmentId`、报价与套餐版本。
- 续期未完成或到期结束后，不生成 `periodStart > effectiveServiceEndDate` 的账单。

### 10.2 权益

- 每一新账期按命中分段的套餐快照生成月度权益。
- 权益任务幂等键包含订单、分段、权益类型和账期；重复执行不重复发放。
- 到期任务关闭权益账户未来续发；已发生的历史权益和使用记录不变。

### 10.3 支付与代扣

- 已生成且合法的应收账单继续按原支付、代扣、重试和逾期规则处理，不因续期流程暂停。
- 到期后不再创建新月租账单，因此也不得为不存在的新账单创建扣款任务。
- 已处于 ACTIVE 的 `PaymentMandate` 可以保持授权状态，本次不自动撤销；后续是否在终止订单时撤销属于独立策略。
- 续期流程失败不得取消已有账单、核销、催收案件或支付委托。

## 11. 到期结束与退车

在完成期限到达且没有有效 EXTENSION 分段时，到期任务以单一事务执行：

1. 锁定末分段、考虑期、活动变更、订单、Lease 和退车记录。
2. 将末分段标记为 `COMPLETED`。
3. 将考虑期标记为 `EXPIRED`；仍在进行的续期变更标记为 `FAILED`，错误码为 `EXTENSION_DEADLINE_MISSED`。
4. 将订单置为 `PENDING_RETURN`，Lease 置为 `RETURN_DUE`。
5. 将 BillingSchedule 标记为 COMPLETED，并取消所有会生成到期后账单、权益或扣款的未执行任务。
6. 幂等创建或复用该订单唯一的 `VehicleReturn`，类型 `NORMAL_RETURN`、状态 `PENDING`。
7. 保持车辆 `LEASED`，禁止库存分配，直至实体退车确认。
8. 向客户和运营发送到期退车站内通知，并按配置尝试短信。

到期后 D+1 仍未完成退车时创建“逾期未退车”异常通知/运营任务，每日汇总可见，但首批不自动生成占用费、留车费或新合同。费用处理需另行批准设计。

退车确认沿用既有流程：确认后写入不可变退车里程档案，更新车辆状态，并将订单/Lease 转为现有最终状态。到期任务不得伪造实际退车时间。

## 12. 通知与提醒

### 12.1 时间表

提醒在上海时间 09:00 计划：

- D-30：进入考虑期，说明续订和到期退车两种选择；
- D-14：未决定或续期未完成时提醒剩余时间；
- D-3：最终提醒，明确未完成签署归档将按期退车；
- 到期：合同结束和退车通知；
- D+1：尚未退车的异常提醒给运营，并可通知客户。

三次提醒均使用同一考虑期事实和各自唯一 slot。客户明确选择到期结束后取消剩余营销式提醒；仍保留必要的到期退车通知。续期成功后取消全部续期及退车预备提醒。

### 12.2 模板配置

环境变量：

```text
RENEWAL_REMINDER_D30_TEMPLATE_CODE
RENEWAL_REMINDER_D14_TEMPLATE_CODE
RENEWAL_REMINDER_D3_TEMPLATE_CODE
RENEWAL_EXPIRY_RETURN_TEMPLATE_CODE
RENEWAL_RETURN_OVERDUE_D1_TEMPLATE_CODE
```

短信变量至少支持订单号、车牌号、原到期日、剩余天数和 Portal 入口。敏感信息按现有通知规则脱敏。

模板未配置或供应商发送失败时：

- 站内信仍可独立成功；
- 短信渠道结果必须是 FAILED/CONFIG_MISSING，并显示在运营台；
- 不得记录为已发送，不得因短信失败回滚续期业务事务；
- 提供有权限的安全重试，沿用相同 reminder slot 和通知幂等键。

## 13. API 设计

### 13.1 Admin

统一前缀 `/api/subscription-changes`：

| 方法与路径 | 作用 |
| --- | --- |
| `POST /extensions` | 为订单创建续期草稿 |
| `POST /:id/quotes/preview` | 无写入试算 |
| `POST /:id/quotes` | 创建新的正式报价 revision |
| `POST /:id/price-override/approve` | 审批原价/折扣例外 |
| `POST /:id/submit-customer-confirmation` | 发布到 Portal 等待客户确认 |
| `POST /:id/contracts` | 使用专用模板生成补充协议 |
| `POST /:id/esign/start` | 发起电子签 |
| `POST /:id/esign/retry` | 重试安全的电子签动作 |
| `POST /:id/jobs/:jobId/retry` | 重试自动任务 |
| `POST /:id/manual-takeover` | 管理员人工接管 |
| `POST /:id/cancel` | 在允许阶段取消并记录原因 |
| `GET /:id` | 变更、报价、合同、分段和任务详情 |
| `GET /:id/timeline` | 审计时间线 |
| `GET /orders/:orderId` | 订单的 V2 变更及合同分段 |

续订考虑期 Admin API：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/renewal-considerations` | 列表和筛选 |
| `GET /api/renewal-considerations/:id` | 详情、提醒和关联变更 |
| `POST /api/renewal-considerations/:id/reminders/:slot/retry` | 重试失败提醒 |
| `POST /api/renewal-considerations/:id/reconcile` | 安全重算/修复计划，不改变客户决定 |

所有写接口支持 `Idempotency-Key`，并校验 `version` 防止并发覆盖。状态不允许时返回 409，校验失败返回 400，权限不足返回 403；不得使用 500 表达业务冲突。

### 13.2 Portal

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/portal/renewal-considerations` | 当前客户的考虑期列表 |
| `GET /api/portal/renewal-considerations/:id` | 决策、期限和进度 |
| `POST /api/portal/renewal-considerations/:id/decision` | 提交 RENEW 或 EXPIRE |
| `GET /api/portal/subscription-changes/:id` | 报价、合同和分段详情 |
| `POST /api/portal/subscription-changes/:id/quote/confirm` | 确认精确报价 revision |
| `POST /api/portal/subscription-changes/:id/quote/reject` | 拒绝报价并填写原因 |
| `POST /api/portal/subscription-changes/:id/sign-url` | 获取有效签署入口 |
| `GET /api/portal/orders/:orderId/contract-segments` | 原合同与续期分段展示 |

Portal 只按登录客户和订单归属授权，不接受 customerId 越权查询。

## 14. 页面与操作引导

### 14.1 Admin

- 新增“合同变更中心”，首批只展示“协议延长”。
- 订单工作台同时展示“原合同到期日”和“已签约至”，不得用新日期覆盖旧日期。
- 合同变更 tab 展示变更状态、下一步动作、当前报价、补充协议、任务失败原因和安全重试。
- 续订考虑期列表支持按剩余天数、客户决定、续期进度、短信失败和退车逾期筛选。
- 原价和折扣审批必须在独立审批动作中展示基准价、拟议价格、差额、原因和提交人。
- 人工接管页只能执行已定义的恢复动作，不提供直接修改状态、日期或分段的万能按钮。

### 14.2 Portal

- “我的申请”在 D-30 起持续展示续订卡片，直至 `EXTENDED` 或 `EXPIRED`。
- 首屏明确显示当前合同到期日、续订完成期限、“申请续订”和“到期结束”两个互斥选择。
- 申请续订后按顺序引导：查看报价 -> 确认/拒绝 -> 查看补充协议 -> 去签署 -> 等待归档 -> 续期完成。
- 到期结束后展示退车准备和退车进度，不再展示续订营销按钮。
- 合同详情提供原合同和已签补充协议 PDF 的查看/下载入口。
- 错误文案区分业务期限已过、报价已更新、签署服务失败和系统重试中。

## 15. 权限与职责分离

新增权限：

```text
subscription_change:view
subscription_change:create
subscription_change:quote
subscription_change:price_override_approve
subscription_change:submit
subscription_change:esign_retry
subscription_change:execute
subscription_change:manual_takeover
subscription_change:cancel
```

角色分配：

| 角色 | 权限 |
| --- | --- |
| ADMIN | 全部权限 |
| OP | view/create/quote/submit/esign_retry/execute/cancel |
| SA / AS | view |

原价/折扣审批和人工接管仅 ADMIN。价格例外审批还需校验审批人与报价提交人不同。权限必须同步更新后端守卫、共享认证常量、种子、菜单和前端动作守卫；种子更新后用户需重新登录取得新权限声明。

## 16. 自动任务、幂等与并发

新增或扩充任务类型：

- `RENEWAL_CONSIDERATION_ENROLL`
- `RENEWAL_REMINDER_D30/D14/D3`
- `RENEWAL_EXPIRY_PROCESS`
- `RENEWAL_RETURN_OVERDUE_D1`
- `EXTENSION_SEGMENT_ACTIVATE`
- `EXTENSION_BILLING_RESUME`
- `EXTENSION_ENTITLEMENT_RENEW`
- `EXTENSION_INSURANCE_VALIDATION`
- `EXTENSION_EFFECTIVE_NOTICE`

幂等键示例：

```text
renewal-consideration:{segmentId}
renewal-reminder:{considerationId}:{slot}
renewal-expiry:{segmentId}:{endDate}
renewal-return-overdue:{orderId}:{endDate}:D1
extension-segment:{changeOrderId}
extension-activate:{segmentId}:{startDate}
extension-billing-resume:{orderId}:{segmentId}
extension-entitlement:{orderId}:{segmentId}:{periodStart}:{type}
```

执行要求：

- worker 使用现有租约、重试和最大尝试机制；进程重启后可继续。
- 状态转换在数据库事务内以 `SELECT ... FOR UPDATE` 锁定订单、末分段、变更和考虑期。
- 关键写入同时依赖数据库唯一约束；不能只靠应用层“先查再写”。
- 外部调用使用 outbox/任务记录，数据库事务不等待短信或电子签网络请求。
- 重试前重新读取当前状态；已决定、已续期或已到期的任务安全跳过并记录原因。
- 保险有效期不足以覆盖续期分段时，在合同生成前阻塞并进入可见异常，不自动伪造保单延长。

## 17. 审计与可观测性

以下动作必须写入结构化审计日志：

- 创建、报价、重新报价、客户确认/拒绝；
- 原价/折扣审批；
- 合同生成、发起签署、回调、归档和迟到回调；
- 分段创建、激活、完成；
- 客户续订/到期决定；
- 每次提醒的计划、发送、失败、重试和跳过；
- 到期状态切换、退车记录创建；
- 自动重试、人工接管、取消和失败。

审计保存操作者、来源、前后状态、业务编号、关联对象、幂等键、时间、原因和脱敏后的结果，不保存明文身份证号或供应商密钥。

运营指标至少包括：进入考虑期订单数、续订申请率、报价确认率、期限前归档率、到期退车率、提醒发送成功率、失败任务数、人工接管数、迟到回调数和分段一致性异常数。

## 18. 迁移、引导与数据核对

### 18.1 数据库迁移

- 只使用增量 Prisma migration，新库和存量库都必须通过。
- 先新增枚举、表、外键和普通索引，再用 SQL 建立 Prisma 无法表达的部分唯一/排斥约束。
- 不修改历史 migration，不重置环境数据库。
- 合同、订单、Lease 的新反向关系在同一 schema 变更中补齐。

### 18.2 BASE 分段引导

- 不对所有历史订单盲目写入。
- 功能开启前运行只读预检，列出 ACTIVE、PENDING_RETURN 和近期到期订单的日期、主合同、套餐和账单锚点一致性。
- 对满足 `startDate/endDate`、主合同已归档、套餐快照完整的有效订单幂等创建 BASE。
- 不满足条件的订单进入数据一致性异常清单，禁止发起续期，人工核对后通过受控修复工具引导。
- 已完成或取消的历史订单默认不引导，仍通过兼容只读视图展示原日期。

### 18.3 考虑期补录

功能启用时：

- 距离有效结束日大于 30 天的订单等待正常 D-30 任务。
- 已进入 30 天窗口但尚未到期的订单立即创建考虑期，只发送“当前时点最新适用”的一条提醒；更早 slot 标记 `SKIPPED_LATE_ENROLLMENT`，禁止一次性发送三条短信。
- 已到期订单不补建续期机会，只进入到期/退车数据核对。
- 已存在未来有效 EXTENSION 分段的订单不创建针对旧分段的到期任务。

### 18.4 一致性巡检

每日巡检：

- 有效分段是否连续、无重叠且只有一个 ACTIVE；
- `SCHEDULED` 变更是否存在归档合同和唯一 EXTENSION 分段；
- 账单账期命中的分段与账单快照是否一致；
- 到期订单是否仍存在未来账单、权益或扣款任务；
- PENDING_RETURN 是否有唯一未完成退车记录；
- 提醒 slot 是否重复或与客户决定冲突。

巡检只报警和创建修复任务，不自动改写合同或金额事实。

## 19. 配置、发布与回滚

功能开关：

```text
SUBSCRIPTION_EXTENSION_ENABLED=false
```

默认关闭。发布顺序：

1. 备份并执行数据库迁移；
2. 部署 API/Web，保持开关关闭；
3. 等待容器 healthy 并执行公网健康检查；
4. 运行 BASE 预检、引导和一致性报告；
5. 配置并验证五个短信模板及续期合同模板；
6. 在 staging 开启开关，执行沙盒/真实验收；
7. 生产先对内部白名单订单开启，再逐步扩大。

回滚：

- 关闭开关，禁止新建续期和新考虑期；
- 保留数据库新增表和枚举，避免破坏已签合同和分段；
- 已 `SCHEDULED` 的续期由兼容 worker 继续执行或进入人工接管，不得因应用回滚删除；
- 已生成的合同、通知、报价和审计均保留；
- 回滚前后都运行分段、账单和到期任务巡检。

## 20. 验收标准

### 20.1 正常续期

- 当前版本价格可完成报价、客户确认、专用补充协议签署归档和未来生效。
- 原价格只有经过独立审批才能提交客户。
- 折扣金额必须合法且经过独立审批。
- 重新报价产生新 revision，客户不能确认过期 revision。
- 客户拒绝和允许阶段取消均保留完整历史且不影响原合同。
- 补充协议只选用 `SUBSCRIPTION_EXTENSION` 模板，无法错误选择主合同或交接模板。
- 重复/乱序回调不重复创建合同分段；迟到回调不恢复到期订单。
- 续期分段与 BASE 连续无重叠，原 `SubscriptionOrder.endDate`、主合同和原报价均不变。
- 到生效日后账单计划保留 cycle 与锚点，按新分段金额生成账单。
- 活动支付、代扣、重试和逾期流程在续期前后正常工作。
- 权益按新分段套餐幂等续发。
- worker 重启后所有待办任务继续执行，不产生重复账单、提醒或分段。

### 20.2 到期与续订考虑期

- D-30、D-14、D-3 各提醒最多发送一次，并能在页面查看独立渠道结果。
- 客户选择到期结束后停止后续续订提醒，并在到期创建/复用退车任务。
- 客户未答复时，到期自动转 `PENDING_RETURN` / `RETURN_DUE`，无留车期。
- 客户申请续订但补充协议未在期限前归档时同样转入退车。
- 续期在期限前归档后取消到期任务与退车预备任务。
- 回调与到期任务在边界并发时只有一个合法结果，且可通过审计还原。
- 到期后不生成新的月租账单、权益或扣款任务，既有应收仍可支付和催收。
- D+1 未退车产生异常任务但不自动计费。
- 逾期退车期间车辆仍为 LEASED，不能重新分配。

### 20.3 迁移与安全

- 全新数据库可从零执行完整 migration 和 seed。
- 存量数据库可增量迁移，不重置数据。
- 窗口内存量订单只收到一条当前适用提醒，旧 slot 正确标记跳过。
- 缺少日期、主合同或套餐快照的订单被阻止续期并进入人工异常，不被猜测修复。
- 短信模板缺失时明确失败且可重试，不能显示假成功。
- 未授权用户无法报价、审批、重试、人工接管或查看他人 Portal 数据。
- 所有关键操作、失败和人工动作均能在审计时间线追溯。

## 21. 后续扩展边界

本纵切稳定后，`SubscriptionChangeOrder` 可扩展提前结束、套餐变更和换车；扩展时必须为每种变更单独定义报价事实、合同类型、执行副作用和冲突矩阵，不得复用续期状态绕过审批。

到期后收费、支付委托自动撤销、留车法律处理和更复杂的续期产品属于后续独立设计，不能通过修改本设计中的到期边界暗中启用。
