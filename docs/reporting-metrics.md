# 报表口径文档

本文档固化 Stage 7.6 经营报表与 CSV 导出的第一版口径。当前报表面向后台运营、财务和资产管理角色，提供实时聚合查询与轻量 CSV 导出。

## 报表模块

后端模块：`apps/api/src/report`

前端页面：`/reports`

查看 API：

- `GET /api/reports/dashboard-summary`
- `GET /api/reports/orders`
- `GET /api/reports/finance`
- `GET /api/reports/deposit-pool`
- `GET /api/reports/collections`
- `GET /api/reports/vehicle-assets`

CSV 导出 API：

- `GET /api/reports/orders/export`
- `GET /api/reports/finance/export`
- `GET /api/reports/deposit-pool/export`
- `GET /api/reports/collections/export`
- `GET /api/reports/vehicle-assets/export`

## 日期范围口径

所有报表支持 `startDate` / `endDate`，格式为 `YYYY-MM-DD`。

如未传日期，默认最近 30 个自然日。

日期按业务自然日统计，当前按 UTC+8 业务日期换算为数据库时间范围。

## 经营总览口径

订单数据按 `SubscriptionOrder.createdAt` 统计。

车辆数量按当前 `Vehicle.status` 统计。

财务汇总来自 `ReceivableBill.amount`、`ReceivableBill.paidAmount`、`ReceivableBill.remainingAmount`。

保证金余额来自 `DepositLedger` 中已确认且未删除的交易。

逾期金额来自 `billStatus = OVERDUE` 且 `remainingAmount > 0` 的 `ReceivableBill`。

## 订单报表口径

订单报表按 `SubscriptionOrder.createdAt` 进入统计周期。

支持筛选：

- `orderSource`
- `orderStatus`
- `productId`
- `vehicleModel`

统计维度：

- 订单总数
- 按订单状态统计
- 按订单来源统计
- 按车型统计
- 按订阅套餐统计

订单状态中文标签使用订单业务域标签，例如 `ACTIVE = 在租`，不得混用产品或套餐的 `ACTIVE = 启用`。

## 财务报表口径

统计来源：

- `ReceivableBill`
- `PaymentWriteOff`
- `PaymentRecord`

当前财务报表确认金额只使用账单字段：

- 应收金额 = `ReceivableBill.amount`
- 已收金额 = `ReceivableBill.paidAmount`
- 未收金额 = `ReceivableBill.remainingAmount`

`PaymentRecord` 是收款来源，不直接等同收入；必须通过核销确认到具体账单后才反映到账单已收金额。

统计维度：

- 汇总：总应收、总已收、总未收
- 按账单类型统计
- 按账单状态统计

## 保证金池口径

统计来源：`DepositLedger`

只统计：

- `transactionStatus = CONFIRMED`
- `deletedAt IS NULL`

余额规则：

- `COLLECT` 增加余额
- `DEDUCT` 减少余额
- `REFUND` 减少余额
- `RELEASE` 减少余额
- `FREEZE` 第一版不影响可用余额

统计维度：

- 累计收取保证金
- 累计扣减保证金
- 累计退款保证金
- 当前保证金余额
- 保证金交易笔数
- 按交易类型统计

## 逾期催收口径

统计来源：

- `ReceivableBill`
- `CollectionCase`
- `CollectionAction`

逾期金额来自：

```text
billStatus = OVERDUE
remainingAmount > 0
```

统计维度：

- 逾期账单数
- 逾期金额
- 逾期订单数
- 催收案件数
- 催收中案件数
- 已关闭案件数
- 按逾期等级统计 D1-D5
- 按案件状态统计
- 催收动作数量
- 承诺付款金额

第一版逾期等级导出中的“账单数”列保留表头；当前查看 API 未提供按逾期等级分组的账单数，导出以 `-` 表示。

## 车辆资产口径

统计来源：

- `Vehicle`
- `SubscriptionOrder`
- `VehicleDelivery`
- `VehicleReturn`
- `ReceivableBill`

车辆数量按当前车辆状态统计。

出租率公式：

```text
在租车辆数 / 可运营车辆数
```

可运营车辆包含：

- `AVAILABLE`
- `REVIEW_RESERVED`
- `RESERVED`
- `LEASED`
- `RENTED`
- `RETURNED`
- `MAINTENANCE`

可运营车辆不包含已售和待退出车辆。当前 Prisma 车辆状态枚举尚无 `SOLD`，第一版已售车辆数返回 0。

收入第一版使用：

```text
ReceivableBill.paidAmount
```

车辆生命周期收益第一版只返回轻量字段：

- `totalPurchasePriceAmount`
- `totalCurrentSalePriceAmount`
- `totalPaidAmount`

## 金额单位

数据库金额单位为分。

API 查看接口返回金额单位为分，由前端展示为元。

CSV 导出面向业务人员，金额单位为元，保留 2 位小数。

## 状态中文映射注意事项

状态中文标签必须按业务域区分。

示例：

- 订单 `ACTIVE = 在租`
- 产品 / 套餐 `ACTIVE = 启用`
- 车辆 `LEASED = 已出租`

不得跨业务域复用同一个英文枚举的中文含义。

## CSV 导出说明

第一版只提供 CSV 导出，不提供 Excel xlsx。

CSV 响应：

```text
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="<file-name>.csv"
```

CSV 文件包含 UTF-8 BOM，避免 Excel 打开中文乱码。

CSV 缺失值统一使用 `-`。

CSV escape 规则覆盖逗号、换行、双引号和中文内容。

## 下钻明细与明细导出

汇总导出和明细导出是两类不同文件：

- 汇总导出：导出订单、财务、保证金池、逾期催收、车辆资产等报表的聚合结果。
- 明细导出：在经营看板 Drawer 中按当前下钻条件导出底层业务明细。

明细导出导出的是当前下钻筛选条件下的全部明细，不是 Drawer 当前分页。

明细查看 API：

