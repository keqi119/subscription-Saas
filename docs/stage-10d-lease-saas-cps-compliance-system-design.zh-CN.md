# Stage 10D 租赁 SaaS + 电子签 + CPS 合规系统设计

Stage 10D-Lease-SaaS-CPS-Compliance-System-Design 的目标，是把当前已经完成的电子签平台升级为生产级租赁合同自动履约平台：

```text
Order -> Contract -> Signing -> Seal -> Lease Fulfillment
订单 -> 合同 -> 签署 -> 盖章 -> 租赁履约
```

本阶段只做架构设计：

```text
不实现代码
不修改 Prisma schema
不新增 migration
不调用真实法大大 API
不生成 signUrl
不执行签署
不修改生产数据
不执行 seed
不部署生产
```

## 1. 合规输入

本设计纳入用户提供的法大大 CPS 证书合规要求，公告日期为 2026-06-23。

本阶段按以下合规口径设计：

```text
自动签署 / 企业自动盖章必须先检查证书有效性。
证书过期、无效、未知或需要重新授权时，必须阻断自动签署。
重新授权必须由明确授权动作触发。
系统不得自动续期证书。
```

本阶段公开检索未找到可靠的公开版 2026-06-23 法大大 CPS 公告页面。因此，后续实现前必须把官方公告或内部合规通知作为证据附件纳入合规登记。

后续实现前建议复核本地法大大资料：

```text
D:\Projects\document\fadada\doc\4.6.6 扩展接口列表_查看&查询&下载_查询证书信息.pdf
D:\Projects\document\fadada\doc\3.7.3 API文档_合同签署_自动签署.pdf
D:\Projects\document\fadada\doc\3.7.2.4 API文档_合同签署_授权自动签_查询授权自动签状态接口.pdf
D:\Projects\document\fadada\doc\3.7.2.1 API文档_合同签署_授权自动签_获取授权自动签页面接口.pdf
```

## 2. 最终 SaaS 架构

目标系统是一个分层的租赁合同自动化平台：

```text
产品 / 后台 / Portal 入口
-> 订单受理
-> 合同生成与版本固化
-> C3 客户 onboarding 编排
-> C2 实名生命周期
-> C1 provider account binding
-> C4 企业签署策略
-> CPS 合规层
-> B5 签署执行引擎
-> callback / archive / evidence
-> 租赁履约引擎
-> 账单 / 应收 / 服务权益
-> 合规审计 / 风险监控
```

### 2.1 分层职责

| 层级 | 职责 | 禁止承担的职责 |
| --- | --- | --- |
| 订单受理 | 记录客户、车辆、报价、产品版本和商业意向 | 不签署、不盖章、不激活租赁 |
| 合同生成 | 生成不可变合同版本和待签 PDF artifact | 不改变财务状态 |
| C3 Onboarding | 编排客户接入和签署准备态 | 不直接调用签署 API |
| C2 实名 | 管理实名状态和证书绑定机制 | 不发起签署 |
| C1 Provider Binding | 保存 provider account 映射和可签准备态 | 不做签署策略判断 |
| C4 Policy Engine | 决策谁能签、如何签、用哪个 SigningPlan | 不调用法大大 |
| CPS 合规层 | 自动签署前检查证书有效性和合规规则 | 不自动续期证书 |
| B5 Execution Engine | 执行已批准的签署计划 | 不计算策略、不绕过 CPS |
| 租赁履约 | 在签署和商业 gate 都通过后激活租赁 | 不因签署完成直接创建付款记录 |
| 审计 / 风控 | 记录不可变审计、告警和合规证据 | 不写 PII、secret、完整 provider 原文 |

### 2.2 核心系统不变量

```text
签署完成 != 租赁激活。
```

签署完成只是法律前置条件。租赁激活还必须经过：

```text
已签署 PDF 归档
首付 / 押金 / 支付 gate
车辆交付准备
应收计划生成
风控 / 合规 hold 检查
```

## 3. CPS Compliance Layer 设计

CPS 合规层位于 C4 policy approval 与 B5 auto-sign execution 之间：

```text
C4 SigningPlan
-> CPSComplianceGate
-> CertificateValidityCheckService
-> ComplianceRuleEngine
-> ApprovedCPSDecisionRef
-> B5 execution
```

### 3.1 CertificateValidityCheckService

