# 报表口径文档

本文档固化 Stage 7.6 经营报表与 CSV 导出的第一版口径。当前报表面向后台运营、财务和资产管理角色，提供实时聚合查询与轻量 CSV 导出。

## Stage 10X-F 车型主数据说明

车型主数据接入状态：

```text
Stage 10X-E: Product / Portal / Reports 已支持 modelDefinitionId、modelDisplayName 和 legacy fallback
Stage 10X-F: Residual market / residual forecast / valuation review 已支持 modelDefinitionId 展示和筛选
```

本阶段不修改既有经营报表主口径，不重算历史 residual forecast，不自动 adopt residual，不更新车辆当前销售价，也不改变 ROE / 折旧 / BaaS 计算公式。

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

## Stage 10N-C-A 车辆折旧基础台账

Stage 10N-C-A 已新增正式折旧基础模型：

- `VehicleDepreciationPolicy`
- `VehicleDepreciationSchedule`
- `VehicleDepreciationRecord`

本阶段口径：

1. 主 ROE 后续先采用会计折旧。
2. 会计折旧默认采用直线法。
3. `MANUAL` 折旧通过月度折旧 record 补录解决。
4. 后续接入 ROE 时，折旧按 `periodStart` / `periodEnd` 归属，跨期按天分摊。

本阶段仅建立 policy / schedule / record 和后台管理能力，不接入资产收益主口径：

- 不修改 `platformNetIncomeAmount`。
- 不修改 `roeTrial`。
- 不修改 `annualizedRoeTrial`。
- 不修改 `trialRoa`。
- 不修改既有 `VehicleAssetCostProfile` 即时折旧试算。

直线法 schedule 生成以月为最小计划单位，第一期从 `depreciationStartDate` 到当月月末，后续按自然月生成；金额按分取整，余数放入最后一期，保证 schedule 合计等于 `depreciationBasisAmount - residualValueAmount`。

后续 Stage 10N-C-B 再确认是否仅使用 `CONFIRMED` / `LOCKED` depreciation records 接入资产收益主口径。

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

## Stage 8.4D-A 单车残值预测口径

Stage 8.4D-A 新增单车残值预测后端能力。预测基于具体 `Vehicle` 和已启用的 `VehicleResidualCurve` / `VehicleResidualCurvePoint`，第一版只使用统计残值曲线，不使用 AI / ML，也不生成 `ResidualModelRun`。

曲线匹配：

- 默认只匹配 `curveStatus = ACTIVE` 且 `deletedAt IS NULL` 的残值曲线。
- 车辆必须至少能提供 `brand` 和 `model`，并按 `series`、`modelYear`、`batteryCapacityKwh`、`batteryUsageType` 等维度计算匹配分。
- 如请求显式传入 `curveId`，dryRun 可使用 `DRAFT` 或 `ACTIVE` 曲线；正式生成只允许使用 `ACTIVE` 曲线。
- 找不到匹配的生效曲线时，不生成预测记录。

车辆车龄和 horizon：

- `Vehicle.registrationDate` 在车辆台账中定义为“初次上牌日期”，用于单车残值预测车龄计算。
- `Vehicle.latestRegistrationDate` 定义为“最近一次上牌日期”，用于记录过户、换牌等最近登记时间；当前不参与残值预测车龄计算。
- 车辆必须有 `registrationDate`；单车残值预测不会用 `purchaseDate` 或 `latestRegistrationDate` 代替初次上牌日期。
- `vehicleAgeMonths` 由 `asOfDate` 与 `registrationDate` 的月份差计算。
- 默认预测 horizon 为 `0 / 6 / 12 / 24 / 36` 月；请求可传入最多 10 个非负整数 horizon。
- 每个预测点的 `targetAgeMonth = vehicleAgeMonths + horizonMonth`，`targetDate = asOfDate + horizonMonth`。

曲线点匹配和插值：

- 若曲线存在同 `targetAgeMonth` 点，使用 `EXACT` 精确匹配。
- 若不存在精确点，但目标月龄两侧都有曲线点，则使用 `LINEAR_INTERPOLATION` 对预测残值、上下界和置信度做线性插值。
- 若目标月龄超出曲线范围，状态为 `UNSUPPORTED`，第一版不做外推，避免给出误导性残值。

金额和残值率：

- 所有后端金额字段仍以分为单位。
- 单车预测点的 `predictedResidualRateBps` 使用 `predictedResidualAmount / Vehicle.purchasePriceAmount * 10000` 计算。
- 如果车辆采购价为空或小于等于 0，或预测残值为空，则单车残值率为空。
- 不直接使用曲线点上的 `predictedResidualRateBps`，因为曲线残值率可能基于曲线生成时的 `referencePriceAmount`。

人工采用：

- 可对支持的预测点记录 `adoptedResidualAmount`、`adoptedBy`、`adoptedAt` 和 `adoptRemark`。
- 采用预测点只更新 `VehicleResidualForecastPoint` 和预测记录状态，不覆盖 `Vehicle.currentSalePriceAmount`。
- `UNSUPPORTED` 点不能被采用。
- 本阶段不修改 `VehicleSalePriceHistory`，不自动进入资产经营分析或 ROE。

Stage 8.4D-B 前端使用说明：

- 车辆详情页在有 `residual_forecast:view` 权限时展示“残值预测”区块，加载最新预测和预测历史。
- 车辆新增 / 编辑表单维护“初次上牌日期”和“最近一次上牌日期”；生成预测前请先补齐初次上牌日期。
- 生成预测支持 dryRun 试算；试算只展示匹配曲线、车辆快照和预测点预览，不保存预测记录。
- 正式生成会保存预测记录和预测点，但不会覆盖 `Vehicle.currentSalePriceAmount`，也不会写入 `VehicleSalePriceHistory`。
- 人工采用预测点时，页面按元输入采用残值，提交给后端按分保存；采用值只保存在预测点上。
- 作废预测不会物理删除记录，只把预测记录标记为不可作为有效预测参考。
- 页面展示金额时按元展示，残值率按 bps 转百分比展示，缺失值统一显示为 `-`。
- 当前不接入 ROE，不使用 AI / ML，不修改资产收益试算口径。

当前阶段仍不做 AI / ML、不接入 ROE、不修改 `Vehicle.currentSalePriceAmount`、不修改 `VehicleSalePriceHistory`、不改资产收益试算口径、不做爬虫、定时采集或第三方平台 API。

## Stage 8.4D-C 残值预测接入资产收益试算口径

