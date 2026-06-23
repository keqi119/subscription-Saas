# Stage 10K-B-R4A Controlled Beta 业务样本复核

## 结论

本轮完成 controlled beta 业务样本只读复核。复核不修改业务代码、不修改 Prisma schema、不新增 migration、不发起真实短信/微信消息/扣款，不提交真实手机号、客户 cookie 或 secret。

结论：

```text
建议继续 controlled beta monitoring。
暂不建议扩大白名单。
不需要暂停 beta。
不允许进入 unrestricted launch。
```

原因：

- Portal 公开路由、公开 catalog API、后台管理 GET、资产收益报表和 CSV 复核通过。
- ROE / BaaS / 折旧 / 市场校准报表样例仍与 Stage 10N-C-D 结论一致。
- 当前本地环境未启用 `PORTAL_BETA_MODE`，且未提供真实客户 cookie，本轮不能完成真实短信登录、authenticated Portal API、客户数据隔离、资料上传预览、服务工单和支付全链路复核。

## 样本范围

客户样本数量：3。

| 样本 | 脱敏手机号 | Portal 账号 | 自助申请 | 资料 | 订单 | 账单 | 通知 | 备注 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 客户 A | 186****0212 | 有 | 1 | 4 | 1 | 1 | 2 | 覆盖 Portal 账号、资料中心、自助申请、订单和通知 |
| 客户 B | 139****1010 | 有 | 0 | 0 | 0 | 0 | 4 | 覆盖通知样本 |
| 客户 C | 181****6304 | 有 | 0 | 0 | 0 | 0 | 0 | 覆盖登录账号样本 |

车辆样本数量：3。

| 样本 | 车辆编号 | VIN/车牌 | Portal 商品 | 车况报告 | 保单/权证 | BaaS | 折旧 / ROE | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 车辆 A | `VEH20260622132627EQP8` | 已脱敏 | 已发布，可见 | 1 个 PUBLISHED | 2 份客户可见文档，2 张保单 | 1 个合同，12 条成本记录 | 无折旧 policy | 覆盖车辆商品、图集、车况、保单/权证、BaaS |
| 车辆 B | `STAGE10NCD-VEH-B` | 已脱敏 | 不可见 | 无 | 无 | 1 个合同，4 条成本记录 | 1 个 policy，1 条 record | 覆盖 BaaS / 折旧 / ROE 样例 |
| 车辆 C | `VEH20260623170752MCJY` | 已脱敏 | 不可见 | 无 | 2 张保单 | 无 | 无 | 覆盖保险后台样本 |

## Portal 主链路

执行：

```text
PORTAL_BASE_URL=http://localhost:3200
PORTAL_SMOKE_TIMEOUT_MS=30000
pnpm portal:route-smoke
```

结果：通过。

覆盖路由：

```text
/portal/login
/portal
/portal/catalog
/portal/materials
/portal/applications
/portal/orders
/portal/bills
/portal/payment-orders
/portal/service-cases
/portal/notifications
```

公开 Portal API：

```text
PORTAL_API_BASE_URL=http://localhost:3201/api
PORTAL_API_SMOKE_TIMEOUT_MS=30000
pnpm portal:api-smoke
```

结果：

- `/portal/catalog/vehicles`: 200
- `/portal/catalog/subscription-plans`: 200
- authenticated Portal API smoke: skipped，因为本轮未提供 `PORTAL_CUSTOMER_COOKIE`

未执行项：

- 真实短信登录未执行。
- 非白名单客户拦截未执行。
- authenticated Portal API 未执行。
- 资料上传/预览的真实客户 ownership 检查未执行。
- 客户只能看自己的订单/账单/工单/通知未用 customer cookie 复核。

本地环境状态：

```text
PORTAL_BETA_MODE: disabled
PORTAL_BETA_ALLOWED_PHONES: 0
PORTAL_SMS_ENABLED: disabled
PORTAL_SMS_DEBUG_CODE: disabled
PORTAL_SMS_PROVIDER: not configured
```

因此，本轮仅证明本地公开路由和公开 API 可用；真实 invited beta 登录和白名单 gate 必须在 staging/production controlled account 上复核。

## 后台运营链路

后台只读 GET 复核通过。

| 模块 | 结果 | 样本数量 |
| --- | --- | ---: |
| `/vehicles` | 可查询 | 12 |
| `/vehicle-insurance-policies` | 可查询 | 4 |
| `/vehicle-baas-contracts` | 可查询 | 2 |
| `/vehicle-depreciation-policies` | 可查询 | 4 |
| `/service-cases` | 可查询但无样本 | 0 |
| `/notifications/records` | 可查询 | 6 |
| `/notifications/events` | 可查询 | 5 |
| `/reports/asset-profitability` | 报表 API / CSV 可查询 | 5 台 ROE 样例车 |

后台菜单和权限在 `pnpm release:check`、API typecheck、API tests 中复核通过；如 staging 后台菜单不可见，仍需退出重登刷新 token。

## 车辆商品内容

公开 catalog API：

- 车辆列表数量：3。
- 订阅套餐数量：5。
- 车辆详情 API：可返回。
- 样本车辆详情有费用说明和套餐。
- 选中公开 catalog 车辆的车况报告 endpoint 返回 404。

车辆 A 数据侧完整度：

