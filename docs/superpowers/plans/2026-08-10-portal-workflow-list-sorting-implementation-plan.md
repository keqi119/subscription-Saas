# Portal Workflow List Sorting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Portal 账单及流程列表在完整结果集中优先展示客户当前待办，再展示平台处理中记录，最后展示已完成或已取消的历史记录。

**Architecture:** 在 API 侧新增无业务依赖的稳定排序键和状态桶分页规划工具。账单、支付单、服务工单使用只读事务中的状态桶全局分页；订单只全量读取单客户非终态工作集并在内存计算关联期限，历史订单继续数据库分页；无分页列表在服务层稳定排序。Portal Web 不二次排序，也不改变接口契约。

**Tech Stack:** TypeScript 6、NestJS、Prisma 7.8、PostgreSQL、Vitest、pnpm monorepo

## Global Constraints

- 执行前使用 `superpowers:using-git-worktrees` 创建隔离 worktree；不得直接在当前 `main` 上实施业务代码。
- 在 worktree 中先运行并记录：

```powershell
git status --short
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm prisma:validate
```

- migration status 失败或存在待执行迁移时停止实施并报告；禁止执行 `prisma migrate reset`。
- 不新增数据库字段、索引或迁移，不使用 `$queryRaw`、`$executeRaw` 或手写 SQL。
- 不修改 Portal API 路由、查询参数、响应字段、分页字段或客户数据边界。
- 不新增 Portal Tab、筛选项、按钮或前端当前页排序。
- 账单固定优先级必须为 `OVERDUE -> PARTIALLY_PAID -> PENDING -> PAID -> CANCELLED`。
- 流程列表固定优先级必须为客户待操作、平台处理中、已完成/历史。
- 订单允许全量读取当前客户的非终态工作集；终态历史必须继续数据库分页。
- 非终态订单超过 100 条时记录 `PORTAL_ORDER_ACTIVE_SET_LARGE` 结构化告警，告警不得包含个人信息。
- 消息、流水、核销、自动扣款、商品、材料、权益和里程复核的既有专用排序不得改变。
- Golden Path 和微信模板验收不在本计划范围。
- 每项功能严格执行测试先行：先观察目标测试失败，再写最小实现，再运行回归测试。
- 每个任务只提交该任务列出的文件，保留 `.superpowers/`、`apps/api/tmp/`、`output/`、`tmp/` 等既有未跟踪目录。

## File Structure

### 新建

- `apps/api/src/common/portal-list-ordering.ts`：稳定排序键比较和状态桶分页切片规划，不引用 Prisma 模型或业务枚举。
- `apps/api/test/portal-list-ordering.spec.ts`：纯函数边界、稳定排序和跨桶分页测试。

### 修改

- `apps/api/src/portal/portal-billing.service.ts`：账单状态桶分页、订单非终态工作集排序与历史拼页。
- `apps/api/test/portal-order-billing.spec.ts`：账单、订单、跨页、筛选、告警和数据隔离测试。
- `apps/api/src/payment/payment-order.service.ts`：Portal 支付单状态桶分页。
- `apps/api/test/portal-payment.spec.ts`：支付单待办优先及跨页测试。
- `apps/api/src/service-case/service-case.service.ts`：Portal 服务工单状态桶分页。
- `apps/api/test/portal-service-case.spec.ts`：等待客户、处理中、历史排序测试。
- `apps/api/src/portal/portal-application.service.ts`：申请下一步动作优先排序。
- `apps/api/test/portal-application.spec.ts`：补材料、确认方案、处理中、终态排序测试。
- `apps/api/src/esign/esign.service.ts`：合同可签任务优先排序，并复用 Portal 可签判断。
- `apps/api/test/esign.spec.ts`：可签、处理中、已签/归档合同排序测试。
- `apps/api/src/portal/portal-handover-review.service.ts`：交付复核客户确认/签署待办优先排序。
- `apps/api/test/portal-handover-review.spec.ts`：交付复核分组和预约时间测试。
- `apps/api/src/portal/portal-renewal.service.ts`：续租下一步动作优先排序。
- `apps/api/test/portal-renewal.spec.ts`：续租决策、报价确认、处理中、终态排序测试。

### 明确不修改

- `apps/web/**`：Web 继续按 API 返回顺序渲染。
- `apps/api/prisma/schema.prisma` 和 `apps/api/prisma/migrations/**`：本轮无数据结构变化。

---

### Task 1: 通用稳定排序与状态桶分页规划

**Files:**
- Create: `apps/api/src/common/portal-list-ordering.ts`
- Test: `apps/api/test/portal-list-ordering.spec.ts`

**Interfaces:**
- Produces: `PortalListSortKey`
- Produces: `comparePortalListSortKeys(left, right): number`
- Produces: `sortByPortalListOrder<T>(items, keyOf): T[]`
- Produces: `PortalBucketCount<TBucket>`、`PortalBucketSlice<TBucket>`
- Produces: `planPortalBucketPage<TBucket>(buckets, skip, take): PortalBucketSlice<TBucket>[]`

- [ ] **Step 1: 写排序和分页规划失败测试**

```ts
import { describe, expect, it } from "vitest";

import {
  planPortalBucketPage,
  sortByPortalListOrder
} from "../src/common/portal-list-ordering";

describe("portal list ordering", () => {
  it("sorts priority, deadline, updatedAt, createdAt, then id", () => {
    const rows = [
      key("processing", 1, null, "2026-08-10T03:00:00Z"),
      key("late-action", 0, "2026-08-12T00:00:00Z", "2026-08-10T04:00:00Z"),
      key("early-action", 0, "2026-08-11T00:00:00Z", "2026-08-10T02:00:00Z"),
      key("history", 2, null, "2026-08-10T05:00:00Z")
    ];

    expect(sortByPortalListOrder(rows, (row) => row).map((row) => row.id)).toEqual([
      "early-action",
      "late-action",
      "processing",
      "history"
    ]);
  });

  it("puts a dated row before an undated row inside the same priority", () => {
    const rows = [
      key("undated", 0, null, "2026-08-10T05:00:00Z"),
      key("dated", 0, "2026-08-11T00:00:00Z", "2026-08-10T01:00:00Z")
    ];
    expect(sortByPortalListOrder(rows, (row) => row).map((row) => row.id)).toEqual([
      "dated",
      "undated"
    ]);
  });

  it("plans one page across multiple ordered buckets", () => {
    expect(
      planPortalBucketPage(
        [
          { bucket: "ACTION" as const, count: 3 },
          { bucket: "PROCESSING" as const, count: 4 },
          { bucket: "HISTORY" as const, count: 5 }
        ],
        2,
        5
      )
    ).toEqual([
      { bucket: "ACTION", skip: 2, take: 1 },
      { bucket: "PROCESSING", skip: 0, take: 4 }
    ]);
  });

  it("returns no slices for an offset beyond the total", () => {
    expect(planPortalBucketPage([{ bucket: "A", count: 2 }], 3, 10)).toEqual([]);
  });
});

function key(
  id: string,
  priority: number,
  deadlineAt: string | null,
  updatedAt: string
) {
  return {
    createdAt: new Date("2026-08-01T00:00:00Z"),
    deadlineAt: deadlineAt ? new Date(deadlineAt) : null,
    id,
    priority,
    updatedAt: new Date(updatedAt)
  };
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-list-ordering.spec.ts
```

