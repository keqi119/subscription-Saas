# Stage 1B Contract Extension and Renewal Consideration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付仅面向原车原订单协议延长的完整闭环，包括到期前续订考虑期、不可变报价、续期补充协议、分段生效，以及未按期完成时自动进入退车。

**Architecture:** 新增独立 `subscription-change` 领域模块，使用追加式报价、不可变合同分段和续订考虑期作为权威事实；现有合同、电子签、账单、权益、通知和退车模块通过窄接口接入。旧 `OrderChange` 保留历史读取但拒绝新建 `EXTENSION`，原 `SubscriptionOrder.endDate` 和主合同永不改写。

**Tech Stack:** NestJS 11、Prisma 7/PostgreSQL、Vitest 4、Next.js 16/React 19、Ant Design 6、TypeScript 6、pnpm 11。

## Global Constraints

- 批准设计：`docs/superpowers/specs/2026-08-05-stage1b-contract-extension-renewal-design.zh-CN.md`。
- 首批唯一业务类型是 `SubscriptionChangeType.EXTENSION`；不实现换车、套餐变更、提前解约、买断或到期后补签。
- 业务时区固定为 `Asia/Shanghai`；`date` 保存合同日期，`timestamptz` 保存任务和审计时间。
- 所有金额使用分和 `BigInt`，不得使用浮点金额。
- 原 `SubscriptionOrder.endDate`、原主合同、原报价和已确认报价不可变。
- 续期必须在当前末分段结束日次日 00:00 前完成签署、归档和分段事务；到期后无留车期。
- 使用增量 migration，不修改历史 migration，不执行 `migrate reset`。
- 每个行为改动严格执行 RED → GREEN → REFACTOR，并在任务边界独立提交。
- 每轮先运行 `git status --short --branch`、`pnpm prisma:migrate:status`、`pnpm prisma:validate`；发现非本任务改动或待执行迁移时停止处理。
- 功能开关 `SUBSCRIPTION_EXTENSION_ENABLED` 默认 `false`；短信模板缺失必须记录明确失败，不能伪装成功。
- 自动任务、客户决定、价格审批、签署归档、状态转换、重试与人工接管全部写审计。

---

### Task 1: Domain schema, migration, permissions, and enum contracts

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260805120000_stage1b_contract_extension_renewal/migration.sql`
- Modify: `apps/api/prisma/seed.mjs`
- Modify: `packages/shared/src/auth.ts`
- Modify: `packages/shared/test/auth.spec.ts`
- Modify: `apps/web/src/constants/labels.ts`
- Modify: `apps/web/src/lib/contract-version-form.ts`
- Create: `apps/api/test/subscription-change-schema.spec.ts`
- Modify: `apps/api/test/permissions.spec.ts`

**Interfaces:**

- Consumes: existing `SubscriptionOrder`, `Contract`, `ContractVersion`, `BillingSchedule`, `SubscriptionAutomationJob`, `VehicleReturn`, `NotificationEvent`, and RBAC seed patterns.
- Produces: Prisma models/enums for `SubscriptionChangeOrder`, `SubscriptionChangeQuote`, `SubscriptionContractSegment`, `RenewalConsideration`, and `RenewalReminder`; `PermissionCode.SUBSCRIPTION_CHANGE_*`; Stage 3 extension contract/e-sign enum values.

- [x] **Step 1: Write the failing schema and RBAC contract tests**

Create `apps/api/test/subscription-change-schema.spec.ts` with DMMF/schema assertions covering all five models, enum values, foreign keys, append-only quote revision, job relations, renewal automation job types, `NotificationType.RENEWAL_REMINDER/RENEWAL_EXPIRY_RETURN/RENEWAL_RETURN_OVERDUE`, matching `NotificationTemplateType` values, `NotificationEventType.RENEWAL_REMINDER_D30/RENEWAL_REMINDER_D14/RENEWAL_REMINDER_D3/RENEWAL_EXPIRED/RENEWAL_RETURN_OVERDUE_D1`, `PENDING_RETURN`, `RETURN_DUE`, `SUBSCRIPTION_EXTENSION`, and Stage 3 e-sign identifiers. Extend permission tests with the exact nine codes and role matrix:

```ts
expect(PermissionCode.SUBSCRIPTION_CHANGE_VIEW).toBe("subscription_change:view");
expect(rolePermissions.ADMIN).toEqual(
  expect.arrayContaining(Object.values(subscriptionChangePermissions))
);
expect(rolePermissions.OP).toEqual(
  expect.arrayContaining([
    "subscription_change:view",
    "subscription_change:create",
    "subscription_change:quote",
    "subscription_change:submit",
    "subscription_change:esign_retry",
    "subscription_change:execute",
    "subscription_change:cancel"
  ])
);
expect(rolePermissions.OP).not.toContain("subscription_change:price_override_approve");
expect(rolePermissions.OP).not.toContain("subscription_change:manual_takeover");
```

- [x] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-change-schema.spec.ts test/permissions.spec.ts
pnpm --filter @subscription-saas/shared exec vitest run test/auth.spec.ts
```

Expected: FAIL because the models, enum values, and permission constants do not exist.

- [x] **Step 3: Add schema models and database constraints**

Implement the exact enums and fields from design sections 5.1–5.6. The migration must include:

```sql
CREATE UNIQUE INDEX "subscription_change_order_one_active_per_order"
ON "subscription_change_order" ("order_id")
WHERE "status" IN ('DRAFT','QUOTED','CUSTOMER_CONFIRMED','SIGNING_OR_PAYMENT','SCHEDULED','EXECUTING','MANUAL_TAKEOVER');

CREATE UNIQUE INDEX "subscription_contract_segment_one_base_per_order"
ON "subscription_contract_segment" ("order_id")
WHERE "segment_type" = 'BASE';

CREATE UNIQUE INDEX "subscription_contract_segment_one_active_per_order"
ON "subscription_contract_segment" ("order_id")
WHERE "status" = 'ACTIVE';

ALTER TABLE "subscription_change_order"
ADD CONSTRAINT "subscription_change_order_extension_months_positive"
CHECK ("extension_months" > 0);

ALTER TABLE "subscription_contract_segment"
ADD CONSTRAINT "subscription_contract_segment_dates_valid"
CHECK ("end_date" >= "start_date");
```

Also add unique constraints for `(change_order_id, revision)`, `source_change_order_id`, `(order_id, sequence_no)`, `renewal_consideration.segment_id`, and `(renewal_consideration_id, slot)`. Add optional `changeOrderId`, `contractSegmentId`, and `renewalConsiderationId` relations to `SubscriptionAutomationJob`.

- [x] **Step 4: Add shared permissions, seed assignments, menu seed, and labels**

Add the nine approved codes to `PermissionCode`; seed ADMIN with all, OP with the seven approved operational permissions, and SA/AS with view only. Add an Admin menu entry `orders.subscription_changes` at `/subscription-changes` guarded by `subscription_change:view`. Add Chinese labels for every new status, pricing mode, segment type, and contract template type.

