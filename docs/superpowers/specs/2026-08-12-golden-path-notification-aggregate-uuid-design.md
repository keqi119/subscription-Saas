# Golden Path 通知聚合 UUID 修复设计

## 背景

申请 `APP20260811071250MC2M` 完成最终方案人工确认后，最终方案已正确继承 A 线进件的 24 期套餐和软锁车辆，但 Journey 在 `CUSTOMER_PLAN_CONFIRMATION` 的微信通知任务中进入 `EXCEPTION`。

生产证据显示：

- Journey ID 为 CUID：`cmsobpjav000001p19v68hers`；
- `SubscriptionJourneyNotificationService` 将 `job.journeyId` 作为通知事件的 `aggregateId`；
- `notification_event.aggregate_id` 是 PostgreSQL UUID 字段；
- 通知事件和通知记录均未创建，任务重试 5 次后进入 `DEAD_LETTER`；
- 微信接口尚未被调用，因此故障与模板 ID 或微信平台无关。

## 目标

1. 所有 Golden Path 客户通知只向 `notification_event.aggregate_id` 写入合法 UUID。
2. 最终方案待确认通知以 Application 为业务聚合。
3. 订单产生后的合同、支付和交付通知以 SubscriptionOrder 为业务聚合。
4. Journey CUID 仅保留在通知 payload 和现有幂等键中。
5. 不修改数据库结构，不改变通知模板、通知重试和微信成功门槛。

## 非目标

- 不修改 Golden Path 步骤顺序。
- 不调整微信模板字段或模板 ID。
- 不清理历史 Journey 异常记录。
- 不修改 A/B 线最终方案页面 UI；该问题单独处理。

## 方案比较

### 方案 A：将 `notification_event.aggregate_id` 改为字符串

能够直接保存 Journey CUID，但会引入数据库迁移，并扩大所有通知事件聚合 ID 的类型边界。当前其他通知均以 UUID 业务实体为聚合，该方案影响面过大，不采用。

### 方案 B：所有 Journey 通知统一使用 Application UUID

改动最小且可消除 UUID 错误，但订单创建后的合同、支付和交付通知会失去订单聚合语义，不采用。

### 方案 C：按业务阶段选择 Application 或 SubscriptionOrder UUID

最终方案确认发生在订单创建前，使用 Application UUID；订单创建后的通知使用 SubscriptionOrder UUID。Journey CUID 写入 payload，并继续包含在现有 eventKey/幂等键中。该方案兼顾最小改动、字段约束和业务语义，确定采用。

## 详细设计

### 聚合映射

`SubscriptionJourneyNotificationService.dispatch()` 在加载 Journey 上下文后生成通知聚合：

| 场景 | `aggregateType` | `aggregateId` |
| --- | --- | --- |
| `CUSTOMER_PLAN_CONFIRMATION` | `Application` | `context.application.id` |
| 已存在订单的合同、支付、交付通知 | `SubscriptionOrder` | `context.order.id` |

实现采用一个局部纯函数解析聚合：存在 `context.order` 时返回订单聚合，否则返回申请聚合。当前支持的无订单通知只有最终方案待确认；需要订单的其他通知已由 `notificationDefinition()` 校验上下文。

### Journey 身份保留

通知 `data` 增加 `journeyId: job.journeyId`，供排障与事件追踪使用。现有 `eventKey` 和 `idempotencyKey` 不变，因此重试不会产生新的业务幂等身份。

### 错误与重试

- `requireWechatSuccess: true` 保持不变；微信未成功送达时 Journey 仍进入可重试异常。
- 本修复不吞掉通知错误，也不把微信失败误判为步骤成功。
- 修复部署后，由管理员对当前 `CUSTOMER_PLAN_CONFIRMATION` 失败步骤执行“重试失败步骤”。

## 测试设计

在 `apps/api/test/subscription-journey-notification.spec.ts` 先增加失败测试：

1. 最终方案待确认通知必须调用 `notifyCustomer()`，并传入 Application UUID、`aggregateType: "Application"` 和 Journey CUID payload。
2. 已有订单的通知必须传入 SubscriptionOrder UUID、`aggregateType: "SubscriptionOrder"` 和 Journey CUID payload。
3. 保留现有微信成功、模板语义数据、幂等键及失败重试测试。

完成实现后运行：

```powershell
pnpm --filter @subscription-saas/api test -- subscription-journey-notification.spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/api lint
pnpm prisma:validate
```

## 验收标准

1. 聚焦测试在修复前因 `aggregateId` 仍为 Journey CUID 而失败，修复后通过。
2. API 类型检查、lint 和 Prisma validate 通过。
3. staging 重试后，Journey 从 `CUSTOMER_PLAN_CONFIRMATION / EXCEPTION` 恢复。
4. 新建 `notification_event.aggregate_id` 为 Application UUID，通知记录使用 `FINAL_PLAN_READY_WECHAT`。
5. 微信通知状态达到 `SENT` 或 `READ` 后，Journey 保持 `WAITING_CUSTOMER / CUSTOMER_PLAN_CONFIRMATION`，不再进入 UUID 异常。

