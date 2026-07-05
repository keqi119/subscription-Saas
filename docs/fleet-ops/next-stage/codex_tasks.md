# Fleet Ops OS 下一阶段 Codex 任务包（codex_tasks.md）

生成日期：2026-07-01  
执行方式：每个任务按 `PLAN -> BUILD -> VERIFY` 三段式执行。  
事实基线：当前代码尚未形成独立 Fleet Ops OS 引擎层，下一阶段优先从只读引擎抽象开始。

---

## 0. 全局 Codex 约束

每个任务开头都必须附带：


All Codex tasks must read `docs/fleet-ops/next-stage/codex_workflow_rules.md` before branch prep, build, verify, recovery, or local commit work. Branch policy, approved file lists, EOL checks, explicit-path staging, and human-only push / PR / merge rules must follow that document.

P1-H7 and later Fleet Ops BUILD, VERIFY, LOCAL_COMMIT, and release-readiness tasks should use the canonical Fleet Ops release candidate gate instead of broad package test narrowing:

```bash
pnpm --filter @subscription-saas/api test:fleet-ops
```

Codex must still run `pnpm --filter @subscription-saas/api typecheck`, `pnpm --filter @subscription-saas/api lint`, task-specific focused tests when a task requires narrower validation, and pre-commit diff/safety checks.

Do not use this as the Fleet Ops release candidate gate:

```bash
pnpm --filter @subscription-saas/api test -- fleet-ops
```

Package test argument narrowing has been unreliable in this repository and can run an unintended test set.

The canonical command is test-only readiness coverage. It must not be used to justify schema changes, DB writes, PR-1 to PR-5 logic rewrites, controller exposure, or remote push / PR / merge actions by Codex.

```text
You are working in a production TypeScript + NestJS backend repository.

GLOBAL CONSTRAINTS:
- DO NOT modify database schema.
- DO NOT add migrations.
- DO NOT write to database unless explicitly allowed. For current Fleet Ops tasks, writes are NOT allowed.
- DO NOT replace existing Order / Lease / Finance / Report write flows.
- Build read-only Fleet Ops logic layers on top of existing models and services.
- Every output must be explainable with evidence, confidence, warnings, and conflicts where applicable.
- Keep changes small and PR-scoped.
```

---

## Task 00 — Repository Survey & P0 Plan

### 目标

在写代码前确认现有模型、服务、测试工具、模块注册方式，生成 P0 实施计划。

### PLAN Prompt

```text
TASK: Fleet Ops OS Task 00 - Repository Survey and P0 Implementation Plan

MODE: PLAN ONLY. Do not write code or modify files.

Inspect the repository structure and identify:
1. Existing module registration pattern in app.module.ts.
2. Existing Prisma service / repository usage pattern.
3. Existing test framework and test file conventions.
4. Available entities and services for Vehicle, Lease, SubscriptionOrder, ServiceCase, VehicleConditionReport, ReceivableBill, PaymentRecord.
5. Best location for apps/api/src/fleet-ops.
6. P0 implementation order for PR-1, PR-2, PR-9, and PR-10 baseline diagnostics.

Output:
- repo findings
- proposed file structure
- risks
- exact BUILD tasks for PR-1

Do not change files.
```

### 验收

- 输出不包含代码 diff。
- 明确 P0 文件结构。
- 明确可复用现有 service / prisma 模式。

---

## Task 01 — PR-1 Vehicle Operational State Engine

### 目标

实现只读车辆运营状态引擎。

### PLAN Prompt

```text
TASK: Fleet Ops OS PR-1 - Vehicle Operational State Engine

MODE: PLAN ONLY. Do not write code.

Design a read-only vehicle operational state engine using only:
- Vehicle
- Lease
- SubscriptionOrder
- ServiceCase
- VehicleConditionReport

Required layers:
- types
- rules
- resolver
- confidence
- repository
- service

Output:
1. Exact files to create.
2. Data loading strategy.
3. Deterministic state priority:
   RETIRED > LEASED > MAINTENANCE > RESERVED > REVIEW_RESERVED > AVAILABLE > IN_PREPARATION > UNKNOWN
4. Evidence and conflict model.
5. Confidence scoring model.
6. Test cases.
7. Read-only safety checks.

Strictly no code.
```

