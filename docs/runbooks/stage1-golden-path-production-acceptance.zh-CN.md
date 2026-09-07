# Stage 1 Golden Path Staging RC × 生产通道验收手册

日期：2026-09-07

[Stage 1 P0/P1 准入实施计划](../superpowers/plans/2026-09-06-stage1-p0-p1-admission-implementation-plan.md)仅为历史准入记录；当前依赖按[现有 Stage 1 主线与最小受控发布覆盖路线图](../superpowers/plans/2026-09-06-stage1-mainline-minimal-release-implementation-plan.md)及分别批准的 B/R/A 小计划执行，本文不提供重跑 P0/P1 的权限。本 Runbook 是冻结待复审的后续验收清单。批准本路线或本文修订，不等于批准 Staging 配置/部署、真实实名/签署、合同上传/链接生成、模板 smoke/通知开启、支付或退款；每个实际操作仍须逐项批准。

适用范围：第 1 阶段新订阅 A/B Golden Path。A 线为客户 Portal 自助进件，B 线为 Admin 代客进件。两条线必须使用不同的 Application，但执行完全相同的下游步骤。

固定拓扑是：**指定 Staging RC 的 Web/API、Staging 专用数据库、队列和对象存储**，本次法大大/支付/退款路线仅外连**生产法大大与生产微信支付/退款通道**，并且只使用逐项批准的专用生产测试资产；该拓扑描述不包含或授权通知路线。生产业务数据库、普通客户、运营车辆及非测试 payer 均不在范围内；生产应用也不得同时消费本次专用交易的 callback/notify。

本手册不授权接入或开启微信委托代扣。整个验收期间必须保持 `AUTO_DEBIT_ENABLED=false`、`PAYMENT_MANDATE_PROVIDER=disabled`、`PAYMENT_MANDATE_MOCK_ENABLED=false`，支付仅使用客户 Portal 的微信 JSAPI 主动支付。A/B 流程与状态机不变：合同归档后进入 `INITIAL_BILLING`，账单生成后才进入客户支付；本手册不修改运行时代码或状态语义。

## 1. 安全边界与通过条件

验收只允许使用事先批准的专用生产测试资产：已授权测试客户与签署人、授权测试 payer OpenID、非运营车辆、生产合同模板和受控付款额度。退款额度仅在独立退款操作中另行批准，不是主线资产准入字段。不得使用生产业务数据库、运营车辆、普通客户或未授权/非测试微信用户；不得填写猜测值、通配列表、真实 PII 或秘密。

候选相关的每个操作级批准只绑定一个已验真的 `buildProofDigest`，并绑定操作时间窗、精确资产、执行人、独立复核人及批准引用。候选完整 source SHA、API/Web/Runner 镜像 digest、migration catalog 与 repository contract identity 只能从该已验证 `build-proof.v1` 派生展示并逐项比对，不能复制成第二套身份权威。支付/退款批准另绑定以整数分为单位的单次上限及变更单单列的累计上限；非资金操作不填金额门槛。缺少适用字段或身份不一致即 `STOP`。退款还须另绑原支付交易、精确退款金额、财务复核人与独立批准引用，并要求日终对账；签署/支付批准不能继承为退款批准。

当前批准口径：真实支付继续使用既有微信 API v3、Portal JSAPI、支付回调与核销链路；真实支付、回调和核销仍是主线必需证据。退款按[受控测试退款方案](../superpowers/specs/2026-09-07-stage1-controlled-test-refund-design.zh-CN.md)作为独立人工资金收尾：在既有微信商户平台“退款管理”通过商户订单号或微信支付订单号定位原交易，经独立批准后单次全额原路退款，平台业务数据全程只读。不开发退款 API、不配置退款 notify URL、不修改支付 callback，也不自动转入接口开发。

退款路线可行性、实际退款、财务核对或日终收尾未完成，均不作为 Stage 1 实施、候选提升或主线验收签字的前置条件；缺失证据仍按缺失登记，不改成退款通过或 N/A。退款方案的正常免押、仅测试租金等限制只约束该退款路线，不扩大为全部 A/B 样本或主线付款门槛。付款与退款各自独立批准；商户受理、渠道最终成功、财务核对完成是三个不同事实，不得相互替代或推导平台自动退款、平台余额冲回。

通过条件：

