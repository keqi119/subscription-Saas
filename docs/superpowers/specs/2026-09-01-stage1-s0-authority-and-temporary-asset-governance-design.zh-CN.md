# Stage 1 S0 原子事实权威与临时资产治理规格

日期：2026-09-01

状态：待评审

基线提交：`2b96822dddcf4221142caa0c3993449ba6b98978`

上位决策：[Stage 1 收敛治理主 ADR](./2026-09-01-stage1-convergence-governance-adr.zh-CN.md)

## 目的

S0 在任何 S1/S2 施工前明确：

1. 每个原子业务事实的唯一权威；
2. Journey、运营状态和页面状态的投影边界；
3. 激活前置事实、原子写入、同步运营投影和后置编排投影；
4. 激活成功与重放所需的完整不变量；
5. Closure、Billing 和 Payment 的权威边界；
6. 临时资产的分类、登记、启用和退出规则。

本规格不授权业务代码、数据库、功能开关、数据或部署修改，也不批准 S1/S2 实施计划。

## 基本术语

### 权威事实

能够独立证明一个原子业务命题的持久化领域事实。其他服务不得使用自己的状态反向覆盖或替代该事实。

### 同步运营投影

为列表、筛选、权限判断或运营操作提供的派生状态。投影可以在领域事务内同步维护，但不能反向证明权威事实。

### 编排投影

Journey 中的 Step、Job、ManualTask、Exception 和当前步骤状态。它们证明流程执行位置、等待和技术处理情况，不证明合同、支付、交付或车辆占用已经发生。

### 完整不变量

一个业务动作被视为成功或幂等重放前必须同时成立的事实集合。只检查其中一个或几个展示状态不构成完整重放。

## 原子事实权威矩阵

| 原子命题                                           | 唯一权威                                                                                                                 | 非权威投影或禁止替代                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 客户已提交进件、材料版本、审核结论和当前客户意图   | `Application` 及其冻结提交/审核事实                                                                                      | Journey 当前步骤、页面标签不得替代                                                                             |
| 报价内容、产品/价格版本和报价状态                  | `SubscriptionQuote`                                                                                                      | Application/Order 快照和 Journey “方案完成”不得替代报价原始事实                                                |
| 已发布最终方案及客户确认的精确版本                 | Application 的最终方案快照、商业哈希、确认修订和确认时间                                                                 | Order 展示字段、Quote 当前状态和 Journey “方案完成”不得替代；最终方案必须引用其来源 Quote                      |
| 审核期软预约的 owner、建立时间和到期时间           | `Application.softReservedVehicleId/softReservedAt/softReservationExpiresAt`                                              | `Vehicle.REVIEW_RESERVED`、Journey 手工任务或页面选择值不能证明预约 owner                                      |
| 车辆预约排他门槛是否已同步占位                     | 对 `Vehicle.status` 的行锁与 CAS；`REVIEW_RESERVED/RESERVED` 只表达同步排他状态                                          | Vehicle 状态不能证明预约 owner，也不能取代 Application/Order 的来源事实                                        |
| 车辆基础档案及与特定订单无关的准备、维护和退役决定 | `Vehicle`，并由资产运营命令及其审计事实约束                                                                              | `REVIEW_RESERVED/RESERVED/LEASED/RENTED/RETURNED/AVAILABLE` 不得脱离预约、期间、取回和限制事实作为独立业务证明 |
| 订单存在、商业关系绑定和激活前生命周期决定         | `SubscriptionOrder` 的身份、Application/Quote/Customer/Product/Vehicle 绑定及激活前状态；激活前取消/拒绝须有对应审计事实 | `PENDING_*` 状态不能证明合同归档、付款、车辆预约或交付已经发生                                                 |
| 订单已经激活                                       | `Lease.ACTIVE`、唯一开放 `VehicleSubscriptionPeriod` 及其共同的权威激活来源                                              | `Order.ACTIVE`、`Vehicle.LEASED` 和 `VehicleDelivery.DELIVERED` 是同步运营投影                                 |
| 在租后的待退回、已退回待结算等运营阶段             | `VehicleReturn`、Closure、Lease/Period 和限制事实的相应转换                                                              | `Order.SUSPENDED/PENDING_RETURN/RETURNED_PENDING_SETTLEMENT` 只是聚合投影，不能单独证明底层转换                |
| 订单正常完成或提前终止                             | Closure 终态、已结束 Lease/Period、车辆取回及库存释放事实的完整组合                                                      | `Order.COMPLETED/TERMINATED` 和 `Vehicle.AVAILABLE/RETURNED` 是结果投影                                        |
| 合同文本、条款和不可变文档版本                     | `ContractVersion`                                                                                                        | 当前 Contract 状态、ESignTask 或页面快照不得覆盖历史版本                                                       |
| 平台接纳的当前合同状态、归档文件指针和激活准入     | `Contract` 及其当前版本/归档文件引用                                                                                     | `ESignTask` 状态不能反向替代 Contract；`ARCHIVED` 在本规格中不宣称法律生效时点                                 |
| 电子签供应商交互、签署人、回调和任务执行状态       | `ContractESignTask` 及签署人/回调事实                                                                                    | Contract 不替代供应商交互历史；供应商“已完成”不自动等于平台已接纳归档                                          |
| 应收项目、金额、到期日、未结余额和账单状态         | `ReceivableBill`/Billing 领域                                                                                            | Closure 试算、Journey 账单步骤不得替代                                                                         |
| 渠道支付发起、渠道状态和已验证回调                 | `PaymentOrder` 与已验证的 `PaymentCallbackLog`                                                                           | `PaymentRecord`、Bill、Closure 或 Journey 不得覆盖渠道交互与回调历史                                           |
| 平台接纳的到账事实，包括人工确认付款               | 状态为已确认的 `PaymentRecord` 及其来源证明                                                                              | PaymentOrder “支付成功”、Bill `PAID` 或 Closure `settledAt` 不能单独证明平台已接纳到账                         |
| 确认资金对具体应收的核销分配                       | `PaymentWriteOff` 及其关联的已确认 Payment                                                                               | Bill `PAID` 必须可追溯到足额核销；Closure `settledAt` 不得替代                                                 |
| Stage2 实际交付时间                                | 已完成且权威校验通过的 `VehicleDeliveryHandover.completedAt`                                                             | `VehicleDelivery.deliveredAt`、Order `actualDeliveryAt` 是派生投影                                             |
| 现场交接任务执行、运营复核和客户意见               | `VehicleHandoverWorkOrder`、ReviewAttempt 和 Event 事实                                                                  | Journey、Order 或页面状态不得替代工作流历史                                                                    |
| 单项交接证据、原始文件和签署交接文档               | `VehicleDeliveryEvidenceItem`、`VehicleDeliveryEvidenceFile` 及 Handover 归档文件引用                                    | WorkOrder 汇总状态、Journey 或 Closure 摘要不得覆盖原始证据                                                    |
| 车辆物理取回、返回时间和初始损伤记录               | `VehicleReturn`、`VehicleReturnDamage` 及受管 Return Checklist/Evidence 事实                                             | Closure 结算状态、Vehicle 库存状态或 Journey 不得替代物理取回证据                                              |
| 车辆被某订单占用的开放期间                         | `VehicleSubscriptionPeriod`                                                                                              | `Vehicle.LEASED` 和 Order `ACTIVE` 是运营投影                                                                  |
| 客户在租履约关系                                   | `Lease`                                                                                                                  | Order、Vehicle 或 Journey 状态不得代替 Lease                                                                   |
| 指定履约日期适用的合同计费与权益条款               | `SubscriptionContractSegment`                                                                                            | Order 当前字段、Quote 或变更单展示状态不得替代已生效分段                                                       |
| 结束责任、应结算金额、客户意见、争议和处置决定     | Closure 领域的 Case、SettlementRevision、CustomerResponse、Dispute、Disposition 和 LegalCollection 事实                  | Closure 不证明支付已完成；Billing/Payment 不决定法律责任或争议处置                                             |
| 流程调度、等待、重试、人工任务和技术异常           | `SubscriptionJourney` 及 Step/Job/Exception/Outbox                                                                       | Journey 不得成为合同、支付、交付、占用、Lease 或 Closure 的业务权威                                            |

