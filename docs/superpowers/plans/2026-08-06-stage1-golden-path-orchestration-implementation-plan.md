# Stage 1 Golden Path Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不依赖微信委托代扣的前提下，把 A/B 两条进件入口、三个人工决策、法大大生产电子签、Portal 微信 JSAPI 支付、Stage 2 交付证据和权威激活串成可观测、可恢复、可在生产环境验收的第 1 阶段 Golden Path。

**Architecture:** 新增轻量持久化 `SubscriptionJourney` 编排域，以步骤、任务、人工任务、事件、异常和事务 Outbox 记录旅程事实；领域模块只发布事务信号，编排处理器读取权威业务事实推进状态，不让 Controller 互相调用，也不引入通用 BPM。现有 Application、Order、Fadada、Finance/Payment、Stage 2 Handover 与 Lease 服务通过窄的事务内接口接入；Admin 只在现有进件页和订单工作台增加卡片与动作，Portal 只增加“下一步”引导。

**Tech Stack:** NestJS 11、Prisma 7/PostgreSQL、Vitest 4、Next.js 16/React 19、Ant Design 6、TypeScript 6、pnpm 11、法大大生产 API、微信支付 JSAPI、微信公众号通知。

## Global Constraints

- 批准设计：`docs/superpowers/specs/2026-08-06-stage1-golden-path-orchestration-design.zh-CN.md`；目标依据：`docs/superpowers/specs/2026-07-29-six-month-subscription-automation-design.zh-CN.md` 与 `docs/superpowers/specs/2026-07-30-three-stage-subscription-capability-roadmap-design.zh-CN.md`。
- 本轮仅覆盖第 1 阶段新订阅 Golden Path；不得暴露或实现 `RENT_TO_OWN`，不得破坏 `ProductPriceRule`、旧 Quote 字段、合同续期和现有 Stage 2 能力。
- 微信委托代扣仍处于审核期：`AUTO_DEBIT_ENABLED=false` 是正常配置，Golden Path 仅用客户 Portal 的微信 JSAPI 支付完成首期账单闭环，验收不得要求 mandate。
- 电子签唯一供应商是法大大，生产验收必须 `ESIGN_PROVIDER=fadada`、`FADADA_ENV=production`；签署完成、平台盖章完成且归档 PDF 落库后，合同权威状态才是 `ARCHIVED`。
- 正常流内部人工决策严格只有三次：`FINAL_PLAN_DECISION`、`FINAL_VEHICLE_ALLOCATION`、`DELIVERY_EVIDENCE_DECISION`。客户确认方案、电子签和 JSAPI 支付属于客户动作，不计入内部人工决策。
- 激活依据只能是权威事实：`Contract.status=ARCHIVED`、首期 `ReceivableBill` 已由真实 `Payment`/`WriteOff` 结清、Stage 2 交付工单与证据审核通过。`VehicleDelivery.depositReceivedConfirmed` 和 `firstMonthlyFeeReceivedConfirmed` 仅保留为旧数据兼容字段，新流程不得读取或写入。
- 激活必须在一个数据库事务内完成 `VehicleDelivery=DELIVERED`、`SubscriptionOrder=ACTIVE`、`Vehicle=LEASED`、`Lease=ACTIVE`、`BillingSchedule`、初始权益、Journey 步骤与 Outbox；任一前置事实不满足时整笔回滚。
- 所有金额继续使用分和 `BigInt`；业务日期/时间继续遵循项目既有 `Asia/Shanghai` 约定；外部返回值和错误日志不得泄漏证件号、手机号、支付密钥、法大大密钥或签署 URL。
- 采用增量 migration，不修改历史 migration，不执行 `prisma migrate reset`。每个任务开始前运行 `git status --short --branch`、`pnpm prisma:migrate:status`、`pnpm prisma:validate`；发现非本任务改动或待执行 migration 时停止并处理。
- 当前基线 `pnpm prisma:validate` 已通过，但 `pnpm prisma:migrate:status` 因缺少 `DATABASE_URL` 无法执行。Task 0 是硬门禁：获得可用数据库连接并确认 migration 状态前，不得修改业务代码或生成 migration。
- 功能开关 `SUBSCRIPTION_JOURNEY_ENABLED` 默认 `false`；生产初期还必须命中 `SUBSCRIPTION_JOURNEY_ALLOWLIST_CUSTOMER_IDS` 或 `SUBSCRIPTION_JOURNEY_ALLOWLIST_APPLICATION_IDS`。开关关闭或不在 allowlist 时保留现有人工流程。
- 默认任务最多执行 5 次；失败后按 30 秒、2 分钟、10 分钟、30 分钟重试并加入 20% jitter；尊重供应商 `Retry-After`，但单次不超过 2 小时。法大大状态对账首次 5 分钟、第二次 30 分钟、之后每 6 小时。
- 每项行为改动严格执行 RED → GREEN → REFACTOR，任务边界独立提交。任何“通过”结论都必须来自本轮新运行的命令。

---

### Task 0: Database and worktree preflight gate

**Files:** None.

**Interfaces:**

- Consumes: a valid PostgreSQL `DATABASE_URL` for the isolated worktree.
- Produces: a clean branch, validated Prisma schema, and confirmation that no migration is pending before implementation begins.

- [ ] **Step 1: Confirm the isolated branch and clean tree**

Run:

```powershell
git status --short --branch
git branch --show-current
git rev-parse --show-toplevel
```

Expected: branch is `feat/stage1-golden-path-orchestration-20260806`, repository root ends in `.worktrees/stage1-golden-path-orchestration-20260806`, and only this plan's checkbox updates may be present.

- [ ] **Step 2: Provide and verify the database connection**

Set `DATABASE_URL` through the existing local secret-loading mechanism, then run:

```powershell
if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL)) { throw "DATABASE_URL is required" }
pnpm prisma:migrate:status
pnpm prisma:validate
```

Expected: the database is reachable, Prisma reports no pending migrations, and schema validation passes. If migration status fails or reports pending migrations, stop; do not run reset and do not continue to Task 1.

### Task 1: Journey schema, migration, relations, permissions, and menu contract

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260806120000_stage1_subscription_journey/migration.sql`
- Modify: `apps/api/prisma/seed.mjs`
- Modify: `packages/shared/src/auth.ts`
- Modify: `packages/shared/src/menus.ts`
- Modify: `packages/shared/test/auth.spec.ts`
- Modify: `apps/api/test/permissions.spec.ts`
- Create: `apps/api/test/subscription-journey-schema.spec.ts`

**Interfaces:**

- Consumes: existing `Application`, `SubscriptionOrder`, `Contract`, `ReceivableBill`, `Payment`, `WriteOff`, `VehicleDelivery`, `HandoverWorkOrder`, `Lease`, `Vehicle`, AuditLog and RBAC patterns.
- Produces: the seven persistent journey models, approved enums, exact-plan revision fields, six permission codes, and an existing Orders-menu child filter.

- [ ] **Step 1: Write failing schema and permission contract tests**

In `subscription-journey-schema.spec.ts`, assert the DMMF/schema contains:

```ts
expect(modelNames).toEqual(
  expect.arrayContaining([
    "SubscriptionJourney",
    "SubscriptionJourneyStep",
    "SubscriptionJourneyJob",
    "SubscriptionJourneyManualTask",
    "SubscriptionJourneyEvent",
    "SubscriptionJourneyException",
    "SubscriptionJourneyOutbox"
  ])
);
expect(enumValues("SubscriptionJourneyManualTaskType")).toEqual([
  "FINAL_PLAN_DECISION",
  "FINAL_VEHICLE_ALLOCATION",
  "DELIVERY_EVIDENCE_DECISION"
]);
expect(field("Application", "finalPlanRevision").type).toBe("Int");
expect(field("Application", "customerConfirmedPlanRevision").isRequired).toBe(false);
```

Extend shared/API permission tests with:

```ts
expect(PermissionCode.SUBSCRIPTION_JOURNEY_VIEW).toBe("subscription_journey:view");
expect(PermissionCode.SUBSCRIPTION_JOURNEY_PLAN_DECIDE).toBe("subscription_journey:plan_decide");
expect(PermissionCode.SUBSCRIPTION_JOURNEY_VEHICLE_ALLOCATE).toBe(
  "subscription_journey:vehicle_allocate"
);
expect(PermissionCode.SUBSCRIPTION_JOURNEY_DELIVERY_EVIDENCE_DECIDE).toBe(
  "subscription_journey:delivery_evidence_decide"
);
expect(PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER).toBe("subscription_journey:recover");
expect(PermissionCode.SUBSCRIPTION_JOURNEY_CANCEL).toBe("subscription_journey:cancel");
```

Assert ADMIN has all six; OP has view plus three decisions and recover; SA/AS have view; only ADMIN has cancel. Assert `orders.journey_exceptions` points to `/orders?journeyStatus=EXCEPTION` and there is no new top-level menu.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-schema.spec.ts test/permissions.spec.ts
pnpm --filter @subscription-saas/shared exec vitest run test/auth.spec.ts
```