- [x] **Step 5: Apply and validate the migration**

Run:

```powershell
pnpm prisma:migrate:deploy
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec vitest run test/subscription-change-schema.spec.ts test/permissions.spec.ts
pnpm --filter @subscription-saas/shared exec vitest run test/auth.spec.ts
```

Expected: migration is applied, Prisma validates, and all focused tests PASS.

- [x] **Step 6: Commit the schema boundary**

```powershell
git add apps/api/prisma packages/shared/src/auth.ts packages/shared/test/auth.spec.ts apps/web/src/constants/labels.ts apps/web/src/lib/contract-version-form.ts apps/api/test/subscription-change-schema.spec.ts apps/api/test/permissions.spec.ts
git commit -m "feat: add contract extension domain schema"
```

### Task 2: Contract segment resolver and BASE bootstrap

**Files:**

- Create: `apps/api/src/subscription-change/subscription-change.types.ts`
- Create: `apps/api/src/subscription-change/subscription-change.errors.ts`
- Create: `apps/api/src/subscription-change/contract-segment.service.ts`
- Create: `apps/api/src/subscription-change/contract-segment.module.ts`
- Create: `apps/api/src/subscription-change/subscription-change.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/contract-segment.service.spec.ts`
- Create: `apps/api/test/contract-segment.integration.spec.ts`

**Interfaces:**

- Consumes: Task 1 Prisma models and original order/main-contract snapshots.
- Produces:

```ts
export interface ContractSegmentTerms {
  segmentId: string;
  startDate: Date;
  endDate: Date;
  monthlyFeeAmount: bigint;
  mileageLimitKm: number;
  overMileageFeeAmount: bigint;
  planSnapshot: Prisma.JsonValue;
}

export class ContractSegmentService {
  ensureBaseSegment(orderId: string, actorId?: string): Promise<SubscriptionContractSegment>;
  resolveEffectiveServiceEndDate(orderId: string): Promise<Date | null>;
  resolveSegmentForPeriod(orderId: string, periodStart: Date): Promise<ContractSegmentTerms>;
  assertAppendableExtension(sourceSegmentId: string, startDate: Date, endDate: Date): Promise<void>;
}
```

- [x] **Step 1: Write failing unit tests for date and snapshot invariants**

Cover idempotent BASE creation, fallback read before bootstrap, missing original dates, unarchived main contract, incomplete plan snapshot, adjacent EXTENSION validation, overlap rejection, and period-to-segment resolution:

```ts
await expect(service.ensureBaseSegment(order.id)).resolves.toMatchObject({
  segmentType: "BASE",
  sequenceNo: 1,
  startDate: order.startDate,
  endDate: order.endDate
});
await service.ensureBaseSegment(order.id);
expect(prisma.subscriptionContractSegment.create).toHaveBeenCalledTimes(1);
await expect(
  service.assertAppendableExtension(base.id, date("2026-09-04"), date("2027-03-03"))
).rejects.toMatchObject({ code: "CONTRACT_SEGMENT_NOT_CONTIGUOUS" });
```

- [x] **Step 2: Run the segment tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/contract-segment.service.spec.ts test/contract-segment.integration.spec.ts
```

Expected: FAIL because the module and service do not exist.

- [x] **Step 3: Implement focused segment service and typed errors**

Use a serializable transaction/advisory row lock around bootstrap and append validation. `ensureBaseSegment` must copy `startDate`, `endDate`, `monthlyFeeAmount`, entitlement terms, `finalPlanSnapshot`, `quoteSnapshot`, and archived main-contract snapshot without updating the order. Throw stable errors such as `BASE_SEGMENT_SOURCE_INCOMPLETE`, `CONTRACT_SEGMENT_OVERLAP`, and `CONTRACT_SEGMENT_NOT_CONTIGUOUS`. `ContractSegmentModule` exports only `ContractSegmentService`; `SubscriptionChangeModule` imports that module, so billing can later consume the resolver without a circular dependency.

- [x] **Step 4: Wire the module and run GREEN tests**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/contract-segment.service.spec.ts test/contract-segment.integration.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: focused tests and typecheck PASS.

- [x] **Step 5: Commit the segment source of truth**

```powershell
git add apps/api/src/subscription-change apps/api/src/app.module.ts apps/api/test/contract-segment.service.spec.ts apps/api/test/contract-segment.integration.spec.ts
git commit -m "feat: add subscription contract segments"
```

### Task 3: Extension drafts, append-only quotes, pricing approvals, and Admin API

**Files:**

- Create: `apps/api/src/subscription-change/subscription-change.config.ts`
- Create: `apps/api/src/subscription-change/subscription-change.dto.ts`
- Create: `apps/api/src/subscription-change/subscription-extension-pricing.service.ts`
- Create: `apps/api/src/subscription-change/subscription-extension.service.ts`
- Create: `apps/api/src/subscription-change/subscription-change.controller.ts`
- Modify: `apps/api/src/subscription-change/subscription-change.module.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/.env.production.example`
- Create: `apps/api/test/subscription-extension-pricing.spec.ts`
- Create: `apps/api/test/subscription-change.service.spec.ts`
- Create: `apps/api/test/subscription-change.controller.spec.ts`
- Modify: `apps/api/test/order-change-execute.spec.ts`

**Interfaces:**

- Consumes: `ContractSegmentService` from Task 2, existing quote calculation primitives, Auth/Audit modules, and Task 1 permissions.
- Produces:

```ts
export interface ExtensionQuotePreview {
  pricingMode: SubscriptionChangePricingMode;
  targetStartDate: Date;
  targetEndDate: Date;
  monthlyFeeAmount: bigint;
  planSnapshot: Prisma.JsonValue;
  priceRuleSnapshot: Prisma.JsonValue;
}