### BUILD Prompt

```text
TASK: Fleet Ops OS PR-1 - Vehicle Operational State Engine

MODE: BUILD.

Implement the PR-1 plan exactly.

Create files under:
apps/api/src/fleet-ops/state/

Required files:
- vehicle-operational-state.types.ts
- vehicle-operational-state.rules.ts
- vehicle-operational-state.resolver.ts
- vehicle-operational-state.confidence.ts
- vehicle-operational-state.repository.ts
- vehicle-operational-state.service.ts

Create test:
apps/api/test/fleet-ops/vehicle-operational-state.spec.ts

Rules:
- Read-only only.
- Repository may only load data.
- Resolver must be pure and deterministic.
- Output must include state, priorityReason, evidence, confidence, conflicts, warnings.
- Do not modify Vehicle.status.
- Do not call lease activation or order transition.
```

### VERIFY Prompt

```text
TASK: Fleet Ops OS PR-1 - Verification

Check:
1. No schema changes.
2. No database writes.
3. No mutation of source entities.
4. Resolver deterministic.
5. Evidence/confidence/conflicts present.
6. Tests cover retired vs active lease, available vs service case, reservation, unknown, and conflicts.

Run or report commands:
- pnpm --filter @subscription-saas/api typecheck
- pnpm --filter @subscription-saas/api lint
- pnpm --filter @subscription-saas/api test -- vehicle-operational-state.spec.ts
```

---

## Task 02 — PR-2 Vehicle Timeline / Digital Twin Engine

### 目标

实现只读车辆 canonical timeline aggregator。

### PLAN Prompt

```text
TASK: Fleet Ops OS PR-2 - Vehicle Timeline / Digital Twin Engine

MODE: PLAN ONLY. Do not write code.

Design a read-only vehicle timeline engine that aggregates existing data into canonical events.

Sources:
- Vehicle
- Lease
- SubscriptionOrder
- VehicleDelivery / return data if available
- ServiceCase
- VehicleConditionReport
- ReceivableBill
- PaymentRecord if safely linkable
- AuditLog if available

Output must include:
- eventId
- vehicleId
- occurredAt
- eventType
- sourceEntity
- sourceId
- evidence
- confidence
- warnings

Rules:
- Sort chronologically.
- Deduplicate same source event.
- Keep source evidence.
- Mark UNKNOWN_GAP for missing lifecycle evidence.
- Do not infer historical truth from current Vehicle.status.

Output file plan, event taxonomy, gap rules, test cases.
```

### BUILD Prompt

```text
TASK: Fleet Ops OS PR-2 - Vehicle Timeline / Digital Twin Engine

MODE: BUILD.

Implement the PR-2 plan under:
apps/api/src/fleet-ops/timeline/

Required files:
- vehicle-timeline.types.ts
- vehicle-timeline.event-builder.ts
- vehicle-timeline.normalizer.ts
- vehicle-timeline.resolver.ts
- vehicle-timeline.service.ts

Test file:
apps/api/test/fleet-ops/vehicle-timeline.spec.ts

Rules:
- Read-only only.
- No new event table.
- No writes.
- Keep source entity/source id.
- Timeline must be deterministic for same input.
```

### VERIFY Prompt

```text
TASK: Fleet Ops OS PR-2 - Verification

Check:
1. No schema changes.
2. No database writes.
3. Timeline events are source-backed.
4. Sorting is stable.
5. Deduplication is deterministic.
6. UNKNOWN_GAP or warnings appear for missing lifecycle evidence.
7. Tests cover overlapping events, missing dates, duplicate source events, service case timeline, order/lease lifecycle.
```

---

## Task 03 — PR-9 Fleet Facade + Health + Invariants

### 目标

P0 阶段提前建立统一只读集成面和诊断能力。

### PLAN Prompt

