# Stage 2 车辆交接第一波编排闭环与验收解阻设计

日期：2026-08-01
状态：已完成对话评审，待书面规格确认
分支：`fix/staging-stage2-handover-wave1-20260801`

## 1. 背景与目标

本设计处理验收报告中的第一波问题：

- `STG2-001`：主合同签署及交接前账单支付完成后，订单工作台没有明确提示推进车辆交接。
- `STG2-002`：Admin 指派外部 Field 人员后，没有自动发送现场交接任务通知。
- `STG2-003`：公众号缺少 Field 入口。该入口现已由用户配置为 `/field/handover`，本轮只验证，不再修改公众号菜单。
- `STG2-006`：客户确认并生成 Stage 2 源 PDF 后，Field 无法发起电子签；通知任务失败时工作台只显示笼统的“处理中”。

第一波目标是恢复并稳定以下闭环：

```text
Stage 1 已签署 + 交接前账单已结清
  -> Admin 工作台提示推进车辆交接
  -> 完成交付准备并创建现场交接工单
  -> Admin 指派外部 Field 人员
  -> Field 收到任务生成短信并从公众号进入 /field/handover
  -> Field 完成现场采集并提交
  -> 客户在 Portal 确认无异议
  -> 系统生成 Stage 2 源 PDF v2
  -> Field 收到源 PDF 就绪短信并发起电子签
  -> 客户收到待签短信并从 Portal 签署
```

本轮不重构整个 Stage 2 状态机，不直接修改验收订单的业务状态，不手工改写 PDF 版本或工作流任务状态。

## 2. 范围与非目标

### 2.1 本轮范围

1. 修正 Stage 2 电子签 readiness 的源 PDF 版本漂移。
2. 为外部 Field 指派增加可靠、幂等、可恢复的短信任务。
3. 保持并修复源 PDF 就绪通知和客户待签通知。
4. 让订单工作台使用权威业务检查结果显示明确下一步和工作流状态。
5. 在 Staging 补齐真实阿里云短信配置并受控验证现有订单。
6. 验证公众号 `/field/handover`、手机号登录及任务可见性。

### 2.2 非目标

- 不处理 `STG2-004`、`STG2-005` 的视频上传与录像清晰度问题；这些属于第二波。
- 不处理 `STG2-007` 的 Field 结构化验车与 PDF 字段映射；这些属于第三波。
- 不修改或重新应用微信公众号菜单。
- 不把短信送达设为电子签或交付的硬门禁。
- 不改变 Stage 1 合同签署、支付、交付确认、租约激活或账单激活规则。
- 不删除历史工作流任务、短信记录或旧枚举值。

## 3. 已确认的核心决策

### 3.1 采用“编排闭环”而不是最小补丁

本轮不仅修正 `artifactVersion`，还补齐通知触发、工作台下一步、重试状态与恢复入口。仍沿用现有持久化任务、幂等发送记录、readiness 服务和权限模型，不引入第二套流程状态。

### 3.2 三个短信模板具有不同触发语义

| 触发时点 | 模板编号 | 接收人 | 模板参数 |
| --- | --- | --- | --- |
| Admin 完成外部 Field 人员指派 | `SMS_511185078` | 当前被指派交车员 | `{ name: plateNo }` |
| Stage 2 源 PDF 已生成，Field 可发起电子签 | `SMS_510815118` | 当前交车员 | 无变量 |
| Field 已发起电子签，客户待签 | `SMS_510795093` | 当前客户 | 无变量 |

`SMS_511185078` 的变量名必须是阿里云已审核模板中的 `name`，值为该工单关联订单当前车辆的权威完整车牌号 `Vehicle.plateNo`。

### 3.3 短信与业务推进解耦

- 外部人员指派成功后，即使短信失败，指派也保持成功。
- 源 PDF 就绪短信失败不能让 `canStartESign` 变为 `false`。
- 客户待签短信失败不能撤销已创建的电子签任务。
- 通知失败通过持久化任务重试、死信恢复和工作台提示处理。

### 3.4 当前验收订单不做直接数据修补

当前订单 `ORD20260731173351SMF2` 已有 `NOTIFY_FIELD_ESIGN_READY` 任务。部署后保留该任务，让它在配置恢复后按原幂等键发送一次 `SMS_510815118`。不得把源 PDF 版本从 2 改回 1，不直接更新任务状态，不补造短信发送日志。

## 4. 数据流与触发设计

### 4.1 外部 Field 指派通知

Admin 指派外部 Field 人员时，系统在同一个数据库事务中完成：

