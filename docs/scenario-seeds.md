# Stage 9C 场景 Seed 与 Smoke 验收

本文档用于 Stage 9C。目标是让主线验收数据可重复创建、可定位清理、可被 smoke 脚本读取。

## 1. 默认 seed 与 scenario seed

`pnpm prisma:seed` 只用于初始化 baseline master data：

- 用户、角色、权限、菜单
- 基础客户线索
- 产品、版本、套餐、订阅计划
- 押金规则
- baseline 车辆池和车辆销售价初始化记录

默认 seed 不创建复杂流程数据，例如进件、报价、订单、合同、账单、收款、交付、退车、催收、残值预测或估值复核。

复杂验收数据必须通过显式 scenario seed 创建：

```powershell
pnpm seed:scenario mainline
pnpm seed:scenario residual
pnpm seed:scenario all
pnpm seed:scenario cleanup
```

## 2. 场景命名和前缀

当前支持两个场景：

- `mainline`：主线客户 / 进件 / 车辆 / 订阅计划验收数据
- `residual`：残值样本 / 曲线 / 单车预测 / 估值复核验收数据

场景数据统一使用前缀：

- `SCN9_MAINLINE_`
- `SCN9_RESIDUAL_`

专用车辆 VIN 使用：

- `SCN9MAINLINE...`
- `SCN9RESIDUAL...`

cleanup 只按 `SCN9_` 前缀和专用 VIN 前缀清理，不删除 baseline seed 数据。

## 3. mainline 场景

执行：

```powershell
pnpm seed:scenario mainline
```

当前覆盖：

- 专用客户
- `SELF_SERVICE` 进件
- 专用 `AVAILABLE` 车辆
- active subscription plan 引用
- 车辆销售价初始化记录

当前不直接创建报价、订单、合同或账单。验收人员可从输出的 `applicationId` 继续人工推进报价、订单、合同和交付链路。

输出文件：

```text
.tmp/scenarios/mainline.json
```

## 4. residual 场景

执行：

```powershell
pnpm seed:scenario residual
```

当前覆盖：

- 专用车辆
- 车辆销售价初始化记录
- 市场残值样本 import batch
- 市场残值样本 observations
- `ACTIVE` 残值曲线和曲线点
- 单车残值预测和 forecast points
- 一个 `PENDING` 估值复核

`forecastPointId` 指向可用于后续采用 / 复核流程的预测点。脚本不会自动审批估值复核。

输出文件：

```text
.tmp/scenarios/residual.json
```

## 5. cleanup

执行：

```powershell
pnpm seed:scenario cleanup
```

清理范围：

- `SCN9_` 前缀客户、进件、报价、订单、合同
- `SCN9_` 专用车辆和车辆销售价历史
- `SCN9_` 残值样本、import batch、曲线、预测、估值复核
- 与 `SCN9_` 订单关联的账单、收款、押金、催收、交付、退车、权益记录
- `.tmp/scenarios/mainline.json`
- `.tmp/scenarios/residual.json`

禁止用于清理非 `SCN9_` 数据。生产环境不应执行 scenario seed 或 cleanup。

## 6. Smoke 配合

基础 API smoke：

```powershell
pnpm smoke:api
```

读取 mainline 输出并追加详情校验：

```powershell
pnpm smoke:mainline
```

读取 residual 输出并追加详情校验：

```powershell
pnpm smoke:residual
```

也可以显式指定场景文件：

```powershell
$env:SMOKE_SCENARIO_FILE=".tmp/scenarios/mainline.json"
pnpm smoke:api
```

常用环境变量：

```powershell
$env:SMOKE_API_BASE_URL="http://localhost:3001"
$env:SMOKE_WEB_BASE_URL="http://localhost:3000"
$env:SMOKE_ADMIN_USERNAME="admin"
$env:SMOKE_ADMIN_PASSWORD="Admin@123456"
```

`SMOKE_API_BASE_URL` 可以传 `http://localhost:3001` 或 `http://localhost:3001/api`。

## 7. 输出 JSON 字段

`mainline.json` 包含：

- `customerId`
- `applicationId`
- `vehicleId`
- `subscriptionPlanId`
- `quoteId`
- `orderId`
- `contractId`

`quoteId`、`orderId`、`contractId` 当前可能为 `null`。smoke 会跳过缺失 ID，不会因此失败。

`residual.json` 包含：

- `vehicleId`
- `importBatchId`
- `curveId`
- `curvePointId`
- `forecastId`
- `forecastPointId`
- `valuationReviewId`

## 8. 风险提示

- scenario seed 只用于开发、测试和人工验收环境。
- 执行 scenario seed 前建议先执行 `pnpm prisma:seed`，确保 baseline master data 存在。
- 不要在生产环境执行 `pnpm seed:scenario`。
- 不要使用 `prisma migrate reset` 或 `prisma db push` 处理 scenario seed 数据。