Expected: FAIL because journey schema types and permission constants do not exist.

- [ ] **Step 3: Add exact enums and models**

Add the approved enum values without abbreviations:

```prisma
enum SubscriptionJourneyStatus {
  RUNNING
  WAITING_CUSTOMER
  WAITING_MANUAL
  RETRY_SCHEDULED
  PAUSED
  EXCEPTION
  COMPLETED
  CANCELLED
}

enum SubscriptionJourneyStepCode {
  APPLICATION_VALIDATION
  FINAL_PLAN_DECISION
  CUSTOMER_PLAN_CONFIRMATION
  FINAL_VEHICLE_ALLOCATION
  ORDER_AND_CONTRACT_CREATION
  FADADA_SIGNING_AND_ARCHIVE
  INITIAL_BILLING
  CUSTOMER_JSAPI_PAYMENT
  HANDOVER_AND_STAGE2_CREATION
  DELIVERY_EVIDENCE_DECISION
  AUTHORITATIVE_ACTIVATION
}
```

Add the remaining enums exactly as follows:

```prisma
enum SubscriptionJourneyStepStatus {
  PENDING
  RUNNING
  WAITING_CUSTOMER
  WAITING_MANUAL
  RETRY_SCHEDULED
  EXCEPTION
  COMPLETED
  SKIPPED
  CANCELLED
}

enum SubscriptionJourneyManualTaskType {
  FINAL_PLAN_DECISION
  FINAL_VEHICLE_ALLOCATION
  DELIVERY_EVIDENCE_DECISION
}

enum SubscriptionJourneyManualTaskStatus {
  OPEN
  COMPLETED
  CANCELLED
}

enum SubscriptionJourneyManualDecision {
  APPROVED
  REJECTED
}

enum SubscriptionJourneyJobType {
  VALIDATE_APPLICATION
  CREATE_ORDER_AND_CONTRACT
  START_FADADA_SIGNING
  RECONCILE_FADADA_SIGNING
  GENERATE_INITIAL_BILLS
  EVALUATE_PAYMENT_SETTLEMENT
  CREATE_HANDOVER
  ACTIVATE_SUBSCRIPTION
  DISPATCH_NOTIFICATION
}

enum SubscriptionJourneyJobStatus {
  PENDING
  PROCESSING
  RETRY_SCHEDULED
  COMPLETED
  DEAD_LETTER
  CANCELLED
}

enum SubscriptionJourneyEventType {
  JOURNEY_STARTED
  STEP_STARTED
  STEP_WAITING_CUSTOMER
  STEP_WAITING_MANUAL
  STEP_COMPLETED
  STEP_RETRY_SCHEDULED
  STEP_EXCEPTION
  MANUAL_TASK_DECIDED
  DOMAIN_FACT_OBSERVED
  JOURNEY_PAUSED
  JOURNEY_RESUMED
  JOURNEY_CANCELLED
  JOURNEY_COMPLETED
  EXCEPTION_RESOLVED
}

enum SubscriptionJourneyExceptionStatus {
  OPEN
  ACKNOWLEDGED
  RESOLVED
}

enum SubscriptionJourneyOutboxStatus {
  PENDING
  PROCESSING
  DELIVERED
  DEAD_LETTER
  CANCELLED
}
```

Use these exact field contracts:

- `SubscriptionJourney`: `id`, unique `applicationId`, nullable unique `orderId`, `status`, `currentStepCode`, `currentStepStatus`, nullable `pausedFromStatus`, optimistic `version`, `startedAt`, nullable `completedAt`/`cancelledAt`, timestamps and relations to all child rows.
- `SubscriptionJourneyStep`: `id`, `journeyId`, `code`, `status`, `attemptCount`, nullable `startedAt`/`waitingAt`/`completedAt`, nullable safe `lastErrorCode`, timestamps and unique `(journeyId, code)`.
- `SubscriptionJourneyJob`: `id`, `journeyId`, `stepId`, `jobType`, `status`, unique `sourceKey`, nullable JSON `payload`, `attemptCount`, `maxAttempts`, `availableAt`, nullable `leaseToken`/`leaseExpiresAt`, nullable safe `lastErrorCode`/`lastErrorMessage`, nullable `completedAt`, timestamps.
- `SubscriptionJourneyManualTask`: `id`, `journeyId`, `stepId`, `taskType`, `status`, nullable `decision`, immutable JSON `inputSnapshot`, nullable `decidedBy`/`decisionNotes`/`decidedAt`, optimistic `version`, timestamps.
- `SubscriptionJourneyEvent`: `id`, `journeyId`, monotonically increasing `sequence`, unique `eventKey`, `eventType`, nullable `actorType`/`actorId`, sanitized JSON `payload`, `createdAt`, and unique `(journeyId, sequence)`.
- `SubscriptionJourneyException`: `id`, `journeyId`, `stepId`, nullable `jobId`, `status`, `code`, safe `message`, `retryable`, `occurrenceCount`, `firstOccurredAt`, `lastOccurredAt`, nullable `acknowledgedBy`/`acknowledgedAt`/`resolvedBy`/`resolvedAt`/`resolutionNotes`, timestamps.
- `SubscriptionJourneyOutbox`: `id`, nullable `journeyId`, `aggregateType`, `aggregateId`, `eventType` string, unique `eventKey`, sanitized JSON `payload`, `status`, `attemptCount`, `availableAt`, nullable `leaseToken`/`leaseExpiresAt`, nullable safe `lastErrorCode`/`lastErrorMessage`, nullable `deliveredAt`, timestamps. Nullable `journeyId` permits the intake signal to exist before enrollment.

All models use stable CUID IDs and `createdAt`/`updatedAt` where listed. Add these database constraints:

```sql
CREATE UNIQUE INDEX "subscription_journey_application_id_key"
ON "subscription_journey" ("application_id");

CREATE UNIQUE INDEX "subscription_journey_order_id_key"
ON "subscription_journey" ("order_id")
WHERE "order_id" IS NOT NULL;

CREATE UNIQUE INDEX "subscription_journey_step_code_key"
ON "subscription_journey_step" ("journey_id", "code");

CREATE UNIQUE INDEX "subscription_journey_open_manual_task_key"
ON "subscription_journey_manual_task" ("journey_id", "task_type")
WHERE "status" = 'OPEN';

CREATE UNIQUE INDEX "subscription_journey_event_event_key_key"
ON "subscription_journey_event" ("event_key");

CREATE UNIQUE INDEX "subscription_journey_outbox_event_key_key"
ON "subscription_journey_outbox" ("event_key");
```

Add lease-claim indexes for due jobs/outbox rows and indexes for status/current step/order/application queries. Add relations from Application and SubscriptionOrder. Add `Application.finalPlanRevision Int @default(0)` and nullable `customerConfirmedPlanRevision Int`; do not drop or reinterpret legacy delivery booleans.

- [ ] **Step 4: Add permissions, seed grants, and the incremental menu entry**

Add the six permission constants, seed records, role grants, and `orders.journey_exceptions`. The menu entry reuses the current `/orders` page with a query filter; it must not create a page or top-level navigation group. Update seed verification expectations if they enumerate menu/permission counts.

- [ ] **Step 5: Apply migration and make tests GREEN**

```powershell
pnpm prisma:migrate:deploy
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-schema.spec.ts test/permissions.spec.ts
pnpm --filter @subscription-saas/shared exec vitest run test/auth.spec.ts
pnpm prisma:seed:verify
```

Expected: migration applies once, schema and seed baseline validate, all focused tests pass.

- [ ] **Step 6: Commit the persistence and RBAC boundary**

```powershell
git add apps/api/prisma packages/shared/src/auth.ts packages/shared/src/menus.ts packages/shared/test/auth.spec.ts apps/api/test/subscription-journey-schema.spec.ts apps/api/test/permissions.spec.ts
git commit -m "feat: add subscription journey persistence"
```

### Task 2: Pure state machine, repository, and transaction signal boundary

**Files:**

- Create: `apps/api/src/subscription-journey/subscription-journey.types.ts`
- Create: `apps/api/src/subscription-journey/subscription-journey.errors.ts`
- Create: `apps/api/src/subscription-journey/subscription-journey-state-machine.ts`
- Create: `apps/api/src/subscription-journey/subscription-journey.repository.ts`
- Create: `apps/api/src/subscription-journey/subscription-journey-signal.service.ts`
- Create: `apps/api/src/subscription-journey/subscription-journey-signal.module.ts`
- Create: `apps/api/test/subscription-journey-state-machine.spec.ts`
- Create: `apps/api/test/subscription-journey.repository.spec.ts`

