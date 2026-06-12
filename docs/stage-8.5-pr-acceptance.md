# Stage 8.5 PR 验收文档

## PR 信息

建议 PR 标题：

```text
feat: add vehicle valuation review flow
```

适用提交范围：

```text
5570bd0 docs: add residual market user guide
5bb9be0 feat: add residual forecast valuation review backend
8742949 feat: add vehicle valuation review page
af6033f fix: shrink auth token cookie
```

本轮完成 Stage 8.5 残值预测到车辆销售价复核闭环：

```text
残值预测
  -> 人工采用预测点
  -> 发起车辆估值复核
  -> 审核通过
  -> 更新车辆当前销售价
  -> 写销售价历史
```

核心边界：

```text
采用预测点 != 更新车辆当前销售价
发起复核 != 更新车辆当前销售价
审核通过 = 唯一可以更新车辆当前销售价的动作
```

## 变更摘要

后端能力：

- 新增 `VehicleValuationReview` 模型。
- 新增 `VehicleValuationReviewSource`、`VehicleValuationReviewStatus` 枚举。
- 扩展 `VehicleSalePriceReviewType.RESIDUAL_FORECAST_ADOPTION`。
- 新增从残值预测点发起估值复核、复核列表、详情、审核通过、拒绝、取消 API。
- 审核通过后更新 `Vehicle.currentSalePriceAmount`、`currentSalePriceReviewedAt`、`nextSalePriceReviewAt`、`salePriceStatus`，并写入 `VehicleSalePriceHistory`。
- 发起、拒绝、取消均不修改车辆当前销售价，不写销售价历史。
- 补充审计日志和权限控制。

前端能力：

- 车辆详情残值预测点新增“发起估值复核”入口。
- 车辆详情新增“估值复核记录”区块。
- 新增 `/vehicle-valuation-reviews` 车辆估值复核工作台。
- 工作台支持筛选、列表、详情 Drawer、审核通过、审核拒绝、取消。
- 审核通过后可查看车辆当前销售价和销售价历史变化。
- 补充中文标签、菜单和权限控制。

登录修复：

- 移除 JWT 中冗余的完整 `permissions` 数组，避免 ADMIN 权限增长后 `access_token` Cookie 超过 4096 字节。
- 鉴权仍通过 token `sub` 查询数据库并实时重建用户权限。

## 权限和 Seed

新增权限：

```text
vehicle_valuation_review:view
vehicle_valuation_review:create
vehicle_valuation_review:approve
```

菜单位置：

```text
车辆资产 -> 估值复核
```

人工验收前需要执行：

```powershell
pnpm prisma:seed
```

然后退出登录并重新登录，刷新 `access_token`。

## 人工验收清单

### 1. 页面入口

- [x] 打开 `/vehicle-valuation-reviews` 页面返回 200。
- [x] `ADMIN` 可看到“车辆资产 -> 估值复核”菜单。
- [x] 无 `vehicle_valuation_review:view` 权限用户不可见菜单，不能查看列表和详情。
- [x] 页面无控制台阻断性错误。

### 2. 从车辆详情发起估值复核

- [x] 车辆详情残值预测区块可从支持的预测点点击“发起估值复核”。
- [x] `UNSUPPORTED` 预测点不能发起复核。
- [x] 存在 `adoptedResidualAmount` 时，建议复核销售价默认取采用残值。
- [x] 不存在采用残值时，建议复核销售价默认取预测残值。
- [x] 金额按元输入，提交后端按分传递。
- [x] 提交前有二次确认，明确不会修改车辆当前销售价，不会写销售价历史。
- [x] 发起成功后刷新车辆详情中的估值复核记录。
- [x] 发起复核不修改 `Vehicle.currentSalePriceAmount`。
- [x] 发起复核不新增 `VehicleSalePriceHistory`。

### 3. 车辆详情估值复核记录

- [x] 车辆详情展示“估值复核记录”区块。
- [x] 列表展示复核编号、来源、状态、原销售价、预测残值、人工采用残值、请求销售价、审核通过销售价、发起时间、审核时间、原因和操作。
- [x] 支持查看详情。
- [x] 仅 `PENDING` 复核可取消。
- [x] 取消复核不修改车辆当前销售价，不写销售价历史。