- A/B 两个 Journey 均到达 `COMPLETED`，且 Application 不复用；
- 两个 Journey 的步骤顺序一致；
- 每个 Journey 恰好出现两类且各一次的内部人工决定：`FINAL_PLAN_DECISION`、`DELIVERY_EVIDENCE_DECISION`；
- 法大大完成客户签署、平台盖章和归档，最终 PDF 的服务端校验和可复核；
- 最小金额真实 JSAPI 支付、回调已核验，原收款已登记、分摊并核销；退款及其财务收尾独立登记，不列入主线通过条件；
- Stage 2 的精确 evidence manifest 已通过审核，订单、车辆、Lease 与 BillingSchedule 由权威事实激活；
- 当前收款模式为 `ACTIVE_PAYMENT_ONLY`，不存在 `PENDING` 或 `PROCESSING` 的退役自动扣款任务；
- 客户和 Admin 均无代扣 mutation 路由或 UI 动作控件；历史 Mandate/Attempt 数量只记录、不影响验收；
- 导出的证据已脱敏，PII 与供应商原始 payload 只保留在受控服务端审计系统中。

当前 B3 Task 3S 的方案在 source `2886d911223c741b000d00c0701676e1b391593f` 上已获批准，但实际执行属于另一任务；本 Runbook 未新跑任何验证，也不得据此写成 B3 已通过。Task 30、旧 Task 6/29R、全部 I 系列及其 stash/证据边界继续冻结，不能由本路线自动恢复。

## 2. 变更窗口前检查

执行人、复核人和回滚负责人必须是不同的已授权角色。开始前逐项记录到变更单，不在本手册副本中填写秘密或 PII。

- [ ] 数据库备份已完成，恢复演练时间和备份引用已登记。
- [ ] Staging 专用数据库的 Prisma migration 状态为 clean；操作批准已绑定唯一、验真的 `buildProofDigest`。
- [ ] 从该 build proof 派生并逐项读回候选完整 source SHA、API/Web/Runner 镜像 digest、migration catalog 与 repository contract identity；API、Web 和 Journey worker 均匹配该身份，且时间窗、操作人、复核人和批准引用一致。
- [ ] `/api/health` 正常；worker heartbeat、待处理 job/outbox 和最老异常时间已建立基线。
- [ ] 从部署配置和资源控制面独立读回数据库、队列、对象存储的精确资源身份，并从路由/代理实际配置独立读回 callback/return/notify 的精确目标；均只指向本次指定 Staging RC。仅有域名、页面或 `/api/health` 正常不是隔离证明。
- [ ] 已证明只对本次专用交易安全分流，生产应用不会消费同一组 callback/notify；不得为测试全局改写生产商户 callback、停止普通客户消费，或提供未单独批准的租户级配置步骤。无法证明安全分流和唯一消费者时 `STOP`。
- [ ] 已在窗口前逐项核验并记录紧急停止边界：本次 Staging 的精确 enrollment、worker 与 consumer 暂停目标、执行身份、有效窗口、停止/事故操作批准引用，以及现有权限/config 的只读 readback。任一项缺失时不得开启窗口；该批准不得包含生产应用、普通客户或通配控制目标。
- [ ] 回滚负责人、应用回滚步骤和数据库处置边界已确认。
- [ ] 初始配置为 `SUBSCRIPTION_JOURNEY_ENABLED=false`、`SUBSCRIPTION_JOURNEY_WORKER_ENABLED=false`、两类 allowlist 为空。
- [ ] `AUTO_DEBIT_ENABLED=false`、`PAYMENT_MANDATE_PROVIDER=disabled`、`PAYMENT_MANDATE_MOCK_ENABLED=false`，且变更窗口内禁止修改。
- [ ] 主线付款批准、付款单次/累计额度、真实支付回调隔离及平台收款/核销证据来源已核实；不填写或借用尚未生成的付款、核销或微信交易 ID，不以退款路线限制替代正常风控、押金和账单规则。

以下仅在另行启动独立退款路线时核验，不属于主线窗口前置清单：

- [ ] 退款方案 §3 的无资金桌面演练和只读核验：同一商户的单笔退款/查询权限、实际通知行为、唯一执行人及无并发控制、退款单次/累计额度、期限、资金可用性和既有财务方法/责任人/复核人/档案保管均已明确；该退款样本已有正常免押批准且原付款只有测试租金，不为退款伪造免押事实。
- [ ] 按退款方案 §4.1 核对原付款/核销与商户原单的现有只读来源和精确关联；缺少退款所需来源只停止该退款路线，不自动停止主线，不临时开放 SQL、API 或 RBAC。若发现主线收款事实不成立或越界访问等实际事故，仍适用第 11 节主线安全停止。