1. 锁定并重新读取当前工单。
2. 校验工单仍允许指派。
3. 写入当前外部经办人姓名、标准化手机号和访问状态。
4. 写入 `EXTERNAL_OPERATOR_ASSIGNED` 事件和审计信息。
5. 创建 `NOTIFY_FIELD_HANDOVER_ASSIGNED` 持久化任务。

通知任务使用本次指派事件的稳定 ID 参与幂等键，例如：

```text
field-assigned:{workOrderId}:{assignmentEventId}
```

这样同一次指派只发送一次；改派会产生新事件和新任务，可以通知新经办人。

任务执行时不能盲信入队时的手机号或车牌快照。Worker 必须重新读取并核验：

- 工单仍为当前有效工单；
- 当前 `operatorType` 为 `EXTERNAL`；
- 当前指派事件仍对应当前手机号；
- 工单、订单和车辆关联一致；
- `Vehicle.plateNo` 存在且符合短信参数长度约束。

若任务已经被后续改派取代，则以“已过期/已替代”安全完成，不向旧手机号发送。若当前手机号或车牌缺失，则不调用供应商，任务进入可见失败/重试流程。

### 4.2 Field 源 PDF 就绪通知

现有 `GENERATE_SOURCE_PDF -> NOTIFY_FIELD_ESIGN_READY` 编排保留：

- 仅在客户确认、源 PDF 成功生成并绑定当前证据包后入队。
- 使用 `SMS_510815118`。
- 无模板变量，不再发送额外的 `instruction` 参数。
- 任务执行前重新核验当前源 PDF、当前工单和当前 Field 手机号。
- 现有历史任务继续使用原任务类型和幂等键，确保当前验收订单可以自然恢复。

### 4.3 客户待签通知

现有 `NOTIFY_CUSTOMER_ESIGN_READY` 保留：

- 仅在 Field 成功创建当前 Stage 2 电子签任务、客户签署入口就绪后入队。
- 使用 `SMS_510795093`。
- 无模板变量，不再发送额外的 `instruction` 参数。
- 电子签任务创建成功是权威事实；短信失败不会回滚该任务。

## 5. 源 PDF 版本与电子签 readiness

当前源 PDF 生成侧权威版本为：

```ts
STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION = 2
```

`Stage2HandoverESignReadinessService.checkHandoverSource()` 不得再硬编码 `artifactVersion !== 1`，必须引用同一运行时常量。版本 2 应通过；版本 1 或未来未知版本应继续被 `SOURCE_ARTIFACT_VERSION_INVALID` 拒绝。

离线回填脚本中的 `scripts/stage2-handover-workflow-contract.mjs` 也必须更新为版本 2，并新增漂移回归测试，防止运行时和运维脚本再次使用不同版本。

修复不会放宽其他 readiness 门禁。以下检查继续有效：

- Stage 1 当前合同已签署；
- 最新 Field 事实和证据完整；
- 客户确认覆盖当前证据包；
- 源 Contract、FileObject、PDF 哈希、manifest 哈希和签署槽位匹配；
- 源模板是启用中的 `DELIVERY_HANDOVER`；
- 当前没有冲突或过期的 Stage 2 电子签任务。

## 6. 订单工作台设计

### 6.1 “推进车辆交接”入口

订单工作台不自行复制支付或交付规则，而是复用现有 `delivery-check` 权威结果：

- 当 Stage 1、账单、车辆和交付准备前置条件未满足时，交接模块显示前置条件未满足，不提供提前操作。
- 当前置条件已满足且尚无有效现场交接工单时，显示 `ACTION_REQUIRED` 和新动作 `handover.prepare`，文案为“推进车辆交接”。
- 动作只导航到当前订单的车辆交接模块，不在工作台静默创建工单。
- `handover.prepare` 继续受 `delivery:prepare` 权限控制。
- 交付准备完成且工单未指派时，继续显示“分配交接任务”。

### 6.2 工作流任务状态

工作台和车辆交接模块应显示安全、可操作的状态，而不是只有“处理中”：

- `PENDING`：等待系统重试，并显示 `nextRunAt`。
- `PROCESSING`：系统正在处理，并显示当前任务名称。
- readiness 被阻塞：显示安全的业务阻塞分类并导航到交接详情。
- `DEAD_LETTER`：显示现有受权限保护的恢复动作，例如“重发经办人通知”。
- 电子签已经就绪但短信仍重试时：交接签署保持可用，通知状态以非阻塞提示展示。

API 只返回白名单化的任务类型、状态、尝试次数、最大次数、下次运行时间和安全错误分类。不得把供应商请求体、手机号、签署 URL、对象存储键、原始异常或凭据暴露到工作台。

