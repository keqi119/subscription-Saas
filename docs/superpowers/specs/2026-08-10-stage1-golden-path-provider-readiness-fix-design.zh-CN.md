# Stage 1 Golden Path 真实供应商验收就绪修复设计

日期：2026-08-10
状态：已确认，待实施

## 1. 背景与问题

`Staging-20260809-169d000-r2` 已部署并完成数据库迁移，三个既有微信模板 ID 也已进入服务器受控配置。生产前专项自动化通过，但真实供应商预检发现以下阻断：

1. 通知服务只为服务工单构造微信模板变量，申请进度、最终方案、合同待签、首期账单待支付和交付通知仍把通用业务字段直接传给微信，无法满足已领用模板的真实变量名。
2. `HANDOVER_ESIGN_PENDING` 错误复用申请进度模板，不符合微信“一场景一模板”的约束。
3. Golden Path 生产预检未要求独立交付模板配置，无法在放量前阻止错误复用。
4. 法大大本地客户现有正式绑定与批准的生产验收签署人不一致，不能直接覆盖数据库绑定。
5. 当前主线发布检查因车辆工作区局部变量名 `vehicleModel` 触发兼容字段移除门禁。

发现阻断后已按运行手册设置 `SUBSCRIPTION_JOURNEY_ENABLED=false`，并保持 `SUBSCRIPTION_JOURNEY_WORKER_ENABLED=true`。本修复不在阻断解除前创建新的验收 Journey。

## 2. 目标

- 为五个客户动作场景生成与微信已领用模板完全一致的数据字段。
- 为交付流程使用独立模板和独立环境变量，禁止回退到申请进度模板。
- 在生产预检阶段 fail-closed：缺少任一模板 ID 时不得开启 Golden Path。
- 缺少真实模板必填数据时不调用微信接口，让 Journey 进入现有可重试异常机制。
- 通过现有正式流程建立法大大生产验收绑定，不直接修改数据库事实。
- 修复当前发布检查门禁，不改变车辆工作区 UI 或业务行为。

## 3. 非目标

- 不新增数据库表、字段或 migration。
- 不新增通知模板后台配置页面，也不把字段映射改为数据库 JSON。
- 不调整 Journey 步骤、人工决定数量、支付、交付或激活规则。
- 不替换微信、法大大或支付供应商。
- 不扩大 Journey allowlist，不启用委托代扣，不使用 mock/sandbox 绕过验收。

## 4. 已核验的微信模板契约

真实模板 ID 只保存在服务器受控配置中，不提交到 Git。下表字段来自微信公众平台官方模板列表接口的只读核验结果。

| 场景 | 环境变量 | 模板标题 | 微信变量 |
|---|---|---|---|
| 申请已受理 | `WECHAT_TEMPLATE_APPLICATION_PROGRESS` | 订单已受理通知 | `character_string3` 订单编号、`const4` 订单状态、`const5` 服务类型、`time6` 用车时间 |
| 最终方案待确认 | `WECHAT_TEMPLATE_FINAL_PLAN_PENDING` | 服务单确认提醒 | `character_string2` 服务单号、`phrase5` 服务状态、`car_number8` 车牌号、`thing13` 服务项目、`time9` 发送时间 |
| 合同待签署 | `WECHAT_TEMPLATE_CONTRACT_PENDING` | 合同签订审核通知 | `character_string2` 订单编号、`thing3` 车型名称、`thing6` 签署项目、`thing1` 客户名称 |
| 首期账单待支付 | `WECHAT_TEMPLATE_PAYMENT_PENDING` | 租车账单生成通知 | `car_number1` 车牌号、`thing2` 账单名称、`amount4` 账单金额、`amount7` 应付金额、`time5` 还款日期 |
| 车辆待取车 | `WECHAT_TEMPLATE_HANDOVER_PENDING` | 订单待取车提醒（模板库编号 `50720`） | `character_string1` 订单号、`thing9` 车辆名称、`car_number5` 车牌号、`thing11` 客户名称 |

申请模板的常量值使用微信平台已提交审核的业务枚举：

- `const4 = 已受理`
- `const5 = 车辆订阅`

在常量审核通过且单 OpenID 真实 smoke 成功前，Journey 必须保持关闭。

## 5. 运行时字段映射

### 5.1 语义数据来源

`SubscriptionJourneyNotificationService` 继续只负责读取权威领域事实并传递稳定语义字段：

- Application：`applicationNo`、`finalPlanRevision`、`finalVehicleId`；
- Customer：客户名称由通知服务按 `customerId` 读取；
- Order：`orderNo`、`modelDisplayNameSnapshot`、`vehicleId`；
- ReceivableBill：首期 `DEPOSIT` 与 `FIRST_MONTHLY_FEE` 有效账单的原始金额、剩余金额和最早到期日；
- Vehicle：`plateNo`，车型展示优先使用订单快照，不从可变商品文案反推；
- 通知时间：由通知服务在发送时生成，格式为 `YYYY-MM-DD HH:mm`。

最终方案通知在订单创建前发送，因此根据 `Application.finalVehicleId` 读取车辆车牌。合同、支付和交付通知在订单创建后发送，因此使用订单快照和订单关联车辆。支付通知只聚合当前订单中未删除、未取消的首期押金与首期租金账单，不包含后续期次或其他费用。

### 5.2 微信变量映射