Expected: FAIL，提示无法解析 `../src/common/portal-list-ordering`。

- [ ] **Step 3: 实现无业务依赖的排序和分页工具**

```ts
export interface PortalListSortKey {
  createdAt: Date;
  deadlineAt: Date | null;
  id: string;
  priority: number;
  updatedAt: Date;
}

export interface PortalBucketCount<TBucket extends string> {
  bucket: TBucket;
  count: number;
}

export interface PortalBucketSlice<TBucket extends string> {
  bucket: TBucket;
  skip: number;
  take: number;
}

export function comparePortalListSortKeys(
  left: PortalListSortKey,
  right: PortalListSortKey
) {
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.deadlineAt && right.deadlineAt) {
    const deadlineDiff = left.deadlineAt.getTime() - right.deadlineAt.getTime();
    if (deadlineDiff !== 0) return deadlineDiff;
  } else if (left.deadlineAt || right.deadlineAt) {
    return left.deadlineAt ? -1 : 1;
  }
  const updatedDiff = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (updatedDiff !== 0) return updatedDiff;
  const createdDiff = right.createdAt.getTime() - left.createdAt.getTime();
  if (createdDiff !== 0) return createdDiff;
  return left.id.localeCompare(right.id);
}

export function sortByPortalListOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => PortalListSortKey
) {
  return [...items].sort((left, right) =>
    comparePortalListSortKeys(keyOf(left), keyOf(right))
  );
}

export function planPortalBucketPage<TBucket extends string>(
  buckets: readonly PortalBucketCount<TBucket>[],
  skip: number,
  take: number
): PortalBucketSlice<TBucket>[] {
  if (skip < 0 || take <= 0) return [];
  const slices: PortalBucketSlice<TBucket>[] = [];
  let remainingSkip = skip;
  let remainingTake = take;
  for (const { bucket, count } of buckets) {
    if (remainingTake === 0) break;
    if (remainingSkip >= count) {
      remainingSkip -= count;
      continue;
    }
    const bucketTake = Math.min(count - remainingSkip, remainingTake);
    slices.push({ bucket, skip: remainingSkip, take: bucketTake });
    remainingSkip = 0;
    remainingTake -= bucketTake;
  }
  return slices;
}
```

- [ ] **Step 4: 运行通用工具测试并确认通过**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-list-ordering.spec.ts
```

Expected: PASS，4 个测试全部通过。

- [ ] **Step 5: 提交通用工具**

```powershell
git add apps/api/src/common/portal-list-ordering.ts apps/api/test/portal-list-ordering.spec.ts
git commit -m "feat: add portal list ordering primitives"
```

---

### Task 2: 账单固定状态优先级与跨桶分页

**Files:**
- Modify: `apps/api/src/portal/portal-billing.service.ts:268-288`
- Modify: `apps/api/test/portal-order-billing.spec.ts`

**Interfaces:**
- Consumes: `planPortalBucketPage()` from Task 1
- Produces: `listBills()` 在完整结果集上按五种状态和到期日排序，响应结构不变

- [ ] **Step 1: 扩展账单夹具并写失败测试**

在 `createPortalBillingHarness()` 返回值中暴露 `bills`，给账单夹具补齐 `createdAt`、`updatedAt`，让 `makeBill()` 使用传入的 `dueDate/createdAt/updatedAt`，并让 `receivableBill.findMany` 支持 `skip/take`。新增以下测试：

```ts
it("sorts bills by business status before due date across pages", async () => {
  const harness = createPortalBillingHarness();
  harness.bills.splice(
    0,
    harness.bills.length,
    makeBill({ id: "paid", billNo: "PAID", billStatus: BillStatus.PAID, dueDate: new Date("2026-06-01T00:00:00Z"), remainingAmount: 0n }),
    makeBill({ id: "pending", billNo: "PENDING", billStatus: BillStatus.PENDING, dueDate: new Date("2026-06-20T00:00:00Z") }),
    makeBill({ id: "partial", billNo: "PARTIAL", billStatus: BillStatus.PARTIALLY_PAID, dueDate: new Date("2026-06-19T00:00:00Z"), paidAmount: 1n }),
    makeBill({ id: "overdue-new", billNo: "OVERDUE-NEW", billStatus: BillStatus.OVERDUE, dueDate: new Date("2026-06-10T00:00:00Z") }),
    makeBill({ id: "overdue-old", billNo: "OVERDUE-OLD", billStatus: BillStatus.OVERDUE, dueDate: new Date("2026-06-05T00:00:00Z") }),
    makeBill({ id: "cancelled", billNo: "CANCELLED", billStatus: BillStatus.CANCELLED, dueDate: new Date("2026-05-01T00:00:00Z"), remainingAmount: 0n })
  );

  const first = await harness.service.listBills(
    harness.currentCustomer("customer_a"),
    { page: 1, pageSize: 3 }
  );
  const second = await harness.service.listBills(
    harness.currentCustomer("customer_a"),
    { page: 2, pageSize: 3 }
  );

  expect(first.items.map((item) => item.billNo)).toEqual([
    "OVERDUE-OLD",
    "OVERDUE-NEW",
    "PARTIAL"
  ]);
  expect(second.items.map((item) => item.billNo)).toEqual([
    "PENDING",
    "PAID",
    "CANCELLED"
  ]);
  expect(first.total).toBe(6);
});

it("keeps a bill status filter and only sorts inside that status", async () => {
  const harness = createPortalBillingHarness();
  harness.bills.splice(
    0,
    harness.bills.length,
    makeBill({ id: "pending-late", billNo: "LATE", dueDate: new Date("2026-06-22T00:00:00Z") }),
    makeBill({ id: "pending-soon", billNo: "SOON", dueDate: new Date("2026-06-20T00:00:00Z") }),
    makeBill({ id: "paid", billNo: "PAID", billStatus: BillStatus.PAID, remainingAmount: 0n })
  );

  const result = await harness.service.listBills(
    harness.currentCustomer("customer_a"),
    { billStatus: BillStatus.PENDING }
  );

  expect(result.items.map((item) => item.billNo)).toEqual(["SOON", "LATE"]);
  expect(result.total).toBe(2);
});
```

- [ ] **Step 2: 运行账单测试并确认旧实现失败**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-order-billing.spec.ts
```

Expected: FAIL，旧实现把所有状态混合后仅按 `dueDate` 排序。

- [ ] **Step 3: 实现账单状态桶只读事务分页**

在服务文件新增：

```ts
const PORTAL_BILL_STATUS_ORDER = [
  BillStatus.OVERDUE,
  BillStatus.PARTIALLY_PAID,
  BillStatus.PENDING,
  BillStatus.PAID,
  BillStatus.CANCELLED
] as const;
```

