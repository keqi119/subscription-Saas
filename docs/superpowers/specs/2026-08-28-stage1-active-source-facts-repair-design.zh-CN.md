# 阶段 1 在租订单源事实修复设计

> 日期：2026-08-28  
> 适用范围：阶段 1 在租期合同变更中心发布前修复  
> 基线：`main@72f639c`  
> 目标环境：Staging；Production 不在本轮数据修复范围内

## 1. 背景与已确认根因

`Staging-20260828-72f639c` 的迁移与校验均已通过，但合同变更引导脚本对 4 个 `ACTIVE` 订单报告以下阻断：

- 原始主合同 `startDate/endDate` 缺失；
- 3 个订单的主合同电子签证据已存在，但合同状态仍为 `SIGNED`，其中 1 个订单未绑定 `contractId`；
- 4 个订单均无 BASE 合同分段；
- 4 个订单均无当前 `VehicleSubscriptionPeriod`；
- 账单维护任务解析首个缺失分段的订单后抛出 `CONTRACT_SEGMENT_NOT_FOUND`，整轮维护失败并按 5 秒轮询间隔重复报错。

代码链路证明根因在交付激活事务：`LeaseActivationEngine.activateFromAuthoritativeHandover` 目前只写 `actualDeliveryAt`、订单/车辆/Lease 状态、BillingSchedule、权益和旅程事实，没有同时写原始合同履行日期、BASE 分段和车辆在租期间事实。后续合同变更与账单模块已把不可变合同分段作为权威来源，因此旧激活事务留下的事实缺口在新模块发布时被正确地 fail-closed 暴露。

本轮不把“缺少分段时继续使用订单月租”作为修复。该做法会绕过合同事实，可能生成无合同依据的账单。

## 2. 目标与非目标

### 2.1 目标

1. 未来每次权威交付激活在同一数据库事务内写齐：原始履行日期、BASE 分段、车辆在租期间、Lease、BillingSchedule、权益和审计。
2. 对历史 `ACTIVE` 订单提供 dry-run 优先、证据驱动、幂等、全量审计的源事实修复工具。
3. 单个订单存在业务事实异常时，仅阻断该订单的账单协调，不再阻断其他健康订单和到期任务。
4. 将所有发布前修复工具打包进 API runtime 镜像，避免线上临时复制脚本成为标准发布步骤。
5. 在任何存量写入前输出脱敏报告并要求单独的 apply 批准。

### 2.2 非目标

- 不改写已存在且与推导结果不一致的合同日期、合同分段、车辆期间或账单。
- 不从订单创建时间、客户确认时间或人工填写值猜测履行日期。
- 不下载、重签或重新生成历史电子签文件。
- 不直接用 SQL 人工插入 BASE 分段或车辆期间。
- 不回滚已应用的 109 个数据库迁移。
- 不在本轮修改 Production 数据。

## 3. 方案选择

### 3.1 采用：源头原子闭环 + 分层历史修复 + 逐单隔离

交付激活负责写齐未来事实；新的源事实修复器只恢复订单日期和已有电子签归档/绑定；随后复用既有 BASE 引导和 Stage 1C 车辆期间回填工具。每层都有独立 dry-run、阻断报告和幂等 apply。

优点：事实来源明确，复用现有不变量检查，失败面可定位，存量写入可审计。缺点：发布前需要按顺序执行多道门槛。

### 3.2 不采用：只修复当前 4 个订单

只运行一次性 SQL 或只补历史脚本不能修复交付激活源头，后续新订单仍会产生同类缺口，也无法形成可复验的审计证据。

### 3.3 不采用：账单模块回退到订单字段或最终方案

这会让无归档合同或无有效分段的订单继续生成账单，破坏“合同分段是账单权威来源”的阶段 1 基线，因此禁止。

## 4. 未来交付激活原子闭环

### 4.1 事务边界

在现有权威交付事务和行锁内，按以下顺序执行：

1. 校验归档主合同、交付交接、证据审批、车辆、保险、首期账单等既有门槛。
2. 以权威交接 `completedAt` 作为唯一激活时间 `activatedAt`。
3. 以 `Asia/Shanghai` 日历日推导原始主合同日期：
   - `startDate = activatedAt` 的上海业务日期；
   - `endDate = addCalendarMonths(startDate, periodMonths) - 1 day`；
   - 月末采用夹紧规则，例如 1 月 31 日加 1 个月得到 2 月最后一天。