- `GET /api/reports/details/orders`
- `GET /api/reports/details/bills`
- `GET /api/reports/details/deposit-ledgers`
- `GET /api/reports/details/overdue-bills`
- `GET /api/reports/details/collection-cases`
- `GET /api/reports/details/vehicles`

明细 CSV 导出 API：

- `GET /api/reports/details/orders/export`
- `GET /api/reports/details/bills/export`
- `GET /api/reports/details/deposit-ledgers/export`
- `GET /api/reports/details/overdue-bills/export`
- `GET /api/reports/details/collection-cases/export`
- `GET /api/reports/details/vehicles/export`

明细导出第一版最大导出行数为 5000 行。超过上限时返回中文错误：

```text
明细数据超过 5000 行，请缩小筛选范围后再导出。
```

明细导出权限与明细查看权限一致：

- 订单明细：`report:view`
- 账单明细：`report:finance`
- 保证金台账明细：`report:finance`
- 逾期账单明细：`report:finance` 或 `collection:view`
- 催收案件明细：`report:finance` 或 `collection:view`
- 车辆明细：`report:asset`

明细导出字段：

- 订单明细：订单编号、客户姓名、手机号、订单来源、订单状态、车辆 VIN、车牌号、车型、订阅套餐、月费、押金、合同状态、起租时间、退车时间、创建时间。
- 账单明细：账单编号、订单编号、客户姓名、账单类型、账单状态、应收金额、已收金额、剩余金额、到期日、账期开始、账期结束、创建时间。
- 保证金台账明细：台账编号、订单编号、客户姓名、交易类型、交易状态、金额、交易后余额、关联账单编号、发生时间、备注。
- 逾期账单明细：账单编号、订单编号、客户姓名、账单类型、剩余金额、到期日、逾期天数、逾期等级、案件编号、案件状态。
- 催收案件明细：案件编号、客户姓名、订单编号、逾期总金额、最大逾期天数、逾期等级、案件状态、负责人、下次跟进时间、创建时间、关闭时间。
- 车辆明细：车辆编号、VIN、车牌号、品牌、车系、车型、电池容量、电池使用方式、车辆状态、采购价、当前销售价、当前订单编号、当前客户、累计已收金额、最近交付时间、最近退车时间、创建时间。

## 权益报表口径

统计来源：

- `OrderEntitlementAccount`
- `OrderEntitlementGrant`
- `OrderEntitlementUsage`

查看 API：

- `GET /api/reports/entitlements`
- `GET /api/reports/details/entitlement-grants`
- `GET /api/reports/details/entitlement-usages`

统计周期：

- 权益账户概览按 `OrderEntitlementAccount.createdAt` 进入统计周期。
- 权益发放概览、权益类型 / 单位统计、最近用尽权益按 `OrderEntitlementGrant.createdAt` 进入统计周期。
- 权益消耗概览、消耗来源 / 状态 / 单位统计、消耗明细按 `OrderEntitlementUsage.occurredAt` 进入统计周期。
- 未传 `startDate` / `endDate` 时默认最近 30 个业务自然日。

筛选条件：

- `startDate`
- `endDate`
- `entitlementType`
- `unit`
- `grantStatus`
- `orderStatus`

权益账户统计：

- 权益账户总数 = 周期内未删除权益账户数。
- 生效中账户数 = `accountStatus = ACTIVE`。
- 暂停账户数 = `accountStatus = SUSPENDED`。
- 已关闭账户数 = `accountStatus = CLOSED`。

权益发放统计：

- 权益发放总数 = 周期内未删除权益发放记录数。
- 可用权益数 = `status = ACTIVE`。
- 已用尽权益数 = `status = EXHAUSTED`。
- 已过期权益数 = `status = EXPIRED`。
- 已取消权益数 = `status = CANCELLED`。
- 按权益类型 + 单位统计时，`totalAmount`、`usedAmount`、`remainingAmount` 只在同一单位内求和。

权益消耗统计：

- 消耗流水数 = 周期内未删除权益消耗流水数。
- 消耗总量按 `unit` 分组统计，不同单位不能直接相加。
- 消耗来源按 `usageSource` 分组：`MANUAL`、`SYSTEM`、`THIRD_PARTY`。
- 消耗状态按 `usageStatus` 分组：`CONFIRMED`、`CANCELLED`。

TEXT 权益口径：

- `unit = TEXT` 的权益只统计发放数量。
- TEXT 权益不参与余额扣减。
- TEXT 权益的 `totalAmount`、`usedAmount`、`remainingAmount` 不参与求和，报表中返回 `null` 或展示为 `-`。

当前阶段不包含：

- 权益月度续发。
- 权益过期批处理。
- 第三方权益自动发放。
- 权益调整审批。
- 权益取消 / 冲正。

## 车辆资产经营分析口径

查看 API：

- `GET /api/reports/asset-profitability/summary`
- `GET /api/reports/asset-profitability/vehicles`
- `GET /api/reports/asset-profitability/vehicles/:id`

第一版只做经营分析口径，不计算会计 ROA / ROE。

资产价值：

1. 车辆投入成本 = `Vehicle.purchasePriceAmount`。
2. 当前估值 / 当前销售价 = `Vehicle.currentSalePriceAmount`。
3. 缺失金额按 0 返回或在明细中保留 null，不因缺失数据报 500。

收入与账务：

1. 租金实收 = `ReceivableBill.billType in (FIRST_MONTHLY_FEE, MONTHLY_RENT)` 的 `paidAmount`。
2. 损伤费用实收 = `ReceivableBill.billType = DAMAGE_FEE` 的 `paidAmount`。
3. 其他实收 = `ReceivableBill.billType = OTHER` 的 `paidAmount`。
4. 押金不计入租金收入，不参与回报率。
5. 押金收取金额单独列示，第一版按 `DepositLedger.transactionType = COLLECT` 且 `transactionStatus = CONFIRMED` 统计。
6. 应收合计 = `ReceivableBill.amount`。
7. 已收合计 = `ReceivableBill.paidAmount`。
8. 未收合计 = `ReceivableBill.remainingAmount`。
9. 账单通过 `ReceivableBill.orderId -> SubscriptionOrder.vehicleId` 归属到车辆。