先在各自操作批准下完成 migration 和应用部署，再确认资源隔离与健康状态；不得在 migration、候选身份或隔离未确认时开启 Journey 或 worker。生产法大大/微信租户与凭据保持生产属性；任何 callback、notify、开关、allowlist 或其他设置变化均须单独批准，不从本 Runbook 推定权限。

## 3. 专用验收资产与配置

在部署秘密存储中配置下列变量。这里只记录“已配置/未配置”，不得抄录真实值。

| 变量                                     | 用途                     | 验收要求                                                            |
| ---------------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| `FADADA_TEST_CUSTOMER_ID`                | 已实名的法大大测试签署人 | 专用、已授权                                                        |
| `FADADA_TEST_LOCAL_CUSTOMER_ID`          | Staging 专用测试客户     | 与签署人绑定且不用于日常运营                                        |
| `STAGE1_ACCEPTANCE_CONTRACT_TEMPLATE_ID` | 生产订阅合同模板         | 已激活、版本已冻结                                                  |
| `STAGE1_ACCEPTANCE_PAYER_OPENID`         | JSAPI 付款人             | 已书面授权                                                          |
| `STAGE1_ACCEPTANCE_TEST_VEHICLE_ID`      | 专用验收测试车辆         | Staging 精确记录，实物明确为非运营                                  |
| `STAGE1_ACCEPTANCE_TEST_APPLICATION_ID`  | Staging 首条验收申请     | 仅作预检锚点；A/B 运行时仍各建新 Application                        |
| `STAGE1_ACCEPTANCE_MAX_PAYMENT_FEN`      | 单次付款上限             | 正整数，取批准的最小金额                                            |
| `STAGE1_ACCEPTANCE_MAX_REFUND_FEN`       | 独立退款单次上限         | 仅退款路线使用实际批准值；现有总预检仍依赖此项，见第 4 节未实施差异 |

五个微信公众号模板的候选映射必须分别记录，禁止跨场景复用：

| 变量                                   | 场景           | 核验字段                                                                                            |
| -------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `WECHAT_TEMPLATE_APPLICATION_PROGRESS` | 申请已受理     | `character_string3`、`const4`、`const5`、`time6`；枚举固定为 `const4=审核中`、`const5=车辆订阅申请` |
| `WECHAT_TEMPLATE_FINAL_PLAN_PENDING`   | 最终方案待确认 | `character_string2`、`phrase5`、`car_number8`、`thing13`、`time9`                                   |
| `WECHAT_TEMPLATE_CONTRACT_PENDING`     | 合同待签署     | `character_string2`、`thing3`、`thing6`、`thing1`                                                   |
| `WECHAT_TEMPLATE_PAYMENT_PENDING`      | 首期账单待支付 | `car_number1`、`thing2`、`amount4`、`amount7`、`time5`                                              |
| `WECHAT_TEMPLATE_HANDOVER_PENDING`     | 车辆待取车     | `character_string1`、`thing9`、`car_number5`、`thing11`                                             |

同时确认：

- `ESIGN_PROVIDER=fadada`、`FADADA_ENV=production`，基础地址为已确认的法大大生产地址；
- 法大大实名 callback/return 与签署 callback/return 均须逐项记录为**指定 Staging RC 的精确已批准 HTTPS 地址**，不是生产应用地址；未知实际值时保持未配置/未通过，不猜测 URL 或新增变量名；
- `PAYMENT_PROVIDER=wechat_pay`、`PAYMENT_DEFAULT_CHANNEL=WECHAT_JSAPI`、`WECHAT_PAY_ENABLED=true`；
- 微信支付 notify 仍须逐项记录为**指定 Staging RC 的精确已批准 HTTPS 地址**，不是生产应用地址；未知实际值时保持未配置/未通过，不猜测 URL 或新增变量名；签署 callback/return 与支付 callback/notify 的既有路由规则不变；
- 独立退款路线必须先只读核实实际通知行为。仅当本次退款实际不向应用推送通知，且已独立批准采用商户后台查询作为结果来源时，方可将该退款 notify 记为窄范围 N/A（不是 `stage1.refund` N/A）；如存在全局通知、目标未知或生产应用可能收到本次通知，保持原配置并停止该退款路线，不新增接收器、不配置退款 notify URL、不修改全局 callback，也不把退款 XML 发送到支付 JSON callback。已发生通知越界等实际事故仍适用主线安全停止；
- `NOTIFICATION_PROVIDER=wechat_official_account` 的五模板 smoke 与 `NOTIFICATION_WECHAT_ENABLED=true` 均是独立真实外部动作，只能在 `stage1.notification = must-external-verify` 的单独门槛和批准下执行；法大大/支付/退款路线批准不自动涵盖它们；
- 五个模板映射可基于既有受控证据核对；如需调用官方列表接口，亦须取得只读外部操作批准。对批准 OpenID 的精确字段 smoke 必须另获操作批准，不得使用通配或普通客户 OpenID；
- A/B 两个新 Application 或对应专用客户被精确加入 allowlist，禁止使用通配或扩大到普通客户群。

