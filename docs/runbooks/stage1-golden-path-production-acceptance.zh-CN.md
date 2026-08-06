# Stage 1 Golden Path 生产验收手册

日期：2026-08-06

适用范围：第 1 阶段新订阅 A/B Golden Path。A 线为客户 Portal 自助进件，B 线为 Admin 代客进件。两条线必须使用不同的 Application，但执行完全相同的下游步骤。

本手册不授权接入或开启微信委托代扣。整个验收期间必须保持 `AUTO_DEBIT_ENABLED=false`，支付仅使用客户 Portal 的微信 JSAPI 主动支付。

## 1. 安全边界与通过条件

验收只允许使用事先批准的专用生产测试资产：已授权测试客户与签署人、授权 payer OpenID、非运营车辆、生产合同模板、受控付款额度和退款额度。不得使用真实运营车辆、普通客户或未授权微信用户。

通过条件：

- A/B 两个 Journey 均到达 `COMPLETED`，且 Application 不复用；
- 两个 Journey 的步骤顺序一致；
- 每个 Journey 恰好出现三类且各一次的内部人工决定：`FINAL_PLAN_DECISION`、`FINAL_VEHICLE_ALLOCATION`、`DELIVERY_EVIDENCE_DECISION`；
- 法大大完成客户签署、平台盖章和归档，最终 PDF 的服务端校验和可复核；
- 最小金额真实 JSAPI 支付已登记、分摊并核销，随后按批准流程完成退款和对账；
- Stage 2 的精确 evidence manifest 已通过审核，订单、车辆、Lease 与 BillingSchedule 由权威事实激活；
- 未创建 PaymentMandate 或 DebitAttempt，也未依赖人工“已收款”布尔字段；
- 导出的证据已脱敏，PII 与供应商原始 payload 只保留在受控服务端审计系统中。

## 2. 变更窗口前检查

执行人、复核人和回滚负责人必须是不同的已授权角色。开始前逐项记录到变更单，不在本手册副本中填写秘密或 PII。

- [ ] 数据库备份已完成，恢复演练时间和备份引用已登记。
- [ ] Prisma migration 状态为 clean，目标部署版本和镜像不可变 tag 已登记。
- [ ] API、Web 和 Journey worker 的部署版本一致。
- [ ] `/api/health` 正常；worker heartbeat、待处理 job/outbox 和最老异常时间已建立基线。
- [ ] 回滚负责人、应用回滚步骤和数据库处置边界已确认。
- [ ] 初始配置为 `SUBSCRIPTION_JOURNEY_ENABLED=false`、`SUBSCRIPTION_JOURNEY_WORKER_ENABLED=false`、两类 allowlist 为空。
- [ ] `AUTO_DEBIT_ENABLED=false`，且变更窗口内禁止修改。

先完成 migration 和应用部署，再确认健康状态；不得在 migration 或部署未确认时开启 Journey 或 worker。

## 3. 专用验收资产与配置

在部署秘密存储中配置下列变量。这里只记录“已配置/未配置”，不得抄录真实值。

| 变量 | 用途 | 验收要求 |
|---|---|---|
| `FADADA_TEST_CUSTOMER_ID` | 已实名的法大大测试签署人 | 专用、已授权 |
| `FADADA_TEST_LOCAL_CUSTOMER_ID` | 本地测试客户 | 与签署人绑定且不用于日常运营 |
| `STAGE1_ACCEPTANCE_CONTRACT_TEMPLATE_ID` | 生产订阅合同模板 | 已激活、版本已冻结 |
| `STAGE1_ACCEPTANCE_PAYER_OPENID` | JSAPI 付款人 | 已书面授权 |
| `STAGE1_ACCEPTANCE_TEST_VEHICLE_ID` | 生产测试车辆 | 明确标记为非运营 |
| `STAGE1_ACCEPTANCE_TEST_APPLICATION_ID` | 首条验收申请 | 仅作预检锚点；A/B 运行时仍各建新 Application |
| `STAGE1_ACCEPTANCE_MAX_PAYMENT_FEN` | 单次付款上限 | 正整数，取批准的最小金额 |
| `STAGE1_ACCEPTANCE_MAX_REFUND_FEN` | 单次退款上限 | 正整数且不高于付款上限 |

同时确认：

- `ESIGN_PROVIDER=fadada`、`FADADA_ENV=production`，基础地址为已确认的法大大生产地址；
- 法大大签署 callback/return URL 均为生产 HTTPS 地址；
- `PAYMENT_PROVIDER=wechat_pay`、`PAYMENT_DEFAULT_CHANNEL=WECHAT_JSAPI`、`WECHAT_PAY_ENABLED=true`；
- 微信支付 notify URL 为生产 HTTPS 地址；
- `NOTIFICATION_PROVIDER=wechat_official_account`，验收窗口内 `NOTIFICATION_WECHAT_ENABLED=true`；
- A/B 两个新 Application 或对应专用客户被精确加入 allowlist，禁止使用通配或扩大到普通客户群。