export class SubscriptionExtensionService {
  createExtension(
    input: CreateExtensionInput,
    actor: RequestUser,
    context: RequestContext
  ): Promise<ChangeView>;
  previewQuote(id: string, input: QuoteInput, actor: RequestUser): Promise<ExtensionQuotePreview>;
  createFormalQuote(
    id: string,
    input: QuoteInput,
    actor: RequestUser,
    context: RequestContext
  ): Promise<QuoteView>;
  approvePriceOverride(
    id: string,
    input: PriceApprovalInput,
    actor: RequestUser,
    context: RequestContext
  ): Promise<ChangeView>;
  submitCustomerConfirmation(
    id: string,
    actor: RequestUser,
    context: RequestContext
  ): Promise<ChangeView>;
  cancel(
    id: string,
    reason: string,
    actor: RequestUser,
    context: RequestContext
  ): Promise<ChangeView>;
  manualTakeover(
    id: string,
    reason: string,
    actor: RequestUser,
    context: RequestContext
  ): Promise<ChangeView>;
  get(id: string, actor: RequestUser): Promise<ChangeDetail>;
  listForOrder(orderId: string, actor: RequestUser): Promise<ChangeSummary[]>;
}
```

- [x] **Step 1: Write failing pricing and lifecycle tests**

Test `CURRENT_VERSION` pricing with an ACTIVE plan and leased-vehicle inventory bypass, `ORIGINAL_PRICE` using the source segment snapshot with approval, `APPROVED_DISCOUNT` amount bounds, submitter/approver separation, quote revision superseding, confirmation immutability guard, one-active-change conflict, post-expiry rejection, audit contents, and feature flag fail-closed:

```ts
await expect(service.approvePriceOverride(change.id, approval, submitter)).rejects.toMatchObject({
  code: "PRICE_OVERRIDE_SELF_APPROVAL_FORBIDDEN"
});
expect(secondQuote.revision).toBe(2);
expect(firstQuote.status).toBe("SUPERSEDED");
await expect(
  legacyOrderService.createOrderChange(order.id, { changeType: "EXTENSION" }, user, ctx)
).rejects.toMatchObject({ status: 409 });
```

- [x] **Step 2: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-extension-pricing.spec.ts test/subscription-change.service.spec.ts test/subscription-change.controller.spec.ts test/order-change-execute.spec.ts
```

Expected: FAIL because the V2 services/routes and legacy guard are absent.

- [x] **Step 3: Implement feature config, DTO validation, and pricing service**

Read only `SUBSCRIPTION_EXTENSION_ENABLED=true` as enabled. Validate `extensionMonths` as positive integer, `version` for optimistic locking, approved discount as `0 < discounted <= baseline`, and all money DTOs as digit strings converted to `BigInt` at the boundary. Calculate `targetStartDate = source.endDate + 1 day` and `targetEndDate = addCalendarMonths(targetStartDate, extensionMonths) - 1 day`, operating on Shanghai-local date parts so UTC conversion cannot shift the business date.

- [x] **Step 4: Implement lifecycle service and Admin controller**

Expose the approved `/api/subscription-changes` routes, including detail, timeline, task, segment, and order-scoped list reads. Each write must enforce permission, feature flag, state transition, version, idempotency key, and audit. `confirmedQuoteId` is write-once. Creating the first formal quote for a consideration-linked change transitions the consideration from `RENEWAL_REQUESTED` to `EXTENSION_IN_PROGRESS`. Return 409 for state/deadline/idempotency conflicts and 400 for invalid request values.

- [x] **Step 5: Add the legacy EXTENSION guard and run GREEN**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-extension-pricing.spec.ts test/subscription-change.service.spec.ts test/subscription-change.controller.spec.ts test/order-change-execute.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: all focused tests PASS; legacy non-extension changes remain unchanged.

- [x] **Step 6: Commit the Admin extension lifecycle**

```powershell
git add apps/api/src/subscription-change apps/api/src/order/order.service.ts apps/api/.env.example apps/api/.env.production.example apps/api/test/subscription-extension-pricing.spec.ts apps/api/test/subscription-change.service.spec.ts apps/api/test/subscription-change.controller.spec.ts apps/api/test/order-change-execute.spec.ts
git commit -m "feat: add extension quote lifecycle"
```

### Task 4: Renewal consideration enrollment, reminders, and durable jobs

**Files:**

- Create: `apps/api/src/subscription-change/renewal-calendar.ts`
- Create: `apps/api/src/subscription-change/renewal-consideration.service.ts`
- Create: `apps/api/src/subscription-change/renewal-consideration.controller.ts`
- Create: `apps/api/src/subscription-change/subscription-change-job.service.ts`
- Create: `apps/api/src/subscription-change/subscription-change.worker.ts`
- Modify: `apps/api/src/subscription-change/subscription-change.module.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.repository.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.types.ts`
- Modify: `apps/api/src/notification/notification.service.ts`
- Modify: `apps/api/src/sms/sms.service.ts`
- Modify: `apps/api/src/sms/sms-provider.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/.env.production.example`
- Create: `apps/api/test/renewal-calendar.spec.ts`
- Create: `apps/api/test/renewal-consideration.spec.ts`
- Create: `apps/api/test/renewal-consideration.controller.spec.ts`
- Create: `apps/api/test/renewal-reminder-notification.spec.ts`
- Create: `apps/api/test/subscription-change-worker.spec.ts`
- Modify: `apps/api/test/notification.spec.ts`

**Interfaces:**

- Consumes: segment source of truth, existing automation job lease/retry conventions, NotificationService, and SmsService.
- Produces:

```ts
export function renewalSchedule(endDate: Date): {
  considerationStartAt: Date;
  completionDeadlineAt: Date;
  reminders: Record<"D30" | "D14" | "D3", Date>;
};

export class RenewalConsiderationService {
  enrollDueSegments(now?: Date): Promise<{ created: number; skipped: number }>;
  enrollSegment(segmentId: string, now?: Date): Promise<RenewalConsideration>;
  dispatchReminder(
    considerationId: string,
    slot: RenewalReminderSlot,
    now?: Date
  ): Promise<RenewalReminder>;
  retryReminder(
    considerationId: string,
    slot: RenewalReminderSlot,
    actor: RequestUser
  ): Promise<RenewalReminder>;
  list(
    query: RenewalConsiderationQuery,
    actor: RequestUser
  ): Promise<PageResult<RenewalConsiderationView>>;
  get(id: string, actor: RequestUser): Promise<RenewalConsiderationDetail>;
  reconcile(id: string, actor: RequestUser): Promise<RenewalConsiderationDetail>;
  retryJob(
    changeOrderId: string,
    jobId: string,
    actor: RequestUser
  ): Promise<SubscriptionAutomationJob>;
}
```

- [x] **Step 1: Write failing calendar, idempotency, and channel-result tests**

Cover Shanghai D-30/D-14/D-3 at 09:00, next-day 00:00 deadline, one consideration per segment, disabled feature flag producing no writes, late enrollment sending only the latest applicable slot, decision/extension stopping reminders, duplicate worker runs, absent SMS template as `FAILED/CONFIG_MISSING`, station notification success independent from SMS, and safe retry using the same slot:

```ts
expect(renewalSchedule(date("2026-09-02")).completionDeadlineAt.toISOString()).toBe(
  "2026-09-02T16:00:00.000Z"
);
expect(late.reminders.map(({ status }) => status)).toEqual([
  "SKIPPED_LATE_ENROLLMENT",
  "SKIPPED_LATE_ENROLLMENT",
  "PENDING"
]);
expect(result.sms).toMatchObject({ status: "FAILED", errorCode: "CONFIG_MISSING" });
expect(result.inApp.status).toBe("SENT");
```

