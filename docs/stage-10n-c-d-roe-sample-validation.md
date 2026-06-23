# Stage 10N-C-D ROE 样例车辆人工验算

## 验算范围

本阶段在本地数据库创建脱敏样例数据，使用 `STAGE10NCD` 前缀隔离，不写入真实客户信息，不修改业务代码、Prisma schema 或 migration。

- 分析周期：2026-06-01 至 2026-06-30，共 30 天
- API 基准筛选：`vehicleModel=ET9`、`vehicleStatus=MAINTENANCE`
- 残值预测周期：未来 12 个月
- 残值校准比例：0%、+10%、-10%
- 金额口径：API 金额单位为分，CSV 展示单位为元

## 样例车辆

| 脱敏编号 | 覆盖场景 | 折旧来源 | BaaS | 残值数据 |
| --- | --- | --- | --- | --- |
| STAGE10NCD-VEH-A | 无 ACTIVE 折旧 policy，回退旧成本参数 | LEGACY_COST_PROFILE | 无 | adopted residual |
| STAGE10NCD-VEH-B | ACTIVE STRAIGHT_LINE，已确认 schedule/record | RECORDS | 有 | predicted residual |
| STAGE10NCD-VEH-C | ACTIVE MANUAL，手工 CONFIRMED record | RECORDS | 无 | 无 |
| STAGE10NCD-VEH-D | ACTIVE MANUAL，缺 CONFIRMED/LOCKED record | UNAVAILABLE | 无 | 无 |
| STAGE10NCD-VEH-E | ACTIVE NONE policy | NONE | 无 | 无 |

每台车均设置采购价 1,200,000 分、当前销售价 900,000 分、成本参数残值 300,000 分、分析期实收租金 100,000 分。未录入资本事件，系统按全自有资金假设试算 ROE，权益基数为采购价。

## 手工公式

旧成本参数折旧：

```text
monthlyDepreciation = round((purchasePriceAmount - residualValueAmount) / usefulLifeMonths)
legacyDepreciation = round(monthlyDepreciation * 12 * costDays / 365)
```

样例成本参数为：

```text
monthlyDepreciation = round((1,200,000 - 300,000) / 60) = 15,000
legacyDepreciation = round(15,000 * 12 * 30 / 365) = 14,795
```

主 ROE：

```text
platformNetIncomeAmount =
  platformRetainedRevenueAmount
  - depreciationAmount
  - BaaS period-prorated cost
  - other operating/capital/external costs

roeTrial = platformNetIncomeAmount / roeEquityBaseAmount
annualizedRoeTrial = roeTrial * 365 / analysisDays
trialRoa = platformNetIncomeAmount / purchasePriceAmount
```

市场校准 ROE：

```text
marketResidualBaseAmount = adoptedResidualAmount ?? predictedResidualAmount
marketCalibratedResidualAmount = round(marketResidualBaseAmount * (100 + residualCalibrationPercent) / 100)
marketResidualDeltaAmount = marketCalibratedResidualAmount - accountingResidualBaselineAmount
marketCalibratedPlatformNetIncomeAmount = platformNetIncomeAmount + marketResidualDeltaAmount
marketCalibratedRoeTrial = marketCalibratedPlatformNetIncomeAmount / roeEquityBaseAmount
marketCalibratedAnnualizedRoeTrial = marketCalibratedRoeTrial * 365 / analysisDays
```

## 单车验算

| 车辆 | 收入 | BaaS 成本 | 折旧金额 | 平台净收益 | 权益基数 | ROE | 年化 ROE | ROA | API 差异 | CSV 差异 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 100,000 | 0 | 14,795 | 85,205 | 1,200,000 | 7.1004% | 86.3884% | 7.1004% | 0 分 | 0 分 |
| B | 100,000 | 12,000 | 18,000 | 70,000 | 1,200,000 | 5.8333% | 70.9722% | 5.8333% | 0 分 | 0 分 |
| C | 100,000 | 0 | 20,000 | 80,000 | 1,200,000 | 6.6667% | 81.1111% | 6.6667% | 0 分 | 0 分 |
| D | 100,000 | 0 | 不可用 | 不可用 | 1,200,000 | 不可用 | 不可用 | 不可用 | 0 分 | 0 分 |
| E | 100,000 | 0 | 0 | 100,000 | 1,200,000 | 8.3333% | 101.3889% | 8.3333% | 0 分 | 0 分 |

车辆 D 按预期返回 `roeDataReady=false`，缺失原因包含：

```text
手工折旧策略缺少折旧记录
经营成本无法完整计算，暂不输出 ROE。
```

## BaaS 成本验算

样例 B 设置 4 条 BaaS 成本记录：

| 状态 | periodStart | periodEnd | dueDate | 原始金额 | 重叠天数 / 总天数 | 纳入金额 | 结论 |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| SCHEDULED | 2026-05-17 | 2026-06-15 | 2026-09-01 | 6,000 | 15 / 30 | 3,000 | 纳入 |
| CONFIRMED | 2026-06-01 | 2026-06-30 | 2026-01-01 | 4,000 | 30 / 30 | 4,000 | 纳入 |
| PAID | 2026-06-16 | 2026-07-15 | 2026-07-30 | 10,000 | 15 / 30 | 5,000 | 纳入 |
| VOIDED | 2026-06-01 | 2026-06-30 | 2026-06-15 | 7,000 | 30 / 30 | 0 | 排除 |