Stage 8.4D-C-A 将单车残值预测接入资产收益试算 API，作为残值敏感性分析输入。该能力服务于经营分析试算，不构成正式会计估值、正式减值测试、正式 ROE 或会计凭证。

增强 API：

- `GET /api/reports/asset-profitability/returns/summary`
- `GET /api/reports/asset-profitability/returns/vehicles`
- `GET /api/reports/asset-profitability/returns/vehicles/:id`

查询参数：

- `residualHorizonMonth`：选择未来 N 个月预测点用于残值敏感性展示，默认 `12`，范围 `0 - 120`。
- `residualCalibrationPercent`：Stage 10N-C-C 新增的市场残值校准比例，默认 `0`，范围 `-30 - 30`；超出范围返回 `400`。

残值预测选择规则：

- 来源为 `VehicleResidualForecast` 和 `VehicleResidualForecastPoint`。
- 只使用 `forecastStatus IN (GENERATED, ADOPTED)` 且未删除的预测记录，排除 `VOIDED` / `ARCHIVED`。
- 优先选择最新 `ADOPTED` forecast；没有时选择最新 `GENERATED` forecast。
- 在选中的 forecast 中只查找 `horizonMonth = residualHorizonMonth` 的预测点；本阶段不对预测点再次插值。
- 预测点金额优先使用 `adoptedResidualAmount`，否则使用 `predictedResidualAmount`。

新增残值字段口径：

- `forecastResidualAmount`：本次试算展示的预测残值，来源为人工采用值或曲线预测值。
- `forecastResidualAmountSource`：`ADOPTED` 表示人工采用值，`PREDICTED` 表示曲线预测值。
- `residualDeltaToCurrentSalePriceAmount = forecastResidualAmount - Vehicle.currentSalePriceAmount`。
- `costProfileResidualValueAmount` 来自当前 ACTIVE `VehicleAssetCostProfile.residualValueAmount`。
- `residualDeltaToCostProfileAmount = forecastResidualAmount - costProfileResidualValueAmount`。
- `residualSensitivityNetIncomeAmount = platformNetIncomeAmount + residualDeltaToCostProfileAmount`。
- `residualSensitivityRoeTrial = residualSensitivityNetIncomeAmount / roeEquityBaseAmount`。
- `residualSensitivityAnnualizedRoeTrial = residualSensitivityRoeTrial * 365 / analysisDays`。

主口径不变：

- `platformNetIncomeAmount`、`roeTrial`、`annualizedRoeTrial`、`trialRoa`、`annualizedTrialRoa` 仍保持 Stage 8.3D 主口径。
- `residualSensitivityRoeTrial` 只是残值敏感性分析，不是主 ROE。
- 本阶段不修改 `Vehicle.currentSalePriceAmount`，不写 `VehicleSalePriceHistory`，不自动采用预测点，不自动修改 `VehicleAssetCostProfile.residualValueAmount`，不做 AI / ML。

前端展示口径：

- `/reports/asset-profitability` 的“收益试算”Tab 可选择 `residualHorizonMonth`，默认展示未来 `12` 个月预测点。
- Stage 10N-C-C 起可选择 `residualCalibrationPercent`，用于模拟市场残值上调或下调。
- 页面同时展示主 `roeTrial` / `annualizedRoeTrial` 与 `residualSensitivityRoeTrial` / `residualSensitivityAnnualizedRoeTrial`。
- 残值敏感性 ROE 不改变主 ROE，仅用于观察采用残值预测后对收益试算的影响。
- 市场校准 ROE 不改变主 ROE，仅用于观察残值校准后的经营分析对比。
- 车辆列表展示残值预测可用状态、预测残值、预测值来源、相对成本参数残值差异和残值敏感性 ROE；不可用车辆展示不可用原因。
- 单车收益详情展示残值预测摘要、预测点、曲线摘要、残值差异和残值敏感性 ROE。
- 页面展示预测残值不会覆盖车辆当前销售价，也不会写入销售价历史。

### Stage 10N-C-C 市场校准折旧 / 残值滑块对比

Stage 10N-C-C 在会计折旧主口径旁新增市场校准折旧对比。该口径复用残值预测和残值敏感性基准，不修改主 `platformNetIncomeAmount`、`roeTrial`、`annualizedRoeTrial`、`trialRoa`。

市场残值基准：

- 优先使用 `adoptedResidualAmount`。
- 其次使用 `predictedResidualAmount`。
- 缺少可用残值时返回 `marketCalibrationUnavailableReason`。

公式：

```text
marketCalibratedResidualAmount =
  marketResidualBaseAmount * (1 + residualCalibrationPercent / 100)

marketResidualDeltaAmount =
  marketCalibratedResidualAmount - VehicleAssetCostProfile.residualValueAmount

marketCalibratedPlatformNetIncomeAmount =
  platformNetIncomeAmount + marketResidualDeltaAmount
```

新增 summary 字段：

- `marketCalibratedVehicleCount`
- `marketCalibratedUnavailableVehicleCount`
- `marketResidualBaseAmount`
- `marketCalibratedResidualAmount`
- `marketResidualDeltaAmount`
- `marketCalibratedPlatformNetIncomeAmount`
- `marketCalibratedRoeTrial`
- `marketCalibratedAnnualizedRoeTrial`
- `marketCalibratedTrialRoa`
- `residualCalibrationPercent`

车辆列表与单车详情新增市场残值来源、市场残值基准、校准后残值、残值差异、市场校准净收益、市场校准 ROE / ROA 和不可用原因。CSV 同步新增“市场校准折旧 / 残值校准”字段。

### Stage 8.4D-C-C 残值敏感性 CSV 导出口径

Stage 8.4D-C-C 将收益试算页面的信息架构同步到 CSV 导出，只增强导出内容和前端导出参数，不改变主 ROE、残值敏感性 ROE、收益、成本或残值预测选择口径。

更新的导出 API：

- `GET /api/reports/asset-profitability/returns/summary/export`
- `GET /api/reports/asset-profitability/returns/vehicles/export`
- `GET /api/reports/asset-profitability/returns/vehicles/:id/export`

导出参数：

- 前端导出会继续携带统计周期、车型、车辆状态、排序等既有筛选。
- 收益试算导出额外携带 `residualHorizonMonth`，默认 `12`，用于指定本次 CSV 中展示的残值预测周期。
- Stage 10N-C-C 起收益试算导出同时携带 `residualCalibrationPercent`，用于输出市场校准折旧对比字段。

收益汇总 CSV 按页面结构分段输出：