### Vehicle 与 Order 聚合状态约束

`Vehicle.status` 不是所有车辆相关事实的统一权威：

- `DRAFT/IN_PREPARATION/MAINTENANCE/RETIRED` 表达与特定订阅订单无关的当前运营决定，但仍须保留相应资产运营命令和审计来源；
- `REVIEW_RESERVED/RESERVED` 是并发排他门槛。前者的 owner 来自有效 Application 软预约，后者的 owner 来自当前签约订单绑定；状态本身不携带 owner；
- `LEASED/RENTED` 由开放占用期间和 Lease 派生；
- `RETURNED` 由物理取回事实派生；`AVAILABLE` 只有在不存在有效预约、开放占用期间、未释放限制和未完成取回/整备事项时才能派生。

`SubscriptionOrder.orderStatus` 也不是所有履约事实的统一权威：

- Order 拥有订单身份、商业关系绑定、激活前状态，以及激活前取消/拒绝决定；
- 所有 `PENDING_*` 只表达订单工作阶段，不能证明对应 Contract、Payment、Vehicle 或 Handover 事实已经成立；
- `ACTIVE` 由权威激活事实派生；
- `SUSPENDED/PENDING_RETURN/RETURNED_PENDING_SETTLEMENT` 由对应 Lease、Return、Closure 和限制事实派生；
- `COMPLETED/TERMINATED` 只能由 Closure 终态、Lease/Period 结束及车辆释放的完整组合派生。

### 软预约复合事务不变量

当前 Schema 只为 `Application.softReservedVehicleId` 建立普通索引，没有数据库唯一约束。因此 S0 不宣称单个字段已经构成“同一车辆只有一个有效预约”的独立权威。

审核期软预约必须作为复合事务不变量处理：在同一事务中锁定目标 Vehicle，以数据库时间检查不存在另一条未删除、未拒绝、未取消且尚未到期的 Application 软预约，然后写入 Application 的 owner/时间/期限并 CAS 更新 Vehicle 排他状态。任一条件失败时不得留下单边写入。当前实现与该目标的符合性和并发缺口登记到“现状到目标偏差登记”，路由至 S2 转换 2；本规格不预先批准新增唯一约束或具体实现方案。

## Contract 与 ESign 边界

Contract 和 ESignTask 不是双权威，它们回答不同问题：

- ESignTask 回答“供应商交互进行到哪里、谁签署、回调是否接收”；
- Contract 回答“平台当前接纳哪一版合同、是否具有完整归档文件、该归档是否满足激活准入”。

S0 使用“平台激活准入事实”或“归档证据完整事实”描述 `Contract.ARCHIVED`。除非法务另行批准，不把数据库 `ARCHIVED` 枚举直接定义为法律生效时点。

供应商回调必须先经过平台接纳、文件校验和归档，才能改变 Contract 权威事实。Contract 投影不得删除或覆盖 ESignTask、签署人和回调历史。

## 激活事实分层

### 激活前置事实

激活事务必须按 S2 经批准并由并发契约测试固定的锁顺序重新读取并验证，但不得重写以下事实。S2 转换 4 必须先记录当前 `lockDeliveryConfirmationGateRows` 的锁定对象、顺序和调用基线，未完成基线记录前不得调整事务边界：