```text
TASK: Fleet Ops OS PR-9 - Fleet Facade + Health + Invariants

MODE: PLAN ONLY. Do not write code.

Design a read-only Fleet Ops integration boundary.

Required files:
- fleet-ops.module.ts
- fleet-ops.facade.ts
- fleet-ops.health.service.ts
- fleet-ops.contracts.ts
- fleet-ops.errors.ts
- fleet-ops.invariants.ts

Facade methods:
- getVehicleOperationalState(vehicleId, asOf?)
- getVehicleTimeline(vehicleId, range)
- getVehicleFleetSummary(vehicleId, range)
- getFleetDiagnostics(range?)
- getFleetInvariantReport(range?)

Invariants:
- Fleet Ops modules do not write DB.
- PR-1 resolver deterministic.
- PR-2 timeline source-backed.
- PR-3 must not count deposit as revenue when implemented.
- PR-4 must not rely only on BillStatus.OVERDUE when implemented.
- PR-5 must not execute actions when implemented.

Output exact plan, contracts, tests.
```

### BUILD Prompt

```text
TASK: Fleet Ops OS PR-9 - Fleet Facade + Health + Invariants

MODE: BUILD.

Implement the facade and diagnostics layer under:
apps/api/src/fleet-ops/

Required files:
- fleet-ops.module.ts
- fleet-ops.facade.ts
- fleet-ops.health.service.ts
- fleet-ops.contracts.ts
- fleet-ops.errors.ts
- fleet-ops.invariants.ts

Tests:
- apps/api/test/fleet-ops/fleet-ops.facade.spec.ts
- apps/api/test/fleet-ops/fleet-ops.invariants.spec.ts
- apps/api/test/fleet-ops/fleet-ops.readonly.spec.ts

Rules:
- Facade only orchestrates read-only engines.
- Health service must not trigger heavy recomputation.
- Do not expose public API controller in this PR.
- Do not call PR-5 execution paths.
```

### VERIFY Prompt

```text
TASK: Fleet Ops OS PR-9 - Verification

Check:
1. FleetOpsModule compiles.
2. FleetOpsFacade is injectable.
3. Health service returns state/timeline readiness.
4. Invariant tests pass.
5. Read-only scan covers apps/api/src/fleet-ops.
6. No schema changes.
```

---

## Task 04 — PR-10 P0 Release Readiness Baseline

### 目标

从 P0 开始建立专项测试、smoke、diagnostics 文档，避免后续堆功能后无法上线。

### Prompt

```text
TASK: Fleet Ops OS PR-10 Baseline - Release Readiness for P0

Implement release readiness artifacts for the current Fleet Ops P0 modules.

Add:
- apps/api/src/fleet-ops/fleet-ops.diagnostics.ts
- apps/api/src/fleet-ops/fleet-ops.observability.ts
- apps/api/src/fleet-ops/fleet-ops.readme.md
- apps/api/src/fleet-ops/fleet-ops.release-checklist.md
- apps/api/test/fleet-ops/fleet-ops.bootstrap.spec.ts
- apps/api/test/fleet-ops/fleet-ops.observability.spec.ts

Rules:
- No new intelligence layer.
- No DB writes.
- No public API exposure.
- No execution path.
- Document commands for PR-1/PR-2/PR-9 tests.
```

---

## Task 05 — PR-3 KPI / Economic Engine Extraction

### 目标

从 ReportService 抽出可复用经济引擎，但保持现有报表输出兼容。

### PLAN Prompt

```text
TASK: Fleet Ops OS PR-3 - KPI / Economic Engine Extraction

MODE: PLAN ONLY.

Inspect ReportService KPI / asset income / utilization / ROA / ROE / depreciation / residual / BaaS / capital occupation logic.

Design a read-only Fleet KPI engine under:
apps/api/src/fleet-ops/economics/

Must support:
- utilization rate
- downtime rate
- ROI per vehicle
- ROE per vehicle
- fleet IRR or placeholder calculator with explicit limitation
- planned vs actual cashflow
- depreciation and cost allocation

Financial rules:
- ReceivableBill is planned cashflow, not realized revenue.
- PaymentRecord / write-off facts drive actual cashflow.
- Deposit is not operating revenue.
- Fleet ROI aggregation must be weighted, not simple average.

Do not write code.
```

### BUILD Prompt