### 4. 估值复核工作台

- [x] 工作台支持按复核状态、复核来源、车辆 ID、车辆编号、VIN、开始日期、结束日期筛选。
- [x] 列表展示车辆、VIN、车牌号、来源、状态、价格信息、发起时间、审核时间、原因和操作。
- [x] 金额按元展示并保留 2 位小数。
- [x] 状态和来源以中文 Tag 展示。
- [x] 缺失值展示 `-`。
- [x] 页面不出现 `undefined`、`null`、`NaN`、`[object Object]`、`Invalid Date`。

### 5. 详情 Drawer

- [x] 详情 Drawer 展示复核基础信息。
- [x] 详情 Drawer 展示车辆摘要。
- [x] 详情 Drawer 展示残值预测摘要。
- [x] 详情 Drawer 展示价格复核信息。
- [x] `beforeSnapshot`、`forecastSnapshot`、`approvalSnapshot`、`snapshot` 使用折叠区展示。
- [x] 大段 JSON 不默认展开破坏页面。
- [x] 有销售价历史权限时，可查看车辆销售价历史。

### 6. 审核通过

- [x] 仅 `PENDING` 复核可审核通过。
- [x] 审核通过销售价默认取 `requestedSalePriceAmount`。
- [x] 审核通过前有二次确认，明确会更新当前销售价并写销售价历史。
- [x] 审核通过后复核状态变为 `APPROVED`。
- [x] `Vehicle.currentSalePriceAmount` 更新为 `approvedSalePriceAmount`。
- [x] `Vehicle.currentSalePriceReviewedAt` 更新。
- [x] `nextSalePriceReviewAt` / `salePriceStatus` 按后端销售价复核规则更新。
- [x] 新增 `VehicleSalePriceHistory`。
- [x] 历史记录 `reviewType = RESIDUAL_FORECAST_ADOPTION`，中文展示为“残值预测采用复核”。
- [x] 历史记录 before / after 金额正确。
- [x] 列表和详情刷新。

### 7. 审核拒绝

- [x] 仅 `PENDING` 复核可拒绝。
- [x] 拒绝原因必填。
- [x] 拒绝前有二次确认，明确不会修改当前销售价，不会写销售价历史。
- [x] 拒绝后复核状态变为 `REJECTED`。
- [x] 车辆当前销售价不变。
- [x] `VehicleSalePriceHistory` 不新增记录。
- [x] 拒绝原因在详情中展示。

### 8. 取消复核

- [x] 仅 `PENDING` 复核可取消。
- [x] 取消原因必填。
- [x] 取消前有二次确认，明确不会修改当前销售价，不会写销售价历史。
- [x] 取消后复核状态变为 `CANCELLED`。
- [x] 车辆当前销售价不变。
- [x] `VehicleSalePriceHistory` 不新增记录。
- [x] 取消原因在详情中展示。

### 9. 状态限制

- [x] `PENDING` 可审核通过、审核拒绝、取消。
- [x] `APPROVED` 不可再次审核通过、拒绝或取消。
- [x] `REJECTED` 不可审核通过、拒绝或取消。
- [x] `CANCELLED` 不可审核通过、拒绝或取消。
- [x] 无效操作按钮隐藏或置灰，不触发 API。

### 10. 登录验证

- [x] `admin / Admin@123456` 可登录。
- [x] `admiin / Admin@123456` 按预期返回 401。
- [x] `access_token` Cookie 未超过浏览器 Cookie 大小限制。

## 质量门禁

已通过：

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

测试结果：

```text
31 files / 524 tests passed
Database schema is up to date
```

## 不包含内容

本 PR 不包含：

- 自动覆盖 `Vehicle.currentSalePriceAmount`。
- 采用预测点时修改车辆当前销售价。
- 发起复核时修改车辆当前销售价。
- 拒绝 / 取消时写 `VehicleSalePriceHistory`。
- 修改 ROE 主口径。
- 修改残值敏感性口径。
- AI / ML。
- 爬虫。
- 第三方平台 API。
- 订单状态机修改。
- 车辆状态机修改。

## 验收结论

Stage 8.5 人工验收通过，可以进入后续阶段。

后续建议：

```text
Stage 8.5C：车辆估值复核接入批量审批 / 报表
```