出租天数：

1. 只统计 `SubscriptionOrder.actualDeliveryAt` 不为空的订单。
2. 订单出租开始日 = `actualDeliveryAt` 对应业务日期。
3. 订单出租结束日 = `actualReturnAt`，如为空则使用 `SubscriptionOrder.endDate`，仍为空则使用查询 `endDate` / 今天。
4. 统计时按查询日期范围裁剪。
5. 出租天数 = 结束日 - 开始日 + 1。

可运营天数：

1. 车辆可运营起点优先取最早 `VehicleSalePriceHistory.reviewType = INITIAL_POOL` 的 `effectiveFrom`。
2. 如无 `INITIAL_POOL`，使用 `Vehicle.createdAt` 对应业务日期。
3. 第一版按查询日期范围裁剪。
4. 可运营天数 = 统计结束日 - 统计开始日 + 1。

出租率：

```text
utilizationRate = leasedDays / operatingDays
```

返回小数，例如 `0.8325`，前端后续显示为 `83.25%`。

简化经营回报率：

```text
simpleReturnRate = rentalPaidAmount / purchasePriceAmount
```

`purchasePriceAmount <= 0` 时返回 `null`。

`simpleReturnRate` 是简化经营回报率，不是会计 ROA / ROE。

完整 ROA / ROE 后续需要引入折旧、资金成本、残值、保险、维修、人工和其他费用分摊模型。

### 车辆资产经营分析导出说明

导出 API：

- `GET /api/reports/asset-profitability/summary/export`
- `GET /api/reports/asset-profitability/vehicles/export`
- `GET /api/reports/asset-profitability/vehicles/:id/export`

导出内容：

1. 汇总导出包含车辆总数、采购成本合计、当前销售价合计、租金实收、损伤费用实收、押金收取、应收、未收、总出租天数、平均出租率和平均简化经营回报率。
2. 车辆列表导出包含当前筛选条件下的全部车辆经营明细，不受页面分页影响；导出上限为 5000 行。
3. 单车详情导出包含车辆基础信息、资产价值信息、经营汇总、订单周期、账单明细、生命周期节点、损伤记录和销售价历史。
4. 导出金额单位为元，出租率和简化经营回报率按百分比展示。
5. 导出使用与页面 API 相同的统计口径，不改变资产经营分析计算逻辑。
6. `simpleReturnRate` 仍是简化经营回报率，不是会计 ROA / ROE。
7. ROA / ROE 后续需要引入折旧、资金成本、残值和费用模型后再单独定义。

## 车辆资产成本参数口径

Stage 8.2A 新增车辆资产成本参数层，用于后续资产收益试算。本阶段只维护参数和成本预览，不改变现有资产经营分析 API、页面或 CSV 导出口径。

模型：

- `VehicleAssetCostProfile`

枚举：

- `VehicleAssetCostProfileStatus.ACTIVE`：生效中。
- `VehicleAssetCostProfileStatus.INACTIVE`：已停用。
- `VehicleDepreciationMethod.STRAIGHT_LINE`：直线法。
- `VehicleDepreciationMethod.NONE`：不计提。
- `VehicleDepreciationMethod.MANUAL`：手工口径。

字段口径：

1. `depreciationMethod`：折旧方法，第一版支持直线法和不计提；`MANUAL` 可保存参数，但不生成手工折旧明细。
2. `depreciationStartDate`：折旧起算日。未传入时优先取最早 `VehicleSalePriceHistory.reviewType = INITIAL_POOL` 的 `effectiveFrom`，其次取 `Vehicle.purchaseDate`，再次取 `Vehicle.createdAt`。
3. `usefulLifeMonths`：预计使用月数，必须大于 0。
4. `residualValueAmount`：预计残值，单位为分，必须大于等于 0 且不大于 `Vehicle.purchasePriceAmount`。
5. `capitalCostRateBps`：资金成本率，单位为 bps，例如 `800 = 8.00%`；为空时 preview 按 0 处理。
6. `annualInsuranceCostAmount`：年度保险成本，单位为分；为空时 preview 按 0 处理。
7. `annualMaintenanceReserveAmount`：年度维修准备金，单位为分；为空时 preview 按 0 处理。
8. `otherMonthlyCostAmount`：其他月度成本，单位为分；为空时 preview 按 0 处理。

成本预览口径：

```text
depreciableAmount = purchasePriceAmount - residualValueAmount

monthlyDepreciationAmount =
  STRAIGHT_LINE: round(depreciableAmount / usefulLifeMonths)
  NONE: 0
  MANUAL: null

annualCapitalCostAmount = round(purchasePriceAmount * capitalCostRateBps / 10000)
monthlyCapitalCostAmount = round(annualCapitalCostAmount / 12)
monthlyInsuranceCostAmount = round(annualInsuranceCostAmount / 12)
monthlyMaintenanceReserveAmount = round(annualMaintenanceReserveAmount / 12)

estimatedMonthlyCostAmount =
  monthlyDepreciationAmount
  + monthlyCapitalCostAmount
  + monthlyInsuranceCostAmount
  + monthlyMaintenanceReserveAmount
  + otherMonthlyCostAmount
```

当 `depreciationMethod = MANUAL` 时，`monthlyDepreciationAmount = null`，`estimatedMonthlyCostAmount = null`，避免在未维护手工折旧明细时产生误导。

`estimatedMonthlyCostAmount` 只是经营分析预估成本，不构成会计凭证，不产生财务入账。本阶段不计算正式 ROA / ROE。

## Stage 8.2 ROA / ROE 试算口径

Stage 8.2B 新增资产收益试算 API：

- `GET /api/reports/asset-profitability/returns/summary`
- `GET /api/reports/asset-profitability/returns/vehicles`
- `GET /api/reports/asset-profitability/returns/vehicles/:id`

以上 API 只提供经营分析试算口径，不构成会计凭证、正式财务报表或正式 ROA / ROE。

收入试算口径：