### 6.3 Admin fallback 边界

本轮不改变既有的 Field 优先和 15 分钟 Admin fallback 规则。工作台不得仅根据页面时间自行推断 Admin 可发起电子签；任何 fallback 动作仍以 API 返回的权威 capability 为准，并在执行事务中再次校验。

## 7. Schema、配置与兼容性

### 7.1 Additive Prisma 迁移

新增枚举值：

- `CustomerVerificationCodePurpose.FIELD_HANDOVER_ASSIGNED`
- `VehicleHandoverWorkflowJobType.NOTIFY_FIELD_HANDOVER_ASSIGNED`

迁移只追加 PostgreSQL 枚举值，不删除、不重命名历史枚举，不修改现有业务行。

### 7.2 配置

Staging/API 配置需要明确包含：

```dotenv
FIELD_OPERATOR_SMS_ENABLED=true
FIELD_OPERATOR_SMS_PROVIDER=aliyun
ALIYUN_SMS_FIELD_HANDOVER_ASSIGNED_TEMPLATE_CODE=SMS_511185078
ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510815118
ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510795093
```

客户短信仍遵守现有 `PORTAL_SMS_ENABLED` 和供应商配置边界。模板编号不是秘密；阿里云凭据、签名名称和访问密钥不得写入仓库或发布记录。

示例环境文件、部署 Compose 透传和 rollout runbook 必须同步更新。缺少模板编号时应返回明确的安全配置错误，工作流记录可恢复分类，不应只保留泛化 `WORKFLOW_ERROR`。

### 7.3 模板参数

短信服务由当前统一的固定 `instruction` 参数改为按模板显式构造参数：

```ts
FIELD_HANDOVER_ASSIGNED -> { name: plateNo }
FIELD_HANDOVER_ESIGN_READY -> {}
CUSTOMER_HANDOVER_ESIGN_READY -> {}
```

模板参数必须经过长度和文本校验；不能包含客户姓名、手机号、证件号、VIN、订单编号、任务链接、签署链接或令牌。

## 8. 错误处理、幂等与审计

### 8.1 错误分类

至少区分以下安全分类：

- 短信功能未启用；
- 短信供应商或模板未配置；
- 当前 Field 接收人缺失；
- 当前车辆车牌缺失；
- 指派任务已被新指派取代；
- 供应商明确拒绝；
- 供应商结果不确定；
- 本地发送记录最终化不确定。

可重试错误按现有退避策略处理；达到最大次数后进入 `DEAD_LETTER`。确定已过期的旧指派任务安全完成且不发送。供应商结果为 `UNCERTAIN` 时不得自动重复调用，避免重复短信。

### 8.2 幂等

每类短信使用独立的 `SmsSendLog.idempotencyKey` 和用途：

- 指派通知绑定工单和指派事件；
- Field 源 PDF 就绪通知绑定工单和源 artifact 版本；
- 客户待签通知绑定当前 Stage 2 电子签任务/客户交易。

相同幂等键若手机号或用途不一致，视为冲突并拒绝发送。

### 8.3 审计

继续记录：

- Admin 指派操作及脱敏手机号；
- 工作流任务创建、领取、重试、完成和死信；
- 短信发送用途、脱敏手机号、供应商状态和发送记录 ID；
- Admin 手工恢复操作及权限主体。

不得在审计、错误提示或 PR/发布报告中记录完整手机号、短信供应商响应体、签署 URL、访问令牌或客户身份信息。

## 9. 测试设计

实现遵循测试驱动：先增加失败测试，再写生产实现。

### 9.1 API 与数据测试

- readiness 接受权威 artifact v2。
- readiness 拒绝 v1 和未知版本。
- 回填脚本版本与运行时版本一致。
- 外部指派在同一事务创建一条指派通知任务。
- 重复提交同一次指派不会重复入队或重复发送。
- 改派后旧任务不向旧手机号发送，新任务可通知新手机号。
- `SMS_511185078` 使用 `{ name: plateNo }`。
- 车牌或当前手机号缺失时不调用供应商。
- `SMS_510815118` 和 `SMS_510795093` 使用空模板参数。
- 三类短信使用独立用途和幂等键。
- 供应商明确失败、未知结果和发送记录竞争保持现有安全语义。
- 历史 `NOTIFY_FIELD_ESIGN_READY` 任务仍可被处理。

### 9.2 工作台与 Web 测试