**Interfaces:**

- Consumes: Task 1 Prisma types and `Prisma.TransactionClient`.
- Produces: one deterministic transition table, transaction-scoped state/event/outbox writes, idempotent signal insertion, job lease operations, and stable public error codes.

```ts
export type JourneySignalType =
  | "APPLICATION_SUBMITTED"
  | "CUSTOMER_PLAN_CONFIRMED"
  | "FADADA_TASK_COMPLETED"
  | "FADADA_ARTIFACT_ARCHIVED"
  | "PAYMENT_SETTLED"
  | "HANDOVER_EVIDENCE_READY"
  | "HANDOVER_OPS_REVIEWED";

export interface JourneySignalInput {
  applicationId?: string;
  orderId?: string;
  type: JourneySignalType;
  eventKey: string;
  payload?: Prisma.InputJsonValue;
}

export class SubscriptionJourneySignalService {
  record(tx: Prisma.TransactionClient, input: JourneySignalInput): Promise<void>;
}
```

- [ ] **Step 1: Write failing state-machine tests**

Test every allowed edge in order, reject skips/backtracks, permit `PAUSED → previous status`, permit explicit cancellation before completion, and prove that only the three manual steps produce an OPEN manual task:

```ts
expect(nextStep("APPLICATION_VALIDATION", "COMPLETED")).toBe("FINAL_PLAN_DECISION");
expect(manualTaskTypeFor("CUSTOMER_PLAN_CONFIRMATION")).toBeNull();
expect(manualTaskTypeFor("FINAL_VEHICLE_ALLOCATION")).toBe("FINAL_VEHICLE_ALLOCATION");
expect(() => assertTransition("INITIAL_BILLING", "AUTHORITATIVE_ACTIVATION")).toThrowError(
  expect.objectContaining({ code: "JOURNEY_INVALID_TRANSITION" })
);
```

- [ ] **Step 2: Write failing repository and idempotency tests**

Cover event-key duplicate suppression, optimistic-version rejection, one-open-manual-task enforcement, `FOR UPDATE SKIP LOCKED` job/outbox claim, lease-token completion, retry scheduling, dead-letter-to-exception creation, and sensitive payload rejection. Verify a single mocked transaction contains the step update, event insert and outbox insert.

- [ ] **Step 3: Run the focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-state-machine.spec.ts test/subscription-journey.repository.spec.ts
```

Expected: FAIL because state machine and repository do not exist.

- [ ] **Step 4: Implement the pure state machine and stable errors**

Keep transition logic free of NestJS/Prisma. Define `SubscriptionJourneyError` with safe `code`, `message`, `retryable` and optional `retryAfterMs`; never carry raw provider response bodies into public errors.

- [ ] **Step 5: Implement repository and signal module**

`SubscriptionJourneyRepository` must expose transaction-aware operations rather than opening nested transactions:

```ts
createOrGetForApplication(tx, applicationId, eventKey): Promise<SubscriptionJourney>;
completeStep(tx, input): Promise<SubscriptionJourneyStep>;
waitForCustomer(tx, input): Promise<SubscriptionJourneyStep>;
openManualTask(tx, input): Promise<SubscriptionJourneyManualTask>;
decideManualTask(tx, input): Promise<SubscriptionJourneyManualTask>;
enqueueJob(tx, input): Promise<SubscriptionJourneyJob>;
recordException(tx, input): Promise<SubscriptionJourneyException>;
```

Use `upsert`/unique event keys for producer retry idempotency. `SubscriptionJourneySignalModule` imports only `PrismaModule` and exports only the signal service, so Customer/ESign/Finance/Handover modules can publish signals without importing the full orchestration module.

- [ ] **Step 6: Run GREEN tests and typecheck**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-state-machine.spec.ts test/subscription-journey.repository.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: focused tests and API typecheck pass.

- [ ] **Step 7: Commit the engine boundary**

```powershell
git add apps/api/src/subscription-journey apps/api/test/subscription-journey-state-machine.spec.ts apps/api/test/subscription-journey.repository.spec.ts
git commit -m "feat: add subscription journey state engine"
```

### Task 3: Worker, dispatcher, enrollment, retries, and observability

**Files:**

- Create: `apps/api/src/subscription-journey/subscription-journey.config.ts`
- Create: `apps/api/src/subscription-journey/subscription-journey.handlers.ts`
- Create: `apps/api/src/subscription-journey/subscription-journey.service.ts`
- Create: `apps/api/src/subscription-journey/subscription-journey.worker.ts`
- Create: `apps/api/src/subscription-journey/subscription-journey.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/.env.production.example`
- Create: `apps/api/test/subscription-journey-worker.spec.ts`
- Create: `apps/api/test/subscription-journey-enrollment.spec.ts`

**Interfaces:**

- Consumes: Task 2 repository/signal boundary and existing billing-worker lease patterns.
- Produces: feature-gated enrollment, polling workers for domain signals/jobs/outbox, deterministic retry policy, worker heartbeat, and operational journey metrics.

- [ ] **Step 1: Write failing worker retry and lease tests**

Test disabled worker, one-run claim, successful completion, safe shutdown, stale lease reclaim, maximum five executions, 20% bounded jitter, `Retry-After` cap, and direct dead letter for non-retryable errors:

```ts
expect(baseRetryDelayMs(1)).toBe(30_000);
expect(baseRetryDelayMs(2)).toBe(120_000);
expect(baseRetryDelayMs(3)).toBe(600_000);
expect(baseRetryDelayMs(4)).toBe(1_800_000);
expect(capRetryAfterMs(9_000_000)).toBe(7_200_000);
expect(repository.deadLetter).toHaveBeenCalledOnce();
```

For `RECONCILE_FADADA_SIGNING`, assert delays are 5 minutes, 30 minutes, then 6 hours. Inject deterministic random values in tests rather than asserting wall-clock jitter.

- [ ] **Step 2: Write failing enrollment and allowlist tests**

Cover feature flag false, allowlisted customer ID, allowlisted application ID, non-allowlisted rejection, A/B source parity, duplicate `APPLICATION_SUBMITTED`, and existing journeys after rollout disable. Existing enrolled journeys may continue; new journeys may not enroll.

- [ ] **Step 3: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-worker.spec.ts test/subscription-journey-enrollment.spec.ts
```

Expected: FAIL because worker/module/config do not exist.

- [ ] **Step 4: Implement typed configuration and worker loops**

Read:

```dotenv
SUBSCRIPTION_JOURNEY_ENABLED=false
SUBSCRIPTION_JOURNEY_WORKER_ENABLED=false
SUBSCRIPTION_JOURNEY_POLL_INTERVAL_MS=5000
SUBSCRIPTION_JOURNEY_CLAIM_LIMIT=10
SUBSCRIPTION_JOURNEY_LEASE_MS=120000
SUBSCRIPTION_JOURNEY_ALLOWLIST_CUSTOMER_IDS=
SUBSCRIPTION_JOURNEY_ALLOWLIST_APPLICATION_IDS=
```

Reject invalid positive integers at startup. Follow `BillingAutomationWorker` for lifecycle and lease semantics, but use separate claim loops for input signals, jobs and notification outbox. Persist heartbeat/last success through metrics derived from job/event rows; do not add an in-memory-only success indicator.

- [ ] **Step 5: Implement enrollment and handler dispatch skeleton**

Signal dispatch must enroll on `APPLICATION_SUBMITTED`, attach `orderId` after order creation, and enqueue exactly one handler job per step using stable source keys such as `journey:{journeyId}:step:{stepCode}:revision:{finalPlanRevision}`. Unimplemented domain handlers must throw `JOURNEY_HANDLER_NOT_READY` as non-retryable in this task's tests; subsequent tasks replace them one at a time.

- [ ] **Step 6: Wire the module and make tests GREEN**

`SubscriptionJourneyModule` imports the signal module and required domain modules; `AppModule` imports it once. Avoid `forwardRef` by keeping domain modules dependent only on `SubscriptionJourneySignalModule`.

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-worker.spec.ts test/subscription-journey-enrollment.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 7: Commit the runtime skeleton**

```powershell
git add apps/api/src/subscription-journey apps/api/src/app.module.ts apps/api/.env.example apps/api/.env.production.example apps/api/test/subscription-journey-worker.spec.ts apps/api/test/subscription-journey-enrollment.spec.ts
git commit -m "feat: run subscription journey orchestration"
```

### Task 4: A/B intake, validation, exact plan revision, and first two manual decisions

**Files:**