```text
operatingRevenueAmount =
  rentalPaidAmount
  + damagePaidAmount
  + otherPaidAmount
```

其中：

1. `rentalPaidAmount` = `FIRST_MONTHLY_FEE.paidAmount + MONTHLY_RENT.paidAmount`。
2. `damagePaidAmount` = `DAMAGE_FEE.paidAmount`。
3. `otherPaidAmount` = `OTHER.paidAmount`。
4. `depositCollectedAmount` 单独列示，不计入 `operatingRevenueAmount`，不作为收益率分子。

成本试算口径来自当前 ACTIVE 且未删除的 `VehicleAssetCostProfile`。车辆没有 ACTIVE 成本参数时：

```text
costProfileMissing = true
operatingCostAmount = null
trialNetOperatingIncomeAmount = null
trialRoa = null
annualizedTrialRoa = null
```

成本按查询日期范围日折算：

```text
costStart = max(startDate, profile.depreciationStartDate)
costEnd = endDate
costDays = costEnd - costStart + 1
```

如果 `costStart > costEnd`，本期成本天数为 0。

成本拆分：

```text
depreciationCostAmount =
  STRAIGHT_LINE: round(monthlyDepreciationAmount * 12 / 365 * costDays)
  NONE: 0
  MANUAL: null

capitalCostAmount = round(annualCapitalCostAmount / 365 * costDays)
insuranceCostAmount = round(annualInsuranceCostAmount / 365 * costDays)
maintenanceReserveCostAmount = round(annualMaintenanceReserveAmount / 365 * costDays)
otherCostAmount = round(otherMonthlyCostAmount * 12 / 365 * costDays)
```

`MANUAL` 折旧第一版暂不参与 ROA 试算：

```text
manualDepreciationUnsupported = true
trialRoa = null
```

原因：

```text
MANUAL 折旧方法暂未配置手工折旧明细，无法试算 ROA。
```

经营成本：

```text
operatingCostAmount =
  depreciationCostAmount
  + capitalCostAmount
  + insuranceCostAmount
  + maintenanceReserveCostAmount
  + otherCostAmount
```

如果折旧成本等核心成本不可计算，`operatingCostAmount = null`。

试算经营净收益：

```text
trialNetOperatingIncomeAmount =
  operatingRevenueAmount - operatingCostAmount
```

试算 ROA：

```text
trialRoa = trialNetOperatingIncomeAmount / purchasePriceAmount
```

当 `purchasePriceAmount <= 0` 或 `trialNetOperatingIncomeAmount = null` 时，`trialRoa = null`。

年化试算 ROA：

```text
annualizedTrialRoa = trialRoa * 365 / analysisDays
analysisDays = endDate - startDate + 1
```

Stage 8.2 阶段 ROE 不输出试算值：

```json
{
  "roeTrial": null,
  "roeUnavailableReason": "缺少债务 / 自有资本拆分模型，暂不输出正式 ROE。"
}
```

Stage 8.3D 已在数据足够时接入经营分析试算 ROE；正式会计 ROE 仍需后续财务入账、日均权益资本和残值预测等能力。

### 资产收益试算导出说明

Stage 8.2D 新增资产收益试算 CSV 导出 API：

- `GET /api/reports/asset-profitability/returns/summary/export`
- `GET /api/reports/asset-profitability/returns/vehicles/export`
- `GET /api/reports/asset-profitability/returns/vehicles/:id/export`

导出内容：

1. 收益汇总导出包含覆盖车辆数、成本参数覆盖情况、收入指标、成本指标、试算经营净收益、试算 ROA、年化试算 ROA 和 ROE 不可用原因。
2. 车辆收益列表导出包含当前筛选条件下的全部车辆收益试算明细，不受页面分页影响；导出上限为 5000 行。
3. 单车收益详情导出包含车辆基础信息、成本参数、成本 preview、收入明细、成本拆分、收益试算、订单周期明细和账单明细。
4. 导出金额单位为元，保留 2 位小数；试算 ROA 和年化试算 ROA 按百分比展示。
5. `trialRoa` 是经营分析试算 ROA，不是正式会计 ROA。
6. `annualizedTrialRoa` 按查询天数折算年化，不代表完整生命周期收益率。
7. Stage 8.3D 之后，ROE 在数据足够时导出试算值；不可计算时继续导出 `roeUnavailableReason`。
8. 正式会计 ROE 需要后续财务入账、日均权益资本、融资还款计划和残值预测后才能输出。
9. `MANUAL` 折旧方法第一版不参与试算；导出会列示不可计算原因。
10. 试算导出只复用现有收益试算 API 口径，不改变页面和 API 统计口径，不构成会计凭证或正式财务报表。

## Stage 8.3A 资本结构与融资工具口径

Stage 8.3A 新增车辆资本结构事实数据层，用于记录车辆取得方式、车辆生命周期资本事件、外部融资工具和融资工具到车辆的分摊关系。

本阶段只建立 ROE 数据基础，不计算正式 ROE，不接入资产收益试算 API，不改变现有资产经营分析、CSV 导出、订单、账务或车辆状态机口径。

新增模型：

- `Vehicle.acquisitionMode`：车辆取得方式。
- `VehicleCapitalEvent`：车辆资本事件时间轴。
- `FinancingInstrument`：融资工具主数据。
- `FinancingInstrumentVehicle`：融资工具与车辆分摊关系。

`VehicleAcquisitionMode` 含义：

- `OWNED_CASH`：自有资金购入。
- `OWNED_FINANCED`：自有资金 + 外部融资购入。
- `LONG_TERM_LEASED`：外部长租取得。
- `MANAGED_REVENUE_SHARE`：托管收益分成取得。

`VehicleCapitalEvent` 记录车辆生命周期内资本结构变化，包括初始自有资金购入、新增债务融资、再融资、提前结清、融资解除、外部长租接入/终止、托管接入/终止和其他事件。金额字段单位均为分。

