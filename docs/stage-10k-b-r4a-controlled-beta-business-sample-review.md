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

## R4B P1 closure results

R4B 在本地受控环境执行 authenticated Portal API、资料 ownership、PaymentOrder、ServiceCase 和追踪复核。验证过程中不提交真实手机号、customer cookie、token、AccessKey、AppSecret，不群发短信或微信消息，不发起真实扣款，不修改 Prisma schema，不新增 migration。

执行环境：

```text
API: http://localhost:3201/api
Web: http://localhost:3200
Upload storage: local
Payment provider: MOCK
```

Authenticated Portal API smoke：

```text
结果：通过
public endpoints: 2 passed
authenticated endpoints: 10 passed
cookie/token：未写入文档，未提交
```

客户资料中心 ownership：

```text
结果：通过
测试资料：R4B 专用 1x1 PNG 测试图片，非真实证件
上传：通过
本人 preview：200
无 cookie preview：401
其他客户 preview：404
删除 / 归档：通过
删除后 preview：404
返回 DTO：未暴露 bucket / objectKey
```

订单车辆材料 / 权证 preview ownership：

```text
结果：未执行完成
原因：当前本地数据库 7 个有车订单均未关联 customerVisible=true 且 ACTIVE 的车辆文档
性质：样本 / 运营缺口，不是本轮发现的代码缺陷
```

因此订单车辆材料 preview ownership 仍需准备一个满足条件的 beta 订单样本后复核：

```text
客户订单 -> 订单车辆 -> customerVisible=true ACTIVE 车辆文档
```

PaymentOrder beta 样本：

```text
结果：通过
样本：R4B 本地创建 / 复用 1 个 MOCK PENDING PaymentOrder
paymentOrderNo: PYO202606232239149P9J
未调用 pay
未调用 mock-pay
未发起真实扣款
PaymentRecord: 0
PaymentWriteOff: 0
其他客户 detail：404
无 cookie detail：401
```

PaymentOrder DTO 复核说明：

```text
未返回 requestSnapshot / responseSnapshot / errorSnapshot
返回 providerPrepayId，作为 provider 技术引用保留为后续 DTO 暴露范围复核项
```

ServiceCase beta 样本：

```text
结果：通过
最新样本 caseNo: SC20260623224308W3YQ
客户创建：SUBMITTED
后台可见：通过
后台受理：ACCEPTED
后台更新：IN_PROGRESS
Portal 可见更新：IN_PROGRESS
后台关闭：CLOSED
Portal 可见关闭：CLOSED
其他客户 detail：404
无 cookie detail：401
未自动修改车辆状态
未自动生成费用账单
```

脚本调试期间共创建 4 个 R4B 标记工单，均已关闭：

```text
SC202606232240012M48: CLOSED
SC202606232241054GZC: CLOSED
SC20260623224144ZYAP: CLOSED
SC20260623224308W3YQ: CLOSED
```

通知 / 工单 / 支付追踪：

```text
ServiceCaseAction: 4
NotificationEvent: 4
NotificationRecord: 4
PaymentOrder: PENDING
PaymentRecord: 0
PaymentWriteOff: 0
5xx：未发现
权限越权：未发现
```

R4B 判断：

```text
P0: 0
P1: authenticated Portal API smoke、资料 ownership、PaymentOrder、ServiceCase 已关闭
剩余缺口：订单车辆材料 preview ownership 缺可执行样本，降级为 P2 运营样本缺口
是否继续 beta：建议继续 controlled beta monitoring
是否扩大白名单：暂不建议
是否暂停 beta：不建议
```

## R4C order vehicle document preview ownership closure

R4C 在本地受控环境补充订单车辆材料样本，并执行 Portal list / preview ownership 复核。验证过程中不提交真实行驶证、真实保单、完整 VIN、完整车牌、customer cookie、token、AccessKey 或 AppSecret；不修改业务逻辑、Prisma schema 或 migration。

执行环境：

```text
API: http://localhost:3201/api
Web: http://localhost:3200
Upload storage: local
```

样本范围：

```text
Customer A: 受控 beta 客户，手机号已脱敏
Order A: ORD2...PJUG
Vehicle A: VEH2...TEH6 / VIN LE4Z****0762
Cross-customer: Customer B
```

样本材料：

```text
documentType: VEHICLE_LICENSE
文件类型：application/pdf
材料性质：R4C 测试占位 PDF，文件内容明确标记为测试材料 / 非正式材料
敏感信息：不包含真实证件号、完整 VIN、完整车牌、真实保单号
创建方式：后台车辆材料上传 API
```

Portal documents list：

```text
GET /api/portal/orders/:id/documents
结果：通过
HTTP: 200
返回数量：1
返回刚创建的 customerVisible=true ACTIVE VEHICLE_LICENSE
customerVisible=false 测试材料未出现在列表
未暴露 bucket / objectKey
未暴露 uploadedBy / deletedAt / policyId / vehicleId
```

本人 preview：

```text
GET /api/portal/orders/:id/documents/:documentId/preview
结果：通过
HTTP: 200
Content-Type: application/pdf
返回文件流
未返回 OSS public URL
```

无 cookie preview：

```text
结果：通过
HTTP: 401
```

跨客户 preview：

```text
结果：通过
HTTP: 404
说明：与当前 ownership 口径一致，对他人订单 / 文档返回 not found
```

customerVisible=false 验证：

```text
结果：通过
Portal list 不返回
preview HTTP: 404
```

测试材料清理：

```text
visible test document: ARCHIVED, customerVisible=false
hidden test document: ARCHIVED, customerVisible=false
是否保留为客户可见材料：否
```

R4C 判断：

```text
订单车辆材料 preview ownership：已关闭
P2 订单车辆材料样本缺口：已关闭
是否继续 beta：建议继续 controlled beta monitoring
是否扩大白名单：暂不建议
是否暂停 beta：不建议
```

## 问题和风险

| 等级 | 数量 | 说明 |
| --- | ---: | --- |
| P0 | 0 | 未发现需要暂停 beta 的阻断问题 |
| P1 | 0 | R4B 已关闭 authenticated Portal API smoke、资料 ownership、PaymentOrder 和 ServiceCase 验证缺口 |
| P2 | 4 | 车辆商品内容部分缺失；公开 catalog 选中车辆车况报告返回 404；PaymentOrder provider 技术引用 DTO 暴露范围待复核；真实短信 / beta gate 仍需 staging controlled account 复核 |
| P3 | 1 | Next dev 日志存在 Ant Design deprecation warnings，不影响本轮验收 |

## 运营待办

1. 在 staging/production controlled account 上完成真实短信登录和非白名单拒绝复核。
2. 补齐 Portal 商品内容：车况摘要、费用说明、申请流程、FAQ。
3. 复核公开 catalog 车辆与 customer-visible 车况报告的映射。
4. 复核 PaymentOrder Portal DTO 中 provider 技术引用字段是否需要对客户隐藏。
5. 确认 beta allowlist 仅存在于环境变量或密钥系统，不进入 Git。

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
进入 Stage 10X-B 车型代码主数据化影响审计。
```
