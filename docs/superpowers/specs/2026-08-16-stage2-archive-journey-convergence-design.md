# Stage 2 归档后 Journey 状态收敛设计

## 1. 背景与问题

订单 `ORD20260814085019DMGZ` 已完成 Stage 2 客户签署、平台盖章和签署文件归档，但权威状态没有继续收敛：

- `VehicleDeliveryHandover` 已为 `ARCHIVED / ARCHIVED`，且签署文件、对象键和 SHA-256 均完整；
- `VehicleHandoverWorkOrder` 仍为 `CUSTOMER_CONFIRMED`，`opsReviewStatus=NOT_REQUIRED`；
- Subscription Journey 仍停在 `HANDOVER_AND_STAGE2_CREATION / RETRY_SCHEDULED`；
- 未生成第三个人工任务 `DELIVERY_EVIDENCE_DECISION`；
- 未生成 `AUTHORITATIVE_ACTIVATION` 任务，订单、交付、车辆和 Lease 均未激活。

现有 `markOpsReviewPending` 会生成精确 evidence manifest，并通过 `HANDOVER_EVIDENCE_READY` 信号推进 Journey，但 Stage 2 归档成功路径没有调用该能力。归档本身成功、后续信号缺失，是本次故障的根因。

## 2. 目标与非目标

### 2.1 目标

1. Stage 2 权威归档成功后，幂等地将对应交接工单推进到运营证据复核待办。
2. 生成并绑定当前精确 evidence manifest，发出唯一的 `HANDOVER_EVIDENCE_READY` 领域信号。
3. Journey 自动进入 `DELIVERY_EVIDENCE_DECISION / WAITING_MANUAL`，Admin 显示“通过证据 / 驳回证据”。
4. 人工通过后，沿现有 `AUTHORITATIVE_ACTIVATION` 自动激活订单、交付、车辆、Lease、BillingSchedule 和权益。
5. 自动修复已经完成归档、但因旧代码或进程中断而没有发出信号的存量记录，包括当前验收订单。

### 2.2 非目标

- 不替换或重签已归档的 Stage 2 PDF。
- 不修改本次验收中已使用的旧平台印章；正确印章配置仅影响后续新合同。
- 不直接更新生产或 Staging 数据库业务状态。
- 不跳过 `DELIVERY_EVIDENCE_DECISION` 人工决定。
- 不修改还车流程、Stage 1 合同流程、支付流程或法大大协议字段。
- 不新增数据库表、枚举或迁移。

## 3. 方案比较

### 方案 A：幂等收敛服务 + 即时触发 + 有界补偿（采用）

在交接域增加单一收敛入口。归档成功后立即调用；Stage 2 worker 以小批量、严格条件扫描已归档但未进入证据复核的记录，补偿“归档事务已提交、后续进程中断”以及本次历史记录。

优点：以权威归档事实为前提；覆盖正常路径和崩溃窗口；可重复执行；无需人工改库；不需要永久暴露新的人工按钮。

代价：worker 增加一条范围受限的补偿查询，必须限制批量、候选状态和幂等键。

### 方案 B：仅在归档调用点追加状态更新

优点：代码最少。

缺点：无法恢复当前已经归档的订单，也无法处理归档提交后、信号发送前的进程中断，仍会产生同类孤儿状态。

### 方案 C：一次性 SQL/迁移修复

优点：当前数据恢复快。

缺点：绕过领域校验、manifest 生成、事件和审计；不能修复未来故障窗口；违反 Golden Path 不得直接改状态跳步的要求，因此不采用。

## 4. 架构与职责

### 4.1 交接工单收敛入口

在 `HandoverWorkOrderService` 提供一个面向权威归档事实的幂等方法，例如：

```ts
reconcileArchivedStage2JourneyEvidence(
  workOrderId: string,
  actorId?: string,
  db?: Prisma.TransactionClient
): Promise<{
  manifestHash: string;
  outcome: "ALREADY_READY" | "SIGNALLED";
  workOrderId: string;
}>
```

该方法只承担以下职责：

1. 锁定并重新读取交接工单、关联 handover 与 Journey；
2. 校验 handover 为完整权威归档：
   - `status=ARCHIVED`；
   - `archiveStatus=ARCHIVED`；
   - `archivedAt`、`signedDocumentFileId`、`signedObjectKey`、`signedPdfHash` 完整；
3. 拒绝已取消、作废、失败、客户异议或绑定不一致的工单；
4. 基于当前证据重新计算精确 manifest，不复用客户端或旧 metadata 中的 hash；
5. 将工单收敛为 `OPS_REVIEW_PENDING`、`opsReviewStatus=PENDING`，补齐可由权威签署事实推导的时间字段；
6. 记录 `OPS_REVIEW_UPDATED` 领域事件，注明来源为 Stage 2 权威归档收敛；
7. 调用现有 `recordJourneyEvidenceReady`，使用稳定事件键写入 Journey outbox。