- Modify: `apps/api/src/customer/customer.module.ts`
- Modify: `apps/api/src/customer/customer.service.ts`
- Modify: `apps/api/src/portal/portal-application.service.ts`
- Modify: `apps/api/src/portal/portal-application.controller.ts`
- Modify: `apps/api/src/portal/portal-application.dto.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.handlers.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.service.ts`
- Create: `apps/api/test/subscription-journey-application.spec.ts`
- Modify: `apps/api/test/portal-application.spec.ts`

**Interfaces:**

- Consumes: existing A-line admin-assisted and B-line Portal application creation, material/credit/product validation, available vehicle rules, and plan snapshot shape.
- Produces: transactional application signals, exact plan revision confirmation, final plan decision, final vehicle allocation, and automatic order-creation readiness.

```ts
applyJourneyFinalPlanDecision(
  tx: Prisma.TransactionClient,
  applicationId: string,
  input: JourneyFinalPlanDecisionInput,
  actor: RequestUser,
  context: RequestContext
): Promise<Application>;

allocateJourneyVehicle(
  tx: Prisma.TransactionClient,
  applicationId: string,
  vehicleId: string,
  actor: RequestUser,
  context: RequestContext
): Promise<{ application: Application; requiresCustomerReconfirmation: boolean }>;
```

- [x] **Step 1: Write failing A/B parity and validation tests**

Create one admin-assisted application and one Portal self-service application with the same approved inputs. Assert both emit `APPLICATION_SUBMITTED`, enter `APPLICATION_VALIDATION`, reject incomplete materials/credit/product facts with stable codes, and open exactly one `FINAL_PLAN_DECISION` task after validation.

- [x] **Step 2: Write failing exact-revision and vehicle-allocation tests**

Cover:

```ts
expect(result.finalPlanRevision).toBe(1);
await expect(
  portal.confirmFinalPlan(application.id, { revision: 0 }, customer, context)
).rejects.toMatchObject({ code: "FINAL_PLAN_REVISION_STALE" });
expect(confirmed.customerConfirmedPlanRevision).toBe(1);
expect(await countOpenManualTasks(journey.id)).toBe(1);
```

Reject vehicle allocation before customer confirmation. On compatible vehicle allocation, reserve once and complete the task. If concrete vehicle facts change price/model/terms, increment `finalPlanRevision`, clear `customerConfirmedPlanRevision`, release the prior reservation safely, return to `CUSTOMER_PLAN_CONFIRMATION`, and do not count an extra internal decision.

- [x] **Step 3: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-application.spec.ts test/portal-application.spec.ts
```

Expected: FAIL because signals, revision input and journey decision methods are absent.

- [x] **Step 4: Publish intake/confirmation signals inside existing transactions**

Import only `SubscriptionJourneySignalModule` in `CustomerModule`. Record stable signals in the same transaction as application submission and customer confirmation. Change the Portal confirmation DTO to require integer `revision >= 1`; legacy non-journey applications retain their existing behavior through a separate compatibility branch.

- [x] **Step 5: Implement validation and the two manual decision handlers**

Reuse existing product, price, risk and vehicle availability services; do not duplicate rule calculations in the journey handler. Final-plan approval persists a complete snapshot and increments the revision. Allocation happens only after exact revision confirmation and uses row locking/unique reservation rules. Both manual decisions write the domain mutation, manual-task result, journey event and outbox in one transaction.

- [x] **Step 6: Replace the application handler stubs and make tests GREEN**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-application.spec.ts test/portal-application.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: both intake paths converge and focused tests/typecheck pass.

- [x] **Step 7: Commit intake and manual-decision behavior**

```powershell
git add apps/api/src/customer apps/api/src/portal/portal-application.service.ts apps/api/src/portal/portal-application.controller.ts apps/api/src/portal/portal-application.dto.ts apps/api/src/subscription-journey apps/api/test/subscription-journey-application.spec.ts apps/api/test/portal-application.spec.ts
git commit -m "feat: orchestrate subscription application decisions"
```

### Task 5: Automatic order, quote, contract, and entitlement preparation

**Files:**

- Modify: `apps/api/src/customer/customer.service.ts`
- Modify: `apps/api/src/order/order.module.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Create: `apps/api/src/order/order-entitlement.service.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.handlers.ts`
- Create: `apps/api/test/subscription-journey-order-contract.spec.ts`
- Modify: `apps/api/test/order-entitlement.spec.ts`
- Modify: `apps/api/test/order-contract.spec.ts`

**Interfaces:**

- Consumes: `CustomerService.createOrderFromApplication`, `OrderService.generateContract`, active contract-template selection and existing entitlement generation.
- Produces: transaction-capable, idempotent order/contract bootstrap and a reusable transaction-scoped entitlement writer for later activation.

```ts
createOrderFromApplicationInTransaction(
  tx: Prisma.TransactionClient,
  applicationId: string,
  user: RequestUser,
  context: RequestContext
): Promise<SubscriptionOrder>;

createJourneyContractInTransaction(
  tx: Prisma.TransactionClient,
  orderId: string,
  actorId: string,
  sourceKey: string
): Promise<Contract>;

ensureInitialEntitlements(
  tx: Prisma.TransactionClient,
  orderId: string,
  actorId: string
): Promise<void>;
```

- [x] **Step 1: Write failing order/contract bootstrap tests**

Assert customer-confirmed plan plus allocated vehicle creates one Quote, one SubscriptionOrder and one generated Contract, attaches `journey.orderId`, and advances to `FADADA_SIGNING_AND_ARCHIVE`. Retry the same source key and assert no duplicate quote/order/contract. Reject inactive template, missing concrete vehicle, stale plan revision and non-`SUBSCRIPTION` product.

- [x] **Step 2: Write failing transaction-capable entitlement tests**

Assert `ensureInitialEntitlements(tx, orderId, actorId)` uses the caller's transaction, is idempotent by order/entitlement type, and does not activate entitlements yet. The existing public endpoint may keep its wrapper, but it must delegate to this service.

- [x] **Step 3: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-order-contract.spec.ts test/order-entitlement.spec.ts test/order-contract.spec.ts
```

Expected: FAIL because transaction-scoped methods and journey handler are absent.

- [x] **Step 4: Extract transaction-scoped methods without changing legacy endpoints**

Refactor existing public methods into thin `$transaction` wrappers over the new methods. Preserve existing Quote snapshots and `ProductPriceRule` outcomes. Export `OrderService` and `OrderEntitlementService` from `OrderModule`; do not add Controller-to-Controller calls.

- [x] **Step 5: Implement idempotent journey bootstrap**

Within one transaction, lock Application/Journey, revalidate exact plan revision and vehicle reservation, create/reuse quote, order and draft/generated contract, attach order to journey, write event/outbox, and enqueue `START_FADADA_SIGNING`. Use source keys for deterministic retries. Do not call the external Fadada API while the database transaction is open.

- [x] **Step 6: Make tests GREEN and typecheck**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-order-contract.spec.ts test/order-entitlement.spec.ts test/order-contract.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: focused tests and typecheck pass with legacy application endpoints unchanged for non-journey records.

- [x] **Step 7: Commit the order/contract bootstrap**

```powershell
git add apps/api/src/customer/customer.service.ts apps/api/src/order apps/api/src/subscription-journey/subscription-journey.handlers.ts apps/api/test/subscription-journey-order-contract.spec.ts apps/api/test/order-entitlement.spec.ts apps/api/test/order-contract.spec.ts
git commit -m "feat: bootstrap journey orders and contracts"
```

### Task 6: Fadada production signing, callback reconciliation, seal, and archive authority

**Files:**

- Modify: `apps/api/src/esign/esign.module.ts`
- Modify: `apps/api/src/esign/esign.service.ts`
- Modify: `apps/api/src/esign/fadada/fadada-signed-artifact.service.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.handlers.ts`
- Create: `apps/api/test/subscription-journey-esign.spec.ts`
- Modify: `apps/api/test/esign.spec.ts`
- Modify: `apps/api/test/fadada-archive.spec.ts`

**Interfaces:**

- Consumes: existing `ESignService.createTaskForContract`, `startPortalSigning`, verified Fadada callback parser, provider account/onboarding and signed-artifact storage.
- Produces: journey-aware real signing start, reconciliation, Stage 1 archive finalization, and authoritative `Contract.status=ARCHIVED` signal.

- [x] **Step 1: Write failing fail-closed and idempotency tests**

Assert a journey cannot start with mock provider, sandbox/non-production Fadada base URL, missing provider account, unverified test signer, absent production callback URL, or unsigned contract. Assert repeated `START_FADADA_SIGNING` reuses the same `ContractESignTask` and provider transaction ID.

- [x] **Step 2: Write failing callback/archive authority tests**

Cover invalid callback signature, duplicate callback, callback-before-worker race, signed-but-not-archived state, platform seal pending, artifact checksum/storage failure, and success:

```ts
expect(afterSigned.contract.status).toBe("SIGNED");
expect(afterSigned.journey.currentStepCode).toBe("FADADA_SIGNING_AND_ARCHIVE");
expect(afterArchived.contract).toMatchObject({ status: "ARCHIVED", fileId: expect.any(String) });
expect(signals).toContainEqual(expect.objectContaining({ type: "FADADA_ARTIFACT_ARCHIVED" }));
```

- [x] **Step 3: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-esign.spec.ts test/esign.spec.ts test/fadada-archive.spec.ts
```