- [x] **Step 2: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/renewal-calendar.spec.ts test/renewal-consideration.spec.ts test/renewal-consideration.controller.spec.ts test/renewal-reminder-notification.spec.ts test/subscription-change-worker.spec.ts test/notification.spec.ts
```

Expected: FAIL because scheduling, handlers, Admin consideration routes, and channel result persistence are absent.

- [x] **Step 3: Implement calendar, enrollment, job claims, and worker dispatch**

Use the exact globally unique keys from design section 16. Extend `EnqueueBillingAutomationJobInput` with `changeOrderId`, `contractSegmentId`, and `renewalConsiderationId`, and reuse exported `BillingAutomationRepository.enqueue/claimDue/complete/reschedule/deadLetter` for renewal job types. Keep the existing billing-only `GENERATE_MONTHLY_RENT_BILL` schedule guard unchanged. Worker restart must reclaim expired leases and never duplicate reminder slots.

- [x] **Step 4: Implement renewal notification channels and exact environment keys**

Add `RENEWAL_REMINDER_D30_TEMPLATE_CODE`, `RENEWAL_REMINDER_D14_TEMPLATE_CODE`, `RENEWAL_REMINDER_D3_TEMPLATE_CODE`, `RENEWAL_EXPIRY_RETURN_TEMPLATE_CODE`, and `RENEWAL_RETURN_OVERDUE_D1_TEMPLATE_CODE`. Store template code snapshot and channel result on the reminder. Use order number, masked plate, end date, days remaining, and Portal path as variables.

- [x] **Step 5: Run GREEN tests and typecheck**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/renewal-calendar.spec.ts test/renewal-consideration.spec.ts test/renewal-consideration.controller.spec.ts test/renewal-reminder-notification.spec.ts test/subscription-change-worker.spec.ts test/notification.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

- [x] **Step 6: Commit renewal scheduling and reminders**

```powershell
git add apps/api/src/subscription-change apps/api/src/billing-automation/billing-automation.repository.ts apps/api/src/billing-automation/billing-automation.types.ts apps/api/src/notification/notification.service.ts apps/api/src/sms apps/api/.env.example apps/api/.env.production.example apps/api/test/renewal-calendar.spec.ts apps/api/test/renewal-consideration.spec.ts apps/api/test/renewal-consideration.controller.spec.ts apps/api/test/renewal-reminder-notification.spec.ts apps/api/test/subscription-change-worker.spec.ts apps/api/test/notification.spec.ts
git commit -m "feat: schedule renewal consideration reminders"
```

### Task 5: Portal renewal decisions and exact quote confirmation

**Files:**

- Create: `apps/api/src/portal/portal-renewal.dto.ts`
- Create: `apps/api/src/portal/portal-renewal.service.ts`
- Create: `apps/api/src/portal/portal-renewal.controller.ts`
- Modify: `apps/api/src/portal/portal.module.ts`
- Modify: `apps/api/src/subscription-change/renewal-consideration.service.ts`
- Modify: `apps/api/src/subscription-change/subscription-extension.service.ts`
- Create: `apps/api/test/portal-renewal.spec.ts`
- Create: `apps/api/test/portal-renewal-security.spec.ts`

**Interfaces:**

- Consumes: Task 3 extension service, Task 4 consideration service, `CurrentCustomer`, and Portal auth guard.
- Produces:

```ts
export class PortalRenewalService {
  list(customer: CurrentCustomer): Promise<PortalRenewalSummary[]>;
  get(id: string, customer: CurrentCustomer): Promise<PortalRenewalDetail>;
  decide(
    id: string,
    input: { decision: "RENEW" | "EXPIRE"; version: number },
    customer: CurrentCustomer,
    context: PortalRequestContext
  ): Promise<PortalRenewalDetail>;
  confirmQuote(
    changeId: string,
    input: { quoteId: string; revision: number; version: number },
    customer: CurrentCustomer,
    context: PortalRequestContext
  ): Promise<PortalChangeDetail>;
  rejectQuote(
    changeId: string,
    input: { quoteId: string; reason: string; version: number },
    customer: CurrentCustomer,
    context: PortalRequestContext
  ): Promise<PortalChangeDetail>;
}
```

- [x] **Step 1: Write failing Portal ownership and decision tests**

Cover list/detail ownership, cross-customer 404, RENEW idempotently creating/linking one extension, EXPIRE cancelling future reminder jobs, conflicting second decision returning 409, exact quote revision confirmation, stale/superseded quote rejection, customer quote rejection cancelling the change with an audit reason, and confirmed quote write-once behavior.

```ts
await expect(service.get(otherCustomerConsideration.id, currentCustomer)).rejects.toMatchObject({
  status: 404
});
const first = await service.decide(id, { decision: "RENEW", version: 0 }, customer, ctx);
const retry = await service.decide(id, { decision: "RENEW", version: 1 }, customer, ctx);
expect(retry.changeOrderId).toBe(first.changeOrderId);
```

- [x] **Step 2: Run tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-renewal.spec.ts test/portal-renewal-security.spec.ts
```

- [x] **Step 3: Implement DTOs, service transactions, and routes**

Implement the approved `/api/portal/renewal-considerations` and `/api/portal/subscription-changes` routes. Return only customer-safe snapshots, masked vehicle data, contract dates, amount strings, status, next action, and public errors. Never accept `customerId` from the request.

- [x] **Step 4: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-renewal.spec.ts test/portal-renewal-security.spec.ts
pnpm --filter @subscription-saas/api typecheck
git add apps/api/src/portal apps/api/src/subscription-change apps/api/test/portal-renewal.spec.ts apps/api/test/portal-renewal-security.spec.ts
git commit -m "feat: add portal renewal decisions"
```

### Task 6: Dedicated extension agreement generation and rendering

**Files:**

- Create: `apps/api/src/subscription-change/subscription-extension-contract.service.ts`
- Modify: `apps/api/src/subscription-change/subscription-change.controller.ts`
- Modify: `apps/api/src/subscription-change/subscription-change.module.ts`
- Modify: `apps/api/src/contract/contract-pdf-render-model.ts`
- Modify: `apps/api/src/contract/contract-pdf-renderer.service.ts`
- Modify: `apps/api/src/vehicle-insurance/vehicle-insurance.service.ts`
- Modify: `apps/api/src/vehicle-insurance/vehicle-insurance.module.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Modify: `apps/api/src/order/dto/order.dto.ts`
- Create: `apps/api/test/subscription-extension-contract.spec.ts`
- Modify: `apps/api/test/contract-pdf-renderer.spec.ts`
- Modify: `apps/api/test/order-contract.spec.ts`

**Interfaces:**

- Consumes: customer-confirmed quote, existing `ContractVersion` approval/effective-date rules, Contract PDF writer/renderer.
- Produces:

```ts
export class SubscriptionExtensionContractService {
  generate(changeOrderId: string, actor: RequestUser, context: RequestContext): Promise<Contract>;
  getContractSnapshot(changeOrderId: string): Promise<ExtensionContractSnapshot>;
}

export class VehicleInsuranceService {
  assertVehicleCoveredThrough(
    vehicleId: string,
    endDate: Date
  ): Promise<{ policyId: string; effectiveTo: Date }>;
}
```