将 `listBills()` 改为：

```ts
async listBills(currentCustomer: CurrentCustomer, query: PortalBillsQueryDto) {
  const { page, pageSize, skip } = resolvePagination(query);
  const baseWhere: Prisma.ReceivableBillWhereInput = {
    billType: query.billType,
    customerId: currentCustomer.customerId,
    deletedAt: null,
    orderId: query.orderId
  };
  const statuses = query.billStatus
    ? [query.billStatus]
    : [...PORTAL_BILL_STATUS_ORDER];

  return this.prisma.$transaction(async (tx) => {
    const counts = await Promise.all(
      statuses.map((status) =>
        tx.receivableBill.count({ where: { ...baseWhere, billStatus: status } })
      )
    );
    const slices = planPortalBucketPage(
      statuses.map((status, index) => ({ bucket: status, count: counts[index] ?? 0 })),
      skip,
      pageSize
    );
    const pages = await Promise.all(
      slices.map((slice) =>
        tx.receivableBill.findMany({
          include: { order: { select: { id: true, orderNo: true, orderStatus: true } } },
          orderBy: [
            { dueDate: "asc" },
            { updatedAt: "desc" },
            { createdAt: "desc" },
            { id: "asc" }
          ],
          skip: slice.skip,
          take: slice.take,
          where: { ...baseWhere, billStatus: slice.bucket }
        })
      )
    );
    const total = counts.reduce((sum, count) => sum + count, 0);
    return paged(pages.flat().map(toBillListItem), total, page, pageSize);
  });
}
```

同时给测试 Prisma 增加回调式 `$transaction`，并确保 mock 对 `billStatus`、`skip/take` 和上述组内字段排序的行为与真实 Prisma 一致。

- [ ] **Step 4: 运行账单及通用工具测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-list-ordering.spec.ts test/portal-order-billing.spec.ts
```

Expected: PASS。

- [ ] **Step 5: 提交账单排序**

```powershell
git add apps/api/src/portal/portal-billing.service.ts apps/api/test/portal-order-billing.spec.ts
git commit -m "feat: prioritize actionable portal bills"
```

---

### Task 3: 支付单待支付优先与全局分页

**Files:**
- Modify: `apps/api/src/payment/payment-order.service.ts:193-220`
- Modify: `apps/api/test/portal-payment.spec.ts`

**Interfaces:**
- Consumes: `planPortalBucketPage()` from Task 1
- Produces: `listPortalPaymentOrders()` 将 `CREATED/PENDING` 置于全部历史状态之前

- [ ] **Step 1: 增加支付单构造助手和失败测试**

在支付夹具返回对象中增加 `addPaymentOrder(input)`，创建包含 `cashierUrlExpiresAt`、`createdAt`、`updatedAt`、`paymentStatus` 和现有 include 所需字段的记录；给 mock 增加回调式 `$transaction` 与 `skip/take`。新增：

```ts
it("puts payable payment orders before historical orders across pages", async () => {
  const harness = createPaymentHarness();
  harness.addPaymentOrder({ id: "paid", paymentStatus: PaymentOrderStatus.PAID, updatedAt: new Date("2026-08-10T05:00:00Z") });
  harness.addPaymentOrder({ id: "pending-late", paymentStatus: PaymentOrderStatus.PENDING, cashierUrlExpiresAt: new Date("2026-08-12T00:00:00Z") });
  harness.addPaymentOrder({ id: "created-soon", paymentStatus: PaymentOrderStatus.CREATED, cashierUrlExpiresAt: new Date("2026-08-11T00:00:00Z") });
  harness.addPaymentOrder({ id: "failed", paymentStatus: PaymentOrderStatus.FAILED, updatedAt: new Date("2026-08-10T06:00:00Z") });

  const first = await harness.service.listPortalPaymentOrders(
    harness.currentCustomer("customer_a"),
    { page: 1, pageSize: 2 }
  );
  const second = await harness.service.listPortalPaymentOrders(
    harness.currentCustomer("customer_a"),
    { page: 2, pageSize: 2 }
  );

  expect(first.items.map((item) => item.id)).toEqual(["created-soon", "pending-late"]);
  expect(second.items.map((item) => item.id)).toEqual(["failed", "paid"]);
});

it("keeps paymentStatus filtering exact", async () => {
  const harness = createPaymentHarness();
  harness.addPaymentOrder({ id: "pending", paymentStatus: PaymentOrderStatus.PENDING });
  harness.addPaymentOrder({ id: "paid", paymentStatus: PaymentOrderStatus.PAID });

  const result = await harness.service.listPortalPaymentOrders(
    harness.currentCustomer("customer_a"),
    { paymentStatus: PaymentOrderStatus.PAID }
  );
  expect(result.items.map((item) => item.id)).toEqual(["paid"]);
});
```

- [ ] **Step 2: 运行支付测试并确认失败**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-payment.spec.ts
```

Expected: FAIL，旧实现仅按 `createdAt desc`。

- [ ] **Step 3: 实现支付单两桶分页**

新增状态定义：

```ts
const PORTAL_PAYMENT_ORDER_BUCKETS = [
  {
    bucket: "ACTION" as const,
    statuses: [PaymentOrderStatus.CREATED, PaymentOrderStatus.PENDING]
  },
  {
    bucket: "HISTORY" as const,
    statuses: [
      PaymentOrderStatus.PAID,
      PaymentOrderStatus.FAILED,
      PaymentOrderStatus.CLOSED,
      PaymentOrderStatus.CANCELLED,
      PaymentOrderStatus.EXPIRED
    ]
  }
] as const;
```

`listPortalPaymentOrders()` 在回调式只读事务中：

1. 保留 customer、debitAttempt、deletedAt、orderId、paymentChannel 条件作为 `baseWhere`；
2. 若 `query.paymentStatus` 存在，仅保留包含该状态的桶并将桶状态收窄为该状态；
3. 分别 count；
4. 使用 `planPortalBucketPage()` 计算切片；
5. `ACTION` 桶按 `cashierUrlExpiresAt asc nulls last`、`updatedAt desc`、`createdAt desc`、`id asc`；
6. `HISTORY` 桶按 `updatedAt desc`、`createdAt desc`、`id asc`；
7. 拼接后继续调用 `toPaymentOrderView()`，返回原有 `{ items, page, pageSize, total }`。

ACTION 桶的 Prisma 排序必须使用：

```ts
orderBy: [
  { cashierUrlExpiresAt: { sort: "asc", nulls: "last" } },
  { updatedAt: "desc" },
  { createdAt: "desc" },
  { id: "asc" }
]
```