- 前置条件未满足且无工单时不提前显示推进动作。
- `delivery-check.canPrepareDelivery=true` 且无工单时显示“推进车辆交接”。
- 工单未指派时显示“分配交接任务”。
- `PENDING/PROCESSING` 展示安全任务名称和下一次重试时间。
- `DEAD_LETTER` 仅向有权限人员展示匹配的恢复动作。
- 通知任务失败但 readiness 为 true 时，Field 发起电子签按钮仍可用。
- artifact v2 的 Field 详情显示可发起电子签。

### 9.3 质量门禁

提交和发布前至少运行：

```powershell
pnpm stage2-handover-workflow:backfill:test
pnpm --filter @subscription-saas/api test -- \
  stage2-handover-esign-readiness.spec.ts \
  stage2-handover-notifications.spec.ts \
  stage2-handover-workflow-recovery.spec.ts \
  order-workspace.spec.ts
pnpm --filter @subscription-saas/web test -- \
  admin-order-workspace.spec.ts \
  admin-stage2-handover-esign.spec.ts \
  field-handover-api.spec.ts
pnpm quality:gate
pnpm -r build
git diff --check
```

所有自动化测试使用 mock 短信，不调用真实阿里云、微信、法大大、Staging 或生产外部服务。

## 10. Staging 发布与恢复

### 10.1 发布顺序

1. 合并第一波 PR，并从合并提交构建 API/Web 镜像。
2. 记录旧镜像、数据库备份和当前未完成任务计数。
3. 部署 additive 枚举迁移。
4. 部署兼容的新 API/Web 镜像，先保持 Stage 2 worker 关闭。
5. 注入并核对三套短信模板配置以及真实阿里云 provider/enabled 配置。
6. 执行 Stage 2 backfill dry-run；不得直接更新任务状态。
7. 启用单并发 worker，确认 API 健康和任务领取正常。
8. 刷新当前工单 readiness，确认 `SOURCE_ARTIFACT_VERSION_INVALID` 消失且 Field 按钮可用。
9. 允许当前已有 `NOTIFY_FIELD_ESIGN_READY` 任务自然重试，确认仅向当前 Field 手机发送一次 `SMS_510815118`。
10. 验证公众号 `/field/handover`、手机号登录和当前任务可见性。
11. 用户恢复人工验收；Field 发起电子签后由系统自然触发 `SMS_510795093`。

当前订单已错过“指派完成”触发点，因此不为它补造 `SMS_511185078` 指派通知。该新模板在下一次受控外部指派或新验收订单中验证，避免为测试重新指派当前工单。

### 10.2 恢复

- 若现有通知任务仍为 `PENDING`，由 worker 按原计划和原幂等键重试。
- 若已进入 `DEAD_LETTER`，使用现有受权限保护、带审计的恢复接口创建替代任务。
- 不直接执行 SQL 修改任务状态，不删除旧任务，不插入伪造短信记录。

### 10.3 回滚

1. 先关闭 Stage 2 worker，确认不再领取新任务。
2. 保留所有 `PENDING`、`PROCESSING`、`COMPLETED` 和 `DEAD_LETTER` 任务。
3. 如需运行时回滚，恢复此前记录的兼容 API/Web 镜像。
4. 保留新增枚举；不执行破坏性 down migration。
5. 记录未完成任务的安全计数和本地 ID，修复后再通过 dry-run 恢复。

## 11. 验收标准

第一波完成需同时满足：

1. 支付和 Stage 1 签署完成后，工作台明确显示“推进车辆交接”。
2. 新的外部 Field 指派生成一条持久化通知任务，模板 `SMS_511185078` 的 `name` 为正确车牌。
3. 源 PDF v2 被 readiness 接受，Field “发起电子签”按钮可用。
4. 源 PDF 就绪时发送 `SMS_510815118`，客户待签时发送 `SMS_510795093`。
5. 三类通知均可审计、幂等、重试，且通知失败不回滚业务事实或阻塞电子签资格。
6. 工作台能区分重试中、处理中、readiness 阻塞和死信，并展示下一步。
7. 公众号 `/field/handover` 可进入，Field 登录后只能看到当前手机号获授权的任务。
8. 当前验收订单在不直接修改数据库的情况下解除 `SOURCE_ARTIFACT_VERSION_INVALID` 阻塞并恢复通知链路。
9. 迁移状态、质量门禁、构建和相关端到端回归全部通过。

## 12. 后续波次

- 第二波：`STG2-004`、`STG2-005`，修复高质量视频上传、413 提示、视频元数据与录像清晰度策略。
- 第三波：`STG2-007`，实施 Field 结构化验收表、历史数据兼容和客户确认/PDF 一致性。