Expected: FAIL because Stage 1 artifact archiving does not yet update Contract authority or publish journey signals.

- [x] **Step 4: Publish verified e-sign signals transactionally**

Import `SubscriptionJourneySignalModule` into `ESignModule`. After callback authenticity and provider status are verified, persist task/contract state and `FADADA_TASK_COMPLETED` in the same transaction. Duplicate provider callbacks must return the prior result and not create new events.

- [x] **Step 5: Finalize signed artifact and archive Contract**

Extend `FadadaSignedArtifactService.archiveSignedContract` for Stage 1 contracts: download via authenticated provider call, validate non-empty PDF/checksum, store file metadata, record platform seal completion, set `Contract.fileId` and `Contract.status=ARCHIVED`, audit, and write `FADADA_ARTIFACT_ARCHIVED` atomically. On partial external failure, retain the job for reconciliation; never mark archived from callback payload alone.

- [x] **Step 6: Implement start/reconcile handlers and make tests GREEN**

`START_FADADA_SIGNING` creates/reuses the task and customer sign URL. `RECONCILE_FADADA_SIGNING` queries at 5 minutes, 30 minutes, then 6-hour cadence until archive or terminal exception. Raw sign URLs are returned only to the authenticated contract customer and never placed in events/logs.

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-esign.spec.ts test/esign.spec.ts test/fadada-archive.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: focused tests and typecheck pass; only archived artifacts advance the journey.

- [x] **Step 7: Commit real e-sign orchestration**

```powershell
git add apps/api/src/esign apps/api/src/subscription-journey/subscription-journey.handlers.ts apps/api/test/subscription-journey-esign.spec.ts apps/api/test/esign.spec.ts apps/api/test/fadada-archive.spec.ts
git commit -m "feat: archive journey contracts through fadada"
```

### Task 7: Initial billing and Portal WeChat JSAPI payment closure

**Files:**

- Modify: `apps/api/src/finance/finance.module.ts`
- Modify: `apps/api/src/finance/finance.service.ts`
- Modify: `apps/api/src/payment/payment-order.service.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.handlers.ts`
- Create: `apps/api/test/subscription-journey-payment.spec.ts`
- Modify: `apps/api/test/finance-billing.spec.ts`
- Modify: `apps/api/test/payment-settlement.spec.ts`
- Modify: `apps/api/test/portal-payment.spec.ts`

**Interfaces:**

- Consumes: archived Contract, `FinanceService.generateInitialBills`, Portal `PaymentOrderService.createPortalPaymentOrder`, verified WeChat Pay callback and `FinanceService.settlePaymentOrder`.
- Produces: idempotent initial bills, customer-payment wait state, transaction signal after real settlement, and bill-derived payment authority independent of auto-debit mandates.

```ts
generateInitialBillsInTransaction(
  tx: Prisma.TransactionClient,
  orderId: string,
  actorId: string,
  sourceKey: string
): Promise<ReceivableBill[]>;

evaluateInitialBillSettlement(
  tx: Prisma.TransactionClient,
  orderId: string
): Promise<{ paid: boolean; remainingAmount: bigint }>;
```

- [x] **Step 1: Write failing initial-billing tests**

Assert only an archived contract can generate deposit/first-period bills, retries reuse the existing bill source keys, amounts exactly match the final plan snapshot, and success advances to `CUSTOMER_JSAPI_PAYMENT` with `WAITING_CUSTOMER`.

- [x] **Step 2: Write failing JSAPI settlement authority tests**

Cover open PaymentOrder reuse, customer/order ownership, exact bill allocation, duplicate and out-of-order WeChat callbacks, partial payment, full settlement, overpayment handling under current finance policy, callback signature failure, and no raw callback leakage. Explicitly prove auto debit is irrelevant:

```ts
const config = { AUTO_DEBIT_ENABLED: "false", WECHAT_PAY_ENABLED: "true" };
await expect(createPortalJsapiOrder(config)).resolves.toMatchObject({
  provider: "WECHAT_PAY",
  tradeType: "JSAPI"
});
expect(await evaluateInitialBillSettlement(tx, order.id)).toEqual({
  paid: true,
  remainingAmount: 0n
});
expect(autoDebitMandateRepository.findFirst).not.toHaveBeenCalled();
```

- [x] **Step 3: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-payment.spec.ts test/finance-billing.spec.ts test/payment-settlement.spec.ts test/portal-payment.spec.ts
```

Expected: FAIL because transaction-scoped billing and journey settlement signals do not exist.

- [x] **Step 4: Extract transaction-scoped bill generation**

Keep `FinanceService.generateInitialBills` as a public wrapper. The inner method uses the caller transaction and stable bill source keys; journey handler writes bills, step/event/outbox and customer-wait state atomically. Do not synthesize a paid flag.

- [x] **Step 5: Publish settlement signals in the authoritative finance transaction**

Import only `SubscriptionJourneySignalModule` into `FinanceModule`. After Payment, allocation and WriteOff persistence succeeds, write `PAYMENT_SETTLED` with the provider transaction/event key in that same transaction. The journey handler locks all initial bills and advances only when every required bill has zero remaining amount or status `PAID` as derived by existing finance rules.

- [x] **Step 6: Make focused tests GREEN**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-payment.spec.ts test/finance-billing.spec.ts test/payment-settlement.spec.ts test/portal-payment.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: tests and typecheck pass with `AUTO_DEBIT_ENABLED=false`.

- [x] **Step 7: Commit billing and JSAPI payment closure**

```powershell
git add apps/api/src/finance apps/api/src/payment/payment-order.service.ts apps/api/src/subscription-journey/subscription-journey.handlers.ts apps/api/test/subscription-journey-payment.spec.ts apps/api/test/finance-billing.spec.ts apps/api/test/payment-settlement.spec.ts apps/api/test/portal-payment.spec.ts
git commit -m "feat: settle journey bills through jsapi payments"
```

### Task 8: Stage 2 handover creation, evidence readiness, and third manual decision

**Files:**

- Modify: `apps/api/src/handover-work-order/handover-work-order.module.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/api/src/delivery-evidence/delivery-evidence.module.ts`
- Modify: `apps/api/src/delivery-evidence/delivery-evidence.service.ts`
- Modify: `apps/api/src/delivery-handover/delivery-handover.service.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.handlers.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.module.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.repository.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey-signal.service.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.service.ts`
- Create: `apps/api/test/subscription-journey-handover.spec.ts`
- Modify: `apps/api/test/subscription-journey.repository.spec.ts`
- Modify: `apps/api/test/handover-work-order.spec.ts`
- Modify: `apps/api/test/delivery-evidence.spec.ts`

**Interfaces:**

- Consumes: fully settled initial bills, `HandoverWorkOrderService.createDraft`, Stage 2 field evidence/upload reconciliation, aggregate ops review methods and delivery readiness validation.
- Produces: idempotent Stage 2 handover bootstrap, evidence-ready signal and exactly one `DELIVERY_EVIDENCE_DECISION` manual task.

```ts
createJourneyHandoverInTransaction(
  tx: Prisma.TransactionClient,
  orderId: string,
  actorId: string,
  sourceKey: string
): Promise<HandoverWorkOrder>;

decideJourneyDeliveryEvidence(
  tx: Prisma.TransactionClient,
  workOrderId: string,
  decision: "APPROVED" | "REJECTED",
  actorId: string,
  notes?: string
): Promise<HandoverWorkOrder>;
```

- [x] **Step 1: Write failing handover bootstrap tests**

Assert full bill settlement creates/reuses one Stage 2 delivery work order, links it to the Journey/order, and advances to `DELIVERY_EVIDENCE_DECISION` only after the existing evidence-readiness validator passes. Partial payment, unarchived contract, missing insurance/inspection prerequisites and duplicate signals must not create duplicate work orders.

- [x] **Step 2: Write failing third-decision tests**

Map the aggregate ops review to the single journey manual task. Item-level capture/upload/reconciliation remains evidence preparation, not another journey decision. On approval, write aggregate review plus manual-task completion atomically and enqueue activation. On rejection, return to evidence preparation, retain an auditable rejection event, and reopen at most one task after new evidence becomes ready.

```ts
expect(manualTasks.map((task) => task.taskType)).toEqual([
  "FINAL_PLAN_DECISION",
  "FINAL_VEHICLE_ALLOCATION",
  "DELIVERY_EVIDENCE_DECISION"
]);
expect(manualTasks.filter((task) => task.status === "OPEN")).toHaveLength(1);
```

- [x] **Step 3: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-handover.spec.ts test/handover-work-order.spec.ts test/delivery-evidence.spec.ts
```