## 4. 只读预检

以下命令不会创建客户、申请、订单、合同、支付或退款：

```powershell
pnpm stage1:golden-path:preflight
pnpm fadada:test-signer:preflight
pnpm fadada:upload-signurl:preflight
```

第一条命令只检查 fail-closed 配置并以 GET 请求读取 API health；后两条使用既有法大大生产预检能力。任何 blocker 都必须先修复，禁止通过改脚本、切换 mock/sandbox 或扩大 allowlist 绕过。

完成 migration、部署和配置复核后，按以下顺序进入验收窗口：

1. 设置精确 allowlist；
2. 设置 `SUBSCRIPTION_JOURNEY_ENABLED=true`；
3. 设置 `SUBSCRIPTION_JOURNEY_WORKER_ENABLED=true`；
4. 重启 API/worker 并确认 heartbeat；
5. 再运行一次 `pnpm stage1:golden-path:preflight`。

## 5. A/B 两线执行步骤

先完整执行 A 线，再使用新的 Application 完整执行 B 线。不得把 A 线的 Application、Journey、Order 或法大大任务复用于 B 线。

### 5.1 A 线：Portal 自助进件

1. 授权客户在 Portal 创建并提交 `SELF_SERVICE` Application。
2. 确认 Journey 进入 `APPLICATION_VALIDATION`，随后只生成一个 `FINAL_PLAN_DECISION` 任务。
3. 运营批准 `FINAL_PLAN_DECISION`；客户在 Portal 核对并确认页面展示的精确 `finalPlanRevision`。
4. 运营批准 `FINAL_VEHICLE_ALLOCATION`，使用专用非运营车辆。
5. 系统自动创建唯一 Order、Contract 和初始权益，不手工调用旧建单/建合同入口。
6. 客户完成法大大实名与签署，平台完成盖章；等待 callback/主动对账使合同归档。
7. 系统自动生成押金和首期租金应收。
8. 客户在 Portal 使用授权 OpenID 完成不超过批准上限的最小真实 JSAPI 支付。
9. 核对 PaymentRecord、allocation/write-off 与账单余额全部一致。
10. 系统自动创建 Stage 2 handover；现场人员完成预约、里程和全部必需证据。
11. 运营对精确 evidence manifest 批准 `DELIVERY_EVIDENCE_DECISION`。
12. 系统从合同、支付核销和交付证据权威事实完成激活，Journey 到达 `COMPLETED`。

### 5.2 B 线：Admin 代客进件

使用新的 `SALES_ASSISTED` Application 重复 5.1 的第 2—12 步。输入规则、最终方案快照、客户确认、电子签、主动支付、交付证据和激活门禁必须与 A 线相同；只允许入口来源不同。

## 6. 三个人工决定核验

每条 Journey 完成后，按 Journey 时间线和 ManualTask 记录同时核对：

```text
FINAL_PLAN_DECISION          = 1
FINAL_VEHICLE_ALLOCATION     = 1
DELIVERY_EVIDENCE_DECISION   = 1
其他内部人工决定             = 0
总计                         = 3
```

客户确认方案、法大大签署、JSAPI 支付和现场人员提交证据均是客户/履约动作，不计入内部人工决定。若因驳回产生同类任务的新版本，当前验收运行判为不通过，应保留证据后使用新的 Application 重跑，不得篡改历史。

## 7. 法大大归档与 PDF 证据

- 确认供应商环境、任务号和合同号均属于生产验收资产；证据导出时只保留掩码引用。
- 确认客户签署、平台盖章和 archive 状态全部完成。
- 从受控存储读取最终 signed PDF，重新计算 SHA-256，与服务端归档 metadata 的 checksum 比对。
- 确认 PDF 绑定本次 Order/Contract 和正确模板版本，不包含另一条验收线的标识。
- 不把 sign URL、证件号、手机号、原始供应商响应或 PDF 本体复制到验收文档。

## 8. JSAPI 支付、退款与对账

1. 付款前确认应付金额不超过 `STAGE1_ACCEPTANCE_MAX_PAYMENT_FEN`。
2. 仅由 `STAGE1_ACCEPTANCE_PAYER_OPENID` 对应的授权用户在 Portal 发起 JSAPI 支付。
3. 以服务端支付回调和主动查询结果为准，核对 PaymentRecord、PaymentOrder、Bill allocation/write-off 和 remaining amount。
4. 激活与证据采集完成后，按财务已批准的生产退款流程发起不超过 `STAGE1_ACCEPTANCE_MAX_REFUND_FEN` 的退款。
5. 由第二人复核微信商户侧退款引用、平台退款记录、账务冲销和日终对账结果。

预检脚本不会发起支付或退款。不得用 mock-pay 页面、手工改账单状态或人工“已收款”字段替代真实闭环。