4. 更新订单 `actualDeliveryAt/startDate/endDate/orderStatus`。
5. 使用事务内接口从订单快照和归档主合同创建或核对唯一 BASE 分段。
6. 使用 `AssetFactsService` 的 caller-owned transaction 能力创建或核对唯一车辆在租期间，原因使用 `DELIVERY_CONFIRMED`，稳定来源键使用订单与权威交付记录。
7. 继续写车辆、Lease、BillingSchedule、里程、权益、旅程和审计事实。

任一步失败，整笔交付激活回滚，不允许订单已 `ACTIVE` 而合同/车辆期间事实缺失。

### 4.2 重放与冲突

- 完全一致的 BASE 分段、车辆期间和日期视为幂等重放，不创建重复记录。
- 已存在但日期、合同、车辆、客户或来源不一致时抛出稳定冲突码并回滚。
- 既有 `ContractSegmentService.ensureBaseSegment` 增加事务内窄接口；外部公开接口仍保留串行化事务和行锁。
- 激活审计补充 `startDate/endDate/baseSegmentId/subscriptionPeriodId`，不得记录客户敏感字段。

## 5. 历史源事实修复器

### 5.1 工具边界

新增以下三层脚本：

- 纯函数分类器：只接收快照并输出候选、未变更项和异常；
- 执行器：负责 Repeatable Read dry-run、Serializable apply、加锁、重分类和审计；
- CLI：只接受 `--dry-run` 或 `--apply`，支持 `--output`，输出脱敏 JSON。

apply 还必须满足专用环境确认值 `STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_APPLY=1`。报告不得输出姓名、手机号、身份证号、数据库 URL、对象存储凭证或电子签访问参数。

### 5.2 日期证据规则

仅当以下条件同时满足，才可推导订单日期：

- 订单为未删除的 `ACTIVE` 或 `PENDING_RETURN` 订阅订单；
- `periodMonths` 为正整数；
- `actualDeliveryAt` 有效；
- 存在唯一未删除的 `DELIVERED` 交付记录；
- 存在唯一可信的 Lease，状态为 `ACTIVE/RETURN_DUE/COMPLETED`；
- `actualDeliveryAt`、交付 `deliveredAt`、Lease `activatedAt` 三者完全相同；
- 交付、Lease、订单的订单、车辆和客户身份一致；
- `startDate/endDate` 均为空，或均与推导结果完全一致。

任一时间戳冲突、只有一个日期缺失、日期与推导结果不同、交付/Lease 多义或身份不一致，均进入异常清单，不覆盖原值。

### 5.3 主合同证据规则

主合同权威按以下顺序确定：

1. `order.contractId` 指向同订单、同客户、未删除且已归档的订阅主合同；或
2. `order.contractId` 为空时，订单下恰好存在一个可证明的阶段 1 订阅主合同。

“可证明”要求同时满足：

- 合同状态为 `SIGNED` 或 `ARCHIVED`，`signedAt` 存在；
- 存在且仅存在一个匹配该合同/订单的阶段 1 订阅电子签任务；
- 任务状态已完成，`completedAt` 和 `signedDocumentObjectKey` 存在；
- 合同 `fileId` 指向存在的 PDF 文件对象，且文件 `objectKey` 与任务的 `signedDocumentObjectKey` 完全相同；
- 合同快照为非数组 JSON 对象；
- 合同、任务、订单的订单和客户身份一致。

当合同仍为 `SIGNED` 但上述已签文件证据完整时，修复器只把既有合同生命周期恢复为 `ARCHIVED`，`archivedAt` 使用电子签任务 `completedAt`；不重新下载或生成文件。`order.contractId` 为空且合同唯一时可同时恢复绑定。多合同、多任务、文件键不一致、缺少文件或时间线倒置均 fail-closed。

### 5.4 apply 写入

apply 在单一串行化事务中：

1. 获取修复 advisory lock，并锁定候选订单、合同、电子签任务、文件、交付、Lease、分段和车辆期间行；
2. 重新加载并重新分类，拒绝陈旧 dry-run 计划；
3. 恢复确定性的合同归档/绑定和订单日期；
4. 为每个发生变化的 `contract` 与 `subscription_order` 写审计日志，快照只保留业务编号、状态、日期、关联 ID 和证据哈希/对象键哈希；
5. 任一候选发生冲突则整批不写入。

该工具不创建 BASE 分段和车辆期间。这样可继续由现有两个专项工具分别验证合同分段不变量和车辆重叠不变量。

## 6. 修复流水线与发布门槛

存量修复严格按以下顺序：

