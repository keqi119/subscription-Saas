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

## ROA / ROE

当前阶段不计算完整 ROA / ROE。

ROA / ROE 后续需要引入：

- 资金成本
- 折旧
- 车辆生命周期累计收入
- 残值
- 运营费用

以上能力建议放入 Stage 8 资产经营分析深化。