- [x] **Step 1: Write failing strict-template and snapshot tests**

Cover template selection restricted to `SUBSCRIPTION_EXTENSION`, no fallback to standard/handover, ACTIVE/effective-date requirement, insurance coverage through the extension end date, one effective contract per change, confirmed quote requirement, contract snapshot completeness, original contract ID/date preservation, and PDF rendering of extension dates/price/plan.

```ts
expect(contract.contractVersion.templateType).toBe("SUBSCRIPTION_EXTENSION");
expect(contract.contractSnapshot).toMatchObject({
  originalContractNo: "CON-BASE",
  originalEndDate: "2026-09-02",
  extensionStartDate: "2026-09-03",
  confirmedQuoteNo: "SCQ-0001"
});
```

- [x] **Step 2: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-extension-contract.spec.ts test/contract-pdf-renderer.spec.ts test/order-contract.spec.ts
```

- [x] **Step 3: Implement generation, render model, and contract-version validation**

Use a dedicated extension render model; do not overload handover fields. `generate` first calls `assertVehicleCoveredThrough(order.vehicleId, targetEndDate)`, then transitions `CUSTOMER_CONFIRMED -> SIGNING_OR_PAYMENT`, stores `changeOrder.contractId`, and never changes `SubscriptionOrder.contractId`. Reject generation when insurance is insufficient or `now >= completionDeadlineAt`.

- [x] **Step 4: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-extension-contract.spec.ts test/contract-pdf-renderer.spec.ts test/order-contract.spec.ts
pnpm --filter @subscription-saas/api typecheck
git add apps/api/src/subscription-change apps/api/src/contract apps/api/src/vehicle-insurance apps/api/src/order apps/api/test/subscription-extension-contract.spec.ts apps/api/test/contract-pdf-renderer.spec.ts apps/api/test/order-contract.spec.ts
git commit -m "feat: generate extension agreements"
```

### Task 7: Stage 3 e-sign and atomic archive/deadline arbitration

**Files:**

- Create: `apps/api/src/esign/stage3-extension-archive.service.ts`
- Modify: `apps/api/src/esign/esign.service.ts`
- Modify: `apps/api/src/esign/esign.dto.ts`
- Modify: `apps/api/src/esign/esign.module.ts`
- Modify: `apps/api/src/subscription-change/subscription-extension.service.ts`
- Modify: `apps/api/src/subscription-change/subscription-change.controller.ts`
- Create: `apps/api/test/stage3-extension-esign.spec.ts`
- Create: `apps/api/test/stage3-extension-archive-race.spec.ts`
- Modify: `apps/api/test/esign.spec.ts`
- Modify: `apps/api/test/contract-pdf-artifact.spec.ts`

**Interfaces:**

- Consumes: Task 6 extension contract, existing provider/signing-plan/artifact pipeline, Task 2 segment validator.
- Produces:

```ts
export class Stage3ExtensionArchiveService {
  finalizeArchivedContract(input: {
    contractId: string;
    taskId: string;
    completedAt: Date;
    source: "CALLBACK" | "RECONCILE";
  }): Promise<{ outcome: "SCHEDULED" | "DUPLICATE" | "LATE_EVIDENCE_ONLY"; segmentId?: string }>;
}
```

- [x] **Step 1: Write failing Stage 3 mapping and race tests**

Cover dedicated signing stage/document type, customer + platform signer plan, start/retry endpoints, signed artifact availability, no order/billing/entitlement mutation before archive, atomic segment creation and `SCHEDULED`, duplicate/乱序回调, callback-before-deadline wins, expiry-lock-first wins, callback exactly at deadline loses, late artifact retained without segment, one segment per change, and cancellation forbidden after `SCHEDULED`.

```ts
const result = await archive.finalizeArchivedContract({
  contractId,
  taskId,
  completedAt: shanghai("2026-09-02 23:59:59"),
  source: "CALLBACK"
});
expect(result.outcome).toBe("SCHEDULED");
expect(await segmentsFor(change.id)).toHaveLength(1);

expect(await finalizeAt("2026-09-03 00:00:00")).toMatchObject({
  outcome: "LATE_EVIDENCE_ONLY"
});
```

- [x] **Step 2: Run focused tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/stage3-extension-esign.spec.ts test/stage3-extension-archive-race.spec.ts test/esign.spec.ts test/contract-pdf-artifact.spec.ts
```

- [x] **Step 3: Implement Stage 3 provider mapping and safe retries**

Extend task creation and portal sign URL selection using the dedicated enums. Reuse existing callback verification and signed artifact pipeline. Admin retry may only retry provider start/query/archive operations; it may not alter dates, signer completion, or status directly.

- [x] **Step 4: Implement atomic finalization under row locks**

In one transaction lock change, consideration, source segment, order, contract, and existing target segment; compare database time to `completionDeadlineAt`; validate archived artifact; create EXTENSION segment; set change `SCHEDULED`; set consideration `EXTENDED`; cancel expiry/reminder jobs; and audit. The late branch records evidence/audit and does not mutate expiry business state.

- [x] **Step 5: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/stage3-extension-esign.spec.ts test/stage3-extension-archive-race.spec.ts test/esign.spec.ts test/contract-pdf-artifact.spec.ts
pnpm --filter @subscription-saas/api typecheck
git add apps/api/src/esign apps/api/src/subscription-change apps/api/test/stage3-extension-esign.spec.ts apps/api/test/stage3-extension-archive-race.spec.ts apps/api/test/esign.spec.ts apps/api/test/contract-pdf-artifact.spec.ts
git commit -m "feat: finalize signed extension agreements"
```

### Task 8: Segment-aware monthly billing and schedule continuation

**Files:**

- Modify: `apps/api/src/billing-automation/billing-automation.service.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.handlers.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.repository.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.types.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.module.ts`
- Modify: `apps/api/src/subscription-change/subscription-change.module.ts`
- Create: `apps/api/test/billing-contract-segment.spec.ts`
- Modify: `apps/api/test/billing-automation-service.spec.ts`
- Modify: `apps/api/test/billing-automation.integration.spec.ts`

**Interfaces:**

- Consumes: `ContractSegmentService.resolveEffectiveServiceEndDate` and `.resolveSegmentForPeriod`.
- Produces:

```ts
export class BillingAutomationService {
  resumeForExtension(orderId: string, segmentId: string, now?: Date): Promise<BillingSchedule>;
}
```

- [x] **Step 1: Write failing segment-aware billing tests**

Cover replacing every direct termination check based on `order.endDate`, BASE amount before extension, EXTENSION amount from its start, a historical billing period crossing a segment returning `BILLING_PERIOD_CROSSES_SEGMENT` and moving the change to `MANUAL_TAKEOVER`, preservation of cycle number/anchor, safe recovery from COMPLETED schedule, bill snapshot `contractSegmentId`, idempotent source key, and no bill after effective end.