Expected: FAIL because journey handover adapters/signals do not exist.

- [x] **Step 4: Add transaction-scoped handover adapters and signals**

Import `SubscriptionJourneySignalModule` in `HandoverWorkOrderModule`. Refactor existing public operations to delegate to transaction-aware inner methods. Publish `HANDOVER_EVIDENCE_READY` only after the readiness validator passes and `HANDOVER_OPS_REVIEWED` in the same transaction as aggregate approval/rejection.

- [x] **Step 5: Implement journey handlers and make tests GREEN**

The creation handler must use a stable source key. The evidence handler must call existing Stage 2 validators rather than copy their rules. A rejection is not a technical exception and must not consume job retry attempts.

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-handover.spec.ts test/handover-work-order.spec.ts test/delivery-evidence.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: focused tests/typecheck pass and the journey history contains exactly three internal manual decision types.

- [x] **Step 6: Commit Stage 2 handover orchestration**

```powershell
git add apps/api/src/handover-work-order apps/api/src/delivery-evidence apps/api/src/subscription-journey/subscription-journey.handlers.ts apps/api/test/subscription-journey-handover.spec.ts apps/api/test/handover-work-order.spec.ts apps/api/test/delivery-evidence.spec.ts
git commit -m "feat: orchestrate journey handover evidence"
```

### Task 9: Authoritative activation transaction and legacy delivery hardening

**Files:**

- Modify: `apps/api/src/lease/lease-activation.engine.ts`
- Modify: `apps/api/src/lease/lease-activation.types.ts`
- Modify: `apps/api/src/lease/lease.module.ts`
- Modify: `apps/api/src/order/delivery-confirmation-gate-lock.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Modify: `apps/api/src/order/dto/order.dto.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.handlers.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.module.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.repository.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.service.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.types.ts`
- Create: `apps/api/test/subscription-journey-activation.spec.ts`
- Modify: `apps/api/test/subscription-journey.repository.spec.ts`
- Modify: `apps/api/test/lease-activation.spec.ts`
- Modify: `apps/api/test/order-delivery.spec.ts`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`

**Interfaces:**

- Consumes: authoritative archived contract, paid initial bills, approved Stage 2 evidence/ops review, mileage, inspection, insurance, reserved vehicle, billing schedule and entitlement service.
- Produces: one shared, transaction-scoped activation gate used by both Journey and the legacy delivery endpoint.

```ts
evaluateInTransaction(
  tx: Prisma.TransactionClient,
  orderId: string
): Promise<LeaseActivationEvaluation>;

activateFromAuthoritativeHandover(
  tx: Prisma.TransactionClient,
  input: { orderId: string; actorId: string; journeyId?: string }
): Promise<SubscriptionActivationResult>;
```

- [x] **Step 1: Write failing authority-gate tests**

Individually reject Contract `SIGNED` without archived PDF, any unpaid/partially paid required bill, manual money booleans without Payment/WriteOff, unapproved evidence, missing inspection, lapsed insurance, mismatched vehicle, and missing delivery mileage. Assert stable blocker codes and no partial writes.

- [x] **Step 2: Write failing atomic-success and retry tests**

On success assert one transaction produces:

```ts
expect(result).toMatchObject({
  orderStatus: "ACTIVE",
  vehicleStatus: "LEASED",
  leaseStatus: "ACTIVE",
  deliveryStatus: "DELIVERED",
  journeyStatus: "COMPLETED"
});
expect(await countActiveBillingSchedules(order.id)).toBe(1);
expect(await countInitialEntitlements(order.id)).toBeGreaterThan(0);
expect(await countEvents(journey.id, "JOURNEY_COMPLETED")).toBe(1);
```

Retry the activation job and assert all records remain singular. Force a write failure after Vehicle update and assert Order, Vehicle, Delivery, Lease, BillingSchedule, entitlements and Journey all roll back.

- [x] **Step 3: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-activation.spec.ts test/lease-activation.spec.ts test/order-delivery.spec.ts
```

Expected: FAIL because existing activation accepts `SIGNED`, assumes delivery already completed, and does not atomically update all aggregates.

- [x] **Step 4: Implement one authoritative transaction gate**

Use row locks on Journey, Order, VehicleDelivery, Vehicle and Lease. Derive delivery facts from the approved Stage 2 work order/evidence. Require `Contract.status=ARCHIVED` and stored signed artifact. Derive money from bills/allocations/write-offs only. Call `ensureActiveSchedule` and `ensureInitialEntitlements` with the same transaction. Write sanitized AuditLog, `JOURNEY_COMPLETED` event and notification outbox before commit.

- [x] **Step 5: Harden the legacy delivery endpoint**

Remove `depositReceivedConfirmed` and `firstMonthlyFeeReceivedConfirmed` from new request DTO acceptance and frontend contract typing. Keep database fields readable for old records. Make `OrderService.confirmDelivery` delegate to the authoritative gate; for a Journey order, reject direct manual progression unless the caller uses an audited recovery action and all facts pass.

- [x] **Step 6: Make focused tests GREEN**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-activation.spec.ts test/lease-activation.spec.ts test/order-delivery.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: all focused tests/typecheck pass and failure injection proves atomic rollback.

- [x] **Step 7: Commit the activation authority boundary**

```powershell
git add apps/api/src/lease apps/api/src/order apps/api/src/subscription-journey/subscription-journey.handlers.ts apps/api/test/subscription-journey-activation.spec.ts apps/api/test/lease-activation.spec.ts apps/api/test/order-delivery.spec.ts
git commit -m "feat: activate subscriptions from authoritative facts"
```

### Task 10: Admin journey API, recovery controls, metrics, and audit contract

**Files:**

- Create: `apps/api/src/subscription-journey/subscription-journey.dto.ts`
- Create: `apps/api/src/subscription-journey/subscription-journey.controller.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.service.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.module.ts`
- Modify: `apps/api/src/order/dto/order.dto.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Create: `apps/api/test/subscription-journey-controller.spec.ts`
- Create: `apps/api/test/subscription-journey-recovery.spec.ts`
- Modify: `apps/api/test/permissions.spec.ts`

**Interfaces:**

- Consumes: journey repository, three decision handlers, job/exception records, AuditLog and Orders list filtering.
- Produces: permission-guarded Admin projections/actions, exception filtering and automation metrics without a new top-level domain page.

- [x] **Step 1: Write failing controller/RBAC contract tests**

Add routes:

```text
GET  /subscription-journeys/by-application/:applicationId
GET  /subscription-journeys/by-order/:orderId
GET  /subscription-journeys?status=EXCEPTION
GET  /subscription-journeys/metrics
POST /subscription-journeys/:id/final-plan-decision
POST /subscription-journeys/:id/vehicle-allocation
POST /subscription-journeys/:id/delivery-evidence-decision
POST /subscription-journeys/:id/retry
POST /subscription-journeys/:id/pause
POST /subscription-journeys/:id/resume
POST /subscription-journeys/:id/cancel
```

Assert view, task-specific decision, recover and cancel permissions on the exact methods. DTOs reject unknown fields, stale `version`, empty rejection reason and cross-task payloads. Sensitive event payload fields must not appear in responses.

- [x] **Step 2: Write failing recovery and metrics tests**

Recovery rules: retry only DEAD_LETTER/OPEN exception work; pause preserves prior status; resume re-evaluates facts before enqueue; cancel is terminal and releases only journey-owned reservations safely. Every action requires optimistic version and AuditLog. Metrics return counts by journey/step/status, open exception age, retry count and automated progress rate; they must not count customer waiting as failure.