```text
TASK: Fleet Ops OS PR-3 - KPI / Economic Engine Extraction

MODE: BUILD.

Implement economics module under:
apps/api/src/fleet-ops/economics/

Required files:
- fleet-kpi.types.ts
- fleet-kpi.service.ts
- fleet-kpi.calculator.ts
- revenue-attribution.model.ts
- cost-allocation.model.ts
- downtime-cost.model.ts
- cashflow.model.ts

Test:
apps/api/test/fleet-ops/fleet-kpi.spec.ts

Rules:
- Do not break ReportService behavior.
- Do not modify payment callbacks.
- Do not count deposit as revenue.
- Do not count receivables as actual revenue.
- Consume PR-1/PR-2 outputs where available.
```

---

## Task 06 — PR-4 Collection Intelligence

### 目标

建立只读逾期风险识别和催收策略建议。

### PLAN Prompt

```text
TASK: Fleet Ops OS PR-4 - Collection Intelligence

MODE: PLAN ONLY.

Design a read-only collection risk engine under:
apps/api/src/fleet-ops/risk/

Use existing:
- ReceivableBill
- PaymentRecord
- CollectionCase
- CollectionAction
- Lease
- Vehicle
- Customer data if available

Overdue fact must be:
dueDate < asOfDate AND remainingAmount > 0 AND billStatus != CANCELLED

Do not rely only on BillStatus.OVERDUE.

Output:
- risk score
- D1-D5 collection level
- arrears pipeline summary
- suggested strategy
- evidence
- warnings

Do not modify existing FinanceService write flow.
```

### BUILD Prompt

```text
TASK: Fleet Ops OS PR-4 - Collection Intelligence

MODE: BUILD.

Implement under:
apps/api/src/fleet-ops/risk/

Required files:
- fleet-risk.types.ts
- overdue-detector.model.ts
- collection-priority.model.ts
- risk-score.model.ts
- arrears-pipeline.model.ts
- fleet-risk.service.ts

Test:
apps/api/test/fleet-ops/fleet-risk.spec.ts

Rules:
- Read-only only.
- No CollectionCase create/update.
- No ReceivableBill status update.
- No dependency on overdue refresh job as source of truth.
```

---

## Task 07 — PR-5 Guarded Action Plan Evaluator

### 目标

只输出动作建议，不执行动作。

### Prompt

```text
TASK: Fleet Ops OS PR-5 - Guarded Action Plan Evaluator

Build a read-only action planning layer under:
apps/api/src/fleet-ops/guarded-actions/

Required files:
- guarded-action-plan.types.ts
- guarded-action-plan.evaluator.ts
- vehicle-allocation.guard.ts
- lease-activation.guard.ts
- order-transition.guard.ts

Outputs:
{
  actionType,
  allowed,
  severity,
  reasons,
  evidence,
  requiredHumanReview
}

Rules:
- Do not execute actions.
- Do not call write-side services.
- Do not create audit logs.
- Use PR-1 state, PR-2 timeline, PR-4 risk where available.
```

---

## Task 08 — PR-6 Advisory Engine（延后到 P2）

### Prompt

```text
TASK: Fleet Ops OS PR-6 - Advisory Engine

Only start this after PR-1, PR-2, PR-3, and PR-4 are stable.

Build advisory recommendations under:
apps/api/src/fleet-ops/advisory/

Recommendations:
- idle reduction
- maintenance attention
- overdue risk attention
- revenue leakage review
- low ROI asset review

Rules:
- Recommendation only.
- No execution.
- Must include evidence, confidence, expected impact, warnings.
```

---

## Task 09 — PR-7 Policy Registry（延后到 P2）

### Prompt

```text
TASK: Fleet Ops OS PR-7 - Fleet Policy Registry

Build read-only policy registry under:
apps/api/src/fleet-ops/governance/

Use existing policy-like concepts:
- signing policy
- deposit rules
- depreciation policy
- collection level rules

Output:
- policy id
- version
- domain
- scope
- effective status
- source evidence
- warnings

Rules:
- Do not modify live policies.
- Do not create policy tables.
- Registry is logical/read-only only.
```

---

## Task 10 — PR-8 Coordination Protocol（P3，最后）

### Prompt