`FinancingInstrument` 记录外部融资合同或资金工具。第一版支持保存融资租赁、银行车贷、银行项目贷款、个人借款、应收账款权益质押融资、ABS / SPV 资产池融资和其他融资工具类型。

`FinancingInstrumentVehicle` 记录融资工具覆盖车辆及分摊金额。同一融资工具与同一车辆同一时间只能存在一条 `ACTIVE` 分摊。分摊金额合计不得超过融资工具 `principalAmount`。

单车资本结构预览 API：

- `GET /api/vehicles/:id/capital-structure`

第一版 preview 口径：

```text
debtPrincipalAmount =
  当前 ACTIVE financing allocations 的 allocatedPrincipalAmount 合计

equityCapitalAmount =
  当前 ACTIVE capital events 中可识别的 equityCapitalAmount 合计

capitalCoverageAmount =
  equityCapitalAmount + debtPrincipalAmount

capitalCoverageRatio =
  capitalCoverageAmount / Vehicle.purchasePriceAmount

annualDebtInterestAmount =
  sum(allocatedPrincipalAmount * instrument.annualRateBps / 10000)

monthlyDebtInterestAmount =
  annualDebtInterestAmount / 12
```

如果车辆没有融资分摊或资本事件，preview 可按 `OWNED_CASH` 给出自有资金购入的默认展示，但必须返回：

```text
roeDataReady = false
missingReasons 包含“尚未录入资本事件。”
```

preview 只是 ROE 数据准备度检查。`roeDataReady = true` 只代表车辆采购价、资本事件、资本覆盖和基础融资利率等第一版数据已满足后续试算前置条件，不代表已经输出正式 ROE。

第一版不处理：

- 订单收入收益权质押到具体订单 / 账单。
- 托管车辆分润结算。
- 外部长租固定成本结算。
- 融资还款计划、利息台账、财务入账和会计凭证。
- 市场残值样本、残值曲线、AI / ML 残值预测。
- 正式 ROE、残值敏感性分析或收益试算 API 接入。

## Stage 8.3B 收益权与托管分润口径

Stage 8.3B 新增收益权归属、质押、转让和托管/长租车辆分润规则事实数据层，用于记录订单收入或账单应收的收益权归属关系，以及托管车辆、外部长租车辆在指定期间内的分润或固定成本规则。

本阶段只做后端事实记录和 preview，不计算正式 ROE，不接入资产收益试算 API，不生成真实分润账单，不触发财务入账或会计凭证，不改变订单、车辆、账务状态机。

新增模型：

- `RevenueRightAssignment`：收益权归属、质押、转让或资产池归集记录。
- `RevenueShareRule`：托管车辆分润、外部长租车辆固定租金或固定成本规则。

`RevenueRightAssignment.targetType` 口径：

- `ORDER`：订单整体收入收益权。
- `RECEIVABLE_BILL`：具体应收账单收益权。
- `VEHICLE`：车辆维度收益权或合作归属。
- `VEHICLE_POOL`：车辆池收益权预留枚举，第一版不实现复杂车辆池模型。

`RevenueRightAssignment.assignmentType` 口径：

- `PLEDGE`：收益权质押，通常需关联 `FinancingInstrument`。
- `TRANSFER`：收益权转让，通常需关联 `FinancingInstrument`。
- `SPV_POOL`：SPV / 资产池归集，通常需关联 `FinancingInstrument`。
- `REVENUE_SHARE`：收益分成归属，主要用于托管或合作车辆。
- `OTHER`：其他手工口径。

`RevenueShareRule` 用于描述单车分润或固定成本：

- `REVENUE_SHARE`：按收益基数和 `ownerShareBps` 计算外部车主分成。
- `FIXED_RENT`：按 `fixedMonthlyAmount` 记录外部长租固定成本。
- `MIXED`：固定成本加收益分成。

分润 preview API：

- `GET /api/vehicles/:id/revenue-share-preview`

第一版支持的 `shareBasis`：

```text
RENTAL_PAID =
  FIRST_MONTHLY_FEE.paidAmount
  + MONTHLY_RENT.paidAmount

OPERATING_REVENUE =
  FIRST_MONTHLY_FEE.paidAmount
  + MONTHLY_RENT.paidAmount
  + DAMAGE_FEE.paidAmount
  + OTHER.paidAmount
```

`DEPOSIT` 不参与分润 preview，也不计入 `shareBaseAmount`。

固定成本折算：

```text
fixedCostAmount =
  round(fixedMonthlyAmount * 12 / 365 * days)
```

分润金额：

```text
ownerShareAmount =
  shareBaseAmount * ownerShareBps / 10000
  + fixedCostAmount

platformShareAmount =
  shareBaseAmount
  - shareBaseAmount * ownerShareBps / 10000
  - fixedCostAmount
```

如果 `platformShareAmount < 0`，preview 返回 warning，提示检查固定成本或分成规则。

暂不支持自动 preview 的 `shareBasis`：

- `GROSS_RECEIVABLE`：应收总额分润口径第一版暂未实现。
- `MANUAL`：手工分润口径需人工结算，暂不支持自动 preview。

本阶段不处理：

- 收益权现金流归集。
- 分润账单和真实付款。
- 应收账款融资还款计划。
- 托管分润结算台账。
- 正式 ROE 或收益试算 API 接入。

## Stage 8.3D ROE 试算口径

Stage 8.3D 将资本结构、融资工具车辆分摊、收益权 assignment 和分润规则接入资产收益试算 API。输出仍为经营分析试算 ROE，不构成会计凭证、正式财务报表或正式会计 ROE。

增强 API：

- `GET /api/reports/asset-profitability/returns/summary`
- `GET /api/reports/asset-profitability/returns/vehicles`
- `GET /api/reports/asset-profitability/returns/vehicles/:id`

收入基础继续复用 Stage 8.2B 经营收入聚合：

```text
rentalPaidAmount =
  FIRST_MONTHLY_FEE.paidAmount
  + MONTHLY_RENT.paidAmount

damagePaidAmount =
  DAMAGE_FEE.paidAmount

otherPaidAmount =
  OTHER.paidAmount

operatingRevenueAmount =
  rentalPaidAmount
  + damagePaidAmount
  + otherPaidAmount
```