- [x] **Step 3: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-controller.spec.ts test/subscription-journey-recovery.spec.ts test/permissions.spec.ts
```

Expected: FAIL because the controller, DTOs and recovery methods do not exist.

- [x] **Step 4: Implement safe projections and actions**

Return journey header, ordered steps, current/open task, sanitized exceptions, customer next action and available operator actions computed from status plus permission. Never return provider secrets, raw callbacks or complete identity/payment payloads. Use the existing audit context conventions for IP, user agent and request ID.

- [x] **Step 5: Add Orders exception filtering and make tests GREEN**

Extend the existing order list DTO/service with optional `journeyStatus`; join/filter only when supplied so normal list performance remains unchanged. Add an index-backed query test for `EXCEPTION`.

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-controller.spec.ts test/subscription-journey-recovery.spec.ts test/permissions.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: focused tests/typecheck pass and each route has an explicit permission guard.

- [x] **Step 6: Commit Admin API and recovery controls**

```powershell
git add apps/api/src/subscription-journey apps/api/src/order/dto/order.dto.ts apps/api/src/order/order.service.ts apps/api/test/subscription-journey-controller.spec.ts apps/api/test/subscription-journey-recovery.spec.ts apps/api/test/permissions.spec.ts
git commit -m "feat: expose journey operations and recovery api"
```

### Task 11: Incremental Admin application and order-workspace UI

**Files:**

- Create: `apps/web/src/lib/subscription-journey-view-model.ts`
- Create: `apps/web/src/components/subscription-journey/application-journey-actions.tsx`
- Create: `apps/web/src/components/order-workspace/subscription-journey-card.tsx`
- Create: `apps/web/src/components/order-workspace/subscription-journey-exception-actions.tsx`
- Modify: `apps/web/src/app/applications/[id]/page.tsx`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Modify: `apps/web/src/app/orders/page.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/test/subscription-journey-view-model.spec.ts`
- Create: `apps/web/test/subscription-journey-admin-ui.spec.tsx`
- Modify: `apps/web/test/action-guards.spec.ts`

**Interfaces:**

- Consumes: Task 10 API projection and current application/order pages.
- Produces: embedded journey timeline/status, three permission-aware decision actions, exception recovery, and the existing Orders-page exception filter.

- [x] **Step 1: Write failing view-model tests**

Test Chinese labels/colors for every journey and step status, current-step summary, safe exception message mapping, three manual-task input shapes, customer-wait labels, next recommended operator action and unavailable-action reasons. Unknown backend codes display a safe generic label, never raw error text.

- [x] **Step 2: Write failing component and permission tests**

Render application/order components with no permission, view only, each decision permission, recover and cancel. Assert buttons are hidden/disabled correctly, stale-version `409` triggers refetch, retry confirmation names the failed step, and cancel requires an explicit reason. Assert no top-level navigation item is added.

- [x] **Step 3: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/subscription-journey-view-model.spec.ts test/subscription-journey-admin-ui.spec.tsx test/action-guards.spec.ts
```

Expected: FAIL because journey UI/view model does not exist.

- [x] **Step 4: Implement focused components and API client methods**

Keep page changes limited to imports, query hooks and one card insertion. `application-journey-actions.tsx` owns final-plan and vehicle-allocation forms. The order-workspace card owns timeline/current state; exception actions are a separate component. Do not add journey state logic to the already-large page files.

- [x] **Step 5: Hide conflicting legacy progression on Journey records**

For Journey-backed applications/orders, hide manual “create order”, “mark paid”, manual contract sign/archive and direct delivery activation actions. Non-journey records keep existing buttons. Show a read-only legacy delivery confirmation field only when old data exists; never offer new writes.

- [x] **Step 6: Implement Orders exception filter and make tests GREEN**

Read `journeyStatus=EXCEPTION` from the URL, pass it to the existing order query and show a removable filter chip. Reuse current table/page; do not create a separate exception page.

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/subscription-journey-view-model.spec.ts test/subscription-journey-admin-ui.spec.tsx test/action-guards.spec.ts
pnpm --filter @subscription-saas/web typecheck
```

Expected: focused tests/typecheck pass and the UI remains incremental.

- [x] **Step 7: Commit incremental Admin UI**

```powershell
git add apps/web/src/lib/subscription-journey-view-model.ts apps/web/src/lib/api.ts apps/web/src/components/subscription-journey apps/web/src/components/order-workspace apps/web/src/app/applications/[id]/page.tsx apps/web/src/app/orders apps/web/test/subscription-journey-view-model.spec.ts apps/web/test/subscription-journey-admin-ui.spec.tsx apps/web/test/action-guards.spec.ts
git commit -m "feat: show subscription journeys in admin workspace"
```

### Task 12: Portal next-action guidance and WeChat Official Account notifications

**Files:**

- Create: `apps/api/src/subscription-journey/portal-subscription-journey.controller.ts`
- Create: `apps/api/src/subscription-journey/subscription-journey-notification.service.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.module.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.handlers.ts`
- Create: `apps/api/test/portal-subscription-journey.spec.ts`
- Create: `apps/api/test/subscription-journey-notification.spec.ts`
- Create: `apps/web/src/lib/portal-journey-view-model.ts`
- Create: `apps/web/src/components/portal/portal-journey-next-action-card.tsx`
- Modify: `apps/web/src/app/portal/applications/[id]/page.tsx`
- Modify: `apps/web/src/app/portal/orders/[id]/page.tsx`
- Modify: `apps/web/src/app/portal/contracts/[id]/page.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/test/portal-journey-view-model.spec.ts`
- Create: `apps/web/test/portal-journey-pages.spec.tsx`

**Interfaces:**

- Consumes: customer ownership guards, exact plan revision, existing Fadada signing page, bill/payment pages and NotificationService.
- Produces: customer-safe journey projection, one current-action card and idempotent official-account notifications.

- [x] **Step 1: Write failing Portal API ownership and redaction tests**

Add:

```text
GET /portal/subscription-journeys/by-application/:applicationId
GET /portal/subscription-journeys/by-order/:orderId
```

Assert the authenticated customer can read only their own Journey. Projection contains current action, safe status, final plan revision, contract/order/bill links and customer-facing blocker text; it excludes internal notes, audit actors, retry stack/provider payload and other customer identifiers.

- [x] **Step 2: Write failing notification tests**

Send only on transitions requiring customer action: exact-plan confirmation, Fadada signature, JSAPI payment and handover appointment/evidence cooperation. Use event key plus customer plus template as idempotency key. In production, provider must be `wechat_official_account`; provider failure creates/retries `DISPATCH_NOTIFICATION` but does not roll back an already committed domain transition.

- [x] **Step 3: Write failing Portal view-model/page tests**

Assert one primary CTA at a time:

```ts
expect(nextAction({ step: "CUSTOMER_PLAN_CONFIRMATION" }).href).toBe(
  `/portal/applications/${applicationId}`
);
expect(nextAction({ step: "FADADA_SIGNING_AND_ARCHIVE" }).href).toBe(
  `/portal/contracts/${contractId}/sign`
);
expect(nextAction({ step: "CUSTOMER_JSAPI_PAYMENT" }).href).toBe(`/portal/orders/${orderId}#bills`);
```

Also test waiting-internal, retry, exception-support and completed displays. The confirmation request sends the displayed `finalPlanRevision`.

- [x] **Step 4: Run all focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-subscription-journey.spec.ts test/subscription-journey-notification.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/portal-journey-view-model.spec.ts test/portal-journey-pages.spec.tsx
```

Expected: FAIL because Portal projection, notification adapter and next-action card do not exist.

- [x] **Step 5: Implement customer-safe API and notifications**

Use existing customer session/ownership guards. Dispatch only sanitized template variables and store notification delivery state through existing `NotificationEvent`. Never send Fadada sign URL or payment credentials through notification text; link to authenticated Portal routes.

- [x] **Step 6: Implement the shared Portal next-action card**

Embed the same small card in application, order and contract pages. Reuse existing contract-sign and bill/payment components; do not duplicate signing or JSAPI invocation. Poll/refetch only while a provider callback is expected, with bounded interval and page-visibility checks.