| 项目 | 状态 |
| --- | --- |
| 展示标题 | 完整 |
| 封面图 / 图集 | 图集完整，含 13 个媒体 |
| 车况摘要 | 缺失 |
| 正式车况报告 | 完整，1 个 PUBLISHED |
| 电池信息 | 部分完整 |
| 展示套餐 | 完整，2 个计划 |
| 费用说明 | 缺失 |
| 申请流程 | 缺失 |
| FAQ | 缺失 |

判断：车辆商品链路可浏览，但内容完整度仍是运营待办。车况报告和公开 catalog 车辆之间需要再做一次人工映射复核。

## 资料中心和申请材料

客户 A 覆盖：

- Portal account: 有。
- self-service application: 1。
- profile materials: 4。
- order: 1。
- receivable bill: 1。

本轮只读确认后台数据存在，Portal route smoke 覆盖 `/portal/materials`、`/portal/applications`、`/portal/applications/[id]` 的页面可达性。

未执行：

- 真实上传。
- 真实预览。
- 申请详情顶部材料提示的 authenticated 检查。
- ownership 负向验证。

这些需要 controlled customer cookie 或人工浏览器验收。

## 保单 / 权证

数据侧：

- 保险 policy：4。
- 车辆 document：6。
- customerVisible document：2。
- 车辆 A：2 张保单，6 份车辆文档，其中 2 份客户可见。
- 车辆 C：2 张保单。

后台 `/vehicle-insurance-policies` 可查询。客户侧只读可见性原则仍是：

```text
客户只应看到 customerVisible=true 的材料。
```

本轮未用 customer cookie 复核客户侧文档预览，因此不扩大白名单前需做一次真实客户 ownership 检查。

## BaaS / 折旧 / ROE

数据侧：

- BaaS contracts：2。
- BaaS cost records：16。
- Depreciation policies：4。
- Depreciation records：2。

ROE 样例报表复核：

| 指标 | 结果 |
| --- | ---: |
| vehicleCount | 5 |
| platformNetIncomeAmount | 335205 |
| baasCostAmount | 12000 |
| depreciationAmount | 52795 |
| depreciationRecordAmount | 38000 |
| marketCalibratedPlatformNetIncomeAmount | 255205 |

车辆行覆盖：

- `STAGE10NCD-VEH-A`: `LEGACY_COST_PROFILE` + `ADOPTED`
- `STAGE10NCD-VEH-B`: `RECORDS` + BaaS + `PREDICTED`
- `STAGE10NCD-VEH-C`: `RECORDS`
- `STAGE10NCD-VEH-D`: `UNAVAILABLE`
- `STAGE10NCD-VEH-E`: `NONE`

CSV 复核：

- summary CSV 包含市场校准字段。
- vehicle list CSV 包含 `STAGE10NCD-VEH-B`。
- vehicle detail CSV 包含 BaaS 字段。

结论：BaaS / 折旧 / ROE 样例可继续用于 controlled beta 经营分析复核；仍不建议作为 unrestricted launch 正式财务口径。

## 支付 / 通知 / 工单

支付：

- `PaymentOrder`: 0。
- `PaymentRecord`: 1。
- `PaymentWriteOff`: 2。
- 本轮未发起真实扣款。

通知：

- `NotificationRecord`: 6。
- `NotificationEvent`: 5。
- 本轮未群发短信或微信消息。

工单：

- `ServiceCase`: 0。
- Portal service case sample: 0。
- `/service-cases` 和 `/portal/service-cases` 路由可达，但无业务样本可复核处理流。

结论：通知记录可查；支付和工单缺少本轮 beta 业务样本，不建议在关闭这些样本缺口前扩大白名单。

## 问题和风险

| 等级 | 数量 | 说明 |
| --- | ---: | --- |
| P0 | 0 | 未发现需要暂停 beta 的阻断问题 |
| P1 | 2 | 未执行真实短信/白名单登录；未执行 authenticated customer cookie ownership 复核 |
| P2 | 4 | 服务工单无样本；PaymentOrder 无样本；车辆商品内容部分缺失；公开 catalog 选中车辆车况报告返回 404 |
| P3 | 1 | Next dev 日志存在 Ant Design deprecation warnings，不影响本轮验收 |

## 运营待办

1. 在 staging/production controlled account 上完成真实短信登录和非白名单拒绝复核。
2. 提供一次短期 `PORTAL_CUSTOMER_COOKIE`，运行 authenticated `pnpm portal:api-smoke`，完成客户数据隔离复核。
3. 为至少 1 个 beta 客户创建服务工单样本，覆盖提交、后台处理、客户查看。
4. 准备 1 个 PaymentOrder 样本或明确采用历史支付验证证据。
5. 补齐 Portal 商品内容：车况摘要、费用说明、申请流程、FAQ。
6. 复核公开 catalog 车辆与 customer-visible 车况报告的映射。
7. 确认 beta allowlist 仅存在于环境变量或密钥系统，不进入 Git。

## 文档更新状态

已更新：

- `docs/customer-portal-release-checklist.md`
- `README.md`

不存在，记录 not found：

- `docs/customer-portal-beta-monitoring-report.md`
- `docs/customer-portal-beta-day1-report.md`
- `docs/customer-portal-active-beta-launch-report.md`
- `docs/customer-portal-beta-feedback-log.md`

## 建议

是否继续 beta：

```text
建议继续 controlled beta monitoring。
```

是否扩大白名单：

```text
暂不建议扩大白名单。
```

是否暂停 beta：

```text
不建议暂停；当前未发现 P0。
```

下一步建议：

```text
先关闭 R4A 的 P1 验证缺口，再进入 Stage 10X-B 车型代码主数据化影响审计。
```