- [ ] **Step 4: 运行支付单与通用分页测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-list-ordering.spec.ts test/portal-payment.spec.ts
```

Expected: PASS。

- [ ] **Step 5: 提交支付单排序**

```powershell
git add apps/api/src/payment/payment-order.service.ts apps/api/test/portal-payment.spec.ts
git commit -m "feat: prioritize actionable portal payments"
```

---

### Task 4: 服务工单等待客户优先与全局分页

**Files:**
- Modify: `apps/api/src/service-case/service-case.service.ts:279-306`
- Modify: `apps/api/test/portal-service-case.spec.ts`

**Interfaces:**
- Consumes: `planPortalBucketPage()` from Task 1
- Produces: `listPortalServiceCases()` 按等待客户、平台处理、历史三组分页

- [ ] **Step 1: 写服务工单跨页失败测试**

给 `addCase()` 补齐可覆盖的 `updatedAt/createdAt`，给 Prisma mock 增加回调式 `$transaction` 和 `skip/take`。新增：

```ts
it("puts waiting-customer cases before processing and history", async () => {
  const harness = createServiceCaseHarness();
  harness.addCase({ id: "closed", caseStatus: ServiceCaseStatus.CLOSED, updatedAt: new Date("2026-08-10T06:00:00Z") });
  harness.addCase({ id: "submitted", caseStatus: ServiceCaseStatus.SUBMITTED, updatedAt: new Date("2026-08-10T05:00:00Z") });
  harness.addCase({ id: "waiting-old", caseStatus: ServiceCaseStatus.WAITING_CUSTOMER, updatedAt: new Date("2026-08-10T03:00:00Z") });
  harness.addCase({ id: "waiting-new", caseStatus: ServiceCaseStatus.WAITING_CUSTOMER, updatedAt: new Date("2026-08-10T04:00:00Z") });
  harness.addCase({ id: "resolved", caseStatus: ServiceCaseStatus.RESOLVED, updatedAt: new Date("2026-08-10T07:00:00Z") });

  const first = await harness.service.listPortalServiceCases(
    currentCustomer("customer-a"),
    { page: 1, pageSize: 3 }
  );
  const second = await harness.service.listPortalServiceCases(
    currentCustomer("customer-a"),
    { page: 2, pageSize: 3 }
  );

  expect(first.items.map((item) => item.id)).toEqual([
    "waiting-new",
    "waiting-old",
    "submitted"
  ]);
  expect(second.items.map((item) => item.id)).toEqual(["resolved", "closed"]);
});

it("keeps caseStatus filtering exact", async () => {
  const harness = createServiceCaseHarness();
  harness.addCase({ id: "waiting", caseStatus: ServiceCaseStatus.WAITING_CUSTOMER });
  harness.addCase({ id: "closed", caseStatus: ServiceCaseStatus.CLOSED });

  const result = await harness.service.listPortalServiceCases(
    currentCustomer("customer-a"),
    { caseStatus: ServiceCaseStatus.CLOSED }
  );
  expect(result.items.map((item) => item.id)).toEqual(["closed"]);
});
```

- [ ] **Step 2: 运行测试并确认旧实现失败**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-service-case.spec.ts
```

Expected: FAIL，旧实现把最近的终态工单排在等待客户之前。

- [ ] **Step 3: 实现三桶只读事务分页**

新增：

```ts
const PORTAL_SERVICE_CASE_BUCKETS = [
  { bucket: "ACTION" as const, statuses: [ServiceCaseStatus.WAITING_CUSTOMER] },
  {
    bucket: "PROCESSING" as const,
    statuses: [
      ServiceCaseStatus.SUBMITTED,
      ServiceCaseStatus.ACCEPTED,
      ServiceCaseStatus.IN_PROGRESS
    ]
  },
  {
    bucket: "HISTORY" as const,
    statuses: [
      ServiceCaseStatus.RESOLVED,
      ServiceCaseStatus.CLOSED,
      ServiceCaseStatus.CANCELLED
    ]
  }
] as const;
```

`listPortalServiceCases()` 保留 customer、caseType、deletedAt 作为 `baseWhere`，按 `query.caseStatus` 收窄桶，使用 `planPortalBucketPage()`。三个桶内部统一按：

```ts
orderBy: [
  { updatedAt: "desc" },
  { createdAt: "desc" },
  { id: "asc" }
]
```

查询、count 和分页记录读取必须位于同一个回调式 `$transaction` 中，返回 DTO 和分页字段不变。

- [ ] **Step 4: 运行服务工单与通用分页测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-list-ordering.spec.ts test/portal-service-case.spec.ts
```

Expected: PASS。

- [ ] **Step 5: 提交服务工单排序**

```powershell
git add apps/api/src/service-case/service-case.service.ts apps/api/test/portal-service-case.spec.ts
git commit -m "feat: prioritize portal service case actions"
```

---

### Task 5: 订单动态待办排序、非终态工作集与历史拼页

**Files:**
- Modify: `apps/api/src/portal/portal-billing.service.ts:1-120,202-223,489-690`
- Modify: `apps/api/test/portal-order-billing.spec.ts`

**Interfaces:**
- Consumes: `PortalListSortKey` and `sortByPortalListOrder()` from Task 1
- Produces: `portalOrderSortKey(order): PortalListSortKey`
- Produces: `listOrders()` 对非终态工作集内存排序、终态历史数据库分页

- [ ] **Step 1: 写订单真实待办、跨页和告警失败测试**

给测试枚举导入增加 `ESignTaskStatus`；给 `makeOrder()` 增加 `updatedAt`，允许覆盖 `contract/contracts/receivableBills/mileageReviews`；给订单 mock 支持 `orderStatus.in/notIn`、`skip/take` 和终态排序。新增以下测试：

```ts
it("orders customer actions by earliest real deadline before processing", async () => {
  const harness = createPortalBillingHarness();
  harness.orders.splice(
    0,
    harness.orders.length,
    makeOrder({ id: "processing", orderNo: "PROCESSING", orderStatus: OrderStatus.PENDING_DELIVERY, updatedAt: new Date("2026-08-10T06:00:00Z") }),
    makeOrder({
      id: "sign",
      orderNo: "SIGN",
      orderStatus: OrderStatus.PENDING_SIGN,
      contract: {
        contractNo: "CON-SIGN",
        createdAt: new Date("2026-08-09T00:00:00Z"),
        esignTasks: [{
          signUrlExpiresAt: new Date("2026-08-10T12:00:00Z"),
          taskStatus: ESignTaskStatus.WAITING_CUSTOMER
        }],
        id: "contract-sign",
        signedAt: null,
        status: ContractStatus.SIGNING
      }
    }),
    makeOrder({
      id: "pay",
      orderNo: "PAY",
      orderStatus: OrderStatus.ACTIVE,
      receivableBills: [makeBill({ id: "pay-bill", orderId: "pay", dueDate: new Date("2026-08-12T00:00:00Z") })]
    }),
    makeOrder({
      id: "mileage",
      orderNo: "MILEAGE",
      orderStatus: OrderStatus.ACTIVE,
      receivableBills: [],
      mileageReviews: [{
        cycleNo: 1,
        dueAt: new Date("2026-08-11T00:00:00Z"),
        id: "review-mileage",
        lockVersion: 0,
        overMileageBillId: null,
        scheduledReviewAt: new Date("2026-08-10T00:00:00Z"),
        status: OrderMileageReviewStatus.PENDING_SUBMISSION
      }]
    })
  );

  const result = await harness.service.listOrders(harness.currentCustomer("customer_a"), {});
  expect(result.items.map((item) => item.orderNo)).toEqual([
    "SIGN",
    "MILEAGE",
    "PAY",
    "PROCESSING"
  ]);
});

