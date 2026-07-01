# Fleet Ops OS 下一阶段 Agents 说明（agents.md）

生成日期：2026-07-01  
用途：定义下一阶段由 Codex / Copilot / 人工 reviewer 协作时的角色、职责、边界和交付物。

---

## 1. 总原则

所有 agents 都必须遵守以下规则：

- 以方案 A 为边界：在现有系统上新增 Fleet Ops 逻辑层。
- 不修改 schema，不新增 migration。
- 默认只读，不写核心业务表。
- 不替换现有 `OrderService`、`FinanceService`、`ReportService`、`LeaseActivationEngine`。
- 所有输出必须可解释：evidence、confidence、warnings、conflicts。
- 优先执行顺序为：`PR-1 -> PR-2 -> PR-9 -> PR-3 -> PR-4`。
- PR-6 / PR-7 / PR-8 必须等核心状态、时间线、KPI、风险引擎稳定后再做。

---

## 2. Agent 列表

## 2.1 Architecture Steward Agent

**使命**：维护 Fleet Ops OS 的分层边界和依赖方向。

**关注文件**：

- `apps/api/src/fleet-ops/**`
- `apps/api/src/app.module.ts`
- `apps/api/src/report/report.service.ts`
- `apps/api/src/finance/finance.service.ts`
- `apps/api/src/order/order.service.ts`
- `apps/api/src/lease/lease-activation.engine.ts`

**允许做**：

- 规划模块结构。
- 定义 contracts / invariants。
- 审查层间依赖。
- 指出需要保留兼容的既有服务。

**禁止做**：

- 直接重写现有业务写流程。
- 把 Fleet Ops 状态作为 source of truth 回写 `Vehicle.status`。
- 提前引入 PR-8 agent coordination。

**输出**：

- Architecture decision notes。
- Layer dependency map。
- PR scope guardrails。

---

## 2.2 Schema Guardian Agent

**使命**：保护 no schema changes 约束。

**允许做**：

- 扫描 schema diff。
- 扫描 migration 文件。
- 扫描 Prisma 写操作。
- 编写只读扫描测试。

**禁止做**：

- 修改 `schema.prisma`。
- 生成 migration。
- 新增表承载 Fleet Ops event / policy / agent output。

**输出**：

```text
Schema status: PASS / FAIL
Migration status: PASS / FAIL
Forbidden write pattern status: PASS / FAIL
```

---

## 2.3 Fleet State Agent（PR-1）

**使命**：实现 Vehicle Operational State Engine。

**职责**：

- 读取 `Vehicle`、`Lease`、`SubscriptionOrder`、`ServiceCase`、`VehicleConditionReport`。
- 输出 computed state、priority reason、evidence、confidence、conflicts、warnings。
- 实现 deterministic resolver。

**拥有目录**：

```text
apps/api/src/fleet-ops/state/
```

**禁止做**：

- 写回 `Vehicle.status`。
- 调用 Lease activation。
- 调用 Order state transition。
- 依赖 PR-2 timeline 结果。

**完成标准**：

- `vehicle-operational-state.spec.ts` 通过。
- 至少覆盖 retired、active lease、open service case、order reserved、unknown data、conflicting signals。

---

## 2.4 Timeline Agent（PR-2）

**使命**：实现车辆级 canonical timeline。

**职责**：

- 聚合订单、租约、交付、还车、工单、车况、账单、审计事件。
- 时间排序、去重、保留来源证据。
- 标记 `UNKNOWN_GAP`。

**拥有目录**：

```text
apps/api/src/fleet-ops/timeline/
```

**禁止做**：

- 用 current state 伪造历史事实。
- 直接复用 PR-1 resolver 作为历史状态判断。
- 写入事件表。

**完成标准**：

- `vehicle-timeline.spec.ts` 通过。
- 同一输入输出稳定。
- 时间线覆盖请求范围或显式返回 gap/warnings。

---

## 2.5 Facade & Diagnostics Agent（PR-9 / PR-10）

**使命**：建立 Fleet Ops 统一入口、健康检查和不变量诊断。

**职责**：

- 实现 `FleetOpsFacade`。
- 实现 `FleetOpsHealthService`。
- 实现 `fleet-ops.invariants.ts`。
- 建立 read-only scan。

**拥有文件**：

```text
apps/api/src/fleet-ops/fleet-ops.module.ts
apps/api/src/fleet-ops/fleet-ops.facade.ts
apps/api/src/fleet-ops/fleet-ops.health.service.ts
apps/api/src/fleet-ops/fleet-ops.invariants.ts
apps/api/src/fleet-ops/fleet-ops.contracts.ts
apps/api/test/fleet-ops/*.spec.ts
```

**禁止做**：

- 在 Facade 中绕过底层 service 直接查大量业务表。
- 暴露 PR-5 执行动作。
- 初始化时触发重计算。

**完成标准**：