```text
TASK: Fleet Ops OS PR-8 - Coordination Protocol Only

Only start after PR-1 to PR-7 are stable.

Build only protocol and context definitions under:
apps/api/src/fleet-ops/coordination/

Do not build autonomous agent execution.

Required:
- agent-context.types.ts
- agent-output.types.ts
- coordination-contracts.ts
- coordination-readme.md

Rules:
- Read-only.
- No agent memory table.
- No dynamic agent execution.
- No override of PR-4 or PR-5.
```

---

## 11. Suggested PR Order

```text
PR-A0: Repository survey and P0 module skeleton plan
PR-A1: Vehicle Operational State Engine
PR-A2: Vehicle Timeline / Digital Twin Engine
PR-A3: Fleet Facade + Health + Invariants
PR-A4: P0 Release Readiness Baseline
PR-A5: KPI / Economic Engine Extraction
PR-A6: Collection Intelligence
PR-A7: Guarded Action Plan Evaluator
PR-A8: Advisory Engine
PR-A9: Policy Registry
PR-A10: Coordination Protocol
```

---

## 12. Per-PR Pull Request Template

```md
# Fleet Ops OS: <PR title>

## Objective

## Scope

## Files changed

## Read-only guarantee
- [ ] No schema changes
- [ ] No migrations
- [ ] No DB write paths
- [ ] No existing business flow replacement

## Evidence / Confidence / Warning behavior

## Tests
- [ ] typecheck
- [ ] lint
- [ ] focused tests
- [ ] read-only scan

## Risks

## Rollback plan
```

---

## 13. Fleet Ops Admin UI Read-Only Tasks

Fleet Ops admin UI tasks must keep backend business behavior unchanged and use the controlled P1-H8 API only.

Rules:
- Use the direct `/fleet-ops` admin route unless the task is the approved P1-H10 menu/permission provisioning pass.
- Use the existing web `apiFetch` pattern and define GET helpers only.
- Handle disabled API and `fleet_ops:read` permission-denied states before loading business data.
- Do not add execution controls, mutation controls, public/customer portal routes, shared menu changes, seed changes, or shared permission enum changes.
- Keep tests in the existing Vitest node setup; do not add jsdom, testing-library, or test environment changes for read-only helper coverage.
- Long-lived static guards must scan current source state, not encode PR-specific changed-file expectations.
- Do not commit reusable Fleet Ops safety tests that require one PR's approved diff list, such as shared permission/menu/seed files, to appear in every future working tree.
- PR-specific diff allowlists may be used only as task-local verification and must not become reusable guards.
- `apps/web/test/fleet-ops-readonly.spec.ts` must stay compatible with clean main, docs-only PRs, copy-only PRs, layout-only read-only PRs, and tests-only PRs.
- Positive Fleet Ops permission/menu/seed provisioning assertions belong in `apps/api/test/permissions.spec.ts` and `packages/shared/test/auth.spec.ts` / `packages/shared/test/menus.spec.ts`; the web readonly guard should only scan shared/provisioning sources for forbidden write/execution exposure.

Focused verification:

```bash
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts test/fleet-ops-readonly.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
```

## 14. Fleet Ops Controlled Menu Permission Tasks

P1-H10 is the only approved pass that provisions Fleet Ops in shared permissions, shared menus, and seed baseline data.

Rules:
- Add only `fleet_ops:read`; do not add Fleet Ops write, execute, admin, action, allocate, or collect permissions.
- Use Chinese visible menu wording. The approved label is `车队运营`.
- Place `/fleet-ops` under the existing vehicle/admin menu structure when available.
- Seed ADMIN through the existing all-access convention.
- Assign OP and GM only when seed conventions clearly show comparable internal vehicle/operations/management access.
- Do not assign Fleet Ops access to AS, FI, SA, RC, customer-like, or public roles in this pass.
- Do not modify Fleet Ops API/controller/facade logic, PR-1 to PR-5 logic, AppModule, schema, migrations, CI, root package scripts, or web test tooling.
- Keep push, PR creation, and merge human-only.

Focused verification:

```bash
pnpm --filter @subscription-saas/shared typecheck
pnpm --filter @subscription-saas/shared lint
pnpm --filter @subscription-saas/shared exec vitest run test/auth.spec.ts test/menus.spec.ts
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-view-model.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
```