```ts
expect(extensionBill.amount).toBe(8_800n);
expect(extensionBill.snapshot).toMatchObject({ contractSegmentId: extension.id });
expect(resumed.nextCycleNo).toBe(completed.nextCycleNo);
expect(resumed.nextPeriodStart).toEqual(completed.nextPeriodStart);
```

- [x] **Step 2: Run tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/billing-contract-segment.spec.ts test/billing-automation-service.spec.ts test/billing-automation.integration.spec.ts
```

- [x] **Step 3: Replace order-level end/price reads with segment resolver**

Import the `ContractSegmentModule` created in Task 2 into `BillingAutomationModule` and inject `ContractSegmentService`. Keep existing billing calendar/source keys; include segment identity in snapshot, not in the existing bill source key format.

- [x] **Step 4: Implement safe schedule continuation and GREEN tests**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/billing-contract-segment.spec.ts test/billing-automation-service.spec.ts test/billing-automation.integration.spec.ts
pnpm --filter @subscription-saas/api typecheck
git add apps/api/src/billing-automation apps/api/src/subscription-change apps/api/test/billing-contract-segment.spec.ts apps/api/test/billing-automation-service.spec.ts apps/api/test/billing-automation.integration.spec.ts
git commit -m "feat: bill subscription contract segments"
```

### Task 9: Extension activation, entitlement renewal, and active payment continuity

**Files:**

- Create: `apps/api/src/subscription-change/subscription-extension-activation.service.ts`
- Modify: `apps/api/src/subscription-change/subscription-change-job.service.ts`
- Modify: `apps/api/src/subscription-change/subscription-change.worker.ts`
- Modify: `apps/api/src/subscription-change/subscription-change.module.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Modify: `apps/api/src/auto-debit/debit-attempt.service.ts`
- Create: `apps/api/test/subscription-extension-activation.spec.ts`
- Create: `apps/api/test/extension-entitlement-renewal.spec.ts`
- Create: `apps/api/test/extension-payment-continuity.spec.ts`
- Modify: `apps/api/test/order-entitlement.spec.ts`

**Interfaces:**

- Consumes: scheduled EXTENSION segment, billing resume API, existing monthly entitlement creation, insurance policy source of truth, existing payment mandate/debit invariants.
- Produces:

```ts
export class SubscriptionExtensionActivationService {
  activate(
    segmentId: string,
    now?: Date
  ): Promise<{ changeStatus: "COMPLETED"; segmentStatus: "ACTIVE" }>;
  renewEntitlements(
    segmentId: string,
    periodStart: Date
  ): Promise<{ created: number; existing: number }>;
}
```

- [x] **Step 1: Write failing activation and continuity tests**

Cover prior segment completing at the new start, extension becoming ACTIVE, change `EXECUTING -> COMPLETED`, billing resume called once, upcoming-effective notice sent once, entitlement snapshot coming from the extension segment, entitlement idempotency key including segment/period/type, existing active mandates remaining active, existing payable bills still debiting, and no duplicate grants after worker restart.

- [x] **Step 2: Run tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-extension-activation.spec.ts test/extension-entitlement-renewal.spec.ts test/extension-payment-continuity.spec.ts test/order-entitlement.spec.ts
```

- [x] **Step 3: Implement activation and entitlement adapters**

Use an activation transaction for segment/change state only; enqueue effective notice, billing, and entitlement jobs with stable keys, then let each idempotent handler complete. Do not change mandate state. A failed downstream job leaves the change in `EXECUTING` with visible retry data; after max attempts move to `MANUAL_TAKEOVER`.

- [x] **Step 4: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-extension-activation.spec.ts test/extension-entitlement-renewal.spec.ts test/extension-payment-continuity.spec.ts test/order-entitlement.spec.ts
pnpm --filter @subscription-saas/api typecheck
git add apps/api/src/subscription-change apps/api/src/order/order.service.ts apps/api/src/auto-debit/debit-attempt.service.ts apps/api/test/subscription-extension-activation.spec.ts apps/api/test/extension-entitlement-renewal.spec.ts apps/api/test/extension-payment-continuity.spec.ts apps/api/test/order-entitlement.spec.ts
git commit -m "feat: activate extension contract segments"
```

### Task 10: Expiry arbitration, return-due transition, and D+1 exception

**Files:**

- Create: `apps/api/src/subscription-change/subscription-expiry.service.ts`
- Modify: `apps/api/src/subscription-change/subscription-change-job.service.ts`
- Modify: `apps/api/src/subscription-change/subscription-change.worker.ts`
- Modify: `apps/api/src/subscription-change/subscription-change.module.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Modify: `apps/api/src/order/order-workspace.service.ts`
- Modify: `apps/api/src/order/order-workspace.types.ts`
- Modify: `apps/api/src/auto-debit/debit-attempt.service.ts`
- Create: `apps/api/test/subscription-expiry.spec.ts`
- Create: `apps/api/test/subscription-expiry-return.integration.spec.ts`
- Modify: `apps/api/test/order-return.spec.ts`
- Modify: `apps/api/test/auto-debit-notification.spec.ts`

**Interfaces:**

- Consumes: same row-lock ordering as Task 7, existing `VehicleReturn`, billing schedules, entitlement accounts, automation jobs, notifications.
- Produces:

```ts
export class SubscriptionExpiryService {
  expireSegment(
    segmentId: string,
    now?: Date
  ): Promise<{ outcome: "EXPIRED" | "EXTENDED" | "DUPLICATE"; returnId?: string }>;
  flagOverdueReturn(orderId: string, now?: Date): Promise<{ created: boolean }>;
}
```

- [x] **Step 1: Write failing expiry and return tests**

Cover no response, EXPIRE decision, renewal requested but unsigned, expiry winning race, extension winning race, `PENDING_RETURN`, `RETURN_DUE`, unique PENDING return, vehicle remains LEASED/unallocatable, schedule completion, cancellation of future bill/entitlement/debit jobs, preservation of existing bills/collections/mandate, expiry notice, D+1 one-time exception, and no automatic fee.

```ts
expect(result.outcome).toBe("EXPIRED");
expect(order.orderStatus).toBe("PENDING_RETURN");
expect(lease.status).toBe("RETURN_DUE");
expect(vehicle.status).toBe("LEASED");
expect(await futureBills(order.id)).toHaveLength(0);
expect(await billsCreatedByD1Exception(order.id)).toHaveLength(0);
```

