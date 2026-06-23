# Stage 10N-C-C 市场校准折旧 / 残值滑块对比

## 目标

Stage 10N-C-C 在资产收益分析中新增市场校准折旧对比口径，把残值预测、人工采用残值、残值敏感性和会计折旧主 ROE 串联到同一经营分析视图。

本阶段不修改主 `platformNetIncomeAmount`、`roeTrial`、`annualizedRoeTrial`、`trialRoa`。市场校准结果只作为对比 / 敏感性口径展示。

## 会计主口径 vs 市场校准口径

会计折旧主口径：

- 使用当前主资产收益报表结果。
- 已包含 BaaS 成本。
- 已包含 Stage 10N-C-B 接入的会计折旧 records 或 legacy fallback。

市场校准折旧对比口径：

- 以主 `platformNetIncomeAmount` 为起点。
- 读取残值预测的人工采用值或曲线预测值。
- 叠加残值校准比例，得到校准后市场残值。
- 与成本参数预计残值比较，形成市场残值差异。
- 只输出对比净收益、ROE、年化 ROE、ROA。

## 残值来源

市场残值基准优先级：

1. `VehicleResidualForecastPoint.adoptedResidualAmount`
2. `VehicleResidualForecastPoint.predictedResidualAmount`
3. 无可用残值时返回 unavailable reason

残值预测仍按 `residualHorizonMonth` 选择指定预测周期；本阶段不插值、不自动采用预测点、不写回车辆资产。

## 残值校准滑块

资产收益试算新增 `residualCalibrationPercent` 参数：

- 默认：`0`
- 范围：`-30` 到 `30`
- 档位：前端选框每 `5%` 一档
- 超出范围：API 返回 `400`

该参数只模拟市场残值上调或下调，不修改 `VehicleDepreciationPolicy`、`VehicleDepreciationRecord`、`VehicleAssetCostProfile.residualValueAmount` 或残值预测数据。

## 公式

```text
marketResidualBaseAmount =
  adoptedResidualAmount ?? predictedResidualAmount

marketCalibratedResidualAmount =
  marketResidualBaseAmount * (1 + residualCalibrationPercent / 100)

accountingResidualBaselineAmount =
  VehicleAssetCostProfile.residualValueAmount

marketResidualDeltaAmount =
  marketCalibratedResidualAmount - accountingResidualBaselineAmount

marketCalibratedPlatformNetIncomeAmount =
  platformNetIncomeAmount + marketResidualDeltaAmount

marketCalibratedRoeTrial =
  marketCalibratedPlatformNetIncomeAmount / roeEquityBaseAmount

marketCalibratedAnnualizedRoeTrial =
  marketCalibratedRoeTrial * 365 / analysisDays

marketCalibratedTrialRoa =
  marketCalibratedPlatformNetIncomeAmount / purchasePriceAmount
```

金额按分取整，残值校准后金额使用四舍五入。

## 返回字段

Summary 新增：

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

Vehicle list 新增：

- `marketResidualSource`
- `marketResidualBaseAmount`
- `marketCalibratedResidualAmount`
- `marketResidualDeltaAmount`
- `marketCalibratedPlatformNetIncomeAmount`
- `marketCalibratedRoeTrial`
- `marketCalibratedAnnualizedRoeTrial`
- `marketCalibratedTrialRoa`
- `marketCalibrationUnavailableReason`
- `residualCalibrationPercent`

Vehicle detail 新增 `marketCalibratedDepreciation`，同时返回会计主口径与市场校准口径的单车对比。

## CSV 更新

收益汇总、车辆收益列表、单车收益详情 CSV 都新增市场校准折旧 / 残值校准字段，包括残值来源、校准比例、市场残值基准、校准后残值、残值差异、市场校准净收益、市场校准 ROE / ROA 和不可用原因。

## 本阶段不做

- 不覆盖会计折旧主 ROE。
- 不修改折旧 policy / record。
- 不自动采用残值预测。
- 不修改残值预测模型。
- 不修改估值复核流程。
- 不修改支付、核销、账单、订单、合同、权益或工单主逻辑。

## 后续

下一步建议进入 Stage 10N-C-D：选择样例车辆人工验算会计 ROE 与市场校准 ROE，覆盖 legacy depreciation、straight-line records、manual records、NONE policy、BaaS 成本、残值预测和 adopted residual。