callback/return/notify 的验收只限本次专用交易。若现有生产商户或法大大租户只支持全局 callback，且无法在不影响生产应用和普通客户的前提下证明精确安全分流，则保持现状并 `STOP`；不得擅自改租户全局配置。

## 4. 预检与逐操作启动门槛

只有以下精确 alias 属于本节预检；本次文档修订未执行它们：

```powershell
pnpm stage1:golden-path:preflight
pnpm fadada:test-signer:preflight
pnpm fadada:upload-signurl:preflight
```

`pnpm stage1:golden-path:preflight` 只检查 HTTPS/fail-closed 配置并以 GET 读取 API health，不能证明 Staging 数据库、队列、对象存储或 callback 唯一消费者隔离；这些事实仍须按第 2 节由独立配置/资源/路由读回证明。

**现有实现差异，尚未实施对齐：** `scripts/stage1-golden-path-production-preflight.mjs:155-164` 仍无条件要求正整数退款额度，并拒绝退款上限高于付款上限。这与“退款独立、非主线前置”的当前文档口径不一致；本次没有修改脚本/测试，也没有运行总预检。按新范围使用该总预检之前，必须单独批准并完成这处限域实现对齐；不得伪填退款额度、忽略实际 blocker 或把本文当作脚本门禁已改。此项是既有实现待对齐，不是退款验证/财务收尾阻断主线。通知与其他安全检查保持原门禁。

两个法大大 `preflight` alias 均在 provider transport 前返回，不创建客户、合同、文件或链接。它们的 CLI 输出是文本：只有看到 `preflight=passed` 且没有 `blockers=` 才可认为内部 `preflight.ok` 通过；preflight 模式的顶层 `ok=true` 或进程退出码 `0` 单独都不代表通过。任何 blocker 都必须先处理并重新审批受影响操作，禁止通过改脚本、切换 mock/sandbox 或扩大 allowlist 绕过。

不得把 `run`、`prepare` 或 `signurl-only` 当作预检：它们会调用生产供应商并创建/复用客户、上传文件或生成链接；人再以 GET 打开所生成 URL 仍是实际外部动作。每次调用均须独立操作批准。本 Runbook 不新增这些模式的命令。

完成候选身份、migration、部署、资源隔离、配置复核，以及对应外部动作各自批准后，才可按以下顺序进入验收窗口；每一步设置变化也须单独批准并记录 readback：

真实付款按既有正常风控、押金及账单事实，并取得绑定精确应付对象、测试 payer、整数分金额和窗口的独立付款批准；不以前述退款路线可行性、免押或仅租金限制作为主线付款前提。将来启动退款时，再按该路线核实实际原单、样本资格并独立批准。总预检的 `NOTIFICATION_WECHAT_ENABLED=true` 仍是硬门禁；退款独立或退款 notify 的窄范围 N/A 均不能豁免，通知未独立批准时仍 `STOP`。总预检退款额度依赖的未实施差异按本节单独处理，不绕过实际结果。

1. 设置精确 allowlist；
2. 设置 `SUBSCRIPTION_JOURNEY_ENABLED=true`；
3. 设置 `SUBSCRIPTION_JOURNEY_WORKER_ENABLED=true`；
4. 重启 API/worker 并确认 heartbeat；
5. 再运行一次 `pnpm stage1:golden-path:preflight`。

五模板 smoke/通知开启仅在独立 `stage1.notification` 门槛通过后加入窗口；未批准时不得执行，也不得因为它缺席而把其他路线的批准扩大为通知批准。

## 5. A/B 两线执行步骤