it("continues from sorted non-terminal orders into paged history", async () => {
  const harness = createPortalBillingHarness();
  harness.orders.splice(
    0,
    harness.orders.length,
    makeOrder({ id: "active", orderNo: "ACTIVE", orderStatus: OrderStatus.PENDING_PAYMENT }),
    makeOrder({ id: "completed-new", orderNo: "COMPLETED-NEW", orderStatus: OrderStatus.COMPLETED, updatedAt: new Date("2026-08-10T06:00:00Z") }),
    makeOrder({ id: "completed-old", orderNo: "COMPLETED-OLD", orderStatus: OrderStatus.COMPLETED, updatedAt: new Date("2026-08-09T06:00:00Z") })
  );

  const page = await harness.service.listOrders(
    harness.currentCustomer("customer_a"),
    { page: 1, pageSize: 2 }
  );
  expect(page.items.map((item) => item.orderNo)).toEqual(["ACTIVE", "COMPLETED-NEW"]);
  expect(page.total).toBe(3);
});

it("keeps orderStatus filtering exact", async () => {
  const harness = createPortalBillingHarness();
  harness.orders.splice(
    0,
    harness.orders.length,
    makeOrder({ id: "active", orderNo: "ACTIVE", orderStatus: OrderStatus.ACTIVE }),
    makeOrder({ id: "completed", orderNo: "COMPLETED", orderStatus: OrderStatus.COMPLETED })
  );

  const result = await harness.service.listOrders(
    harness.currentCustomer("customer_a"),
    { orderStatus: OrderStatus.COMPLETED }
  );
  expect(result.items.map((item) => item.orderNo)).toEqual(["COMPLETED"]);
  expect(result.total).toBe(1);
});

it("warns without customer PII when the non-terminal working set exceeds 100", async () => {
  const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  const harness = createPortalBillingHarness();
  harness.orders.splice(
    0,
    harness.orders.length,
    ...Array.from({ length: 101 }, (_, index) =>
      makeOrder({ id: `active-${index}`, orderNo: `ACTIVE-${index}` })
    )
  );

  await harness.service.listOrders(harness.currentCustomer("customer_a"), { page: 1, pageSize: 20 });

  expect(warn).toHaveBeenCalledWith({
    errorCode: "PORTAL_ORDER_ACTIVE_SET_LARGE",
    nonTerminalCount: 101,
    page: 1,
    pageSize: 20
  });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("13800000000");
  warn.mockRestore();
});
```

- [ ] **Step 2: 运行订单测试并确认失败**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-order-billing.spec.ts
```

Expected: FAIL，旧实现只按 `createdAt desc`，也没有大工作集告警。

- [ ] **Step 3: 扩展订单查询关联数据**

在 `portalOrderInclude` 中：

- 给 `receivableBills.select` 增加 `dueDate`；
- 给 `contract` 和 `contracts` 增加最新未删除电子签任务的 `signUrlExpiresAt`、`taskStatus`；
- 电子签任务按 `createdAt desc`，`take: 1`；
- 保留原有合同、账单、里程、交付、车辆和权益字段。

合同选择结构使用：

```ts
esignTasks: {
  orderBy: { createdAt: "desc" as const },
  select: {
    signUrlExpiresAt: true,
    taskStatus: true
  },
  take: 1,
  where: { deletedAt: null }
}
```

- [ ] **Step 4: 实现订单分类、期限和稳定排序键**

新增 `Logger`、`ESignTaskStatus` 导入及以下常量：

```ts
const PORTAL_TERMINAL_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.TERMINATED,
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED
]);

const PORTAL_CUSTOMER_ACTION_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.PENDING_CUSTOMER_CONFIRMATION,
  OrderStatus.PENDING_SIGN,
  OrderStatus.PENDING_PAYMENT
]);

const PORTAL_SIGNABLE_TASK_STATUSES = new Set<ESignTaskStatus>([
  ESignTaskStatus.CREATED,
  ESignTaskStatus.WAITING_CUSTOMER,
  ESignTaskStatus.SIGNING
]);
```

实现 `portalOrderSortKey(order)`：

1. 用现有 `summarizeBills()`、`toMileageReviewSummary()` 和 `resolveOrderNextAction()` 取得真实动作；
2. `SIGN_CONTRACT`、`PAY_BILL`、`SUBMIT_MILEAGE_REVIEW` 或主状态位于 `PORTAL_CUSTOMER_ACTION_ORDER_STATUSES` 时 `priority = 0`；
3. 其他非终态 `priority = 1`；
4. 从可签任务 `signUrlExpiresAt`、可支付账单 `dueDate`、可操作里程复核 `dueAt` 中取最早日期作为 `deadlineAt`；
5. 返回订单 `updatedAt/createdAt/id` 作为稳定兜底。

期限计算必须只采纳当前仍可执行的事实：已签合同、已付/取消账单、非待提交里程复核不得贡献期限。

- [ ] **Step 5: 实现非终态工作集和终态历史拼页**

给 `PortalBillingService` 增加：

```ts
private readonly logger = new Logger(PortalBillingService.name);
```

`listOrders()` 在回调式事务中执行：

```ts
const requestedStatus = query.orderStatus as OrderStatus | undefined;
const requestsTerminal = requestedStatus
  ? PORTAL_TERMINAL_ORDER_STATUSES.has(requestedStatus)
  : null;
const nonTerminalWhere: Prisma.SubscriptionOrderWhereInput = {
  customerId: currentCustomer.customerId,
  deletedAt: null,
  orderStatus: requestedStatus ?? { notIn: [...PORTAL_TERMINAL_ORDER_STATUSES] }
};
const terminalWhere: Prisma.SubscriptionOrderWhereInput = {
  customerId: currentCustomer.customerId,
  deletedAt: null,
  orderStatus: requestedStatus ?? { in: [...PORTAL_TERMINAL_ORDER_STATUSES] }
};
```

- `requestsTerminal === true` 时非终态数组为空；
- `requestsTerminal === false` 时终态数量为 0；
- 未筛选时同时读取全部非终态和终态 count；
- 非终态使用 `sortByPortalListOrder(nonTerminalOrders, portalOrderSortKey)`；
- 大于 100 条时以对象形式调用 `logger.warn()`，字段严格为测试中的四个字段；
- 当前页先从排序后的非终态数组 `slice(skip, skip + pageSize)`；
- 剩余容量从终态查询，终态 `skip = Math.max(skip - nonTerminalCount, 0)`；
- 终态按 `updatedAt desc`、`createdAt desc`、`id asc`；
- 总数为 `nonTerminalCount + terminalCount`；
- 返回前统一调用现有 `toPortalOrderListItem()`。