- 标题与筛选条件：统计周期、残值预测周期、车型筛选和车辆状态筛选。
- 核心结果：平台权益净收益、主试算 ROE、年化主试算 ROE、残值敏感性净收益、残值敏感性 ROE、年化残值敏感性 ROE、市场校准净收益、市场校准 ROE 和 ROE 状态。
- 数据完整性 / 可计算性：车辆总数、成本参数覆盖、成本可计算覆盖、ROE 可计算覆盖和残值预测覆盖情况。
- 收入归属：租金实收、损伤实收、其他实收、经营收入合计、转让 / 入池外流收入、质押收入金额、车主分润金额、平台留存经营收入和押金收取。
- 成本与资本结构：折旧成本、资金成本、债务利息成本、保险成本、维修准备金、其他成本、外部长租固定成本、经营成本合计、债务本金、权益资本基数和资金成本来源。
- 资产价值与残值敏感性：预测残值合计、预测下界合计、预测上界合计、相对当前销售价差异、相对成本参数预计残值差异、残值敏感性净收益和残值敏感性 ROE。
- 市场校准折旧 / 残值校准：残值校准比例、市场校准车辆数、市场残值基准合计、校准后残值合计、市场残值差异合计、市场校准净收益、市场校准 ROE / ROA。
- 计算链路 / 钩稽关系：导出经营收入、平台留存经营收入、经营成本、平台权益净收益、主 ROE、残值敏感性净收益和残值敏感性 ROE 的公式说明。
- 不可用原因 / warnings：逐条导出 ROE 不可用原因、ROE 试算提示和残值预测提示。

车辆收益列表 CSV 新增残值敏感性字段：

- 残值预测状态、残值预测周期、预测值来源。
- 预测残值、预测下界、预测上界、预测残值率。
- 相对当前销售价差异、相对成本参数残值差异。
- 残值敏感性净收益、残值敏感性 ROE、年化残值敏感性 ROE。
- 残值来源、残值校准比例、市场残值基准、校准后残值、残值差异、市场校准平台净收益、市场校准 ROE / ROA、市场校准不可用原因。
- 不可计算原因会合并 ROE 不可计算原因和残值预测不可用原因；提示信息会合并 ROE warnings 和残值预测 warnings。

单车收益详情 CSV 新增分段：

- 残值预测敏感性：预测状态、预测编号、预测方法、预测基准日、预测周期、目标日期、引用曲线编号、预测值来源、预测残值、预测区间和置信度。
- 残值差异：当前内部销售价、成本参数预计残值、预测残值、相对当前销售价差异和相对成本参数残值差异。
- 残值敏感性收益：主平台权益净收益、残值敏感性净收益、主试算 ROE、残值敏感性 ROE、主年化试算 ROE和年化残值敏感性 ROE。
- 市场校准折旧说明：会计残值基准、市场残值基准、校准后残值、残值差异、会计 ROE、市场校准 ROE、会计 ROA、市场校准 ROA 和不可用原因。
- 残值敏感性说明：导出残值敏感性净收益和残值敏感性 ROE 的公式，并明确残值敏感性 ROE 不改变主试算 ROE。

CSV 格式约定：

- 金额按元导出，保留两位小数。
- `roeTrial` / `residualSensitivityRoeTrial` 按小数转百分比导出。
- `forecastResidualRateBps` 按 bps 转百分比导出。
- `ADOPTED` 导出为“人工采用”，`PREDICTED` 导出为“曲线预测”。
- 缺失值导出为 `-`，数组内容使用中文分号拼接。
- 导出不会修改 `Vehicle.currentSalePriceAmount`，不会写入 `VehicleSalePriceHistory`，不会自动采用预测点，也不做 AI / ML。

## Stage 8.4E-A 残值模型运行记录口径

Stage 8.4E-A 新增 `ResidualModelRun` 与 `ResidualModelRunOutput`，用于记录残值预测模型、统计基线或外部模型的运行批次、版本、样本范围、特征快照、参数快照、指标快照和输出关联。本阶段只建设模型治理与追溯底座，不代表系统已经内置真实训练平台。

模型运行记录定位：

- `ResidualModelRun` 是模型运行批次 / 模型实验 / 模型推理 / 统计基线的治理记录。
- 本阶段不执行真实 AI / ML 训练，不调用 Python 脚本，不调用第三方模型 API，不做爬虫或定时采集。
- `runType` 用于区分统计基线、机器学习训练、机器学习推理、手工导入和外部模型。
- `algorithm` 用于记录算法标签，例如统计中位数、线性回归、随机森林、梯度提升、外部模型或未知算法；这些枚举只做记录，不引入对应 ML 依赖。
- `modelName` / `modelVersion` / `modelProvider` 用于标识模型名称、版本和提供方，方便后续追溯某条曲线或预测来自哪个版本。

快照字段口径：

- `featureSnapshot`：记录本次运行使用或声明的特征集合，例如车龄、里程、电池容量、地区、价格类型等。
- `parameterSnapshot`：记录本次运行参数，例如最小样本数、价格类型范围、是否使用里程桶等。
- `filterSnapshot`：记录样本筛选条件，例如品牌、车系、车型、年款、电池规格、训练样本日期范围等。
- `metricsSnapshot`：记录运行完成后的指标快照，例如 MAE、RMSE、MAPE、样本覆盖率等。
- `outputSnapshot`：记录输出汇总，例如输出曲线数、输出单车预测数、指标报告摘要等。
- `errorSnapshot`：记录失败原因、错误码或异常摘要。

输出关联口径：

- `ResidualModelRunOutput` 用于关联某次运行产生或登记的输出。
- 输出可以关联 `VehicleResidualCurve`、`VehicleResidualForecast` 或具体 `Vehicle`。
- 输出记录只表示治理层面的关联，不会自动生成残值曲线，也不会自动生成单车残值预测。
- 输出状态第一版只有 `ACTIVE` / `VOIDED`，用于保留历史追溯，不做物理删除。

状态流转口径：

- 创建运行记录时，初始状态只允许 `CREATED` 或 `RUNNING`。
- `CREATED` / `RUNNING` 可以标记为 `COMPLETED`，完成时可写入指标快照、输出快照并创建输出关联。
- 未完成且未取消的运行可以标记为 `FAILED`，失败时写入错误快照。
- `CREATED` / `RUNNING` 可以取消为 `CANCELLED`。
- 已完成的运行不能重复完成、失败或取消。

边界说明：