先完整执行 A 线，再使用新的 Application 完整执行 B 线。不得把 A 线的 Application、Journey、Order 或法大大任务复用于 B 线。

以下是未来逐操作获批后的业务顺序，不是本次路线批准附带的执行授权。每次真实供应商调用、签署、支付、配置写入或 worker/Journey 开关变化前，都须重新核对第 1 节批准绑定和第 2 节隔离 readback；主线事实 `UNKNOWN` 立即 `STOP`。退款不在该业务顺序内，其 `UNKNOWN` 先按独立退款停止/查询规则处理；实际事故外溢仍触发第 11 节。

### 5.1 A 线：Portal 自助进件

1. 授权客户在 Portal 创建并提交 `SELF_SERVICE` Application。
2. 确认 Journey 进入 `APPLICATION_VALIDATION`，随后只生成一个 `FINAL_PLAN_DECISION` 任务。
3. 运营批准 `FINAL_PLAN_DECISION`；客户在 Portal 核对并确认页面展示的精确 `finalPlanRevision`。
4. 系统基于已确认方案及预约事实完成车辆分配；使用专用非运营车辆，不新增 `FINAL_VEHICLE_ALLOCATION` 内部批准。
5. 系统自动创建唯一 Order、Contract 和初始权益，不手工调用旧建单/建合同入口。
6. 在该次法大大操作批准下，客户完成实名与签署，平台完成盖章；等待本次专用 callback/主动查询和归档事实一致。
7. 只有合同归档事实完成后，Journey 才进入 `INITIAL_BILLING` 并自动生成押金和首期租金应收；归档 callback 不得跳过该步直接进入支付。
8. 在独立支付操作批准下，客户在 Portal 使用授权测试 OpenID 完成不超过批准上限的最小真实 JSAPI 支付。
9. 核对 PaymentRecord、allocation/write-off 与账单余额全部一致。
10. 系统自动创建 Stage 2 handover；现场人员完成预约、里程和全部必需证据。
11. 运营对精确 evidence manifest 批准 `DELIVERY_EVIDENCE_DECISION`。
12. 系统从合同、支付核销和交付证据权威事实完成激活，Journey 到达 `COMPLETED`。

### 5.2 B 线：Admin 代客进件

使用新的 `SALES_ASSISTED` Application 重复 5.1 的第 2—12 步。输入规则、最终方案快照、客户确认、电子签、主动支付、交付证据和激活门禁必须与 A 线相同；只允许入口来源不同。

## 6. 两个人工决定核验

每条 Journey 完成后，按 Journey 时间线和 ManualTask 记录同时核对：

```text
FINAL_PLAN_DECISION         = 1
FINAL_VEHICLE_ALLOCATION    = 0
DELIVERY_EVIDENCE_DECISION  = 1
其他内部人工决定            = 0
总计                        = 2
```

客户确认方案、法大大签署、JSAPI 支付和现场人员提交证据均是客户/履约动作，不计入内部人工决定。若因驳回产生同类任务的新版本，当前验收运行判为不通过，应保留证据后使用新的 Application 重跑，不得篡改历史。

## 7. 法大大归档与 PDF 证据

- 确认生产供应商环境、任务号和合同号均属于本次专用测试资产，callback 只由指定 Staging RC 消费；证据导出时只保留掩码引用。
- 确认客户签署、平台盖章和 archive 状态全部完成。
- 从 Staging 专用受控对象存储读取最终 signed PDF，重新计算 SHA-256，与服务端归档 metadata 的 checksum 比对。
- 确认 PDF 绑定本次 Order/Contract 和正确模板版本，不包含另一条验收线的标识。
- 不把 sign URL、证件号、手机号、原始供应商响应或 PDF 本体复制到验收文档。

## 8. 主线 JSAPI 支付与独立退款收尾

1. 付款前确认支付操作批准绑定原始应付对象、整数分金额和精确测试 payer；`STAGE1_ACCEPTANCE_MAX_PAYMENT_FEN` 只表示单次上限，累计上限须在变更单另列，且本次应付金额同时不超过两者。
2. 仅由 `STAGE1_ACCEPTANCE_PAYER_OPENID` 对应的授权测试用户在 Portal 发起 JSAPI 支付。
3. 服务端支付回调仍是平台入账触发来源；平台原付款事实只从已落库的 `PaymentOrder`、`PaymentRecord`、`PaymentWriteOff` 及账单观察读取。微信原支付单终态须由获准人员在商户后台独立查询，并将实际 `out_trade_no` 与平台 `paymentOrderNo` 精确关联。当前平台没有主动向微信查询支付终态的接口，不得保留或出具“平台已主动向微信查询”的证明。
4. 将实际生成的 `PaymentOrder`、`PaymentRecord`、`PaymentWriteOff`、账单分摊及微信 `transaction_id`/`out_trade_no` 关联追加到受控支付记录，核实逐笔收款/核销来源和关联完整；主线支付证据缺失即 `STOP`，不得以退款计划或汇总数替代真实支付闭环。