1. Order 仍绑定已确认最终方案修订和来源 Quote，商业哈希及关键快照不存在身份漂移；
2. Contract 满足平台激活准入：状态、归档时间、文件指针和文件对象完整；
3. 押金和首月租金的 ReceivableBill 已由确认支付/核销事实足额结清；
4. Vehicle 仍由本订单有效预约，且没有冲突占用；
5. Delivery 处于允许激活的准备状态，交付确认清单完整；
6. Stage2 Handover 已签署、已归档、具有签署文件，并存在非空 `completedAt`；
7. WorkOrder 已经运营审核通过，证据 Manifest 与归档 Handover 一致；
8. 交付里程存在；
9. Order、Vehicle、Delivery、Handover 和 WorkOrder 指向同一车辆及交付链；
10. 车辆在 `Handover.completedAt` 时点具有有效保险；
11. 所需车辆检测事实已通过。

以上任一条件不满足时，激活不得创建部分占用、Lease 或运营投影。

### 原子权威写入

以下权威事实必须在同一数据库事务中提交：

- 创建或确认唯一的 BASE `SubscriptionContractSegment`，其来源 Contract、方案/报价快照和起止日期与当前激活一致；
- 为当前订单、车辆、客户、合同分段开放唯一的 `VehicleSubscriptionPeriod`；
- 将当前订单的唯一 `Lease` 激活，且 `activatedAt` 等于权威 `Handover.completedAt`。

不得存在：

- 一个订单多个活动 Lease；
- 一个订单存在多个 BASE 合同分段或 BASE 分段与当前权威快照不一致；
- 一辆车多个重叠开放占用期间；
- Lease 激活而无对应开放占用期间；
- 占用期间开始时间与 Handover 完成时间不一致。

### 同步运营投影

以下字段可以与原子权威写入同事务更新，但只作为投影：

- `SubscriptionOrder.orderStatus = ACTIVE`；
- `SubscriptionOrder.actualDeliveryAt = Handover.completedAt`；
- `Vehicle.status = LEASED`；
- `VehicleDelivery.deliveryStatus = DELIVERED`；
- `VehicleDelivery.deliveredAt = Handover.completedAt`。

这些投影不得被其他流程独立写入为“修复权威事实”的手段。投影漂移时应从权威事实进行受控重建或进入人工接管。

### 下游初始化事实

现有激活事务还会初始化交付里程基线、首次里程复核、账单计划、权益账户和审计记录。

S0 不预先规定所有下游初始化都必须留在激活事务内，也不授权将其移出。S2 对每一项必须选择并证明一种一致性模型：

1. **同事务强不变量**：缺失时业务激活整体失败；或
2. **Outbox 最终一致投影**：业务激活提交一个持久事件，下游可幂等补建，且缺失时不会被误报为完成。

选择依据必须是领域语义，而不是减少代码行数。无论选择哪一种，完整激活重放都必须检测并恢复缺失的下游事实，不能静默返回成功。

### 后置编排投影

Journey 的激活步骤完成不属于业务激活权威写入。

目标模型为：

1. 激活事务完成权威事实和必要同步投影；
2. 同一事务写入持久 Outbox 事件；
3. 事务提交后，Journey 消费事件并幂等完成激活步骤；
4. Journey 投影失败不得回滚已经提交的权威激活；
5. 未投影事件必须可重试、可观察并可人工接管。

当前代码在激活事务内直接完成 Journey 步骤。S2 若调整该事务边界，必须单独评审并覆盖锁顺序、事件丢失恢复、并发、幂等和审计兼容。

## 激活完成与重放完整不变量

当前 `isCompletedActivationReplay` 只检查 Order、Delivery 和 Vehicle 三个投影，不能证明完整激活。

S2 修改重放逻辑前，必须以以下不变量作为最低契约：

### 权威事实不变量

- 激活前置事实仍可追溯且不存在身份漂移；
- Lease 唯一、状态为 `ACTIVE`，`activatedAt` 等于 Handover `completedAt`；
- BASE ContractSegment 唯一，来源 Contract、方案/报价快照和起止日期与激活一致；
- 存在唯一匹配的开放 `VehicleSubscriptionPeriod`；
- 期间关联同一 order、vehicle、customer、contract 和 base segment；
- 不存在冲突活动 Lease 或重叠车辆占用期间。

### 投影一致性不变量

- Order 为 `ACTIVE`；
- Vehicle 为 `LEASED` 且仍属于该 Order；
- VehicleDelivery 为 `DELIVERED`；
- Order `actualDeliveryAt` 和 VehicleDelivery `deliveredAt` 均等于 Handover `completedAt`。

### 下游初始化不变量

- 权威交付里程基线存在且来源指向当前 Handover/Delivery；
- 账单计划已创建，或者存在未完成但可恢复的权威 Outbox 事件；
- 初始权益已创建/激活，或者存在未完成但可恢复的权威 Outbox 事件；
- 审计记录能够引用 Lease、Period、Order、Vehicle、Delivery 和权威 Handover 时间。

### 编排恢复不变量

- Journey 完成不是业务重放成功的前置条件；
- 若业务事实完整而 Journey 未完成，重放应补投影或确认已有 Outbox，而不是再次产生领域副作用；
- 若只有投影状态完整而 Lease/Period 不完整，重放必须 fail closed，不得报告激活完成。

## Closure、Billing 与 Payment 边界

### Closure 可以拥有

- 结束原因和责任判断；
- 合同条款、证据和计价规则形成的应结算试算；
- 当前 SettlementRevision 及版本链；
- 客户接受、拒绝或未响应；
- 争议决定、减免/处置决定和法务移交；
- 运营流程是否具备关闭条件。

### Closure 不可以证明

- 渠道资金已经到账；
- 某笔 Payment 已确认；
- ReceivableBill 已足额核销；
- 客户已经实际付款。

Closure 可以引用账单、支付、核销、减免审批或法务处置事实，并基于这些事实更新自己的运营终态。`SubscriptionClosureSettlementType` 的 `ESTIMATE/FINAL` 只区分试算与最终结算版本，不能表示付款、减免、坏账核销或法务处置。