## 9. Stage 2 证据与权威激活

- 确认 handover、field work order、车辆和 Order 均属于本次 Journey。
- 所有必需证据完成后记录 evidence manifest hash；审批时绑定该精确版本。
- 如证据新增或替换，旧决定不得继续生效，必须生成并审批新 manifest。
- 审批通过后确认 Order、Vehicle、Lease、BillingSchedule、初始权益和 Journey 在权威激活事务中一致完成。
- 核对没有 PaymentMandate、DebitAttempt，也没有通过旧交付布尔值激活。

## 10. 脱敏证据包

每条 Journey 导出一个独立证据包，至少包含：

- 掩码后的 Journey/Application/Order/Contract/Lease/Vehicle/WorkOrder 引用；
- 每个步骤的开始、等待、完成时间和最终状态；
- 三个 ManualTask 的类型、决定结果和审计事件引用；
- 掩码后的法大大任务/交易引用、归档 PDF SHA-256；
- 掩码后的微信支付/退款交易引用、Bill/Payment/write-off 引用；
- evidence manifest hash、Stage 2 审批和权威激活审计引用；
- 执行前后 Journey 指标快照：pending job/outbox、open exception、最老异常、worker heartbeat；
- `AUTO_DEBIT_ENABLED=false` 以及 mandate/attempt 数量为零的核验结果。

姓名、手机号、证件号、OpenID、密钥、证书、签署 URL、支付凭据和 provider raw payload 不得进入证据包。完整审计留在服务端受控系统，并按现有保留策略管理。

### 10.1 自动化验收证据（生产执行前必过）

生产变更单必须附上以下自动化证据；测试仅连接回环地址上的专用 PostgreSQL，外部法大大、对象存储和微信支付均使用确定性测试适配器，测试事务结束后回滚：

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-golden-path.e2e-spec.ts test/subscription-journey-failure-recovery.e2e-spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/subscription-journey-golden-path.spec.tsx
pnpm release:check
```

自动化证据必须证明：

- Portal `SELF_SERVICE` A 线与 Admin `SALES_ASSISTED` B 线执行相同的 11 个有序步骤，且各自只有三个内部人工决定；
- 每条线只有一个 Order、Contract、Lease 和 BillingSchedule，合同含法大大签署/盖章/归档元数据，初始账单由 PaymentRecord 与 write-off 权威结清；
- `PaymentMandate=0`、`DebitAttempt=0`，未使用委托代扣或人工“已收款”捷径；
- 法大大启动/归档存储、账单、交接、激活前置条件的重试可恢复，重复支付回调不重复生成业务事实，过期 worker lease 可回收；
- 死信原子投影为 Journey/Step `EXCEPTION`，后台 retry/pause/resume/cancel 受版本和权限约束，Portal/Admin 均不显示 provider/payment 原始错误；
- Journey 订单不显示旧手工收款、直接合同归档或直接交付激活入口。

该自动化结果不等同于生产验收，也不授权部署、迁移、启用 Journey/worker、写入 allowlist、真实签署、真实支付或退款。生产步骤仍须满足第 2～4 节前置条件并取得显式生产放量批准。

## 11. 阻断、恢复与回滚

出现任一 blocker 时立即：

1. 设置 `SUBSCRIPTION_JOURNEY_ENABLED=false`，阻止新 Journey enrollment；
2. 保持 `SUBSCRIPTION_JOURNEY_WORKER_ENABLED=true`，仅让已入组 Journey 完成安全的幂等恢复；
3. 不扩大 allowlist，不删除事件、job、exception 或供应商回调记录；
4. 对 retryable 异常使用 Admin 的 Retry；需要暂停调查时使用 Pause；合同尚未签署/归档且业务确认取消时才使用 Cancel；
5. 对法大大、支付或通知故障只重试对应异步步骤，不回滚已经提交的领域事实；
6. 若存在重复收费、错误车辆占用、证据错绑或权威状态不一致，停止 worker，通知回滚负责人并按事故流程处置。

恢复后先确认幂等对象数量和权威事实，再 Resume/Retry。不得直接改 Journey 状态“跳步”。

## 12. 收尾

- [ ] A/B 两条通过条件全部满足，证据包已由第二人复核。
- [ ] 退款与日终对账已完成。
- [ ] `SUBSCRIPTION_JOURNEY_ENABLED` 恢复为发布决策指定状态；未批准正式放量时设回 `false`。
- [ ] allowlist 清空；注意只有同时关闭 `SUBSCRIPTION_JOURNEY_ENABLED` 才能阻止新 enrollment。
- [ ] worker 对已入组 Journey 的处置策略已记录；无遗留时可按发布决策关闭。
- [ ] `AUTO_DEBIT_ENABLED=false` 保持不变。
- [ ] 变更单已附脱敏证据引用、异常说明和最终签字。