## 15. Fleet Ops Existing DB Access Sync Tasks

P1-H10.1 is the approved repair path when an existing local or staging database was seeded before P1-H10 and an admin still lacks `fleet_ops:read` or the `/fleet-ops` / `车队运营` menu entry.

Rules:
- Fix the provisioning source of truth; do not bypass the frontend permission check.
- Use the narrow idempotent command `pnpm --filter @subscription-saas/api prisma:sync:fleet-ops-access`.
- The sync command may upsert only `fleet_ops:read`, `vehicles.fleet_ops` / `/fleet-ops`, and role links for `ADMIN`, `OP`, and `GM`.
- Do not run the broad seed as the H10.1 repair path unless a human explicitly requests it.
- Do not add Fleet Ops write, execute, admin, action, allocate, or collect permissions.
- Do not add execution submenus, mutation routes, customer/public portal menus, schema changes, migrations, AppModule changes, or Fleet Ops API/UI business logic changes.
- After syncing, require users to log out and log in so `/auth/me` reloads DB-backed permissions and menus.
- Keep push, PR creation, and merge human-only.

Focused verification:

```bash
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
```

## 16. Fleet Ops Staging Smoke Runbook Tasks

P1-H11 is a docs/runbook-only staging enablement task for the read-only Fleet Ops API and admin UI.

Rules:
- Keep the runbook at `docs/fleet-ops/runbooks/staging-smoke.md`.
- Document staging enablement with `FLEET_OPS_API_ENABLED=true`, but do not change the feature flag default.
- Document the existing access sync command for human/operator use only: `pnpm --filter @subscription-saas/api prisma:sync:fleet-ops-access`.
- Codex automated verification must not run the live DB access sync command.
- Do not modify Fleet Ops API/controller/facade/module logic, Fleet Ops UI behavior, frontend API clients, seed behavior, permissions, menus, schema, migrations, AppModule, package scripts, or CI.
- Do not add Fleet Ops write, execute, admin, action, allocate, or collect permissions.
- Do not add execution endpoints, mutation controls, customer/public routes, or production data mutation steps.
- Keep push, PR creation, and merge human-only.

Focused verification:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-view-model.spec.ts
```

## 17. Fleet Ops Production Readiness Checklist Tasks

P1-H14 is a docs/checklist-only task for preparing a later controlled production enablement decision.

Rules:
- Keep the runbook at `docs/fleet-ops/runbooks/production-readiness.md`.
- Do not enable production.
- Do not run live DB sync during Codex automated verification.
- Do not change the `FLEET_OPS_API_ENABLED` default.
- Do not modify Fleet Ops API/controller/facade/module logic, Fleet Ops UI behavior, frontend API clients, permission model, seed behavior, sync script behavior, schema, migrations, AppModule, package scripts, or CI.
- Do not add Fleet Ops write, execute, admin, action, allocate, or collect permissions.
- Do not add execution endpoints, mutation controls, customer/public routes, or production data mutation steps.
- Human operators own production access sync and feature flag enablement.
- Keep push, PR creation, and merge human-only.

Focused verification:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts
```

## 18. Fleet Ops Production GO / NO-GO Record Tasks

P1-H15 is a docs/record-only task for capturing a later human production decision.

Rules:
- Keep the record at `docs/fleet-ops/runbooks/production-go-no-go-record.md`.
- The default decision status must be `PENDING`.
- The record does not enable production and is not approval by itself.
- Do not run live DB sync during Codex automated verification.
- Do not change the `FLEET_OPS_API_ENABLED` default or enable the production feature flag.
- Do not modify Fleet Ops API/controller/facade/module logic, Fleet Ops UI behavior, frontend API clients, permission model, seed behavior, sync script behavior, schema, migrations, AppModule, package scripts, generic production docs, or CI.
- Do not add Fleet Ops write, execute, admin, action, allocate, or collect permissions.
- Do not add execution endpoints, mutation controls, customer/public routes, or production data mutation steps.
- GO / NO-GO / GO_WITH_LIMITATIONS decisions are human-owned and must include owners, rationale, rollback owner, communication owner, limitations, and follow-up items.
- Keep push, PR creation, and merge human-only.