`DEPOSIT` 单独列示，不计入经营收入，也不进入 ROE 分子。

收益权 assignment 对收入的处理：

- `PLEDGE`：收益权质押不代表收入所有权转移，不扣减平台经营收入；计入 `pledgedRevenueAmount` / `pledgedRevenueRatio`，作为现金流受限或质押风险提示。
- `TRANSFER`：收益权转让视为该部分收入不再归平台自由留存，按 `shareRatioBps` 扣减 `platformRetainedRevenueAmount`。
- `SPV_POOL`：SPV / 资产池归集按 `shareRatioBps` 扣减平台留存收入。
- `REVENUE_SHARE`：优先使用 `RevenueShareRule` 计算；如果只有 assignment 而没有对应分润规则，第一版只返回 warning，不自动扣减，避免重复计算。

assignment target 第一版支持：

- `RECEIVABLE_BILL`：按对应账单在查询范围内的 `paidAmount` 计算。
- `ORDER`：按该订单在查询范围内的经营类账单 `paidAmount` 计算。
- `VEHICLE`：按该车辆在查询范围内所有经营类账单 `paidAmount` 计算。
- `VEHICLE_POOL`：车辆池收益权归集暂未接入 ROE 试算，仅返回 warning。

托管分润 / 外部长租规则：

- `REVENUE_SHARE`：按 `shareBasis` 计算 `ownerShareAmount`，并从平台留存经营收入中扣减。
- `FIXED_RENT`：按查询期重叠天数折算 `externalLeaseCostAmount`，作为外部长租固定成本扣除，不从收入中扣除。
- `MIXED`：同时计算车主分成和外部长租固定成本。

分润基础：

```text
RENTAL_PAID =
  rentalPaidAmount

OPERATING_REVENUE =
  rentalPaidAmount
  + damagePaidAmount
  + otherPaidAmount
```

`GROSS_RECEIVABLE` 和 `MANUAL` 暂不支持自动 ROE 试算，会使 `roeTrial = null` 并返回 `roeMissingReasons`。

债务利息成本来自 `FinancingInstrumentVehicle` 与 `FinancingInstrument`：

```text
debtInterestCostAmount =
  allocatedPrincipalAmount
  * annualRateBps / 10000
  * overlapDays / 365
```

第一版只支持 `INTEREST_ONLY` 和 `BULLET` 的简化利息试算。`EQUAL_PRINCIPAL_INTEREST`、`EQUAL_PRINCIPAL`、`MANUAL` 暂未实现精确利息试算，会使 `roeTrial = null` 并返回原因。

资金成本避免重复计算：

- 车辆存在 ACTIVE 融资分摊时，`capitalCostSource = FINANCING_INSTRUMENT`，资金成本使用 `debtInterestCostAmount`。
- 车辆没有融资分摊时，`capitalCostSource = COST_PROFILE`，继续使用 `VehicleAssetCostProfile.capitalCostRateBps` 计算的 `capitalCostAmount`。

平台留存经营收入：

```text
platformRetainedRevenueAmount =
  operatingRevenueAmount
  - assignedOutRevenueAmount
  - ownerShareAmount
```

平台权益净收益：

```text
platformNetIncomeAmount =
  platformRetainedRevenueAmount
  - depreciationCostAmount
  - capitalCostAmount
  - insuranceCostAmount
  - maintenanceReserveCostAmount
  - otherCostAmount
  - externalLeaseCostAmount
```

权益资本基数第一版使用查询期末有效或估算口径，不做日均权益资本：

1. 如果存在有效资本事件 `equityCapitalAmount`，使用最近一条有效值。
2. 无资本事件、无融资分摊且车辆取得方式为 `OWNED_CASH` 时，按 `purchasePriceAmount` 作为全自有资金假设，并返回 warning。
3. 有融资分摊但缺少显式自有资金资本事件时，按 `max(purchasePriceAmount - debtPrincipalAmount, 0)` 估算权益资本，并返回 warning。
4. 权益资本基数缺失或小于等于 0 时，`roeTrial = null`。

ROE 试算：

```text
roeTrial =
  platformNetIncomeAmount / roeEquityBaseAmount

annualizedRoeTrial =
  roeTrial * 365 / analysisDays
```

当成本、债务利息、分润规则或权益资本基数不可计算时，`roeTrial = null`，并通过 `roeMissingReasons` 返回原因；非阻断性假设通过 `roeWarnings` 返回。

## Stage 8.4A 市场残值样本库口径

Stage 8.4A 新增市场价格样本库后端，用于沉淀外部市场挂牌价、成交价、拍卖价、经销商报价、内部处置成交价和人工调研样本。本阶段只建立样本事实表和 CSV 文本导入能力，不生成残值曲线，不做爬虫，不接第三方平台 API，不做 AI / ML，不接入 ROA / ROE 试算。

### 与 Vehicle.currentSalePriceAmount 的区别

`Vehicle.currentSalePriceAmount` 是内部运营当前销售价 / 当前估值，继续用于报价上限、车辆入池、再入池定价和资产经营分析。

`VehicleMarketPriceObservation` 是外部市场价格样本，记录某一来源、日期、车型、里程、车龄、地区和价格类型下的一条市场观测事实。

市场价格样本不会自动覆盖 `Vehicle.currentSalePriceAmount`。后续即使生成残值曲线或残值预测，也必须通过独立审核或定价流程接入内部估值。

### 数据模型

- `MarketPriceImportBatch`：一次 CSV 文本导入批次，记录来源、文件名、导入人、总行数、成功行、跳过行、失败行、导入状态、失败摘要和导入配置快照。
- `VehicleMarketPriceObservation`：一条市场价格样本，记录来源、外部 listing ID、观测日期、品牌、车系、车型、年款、配置、电池、里程、上牌日期、车龄、地区、价格类型、价格金额、卖家类型、车况、电池健康度、事故标识、URL hash、去重 key、质量评分和样本状态。