用于检查计划中的签署主体、企业印章、provider 身份对应的证书有效性。

输入：

```text
tenantId
enterpriseId
provider
providerEnterpriseCustomerId
sealId / signatureId
signingPlanHash
operation = AUTO_SIGN | MANUAL_SIGN | ARCHIVE | QUERY
```

输出：

```text
certificateStatus
validFrom
validTo
lastCheckedAt
source = PROVIDER_QUERY | CACHED_PROJECTION | ADMIN_ATTESTATION
providerEvidenceRef masked
```

规则：

```text
UNKNOWN 不允许自动签署
EXPIRED 阻断自动签署
REAUTH_REQUIRED 阻断自动签署
EXPIRING 按 tenant / region 规则决定 warn 或 block
VALID 只有在其他策略也通过时才允许继续
```

### 3.2 CPSComplianceGate

CPSComplianceGate 负责为 `extsign_auto.api` 或等价企业自动盖章操作生成执行 gate 决策。

决策模型：

```text
decision = ALLOW | WARN | BLOCK | REAUTH_REQUIRED
ruleVersion
certificateStatus
reasonCode
signingPlanHash
auditEventId
expiresAt
```

B5 只有在收到与同一个 `signingPlanHash` 绑定的 `ALLOW` 决策时，才允许执行自动盖章。

### 3.3 ReAuthTriggerFlow

负责显式重新授权流程。

要求：

```text
证书过期 -> 阻断自动签署
阻断结果 -> 生成 re-auth required 事件
管理员 / 授权操作员发起重新授权
只有在显式安全阀下才生成 provider re-auth URL 或启动 provider re-auth workflow
callback / query 确认成功后标记 REAUTHORIZED
projection refresh 后重新变为 VALID
之后才能按幂等规则重试自动签署
```

系统不得自动续期或自动重新授权证书。

### 3.4 CertificateStatusProjection

维护证书当前已知状态，用于后台看板、预检、告警和任务调度。

注意：

```text
projection 不是最终自动签署的法律 gate。
B5 调用自动签署前，仍必须由 CPSComplianceGate 生成有时效的最终 decision。
```

### 3.5 ComplianceRuleEngine

合规规则引擎是 provider-neutral、tenant-aware 的策略层。

规则域包括：

```text
CPS 证书有效性
tenant 级策略
region 级策略
provider capability
企业印章权限
SigningPlan 一致性
证据留存规则
```

## 4. Certificate Lifecycle Model

最小生命周期：

```text
UNKNOWN
-> VALID
-> EXPIRING
-> EXPIRED
-> REAUTH_REQUIRED
-> REAUTH_PENDING
-> REAUTHORIZED
-> VALID
```

附加控制态：

```text
DISABLED
REVOKED
SUSPENDED
```

### 4.1 状态定义

| 状态 | 含义 | 自动签署 |
| --- | --- | --- |
| UNKNOWN | 没有可靠证书状态 | 阻断 |
| VALID | 证书已验证且处于有效期内 | 其他规则通过后允许 |
| EXPIRING | 证书仍有效但进入预警窗口 | 按策略 warn 或 block |
| EXPIRED | 证书已过期 | 阻断 |
| REAUTH_REQUIRED | 系统要求重新授权 | 阻断 |
| REAUTH_PENDING | 重新授权已发起但未确认 | 阻断 |
| REAUTHORIZED | provider 已确认重新授权，等待刷新为 VALID | 刷新为 VALID 前阻断 |
| DISABLED | 管理员或合规人员禁用 | 阻断 |
| REVOKED | provider / CA 撤销证书 | 阻断 |
| SUSPENDED | 临时合规冻结 | 阻断 |

### 4.2 状态流转规则

```text
UNKNOWN -> VALID：provider 查询或批准的 onboarding 确认证书有效
VALID -> EXPIRING：系统时间进入预警窗口
EXPIRING -> EXPIRED：证书有效期结束
VALID / EXPIRING -> REAUTH_REQUIRED：策略要求签署前重新授权
EXPIRED -> REAUTH_REQUIRED：尝试自动签署或调度时发现已过期
REAUTH_REQUIRED -> REAUTH_PENDING：授权操作员发起重新授权
REAUTH_PENDING -> REAUTHORIZED：provider 确认重新授权成功
REAUTHORIZED -> VALID：证书 projection refresh 确认新有效期
任意 active 状态 -> DISABLED / SUSPENDED：合规操作
任意 active 状态 -> REVOKED：provider 或合规证据确认撤销
```