Focused verification:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts
```

## 19. Fleet Ops Production Decision Record Completion Tasks

P1-H16 is a docs/record-only task for completing the production GO / NO-GO record baseline without making a production decision.

Rules:
- Known local/staging evidence from P1-H13 may be filled into `docs/fleet-ops/runbooks/production-go-no-go-record.md`.
- Production-specific fields must remain `TBD - human required` unless explicit human production evidence is provided.
- The final decision must remain `PENDING` unless explicit human production approval exists.
- Do not select `GO` or `GO_WITH_LIMITATIONS` during Codex completion work.
- Do not enable production.
- Do not run live DB sync during Codex automated verification.
- Do not change feature flags or the `FLEET_OPS_API_ENABLED` default.
- Do not modify Fleet Ops API/controller/facade/module logic, Fleet Ops UI behavior, frontend API clients, permission model, seed behavior, sync script behavior, schema, migrations, AppModule, package scripts, generic production docs, or CI.
- Do not add Fleet Ops write, execute, admin, action, allocate, or collect permissions.
- GO / NO-GO decisions remain human-owned.
- Keep push, PR creation, and merge human-only.

Focused verification:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts
```

## 20. Fleet Ops Production Decision Finalization Tasks

P1-H17 is a docs/record-only task for finalizing the production GO / NO-GO record from explicit human decision input.

Rules:
- A `GO` decision may be recorded only when explicit human decision input is provided.
- Recording `GO` does not automatically enable production.
- Production access sync, production DB target confirmation, feature flag enablement, restart/redeploy, production smoke, and rollback remain human/operator actions.
- Do not run live DB sync during Codex automated verification.
- Do not query the production database.
- Do not change feature flags or the `FLEET_OPS_API_ENABLED` default.
- Do not modify Fleet Ops API/controller/facade/module logic, Fleet Ops UI behavior, frontend API clients, permission model, seed behavior, sync script behavior, schema, migrations, AppModule, package scripts, generic production docs, or CI.
- Do not add Fleet Ops write, execute, admin, action, allocate, or collect permissions.
- Keep push, PR creation, and merge human-only.

Focused verification:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts
```

## 21. Fleet Ops Production Image Alignment Tasks

P1-H18 is a docs/checklist-only task for aligning production API/Web images before any Fleet Ops production enablement.

Rules:
- Keep the runbook at `docs/fleet-ops/runbooks/production-image-alignment.md`.
- Production image alignment is not Fleet Ops feature enablement.
- Do not build Docker images from Codex.
- Do not pull production images from Codex.
- Do not push images to GHCR from Codex.
- Do not deploy or restart production services from Codex.
- Do not run live DB sync during Codex automated verification.
- Do not query the production database.
- Do not change feature flags or the `FLEET_OPS_API_ENABLED` default.
- Do not modify Fleet Ops API/controller/facade/module logic, Fleet Ops UI behavior, frontend API clients, permission model, seed behavior, sync script behavior, package scripts, CI, Dockerfiles, compose files, schema, or migrations.
- API and Web must be aligned from the same target commit family before Fleet Ops enablement.
- Human operators own GitHub Actions image build/publish, digest capture, production deployment, migration/preflight execution, access sync, feature flag enablement, production smoke, rollback, push, PR creation, and merge.

Focused verification:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts
```

## 22. Fleet Ops Production Enablement Record Tasks

P1-H22 is a docs-only task for recording completed human/operator production enablement evidence after image alignment, migration preflight, access sync, feature flag enablement, API health, and Fleet Ops UI smoke have already been performed by the operator.

