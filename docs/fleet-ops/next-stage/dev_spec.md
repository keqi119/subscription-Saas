# Fleet Ops OS 下一阶段开发规格（dev_spec.md）

生成日期：2026-07-01  
适用仓库：`D:/Projects/auto-subscription-platform`  
适用策略：方案 A —— 在现有系统上新增 Fleet Ops 逻辑层，不改 schema，不替换现有业务写流程。

---

## 1. 背景与判断

本阶段必须以当前审查结论为事实基线：现有系统已经具备 `Order / Lease / Vehicle / Finance / Report / ServiceCase` 等业务底座，但 Fleet Ops OS 的 PR-1 到 PR-10 能力目前仍未独立形成引擎层，多数能力散落在既有服务中。下一阶段不是继续设计更高级自治层，而是把现有能力抽象为 **只读、可解释、可诊断、可复用** 的 Fleet Ops 引擎。

方案 A 的核心约束继续保留：复用现有 `Vehicle`、`Lease`、`SubscriptionOrder`、`ReceivableBill`、`CollectionCase`、`VehicleDepreciation*`、`FinancingInstrumentVehicle` 等模型，不新增 schema，不新建独立 bounded context，不把 Fleet Ops 做成纯 BI 层。

---

## 2. 下一阶段目标

### 2.1 总目标

建立 Fleet Ops OS v1 的只读核心底座，先解决：

1. 车辆状态可信：`Vehicle.status` 与 Lease / Order / ServiceCase / ConditionReport 冲突时有优先级、证据链、置信度。
2. 车辆历史可追溯：按车辆聚合订单、租约、交付、还车、工单、车况、账单、审计事件，形成 canonical timeline。
3. 跨模块可诊断：用 Fleet Facade、Health、Invariant diagnostics 统一暴露只读能力。
4. 指标可复用：把 ReportService 内的资产收益、利用率、ROA/ROE、折旧、残值、BaaS、资金占用逻辑抽出为经济引擎，但保持现有报表兼容。
5. 催收风险可重算：不依赖刷新后的 `BillStatus.OVERDUE`，基于 `dueDate + remainingAmount` 做只读逾期事实识别。

### 2.2 阶段优先级

| 优先级 | PR / 模块 | 目标 | 是否允许写库 |
|---|---|---|---|
| P0 | PR-1 Vehicle Operational State Engine | 只读状态解释、证据链、置信度、冲突列表 | 否 |
| P0 | PR-2 Timeline / Digital Twin Engine | 只读车辆事件时间线、去重、排序、来源证据 | 否 |
| P0 | PR-9 Fleet Facade + Invariants | 统一只读 Facade、Health、Invariant diagnostics | 否 |
| P1 | PR-3 KPI / Economic Engine | 从 ReportService 抽出可复用指标口径，保留兼容 | 否 |
| P1 | PR-4 Collection Intelligence | 只读逾期识别、D1-D5 策略建议、风险评分 | 否 |
| P1/P2 | PR-5 Guarded Action Plan | 只输出动作建议和阻断原因，不执行写入 | 否 |
| P2 | PR-6 Advisory Optimization | 基于 PR-1~PR-4 输出生成可解释建议 | 否 |
| P2 | PR-7 Governance / Policy Registry | 政策目录、版本、适用范围、审计设计 | 否 |
| P3 | PR-8 Agent Coordination | 只读 agent context 和编排协议，底层稳定后再做 | 否 |
| 持续 | PR-10 Release Readiness | 专项测试、smoke、diagnostic checklist | 否 |

---

## 3. 严格边界

### 3.1 必须遵守

- 不修改 `schema.prisma`。
- 不新增 migration。
- 不写入核心业务表。
- 不替换 `OrderService`、`FinanceService`、`ReportService`、`LeaseActivationEngine` 的既有写流程。
- Fleet Ops 引擎默认只读，只做 interpretation / aggregation / diagnostics / recommendation。
- 所有计算结果必须包含 evidence 或 source references。
- 所有高风险判断必须包含 confidence 和 warnings。
- 所有跨实体冲突必须显式输出，不允许吞掉冲突。

### 3.2 明确不做

- 不做独立 Fleet Ops 新表。
- 不接 GPS 实时流。
- 不启用自动车辆分配、自动催收、自动维修执行。
- 不做生产部署自动化。
- 不把 PR-6 / PR-8 提前做成黑盒 AI 决策系统。

---

## 4. 推荐目录结构

