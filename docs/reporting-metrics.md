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

## ROA / ROE

当前阶段不计算完整 ROA / ROE。

ROA / ROE 后续需要引入：

- 资金成本
- 折旧
- 车辆生命周期累计收入
- 残值
- 运营费用

以上能力建议放入 Stage 8 资产经营分析深化。