Rules:
- Keep the record at `docs/fleet-ops/runbooks/production-enablement-record-20260705.md`.
- Production enablement records are docs-only.
- Codex must not execute production actions.
- Record human/operator evidence only.
- Do not include secrets, plaintext DSNs, passwords, tokens, cookies, registry credentials, or full DB connection strings.
- Do not modify runtime, API, UI, permission, seed, sync, package, Dockerfile, compose, deployment, schema, migration, or CI files.
- Do not run live DB sync during Codex automated verification.
- Do not query the production database.
- Do not change feature flags or the `FLEET_OPS_API_ENABLED` default.
- Do not add Fleet Ops write, execute, admin, action, allocate, or collect permissions.
- Do not add execution endpoints, mutation controls, customer/public routes, or production data mutation steps.
- Record OP/GM access smoke, non-granted role denial, sparse-data notes, vehicleId lookup friction, and other gaps as follow-ups when evidence is incomplete.
- Record P1-H23 vehicle selector/lookup separately; do not implement it in the enablement record task.
- Keep push, PR creation, merge, deployment, production sync, and feature flag operations human-only.

Focused verification:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts
```

## 23. Fleet Ops Vehicle Lookup / Drilldown Entry Tasks

P1-H23 implements a read-only vehicle selector for the production-enabled Fleet Ops diagnostic surface.

Rules:
- Add only a GET lookup endpoint under `/fleet-ops`.
- Require `fleet_ops:read` and respect `FLEET_OPS_API_ENABLED`.
- Search by internal vehicle ID, vehicle number, VIN, and license plate when those fields exist.
- Return only minimal safe identity fields: vehicle ID, vehicle number, masked plate, VIN suffix, brand/model/model year, and status/operational state label.
- Do not return customer, finance, lease, payment, evidence payload, full VIN, or full plate data.
- Do not modify schema, migrations, seed, sync, permissions, AppModule, Docker/compose, CI, or root package scripts.
- Do not add Fleet Ops POST/PATCH/PUT/DELETE endpoints, execution/write/admin/action permissions, mutation controls, customer/public exposure, saved custom views, or P2 pool aggregation.
- Direct `/fleet-ops?vehicleId=<id>` may load the existing single-vehicle snapshot.
- P2 pool overview / dynamic cohort remains next-stage design work.
- P3 saved custom views remain deferred until P2 proves useful.

Focused verification:

```bash
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts test/fleet-ops.vehicle-lookup.spec.ts test/fleet-ops.api-readonly.spec.ts test/fleet-ops.boundary.spec.ts test/fleet-ops.controller.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-vehicle-lookup.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-readonly.spec.ts test/fleet-ops-view-model.spec.ts
```

## 24. Fleet Ops P2-H1 Pool Overview / Dynamic Cohort Design Tasks

P2-H1 is a docs/design-only task that defines how Fleet Ops moves from single-vehicle diagnosis toward pool/cohort overview, anomaly ranking, vehicle list, and single-vehicle snapshot drilldown.

Rules:
- Keep the design at `docs/fleet-ops/next-stage/p2_pool_overview_design.md`.
- P2-H1 must not implement runtime API, runtime UI, backend aggregation, package scripts, CI, Dockerfiles, compose files, schema, migrations, seed behavior, sync behavior, permission changes, or deployment changes.
- Do not add Fleet Ops POST/PATCH/PUT/DELETE operations, execution/write/admin/action permissions, customer/public exposure, mutation controls, or saved custom views.
- P3 saved custom views remain deferred pending P2 effectiveness and require separate write-scope, ownership, audit, permission, sharing, and persistence design.
- Future P2-H2 backend aggregation must remain read-only, GET-only externally, use `fleet_ops:read`, respect `FLEET_OPS_API_ENABLED`, and preserve existing Fleet Ops KPI/risk semantics.
- Future P2-H3 UI must not add saved-view, execution, mutation, or customer/public controls.
- Push, PR creation, merge, deployment, production commands, live DB sync, production DB query, and feature-flag operations remain human-only.

Recommended future backend components:
- `FleetOpsScopeResolver`
- `FleetOpsPoolAggregator`
- `FleetOpsOverviewService`
- `FleetOpsPoolReadModel` contracts

Recommended future endpoints:
- `GET /fleet-ops/overview`
- `GET /fleet-ops/pools`
- `GET /fleet-ops/pools/:poolId`
- Optional `GET /fleet-ops/vehicles` for a paginated scoped vehicle/anomaly list.

Focused verification for P2-H1 docs-only work:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts test/fleet-ops-vehicle-lookup.spec.ts
```