Closure 的 `settledAt` 只表示“所有纳入本次结算的应收均按可判定来源链终结”，且必须逐账单保留当前未被替代的 `SubscriptionClosureReceivableDisposition`：

- `PAID` 或 `MANUAL_PAYMENT_CONFIRMED`：账单余额为零，并存在状态已确认的 `PaymentRecord` 和覆盖对应金额的 `PaymentWriteOff`；
- `WAIVED` 或 `WRITTEN_OFF`：账单余额为零，并存在与当前结算版本、金额、证明文件一致的已批准例外审批；不得伪造 Payment；
- 法务回款：每次 `EXECUTION_RECEIVED` 均形成已确认 Payment、WriteOff 和法律事件，余额归零且法律案件满足关闭条件后才能终结；
- `OPEN/DISPUTED/COLLECTION_PENDING/LEGAL_COLLECTION` 或仍有余额的账单可以在有明确 owner 时允许运营闭环继续，但不得派生 `settledAt`。

因此 `settledAt` 不能统一解释为客户付款，也不能只凭 Closure/SettlementRevision 的 stage 或 financialStatus 写入。

## Journey 边界

Journey 允许：

- 创建和认领持久化 Job；
- 记录业务等待、人工任务、重试和技术异常；
- 通过明确命令调用领域服务；
- 接收领域 Outbox 事件并幂等推进；
- 展示流程级进度和恢复入口。

Journey 禁止：

- 用 Step 完成推断合同已归档、账单已支付、车辆已交付或 Lease 已激活；
- 直接覆盖领域事实来“对齐流程”；
- 把正常客户等待或人工等待记录为技术异常/死信；
- 因 Journey 投影失败撤销已经提交的法律、支付、交付或占用事实；
- 通过 Journey 状态构造成熟订单夹具。

## 现状到目标权威偏差登记（规范性附录）

本表以基线提交 `2b96822dddcf4221142caa0c3993449ba6b98978` 为准。它不是 S2 实施计划；“目标波次/转换”只负责路由，不能作为施工授权。当前写入者和证明性读取者列出已识别的主要位置；若后续发现新的证明性读取者，必须先补入本表，再进入对应规格评审。