- [x] **Step 2: Run tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-expiry.spec.ts test/subscription-expiry-return.integration.spec.ts test/order-return.spec.ts test/auto-debit-notification.spec.ts
```

- [x] **Step 3: Implement locked expiry transaction and task cancellation**

Lock objects in the same order as Stage 3 archive. Set `EXTENSION_DEADLINE_MISSED` on in-progress change, complete segment, expire consideration, update order/Lease, upsert the one `VehicleReturn`, complete schedule, close future entitlement generation, and cancel pending future debit tasks. Never mutate existing receivables, write-offs, collection cases, or active mandates.

- [x] **Step 4: Implement D+1 exception and allow normal return completion**

Create an idempotent operational notification/task only. Update return guards so `PENDING_RETURN` + `RETURN_DUE` follows the existing normal return preparation/confirmation path; confirmed return writes the existing immutable mileage record and final order/vehicle states.

- [x] **Step 5: Run GREEN and commit**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-expiry.spec.ts test/subscription-expiry-return.integration.spec.ts test/order-return.spec.ts test/auto-debit-notification.spec.ts
pnpm --filter @subscription-saas/api typecheck
git add apps/api/src/subscription-change apps/api/src/order apps/api/src/auto-debit/debit-attempt.service.ts apps/api/test/subscription-expiry.spec.ts apps/api/test/subscription-expiry-return.integration.spec.ts apps/api/test/order-return.spec.ts apps/api/test/auto-debit-notification.spec.ts
git commit -m "feat: transition expired subscriptions to return"
```

### Task 11: Admin change center and order-workspace guidance

**Files:**

- Create: `apps/web/src/lib/subscription-change-api.ts`
- Create: `apps/web/src/lib/subscription-change-view-model.ts`
- Create: `apps/web/src/app/subscription-changes/page.tsx`
- Create: `apps/web/src/app/subscription-changes/[id]/page.tsx`
- Modify: `apps/web/src/components/admin-shell.tsx`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Modify: `apps/web/src/lib/admin-order-workspace.ts`
- Create: `apps/web/test/subscription-change-view-model.spec.ts`
- Create: `apps/web/test/subscription-change-admin-pages.spec.tsx`
- Modify: `apps/web/test/admin-order-workspace.spec.ts`
- Modify: `apps/web/test/action-guards.spec.ts`

**Interfaces:**

- Consumes: Admin APIs from Tasks 3, 4, 6, and 7; shared permission constants and labels.
- Produces:

```ts
export function getSubscriptionChangeNextAction(change: AdminSubscriptionChange): {
  kind:
    | "QUOTE"
    | "APPROVE_PRICE"
    | "WAIT_CUSTOMER"
    | "GENERATE_CONTRACT"
    | "START_ESIGN"
    | "WAIT_ARCHIVE"
    | "WAIT_EFFECTIVE"
    | "RETRY"
    | "MANUAL"
    | "DONE";
  label: string;
  enabled: boolean;
  reason?: string;
};
```

- [x] **Step 1: Write failing view-model and page contract tests**

Cover status-to-next-action mapping, permissions, original end vs contracted-through display, price approval details, reminder channel failures, contract/PDF links, safe retry buttons, manual takeover visibility, no generic status mutation button, and legacy changes still visible separately.

- [x] **Step 2: Run tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/subscription-change-view-model.spec.ts test/subscription-change-admin-pages.spec.tsx test/admin-order-workspace.spec.ts test/action-guards.spec.ts
```

- [x] **Step 3: Implement typed API/view model and Admin pages**

Build focused components inside the new detail page rather than expanding the order page state machine. Use string amounts, explicit loading/error/retry states, responsive cards/tables, and permission-gated actions. The order page only embeds a compact summary and deep link.

- [x] **Step 4: Run GREEN, lint, and commit**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/subscription-change-view-model.spec.ts test/subscription-change-admin-pages.spec.tsx test/admin-order-workspace.spec.ts test/action-guards.spec.ts
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
git add apps/web/src/lib/subscription-change-api.ts apps/web/src/lib/subscription-change-view-model.ts apps/web/src/app/subscription-changes apps/web/src/components/admin-shell.tsx apps/web/src/app/orders/[id]/page.tsx apps/web/src/lib/admin-order-workspace.ts apps/web/test/subscription-change-view-model.spec.ts apps/web/test/subscription-change-admin-pages.spec.tsx apps/web/test/admin-order-workspace.spec.ts apps/web/test/action-guards.spec.ts
git commit -m "feat: add admin contract change center"
```

### Task 12: Portal renewal guidance, quote confirmation, signing, and documents

**Files:**

- Modify: `apps/web/src/lib/portal-types.ts`
- Modify: `apps/web/src/lib/portal-api.ts`
- Create: `apps/web/src/lib/portal-renewal-view-model.ts`
- Create: `apps/web/src/app/portal/renewals/page.tsx`
- Create: `apps/web/src/app/portal/renewals/[id]/page.tsx`
- Create: `apps/web/src/app/portal/subscription-changes/[id]/page.tsx`
- Modify: `apps/web/src/app/portal/applications/page.tsx`
- Modify: `apps/web/src/lib/portal-application-next-action-view-model.ts`
- Modify: `apps/web/src/app/portal/contracts/[id]/page.tsx`
- Create: `apps/web/test/portal-renewal-view-model.spec.ts`
- Create: `apps/web/test/portal-renewal-pages.spec.tsx`
- Modify: `apps/web/test/portal-application-next-action-view-model.spec.ts`
- Modify: `apps/web/test/contracts-detail-esign-display.spec.ts`

**Interfaces:**

- Consumes: Portal renewal/change/sign APIs and existing Portal contract viewer.
- Produces:

```ts
export function getPortalRenewalNextAction(input: PortalRenewalDetail): {
  step: "DECIDE" | "WAIT_QUOTE" | "CONFIRM_QUOTE" | "SIGN" | "WAIT_ARCHIVE" | "EXTENDED" | "RETURN";
  title: string;
  helper: string;
  href?: string;
};
```

- [x] **Step 1: Write failing Portal journey tests**

Cover D-30 card in My Applications, mutually exclusive RENEW/EXPIRE decisions, exact quote revision display/confirmation, reject reason, extension PDF preview/download, sign action, wait-for-archive state, EXTENDED contracted-through date, EXPIRED return guidance, stale quote 409 refresh, and mobile layout without horizontal overflow.

- [x] **Step 2: Run tests and confirm RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-renewal-view-model.spec.ts test/portal-renewal-pages.spec.tsx test/portal-application-next-action-view-model.spec.ts test/contracts-detail-esign-display.spec.ts
```

- [x] **Step 3: Implement Portal types, API calls, pages, and continuous guidance**

Reuse the existing Portal contract sign route after obtaining the extension contract ID. Show both original contract and supplemental agreement documents. Keep “我的申请” guidance active through extension completion or return completion; never require the customer to discover a separate menu manually.

- [x] **Step 4: Run GREEN, lint, and commit**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-renewal-view-model.spec.ts test/portal-renewal-pages.spec.tsx test/portal-application-next-action-view-model.spec.ts test/contracts-detail-esign-display.spec.ts
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
git add apps/web/src/lib/portal-types.ts apps/web/src/lib/portal-api.ts apps/web/src/lib/portal-renewal-view-model.ts apps/web/src/app/portal/renewals apps/web/src/app/portal/subscription-changes apps/web/src/app/portal/applications/page.tsx apps/web/src/lib/portal-application-next-action-view-model.ts apps/web/src/app/portal/contracts/[id]/page.tsx apps/web/test/portal-renewal-view-model.spec.ts apps/web/test/portal-renewal-pages.spec.tsx apps/web/test/portal-application-next-action-view-model.spec.ts apps/web/test/contracts-detail-esign-display.spec.ts
git commit -m "feat: guide portal contract renewals"
```