- [ ] **Step 6: 运行订单、账单和通用排序测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-list-ordering.spec.ts test/portal-order-billing.spec.ts
```

Expected: PASS，且现有订单详情下一步动作测试不回归。

- [ ] **Step 7: 提交订单排序**

```powershell
git add apps/api/src/portal/portal-billing.service.ts apps/api/test/portal-order-billing.spec.ts
git commit -m "feat: prioritize portal order actions"
```

---

### Task 6: 申请列表复用下一步动作排序

**Files:**
- Modify: `apps/api/src/portal/portal-application.service.ts:200-212,1215-1259`
- Modify: `apps/api/test/portal-application.spec.ts`

**Interfaces:**
- Consumes: `PortalListSortKey` and `sortByPortalListOrder()` from Task 1
- Consumes: existing `resolvePortalNextAction(application)`
- Produces: `portalApplicationSortKey(application): PortalListSortKey`

- [ ] **Step 1: 写申请待办优先失败测试**

在测试中使用现有 `createApplication()`、`readyFinalPlanApplication()`，覆盖 `prisma.application.findMany` 返回多条归属同一客户的申请：

```ts
it("sorts customer application actions before processing and terminal records", async () => {
  const harness = createPortalApplicationFixture();
  const upload = createApplication({
    id: "application-upload",
    applicationNo: "APP-UPLOAD",
    status: ApplicationStatus.NEED_MORE_INFO,
    updatedAt: new Date("2026-08-08T00:00:00Z")
  });
  const confirm = createApplication({
    ...readyFinalPlanApplication(),
    id: "application-confirm",
    applicationNo: "APP-CONFIRM",
    updatedAt: new Date("2026-08-09T00:00:00Z")
  });
  const processing = createApplication({
    id: "application-processing",
    applicationNo: "APP-PROCESSING",
    status: ApplicationStatus.SUBMITTED,
    updatedAt: new Date("2026-08-10T00:00:00Z")
  });
  const cancelled = createApplication({
    id: "application-cancelled",
    applicationNo: "APP-CANCELLED",
    status: ApplicationStatus.CANCELLED,
    updatedAt: new Date("2026-08-11T00:00:00Z")
  });
  vi.mocked(harness.prisma.application.findMany).mockResolvedValue([
    cancelled,
    processing,
    upload,
    confirm
  ] as never);

  const result = await harness.service.listApplications(currentCustomer("customer-1"));

  expect(result.map((item) => item.applicationNo)).toEqual([
    "APP-CONFIRM",
    "APP-UPLOAD",
    "APP-PROCESSING",
    "APP-CANCELLED"
  ]);
});

it("sinks an application whose latest order is terminal", async () => {
  const harness = createPortalApplicationFixture();
  const terminalOrderApplication = createApplication({
    ...readyFinalPlanApplication({ planConfirmStatus: PlanConfirmStatus.CONFIRMED }),
    id: "application-completed",
    orders: [{
      contractId: "contract-1",
      deletedAt: null,
      handoverWorkOrders: [],
      id: "order-completed",
      mileageReviews: [],
      orderNo: "ORD-COMPLETED",
      orderStatus: OrderStatus.COMPLETED
    }]
  });
  const processing = createApplication({
    id: "application-processing",
    status: ApplicationStatus.SUBMITTED
  });
  vi.mocked(harness.prisma.application.findMany).mockResolvedValue([
    terminalOrderApplication,
    processing
  ] as never);

  const result = await harness.service.listApplications(currentCustomer("customer-1"));
  expect(result.map((item) => item.id)).toEqual([
    "application-processing",
    "application-completed"
  ]);
});
```

- [ ] **Step 2: 运行申请测试并确认失败**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-application.spec.ts
```

Expected: FAIL，旧实现依赖数据库 `createdAt desc`。

- [ ] **Step 3: 实现申请排序键并用于列表**

新增：

```ts
const PORTAL_APPLICATION_ACTIONS = new Set([
  "UPLOAD_MATERIAL",
  "CONFIRM_FINAL_PLAN",
  "GO_CONTRACT",
  "GO_PAYMENT",
  "SUBMIT_MILEAGE_REVIEW"
]);

const PORTAL_APPLICATION_TERMINAL_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.TERMINATED,
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED
]);
```

`portalApplicationSortKey()` 必须先判断申请拒绝/取消或最新非删除订单终态，终态 `priority = 2`；否则调用 `resolvePortalNextAction()`，命中动作集合时 `priority = 0`，其余 `priority = 1`。本轮申请没有独立业务期限，`deadlineAt = null`，使用申请 `updatedAt/createdAt/id` 稳定排序。

将列表返回改为：

```ts
return sortByPortalListOrder(applications, portalApplicationSortKey).map(
  toPortalApplicationListItem
);
```

- [ ] **Step 4: 运行申请和通用排序测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-list-ordering.spec.ts test/portal-application.spec.ts
```

Expected: PASS，既有申请创建、材料、方案确认和权限测试不回归。

- [ ] **Step 5: 提交申请排序**

```powershell
git add apps/api/src/portal/portal-application.service.ts apps/api/test/portal-application.spec.ts
git commit -m "feat: prioritize portal application actions"
```

---

### Task 7: 合同可签任务优先排序

**Files:**
- Modify: `apps/api/src/esign/esign.service.ts:851-862,4022-4065`
- Modify: `apps/api/test/esign.spec.ts`

**Interfaces:**
- Consumes: `PortalListSortKey` and `sortByPortalListOrder()` from Task 1
- Produces: `isPortalContractSignable(contract): boolean`
- Produces: `portalContractSortKey(contract): PortalListSortKey`

- [ ] **Step 1: 写可签、处理中、历史合同排序失败测试**

在 `lists and reads only contracts owned by the portal customer` 邻近位置新增：

```ts
it("puts signable portal contracts before processing and terminal contracts", async () => {
  const harness = createESignFixture();
  const processing = createContract(
    "contract-processing",
    "customer-1",
    "order-processing",
    "ORD-PROCESSING"
  );
  processing.updatedAt = new Date("2026-08-10T05:00:00Z");
  const signed = createContract(
    "contract-signed",
    "customer-1",
    "order-signed",
    "ORD-SIGNED"
  );
  signed.status = ContractStatus.SIGNED;
  signed.signedAt = new Date("2026-08-10T06:00:00Z");
  signed.updatedAt = new Date("2026-08-10T06:00:00Z");
  harness.state.contracts.push(processing, signed);
  await harness.service.createTaskForContract(
    "contract-1",
    adminUser(),
    requestContext()
  );

  const contracts = await harness.service.listPortalContracts(
    currentCustomer("customer-1")
  );

  expect(contracts.map((contract) => contract.id)).toEqual([
    "contract-1",
    "contract-processing",
    "contract-signed"
  ]);
});
```

测试夹具的 `hydrateContract()` 已提供 `esignTasks`；确保创建任务的 `signUrlExpiresAt` 早于空期限记录，并保留 customer ownership 过滤断言。

- [ ] **Step 2: 运行电子签测试并确认失败**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/esign.spec.ts
```