| 原子命题                                 | 目标权威                                                                       | 当前写入者                                                                                                                                                                  | 当前证明性读取者                                                                                                                                                                                     | 现状偏差                                                                                                                 | 目标波次/转换                                        | 契约测试                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 进件、审核与客户意图                     | `Application`                                                                  | [`CustomerService`](../../../apps/api/src/customer/customer.service.ts) 的创建、提交和审核路径                                                                              | [`SubscriptionJourneyService`](../../../apps/api/src/subscription-journey/subscription-journey.service.ts)、[`PortalApplicationService`](../../../apps/api/src/portal/portal-application.service.ts) | 主体符合；仍须确保 Journey 等待/异常分类只读取 Application 事实，不以 Step 替代                                          | S2 转换 1：现状刻画与语义收敛                        | `subscription-journey-application.spec.ts`、`customer-order.spec.ts`；补正常等待不进入技术异常的转换契约                                                |
| 最终方案精确版本与客户单次确认           | Application 最终方案快照、商业哈希、确认修订/时间及来源 Quote                  | `CustomerService.applyJourneyFinalPlanDecision`、Portal 客户确认路径                                                                                                        | `OrderService` 订单创建/最终方案确认、Journey 订单 bootstrap                                                                                                                                         | Application 与 Order 均有展示快照；必须验证 Order 只引用同一确认修订且不会要求客户二次确认                               | S2 转换 2                                            | `customer-order.spec.ts`、`subscription-journey-order-contract.spec.ts`；补“同一修订只确认一次”契约                                                     |
| 审核期软预约 owner 与车辆排他门槛        | Application 软预约字段为 owner；Vehicle 行锁/CAS 仅为同步门槛                  | `CustomerService.createSelfServiceApplication/applyJourneyFinalPlanDecision/allocateJourneyVehicle/releaseRejectedJourneyApplication`                                       | `OrderService` 的车辆锁定检查、Journey 释放逻辑、车辆可用性读取                                                                                                                                      | `softReservedVehicleId` 只有普通索引；并发下“同车仅一个有效 Application”缺少数据库独立保证，Vehicle 状态又不能证明 owner | S2 转换 2                                            | 新增双 Application 并发 barrier：最多一个成功、失败方无单边 Application/Vehicle 写入；过期/拒绝/取消预约可释放                                          |
| Contract 平台归档准入与 ESign 供应商过程 | `Contract` 与 `ContractESignTask` 分别回答平台接纳与供应商过程                 | [`ESignService`](../../../apps/api/src/esign/esign.service.ts)、Fadada 归档服务                                                                                             | [`LeaseActivationEngine`](../../../apps/api/src/lease/lease-activation.engine.ts)、Journey 签署 reconcile、页面投影                                                                                  | 目标边界已明确；仍需刻画所有读取者是否只凭 task 完成或 Contract `ARCHIVED` 单字段放行                                    | S2 转换 3                                            | `order-contract.spec.ts`、`subscription-journey-esign.spec.ts`、`customer-esign-readiness.spec.ts`；补“task 完成但归档证据缺失时 fail closed”           |
| Stage2 实际交付时间及现场证据            | `VehicleDeliveryHandover.completedAt` 与受管证据/归档链                        | [`HandoverWorkOrderService`](../../../apps/api/src/handover-work-order/handover-work-order.service.ts)、Stage2 电子签归档路径                                               | `LeaseActivationEngine`、`OrderService.confirmDeliveryLegacy`、Portal/Admin 交付投影                                                                                                                 | 新引擎以 Handover 时间为源；legacy 路径仍接收并比较人工 `deliveredAt`，需要在不扩大范围的前提下确认主路径唯一来源        | S2 转换 4                                            | `handover-work-order.spec.ts`、`order-delivery.spec.ts`、`lease-activation.spec.ts`；补人工时间不得覆盖 Handover 的契约                                 |
| 激活、车辆占用期间与在租关系             | 唯一 BASE Segment、开放 `VehicleSubscriptionPeriod`、`Lease.ACTIVE`            | [`LeaseActivationEngine`](../../../apps/api/src/lease/lease-activation.engine.ts) 与 `OrderService.confirmDeliveryLegacy`                                                   | `isCompletedActivationReplay`、Billing/里程/合同变更/Closure 对 `Order.ACTIVE` 或 `Vehicle.LEASED` 的门槛读取                                                                                        | 当前重放只检查 Order/Delivery/Vehicle 投影；Journey 完成仍在激活事务内；legacy 路径与新引擎事实集不完全相同              | S2 转换 4                                            | `lease-activation.spec.ts`、`subscription-journey-activation.spec.ts`；补锁顺序、并发 barrier、Lease/Period 缺失 fail closed、Outbox 丢失恢复和幂等重放 |
| 渠道支付发起、状态与回调证据             | `PaymentOrder` + 已验证 `PaymentCallbackLog`                                   | [`PaymentOrderService`](../../../apps/api/src/payment/payment-order.service.ts)、[`FinanceService`](../../../apps/api/src/finance/finance.service.ts)                       | Portal 支付查询、Finance reconcile、Journey 支付推进                                                                                                                                                 | 基本符合；必须防止 PaymentRecord 或 Bill 状态覆盖未验证回调历史                                                          | S2 转换 5：特征化后仅修已证实偏差                    | `payment-settlement.spec.ts`、`portal-payment.spec.ts`、`subscription-journey-payment.spec.ts`；补未验证/重复回调不产生到账                             |
| 平台到账、逐账单核销和账单余额           | 已确认 `PaymentRecord`、`PaymentWriteOff`、`ReceivableBill` 各自分层           | `FinanceService`；[`SubscriptionReturnGovernanceService`](../../../apps/api/src/subscription-closure/subscription-return-governance.service.ts) 的人工付款与法务回款路径    | `LeaseActivationEngine.isAuthoritativelySettled`、Closure financial derivation                                                                                                                       | 当前人工付款会先写 Payment/WriteOff，且通用 Closure 入口禁止直接写 `PAID`，主体符合；需把该约束固定为跨路径契约          | S2 转换 5                                            | `finance-billing.spec.ts`、`payment-settlement.spec.ts`、`subscription-closure-financial.spec.ts`；补主动支付/人工付款/法务回款统一可追溯性             |
| 物理取回、处置和车辆释放                 | `VehicleReturn`/Checklist/Evidence、Closure 决定、结束 Lease/Period 和限制事实 | `SubscriptionReturnGovernanceService`、[`SubscriptionClosureService`](../../../apps/api/src/subscription-closure/subscription-closure.service.ts)、Order legacy return 路径 | Order workspace、Vehicle 状态筛选、Closure completion                                                                                                                                                | 三阶段事实与 legacy payload/旧退车路径并存；`Vehicle.RETURNED/AVAILABLE` 仍可能被当作物理取回或释放证明                  | S2 转换 6 只收敛无争议正常结束；legacy 深层拆分转 S4 | `order-return.spec.ts`、`subscription-closure-financial.spec.ts`、Closure 服务测试；补“有投影无取回/Period 结束时不得完成”                              |
| 订单 `COMPLETED/TERMINATED`              | Closure 终态 + Lease/Period 结束 + 车辆释放组合                                | `SubscriptionReturnGovernanceService.completeOperations` 及其他 Closure 终态路径                                                                                            | Order 列表/工作台、Billing/Change/报表按 OrderStatus 的读取                                                                                                                                          | 当前终态写入与 Closure 同事务，但大量读取者只看 OrderStatus；需要固定终态完整不变量                                      | S2 转换 6                                            | 新增正常完成/提前终止终态矩阵；任一 Closure、Lease、Period、Return、Restriction 条件缺失均不得报告完整闭环                                              |
| Journey 调度与投影                       | Journey Step/Job/ManualTask/Exception/Outbox                                   | `SubscriptionJourneyService/Repository`；激活引擎当前也直接完成 Journey                                                                                                     | Admin/Portal 进度、Worker/recovery                                                                                                                                                                   | 激活事务内 Journey 失败会回滚业务激活，与“Journey 不是业务权威”目标冲突；其他转换仍可能以 Step 完成代替领域读取          | S2 按转换 1—6 分别收敛；激活归转换 4                 | `subscription-journey-state-machine.spec.ts`、recovery/integrity/e2e 测试；每个转换增加“投影失败不改业务结果、可补投影”契约                             |
| 合同变更及旧字段兼容                     | 独立 Change/Segment 事实；不进入本轮最小主路径                                 | Change services 与 [`subscription-extension-compat.ts`](../../../apps/api/src/subscription-change/subscription-extension-compat.ts)                                         | Change API/Portal/Worker、旧 root columns 读取                                                                                                                                                       | 兼容读取和四类高级能力已存在，但不应成为 Stage 1 基础验收前置，也不在 S2 扩建                                            | S5 独立启用/补齐/验收；兼容退役评审在 S4             | 保留现有 change tests；S5 规格前不得新增本轮准入测试依赖                                                                                                |
| 两次维护执行证据                         | `BillingMaintenanceCycleFact` 只证明受控执行身份、结果和幂等性                 | [`BillingMaintenanceEvidenceService`](../../../apps/api/src/billing-automation/billing-maintenance-evidence.service.ts)                                                     | evidence CLI/Runbook/验收签字                                                                                                                                                                        | Stage1 专用对象与版本字符串已固化；不证明两个真实账单周期                                                                | S3 读取；Stage1 签字后由 S4 决定停写只读或另行泛化   | `billing-maintenance-evidence.service.spec.ts`、Schema/Postgres integration 及 Runner 真实命令验证                                                      |