| 通知类型 | 映射 |
|---|---|
| `APPLICATION_PROGRESS` | `character_string3=applicationNo/aggregateNo`；`const4=已受理`；`const5=车辆订阅`；`time6=发送时间` |
| `FINAL_PLAN_PENDING` | `character_string2=applicationNo`；`phrase5=待确认`；`car_number8=plateNo`；`thing13=车辆订阅最终方案`；`time9=发送时间` |
| `CONTRACT_PENDING` | `character_string2=orderNo`；`thing3=modelDisplayNameSnapshot`；`thing6=车辆订阅主合同`；`thing1=customerName` |
| `PAYMENT_PENDING` | `car_number1=plateNo`；`thing2=押金及首期租金`（无押金时为 `首期租金`）；`amount4=首期账单原始金额合计`；`amount7=当前剩余金额合计`；`time5=最早到期日` |
| `HANDOVER_ESIGN_PENDING` | `character_string1=orderNo`；`thing9=modelDisplayNameSnapshot`；`car_number5=plateNo`；`thing11=customerName` |

`thing` 字段按微信限制截断为最多 20 个 Unicode 字符；业务编号按 `character_string` 限制截断为最多 32 个字符。车牌号必须是非空权威车牌，不以 VIN 或车辆编号替代。金额由分转换为两位小数的人民币元字符串，使用整数运算，禁止经过浮点数计算。

### 5.3 精确发送与兼容

通知记录仍保留通用业务 payload 供站内信和审计使用；调用微信 Provider 时，上述五个场景只发送各自模板声明的精确变量，不附带无关通用键。其他既有通知类型保持当前行为。

如果模板必需的编号、车牌、车型、客户名称、首期账单或到期日为空：

1. 不调用微信接口；
2. 微信通知记录写入稳定错误码 `WECHAT_TEMPLATE_DATA_MISSING:<field>`；
3. 普通申请提交通知继续由现有 `safeNotifyCustomer` 隔离，不回滚申请；
4. Golden Path 客户动作通知因 `requireWechatSuccess=true` 判定未送达，由 Journey 现有重试、死信和异常投影处理。

## 6. 配置与生产预检

新增受控配置：

```env
WECHAT_TEMPLATE_HANDOVER_PENDING=<CHANGE_ME>
```

同步更新 `.env.example`、staging/production compose 示例、微信配置说明和 Golden Path 运行手册。提交文件中只保留 `<CHANGE_ME>`，不出现真实模板 ID。

`stage1-golden-path-production-preflight.mjs` 将独立交付模板加入必填项。生产镜像仅在 Journey 关闭时允许示例默认值；准备开启验收时，上述五个模板 ID 均必须是非空、非 `<CHANGE_ME>` 的真实值。

模板 ID 的路由调整为：

- `HANDOVER_ESIGN_PENDING -> WECHAT_TEMPLATE_HANDOVER_PENDING`
- 禁止 `HANDOVER_ESIGN_PENDING -> WECHAT_TEMPLATE_APPLICATION_PROGRESS` 回退。

## 7. 法大大生产验收绑定

法大大阻断不通过代码或 SQL 修复。使用以下受控流程：

1. 通过现有客户创建入口建立专用、非运营验收客户；
2. 通过现有法大大正式开户/实名/绑定流程关联已批准的生产验收签署人；
3. 只读确认本地正式绑定的 Provider Customer ID 与受控配置中的批准签署人一致；
4. 将新客户精确加入 Journey customer allowlist，并移除不再使用的旧验收客户；
5. 重新运行法大大签署人和上传/签署地址生产预检。

禁止直接更新 Provider Customer ID、复用 sandbox 绑定或扩大普通客户 allowlist。

## 8. 发布门禁修复

将 `vehicle-workspace-header.tsx` 的局部展示变量 `vehicleModel` 重命名为 `vehicleDisplayName`。该变量仍由品牌、车系、车型展示名组合，不改变渲染内容、接口或 UI。

## 9. 测试与验收

### 9.1 自动测试

- 通知服务测试逐场景断言发送给 Provider 的精确字段、金额换算及裁剪结果；
- 缺少车牌、车型、编号、首期账单或到期日时断言不调用 Provider，并产生稳定失败记录；
- Journey 通知测试覆盖最终车辆、订单快照和车牌的权威读取；
- 预检测试证明独立交付模板缺失或仍为 `<CHANGE_ME>` 时 fail-closed；
- smoke 脚本支持 `HANDOVER_PENDING`，使用显式 JSON 数据执行单 OpenID 验证；
- Golden Path API/Web 专项测试、类型检查、lint、build 和 `pnpm release:check` 全部通过；
- migration 状态保持 88 个 migration、schema up to date，不生成新 migration。

### 9.2 真实供应商验收门禁

在恢复 Journey 前依次完成：

1. 五个模板均通过官方列表接口读取并核对字段；
2. 五个模板对单一授权 OpenID 的真实 smoke 均返回发送成功；
3. 申请模板的 `已受理`、`车辆订阅` 常量已获微信批准；
4. 法大大专用验收客户完成生产正式绑定并通过只读预检；
5. API/Web 新镜像 1:1 部署、数据库迁移状态正常；
6. 再设置 `SUBSCRIPTION_JOURNEY_ENABLED=true`，先执行 A 线，再使用新 Application 执行 B 线。

任一门禁失败时继续保持 Journey 关闭、Worker 开启、allowlist 精确，不删除失败通知、Job、Exception 或供应商审计事实。

## 10. 兼容、回滚与安全

- 数据库和 API 合约不变，旧订单和非 Journey 通知不受影响；
- 回滚只需恢复上一版 API/Web 镜像并保持 Journey 关闭；
- 新增环境变量未配置时 fail-closed，不回退到错误模板；
- Git、测试输出和验收证据不得包含 AppSecret、access token、完整 OpenID、完整客户证件、签署 URL、支付凭据或 Provider 原始敏感 payload；
- 真实模板 ID 仅写入服务器权限为 `600` 的受控环境文件，并在修改前保留同权限备份。