金额单位：

- 后端 API 手工创建金额字段使用分。
- CSV 导入文件中的金额字段使用元，后端入库时转为分。
- 数据库存储金额统一为分。

### CSV 文本导入字段

必填英文表头：

```text
observedAt
brand
model
priceType
priceAmount
```

可选英文表头：

```text
sourceListingId
series
modelYear
trim
batteryCapacityKwh
batteryUsageType
mileageKm
registrationDate
vehicleAgeMonths
province
city
listingPriceAmount
transactionPriceAmount
listingDays
sellerType
conditionGrade
batteryHealthPercent
accidentFlag
sourceUrl
remark
```

日期格式为 `YYYY-MM-DD`。`accidentFlag` 支持 `true / false`、`1 / 0`、`yes / no`、`是 / 否`。CSV parser 支持 UTF-8 BOM、逗号、双引号、字段内换行和空值。

CSV 枚举字段需填写英文枚举值：

- `batteryUsageType`：`BUYOUT`（买断）、`BAAS`（BaaS）。
- `priceType`：`LISTING`（挂牌价）、`TRANSACTION`（成交价）、`AUCTION`（拍卖价）、`DEALER_QUOTE`（经销商报价）、`INTERNAL_SALE`（内部成交价）、`ESTIMATE`（估算价）。
- `sellerType`：`INDIVIDUAL`（个人）、`DEALER`（经销商）、`PLATFORM`（平台）、`AUCTION_HOUSE`（拍卖机构）、`INTERNAL`（内部）、`UNKNOWN`（未知）。

CSV 文件是纯文本格式，不能像 xlsx 一样内置下拉选项或单元格校验。前端 CSV 导入弹窗会展示并支持复制上述枚举取值，降低人工填写错误。

### 去重口径

第一优先级：存在 `sourceListingId` 时：

```text
dedupeKey = source + ":" + normalized(sourceListingId)
```

第二优先级：不存在 `sourceListingId` 时：

```text
dedupeKey =
  source
  + observedAt 业务日期
  + brand
  + series
  + model
  + modelYear
  + mileageKm
  + city
  + priceType
  + priceAmount
```

归一化规则为 trim、lowercase、空值使用 `-`、日期使用 `YYYY-MM-DD`、金额使用分。数据库对 active 样本增加 partial unique index：`deleted_at IS NULL AND observation_status = 'ACTIVE'`。CSV 导入遇到重复样本跳过；手工创建遇到重复样本返回中文错误。

### confidenceScore 口径

第一版质量评分范围为 0-100：

```text
基础 40 分
有 brand + model：+10
有 observedAt：+10
有 priceAmount：+10
有 mileageKm：+10
有 registrationDate 或 vehicleAgeMonths：+10
有 batteryCapacityKwh：+5
有 city：+5
```

`priceAmount <= 0` 或必填字段缺失时，样本无效，不入库。

### 当前阶段不做

Stage 8.4A 不做前端页面、不做爬虫、不做定时采集、不接第三方平台 API、不做 AI / ML、不生成残值曲线、不接入 ROE、不修改 `Vehicle.currentSalePriceAmount`、不修改资产经营分析口径、不做 Excel xlsx、不做 multipart 文件上传。

后续 Stage 8.4B 建设市场价格样本库前端页面；Stage 8.4C 再基于样本库生成残值曲线。

## Stage 8.4B 市场残值样本库前端使用说明

Stage 8.4B 新增 `/residual-market` 前端页面，并在“车辆资产 -> 市场残值样本”菜单下展示。页面只调用 Stage 8.4A 已有后端 API，不新增模型、不新增 migration、不生成残值曲线，不接入 ROE。

页面包含两个页签：

- 市场价格样本：查看样本列表、按来源/价格类型/状态/品牌/车系/车型/年款/城市/观测日期/里程/价格筛选、查看详情、手工录入样本、CSV 文本导入、作废样本。
- 导入批次：查看 CSV 导入批次列表、按来源/导入状态/创建日期筛选、查看批次详情、错误摘要和导入配置快照。

CSV 模板字段：

```text
observedAt,sourceListingId,brand,series,model,modelYear,trim,batteryCapacityKwh,batteryUsageType,mileageKm,registrationDate,vehicleAgeMonths,province,city,priceType,priceAmount,listingPriceAmount,transactionPriceAmount,listingDays,sellerType,conditionGrade,batteryHealthPercent,accidentFlag,sourceUrl,remark
```

前端页面金额输入统一按元填写；CSV 导入金额字段也按元填写。后端 API 手工创建和数据库入库仍按分处理，前端提交前会转换为分。必填字段为 `observedAt`、`brand`、`model`、`priceType`、`priceAmount`。

作废样本不会物理删除记录，状态更新为 `VOIDED`。作废后的样本后续不参与残值曲线统计，但仍保留导入批次、原始快照、去重 key 和审计记录。

当前阶段仍不做爬虫、不做定时采集、不接第三方平台 API、不做 AI / ML、不生成残值曲线、不接入 ROE、不修改 `Vehicle.currentSalePriceAmount`，也不做 multipart 文件上传或 Excel xlsx 导入。

## Stage 8.4C-A 残值曲线生成口径

Stage 8.4C-A 新增残值曲线后端生成能力。曲线基于 `VehicleMarketPriceObservation` 市场价格样本生成，属于外部市场观测数据的统计结果，不是内部运营当前销售价，也不会自动覆盖 `Vehicle.currentSalePriceAmount`。

样本范围：

- 只使用 `observationStatus = ACTIVE` 且 `deletedAt IS NULL` 的市场样本。
- `VOIDED` / `IGNORED` 样本不参与残值曲线统计。
- 默认价格类型包含 `TRANSACTION`、`AUCTION`、`DEALER_QUOTE`、`INTERNAL_SALE`、`LISTING`，生成请求可显式传入 `priceTypes`。
- 维度必须包含 `brand`、`model`，可选匹配 `series`、`modelYear`、`trim`、`batteryCapacityKwh`、`batteryUsageType`。