### 8.1 独立人工退款与财务核对（非主线前置）

1. 另行启动时先按退款方案核实该原交易已有正常免押批准、仅测试租金等路线资格；不合格只停止该退款路线，不改原业务规则或伪造零押。
2. 重新申请独立退款操作批准，绑定实际原支付交易、精确整数分退款额、财务复核人及批准引用。退款单次/累计上限分别核对；未满足或未批准不得退款。
3. 在同一微信商户平台“退款管理”按商户订单号或微信支付订单号查询原单及全部退款记录；确认无历史/未决退款且批准有效后，才可单次全额原路提交。申请受理后只查询同单，商户扣款或页面提示不等于渠道成功，不新建替代交易。
4. 渠道最终成功后，第二人分别核对商户原单/退款单及金额、平台原付款/核销只读历史、实际财务凭证及日终对账。平台历史不得抹除，不声称账单自动冲销、业务净额同步或已有退款接口。

独立退款字段来源和访问边界以退款方案 §4.1 为准：平台业务入口不返回微信原单终态，且现有读取入口不能单独证明逐笔核销明细全量可取。缺少退款所需逐笔来源、商户查询、财务凭证或日终账单时，停止该退款路线并登记差距；不阻断 Stage 1 实施、候选提升或主线签字，不自行补产品代码、脚本、SQL、权限或猜配明细。主线真实支付证据仍须按上节独立满足。

退款 notify 仅可在第 3 节窄范围条件全部满足时记为 N/A；否则只阻断该退款路线。退款为 `PROCESSING` 或 `UNKNOWN` 时仅可在另获批准的只读范围内查询同一原交易及其退款列表，不得刷新重提、生成新退款 ID 或改用其他交易。独立未完成不等于退款通过；实际资金、回调隔离或安全事故仍按第 11 节处置。

`stage1.refund` 保持独立 `must-external-verify`，不改通过或 N/A，但它登记的是独立人工资金收尾，不是 Stage 1 实施、候选提升或主线签字前置。`relatedSuiteId=api.billing-automation.postgres` 仅为既有锚点；支付成功和该 suite 均不证明真实退款、财务复核或日终对账。

预检脚本不会发起支付或退款。不得用 mock-pay 页面、手工改账单状态、人工“已收款”字段或数据库编辑替代真实闭环。

## 9. Stage 2 证据与权威激活

- 确认 handover、field work order、车辆和 Order 均属于本次 Journey。
- 所有必需证据完成后记录 evidence manifest hash；审批时绑定该精确版本。
- 如证据新增或替换，旧决定不得继续生效，必须生成并审批新 manifest。
- 审批通过后确认 Order、Vehicle、Lease、BillingSchedule、初始权益和 Journey 在权威激活事务中一致完成。
- 核对本次 Journey 没有新建 PaymentMandate、DebitAttempt，也没有通过旧交付布尔值激活；系统级历史记录允许存在但必须只读。

## 10. 脱敏证据包

每条 Journey 导出一个独立证据包，至少包含：

- 唯一已验证 `buildProofDigest`，以及仅从该 proof 派生展示的候选完整 source SHA、API/Web/Runner 镜像 digest、migration catalog、repository contract identity；另含操作时间窗、执行人/复核人的掩码主体 ID 与角色、逐操作批准引用和受控审计引用；
- Staging 数据库/队列/对象存储的精确身份 readback，以及 callback/return/notify 路由和本次专用交易唯一消费者的独立 readback；
- 掩码后的 Journey/Application/Order/Contract/Lease/Vehicle/WorkOrder 引用；
- 每个步骤的开始、等待、完成时间和最终状态；
- 两个 ManualTask 的类型、决定结果和审计事件引用；
- 掩码后的法大大任务/交易引用、归档 PDF SHA-256；
- 掩码后的微信原支付交易引用、付款批准的整数分金额、单次及累计上限，以及真实支付回调、平台原收款/核销和账单证据；不借用退款结果替代；
- evidence manifest hash、Stage 2 审批和权威激活审计引用；
- 执行前后 Journey 指标快照：pending job/outbox、open exception、最老异常、worker heartbeat；
- `ACTIVE_PAYMENT_ONLY` 收款模式、退役任务 `PENDING/PROCESSING=0`、客户/Admin 无 mutation 入口的核验结果；
- 历史 mandate/attempt 数量快照（允许非零，不作为失败条件），以及至少一笔客户发起的 JSAPI 支付达到 PaymentRecord `CONFIRMED` 并生成 WriteOff 的证据。