Expected: FAIL，最近更新的已签合同仍可能位于可签合同之前。

- [ ] **Step 3: 抽取 Portal 可签判断并实现合同排序键**

把 `toPortalContractDetail()` 内现有 `canSign` 布尔表达式抽为：

```ts
function isPortalContractSignable(contract: ContractForESign) {
  const task = findCurrentPortalSigningTask(contract);
  if (!task) return false;
  const identity = getPortalContractSigningIdentity(contract);
  const supportedIdentity =
    (identity.signingStage === "STAGE1_SUBSCRIPTION_CONTRACT" &&
      identity.documentType === "SUBSCRIPTION_CONTRACT") ||
    (identity.signingStage === "STAGE3_SUBSCRIPTION_EXTENSION" &&
      identity.documentType === "SUBSCRIPTION_EXTENSION_AGREEMENT");
  return supportedIdentity && PORTAL_SIGNABLE_ESIGN_TASK_STATUSES.includes(task.taskStatus);
}
```

详情 DTO 使用 `canSign: isPortalContractSignable(contract)`，避免排序规则与按钮权限分叉。

`portalContractSortKey()` 规则：

- 合同状态为 `SIGNED/ARCHIVED/TERMINATED/CANCELLED` 时 `priority = 2`、`deadlineAt = null`；
- `isPortalContractSignable(contract)` 为真时 `priority = 0`，期限为当前任务 `signUrlExpiresAt`；
- 其他为 `priority = 1`、`deadlineAt = null`；
- 使用合同 `updatedAt/createdAt/id` 兜底。

`listPortalContracts()` 在 map 前调用 `sortByPortalListOrder()`。

- [ ] **Step 4: 运行电子签和通用排序测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-list-ordering.spec.ts test/esign.spec.ts
```

Expected: PASS，Portal 合同详情 `canSign` 和原电子签状态机测试保持通过。

- [ ] **Step 5: 提交合同排序**

```powershell
git add apps/api/src/esign/esign.service.ts apps/api/test/esign.spec.ts
git commit -m "feat: prioritize signable portal contracts"
```

---

### Task 8: 车辆交付复核待确认和待签署优先排序

**Files:**
- Modify: `apps/api/src/portal/portal-handover-review.service.ts:20-43,88-105`
- Modify: `apps/api/test/portal-handover-review.spec.ts`

**Interfaces:**
- Consumes: `PortalListSortKey` and `sortByPortalListOrder()` from Task 1
- Produces: `portalHandoverReviewSortKey(workOrder): PortalListSortKey`

- [ ] **Step 1: 写复核分组和预约时间失败测试**

新增：

```ts
it("puts customer handover actions before processing and completed reviews", async () => {
  const harness = createPortalReviewHarness();
  harness.state.workOrders.push(
    completeReviewWorkOrder(harness, {
      id: "review-action-late",
      scheduledAt: new Date("2026-08-12T00:00:00Z"),
      status: "CUSTOMER_REVIEWING"
    }),
    completeReviewWorkOrder(harness, {
      id: "review-action-soon",
      scheduledAt: new Date("2026-08-11T00:00:00Z"),
      status: "EVIDENCE_SUBMITTED"
    }),
    completeReviewWorkOrder(harness, {
      id: "review-sign",
      handover: {
        archiveStatus: "NOT_STARTED",
        archivedAt: null,
        completedAt: null,
        id: "handover-sign",
        status: "PENDING_CUSTOMER_SIGNATURE"
      },
      scheduledAt: new Date("2026-08-13T00:00:00Z"),
      status: "SIGNING"
    }),
    completeReviewWorkOrder(harness, {
      id: "review-processing",
      status: "CUSTOMER_OBJECTED",
      updatedAt: new Date("2026-08-10T06:00:00Z")
    }),
    completeReviewWorkOrder(harness, {
      id: "review-completed",
      status: "OPS_REVIEWED",
      updatedAt: new Date("2026-08-10T07:00:00Z")
    })
  );

  const reviews = await harness.service.listReviews(currentCustomer("customer-1"));
  expect(reviews.map((review) => review.id)).toEqual([
    "review-action-soon",
    "review-action-late",
    "review-sign",
    "review-processing",
    "review-completed"
  ]);
});
```

- [ ] **Step 2: 运行交付复核测试并确认失败**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-handover-review.spec.ts
```

Expected: FAIL，旧实现只按 `scheduledAt asc`，会把已完成记录混入待办前部。

- [ ] **Step 3: 实现交付复核排序键**

新增集合：

```ts
const PORTAL_HANDOVER_HISTORY_STATUSES = new Set(["FIELD_COMPLETED", "OPS_REVIEWED"]);
const PORTAL_HANDOVER_SIGNED_STATUSES = new Set(["SIGNED", "ARCHIVED"]);
```

`portalHandoverReviewSortKey()` 按以下顺序判断：

1. 工单历史状态或关联 handover 已签署/归档：`priority = 2`、`deadlineAt = null`；
2. 工单位于现有 `CUSTOMER_REVIEW_ACTIONABLE_STATUSES`，或 handover 为 `PENDING_CUSTOMER_SIGNATURE`：`priority = 0`；
3. 其他 Portal 可见工单：`priority = 1`；
4. 客户待办和平台处理中使用 `scheduledAt` 作为期限；
5. 使用工单 `updatedAt/createdAt/id` 兜底。

`listReviews()` 查询后先稳定排序，再执行现有 `Promise.all(...toReviewListItem)`，避免异步 DTO 构造改变顺序。

- [ ] **Step 4: 运行交付复核和通用排序测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-list-ordering.spec.ts test/portal-handover-review.spec.ts
```

Expected: PASS，既有 ownership、附件代理、确认、异议和签署测试不回归。

- [ ] **Step 5: 提交交付复核排序**

```powershell
git add apps/api/src/portal/portal-handover-review.service.ts apps/api/test/portal-handover-review.spec.ts
git commit -m "feat: prioritize portal handover actions"
```

---

### Task 9: 续租下一步动作优先排序

**Files:**
- Modify: `apps/api/src/portal/portal-renewal.service.ts:82-89,400-505`
- Modify: `apps/api/test/portal-renewal.spec.ts`

**Interfaces:**
- Consumes: `PortalListSortKey` and `sortByPortalListOrder()` from Task 1
- Consumes: existing `considerationNextAction(consideration)`
- Produces: `portalRenewalSortKey(consideration): PortalListSortKey`

- [ ] **Step 1: 写续租动作、处理和终态排序失败测试**

新增：

```ts
it("sorts renewal customer actions before processing and terminal records", async () => {
  const harness = portalRenewalHarness();
  const action = {
    ...harness.state.consideration,
    changeOrder: null,
    completionDeadlineAt: new Date("2026-08-11T00:00:00Z"),
    id: "renewal-action"
  };
  const processing = {
    ...harness.state.consideration,
    changeOrder: {
      ...harness.state.change,
      status: SubscriptionChangeStatus.DRAFT
    },
    completionDeadlineAt: new Date("2026-08-10T00:00:00Z"),
    decision: RenewalDecision.RENEW,
    id: "renewal-processing",
    status: RenewalConsiderationStatus.RENEWAL_REQUESTED
  };
  const completed = {
    ...harness.state.consideration,
    changeOrder: {
      ...harness.state.change,
      status: SubscriptionChangeStatus.COMPLETED
    },
    completionDeadlineAt: new Date("2026-08-09T00:00:00Z"),
    decision: RenewalDecision.RENEW,
    id: "renewal-completed",
    status: RenewalConsiderationStatus.EXTENDED
  };
  vi.mocked(harness.prisma.renewalConsideration.findMany).mockResolvedValue([
    completed,
    processing,
    action
  ] as never);

  const result = await harness.service.list(harness.customer);
  expect(result.map((item) => item.id)).toEqual([
    "renewal-action",
    "renewal-processing",
    "renewal-completed"
  ]);
});