- 模型运行记录不会修改 `Vehicle.currentSalePriceAmount`。
- 模型运行记录不会写入 `VehicleSalePriceHistory`。
- 模型运行记录不会接入 ROE 计算，也不改变资产收益试算口径。
- 后续阶段可以在该治理底座上接入真实训练脚本、第三方模型或模型文件管理。

Stage 8.4E-B 前端使用说明：

- 模型运行记录在 `/residual-market` 的“模型运行记录”Tab 中查看，与市场价格样本、导入批次和残值曲线放在同一业务链路下。
- `residual_model_run:view` 控制 Tab、列表和详情访问；`residual_model_run:manage` 控制新增运行记录、标记完成、标记失败和取消运行。
- 新增模型运行记录只登记运行批次、模型版本、样本范围、特征快照、参数快照和筛选快照，不会触发真实训练。
- 标记完成只记录 `metricsSnapshot`、`outputSnapshot` 和输出关联，输出关联只是治理关系，不会自动生成残值曲线或单车预测。
- 标记失败记录 `errorSnapshot`；取消运行只改变运行状态，不物理删除记录。
- JSON 快照在前端以折叠区展示，提交前会校验 JSON 格式，避免非法快照进入后端。
- 本阶段不调用 AI / ML，不调用 Python 或第三方模型 API，不修改 `Vehicle.currentSalePriceAmount`，不写入 `VehicleSalePriceHistory`，也不接入 ROE。

## Stage 8.4E-C ResidualModelRun 与残值曲线生成联动口径

Stage 8.4E-C-A 将统计残值曲线正式生成纳入 `ResidualModelRun` 治理链路。统计中位数曲线生成可以被登记为一次 `STATISTICAL_BASELINE` 模型运行，但这仍然不是 AI / ML 训练，也不会调用 Python、第三方模型或外部模型服务。

曲线生成与模型运行记录：

- `POST /api/residual-market/curves/generate` 在 `dryRun = false` 时可传入 `modelRunId` 关联已有 `ResidualModelRun`。
- 关联已有运行记录时，只允许 `CREATED` / `RUNNING` 状态；成功生成曲线后，该运行记录会更新为 `COMPLETED`，写入 `finishedAt`、`metricsSnapshot`、`outputSnapshot`、`filterSnapshot` 和 `parameterSnapshot`。
- 已有运行记录如果填写了目标品牌、车系、车型、年款、版本、电池容量或电池使用方式，则这些目标维度必须与本次曲线生成条件一致。
- `dryRun = false` 且 `autoCreateModelRun = true` 时，系统会自动创建一条 `STATISTICAL_BASELINE` / `STATISTICAL_MEDIAN` 的 `ResidualModelRun`，并立即标记为 `COMPLETED`。
- 自动创建模型运行记录时，`modelVersion` 可由请求传入；未传时使用 `statistical-baseline-YYYYMMDDHHmmss`。
- 自动创建模型运行记录时，`modelProvider` 默认 `internal`，`artifactUri` 只记录引用地址，不上传模型文件。

输出关联：

- 正式生成曲线并关联或自动创建模型运行记录时，会创建一条 `ResidualModelRunOutput`。
- 输出记录使用 `outputType = RESIDUAL_CURVE`、`outputStatus = ACTIVE`，并关联新生成的 `VehicleResidualCurve`。
- `outputNo` 使用曲线编号，`outputSnapshot` 记录曲线 ID、曲线编号、状态、方法、目标维度、样本数、点数和置信度。
- `ResidualModelRunOutput` 只表示治理层追溯关系，不会自动启用曲线，也不会自动生成单车预测。

dryRun 与未关联行为：

- `dryRun = true` 时不会创建或更新 `VehicleResidualCurve`、`VehicleResidualCurvePoint`、`ResidualModelRun`、`ResidualModelRunOutput`，也不会写审计日志。
- `dryRun = true` 时即使传入 `modelRunId`，也只做存在性和目标维度校验，不修改该运行记录。
- `dryRun = true` 时即使传入 `autoCreateModelRun = true`，也只返回试算预览，不创建模型运行记录。
- 不传 `modelRunId` 且不启用 `autoCreateModelRun` 时，正式生成曲线仍保持原行为，允许创建 `DRAFT` 曲线和曲线点，但返回“本次残值曲线未关联模型运行记录”的 warning。

权限和边界：

- 仅生成残值曲线仍使用 `residual_curve:generate`。
- 关联已有模型运行记录或自动创建模型运行记录时，需要同时具备 `residual_model_run:manage`。
- 本阶段不做真实 AI / ML，不调用 Python，不调用第三方模型 API，不做爬虫或定时采集。
- 本阶段不自动生成单车预测，不接入 ROE，不修改 `Vehicle.currentSalePriceAmount`，不写入 `VehicleSalePriceHistory`。

Stage 8.4E-D 前端使用说明：

- 在 `/residual-market` 的“残值曲线”Tab 生成残值曲线时，前端提供“不关联模型运行记录 / 关联已有模型运行记录 / 自动创建模型运行记录”三种方式。
- “不关联模型运行记录”保持原有曲线生成行为，只需要 `residual_curve:generate`；后端返回的未关联 warning 会作为提示展示，不视为失败。
- “关联已有模型运行记录”只允许选择 `CREATED` / `RUNNING` 且目标类型为 `RESIDUAL_CURVE` 的运行记录，正式生成后该运行记录会完成并产生 `ResidualModelRunOutput`。
- “自动创建模型运行记录”可填写运行名称、模型版本、模型提供方和产物地址；正式生成后由后端创建统计基线运行记录并关联输出曲线。
- 用户缺少 `residual_model_run:manage` 时，前端置灰关联已有和自动创建选项，只允许不关联模型运行记录。
- `dryRun` 会展示模型运行记录联动预期和 warning，但不会创建或更新 `ResidualModelRun` / `ResidualModelRunOutput`。
- 正式生成成功后，页面展示 `modelRun` / `modelRunOutput` 摘要，并可跳转查看曲线或模型运行记录详情。
- 该联动只是模型治理链路，不代表真实 AI / ML 训练，不自动生成单车预测，不修改 `Vehicle.currentSalePriceAmount`。

## Stage 8.5A 预测残值到车辆销售价复核口径

Stage 8.5A 建立从单车残值预测点到车辆当前销售价的受控复核链路。该链路用于把市场残值预测纳入内部估值判断，但仍不构成自动定价。

流程口径：