退款若另行执行，其原单/退款单、独立批准及额度、商户受理、渠道终态、平台只读历史、实际财务凭证和日终核对各自登记在独立收尾记录中；缺失项如实保留，不作为主线证据包或签字必备项，也不合并为退款通过。

姓名、手机号、证件号、OpenID、密钥、证书、签署 URL、支付凭据和 provider raw payload 不得进入证据包。执行人/复核人的完整身份只保留在受控变更单和审计系统中；导出包仅保留掩码主体 ID、角色与受控引用。完整审计按现有保留策略管理。

### 10.1 受控自动化证据（外部执行前必过）

旧版 Runbook 列出的直接 API/Web Vitest 命令从本次前向路线退出执行入口，仅保留为历史引用，也不得带入 ambient `DATABASE_URL` 执行。本次文档修订不运行本节产品、数据库或浏览器验收。PostgreSQL 证据必须引用已批准 B/R 小计划中的 governed launcher、精确 suite/chain、受控目标身份和完成报告；Web/unit 证据与真实浏览器证据分别按已批准的 B/A 线计划入口取得，不能假装由数据库 launcher 覆盖。不得从本文拼装新命令或把旧结果改写成当前通过。

受控自动化证据必须证明：

- Portal `SELF_SERVICE` A 线与 Admin `SALES_ASSISTED` B 线执行相同的 11 个有序步骤，且各自只有两个内部人工决定；
- 每条线只有一个 Order、Contract、Lease 和 BillingSchedule，合同含法大大签署/盖章/归档元数据，初始账单由 PaymentRecord 与 write-off 权威结清；
- 本次 A/B Journey 未新建 PaymentMandate、DebitAttempt，系统无可执行退役代扣任务，且未使用委托代扣或人工“已收款”捷径；已有历史 Mandate/Attempt 可非零但必须只读；
- 法大大启动/归档存储、账单、交接、激活前置条件的重试可恢复，重复支付回调不重复生成业务事实，过期 worker lease 可回收；
- 死信原子投影为 Journey/Step `EXCEPTION`，后台 retry/pause/resume/cancel 受版本和权限约束，Portal/Admin 均不显示 provider/payment 原始错误；
- Journey 订单不显示旧手工收款、直接合同归档或直接交付激活入口。

其中 B3 Task 3S 只批准了方案；本任务没有新鲜执行证据，不能标记 B3 通过。其正确归档后继是 `INITIAL_BILLING`，且 Task 3S 不执行 worker、账单、支付或激活路径。

最终验收仍须完成既有最小发布路线的全部门槛：真实最终镜像的 fresh 证据、合法 snapshot 升级、Schema/runtime identity 与 readiness、A 线真实浏览器结果，以及 B4–B6 的权威激活、账单维护和正常完结证据。B3 fresh、路线批准或本文修订均不能替代这些门槛；也不得为此恢复旧 Task 6、Task 29R/30 或 I 系列云关键路径。

`release/contracts/external-validation-applicability.v1.json` 或其他 repository-contract JSON 的内容/digest 一旦变化，必须从包含新字节的新候选生成与之匹配的 repository contract/build proof；旧证明不得复用或重新解释。

自动化结果不等同于本次 Staging RC × 生产通道验收，也不授权部署、迁移、开关/allowlist/租户配置变化、真实实名/签署、模板 smoke/通知开启、支付或退款。外部步骤仍须满足第 1～4 节前置条件并取得逐操作批准。

## 11. 阻断、恢复与回滚