若工单已经处于 `OPS_REVIEW_PENDING` 或更后状态，方法不得回退状态；它只验证 manifest 并幂等补发相同信号。重复调用不得重复创建 ManualTask、JourneyEvent 或激活记录。

### 4.2 正常归档即时触发

两个能够完成 Stage 2 归档的入口都必须在确认 `archiveStatus=ARCHIVED` 后调用收敛入口：

- `Stage2HandoverWorkflowService` 的 `ARCHIVE_SIGNED_PDF` worker 路径；
- `Stage2HandoverESignService` 的后台归档重试路径。

归档事务与收敛事务分开：归档文件和哈希一旦成功即保持权威，不因后续 Journey 信号失败而回滚或删除。若收敛失败，现有异步任务进入可重试状态，再次执行时复用相同归档事实和幂等信号。

### 4.3 有界补偿

Stage 2 worker 每轮最多选择少量候选记录，候选必须同时满足：

- handover 是完整权威归档；
- 订单存在未完成 Journey；
- Journey 当前步骤为 `HANDOVER_AND_STAGE2_CREATION`；
- 工单不是取消、作废、失败或客户异议状态；
- 尚未形成当前 manifest 对应的开放证据复核任务。

worker 对每条候选调用同一收敛入口，不编写第二套状态更新逻辑。查询必须有固定批量上限，单条失败不得阻断其他候选；失败进入现有日志/重试观察面，不直接篡改 Journey。

该补偿用于：

- 当前订单的受控恢复；
- 归档提交后 API/worker 进程中断的恢复；
- 发布前旧版本形成的同类孤儿状态。

## 5. 状态流

```text
Stage 2 签署文件权威归档
  -> 校验 handover 完整归档事实
  -> 重新计算精确 evidence manifest
  -> WorkOrder = OPS_REVIEW_PENDING
  -> HANDOVER_EVIDENCE_READY（稳定幂等键）
  -> Journey 完成 HANDOVER_AND_STAGE2_CREATION
  -> Journey 打开 DELIVERY_EVIDENCE_DECISION
  -> Admin 人工“通过证据”
  -> AUTHORITATIVE_ACTIVATION
  -> Order ACTIVE
  -> Delivery DELIVERED
  -> Vehicle LEASED
  -> Lease ACTIVE
  -> Journey COMPLETED
```

## 6. 并发、错误与审计

- 收敛逻辑使用数据库事务和当前项目既有的串行化/锁定模式，所有判断在锁内重新读取。
- manifest 必须从服务端当前证据计算，禁止接受客户端 hash 作为事实来源。
- `HANDOVER_EVIDENCE_READY` 使用 work-order ID 与 manifest hash 派生稳定事件键。
- 如果证据在复核前发生替换，旧 manifest 不得继续生效，必须由现有驳回/重提机制形成新版本。
- 完整归档校验失败时不推进工单或 Journey。
- 收敛事件使用 `SYSTEM` actor；人工复核仍保留实际操作人、权限和审计记录。
- 当前订单的旧印章仅作为验收备注，不触发重签、替换 PDF 或修改归档哈希。

## 7. 测试与验收

### 7.1 自动化测试

1. 归档成功后会把 `CUSTOMER_CONFIRMED` 工单收敛为 `OPS_REVIEW_PENDING` 并记录一次证据就绪信号。
2. 已归档结果再次重试时仍会执行收敛，但不重复创建事件或任务。
3. handover 缺文件、对象键或 SHA-256 时拒绝推进。
4. 取消、作废、失败、客户异议工单拒绝推进。
5. 正常 archive worker 与后台 archive retry 都调用同一收敛入口。
6. 有界补偿只选择满足严格条件的记录，并能恢复已归档存量订单。
7. Journey 收到信号后生成且仅生成一个 `DELIVERY_EVIDENCE_DECISION` ManualTask。
8. 人工批准后，现有激活测试继续证明 Order、Delivery、Vehicle、Lease、BillingSchedule 与 Journey 一致完成。

### 7.2 Staging 人工验收

1. 发布后等待补偿 worker 处理订单 `ORD20260814085019DMGZ`。
2. Admin 订单页 Golden Path 显示“交付证据复核 · 等待人工”，出现“通过证据 / 驳回证据”。
3. 人工核对精确 manifest 后点击“通过证据”。
4. 刷新确认 Journey 为 `COMPLETED`。
5. 核对：
   - Order=`ACTIVE`；
   - Delivery=`DELIVERED`；
   - Vehicle=`LEASED`；
   - Lease=`ACTIVE`；
   - BillingSchedule 已激活；
   - 三类 ManualTask 各且仅一条；
   - 没有新增 PaymentMandate 或 DebitAttempt。

## 8. 发布与回滚

- 本轮不含数据库迁移。
- 发布前运行 Prisma 状态、聚焦测试、API 全量测试、lint、typecheck 和 build。
- 若补偿查询或收敛产生异常，停止新代码部署并回滚 API 镜像；已归档文件保持不变。
- 不通过 SQL 删除或改写 Journey、ManualTask、handover 或归档文件记录。