## 临时资产分类

新增资产必须归入以下一类，不得统一标记为“阶段临时资产”。

| 类型             | 示例                                         | 默认生命周期                                   |
| ---------------- | -------------------------------------------- | ---------------------------------------------- |
| 永久业务权限     | 合同查看、退车审批、支付核销权限             | 随业务职责保留；只有职责退役时删除             |
| 阶段性功能开关   | Journey worker、三阶段退车、合同变更能力开关 | 必须有启用条件和稳定后折叠/删除日期            |
| 验收身份/测试 ID | 管理员、Portal 测试用户、黄金订单或车辆 ID   | 仅环境 Manifest 引用，不写入仓库稳定契约       |
| 一次性脚本       | 历史订单退休、特定事实 backfill              | 完成执行和保留期后从 Runner 移除，历史提交保留 |
| 临时兼容分支     | legacy 状态读取、旧快照兼容                  | 必须有最后读者、观测指标和前向退役条件         |
| 运营证据对象     | `BillingMaintenanceCycleFact` 等             | 按业务/审计价值决定持续写入、停写只读或泛化    |

## 临时资产登记字段

资产登记不得只记录名称。每项至少包含：

- `assetId`：稳定标识；
- `assetType`：上述六类之一；
- `owner`：具体责任角色；
- `introducedBy`：PR/迁移/提交；
- `purpose`：当前唯一用途；
- `runtimeConsumers`：真实调用方；
- `defaultState`：默认启用/关闭/不可配置；
- `enablementCondition`：启用所需证据和批准；
- `retirementCondition`：可停止、折叠或删除的客观条件；
- `reviewDate`：下一次人工复核日期；
- `evidenceRetention`：执行证据保留期和访问权限；
- `decision`：永久保留、阶段保留、停写只读、待退役或已退役。

登记表不得包含密码、令牌、完整数据库连接、身份证号、手机号或其他客户敏感数据。验收身份只保存受控引用或不可逆指纹。

## S0 基线资产登记（规范性附录）

下表是 S0 关闭所需的实际基线，不是后续待办模板。owner 使用稳定责任角色而不是个人姓名；具体当值人员由团队责任映射和执行批准记录确定。`introducedBy` 记录首次引入该资产或当前受管形态的代表性提交；历史细分以 Git 记录为准。