聚合口径：

- 第一版按 `ageMonth` 聚合生成曲线点。
- `ageMonth` 优先使用样本的 `vehicleAgeMonths`；为空时由 `observedAt` 与 `registrationDate` 推算月份差。
- 无法得到有效 `ageMonth` 的样本会被跳过，并进入 skipped reason。
- 第一版不按里程桶生成曲线，`mileageBucketStartKm` / `mileageBucketEndKm` 为空；曲线点快照保留该月龄样本的里程分布。
- 每个 `ageMonth` 的样本数低于 `minSamplePerPoint` 时不生成曲线点。

统计指标：

- `medianPriceAmount`：价格中位数。
- `p25PriceAmount` / `p75PriceAmount`：简单 percentile 计算的 P25 / P75。
- `averagePriceAmount`：样本价格平均值，四舍五入到整数分。
- `predictedResidualAmount` 第一版等于 `medianPriceAmount`。
- `lowerBoundAmount` 第一版等于 `p25PriceAmount`。
- `upperBoundAmount` 第一版等于 `p75PriceAmount`。
- `referencePriceAmount` 仅用于计算 `predictedResidualRateBps = medianPriceAmount / referencePriceAmount * 10000`；未传入时残值率为空，不阻止曲线生成。
- 曲线点 `confidenceScore` 基于样本 confidence 平均值和样本数计算；曲线整体 confidence 为各曲线点 confidence 平均值。

版本和状态：

- 正式生成的曲线初始状态为 `DRAFT`。
- `dryRun = true` 时只返回预览，不写入数据库，也不写审计日志。
- 启用曲线时，同一 `brand + series + model + modelYear + trim + batteryCapacityKwh + batteryUsageType` 维度下旧 `ACTIVE` 曲线会改为 `SUPERSEDED`。
- 归档曲线只更新状态为 `ARCHIVED` 并写入 `effectiveTo`，不物理删除曲线和曲线点。

前端使用说明：

- 残值曲线在 `/residual-market` 市场残值样本页面的“残值曲线”Tab 中查看和生成。
- 生成前可先执行 dryRun 试算，预览匹配样本数、生成点数、跳过样本数和曲线点统计。
- 正式生成只创建 `DRAFT` 曲线和曲线点，不会自动启用。
- 曲线启用后才会成为 `ACTIVE`；启用时同维度旧 `ACTIVE` 会变为 `SUPERSEDED`。
- 归档曲线不会物理删除记录，也不会删除曲线点。
- 前端参考价格按元输入，提交给后端时转换为分。
- 当前前端只展示统计中位数曲线，不做 AI / ML，不覆盖 `Vehicle.currentSalePriceAmount`，不接入 ROE。

当前阶段不做 AI / ML，不做 `ResidualModelRun`，不做单车残值预测，不接入 ROE，不修改 `Vehicle.currentSalePriceAmount`，不修改资产经营分析口径，不做爬虫、定时采集或第三方平台 API。

## Stage 8.3F ROE 试算导出说明

Stage 8.3F 将 Stage 8.3D / 8.3E 的 ROE 试算字段同步到收益试算 CSV 导出。导出仍为经营分析试算口径，不构成会计凭证、正式财务报表或正式会计 ROE。

更新的导出 API：

- `GET /api/reports/asset-profitability/returns/summary/export`
- `GET /api/reports/asset-profitability/returns/vehicles/export`
- `GET /api/reports/asset-profitability/returns/vehicles/:id/export`

汇总导出新增内容：

- ROE 覆盖情况：`roeCalculatedVehicleCount`、`roeUnavailableVehicleCount`。
- 平台留存收入：`assignedOutRevenueAmount`、`pledgedRevenueAmount`、`ownerShareAmount`、`platformRetainedRevenueAmount`。
- 债务和资本结构：`debtPrincipalAmount`、`debtInterestCostAmount`、`roeEquityBaseAmount`、`capitalCostSource`。
- ROE 收益指标：`platformNetIncomeAmount`、`roeTrial`、`annualizedRoeTrial`。
- `roeMissingReasons` 和 `roeWarnings` 会逐条导出。

车辆列表导出新增内容：

- 平台留存经营收入、转让 / 入池外流收入、质押收入金额、车主分润金额。
- 债务利息成本、外部长租固定成本、债务本金、权益资本基数、资金成本来源。
- 平台权益净收益、试算 ROE、年化试算 ROE。
- ROE 状态、不可计算原因、提示信息。

单车详情导出新增内容：

- 平台留存收入分段。
- 资本结构摘要。
- 融资工具分摊明细。
- 收益权 assignment 明细。
- 分润规则摘要。
- ROE 试算明细中的平台权益净收益、ROE 状态、不可计算原因和提示信息。

导出口径说明：

- `PLEDGE` 不扣减平台收入，只导出为质押收入金额 / 受限现金流提示。
- `TRANSFER` / `SPV_POOL` 扣减平台留存收入，并进入转让 / 入池外流收入。
- `REVENUE_SHARE` 通过 `RevenueShareRule` 扣减车主分润。
- `FIXED_RENT` 作为外部长租固定成本导出，不从收入中扣减。
- `DEPOSIT` 继续单独列示，不计入经营收入或 ROE 分子。
- 有真实融资分摊时，资金成本来源为融资工具，导出债务利息成本，避免重复使用成本参数资金成本。
- `GROSS_RECEIVABLE`、`MANUAL` 分润以及暂不支持的还款方式会使 ROE 状态为暂不可用，并在不可计算原因中列示。

CSV 格式约定：

- 金额按元导出，保留两位小数。
- ROA / ROE 按百分比导出。
- 状态和枚举中文化。
- 缺失值导出为 `-`。

## ROA / ROE

当前阶段不计算正式会计 ROA / ROE。

正式 ROA / ROE 后续需要引入：

- 资金成本
- 折旧
- 车辆生命周期累计收入
- 残值
- 运营费用

以上能力建议放入 Stage 8 资产经营分析深化。