- [x] **Step 7: Make tests GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-subscription-journey.spec.ts test/subscription-journey-notification.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/portal-journey-view-model.spec.ts test/portal-journey-pages.spec.tsx
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
git add apps/api/src/subscription-journey apps/api/test/portal-subscription-journey.spec.ts apps/api/test/subscription-journey-notification.spec.ts apps/web/src/lib apps/web/src/components/portal apps/web/src/app/portal apps/web/test/portal-journey-view-model.spec.ts apps/web/test/portal-journey-pages.spec.tsx
git commit -m "feat: guide customers through subscription journeys"
```

### Task 13: Production fail-closed configuration, preflight, and acceptance runbook

**Files:**

- Modify: `.env.example`
- Modify: `.env.production.example`
- Modify: `.env.production.images.example`
- Modify: `apps/api/.env.production.example`
- Modify: `docker-compose.production.images.example.yml`
- Modify: `package.json`
- Create: `scripts/stage1-golden-path-production-preflight.mjs`
- Create: `scripts/stage1-golden-path-production-preflight.test.mjs`
- Create: `docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md`
- Modify: `scripts/release-check.mjs`

**Interfaces:**

- Consumes: production environment variables, health/API endpoints, Fadada production preflight scripts, WeChat Pay/OA configuration and Journey metrics.
- Produces: a secret-safe fail-closed preflight and a concrete production acceptance procedure using dedicated test assets.

- [x] **Step 1: Write failing preflight tests**

Export a pure `validateStage1GoldenPathPreflight(env)` and test these blockers independently:

- Journey or worker disabled; empty allowlist.
- `ESIGN_PROVIDER` not `fadada`, `FADADA_ENV` not `production`, non-production Fadada host, missing callback/return URL or missing test signer/customer/template IDs.
- `WECHAT_PAY_ENABLED` not true, trade type not JSAPI, missing production notify URL or missing authorized test payer OpenID.
- `NOTIFICATION_PROVIDER` not `wechat_official_account`.
- `AUTO_DEBIT_ENABLED` true during this acceptance phase.
- Missing dedicated non-operational test vehicle/application or missing controlled payment/refund limits.

Assert output masks IDs/secrets and never prints values for names matching `SECRET`, `KEY`, `CERT`, `PASSWORD`, `OPENID` or `TOKEN`.

- [x] **Step 2: Run the preflight test and confirm RED**

```powershell
node --test scripts/stage1-golden-path-production-preflight.test.mjs
```

Expected: FAIL because the script does not exist.

- [x] **Step 3: Implement fail-closed configuration and script**

Add scripts:

```json
{
  "stage1:golden-path:preflight": "node scripts/stage1-golden-path-production-preflight.mjs",
  "stage1:golden-path:preflight:test": "node --test scripts/stage1-golden-path-production-preflight.test.mjs"
}
```

Production examples must show real provider names, `SUBSCRIPTION_JOURNEY_ENABLED=false` until rollout, worker disabled until migration/deploy succeeds, empty allowlists, `AUTO_DEBIT_ENABLED=false`, and no secret values. Compose passes every required Journey variable explicitly. The script validates configuration and read-only health/readiness endpoints only; it must not create customers, orders, contracts or payments.

- [x] **Step 4: Write the production acceptance runbook**

The runbook must specify, in order:

1. Confirm backup, migration status, deploy version, worker heartbeat and rollback owner.
2. Configure a dedicated authorized signer/customer, authorized payer OpenID, non-operational vehicle, production test contract template, Journey allowlist and maximum controlled payment amount.
3. Run the existing Fadada production signer and upload/sign-url preflights.
4. Run A-line once and B-line once through the same steps; do not reuse the same Application.
5. Observe exactly three internal manual decisions per Journey.
6. Complete real Fadada signing/seal/archive and verify the stored PDF checksum.
7. Make one minimum controlled real JSAPI payment, verify bill allocation/write-off, then perform the approved refund/reconciliation procedure.
8. Complete Stage 2 evidence review and authoritative activation using the non-operational vehicle.
9. Export sanitized journey IDs, step timestamps, provider transaction references, bill/payment/write-off references, audit events and metric snapshots; retain server-side audit data, not PII in the runbook.
10. On any blocker, disable new enrollment, leave workers available for already-enrolled safe recovery only, and follow the documented retry/cancel path.

- [x] **Step 5: Extend release checks and make tests GREEN**

Make `release-check.mjs` fail production-image configs that enable Journey with mock/sandbox providers or omit allowlists; also fail if Golden Path acceptance config enables auto debit.

```powershell
pnpm stage1:golden-path:preflight:test
pnpm fadada:upload-signurl:test
pnpm fadada:production-test-signer-realname:test
pnpm release:check
```

Expected: script tests and release check pass without contacting production.

- [x] **Step 6: Commit production safety artifacts**

```powershell
git add .env.example .env.production.example .env.production.images.example apps/api/.env.production.example docker-compose.production.images.example.yml package.json scripts/stage1-golden-path-production-preflight.mjs scripts/stage1-golden-path-production-preflight.test.mjs scripts/release-check.mjs docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md
git commit -m "ops: gate stage1 golden path production acceptance"
```

### Task 14: End-to-end Golden Path proof, regression gate, and production acceptance

**Files:**

- Create: `apps/api/test/subscription-journey-golden-path.e2e-spec.ts`
- Create: `apps/api/test/subscription-journey-failure-recovery.e2e-spec.ts`
- Create: `apps/web/test/subscription-journey-golden-path.spec.tsx`
- Modify: `apps/api/src/subscription-journey/subscription-journey.repository.ts`
- Modify: `apps/api/test/subscription-journey.repository.spec.ts`
- Modify: `apps/api/vitest.config.ts`
- Modify: `apps/web/src/lib/portal-journey-view-model.ts`
- Modify: `docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md`

**Interfaces:**

- Consumes: all prior tasks, a disposable local integration database for automated tests, and approved dedicated production acceptance assets for the final live run.
- Produces: automated A/B parity proof, failure-recovery proof, complete regression evidence and a sanitized production acceptance checklist update.

- [x] **Step 1: Write the full failing A/B Golden Path integration test**

Parameterize `source` over Portal self-service A and Admin-assisted B. Use real database rows and deterministic fake external adapters only in automated tests. Drive:

```text
submit → validate → final plan decision → exact revision confirmation
→ vehicle allocation → order/contract → Fadada signed+sealed+archived
→ initial bills → JSAPI callback settlement → Stage 2 handover/evidence
→ evidence decision → atomic activation → completed
```

Assert identical step sequences, three internal manual task types, one order/contract/lease/schedule, paid bill authority, archived PDF metadata, Journey completion, AuditLog coverage, and no auto-debit mandate/attempt.

- [x] **Step 2: Write the failing recovery matrix test**

Inject failures at Fadada start, Fadada archive storage, bill generation, payment callback duplication, handover creation, evidence rejection, activation prerequisite and worker lease expiry. Assert retry delay/classification, no duplicate business objects, open exception projection, manual retry/resume behavior, safe cancellation and recovery to completion where permitted.

- [x] **Step 3: Write the failing UI journey test**

Render representative Admin and Portal states from start through completion. Assert only the relevant action appears, permissions apply, raw provider/payment errors remain hidden, and Journey orders never expose legacy manual-paid or direct-activation buttons.

- [x] **Step 4: Run focused tests and make them GREEN**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-golden-path.e2e-spec.ts test/subscription-journey-failure-recovery.e2e-spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/subscription-journey-golden-path.spec.tsx
```

Expected: both A/B flows complete with the same ordered steps and all recovery assertions pass.

- [x] **Step 5: Run the full local quality and migration gate**

```powershell
git status --short --branch
pnpm prisma:migrate:status
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/shared test
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
pnpm -r lint
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
pnpm build
pnpm stage1:golden-path:preflight:test
pnpm release:check
```

Expected: clean migration status; all tests, lint, typechecks, build and release checks pass. Record any unrelated pre-existing failure separately and do not claim completion until the Golden Path-specific suites pass.

- [x] **Step 6: Commit end-to-end proof**

```powershell
git add apps/api/src/subscription-journey/subscription-journey.repository.ts apps/api/test/subscription-journey.repository.spec.ts apps/api/test/subscription-journey-golden-path.e2e-spec.ts apps/api/test/subscription-journey-failure-recovery.e2e-spec.ts apps/api/vitest.config.ts apps/web/src/lib/portal-journey-view-model.ts apps/web/test/subscription-journey-golden-path.spec.tsx docs/runbooks/stage1-golden-path-production-acceptance.zh-CN.md docs/superpowers/plans/2026-08-06-stage1-golden-path-orchestration-implementation-plan.md
git commit -m "test: prove stage1 subscription golden path"
```

- [ ] **Step 7: Execute production preflight and controlled acceptance**

After code review, deployment, migration and explicit production rollout approval, follow the runbook exactly:

```powershell
pnpm stage1:golden-path:preflight
pnpm fadada:test-signer:preflight
pnpm fadada:upload-signurl:preflight
```

Then enable only the dedicated allowlist, enable worker, execute one A-line and one B-line Journey, perform the controlled real Fadada signing and minimum JSAPI payment/refund, and capture sanitized evidence. Acceptance passes only when both journeys reach `COMPLETED`, each has exactly three internal manual decisions, the archived PDF and payment/write-off are authoritative, Stage 2 evidence is approved, and no mandate/auto-debit capability was required.

- [ ] **Step 8: Close rollout safely**

If acceptance passes, keep rollout limited to the approved allowlist until metrics are reviewed. If it fails, disable new enrollment, preserve all Journey/job/outbox/audit rows, reconcile the controlled payment/refund, release or quarantine the test vehicle as the runbook specifies, and use audited recovery rather than direct database edits.
