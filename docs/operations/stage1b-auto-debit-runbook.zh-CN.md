# Stage 1 自动扣款退役与历史审计运行手册

## 1. 适用范围与不可变基线

微信委托代扣申请已被驳回，Stage 1 的收款基线固定为“账单提醒 + 主动支付”。本手册用于安全退役历史自动扣款执行任务，并验证周期账单、催收和微信 JSAPI 主动支付继续运行。

所有环境必须同时满足：

```dotenv
AUTO_DEBIT_ENABLED=false
PAYMENT_MANDATE_PROVIDER=disabled
PAYMENT_MANDATE_MOCK_ENABLED=false
```

`BILLING_AUTOMATION_WORKER_ENABLED=true` 与 `WECHAT_PAY_ENABLED=true` 不受退役影响。`AUTO_DEBIT_RUN_TIME`、`WECHAT_AUTO_RENEW_TEMPLATE_ID` 及旧供应商密钥仅属于历史兼容配置，不是启用入口；不得通过修改这些值恢复代扣。

## 2. 退役前检查

- 固定目标 API/Web 镜像摘要和数据库目标，确认变更单与操作人。
- 确认新代码已经让 worker 不再 claim `SUBMIT_BILL_DEBIT`、`QUERY_DEBIT_ATTEMPT`、`SEND_DEBIT_FAILURE_NOTICE`、`SYNC_PAYMENT_MANDATE`。
- 确认 Portal 只有账单主动支付入口，Admin 代扣页面只读。
- 备份数据库并准备归档 dry-run JSON；不得执行 `migrate reset`、`db push` 或直接更新任务状态。

## 3. 固定退役顺序

1. 先部署包含运行时强制禁用和 worker 退役逻辑的新 API/Web 镜像，确认服务 healthy。
2. 执行 `pnpm stage1:auto-debit-retirement:dry-run`，将完整 JSON 输出归档到变更单。
3. 若报告包含 live lease（`blockedProcessingCount > 0`），等待租约窗口结束后重新执行 dry-run；不得强制取消仍在执行的任务。
4. 在已批准的发布窗口执行 `pnpm stage1:auto-debit-retirement:apply`。该命令只取消可安全退役的任务，并为每条变更写入 AuditLog。
5. 再次执行 `pnpm stage1:auto-debit-retirement:dry-run`，要求 `postcondition.executableJobCount = 0` 且 `blockedProcessingCount = 0`。
6. 验证月租账单生成、到期提醒、逾期提醒、催收案件创建、Portal `去支付`、微信 JSAPI 回调、PaymentRecord 和 WriteOff 全链路。
7. 验证历史 Mandate、Attempt、PaymentOrder、PaymentRecord 与 WriteOff 页面仍可读取，且客户和 Admin 页面均无代扣动作控件。

`apply` 不删除 Mandate、Attempt、PaymentOrder、PaymentRecord、WriteOff、BillingAutomationJob 历史或 AuditLog。重复执行必须保持幂等。

## 4. 报告判定与阻断

以下任一情况必须停止 apply 并升级处理：

- dry-run 无法连接已批准的目标数据库；
- 存在 live lease 或 `blockedProcessingCount > 0`；
- 输出包含无法识别的任务类型或缺失任务标识；
- 目标环境三项禁用配置任一不符合基线；
- 新镜像仍暴露客户/Admin 代扣写接口或动作控件。

历史 Mandate/Attempt 数量可以大于零，属于应保留的审计事实，不构成验收失败。`PENDING` 或租约已过期的 `PROCESSING` 退役任务必须由工具审计取消；不得手工改库。

## 5. 主动支付与催收验收

至少选择一笔客户发起的微信 JSAPI 支付，核对：

1. Portal 待付账单持续显示 `去支付`，并明确说明“账单提醒 + 主动支付”。
2. 客户创建独立 PaymentOrder，微信回调通过验签与幂等校验。
3. PaymentRecord 达到 `CONFIRMED`，WriteOff 正确减少账单 `remainingAmount`。
4. 未支付账单仍按既有节奏产生到期、逾期提醒，并进入催收案件。
5. 未分配收款继续纳入正常财务核对，不归入历史自动扣款汇总。

## 6. 历史审计验证

- Admin 显示“历史自动扣款（已停用）”，仅提供状态、客户、订单、账单、金额、历史供应商模式和结算证据。
- 订单财务页保留 `Mandate → Attempt → PaymentOrder → PaymentRecord → WriteOff` 证据链。
- 不提供人工扣款、查询供应商结果、同步/关闭授权、设置模拟结果或取消退役任务的操作。
- 查询历史记录不得产生新的 provider 请求、BillingAutomationJob、PaymentOrder 或 AuditLog 写入。

## 7. 回滚

回滚只允许恢复上一版应用镜像，并保持周期账单 worker、催收与主动支付可用。回滚不得删除或改写审计、任务、授权、扣款尝试、支付、收款或核销历史，也不得重新启用自动扣款。

若上一版镜像会 claim 退役任务或暴露代扣写入口，则不满足安全回滚条件；应继续使用当前镜像并按故障流程修复，而不是恢复旧执行面。