- 单车残值预测不会自动覆盖 `Vehicle.currentSalePriceAmount`。
- 人工采用预测点只会保存 `VehicleResidualForecastPoint.adoptedResidualAmount`，不会自动覆盖车辆当前销售价。
- 发起车辆估值复核只会创建 `VehicleValuationReview`，不会修改车辆当前销售价，也不会写 `VehicleSalePriceHistory`。
- 复核记录 `forecastResidualAmount`、`adoptedResidualAmount`、`requestedSalePriceAmount` 和 `originalSalePriceAmount`，用于后续审计追溯。
- 只有车辆估值复核审核通过后，才会更新 `Vehicle.currentSalePriceAmount` 和 `Vehicle.currentSalePriceReviewedAt`。
- 审核通过会按车辆销售价复核口径写入 `VehicleSalePriceHistory`，`reviewType = RESIDUAL_FORECAST_ADOPTION`。
- 审核拒绝和取消复核不会修改车辆当前销售价，也不会写入 `VehicleSalePriceHistory`。
- 该流程用于受控地把市场残值预测纳入内部估值复核，不改变 ROE 主口径，不改变残值敏感性口径，不代表系统自动定价。

权限口径：

- `vehicle_valuation_review:view`：查看车辆估值复核列表和详情。
- `vehicle_valuation_review:create`：从残值预测点发起复核，以及取消待审核复核。
- `vehicle_valuation_review:approve`：审核通过或拒绝待审核复核。
- seed 更新权限后，用户需要退出登录并重新登录，以刷新 access_token 中的 permissions。

## Stage 8.5B 车辆估值复核前端使用说明

Stage 8.5B 只接入前端页面和交互，不改变 Stage 8.5A 后端 API、Prisma schema、ROE 主口径或残值敏感性口径。

- 车辆详情的残值预测点支持发起车辆估值复核。可发起的预测点必须不是 `UNSUPPORTED`，且存在预测残值或人工采用残值。
- 发起复核时，建议复核销售价默认取 `adoptedResidualAmount`；如未采用，则取 `predictedResidualAmount`。页面按元输入，提交后端时按分传递。
- 发起复核前会二次确认：该动作只创建待审核 `VehicleValuationReview`，不会修改车辆当前销售价，也不会写入销售价历史。
- 车辆详情新增估值复核记录区块，用于查看当前车辆下的复核编号、来源、状态、原销售价、预测残值、请求销售价和审核结果。
- `/vehicle-valuation-reviews` 车辆估值复核工作台支持按状态、来源、车辆 ID、车辆编号、VIN 和发起日期筛选，并支持查看详情、审核通过、审核拒绝和取消。
- 详情 Drawer 展示复核基础信息、车辆摘要、残值预测摘要、价格复核信息和折叠的快照 JSON；有车辆销售价历史权限时，也会展示销售价历史。
- 审核通过前会二次确认。只有审核通过才会更新 `Vehicle.currentSalePriceAmount`，并写入 `VehicleSalePriceHistory`，其中 `reviewType = RESIDUAL_FORECAST_ADOPTION`。
- 审核拒绝和取消前也会二次确认；拒绝 / 取消不会修改车辆当前销售价，也不会写入 `VehicleSalePriceHistory`。
- 前端菜单位于“车辆资产 -> 估值复核”，由 `vehicle_valuation_review:view` 控制；创建 / 取消由 `vehicle_valuation_review:create` 控制；通过 / 拒绝由 `vehicle_valuation_review:approve` 控制。
- 该流程用于受控地将预测残值纳入内部车辆估值复核，仍不构成自动定价。

## Stage 8.6A 残值预测与估值主链路回归收口

Stage 8.6A 是对 Stage 8.4 和 Stage 8.5 已打通能力的稳定性收口，不新增定价功能，不改变后端 schema、ROA / ROE 主口径、残值敏感性口径或车辆状态机。

主链路回归范围：

```text
市场残值样本导入
  -> 残值曲线生成
  -> 残值曲线启用 / 归档
  -> 单车残值预测生成
  -> 预测点人工采用
  -> 发起车辆估值复核
  -> 审核通过 / 拒绝 / 取消
  -> 审核通过更新 Vehicle.currentSalePriceAmount
  -> 审核通过写 VehicleSalePriceHistory
  -> 资产收益试算残值敏感性展示
  -> CSV 导出
```

数据一致性检查：

- `Vehicle.currentSalePriceAmount` 只允许在车辆销售价初始化、销售价复核、退车再入池重新定价、车辆估值复核审核通过等受控动作中更新。
- 单车残值预测生成不会修改 `Vehicle.currentSalePriceAmount`，不会写 `VehicleSalePriceHistory`。
- 预测点人工采用只写 `VehicleResidualForecastPoint.adoptedResidualAmount`、采用人、采用时间和备注，不会修改车辆当前销售价。
- 发起车辆估值复核只创建 `VehicleValuationReview(PENDING)`，记录 `originalSalePriceAmount`、`forecastResidualAmount`、`adoptedResidualAmount`、`requestedSalePriceAmount` 和快照，不会写销售价历史。
- 审核通过车辆估值复核会更新 `Vehicle.currentSalePriceAmount`、`Vehicle.currentSalePriceReviewedAt`、`nextSalePriceReviewAt`、`salePriceStatus`，并新增 `VehicleSalePriceHistory`。
- 估值复核审核通过写入的销售价历史必须使用 `reviewType = RESIDUAL_FORECAST_ADOPTION`，中文展示为“残值预测采用复核”。
- 估值复核拒绝 / 取消只更新复核状态和原因，不修改车辆当前销售价，不写销售价历史。
- `VehicleValuationReview`、`VehicleResidualForecast`、`VehicleResidualForecastPoint`、`VehicleResidualCurve`、`ResidualModelRun` 和 `ResidualModelRunOutput` 之间的引用需要能追溯到具体车辆、曲线、预测点和模型运行记录。

资产收益与 CSV 回归口径：

- 资产收益试算继续以当前车辆资产、订单、收入、资本结构和成本参数为准，不因为残值预测自动修改 ROA / ROE 主口径。
- 残值敏感性展示可读取单车残值预测和采用预测点，用于收益试算辅助分析，但不回写车辆当前销售价。
- CSV 导出金额按元输出并保留 2 位小数，比例按百分比输出，状态、来源、复核类型和残值枚举必须中文化。
- CSV 导出缺失值统一输出 `-`，不得出现 `undefined`、`null`、`NaN`、`[object Object]` 或 `Invalid Date`。

权限、菜单和标签检查：