```text
apps/api/src/fleet-ops/
  fleet-ops.module.ts
  fleet-ops.facade.ts
  fleet-ops.health.service.ts
  fleet-ops.invariants.ts
  fleet-ops.contracts.ts
  fleet-ops.errors.ts

  state/
    vehicle-operational-state.types.ts
    vehicle-operational-state.rules.ts
    vehicle-operational-state.resolver.ts
    vehicle-operational-state.confidence.ts
    vehicle-operational-state.repository.ts
    vehicle-operational-state.service.ts

  timeline/
    vehicle-timeline.types.ts
    vehicle-timeline.event-builder.ts
    vehicle-timeline.normalizer.ts
    vehicle-timeline.resolver.ts
    vehicle-timeline.service.ts

  economics/
    fleet-kpi.types.ts
    fleet-kpi.service.ts
    fleet-kpi.calculator.ts
    revenue-attribution.model.ts
    cost-allocation.model.ts
    downtime-cost.model.ts
    cashflow.model.ts

  risk/
    fleet-risk.types.ts
    overdue-detector.model.ts
    collection-priority.model.ts
    risk-score.model.ts
    arrears-pipeline.model.ts
    fleet-risk.service.ts

  guarded-actions/
    guarded-action-plan.types.ts
    guarded-action-plan.evaluator.ts
    vehicle-allocation.guard.ts
    lease-activation.guard.ts
    order-transition.guard.ts

  advisory/
    fleet-advisory.types.ts
    fleet-advisory.service.ts

  governance/
    fleet-policy.types.ts
    fleet-policy-registry.ts
    fleet-policy-evaluator.ts

apps/api/test/fleet-ops/
  vehicle-operational-state.spec.ts
  vehicle-timeline.spec.ts
  fleet-ops.facade.spec.ts
  fleet-ops.invariants.spec.ts
  fleet-ops.readonly.spec.ts
  fleet-kpi.spec.ts
  fleet-risk.spec.ts
```

---

## 5. 核心引擎规格

## 5.1 PR-1 Vehicle Operational State Engine

### 目标

把当前车辆状态从“单字段状态”升级为“可解释运营状态”。

### 输入实体

- `Vehicle`
- `Lease`
- `SubscriptionOrder`
- `ServiceCase`
- `VehicleConditionReport`

### 输出契约

```ts
export interface VehicleOperationalStateResult {
  vehicleId: string;
  computedState:
    | 'RETIRED'
    | 'LEASED'
    | 'MAINTENANCE'
    | 'RESERVED'
    | 'REVIEW_RESERVED'
    | 'AVAILABLE'
    | 'IN_PREPARATION'
    | 'UNKNOWN';
  priorityReason: string;
  confidence: number; // 0-100
  confidenceBand: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  primaryEvidence: FleetEvidence;
  supportingEvidence: FleetEvidence[];
  conflicts: FleetConflict[];
  warnings: string[];
  asOf: string;
}
```

### 状态优先级

```text
RETIRED > LEASED > MAINTENANCE > RESERVED > REVIEW_RESERVED > AVAILABLE > IN_PREPARATION > UNKNOWN
```

### 验收

- 任意 `vehicleId` 可输出可解释状态。
- Resolver 是纯函数。
- Repository 只用 read query。
- 冲突不隐藏。
- 测试覆盖 retired vs active lease、available vs open service case、missing related data、multiple active-like orders。

---

## 5.2 PR-2 Timeline / Digital Twin Engine

### 目标

建立车辆级 canonical timeline，作为利用率、停运、收益归因、风险识别的共同底座。

### 输入事件来源

- 订单创建、评审、取消、交付、还车。
- Lease 激活、结束、异常。
- ServiceCase 创建、状态变更、关闭。
- VehicleConditionReport。
- ReceivableBill due / overdue / write-off 事实。
- AuditLog / Delivery / Return 相关现有事件。

### 输出契约

```ts
export interface VehicleTimelineEvent {
  vehicleId: string;
  eventId: string;
  occurredAt: string;
  eventType:
    | 'ORDER_CREATED'
    | 'ORDER_RESERVED'
    | 'DELIVERED'
    | 'LEASE_ACTIVATED'
    | 'RETURNED'
    | 'SERVICE_OPENED'
    | 'SERVICE_CLOSED'
    | 'CONDITION_REPORTED'
    | 'BILL_DUE'
    | 'PAYMENT_RECEIVED'
    | 'UNKNOWN_GAP';
  sourceEntity: string;
  sourceId: string;
  evidence: FleetEvidence[];
  confidence: number;
  warnings: string[];
}
```

### 必须行为

- 按时间排序。
- 同源事件去重。
- 事件保留 source entity 和 source id。
- 对缺失交付/还车/工单闭环形成 `UNKNOWN_GAP` 或 warnings。
- 不把 current state 倒灌成历史事实。

---

## 5.3 PR-9 Fleet Facade + Invariants

### 目标

在 P0 阶段就建立统一入口，避免后续各模块被外部直接调用。

### Facade 方法

```ts
getVehicleOperationalState(vehicleId: string, asOf?: Date)
getVehicleTimeline(vehicleId: string, range: DateRange)
getVehicleFleetSummary(vehicleId: string, range: DateRange)
getFleetDiagnostics(range?: DateRange)
getFleetInvariantReport(range?: DateRange)
```

### Invariants

