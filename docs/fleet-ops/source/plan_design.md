已按只读方式完成架构设计，没有改 schema、代码、数据，也没有部署。设计基于现有模型和服务边界，重点参考了 \[schema.prisma](D:/Projects/auto-subscription-platform/apps/api/prisma/schema.prisma:1954)、\[report.service.ts](D:/Projects/auto-subscription-platform/apps/api/src/report/report.service.ts:5370)、\[finance.service.ts](D:/Projects/auto-subscription-platform/apps/api/src/finance/finance.service.ts:730)、\[lease-activation.engine.ts](D:/Projects/auto-subscription-platform/apps/api/src/lease/lease-activation.engine.ts:36)。



\*\*架构策略\*\*

推荐采用方案 A。



| 方案 | 说明 | 取舍 |

|---|---|---|

| A. 现有系统上加 Fleet Ops 逻辑层 | 复用 `Vehicle`、`Lease`、`SubscriptionOrder`、`ReceivableBill`、`CollectionCase`、`VehicleDepreciation\*`、`FinancingInstrumentVehicle` | 最符合本阶段“no schema changes”，风险最低 |

| B. 新建独立 Fleet Ops bounded context | 新表承载车辆运营、GPS、维修、状态事件 | 长期最干净，但本阶段违反 schema 禁令 |

| C. 只做 BI/报表层 | 不碰业务流程，仅聚合指标 | 快，但无法解决审批、分配、停运盲区 |



\*\*总体架构\*\*

```mermaid

flowchart LR

&#x20; Workflow\["Workflow Engine"] --> Order\["Order System"]

&#x20; Workflow --> Application\["Application / Onboarding"]

&#x20; Order --> Lease\["Lease Engine"]

&#x20; Order --> Fleet\["Fleet Ops Engine"]

&#x20; Lease --> Fleet

&#x20; Payment\["Payment System"] --> Finance\["Financial Intelligence Engine"]

&#x20; Finance --> Collection\["Collection / Overdue Engine"]

&#x20; Fleet --> Finance

&#x20; Order --> Finance

&#x20; Collection --> Workflow

```



\*\*1. Workflow Engine\*\*

定位：审批编排层，不直接替代 `Application` / `SubscriptionOrder`，而是定义审批门禁和流转规则。



Onboarding approval flow：

`DRAFT -> SUBMITTED -> material review -> credit/risk review -> product review -> vehicle review -> final plan confirmation -> APPROVED / NEED\_MORE\_INFO / REJECTED`



映射现有字段：

`Application.status`、`materialReviewStatus`、`creditReviewStatus`、`productReviewStatus`、`vehicleReviewStatus`、`planConfirmStatus`、`RiskResult`。



Order approval flow：

`Quote confirmed -> Order created -> review if needed -> customer confirmation if plan/deposit changed -> contract signing -> payment gate -> delivery gate -> lease activation`



映射现有字段：

`SubscriptionOrder.orderStatus`、`creditReviewStatus`、`productReviewStatus`、`vehicleReviewStatus`、`Contract.status`、`ReceivableBill`、`VehicleDelivery`、`Lease`。



Vehicle allocation flow：

`AVAILABLE -> REVIEW\_RESERVED -> RESERVED -> LEASED/RENTED -> RETURNED -> MAINTENANCE -> AVAILABLE/RETIRED`



原则：

Workflow 只判断“是否允许推进”，Order/Fleet 执行状态变化。审批失败必须释放软占用或预约车辆，避免库存假占用。



\*\*2. Fleet Operations Engine\*\*

定位：运营核心层，负责车辆可用性、停运、维护、生命周期，不负责合同法律状态，也不负责收款。



核心能力：

\- vehicle utilization tracking：按车辆日历生成 `leasedDays / operatingDays`，现有报表已有基础口径。

\- downtime tracking：把非营收不可用时间拆成 `PREPARATION`、`RESERVED\_HOLD`、`MAINTENANCE`、`REPAIR`、`ACCIDENT`、`IDLE`、`UNKNOWN\_GAP`。

\- maintenance scheduling：从里程、还车检查、车况报告、服务工单、保险理赔、BaaS 成本记录触发维护计划。

\- operational status lifecycle：以 `Vehicle.status` 为当前状态，交付、还车、服务工单、折旧、保险、GPS 新鲜度作为解释层。



状态优先级建议：

`RETIRED > LEASED/RENTED > MAINTENANCE > RESERVED > REVIEW\_RESERVED > AVAILABLE > IN\_PREPARATION > DRAFT`



\*\*3. Financial Intelligence Engine\*\*

定位：经营分析和资产收益引擎，读取 Payment/Finance/Fleet 事实，不处理支付回调，不写收款事实。



ROE per vehicle：

`ROE = platformNetIncomeAmount / roeEquityBaseAmount`



收入侧：

租金实收、损伤赔付、其他已核销收入，押金单独列示，不进经营收入。



成本侧：

已确认/锁定折旧记录、BaaS 成本、保险、维护准备金、资金成本、其他成本。



资本侧：