### 4.3 硬性不变量

```text
不得存身份证号。
不得存完整手机号。
不得存 appSecret。
不得存完整 provider 原始响应。
不得存完整 signUrl。
不得自动续期。
UNKNOWN / EXPIRED / REAUTH_REQUIRED / REAUTH_PENDING / REVOKED / DISABLED / SUSPENDED 均不得自动签署。
```

## 5. Auto-sign Execution Flow

自动签署路径只用于企业印章 / 平台侧自动盖章。客户手动签署仍由 C1/C2/C3/C4 readiness 和 B5 execution 控制。

推荐流程：

```text
1. Order 和 Contract 进入 signing-ready。
2. C3 确认客户 onboarding readiness。
3. C4 评估签署策略并编译不可变 SigningPlan。
4. SigningPlan 标记企业印章步骤需要 CPS gate。
5. B5 收到 ApprovedSigningPlanRef，但尚不执行自动盖章。
6. CPSComplianceGate 检查证书状态和合规规则。
7. ALLOW：B5 可以针对同一个 plan hash 调用 provider auto-sign。
8. WARN：只有策略允许 warning execution 时才可继续，并必须写审计。
9. BLOCK / REAUTH_REQUIRED：不调用 provider auto-sign。
10. ReAuthTriggerFlow 只能在明确授权动作后启动。
11. 重新授权并刷新为 VALID 后，按幂等规则重试。
```

### 5.1 `extsign_auto.api` 前置 Gate

任何等价于 `extsign_auto.api` 的调用前，B5 必须拿到：

```text
ApprovedSigningPlanRef present
ApprovedCPSDecisionRef present
decision = ALLOW
decision.signingPlanHash = signingPlan.hash
decision.notExpired
certificateStatus = VALID
sealAuthority active
tenant / region rules pass
```

任一条件不满足：

```text
返回 CPS_AUTO_SIGN_BLOCKED
不调用 provider
不生成 signUrl
不把 Contract / Order 推进为已签署状态
不激活租赁
写入合规审计事件
```

### 5.2 即将过期证书策略

默认建议：

```text
EXPIRING 在普通预警窗口内：WARN，用于 dashboard / preflight
EXPIRING 进入 strict block window：BLOCK
EXPIRED：BLOCK
```

预警窗口和硬阻断窗口必须来自有版本的合规规则，不能写死为 provider 假设。

## 6. Lease Fulfillment Engine 设计

租赁履约在签署完成且已签署 artifact 归档后启动。它不能由 signUrl 生成或签署任务创建直接驱动。

### 6.1 履约状态机

推荐状态：

```text
ORDER_CREATED
QUOTE_CONFIRMED
CONTRACT_GENERATED
SIGNING_READY
SIGNING_IN_PROGRESS
SIGNED
SIGNED_PDF_ARCHIVED
LEASE_ACTIVATION_PENDING
PAYMENT_GATE_PENDING
DELIVERY_GATE_PENDING
LEASE_ACTIVE
BILLING_SCHEDULED
SERVICE_ENTITLEMENTS_ACTIVE
FULFILLMENT_BLOCKED
SUSPENDED
TERMINATED
CANCELLED
```

### 6.2 激活 Gate

租赁激活必须满足全部配置 gate：

```text
contract.status = SIGNED
signedDocumentObjectKey present
签署任务完成且 callback verified
如果需要企业自动盖章，则 CPS gate 已通过
首付 / 押金 gate 已满足
车辆交付 / handover readiness 已确认
应收计划已生成
不存在风控 / 合规 hold
```

签署完成可以把订单推进到商业下一状态，例如 `PENDING_PAYMENT`，但不能直接：

```text
创建 PaymentRecord
创建 PaymentWriteOff
标记 ReceivableBill 已支付
激活车辆权益
在未满足 lease activation gates 前开始计费
```

### 6.3 履约服务拆分