| assetId                                      | assetType        | 具体资产                                                                                                                                                                                    | owner                                          | introducedBy                                  | purpose / runtimeConsumers                                                           | defaultState / enablementCondition                                                   | retirementCondition                                                                                        | reviewDate | evidenceRetention                                             | decision                                         |
| -------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `perm.subscription-journey`                  | 永久业务权限     | `subscription_journey:view/plan_decide/vehicle_allocate/delivery_evidence_decide/recover/cancel`                                                                                            | 订阅运营负责人                                 | `1522db45`、`6415d4df`                        | Admin Journey 查询、人工决策、恢复和取消；消费者为 Journey Controller 与 Admin Web   | 仅经角色授权；生产角色变更须走 RBAC 审批                                             | 只有 Journey 运营职责和全部 API/UI/审计读取者均退役时才可前向删除                                          | 2026-09-15 | RBAC 变更审计按安全策略保留；安全管理员可访问                 | 永久保留                                         |
| `perm.subscription-closure-recovery`         | 永久业务权限     | `subscription_closure:*`、`subscription_recovery:*`、`subscription_early_termination:create/execute`                                                                                        | 退车与法务运营负责人                           | `a616b7b8`、`d2c25752`                        | 退车、结算、追偿、法催与提前结束 API/UI                                              | 仅与岗位职责匹配的角色可授权；高风险 approve/execute 分离                            | 对应业务职责、入口、Worker 和审计读取者全部退役后再单独评审                                                | 2026-09-15 | 审批与操作审计依现行业务/法务策略保留                         | 永久保留；提前结束能力在 S5 前不作为 Stage1 准入 |
| `perm.subscription-change`                   | 永久业务权限     | `subscription_change:view/create/quote/approve/price_override_approve/submit/esign_retry/execute/manual_takeover/cancel`                                                                    | 合同变更运营负责人                             | `79f16a6c`、`57cf9ee5`                        | Change Controller、Portal/Admin 变更入口与 Worker                                    | 能力开关开启且角色批准后授权；approve/execute/manual_takeover 保持职责分离           | S5 对四类能力逐项决定保留或退役；不得仅因 Stage1 关闭开关而删除权限                                        | 2026-09-15 | 变更、审批、签署及执行审计按合同策略保留                      | 永久业务权限，能力暂不进入 Stage1                |
| `perm.asset-and-settlement`                  | 永久业务权限     | `asset_facts:view`、`vehicle_period:manage`、`asset_work_order:manage`、`vehicle_restriction:*`、`vehicle_cost_ledger:*`、`business_exception:*`、`billing:*`、`payment:*`                  | 资产运营负责人和财务负责人（按权限域分别负责） | `a9764f3c`、`9359e7f7` 及当前基线             | 占用期间、限制、成本、例外审批、账单、到账和核销 API/UI                              | 仅按领域角色授权；高风险确认/反转/审批/核销分离                                      | 对应长期业务职责退役且全部消费者清零后才可单独删除                                                         | 2026-09-15 | 财务与资产审计按现行合规策略保留                              | 永久保留，不归入验收脚本退出范围                 |
| `flag.journey-stage1`                        | 阶段性功能开关   | `SUBSCRIPTION_JOURNEY_ENABLED`、`SUBSCRIPTION_JOURNEY_WORKER_ENABLED`、两个 `SUBSCRIPTION_JOURNEY_ALLOWLIST_*`                                                                              | Stage1 发布负责人                              | `6415d4df`                                    | Journey enrollment、Worker 和受控验收范围                                            | 缺失时 fail closed；S3 仅对冻结 RC 和批准的 Manifest 引用启用                        | Stage1 签字且 S4 证明无需 allowlist 双路径后，移除 allowlist 与临时分支；Journey 长期启停策略另行评审      | 2026-09-15 | 每次 RC 的非敏感配置指纹随执行证明保留 180 日                 | 阶段保留                                         |
| `flag.contract-change`                       | 阶段性功能开关   | `SUBSCRIPTION_EXTENSION_ENABLED`、`SUBSCRIPTION_VEHICLE_SWAP_ENABLED`、`SUBSCRIPTION_EARLY_TERMINATION_ENABLED`、`SUBSCRIPTION_MANAGED_OTHER_ENABLED`、`SUBSCRIPTION_CHANGE_WORKER_ENABLED` | 合同变更发布负责人                             | `f6f391aa`、`823091f9`                        | 四类变更 API/Portal 与 Change Worker                                                 | 缺失/非 `true` 均关闭；Stage1 基础验收保持关闭，S5 逐能力批准                        | S5 为每项选择单一路径后折叠；不得在 S0/S2 为“方便验收”开启                                                 | 2026-09-15 | 启用批准、配置指纹和执行审计按独立能力验收保留 180 日         | 阶段保留、默认关闭                               |
| `flag.return-three-stage`                    | 阶段性功能开关   | `SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED`                                                                                                                                                   | 退车产品负责人                                 | `d2c25752`、当前受管形态 `b8b3f7e4`           | 三阶段退车受管写入、Return Manifest 电子签和投影                                     | 缺失/非 `true` 时拒绝无既有受管事实的新写入；冻结 RC 满足 S3 数据与回滚门槛后启用    | Stage1 正常结束签字、旧写入者清零且 S4 完成兼容分支退役评审后折叠为单一路径                                | 2026-09-15 | 退车证据按合同/法务策略保留；开关执行证据保留 180 日          | 阶段保留                                         |
| `flag.billing-maintenance-evidence`          | 阶段性功能开关   | `BILLING_MAINTENANCE_EVIDENCE_ENABLED` 及 run/release/image/database identity 元数据                                                                                                        | 计费发布负责人                                 | `96a712e7`、`d31d69b3`                        | Billing maintenance service 写入两次受控维护证据；evidence CLI 读取                  | 默认关闭；只允许与冻结 RC、目标数据库和批准 run id 匹配的短时执行窗口开启            | Stage1 签字后立即关闭并清空运行元数据；S4 决定历史只读保留或前向泛化                                       | 2026-09-15 | 执行证明及只读事实保留 180 日，计费发布/审计角色可访问        | 阶段保留，签字后停写                             |
| `flag.acceptance-workers`                    | 阶段性功能开关   | `BILLING_AUTOMATION_WORKER_ENABLED`、`FIELD_VIDEO_UPLOAD_WORKER_ENABLED`、`STAGE2_HANDOVER_WORKER_ENABLED`、`MILEAGE_REVIEW_WORKER_ENABLED` 及上述 Journey/Change worker 开关               | 平台运行负责人                                 | 当前 main 基线 `2b96822d`                     | 验收库切换、迁移、回滚和 RC 演练时控制后台写入                                       | 仅按 Runbook 的停写/启用序列和执行批准变更；不得依赖默认值猜测                       | S1 将其纳入 Runner/Manifest 后，决定哪些保留为永久运营配置、哪些折叠；在此之前不得删除                     | 2026-09-15 | 每次环境变更的配置指纹和批准记录保留 180 日                   | 阶段保留，待 S1 分类                             |
| `acceptance.identity-refs`                   | 验收身份/测试 ID | Stage1 管理员、Portal 客户、黄金订单/车辆和受控成熟订单夹具的逻辑引用                                                                                                                       | Stage1 验收负责人                              | 既有 Staging 验收流程；本登记首次固化于本规格 | 浏览器验收和 Runner fixture provenance；消费者只能是环境 Manifest、Runner 和验收报告 | 仓库内无真实用户名、手机号或对象 ID；执行时引用受控 secret/ID 并只输出不可逆指纹     | Stage1 签字后撤销专用授权、关闭测试订单；保留证明指纹，不保留可复用凭证                                    | 2026-09-15 | 指纹、对象处置结果和签字证据保留 180 日；凭证不进入证据       | 阶段保留                                         |
| `script.clean-acceptance-and-preflight`      | 一次性脚本       | `stage1-clean-acceptance-*`、`stage1-task9-preflight-governance.mjs`、`stage1-golden-path-production-preflight.mjs`                                                                         | 数据库发布负责人                               | `e6660da7`、`2e365623`                        | 当前由 Runbook/人工通过 API 容器执行验收库创建、验证、快照和预检                     | S0 不批准执行；S1 盘点后只能由身份匹配的 Runner dry-run/批准/apply                   | Runner 提供等价能力、真实镜像门禁稳定且事故复盘保留期结束后，从 API runtime 移除；是否从仓库退役由 S4 决定 | 2026-09-15 | 执行证明和脱敏日志保留 180 日                                 | 待迁出 API runtime                               |
| `script.stage1-data-repair`                  | 一次性脚本       | `stage1-active-source-facts-repair*`、`stage1c-period-backfill*`、`stage1-return-closure-backfill*`、`stage1-staging-invalid-test-order-retirement*`                                        | 数据治理负责人                                 | `f239f6d4`、`d2c25752`、`9467bab0`            | 现有事实补齐、退车补齐和无效测试订单关闭；当前部分脚本由 API runtime/Runbook 调用    | 每类写操作独立 dry-run、目标身份、摘要、digest、人工批准、apply、replay；默认不执行  | 目标环境无需再修复、Runner 替代 API runtime、证据保留期结束后退出运行镜像；历史源码是否保留由 S4 决定      | 2026-09-15 | 每次批准与 before/after digest 保留 180 日                    | 待迁出 API runtime；不为历史测试单扩大执行       |
| `script.stage1-optional-domain`              | 一次性脚本       | `stage1-contract-change-bootstrap*`、`stage1-journey-business-wait-reconcile*`、`stage1-journey-final-plan-order-reconcile*`、`stage1-auto-debit-retirement*`、`stage1c-access-baseline*`   | 对应领域负责人；发布负责人负责执行隔离         | `9a005218`、`981c9d02` 及当前基线             | 合同变更 bootstrap、旧 Journey 对账、主动支付基线退出和权限基线治理                  | 合同变更 bootstrap 默认禁止进入 S3；其他脚本仅在证明确有当前环境阻断且逐项批准后执行 | 无剩余目标、调用者和恢复需求，且证据保留期结束后由 S4 逐项退役                                             | 2026-09-15 | 批准、目标指纹和结果摘要保留 180 日                           | 阶段保留，默认不执行                             |
| `compat.delivery-and-return`                 | 临时兼容分支     | `OrderService.confirmDeliveryLegacy`、Closure `legacyPayload`/`legacy-prepare-return` 路径                                                                                                  | 交付与退车领域负责人                           | 历史路径；当前基线 `2b96822d`                 | 无 Journey 订单交付兼容、旧退车 payload 和事件兼容读取                               | 只服务已有旧事实；不得成为新受管主路径默认写入者                                     | S2 主路径语义稳定，S4 证明旧事实可读、最后写入者为零且指标观察一个发布周期后前向退役                       | 2026-09-15 | 兼容读取指标与退役证据保留 180 日                             | 待 S4 退役评审                                   |
| `compat.subscription-extension-root-columns` | 临时兼容分支     | [`subscription-extension-compat.ts`](../../../apps/api/src/subscription-change/subscription-extension-compat.ts) 对旧 root columns 的读取                                                   | 合同变更领域负责人                             | `823091f9`                                    | Change domain、extension/contract/activation services 兼容历史结构                   | S5 前保持只读兼容；不得新增依赖旧 root columns 的写入者                              | S5 能力决定后完成数据符合性检查、最后读取者清零并通过前向迁移退役                                          | 2026-09-15 | 迁移与兼容读取证据保留 180 日                                 | 阶段保留                                         |
| `evidence.billing-maintenance-cycle-fact`    | 运营证据对象     | `BillingMaintenanceCycleFact`、枚举、触发器/函数与 `20260831010000_billing_maintenance_cycle_fact` 迁移                                                                                     | 计费发布负责人                                 | `96a712e7`                                    | Billing service 写入，evidence CLI/Runbook/验收签字读取                              | 写入由对应开关和完整 source/image/database identity 约束                             | Stage1 签字后停写；历史只读保留，S4 仅在持续运营/外部审计需求成立时设计通用替代和前向迁移                  | 2026-09-15 | 历史事实和导出证明暂定保留 180 日；最终期限由 S4 审计评审确定 | Stage1 前保留，签字后停写只读                    |