- Facade contract tests pass。
- Health service tests pass。
- Invariant tests pass。
- Read-only scan pass。

---

## 2.6 KPI / Economics Agent（PR-3）

**使命**：把 ReportService 中的资产收益与指标口径抽为可复用只读经济引擎。

**职责**：

- 计算 utilization、downtime rate、ROI、ROE、fleet IRR、cashflow。
- 区分实收、应收、押金、write-off。
- 接入 PR-1 状态和 PR-2 downtime/timeline。
- 保持现有 ReportService 输出兼容。

**拥有目录**：

```text
apps/api/src/fleet-ops/economics/
```

**禁止做**：

- 把 ReceivableBill 直接计为收入。
- 把 Deposit 计入经营收入。
- 修改支付回调或核销流程。

**完成标准**：

- `fleet-kpi.spec.ts` 通过。
- 对 ReportService 的兼容性测试通过或不变。

---

## 2.7 Collection Risk Agent（PR-4）

**使命**：建立只读 collection intelligence。

**职责**：

- 基于 `dueDate < asOfDate AND remainingAmount > 0 AND billStatus != CANCELLED` 识别逾期事实。
- 计算 D1-D5。
- 输出风险评分、策略建议、evidence、warnings。
- 不改变现有 FinanceService 催收写流程。

**拥有目录**：

```text
apps/api/src/fleet-ops/risk/
```

**禁止做**：

- 创建或关闭 `CollectionCase`。
- 修改账单状态。
- 依赖 refresh 后的 `BillStatus.OVERDUE` 作为唯一事实。

---

## 2.8 Guarded Action Plan Agent（PR-5）

**使命**：只读评估 action plan，不执行动作。

**职责**：

- 实现 `canAllocateVehicle`、`canActivateLease`、`canProceedWithOrder` 的只读建议版。
- 输出 `ALLOW / WARN / BLOCK`、reasons、evidence。

**禁止做**：

- 调用实际 allocation / activation / order transition 写路径。
- 写 audit log，除非未来明确执行层启用。

---

## 2.9 Advisory Agent（PR-6）

**使命**：在 PR-1~PR-4 稳定后生成优化建议。

**职责**：

- utilization improvement。
- revenue leakage detection。
- downtime reduction suggestion。
- collection prioritization suggestion。

**禁止做**：

- 自动执行建议。
- 绕过 PR-4 risk/control。

---

## 2.10 Governance Agent（PR-7）

**使命**：建立 Fleet policy registry 和政策评估框架。

**职责**：

- 定义政策目录、版本、适用范围。
- 对接押金规则、签约政策、折旧政策。
- 输出建议，不修改 live policy。

---

## 2.11 Coordination Agent（PR-8，延后）

**使命**：只在 PR-1~PR-7 稳定后定义 agent context 和协调协议。

**职责**：

- 定义 agent input/output contract。
- 聚合只读 insight。
- 不做自动决策。

**禁止做**：

- 提前实现多 agent 黑盒编排。
- 引入动态 agent 创建。
- 写入 agent memory 表。

---

## 3. Codex 三段式工作流

每个 PR 必须按以下方式执行：

### 3.1 PLAN

Codex 只输出：

- 文件结构。
- 数据来源。
- 计算规则。
- 依赖边界。
- 测试计划。
- 风险点。

禁止写代码。

### 3.2 BUILD

Codex 根据 PLAN 实现：

- 生产文件。
- 测试文件。
- README / notes。

禁止扩大 scope。

### 3.3 VERIFY

Codex 自查：

- schema diff。
- 写操作扫描。
- dependency direction。
- typecheck / lint / tests。
- edge cases。

---

## 4. Handoff 矩阵

| From | To | Handoff 内容 |
|---|---|---|
| Architecture Steward | Fleet State Agent | 状态优先级、证据链、置信度规则 |
| Fleet State Agent | Timeline Agent | 状态事件解释边界；不得复用 snapshot 作为历史事实 |
| Timeline Agent | Facade Agent | timeline contract、gap/warning contract |
| State + Timeline | KPI Agent | downtime、leased days、operating days、UNKNOWN_GAP |
| KPI Agent | Collection Risk Agent | vehicle exposure、utilization loss、overdue ratio |
| Collection Risk Agent | Guarded Action Plan Agent | risk summary、block reasons、collection level |
| All P0/P1 Agents | Release Readiness Agent | tests、read-only scan、invariants、docs |

---

## 5. Reviewer Checklist

每次 PR review 至少确认：

```text
[ ] 是否修改 schema / migration
[ ] 是否引入 DB write path
[ ] 是否绕过 FleetOpsFacade
[ ] 是否替换现有业务写流程
[ ] 是否输出 evidence / confidence / warnings
[ ] 是否包含冲突测试
[ ] 是否包含只读扫描
[ ] 是否保留 ReportService / FinanceService 兼容
[ ] 是否按优先级推进，没有提前做 PR-8
```