it("orders renewal actions by completion deadline", async () => {
  const harness = portalRenewalHarness();
  const late = {
    ...harness.state.consideration,
    changeOrder: null,
    completionDeadlineAt: new Date("2026-08-12T00:00:00Z"),
    id: "renewal-late"
  };
  const soon = {
    ...harness.state.consideration,
    changeOrder: null,
    completionDeadlineAt: new Date("2026-08-11T00:00:00Z"),
    id: "renewal-soon"
  };
  vi.mocked(harness.prisma.renewalConsideration.findMany).mockResolvedValue([
    late,
    soon
  ] as never);

  const result = await harness.service.list(harness.customer);
  expect(result.map((item) => item.id)).toEqual(["renewal-soon", "renewal-late"]);
});
```

- [ ] **Step 2: 运行续租测试并确认失败**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-renewal.spec.ts
```

Expected: FAIL，旧实现只按 `completionDeadlineAt`，可能把终态置于客户待办之前。

- [ ] **Step 3: 实现续租排序键**

新增：

```ts
const PORTAL_RENEWAL_CUSTOMER_ACTIONS = new Set([
  "DECIDE_RENEW_OR_EXPIRE",
  "REVIEW_QUOTE",
  "SIGN_AGREEMENT",
  "PREPARE_RETURN"
]);

const PORTAL_RENEWAL_HISTORY_STATUSES = new Set<RenewalConsiderationStatus>([
  RenewalConsiderationStatus.EXTENDED,
  RenewalConsiderationStatus.EXPIRED,
  RenewalConsiderationStatus.CANCELLED
]);
```

`portalRenewalSortKey()`：

- 历史状态或 `considerationNextAction()` 为 `RENEWAL_COMPLETED` 时 `priority = 2`、`deadlineAt = null`；
- 下一步动作位于客户动作集合时 `priority = 0`；
- 其他为 `priority = 1`；
- 非历史记录使用 `completionDeadlineAt`；
- 使用 consideration `updatedAt/createdAt/id` 兜底。

测试夹具给 consideration 补齐 `createdAt/updatedAt`。`list()` 在 DTO 映射前使用 `sortByPortalListOrder()`。

- [ ] **Step 4: 运行续租和通用排序测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-list-ordering.spec.ts test/portal-renewal.spec.ts test/portal-renewal-security.spec.ts
```

Expected: PASS。

- [ ] **Step 5: 提交续租排序**

```powershell
git add apps/api/src/portal/portal-renewal.service.ts apps/api/test/portal-renewal.spec.ts
git commit -m "feat: prioritize portal renewal actions"
```

---

### Task 10: 集成回归、质量门禁与范围核验

**Files:**
- Verify only; no planned source file creation

**Interfaces:**
- Consumes: Tasks 1-9
- Produces: 可进入 staging 构建和人工验收的已验证分支

- [ ] **Step 1: 运行本轮全部定向测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-list-ordering.spec.ts test/portal-order-billing.spec.ts test/portal-payment.spec.ts test/portal-service-case.spec.ts test/portal-application.spec.ts test/esign.spec.ts test/portal-handover-review.spec.ts test/portal-renewal.spec.ts test/portal-renewal-security.spec.ts
```

Expected: PASS，退出码 0。

- [ ] **Step 2: 运行 API 全量测试**

Run:

```powershell
pnpm --filter @subscription-saas/api test
```

Expected: PASS，退出码 0。

- [ ] **Step 3: 运行 lint、两端类型检查和 Prisma 校验**

Run:

```powershell
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
```

Expected: 全部退出码 0。

- [ ] **Step 4: 再次确认迁移状态**

Run:

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected: 数据库 schema 已是最新状态；本分支没有新迁移。

- [ ] **Step 5: 核验范围、差异和提交历史**

Run:

```powershell
git diff --check main...HEAD
git diff --name-only main...HEAD
git log --oneline main..HEAD
git status --short
```

Expected:

- `git diff --check` 无输出；
- 差异只包含 File Structure 中列出的 API 和测试文件；若执行分支基于已包含设计与计划文档的 `main`，两份文档无需再次出现在差异中；
- `apps/web/**`、Prisma schema、migrations 无差异；
- 工作区没有本轮未提交文件；既有未跟踪目录保持原状。

- [ ] **Step 6: 形成 staging 人工验收清单**

交付说明必须列出以下人工验收项：

1. 账单依次为已逾期、部分支付、待支付、已支付、已取消；
2. 账单同状态按到期日升序；
3. 申请、订单、合同、支付单、服务工单、交付复核和续租的客户待办均置顶；
4. 平台处理中记录位于待办之后；
5. 已完成、已取消等记录仍可查看但沉底；
6. 状态筛选准确；
7. 翻页无重复、无漏项；
8. 页面按钮、详情入口和操作路径未变化；
9. 消息、流水、核销、自动扣款、商品、材料、权益和里程复核排序未变化。

- [ ] **Step 7: 若质量工具产生受控格式化差异则单独提交**

仅当 lint/format 工具实际修改了本轮范围内文件时执行：

```powershell
git add -- apps/api/src/common/portal-list-ordering.ts apps/api/src/portal/portal-billing.service.ts apps/api/src/payment/payment-order.service.ts apps/api/src/service-case/service-case.service.ts apps/api/src/portal/portal-application.service.ts apps/api/src/esign/esign.service.ts apps/api/src/portal/portal-handover-review.service.ts apps/api/src/portal/portal-renewal.service.ts apps/api/test/portal-list-ordering.spec.ts apps/api/test/portal-order-billing.spec.ts apps/api/test/portal-payment.spec.ts apps/api/test/portal-service-case.spec.ts apps/api/test/portal-application.spec.ts apps/api/test/esign.spec.ts apps/api/test/portal-handover-review.spec.ts apps/api/test/portal-renewal.spec.ts
git commit -m "chore: normalize portal sorting changes"
```

若没有格式化差异，不创建空提交。