- `residual_market:view/manage/import` 控制市场残值样本查看、维护和导入。
- `residual_curve:view/generate/manage` 控制残值曲线查看、生成、启用和归档。
- `residual_forecast:view/generate/manage` 控制单车残值预测查看、生成、采用和作废。
- `residual_model_run:view/manage` 控制模型运行记录查看和管理。
- `vehicle_valuation_review:view/create/approve` 控制估值复核菜单、发起 / 取消、审核通过 / 拒绝。
- `report:asset` 控制资产收益试算、残值敏感性展示和相关导出。
- 菜单位于“车辆资产 -> 市场残值样本”“车辆资产 -> 估值复核”“经营看板 -> 资产经营分析”等既有入口，无权限时菜单不可见，按钮隐藏或置灰且不触发 API。
- 前端中文标签需要覆盖残值曲线状态、预测状态、预测点状态、模型运行状态、估值复核来源、估值复核状态和 `RESIDUAL_FORECAST_ADOPTION`。

审计日志检查：

- 市场残值样本创建、作废和 CSV 导入需要保留操作审计。
- 残值曲线生成、启用、归档需要保留操作审计。
- 单车残值预测生成、预测点采用、预测记录作废需要保留操作审计。
- 车辆估值复核发起、审核通过、审核拒绝、取消需要保留操作审计。
- 审核通过车辆估值复核时，审计内容至少应能追溯 `reviewId`、`reviewNo`、`vehicleId`、`forecastId`、`forecastPointId`、原销售价、审核通过销售价和 `vehicleSalePriceHistoryId`。

建议人工回归脚本：

```text
1. 执行 pnpm prisma:seed，并退出登录后重新登录 admin。
2. 在市场残值样本页导入或确认已有样本。
3. 生成残值曲线，并确认可启用 / 归档。
4. 在车辆详情生成单车残值预测，确认 dryRun 不落库，正式生成会创建预测和预测点。
5. 采用一个支持的预测点，确认车辆当前销售价和销售价历史不变化。
6. 从预测点发起车辆估值复核，确认只新增 PENDING 复核记录。
7. 在估值复核工作台审核通过一条复核，确认车辆当前销售价更新，销售价历史新增 RESIDUAL_FORECAST_ADOPTION。
8. 分别新建复核并执行拒绝、取消，确认车辆当前销售价和销售价历史不变化。
9. 打开资产收益试算和残值敏感性展示，确认数据、中文标签和缺失值展示正确。
10. 导出 CSV，核对金额、比例、中文标签和缺失值口径。
11. 检查 AuditLog，确认关键动作均有审计记录。
```

推荐质量门禁：