`VehicleCapitalEvent`、`FinancingInstrumentVehicle`、`RevenueRightAssignment`、`RevenueShareRule` 共同决定权益资本和收益归属。



Fleet ROI aggregation：

不要简单平均单车 ROI。应按 `purchasePriceAmount`、`roeEquityBaseAmount` 或资产池权重聚合，并按车型、资产池、获取方式、状态分层。



Cashflow modeling：

基于 `ReceivableBill.dueDate` 做计划现金流，基于 `PaymentRecord.receivedAt` 和 `PaymentWriteOff` 做实际现金流，押金基于 `DepositLedger` 单独处理。



Depreciation + cost allocation：

主口径优先用 `VehicleDepreciationRecord CONFIRMED / LOCKED`，无 ACTIVE policy 时 fallback 到 `VehicleAssetCostProfile`。维护实际成本未来应覆盖维护准备金，但本阶段只设计口径。



\*\*4. Collection / Overdue Engine\*\*

定位：逾期识别、案件策略、风险分层、欠款管道。



Overdue detection：

以 `dueDate < asOfDate AND remainingAmount > 0 AND billStatus != CANCELLED` 为事实判断，不只依赖 `BillStatus.OVERDUE`。



Collection strategy：

| Level | 条件 | 策略 |

|---|---|---|

| D1 | 1-3 天 | 自动提醒，账单解释 |

| D2 | 4-7 天 | 人工电话，承诺还款 |

| D3 | 8-15 天 | 风险升级，限制新订单/交付 |

| D4 | 16-30 天 | 正式通知，准备车辆处置预案 |

| D5 | 30 天以上 | 法务、终止、车辆追回流程 |



Risk scoring：

综合 `overdueDays`、逾期金额、客户等级、历史催收、承诺还款违约、车辆价值敞口、GPS/位置新鲜度、当前利用率损失。



Arrears pipeline：

`ReceivableBill -> OverdueBill -> CollectionCase -> CollectionAction -> PromiseToPay -> Partial/Full WriteOff -> Closed/Escalated`



\*\*资产模型升级，逻辑模型，不改 schema\*\*

| 目标模型 | v2 含义 | 当前映射 |

|---|---|---|

| VehicleAsset | 单车资产聚合根 | `Vehicle` + `VehicleAssetCostProfile` + `VehicleDepreciation\*` + `VehicleConditionReport` |

| AssetLiabilityLink | 资产与债务/资金/收益权关系 | `VehicleCapitalEvent` + `FinancingInstrumentVehicle` + `RevenueRightAssignment` |

| MaintenanceRecord | 维修/保养/事故/停运事实 | 当前由 `ServiceCase`、`VehicleReturnDamage`、`VehicleConditionReport`、`InsuranceClaim` 逻辑聚合 |

| GPS/LocationTracking | 位置样本、最新位置、轨迹新鲜度 | 当前只有 `Vehicle.assetLocation` 和 `ServiceCase.latitude/longitude`，v2 先作为外部遥测逻辑模型 |



\*\*系统关系\*\*

Lease Engine vs Fleet Ops Engine：

Lease 负责合同生效和租约激活。Fleet Ops 负责车辆是否可用、是否停运、是否可交付。Lease 可以把车辆置为营运中，Fleet Ops 可以阻止交付准备，但不直接激活租约。



Financial Engine vs Payment System：

Payment 负责支付订单、支付回调、收款记录、核销。Financial Intelligence 只读这些事实，计算 ROE、ROI、现金流和风险暴露。



Workflow Engine vs Order System：

Workflow 负责审批规则、门禁和任务流。Order System 负责订单状态、合同、交付、取消、变更等持久业务动作。



\*\*风险模型\*\*

| 风险 | 典型问题 | 控制 |

|---|---|---|

| asset misclassification | 车辆获取方式、状态、资本结构错误 | acquisitionMode、资本事件、融资分摊、车辆状态交叉校验 |

| revenue misreporting | 押金当收入、应收当实收、收益权漏扣 | 只用核销事实入收入，押金单列，收益权/分润进入 ROE |

| utilization blind spots | 交付/还车缺失、维修未记录、软占用长期不释放 | 车辆日历、UNKNOWN\_GAP、预约过期检查、服务工单闭环 |

| overdue underreporting | 只看 billStatus、部分支付漏算、案件关闭但账单未清 | 每日按 dueDate + remainingAmount 重算，关闭案件必须账单结清 |



\*\*指标体系\*\*

| 指标 | 公式 |

|---|---|

| utilization rate | `leasedDays / operatingDays` |

| downtime rate | `downtimeVehicleDays / operatingVehicleDays` |

| ROI per vehicle | `periodNetReturn / investedCapital` |

| ROE per vehicle | `platformNetIncomeAmount / roeEquityBaseAmount` |

| fleet IRR | 单车现金流合并后的 XIRR，含购置流出、实收流入、成本流出、残值流入 |

| overdue ratio | `overdueRemainingAmount / totalOutstandingReceivableAmount` |



本轮产出是架构设计，不包含 schema migration、实现、部署或数据修改。