API detail 返回 3 条纳入记录，`baasCostAmount=12,000`、`baasCostFullRecordAmount=20,000`。SCHEDULED / CONFIRMED / PAID 均按 `periodStart` / `periodEnd` 分摊，`dueDate` 不影响主 ROE 成本归属，VOIDED 未进入 detail。

## 残值与市场校准

0% 校准：

| 车辆 | 残值来源 | 会计残值基准 | 市场残值基准 | 校准后残值 | 残值差异 | 会计净收益 | 市场校准净收益 | 会计 ROE | 市场校准 ROE |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | ADOPTED | 300,000 | 360,000 | 360,000 | 60,000 | 85,205 | 145,205 | 7.1004% | 12.1004% |
| B | PREDICTED | 300,000 | 340,000 | 340,000 | 40,000 | 70,000 | 110,000 | 5.8333% | 9.1667% |
| C | NONE | 300,000 | - | - | - | 80,000 | 不可用 | 6.6667% | 不可用 |
| D | NONE | 300,000 | - | - | - | 不可用 | 不可用 | 不可用 | 不可用 |
| E | NONE | 300,000 | - | - | - | 100,000 | 不可用 | 8.3333% | 不可用 |

残值校准滑块/选框参数复核：

| 车辆 | 校准比例 | 校准后残值 | 残值差异 | 市场校准净收益 | 市场校准 ROE | 差异 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | +10% | 396,000 | 96,000 | 181,205 | 15.1004% | 0 分 |
| A | -10% | 324,000 | 24,000 | 109,205 | 9.1004% | 0 分 |
| B | +10% | 374,000 | 74,000 | 144,000 | 12.0000% | 0 分 |
| B | -10% | 306,000 | 6,000 | 76,000 | 6.3333% | 0 分 |

`residualCalibrationPercent=31` 返回 HTTP 400，符合 -30 到 30 的参数边界。

## 汇总验算

主会计 ROE 汇总只聚合可计算车辆 A/B/C/E；D 进入不可用统计，不进入主净收益和权益基数。

| 指标 | API | 人工计算 | 差异 |
| --- | ---: | ---: | ---: |
| 车辆数 | 5 | 5 | 0 |
| 成本可计算车辆数 | 4 | 4 | 0 |
| ROE 不可用车辆数 | 1 | 1 | 0 |
| 经营收入 | 500,000 | 500,000 | 0 分 |
| 折旧金额 | 52,795 | 52,795 | 0 分 |
| 折旧记录金额 | 38,000 | 38,000 | 0 分 |
| legacy 折旧参考金额 | 73,975 | 14,795 * 5 | 0 分 |
| BaaS 成本 | 12,000 | 12,000 | 0 分 |
| 经营成本 | 64,795 | 52,795 + 12,000 | 0 分 |
| platformNetIncomeAmount | 335,205 | 85,205 + 70,000 + 80,000 + 100,000 | 0 分 |
| roeEquityBaseAmount | 4,800,000 | 1,200,000 * 4 | 0 分 |
| roeTrial | 6.9834% | 335,205 / 4,800,000 | 展示四舍五入内 |
| annualizedRoeTrial | 84.9652% | roeTrial * 365 / 30 | 展示四舍五入内 |
| trialRoa | 6.9834% | 335,205 / 4,800,000 | 展示四舍五入内 |

市场校准汇总只聚合有可用残值的车辆 A/B，不把无残值车辆 C/D/E 加入市场校准净收益：

| 校准比例 | 市场残值基准合计 | 校准后残值合计 | 残值差异合计 | 市场校准净收益 | 市场校准 ROE | 差异 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0% | 700,000 | 700,000 | 100,000 | 255,205 | 10.6335% | 0 分 |
| +10% | 700,000 | 770,000 | 170,000 | 325,205 | 13.5502% | 0 分 |
| -10% | 700,000 | 630,000 | 30,000 | 185,205 | 7.7169% | 0 分 |

## API / CSV / 前端复核

- API：summary、vehicle list、vehicle detail、summary CSV、vehicle list CSV、vehicle detail CSV 均通过脚本断言。
- CSV：导出文件包含 5 台样例车、折旧来源、BaaS 成本、市场校准 ROE 和残值校准字段；金额与 API 一致，元/分换算一致。
- 前端：本阶段未修改前端业务逻辑；资产经营分析页面使用同一组 report API 字段展示主 ROE、折旧来源、市场校准 ROE 和不可用原因。后续执行 `web tsc` / `web build` 作为页面绑定静态复核。

## 发现的问题

未发现主 ROE、BaaS 分摊、折旧 records、legacy fallback、NONE policy 或市场校准残值计算差异。

注意事项：

- 当前本地 PowerShell 控制台读取 CSV 时中文可能显示乱码，但 CSV 接口返回内容按 UTF-8 文本校验通过。
- 市场校准 summary 的净收益和 ROE 是“可市场校准车辆”聚合口径，不是所有车辆主净收益加总后再加 residual delta。

## 结论

Stage 10N-C-D 样例车辆人工验算通过。当前 ROE 口径具备 controlled beta 使用条件：

- 会计折旧主 ROE 可解释、可复算；
- BaaS 成本按服务期间归属，状态纳入/排除符合预期；
- MANUAL 缺记录时不可用原因清晰；
- 市场校准折旧只作为对比口径，不覆盖主会计 ROE；
- API 与 CSV 对账一致。

建议 controlled beta 前继续保留样例车辆验算脚本思路，选取 3-5 台真实脱敏业务样本由财务/经营共同复核展示口径。