```text
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm prisma:seed
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Stage 8.6A 收口结论口径：

- 若上述回归链路、质量门禁、权限、审计、CSV 导出和文档口径均通过，可进入 Stage 8.5C。
- Stage 8.5C 建议先做估值复核统计报表、批量拒绝、批量取消和批量通过 preview。
- 在批量通过真正更新车辆当前销售价前，应先设计差异阈值、低置信度拦截、批量审计、部分成功 / 失败明细和二次确认保护。

## Stage 8.6B 权限 / 菜单 / 标签 / 错误提示统一收口

Stage 8.6B 只做 Stage 8 残值预测、估值复核和资产收益试算相关功能的治理收口，不新增业务 API，不改变 Prisma schema，不改变残值预测模型、车辆销售价更新条件、销售价历史写入条件、ROA / ROE 主口径或残值敏感性口径。

权限矩阵口径：

- `ADMIN` 拥有全部权限。
- `GM` 拥有 `residual_market:view`、`residual_curve:view`、`residual_forecast:view`、`residual_model_run:view`、`vehicle_valuation_review:view`、`vehicle_valuation_review:approve` 和 `report:asset`。
- `OP` 拥有 `residual_market:view/import`、`residual_curve:view/generate`、`residual_forecast:view/generate`、`residual_model_run:view`、`vehicle_valuation_review:view/create/approve` 和 `report:asset`。
- `AS` 拥有残值样本、残值曲线、单车预测和模型运行记录的 view / generate / manage 权限，拥有 `vehicle_valuation_review:view/create` 和 `report:asset`。
- `FI` 拥有 `residual_market:view`、`residual_curve:view`、`residual_forecast:view`、`residual_model_run:view`、`vehicle_valuation_review:view` 和 `report:asset`。

菜单与权限对应关系：

- “车辆资产 -> 市场残值样本”由 `residual_market:view` 控制。
- “车辆资产 -> 估值复核”由 `vehicle_valuation_review:view` 控制。
- “经营看板 -> 资产经营分析”由 `report:asset` 控制。
- `/residual-market` 内部 Tab 按 `residual_market:view`、`residual_curve:view`、`residual_model_run:view` 分别展示；无权限时不显示对应 Tab，也不发起对应 API 请求。
- `/reports/asset-profitability` 和 CSV 导出统一由 `report:asset` 控制，残值敏感性展示属于资产报表汇总口径，不额外要求 `residual_forecast:view`。

操作权限口径：

- 新增 / 作废市场残值样本需要 `residual_market:manage`，CSV 导入需要 `residual_market:import`。
- 生成残值曲线需要 `residual_curve:generate`，启用 / 归档曲线需要 `residual_curve:manage`。
- 生成单车残值预测需要 `residual_forecast:generate`，采用预测点 / 作废预测需要 `residual_forecast:manage`。
- 新增、完成、失败、取消模型运行记录需要 `residual_model_run:manage`。
- 从残值预测点发起估值复核和取消待审核复核需要 `vehicle_valuation_review:create`。
- 审核通过 / 审核拒绝估值复核需要 `vehicle_valuation_review:approve`。

标签与错误提示口径：

- 前端和 CSV 导出中的残值样本来源、价格类型、卖方类型、样本状态、导入状态、残值曲线状态 / 方法、预测状态 / 方法、预测点状态、插值方式、预测金额来源、模型运行类型 / 状态 / 算法 / 目标 / 输出、估值复核来源 / 状态、销售价复核类型均应中文化。
- `VehicleSalePriceReviewType.RESIDUAL_FORECAST_ADOPTION` 中文展示为“残值预测采用复核”。
- 缺失值展示为 `-`，不得出现 `undefined`、`null`、`NaN`、`[object Object]` 或 `Invalid Date`。
- 前端错误提示优先展示后端中文错误；通用 `Internal Server Error` / `Bad Request` 应转换为中文兜底提示。
- 无权限时菜单不可见，按钮隐藏或置灰，且前端不主动发起对应 API 请求。

开发环境 warning 口径：

- 项目代码内可控的 Ant Design deprecation warning 应在不大规模重构的前提下修复。
- 浏览器插件注入属性导致的 hydration mismatch，例如 `talentranslate-version`、`talentranslate-id`，不属于项目代码问题。
- 数据库连接偶发 `Connection terminated unexpectedly` 不在本阶段处理，除非能明确定位为当前代码引入。

## Stage 8.6C 数据一致性与审计收口

Stage 8.6C 只做 Stage 8 残值预测与车辆估值复核主链路的数据一致性、审计日志和写入边界回归，不新增业务 API，不改变 Prisma schema，不改变 ROA / ROE 主口径、残值敏感性口径或车辆销售价更新规则。

写入边界矩阵：

- 手工创建市场残值样本只允许写 `VehicleMarketPriceObservation` 和 `AuditLog`，不得写 `Vehicle.currentSalePriceAmount`、`VehicleSalePriceHistory`、残值曲线、单车预测或估值复核。
- CSV 导入市场残值样本只允许写 `MarketPriceImportBatch`、`VehicleMarketPriceObservation` 和批次级 `AuditLog`，不得更新车辆销售价或销售价历史。
- 作废市场残值样本只允许更新样本状态为 `VOIDED` 并写 `AuditLog`，不得生成曲线、预测或销售价历史。
- 残值曲线 dryRun 不允许写任何业务表，也不写 `AuditLog`。
- 正式生成残值曲线只允许写 `VehicleResidualCurve`、`VehicleResidualCurvePoint` 和 `AuditLog`；关联或自动创建模型运行记录时，才允许写 `ResidualModelRun` / `ResidualModelRunOutput`。
- 启用或归档残值曲线只允许更新曲线状态、有效期和 `AuditLog`，不得写单车预测、车辆当前销售价或销售价历史。
- 单车残值预测 dryRun 不允许写 `VehicleResidualForecast`、`VehicleResidualForecastPoint` 或 `AuditLog`。
- 正式生成单车残值预测只允许写 `VehicleResidualForecast`、`VehicleResidualForecastPoint` 和 `AuditLog`，不得修改 `Vehicle.currentSalePriceAmount`，不得写 `VehicleSalePriceHistory`。
- 采用预测点只允许更新 `VehicleResidualForecastPoint`、`VehicleResidualForecast` 和 `AuditLog`，不会自动发起估值复核，也不会修改车辆当前销售价。
- 作废预测只允许更新 `VehicleResidualForecast.forecastStatus = VOIDED` 并写 `AuditLog`，不得更新车辆销售价或销售价历史。
- 从残值预测点发起车辆估值复核只允许写 `VehicleValuationReview(PENDING)` 和 `AuditLog`，不会修改车辆当前销售价，也不会写销售价历史。
- 审核通过车辆估值复核是 Stage 8 残值链路中唯一允许更新 `Vehicle.currentSalePriceAmount` 的动作，同时会更新 `currentSalePriceReviewedAt`、按既有规则维护 `nextSalePriceReviewAt` / `salePriceStatus`，并写 `VehicleSalePriceHistory`。
- 审核通过写入的 `VehicleSalePriceHistory.reviewType` 必须是 `RESIDUAL_FORECAST_ADOPTION`。
- 审核拒绝和取消复核只允许更新 `VehicleValuationReview` 状态、原因、审核人 / 时间和 `AuditLog`，不得修改车辆当前销售价，不得写销售价历史。
- 报表查询和 CSV export，包括资产收益试算 summary、车辆列表、单车详情及其导出，必须保持只读，不写任何业务表，也不写 `AuditLog`。

dryRun 与只读规则：

- 所有 dryRun 都只返回试算结果，不落库、不写审计、不更新模型运行输出、不触发销售价变化。
- 所有 GET 查询和 CSV export 都只读，不能因为读取残值预测、估值复核、销售价历史或收益试算字段而产生任何写入副作用。
- 残值敏感性只用于资产收益试算辅助分析，不改变主 ROA / ROE 口径，不写回车辆资产。

审计日志规则：

- 必须写审计日志的动作包括：市场样本创建、CSV 导入、样本作废；残值曲线生成、启用、归档；ResidualModelRun 创建、完成、失败、取消；正式生成单车残值预测、采用预测点、作废预测；发起、通过、拒绝、取消车辆估值复核。
- 不应写审计日志的动作包括：所有 dryRun、所有 GET 查询和所有 CSV export。
- 车辆估值复核审核通过的审计日志必须能追溯 `reviewId`、`reviewNo`、`vehicleId`、`forecastId`、`forecastPointId`、`originalSalePriceAmount`、`approvedSalePriceAmount`、`vehicleSalePriceHistoryId` 和审核备注。

一致性结论口径：

- `Vehicle.currentSalePriceAmount` 在 Stage 8 残值链路中的唯一写入口是车辆估值复核审核通过。
- `VehicleSalePriceHistory.reviewType = RESIDUAL_FORECAST_ADOPTION` 的唯一写入条件是车辆估值复核审核通过。
- 采用预测点、发起复核、拒绝复核、取消复核、曲线生成、单车预测生成、模型运行记录完成、报表查询和 CSV 导出都不得写入车辆当前销售价。
- 若回归中发现其他路径更新 `Vehicle.currentSalePriceAmount` 或写入 `RESIDUAL_FORECAST_ADOPTION` 历史，应按高风险缺陷处理。

## Stage 8.UI-F1 经营看板与资产收益页面信息架构

Stage 8.UI-F1 只优化前端展示层级，不改变后端 API、统计口径、ROA / ROE 计算、残值敏感性计算或 CSV 导出口径。

经营总览页面信息架构：

- 顶部先展示核心经营结果，包括在租订单、已出租车辆 / 出租率、实收金额、未收 / 逾期金额、催收案件数和押金余额。
- 订单、车辆、财务、押金、逾期催收和待处理事项分区展示，避免所有指标等权平铺。
- 押金余额单独展示，不计入经营收入。
- 财务收款区展示 `未收金额 = 应收合计 - 实收合计` 和收款率口径。
- 经营总览口径说明使用折叠区展示，不改变任何报表计算结果。

资产经营页面信息架构：

- 顶部展示核心资产经营结果：车辆总数、平均出租率、租金实收、当前销售价合计和简化经营回报率。
- 资产价值区展示采购成本合计、当前销售价合计和前端安全计算的价值差异。
- 出租与利用率、收入与应收、简化回报率说明分区展示。
- `simpleReturnRate` 页面名称保持为“简化经营回报率”，计算口径仍为 `租金实收 / 车辆采购价`，不是会计 ROA / ROE。

收益试算页面信息架构：

- 顶部核心结果区展示平台权益净收益、主试算 ROE、年化主试算 ROE、残值敏感性 ROE 和 ROE 状态。
- 数据完整性 / 可计算性区单独展示成本参数覆盖、ROE 可计算覆盖和残值预测覆盖情况。
- 收入归属、成本与资本结构、资产价值与残值敏感性按业务关系分区展示。
- 计算链路使用折叠区展示，包括经营收入、平台留存经营收入、经营成本、平台权益净收益、主 ROE 和残值敏感性 ROE 的钩稽关系。
- 主 ROE 与残值敏感性 ROE 并列展示；残值敏感性 ROE 不改变主 ROE。
- 指标分组只是前端展示优化，不修改 `Vehicle.currentSalePriceAmount`，不写 `VehicleSalePriceHistory`。

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

## Stage 10M-C-B / 10M-C-C BaaS 成本收益试算口径

Stage 10M-C-B 先将 BaaS 电池租赁成本作为资产收益试算的补充展示口径。Stage 10M-C-C 起，BaaS 成本正式并入主 `platformNetIncomeAmount`、`roeTrial`、`annualizedRoeTrial` 和 `trialRoa`。此前未含 BaaS 的 ROE 试算未进入大规模生产使用，当前页面不再单独展示 BaaS 结果卡。

BaaS 成本来源：

```text
VehicleBaasCostRecord
```

取数规则：

- 按车辆维度归集。
- 只统计未删除记录。
- 按 `periodStart / periodEnd` 对应服务期间归属到报表周期；跨期记录按重叠天数分摊。
- 纳入 `SCHEDULED`、`CONFIRMED`、`PAID`、`OVERDUE`。
- 排除 `WAIVED`、`VOIDED`。
- `dueDate` 仅用于付款计划、应付提醒、逾期判断和现金流分析，不用于主 ROE 成本归属。
- `paidAt` 仅展示实际付款状态，不决定成本是否计入收益。

新增汇总字段：

```text
baasCostVehicleCount
baasCostRecordCount
baasCostAmount
baasScheduledCostAmount
baasConfirmedCostAmount
baasPaidCostAmount
baasOverdueCostAmount
baasCostFullRecordAmount
baasCostAllocationMethod
```

新增车辆列表字段：

```text
baasContractStatus
baasContractNo
baasProviderName
baasCostRecordCount
baasCostAmount
baasScheduledCostAmount
baasConfirmedCostAmount
baasPaidCostAmount
baasOverdueCostAmount
baasCostFullRecordAmount
baasCostAllocationMethod
```

单车详情新增：

```text
baasCostSummary
baasCurrentContract
baasCostRecords
```

计算公式：

```text
operatingCostAmount =
  existingOperatingCostAmount + baasProratedCostAmount

