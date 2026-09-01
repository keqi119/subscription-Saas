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

| 原子命题                                         | 唯一权威                                                                                                | 非权威投影或禁止替代                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 客户已提交进件、材料版本、审核结论和当前客户意图 | `Application` 及其冻结提交/审核事实                                                                     | Journey 当前步骤、页面标签不得替代                                                          |
| 报价内容、产品/价格版本和报价状态                | `SubscriptionQuote`                                                                                     | Application/Order 快照和 Journey “方案完成”不得替代报价原始事实                             |
| 已发布最终方案及客户确认的精确版本               | Application 的最终方案快照、商业哈希、确认修订和确认时间                                                | Order 展示字段、Quote 当前状态和 Journey “方案完成”不得替代；最终方案必须引用其来源 Quote   |
| 车辆自身库存/运营生命周期状态                    | `Vehicle`                                                                                               | Quote、Order、页面选择值或 Journey 不得替代；“当前可租”是结合预约、占用和限制事实的派生判断 |
| 最终车辆软锁和预约归属                           | Vehicle 上的软预约字段及对应预约来源/期限事实                                                           | Journey 手工任务完成不得替代                                                                |
| 正式签约前后的订单生命周期                       | `SubscriptionOrder`                                                                                     | Journey 当前步骤和合同状态不能单独改写 Order 生命周期                                       |
| 合同文本、条款和不可变文档版本                   | `ContractVersion`                                                                                       | 当前 Contract 状态、ESignTask 或页面快照不得覆盖历史版本                                    |
| 平台接纳的当前合同状态、归档文件指针和激活准入   | `Contract` 及其当前版本/归档文件引用                                                                    | `ESignTask` 状态不能反向替代 Contract；`ARCHIVED` 在本规格中不宣称法律生效时点              |
| 电子签供应商交互、签署人、回调和任务执行状态     | `ContractESignTask` 及签署人/回调事实                                                                   | Contract 不替代供应商交互历史；供应商“已完成”不自动等于平台已接纳归档                       |
| 应收项目、金额、到期日和未结余额                 | `ReceivableBill`/Billing 领域                                                                           | Closure 试算、Journey 账单步骤不得替代                                                      |
| 渠道支付交易及其确认结果                         | `PaymentRecord`                                                                                         | Bill、Closure 或 Journey 不得伪造渠道到账                                                   |
| 确认资金对具体应收的核销分配                     | `PaymentWriteOff` 及其关联的已确认 Payment                                                              | Bill `PAID` 必须可追溯到足额核销；Closure `settledAt` 不得替代                              |
| Stage2 实际交付时间                              | 已完成且权威校验通过的 `VehicleDeliveryHandover.completedAt`                                            | `VehicleDelivery.deliveredAt`、Order `actualDeliveryAt` 是派生投影                          |
| 现场交接任务执行、运营复核和客户意见             | `VehicleHandoverWorkOrder`、ReviewAttempt 和 Event 事实                                                 | Journey、Order 或页面状态不得替代工作流历史                                                 |
| 单项交接证据、原始文件和签署交接文档             | `VehicleDeliveryEvidenceItem`、`VehicleDeliveryEvidenceFile` 及 Handover 归档文件引用                   | WorkOrder 汇总状态、Journey 或 Closure 摘要不得覆盖原始证据                                 |
| 车辆物理取回、返回时间和初始损伤记录             | `VehicleReturn`、`VehicleReturnDamage` 及受管 Return Checklist/Evidence 事实                            | Closure 结算状态、Vehicle 库存状态或 Journey 不得替代物理取回证据                           |
| 车辆被某订单占用的开放期间                       | `VehicleSubscriptionPeriod`                                                                             | `Vehicle.LEASED` 和 Order `ACTIVE` 是运营投影                                               |
| 客户在租履约关系                                 | `Lease`                                                                                                 | Order、Vehicle 或 Journey 状态不得代替 Lease                                                |
| 指定履约日期适用的合同计费与权益条款             | `SubscriptionContractSegment`                                                                           | Order 当前字段、Quote 或变更单展示状态不得替代已生效分段                                    |
| 结束责任、应结算金额、客户意见、争议和处置决定   | Closure 领域的 Case、SettlementRevision、CustomerResponse、Dispute、Disposition 和 LegalCollection 事实 | Closure 不证明支付已完成；Billing/Payment 不决定法律责任或争议处置                          |
| 流程调度、等待、重试、人工任务和技术异常         | `SubscriptionJourney` 及 Step/Job/Exception/Outbox                                                      | Journey 不得成为合同、支付、交付、占用、Lease 或 Closure 的业务权威                         |

## Contract 与 ESign 边界

Contract 和 ESignTask 不是双权威，它们回答不同问题：

- ESignTask 回答“供应商交互进行到哪里、谁签署、回调是否接收”；
- Contract 回答“平台当前接纳哪一版合同、是否具有完整归档文件、该归档是否满足激活准入”。

S0 使用“平台激活准入事实”或“归档证据完整事实”描述 `Contract.ARCHIVED`。除非法务另行批准，不把数据库 `ARCHIVED` 枚举直接定义为法律生效时点。

供应商回调必须先经过平台接纳、文件校验和归档，才能改变 Contract 权威事实。Contract 投影不得删除或覆盖 ESignTask、签署人和回调历史。

## 激活事实分层

### 激活前置事实

激活事务必须按固定锁顺序重新读取并验证，但不得重写以下事实：

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

Closure 可以引用账单、支付、核销、减免审批或法务处置事实，并基于这些事实更新自己的运营终态。Closure 的 `settledAt` 只表示“按已批准处置路径满足 Closure 关闭条件”，必须同时保留具体 settlement type 和来源引用，不能统一解释为客户付款。

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

S0 后续登记不得只记录名称。每项至少包含：

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
- 临时资产六分类和登记字段获得批准；
- S1/S2 仍保持未获施工授权状态。

## S0 停止条件

评审中出现以下任一情况时，S0 停止并返回权威模型修订：

- 同一个原子命题仍有两个可独立改写的权威对象；
- 投影状态可以在缺少权威事实时被当作完成；
- 激活重放允许 Lease/Period 缺失；
- Closure 终态会让争议、法务处置或减免被表示为客户支付；
- 临时资产没有 owner 或客观退出条件；
- S0 文档开始包含 S1/S2 的具体施工步骤或实现批准。