| 服务 | 职责 |
| --- | --- |
| LeaseFulfillmentService | 负责 signed contract 到 active lease 的状态推进 |
| FulfillmentGateEvaluator | 检查 payment、delivery、compliance、artifact、risk gates |
| LeaseActivationService | 在 gates 通过后幂等激活租赁 |
| BillingScheduleService | 在激活批准后生成应收计划 |
| EntitlementActivationService | 在租赁激活后启用客户权益 |
| FulfillmentAuditService | 记录状态流转来源、操作者和证据引用 |

## 7. Compliance Rule Engine

合规规则引擎需要支持 CPS、区域规则、tenant 策略和审计追踪。

决策模型：

```text
ruleSetId
ruleVersion
subjectType = SIGNING_PLAN | AUTO_SIGN | LEASE_ACTIVATION | ARCHIVE | PROVIDER_BINDING
decision = ALLOW | WARN | BLOCK | REAUTH_REQUIRED | MANUAL_REVIEW
reasonCodes[]
evidenceRefs[]
effectiveAt
expiresAt
```

### 7.1 CPS Enforcement Rules

最小 CPS 规则：

```text
CPS_CERT_STATUS_REQUIRED
CPS_CERT_VALID_FOR_AUTO_SIGN
CPS_CERT_NOT_EXPIRED
CPS_CERT_REAUTH_NOT_PENDING
CPS_CERT_SOURCE_ACCEPTED
CPS_DECISION_BOUND_TO_PLAN_HASH
```

### 7.2 Region-based Compliance Rules

未来需要预留区域规则输入：

```text
customerRegion
vehicleRegistrationRegion
contractGoverningLawRegion
tenantOperatingRegion
providerDataResidencyRegion
```

未来可能规则：

```text
特定区域要求人工企业盖章
特定区域要求额外证据留存
特定区域禁止某类合同自动签署
特定区域要求本地化同意文本
```

### 7.3 审计追踪

每一次规则决策必须记录：

```text
tenantId masked
customerId masked
contractId masked
orderId masked
signingPlanHash
certificateStatus
ruleVersion
decision
reasonCodes
actor / system source
createdAt
```

审计日志不得包含：

```text
appSecret
完整 provider customer_id
完整身份证号
完整手机号
完整 provider 原始响应
完整 signUrl
PDF binary
```

## 8. 与现有 C1-C4-B5 系统的集成

### 8.1 C1 Provider Binding

C1 继续作为以下信息的来源：

```text
Customer -> provider customer_id
registrationStatus
realNameStatus
providerOpenId
```

CPS 后续可以新增独立企业证书 / 企业印章证书元数据，不能把企业自动盖章证书状态塞进个人 provider binding。

### 8.2 C2 Real-name Lifecycle

C2 负责身份和账号 readiness。CPS 证书状态是相邻但不同的概念：

```text
C2 realNameStatus = 身份 readiness
CPS certificateStatus = 企业自动盖章证书有效性
```

企业自动签署必须同时满足二者。

### 8.3 C3 Onboarding

C3 继续作为产品入口和 readiness 编排层。

C3 应展示：

```text
customer signing readiness
provider account readiness
real-name readiness
compliance readiness summary
```

C3 不得调用 `extsign_auto.api`。

### 8.4 C4 Policy Engine

C4 负责编译不可变 SigningPlan。

后续 SigningPlan 建议新增：

```text
requiresCpsGate: boolean
autoSignSteps[]
sealAuthorityRef
certificateSubjectRef
complianceRuleSetId
```

C4 不直接查询 provider 证书状态。C4 只声明策略和 gate 要求，CPS gate 在 B5 执行前做最终合规判定。

### 8.5 B5 Execution Engine

B5 只能执行：

```text
ApprovedSigningPlanRef
+ auto-sign steps 对应的 ApprovedCPSDecisionRef
```

B5 不得：

```text
计算 policy
选择 seal
忽略过期证书
自动续期证书
激活租赁
创建付款记录
```

### 8.6 Lease Fulfillment

租赁履约消费签署结果：

```text
callback verified
task completed
contract signed
signed PDF archived
compliance gates satisfied
```

租赁履约层不调用签署 provider API。

## 9. 风险分析