platformNetIncomeAmount =
  platformRetainedRevenueAmount - operatingCostAmount

roeTrial =
  platformNetIncomeAmount / roeEquityBaseAmount

annualizedRoeTrial =
  roeTrial * 365 / analysisDays

trialRoa =
  trialNetOperatingIncomeAmount / purchasePriceAmount
```

当 `platformNetIncomeAmount`、`roeEquityBaseAmount` 缺失或权益资本基数小于等于 0 时，主 `roeTrial` 返回 `null`。

CSV 导出同步增加 BaaS 成本汇总、BaaS 合同摘要和 BaaS 成本分摊记录。车辆列表 CSV 中，BaaS 合同状态跟随车辆状态，BaaS 成本字段位于经营成本之前。CSV 仍为只读导出，不写业务表、不写审计日志、不生成付款单或账单。

## Stage 10N-C-B 折旧记录进入主资产收益口径

Stage 10N-C-B 起，车辆折旧 records 正式进入资产收益主口径。

纳入规则：

- 仅纳入 `VehicleDepreciationRecord.recordStatus = CONFIRMED / LOCKED`。
- 排除 `DRAFT`、`VOIDED`、`deletedAt != null`。
- `VehicleDepreciationSchedule` 不直接进入 ROE，必须 confirm 生成 / 更新 record 后才进入报表。

分摊规则：

- 使用 `VehicleDepreciationRecord.periodStart / periodEnd` 与分析周期的重叠天数分摊。
- 不按 `costPeriod`、`createdAt`、`confirmedAt` 归属。
- 金额按分四舍五入，期间无效时按 0 计入并返回 warning。

折旧来源：

```text
RECORDS = ACTIVE policy 下使用 CONFIRMED / LOCKED records
LEGACY_COST_PROFILE = 无 ACTIVE policy 时 fallback 到 VehicleAssetCostProfile 即时折旧
NONE = ACTIVE NONE policy，折旧为 0
UNAVAILABLE = ACTIVE MANUAL / STRAIGHT_LINE policy 缺少有效 records
```

主口径避免双扣：

```text
有 ACTIVE depreciation policy:
  剥离 VehicleAssetCostProfile 即时折旧
  使用 policy 对应 records / NONE / UNAVAILABLE 结果

无 ACTIVE depreciation policy:
  沿用 VehicleAssetCostProfile 即时折旧
```

新增 summary 字段：

```text
depreciationAmount
depreciationRecordAmount
legacyDepreciationAmount
depreciationRecordCount
depreciationVehicleCount
depreciationSourceBreakdown
depreciationUnavailableVehicleCount
```

新增车辆列表 / 单车详情字段：

```text
depreciationSource
depreciationPolicyId
depreciationPolicyNo
depreciationMethod
depreciationAmount
recordDepreciationAmount
legacyDepreciationAmount
depreciationRecordCount
depreciationMissingReasons
```

CSV 导出同步增加折旧来源、折旧策略、折旧记录数、折旧缺失原因和单车折旧记录分摊明细。本阶段不修改折旧模型 schema，不接市场校准折旧，不修改支付 / 核销 / 财务主线。

## ROA / ROE

历史早期阶段不计算正式会计 ROA / ROE；Stage 8 之后资产收益页已经提供试算 ROA / ROE，Stage 10M-C-C 纳入 BaaS 成本，Stage 10N-C-B 纳入已确认 / 已锁定折旧 records。

正式 ROA / ROE 后续需要引入：

- 资金成本
- 折旧
- 车辆生命周期累计收入
- 残值
- 运营费用

以上能力建议放入 Stage 8 资产经营分析深化。