```text
源事实修复 dry-run
  -> 人工审阅零异常
  -> 单独批准源事实 apply
  -> 源事实 apply + replay
  -> BASE 分段 dry-run
  -> 人工审阅零异常
  -> 单独批准 BASE apply
  -> BASE apply + replay
  -> Stage 1C 车辆期间 dry-run
  -> 人工审阅零异常/重叠/遗漏
  -> 单独批准 Stage 1C apply
  -> Stage 1C apply + replay
  -> 合同变更 bootstrap dry-run
  -> 四个功能旗标显式配置
  -> 发布新 API/Web 镜像
  -> 账单、四类合同变更、Portal/Admin 冒烟
```

任何一步非零退出、候选数异常、存在 blocker、replay 产生新增写入或审计不匹配，都停止后续步骤。数据库备份必须先于第一个 apply，保留现有 `pre-contract-change-blocker-repair-20260828.dump` 及校验和；若修复前数据库状态发生变化则重新备份。

API runtime 镜像必须包含：源事实修复、BASE 引导、Stage 1C 期间回填、合同变更 bootstrap 及其直接依赖。运行时媒体测试校验这些路径，避免再次依赖临时 SCP。

## 7. Billing Worker 逐单隔离

### 7.1 业务异常与系统异常分离

`reconcileSchedules` 对每个订单独立解析有效服务结束日和账单分段：

- `CONTRACT_SEGMENT_NOT_FOUND`、`BILLING_PERIOD_CROSSES_SEGMENT` 等已知合同事实错误转换为脱敏 `BLOCKED` 项，包含 `orderId/orderNo/blockerCode/periodStart`，不创建或更新该订单的 Lease、Schedule、Bill 或 Job；
- 其他健康订单继续协调；
- 数据库不可用、事务失败、代码异常等系统错误仍抛出，使 worker 报警并重试。

返回汇总增加 `blockedCount` 和 `blockedItems`。Admin 预览/执行接口保持可解释性；worker 每轮只记录一次聚合告警，不再因同一业务异常每 5 秒记录整轮失败。

### 7.2 到期任务不被阻断

即使协调结果包含业务 blocker，worker 仍继续执行 `enqueueDueSchedules()` 和已领取任务。只有系统错误才中止该轮。这样异常订单 fail-closed，健康订单继续履约。

## 8. 测试设计

### 8.1 交付激活

- 上海跨 UTC 日期边界、月末、闰年和 12 个月期限计算；
- 同一事务写齐日期、BASE、车辆期间、Lease、Schedule 和审计；
- 中途任一点注入失败时全事务回滚；
- 完全一致重放幂等，冲突重放失败关闭；
- 归档主合同或快照缺失时不得进入 `ACTIVE`。

### 8.2 历史修复器

- 4 类干净候选：日期修复、合同归档、合同绑定、全量组合；
- 时间戳、身份、合同、任务、文件、日期和既有事实冲突均进入稳定异常码；
- dry-run 零写入；apply 必须显式确认；apply 内重分类；并发 apply 只写一次；失败全量回滚；
- replay 全部 `UNCHANGED`；报告确定、脱敏，不泄露连接串和凭证。

### 8.3 账单隔离

- 一个缺失分段订单与一个健康订单同批时，前者 `BLOCKED`、后者成功；
- blocker 不激活 Lease、不创建 Schedule、不生成 Job；
- worker 在有 blocker 时仍 enqueue 健康任务；
- 数据库错误仍让轮询失败并记录系统错误；
- Admin 响应显示 blocker 数量和原因。

### 8.4 质量门槛

至少执行：Prisma validate/generate、API/Web lint 与 typecheck、脚本测试、相关 Vitest、API/Web 全量测试、构建、迁移状态、迁移校验和、`git diff --check` 和 main CI。Staging 还需完成 clean dry-run/replay 和账单日志静默观察。

## 9. 验收标准

1. 新交付订单在激活提交后具有唯一一致的原始日期、BASE 分段和当前车辆期间。
2. 目标 Staging 存量订单在所有 dry-run 中零 blocker，三个 apply replay 均零新增写入。
3. Billing Worker 不再出现由单个订单合同事实缺失导致的整轮 `BILLING_EXECUTION_ERROR`；健康账单任务正常入队。
4. 四个合同变更功能旗标显式配置，四类变更创建入口与权限冒烟通过。
5. 新镜像、迁移状态、备份、报告、审计记录、CI 与人工验收证据可追踪到同一提交。

## 10. 已知限制

- 证据不能唯一证明的订单不会自动修复，必须进入单独人工事实核验流程。
- 本设计不提供“管理员随意填写合同起止日”的入口；如未来需要，应另行设计双人复核、证据附件和不可变修订记录。
- 存量数据 apply 属于业务数据变更，即使代码与 dry-run 全部通过，也必须由用户再次明确批准。
