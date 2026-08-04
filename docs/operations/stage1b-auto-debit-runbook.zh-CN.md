# Stage 1B 自动扣款发布与验收运行手册

## 1. 适用范围

本手册用于 Stage 1B-A 自动扣款基础能力的 Staging Mock 验收和 Production 发布安全检查。当前商户尚未开通微信委托扣款，也没有审核通过的自动续费模板 ID；因此 Staging 的 `mock` 只验证平台编排和持久化事实，**不代表真实微信签约或真实资金扣款**。

Portal 产品交互长图：[`2026-08-04-stage1b-wechat-auto-debit-portal-flow-long.png`](../superpowers/specs/assets/2026-08-04-stage1b-wechat-auto-debit-portal-flow-long.png)。

## 2. 环境安全基线

| 环境 | `AUTO_DEBIT_ENABLED` | `PAYMENT_MANDATE_PROVIDER` | `PAYMENT_MANDATE_MOCK_ENABLED` | 说明 |
| --- | --- | --- | --- | --- |
| Staging | `true` | `mock` | `true` | 页面必须显示 `STAGING MOCK`，不发生真实扣款 |
| Production | `false` | `disabled` | `false` | 商户能力、模板和真实适配器验收前不得开启 |

`BILLING_AUTOMATION_WORKER_ENABLED=true` 与 `PAYMENT_PROVIDER` 独立配置。关闭自动扣款不得停止周期账单 worker，也不得关闭客户主动支付。

Production 只要选择 `mock` 就必须启动失败。选择 `wechat_auto_renew` 且未提供 `WECHAT_AUTO_RENEW_TEMPLATE_ID` 也必须启动失败。当前版本尚未实现真实微信适配器，即使填写模板也不得在 Production 开启。

## 3. 固定发布顺序

1. 备份数据库和 `.env.*.images`，确认目标 API/Web 镜像摘要。
2. 启动并等待 PostgreSQL healthy，拉取新 API/Web 镜像。
3. 用新 API 镜像执行 `pnpm --filter @subscription-saas/api prisma:migrate:deploy`。
4. migration 成功后启动 API/Web；等待两个容器均为 `healthy`。
5. 执行公网 `/api/health`、电子签回调 OPTIONS 和 Portal 路由检查。

完整命令见 [`docs/deployment.md`](../deployment.md#61-镜像发布固定顺序)。任一步失败即停止发布，不得跳过 migration 或 healthy 等待。

## 4. Staging 十项人工验收

1. 打开 Portal 自动扣款页，确认醒目显示 `STAGING MOCK，不会发生真实扣款`，并确认主动支付入口仍可使用。
2. 对一笔已起租、存在未结月租账单的订单创建授权，完成 Mock 签约并确认 Mandate 从 `PENDING` 进入 `ACTIVE`。
3. 刷新 Portal 和 Admin，确认授权编号、订单、签约时间及状态来自持久化记录，重启 API 后记录仍存在。
4. 在 D-3 运行协调预览和正式协调，确认同一账单只建立 D、D+1、D+3 三个扣款任务且幂等重跑不重复。
5. 到 D 执行首轮任务，确认 Attempt 依次经过 `CREATED`、`SUBMITTING`、`PROCESSING`；受理成功不得提前核销。
6. 设置 Mock 成功结果并查询，确认链路 `Mandate → Attempt → PaymentOrder → PaymentRecord → WriteOff` 完整，账单剩余金额不小于零。
7. 分别验证 D+1 可重试失败与 D+3 最终失败；最终失败通知只生成一次，并保留主动支付兜底。
8. 设置 `UNKNOWN`，确认后台只提供“查询结果”，重复查询复用原 Attempt，不创建新的扣款尝试。
9. 验证具备权限且填写原因后可执行人工扣款、取消待执行任务和死信恢复；无权限或无原因时操作被拒绝并留下审计记录。
10. 解约后确认 Mandate 为 `REVOKED`、未来自动扣款不再执行；随后主动支付仍可核销，D+5 未结账单仍进入既有逾期催收。

## 5. 异常处理

### 5.1 死信

先查看任务 `lastErrorCode`、重试次数和关联 Attempt。修复配置或外部故障后，通过 Admin 受控重试；不得直接改数据库状态。重试前确认同一幂等键没有仍在执行的任务。

### 5.2 UNKNOWN

`UNKNOWN` 表示渠道终态未知。只执行“查询结果”，不得人工创建新 Attempt，也不得把 `PROCESSING/UNKNOWN` 当作成功核销。若渠道长期不可查询，保留证据并升级人工处理。

### 5.3 人工扣款

仅 `auto_debit:execute` 权限可操作，必须填写原因。执行前确认账单仍未结、存在 `ACTIVE` 授权，且没有同账单在途 Attempt；操作结果必须进入审计日志。

### 5.4 未分配收款

主动支付与迟到代扣并发时，统一结算按实时 `remainingAmount` 核销，超出部分进入未分配收款。财务人员应核对渠道交易、PaymentRecord 和 WriteOff 后，按既有退款/调账流程处理，禁止扩大原账单核销金额。

## 6. 真实微信适配器启用前清单

- 商户号已开通委托扣款/自动续费能力；
- 已确认微信支持的业务模式、签约规则和扣款限制；
- `WECHAT_AUTO_RENEW_TEMPLATE_ID` 已审核通过；
- Portal 签约/解约页面和协议文案已通过产品、法务审核；
- 签约结果、解约结果、扣款结果回调 URL 已配置并完成验签、重放和幂等测试；
- 商户证书、平台证书、API v3 Key、AppID/MchID 以服务器 secret 管理；
- 渠道订单主动查询、超时和 `UNKNOWN` 恢复已实现；
- 已完成小额真实签约、成功扣款、失败重试、解约和主动支付并发验收；
- Production 配置审查后才允许把 provider 改为 `wechat_auto_renew` 并开启 `AUTO_DEBIT_ENABLED`；
- 上线后监控失败率、UNKNOWN、死信、未分配收款和重复通知。

## 7. 回滚

关闭 `AUTO_DEBIT_ENABLED` 只停止新自动扣款调度，不回退既有授权、Attempt、支付或核销事实。保留 billing worker 和主动支付，切回上一 API/Web 镜像，并继续查询已提交渠道交易的终态。数据库迁移为加法迁移，不使用 `migrate reset` 或 `db push` 回滚。