- Fleet Ops 不写库。
- State resolver 不依赖 Timeline resolver。
- Timeline 不调用 ReportService 写流程。
- KPI 引擎不把押金计入经营收入。
- Collection Intelligence 不依赖 `BillStatus.OVERDUE` 作为唯一事实。
- GuardedActionPlan 不执行动作。

---

## 5.4 PR-3 KPI / Economic Engine

### 目标

从 ReportService 中抽出可复用经济指标层，保留原报表兼容。

### 指标

- utilization rate = `leasedDays / operatingDays`
- downtime rate = `downtimeVehicleDays / operatingVehicleDays`
- ROI per vehicle = `periodNetReturn / investedCapital`
- ROE per vehicle = `platformNetIncomeAmount / roeEquityBaseAmount`
- fleet IRR = 单车现金流合并 XIRR
- overdue ratio = `overdueRemainingAmount / totalOutstandingReceivableAmount`

### 财务口径

- 收入：租金实收、损伤赔付、其他已核销收入。
- 押金：单列，不进经营收入。
- 计划现金流：`ReceivableBill.dueDate`。
- 实际现金流：`PaymentRecord.receivedAt` + write-off facts。
- 折旧：优先 `VehicleDepreciationRecord CONFIRMED / LOCKED`，无 active policy 时 fallback。

---

## 5.5 PR-4 Collection Intelligence

### 目标

在现有 Finance/Collection 写流程之外，建立只读逾期事实、风险评分和策略建议。

### Overdue fact rule

```text
dueDate < asOfDate AND remainingAmount > 0 AND billStatus != CANCELLED
```

### Collection level

| Level | 条件 | 建议 |
|---|---|---|
| D1 | 1-3 天 | 自动提醒，账单解释 |
| D2 | 4-7 天 | 人工电话，承诺还款 |
| D3 | 8-15 天 | 风险升级，限制新订单/交付建议 |
| D4 | 16-30 天 | 正式通知，车辆处置预案建议 |
| D5 | 30 天以上 | 法务、终止、车辆追回流程建议 |

### 输出

```ts
export interface CollectionRiskSummary {
  customerId: string;
  vehicleId?: string;
  overdueDays: number;
  overdueRemainingAmount: number;
  collectionLevel: 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'NONE';
  riskScore: number;
  suggestedStrategy: string;
  evidence: FleetEvidence[];
  warnings: string[];
}
```

---

## 6. 通用类型

```ts
export interface FleetEvidence {
  source: 'Vehicle' | 'Lease' | 'SubscriptionOrder' | 'ServiceCase' | 'VehicleConditionReport' | 'ReceivableBill' | 'PaymentRecord' | 'ReportService' | 'FinanceService' | 'AuditLog';
  sourceId: string;
  field?: string;
  value?: unknown;
  observedAt?: string;
  note?: string;
}

export interface FleetConflict {
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  winningSignal: string;
  suppressedSignal: string;
  evidence: FleetEvidence[];
}

export interface DateRange {
  from: Date;
  to: Date;
}
```

---

## 7. 测试要求

每个 PR 必须包含：

1. 单元测试：resolver / calculator / model 层。
2. 集成测试：service + mocked repository。
3. 只读扫描：禁止 `.create(`、`.update(`、`.delete(`、`.upsert(`、`$executeRaw`、`$queryRawUnsafe`。
4. schema diff 检查：`schema.prisma` 不变。
5. Regression command 写入 PR 描述。
6. README 或模块注释说明边界。

---

## 8. Definition of Done

一个 Fleet Ops PR 只有同时满足以下条件才算完成：

- Typecheck pass。
- Lint pass。
- 对应测试 pass。
- 没有 schema 变化。
- 没有 DB 写入路径。
- 输出包含 evidence / confidence / warnings。
- 不破坏既有 Order / Lease / Finance / Report 流程。
- PR 描述包含：目标、范围、改动文件、只读保证、测试结果、已知风险、rollback plan。

---

## 9. 建议执行顺序

```text
Step 0: Repository survey and module skeleton plan
Step 1: PR-1 Vehicle Operational State Engine
Step 2: PR-2 Vehicle Timeline / Digital Twin Engine
Step 3: PR-9 Fleet Facade + Health + Invariants
Step 4: PR-10 baseline tests and release diagnostics for P0
Step 5: PR-3 KPI / Economic Engine extraction
Step 6: PR-4 Collection Intelligence
Step 7: PR-5 GuardedActionPlan evaluator
Step 8: PR-6 Advisory + PR-7 Policy Registry
Step 9: PR-8 Agent Coordination protocol only
```

---

## 10. 交付建议

下一阶段不要一次性要求 Codex 实现 PR-1 到 PR-10。应使用三段式：

```text
PLAN -> BUILD -> VERIFY
```

每个 PR 独立提交，先做 P0，再做 P1。PR-8 必须延后，避免在底层状态、时间线、KPI、政策未稳定时引入 agent 编排复杂度。