主线候选/业务/通知/隔离等 blocker 或真实安全事故出现时立即执行以下步骤。独立退款的未核验、`PROCESSING`、`UNKNOWN`、财务凭证/日终资料未齐，先停止退款新写并依批准查询同单，不因它们单独暂停主线实施、候选提升或签字；若实际重复收费/退款、错误原单/金额、生产消费者外溢或主线权威事实冲突，则仍触发本节安全停止，不因“退款独立”豁免。

1. 立即使用第 2 节已核验的预批准停止/事故操作，停止本次 Staging 精确范围内的新验收动作和 Journey enrollment，无需等待新授权；不得扩大到生产应用、普通客户或通配控制目标；
2. 按同一预批准边界暂停对应 worker/consumer。停止后立即只读 readback，确认没有新增供应商调用或交易；worker 自动恢复不得越过人工 `STOP`、继续供应商调用或产生新交易；
3. 保留并掩码记录全部 Journey、合同、provider task、支付/退款、callback、job、exception 与批准引用，包括所有在途 `UNKNOWN` 和原交易引用；不扩大 allowlist，不删除或覆盖失败记录；
4. 先用相同幂等身份在已批准范围内查询供应商与平台权威事实并 reconcile；只有事实已知且原操作批准仍有效时，才可 replay 已证明幂等的非退款步骤。A 路线商户后台人工退款提交不属于可 replay 步骤；首次提交后只能在另获批准的只读范围内查询同一原支付交易及其退款记录；
5. 状态为 `UNKNOWN`、回调归属不明或响应丢失时，禁止以新 transaction/contract/payment/refund ID 盲目重试；A 路线人工退款即使取得新批准、沿用同一原支付单或同一退款 ID，也不得第二次提交，只能另获批准后只读查询同一原交易/退款并保留现场、升级人工复核；
6. 数据库恢复、数据库编辑、应用回滚或重新部署都不能撤销已经发生的实名、签署、归档、通知、支付或退款外部事实；不得靠恢复/改库伪造回退，再以新交易重做；
7. 若存在重复收费、错误车辆占用、证据错绑、唯一消费者不成立或权威状态不一致，维持 `STOP`，通知回滚负责人并按事故流程处置。

紧急停止只消费窗口前的精确停止批准；任何恢复或新写操作仍须另行批准。恢复前先确认幂等对象数量、原外部引用、账务与归档权威事实，再取得精确 Resume/Retry/replay 批准；该类批准不适用于 A 路线商户后台人工退款再次提交，首次提交或进入 `UNKNOWN` 后始终只能另获批准后只读查询同一原支付交易/退款。不得直接改 Journey 状态“跳步”，也不得让 worker 的自动恢复代替该批准。

## 12. 收尾

- [ ] A/B 两条通过条件全部满足，证据包已由第二人复核。
- [ ] 在各自收尾操作批准下，`SUBSCRIPTION_JOURNEY_ENABLED` 恢复为发布决策指定状态；未批准放量时设回 `false`。
- [ ] 在单独配置操作批准下清空本次精确 allowlist；注意只有同时关闭 `SUBSCRIPTION_JOURNEY_ENABLED` 才能阻止新 enrollment。
- [ ] worker 对已入组 Journey 的处置策略已记录；无遗留时可按发布决策和独立配置批准关闭。
- [ ] 本次专用 callback/return/notify 路由已按批准处置，未改变生产商户全局 callback，也未中断普通客户消费；Staging 专用 DB/队列/对象存储没有越界写入生产业务资源。
- [ ] `stage1.notification` 的五模板 smoke/通知开启具备自身外部证据、独立批准与复核；未执行不通过，不借用退款或其他路线批准。
- [ ] `AUTO_DEBIT_ENABLED=false`、`PAYMENT_MANDATE_PROVIDER=disabled`、`PAYMENT_MANDATE_MOCK_ENABLED=false` 保持不变。
- [ ] 变更单已附脱敏证据引用、异常说明和最终签字。

独立退款收尾另列状态：商户受理、渠道最终成功、平台原付款/核销只读历史、实际财务凭证及日终核对分别记录。任何 `PROCESSING`、`UNKNOWN`、账单未出、凭证未生效或差异未解决，退款/财务仍未通过，不能因窗口结束关闭；这些未完成项不阻断 Stage 1 实施、候选提升或主线签字，也不把 `stage1.refund` 改为 N/A。

本 Runbook 不执行广泛退役、不建立新发布框架/契约/命令，也不解冻 Task 30 或任何旧路线。完成本文评审仅冻结 Runbook 内容供后续逐操作审批，不构成 Staging 或生产通道执行许可。