### Task 13: Bootstrap/reconciliation tooling, operational smoke, and release verification

**Files:**

- Create: `scripts/subscription-segment-bootstrap-core.mjs`
- Create: `scripts/subscription-segment-bootstrap.mjs`
- Create: `scripts/subscription-renewal-reconcile.mjs`
- Create: `scripts/subscription-segment-bootstrap-core.test.mjs`
- Create: `scripts/subscription-segment-bootstrap-apply.test.mjs`
- Create: `scripts/subscription-renewal-reconcile.test.mjs`
- Create: `scripts/subscription-extension-smoke.mjs`
- Modify: `package.json`
- Modify: `scripts/api-smoke.mjs`
- Modify: `README.md`
- Create: `docs/runbooks/stage1b-contract-extension-renewal-release.md`
- Create: `apps/api/test/subscription-extension-e2e.spec.ts`
- Create: `apps/api/test/subscription-segment-consistency.spec.ts`

**Interfaces:**

- Consumes: all prior tasks and feature/template environment configuration.
- Produces commands:

```text
pnpm subscription-segments:bootstrap:dry-run
pnpm subscription-segments:bootstrap:apply
pnpm subscription-renewals:reconcile
pnpm subscription-extension:smoke
```

- [x] **Step 1: Write failing bootstrap, reconciliation, and end-to-end tests**

Cover clean ACTIVE order bootstrap, missing date/main contract/plan snapshot exception report, idempotent re-run, late-enrollment reminder selection, already-extended skip, segment overlap detection, signed renewal through activation, unsigned expiry through return-due, worker restart, new DB migration, and existing DB migration.

```js
assert.deepEqual(plan.summary, { eligible: 1, exceptions: 1, existing: 0 });
assert.equal(secondApply.created, 0);
assert.equal(secondApply.existing, 1);
assert.equal(consistency.overlaps.length, 0);
```

- [x] **Step 2: Run tooling tests and confirm RED**

```powershell
node --test scripts/subscription-segment-bootstrap-core.test.mjs scripts/subscription-segment-bootstrap-apply.test.mjs scripts/subscription-renewal-reconcile.test.mjs
pnpm --filter @subscription-saas/api exec vitest run test/subscription-extension-e2e.spec.ts test/subscription-segment-consistency.spec.ts
```

- [x] **Step 3: Implement dry-run-first bootstrap and reconciliation**

Require `--apply` for writes, print explicit counts and exception rows, use transactional idempotent inserts, never guess missing facts, and never send SMS from bootstrap. Reconciliation creates only the latest applicable reminder and marks earlier slots `SKIPPED_LATE_ENROLLMENT`.

- [x] **Step 4: Add smoke flow and release runbook**

The runbook must require: migration backup/deploy → container healthy → public health checks → bootstrap dry run → bootstrap apply → reconciliation → template validation → enable staging flag → smoke. Document rollback as flag off while preserving signed contracts and segments. Include the five exact SMS variables and `SUBSCRIPTION_EXTENSION_ENABLED=false` production default.

- [x] **Step 5: Run all quality gates**

```powershell
pnpm prisma:migrate:status
pnpm prisma:validate
pnpm prisma:generate
pnpm -r lint
pnpm -r typecheck
pnpm -r test
pnpm build
node --test scripts/subscription-segment-bootstrap-core.test.mjs scripts/subscription-segment-bootstrap-apply.test.mjs scripts/subscription-renewal-reconcile.test.mjs
git diff --check
git status --short --branch
```

Expected: every command PASS; only intended branch changes exist.

- [x] **Step 6: Commit operational tooling and verification evidence**

```powershell
git add scripts/subscription-segment-bootstrap-core.mjs scripts/subscription-segment-bootstrap.mjs scripts/subscription-renewal-reconcile.mjs scripts/subscription-segment-bootstrap-core.test.mjs scripts/subscription-segment-bootstrap-apply.test.mjs scripts/subscription-renewal-reconcile.test.mjs scripts/subscription-extension-smoke.mjs scripts/api-smoke.mjs package.json README.md docs/runbooks/stage1b-contract-extension-renewal-release.md apps/api/test/subscription-extension-e2e.spec.ts apps/api/test/subscription-segment-consistency.spec.ts
git commit -m "test: verify contract extension renewal flow"
```

### Task 14: Final review, traceability, and branch handoff

**Files:**

- Modify: `docs/superpowers/specs/2026-08-05-stage1b-contract-extension-renewal-design.zh-CN.md` only if implementation reveals a factual correction approved by the user
- Modify: `docs/superpowers/plans/2026-08-05-stage1b-contract-extension-renewal-implementation-plan.md` to check completed steps
- Create: `docs/verification/stage1b-contract-extension-renewal-verification.md`

**Interfaces:**

- Consumes: completed commits and quality-gate output.
- Produces: reviewer-ready evidence mapping every approved acceptance criterion to an automated test or staging-only manual check.

- [x] **Step 1: Build the acceptance traceability table**

Record exact test names/commands for current/original/discount pricing, immutable revisions, strict template, callback race, segment continuity, billing/entitlements/payment, D-30/D-14/D-3, expiry/return, missing template, late enrollment, permissions, migrations, worker restart, and rollback. Mark only real-provider SMS and real-provider e-sign interaction as staging manual checks; their internal state transitions must still have automated provider-mock tests.

- [x] **Step 2: Request code review and address only evidence-backed findings**

Use `superpowers:requesting-code-review`. For every finding, reproduce it with a focused test before changing code; rerun the affected task tests after the fix.

- [x] **Step 3: Re-run completion verification**

```powershell
pnpm quality:gate
pnpm build
git diff --check
git status --short --branch
git log --oneline --decorate -15
```

Expected: all gates PASS and the worktree is clean.

- [x] **Step 4: Commit verification evidence**

```powershell
git add docs/superpowers/plans/2026-08-05-stage1b-contract-extension-renewal-implementation-plan.md docs/verification/stage1b-contract-extension-renewal-verification.md
git commit -m "docs: verify stage1b contract renewals"
```

- [x] **Step 5: Use the branch-finishing workflow**

Use `superpowers:finishing-a-development-branch` to present merge/PR choices. Do not push, open a PR, merge, migrate staging, enable the feature flag, or send external notifications without the user's explicit authorization at that stage.