本基线清单的任何新增、拆分或 owner 变更都必须在 S0 评审记录中形成差异；不能仅修改 Runbook 或环境变量而不更新登记。未登记资产、owner 为空或退出条件不可判定时，S1 仍保持阻断。

## 启用、停写和退役规则

### 永久权限

- 不因“PR260—302 新增”而自动进入退役名单；
- 必须映射到现行业务职责；
- 删除必须同时验证 API、页面入口、后台任务和审计读取方。

### 阶段性功能开关

- 必须有 owner、默认值、启用门槛和删除/折叠复核日期；
- Stage 1 排除能力默认关闭；
- 稳定后应选择单一路径并删除临时双分支，不永久保留两套语义。

### 一次性脚本

- API runtime 不得继续承载仅发布、迁移、验收或历史修复使用的脚本；
- 在 S1 完成调用方盘点前不得机械删除 `scripts/` COPY；
- 迁入 Runner 后仍需发布身份、数据库身份、dry-run、批准、apply、replay 和证据约束；
- 执行完成不等于立即删除，必须满足证据保留和事故复盘要求。

### 运营证据对象

`BillingMaintenanceCycleFact` 在 Stage 1 验收前保持现状，不新增泛化表。

Stage 1 签字后：

1. 关闭验收证据写入开关；
2. 历史事实只读保留；
3. 确定保留期限和访问权限；
4. 只有存在持续运营或外部审计需求时，才单独设计通用事实模型和前向迁移。

## S0 完成门槛

S0 只有在以下条件全部满足时才能批准结束：

- 本规格中的原子事实权威矩阵获得业务、研发和必要法务角色确认；
- `Contract.ARCHIVED` 的表述明确为平台激活准入/归档证据事实；
- 激活前置事实、权威写入、同步投影和 Journey 后置投影无混淆；
- 激活完整重放不变量获得批准；
- Closure 不再被解释为支付完成权威；
- 现状到目标权威偏差登记已逐项确认并路由，但未被误作施工授权；
- 临时资产六分类、登记字段和本规格中的实际基线清单获得批准；每项均有 owner、reviewDate 和可判定退出条件；
- S1/S2 仍保持未获施工授权状态。

## S0 停止条件

评审中出现以下任一情况时，S0 停止并返回权威模型修订：

- 同一个原子命题仍有两个可独立改写的权威对象；
- 投影状态可以在缺少权威事实时被当作完成；
- 激活重放允许 Lease/Period 缺失；
- Closure 终态会让争议、法务处置或减免被表示为客户支付；
- 临时资产没有 owner 或客观退出条件；
- S0 文档开始包含 S1/S2 的具体施工步骤或实现批准。