| 风险 | 失败模式 | 控制措施 |
| --- | --- | --- |
| 证书过期导致自动签失败 | provider 拒绝 `extsign_auto.api`，合同停在半完成状态 | CPS pre-gate 先阻断；触发 re-auth；幂等重试 |
| 绕过 CPS 检查直接自动盖章 | legacy B5 path 直接调用 auto-sign | B5 auto-sign step 必须要求 `ApprovedCPSDecisionRef` |
| 合规规则漂移 | CPS 规则更新但系统仍按旧假设运行 | rule versioning、公告 evidence register、定期合规复核 |
| 审计不完整 | 无法证明为什么允许或阻断自动签署 | 追加式合规决策事件，绑定 signingPlanHash |
| 证书状态过期缓存 | 缓存 VALID 后证书已过期 | decision TTL、最终 gate、系统时钟校验有效期 |
| 重新授权误用 | 操作员给错误企业或印章授权 | 权限 gate、生产双人审批、masked audit、tenant/enterprise 校验 |
| 租户隔离泄漏 | Tenant A 的 seal 被 Tenant B 合同使用 | tenant-scoped policy、seal、certificate、SigningPlan、CPS decision |
| 租赁过早激活 | 合同签完但未支付或未交付即激活 | FulfillmentGateEvaluator 分离 signed 与 active |
| 支付副作用 | 签署 callback 创建 PaymentRecord | callback 只推进签署/合同状态；支付由履约和财务 gate 控制 |
| provider outage | 证书查询失败导致自动盖章不可用 | 自动签署 fail closed；排队重试；人工 review |
| 合规证据缺失 | 后续无法证明 2026-06-23 CPS 要求来源 | 实现前必须附官方公告或内部合规通知 |

## 10. Production Readiness Assessment

当前基础能力：

| 能力 | 状态 |
| --- | --- |
| B5 真实签署执行 | 已验证 |
| 已签 PDF archive | 已验证 |
| C1 provider binding | 已实现 |
| C2 real-name lifecycle | 已实现 |
| C3 onboarding orchestration | 已实现并验证 |
| C4 policy engine + B5 integration | 已实现并验证 |
| multi-tenant signing architecture | 已设计 |
| CPS certificate validity gate | 仅设计 |
| `extsign_auto.api` 生产启用 | No-Go |
| Lease fulfillment engine | 仅设计 |
| 企业自动盖章生产开放 | No-Go |
| 租赁自动履约生产开放 | No-Go |

### 10.1 推荐 Feature Flags

```env
FADADA_AUTO_SIGN_ENABLED=false
FADADA_CPS_COMPLIANCE_ENABLED=false
FADADA_AUTO_SIGN_CPS_GATE_REQUIRED=true
LEASE_FULFILLMENT_ENGINE_ENABLED=false
LEASE_ACTIVATION_AFTER_SIGNING_ENABLED=false
COMPLIANCE_REGION_RULES_ENABLED=false
```

### 10.2 Production Go 条件

```text
官方 2026-06-23 CPS 公告或内部合规通知已入 evidence register
证书查询行为已通过法大大文档 / 支持确认
证书生命周期已持久化并具备审计
extsign_auto.api 已被 CPS decision 硬 gate
B5 direct auto-sign bypass 已移除或不可达
lease fulfillment state machine 已幂等实现
签署 callback 与 payment side effects 已隔离
非生产 CPS rehearsal 通过
生产 rollout 已有 rollback 与 re-auth runbook
```

在这些条件满足前：

```text
客户手动签署可以继续使用现有受控路径
企业自动盖章保持关闭
租赁激活保持非自动化
```

## 11. 推荐下一阶段

```text
Stage 10D-CPS-A：官方 CPS 公告 evidence register 与法大大证书 API 确认
Stage 10D-CPS-B：证书生命周期 schema / service implementation plan
Stage 10D-CPS-C：provider-free CPS gate MVP
Stage 10D-CPS-D：受控证书查询集成测试
Stage 10D-Lease-A：租赁履约状态机 implementation plan
Stage 10D-Lease-B：signed-contract -> lease-activation MVP，不触发财务副作用
```

## 12. 本阶段结论

Stage 10D-Lease-SaaS-CPS-Compliance-System-Design 是纯架构设计阶段。

结论：

```text
final SaaS architecture：已设计
CPS compliance layer：已设计
certificate lifecycle model：已设计
auto-sign execution gate：已设计
lease fulfillment engine：已设计
compliance rule engine：已设计
risk model：已记录
C1-C4-B5 integration：已映射
production readiness：自动盖章 / 租赁自动履约仍为 No-Go，直到 CPS 与履约实现阶段完成并验证
```
