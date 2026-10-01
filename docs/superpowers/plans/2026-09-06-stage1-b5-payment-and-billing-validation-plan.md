# Stage 1 B5 主动支付与账单维护独立验证实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** DRAFT / PENDING_REVIEW. This document is a proposed validation unit, not execution approval.

**Goal:** Independently prove the existing active-payment authority chain and recurring-billing maintenance idempotency, adding only focused tests and a truthful validation record unless a PostgreSQL counterexample is observed and a separate narrow production-fix plan is approved.

**Architecture:** Treat `PaymentOrder` plus a verified `PaymentCallbackLog` as channel authority, a confirmed `PaymentRecord` as receipt authority, `PaymentWriteOff` as allocation authority, and `ReceivableBill` as amount/balance/status authority. Exercise the real `PaymentOrderService.handleCallback()` to `FinanceService.settlePaymentOrder()` transaction through the self-contained fresh lifecycle of the existing `run-database-suite.mjs`, and reuse the existing billing database suite, maintenance fact implementation, and manifest; do not create another target record, runner, credential, cleanup, or evidence-object design.

**Tech Stack:** NestJS 11, Prisma 7, PostgreSQL 17, TypeScript 6, Vitest 4, Node.js test runner, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md`; authority matrix: `docs/superpowers/specs/2026-09-01-stage1-s0-authority-and-temporary-asset-governance-design.zh-CN.md`; billing behavior: `docs/superpowers/specs/2026-07-31-stage1b-recurring-billing-overdue-automation-design.zh-CN.md`; mainline dependency map: `docs/superpowers/plans/2026-09-06-stage1-mainline-minimal-release-implementation-plan.md`; repository baseline: `DEV_SPEC.md`.

## 审批摘要

- 本计划只申请主动支付 authority、回调异常/部分金额/重复回放，以及账单维护正向幂等的聚焦测试和本轮新鲜证据；不预授权产品代码、Schema 或发布运行器修改。
- 所有真实 PostgreSQL 验证只调用现有自包含 `run-database-suite.mjs --chain fresh` 生命周期；不建立固定 target、凭证、bootstrap、cleanup 或新证据对象。完整 `PASSED`/`FAILED` 报告都先 custody/readback 再清理，只有无法产出完整报告的 launcher incident 才保留资源并交精确处置摘要。
- Mock/合成验证不等于真实微信支付、Staging 或两个自然月运行；B6 法务/关账、自动扣款和生产修复均不在范围，任何真实反例都先停止并另行报审。

## Global Constraints

- Scope is only B5: customer-initiated active payment, verified callbacks, confirmed receipt/allocation/bill authority, and recurring billing maintenance positive/replay behavior.
- Stage 1 remains `ACTIVE_PAYMENT_ONLY`. Do not add or enable `PaymentMandate`, `DebitAttempt`, auto-debit jobs, mandate mock behavior, or any auto-debit configuration.
- Do not implement B6 closure, waiver, bad-debt, legal collection, settlement-disposition, vehicle release, or order-completion behavior. Existing closure/legal guards may be read and retained but are not modified by B5.
- Do not add a model, enum, migration, RBAC permission, feature flag, billing-maintenance evidence object, alternate manifest, database launcher, credential reader, cleanup utility, or framework.
- `PaymentOrder`/verified callback, confirmed `PaymentRecord`, `PaymentWriteOff`, and `ReceivableBill` remain separate authorities. No test may manufacture a `PAID` bill and call that proof of a callback or receipt.
- All money remains integer cents. A callback amount different from the immutable payment-order amount must not create a `PaymentRecord`, `PaymentWriteOff`, or bill balance mutation.
- An exact duplicate successful callback may append another callback log, but must produce exactly one payment record, one allocation per paid bill amount, and one bill transition. The new real-PostgreSQL probe intentionally constructs `FinanceService` without the optional Journey signal and therefore proves money facts only; existing focused `payment-settlement.spec.ts` and `subscription-journey-payment.spec.ts` remain the evidence cited for settlement signaling.
- Existing conforming behavior is captured as characterization evidence; do not manufacture a RED phase. A newly added invariant probe may report PASS or expose a real counterexample.
- If a unit or PostgreSQL probe exposes a production defect, preserve the failing test and exact observed rows/output, mark the validation record `BLOCKED_COUNTEREXAMPLE`, and stop. Production files may be changed only under a separate approved plan naming the exact method and counterexample.
- Current P1 results are historical only. Do not copy their counts or receipts as B5 success, and do not read, reuse, or reconstruct a retired P1 controlled-target record, archive, or credential.
- Every `run-database-suite.mjs --chain fresh` invocation owns a separate run-scoped PostgreSQL 17 cluster, suite database, migration verification, custody/readback, and normal complete-report cleanup lifecycle. A counted test failure returns a custodized `terminalStatus=FAILED` report, removes the current run, and exits `1`; only a failure without a complete report becomes a retained incident. B5 never bootstraps a fixed target, creates a second target record, or invokes cleanup independently.
- Before any fresh-suite invocation, reject a dirty checkout and the mere presence of ambient database environment names or retired fixed-target paths without reading their values/content. If the launcher cannot produce a complete `PASSED` or `FAILED` report and retains an incident for bounded reconciliation, stop: do not retry, mutate, or clean it; hand off the exact current-run incident path and non-secret identifiers for explicit disposition.
- This planning turn runs no product tests, database commands, migrations, external provider calls, deployment, GitHub/cloud API, signing, or operational commands. It reads source and writes this plan only.
- Each future commit is restricted to the files listed by its task. Main or the explicitly approved executor owns commits; this draft author does not commit.

## File Ownership And Interface Map

| Path                                                                                                                                                                                     | B5 action                                                               | Responsibility / coordination                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/portal-payment.spec.ts`                                                                                                                                                   | Modify in Task 1                                                        | Mock-boundary characterization for unverified, non-paid, amount-mismatch, and duplicate callbacks. Coordinate with A1 if it concurrently owns Portal-payment acceptance tests.           |
| `apps/api/test/payment-authority.integration.spec.ts`                                                                                                                                    | Create in Task 2                                                        | Focused real-PostgreSQL active-payment authority test. It owns only its local fixture IDs/row cleanup and consumes the suite-issued database context.                                    |
| `release/contracts/database-test-manifest.v1.json`                                                                                                                                       | Modify only the `api.billing-automation.postgres.files` array in Task 2 | Add the focused payment integration file to the existing fresh/snapshot-capable suite. Coordinate serialization with R2, which owns runner/migrate/verify behavior.                      |
| `apps/api/test/billing-automation.integration.spec.ts`                                                                                                                                   | Modify in Task 3                                                        | Add one positive repeated-dispatch assertion using existing `PrismaService`, `BillingAutomationRepository`, and runtime fixture imports; do not edit shared fixtures.                    |
| `docs/acceptance/2026-09-06-stage1-b5-payment-and-billing-validation-record.md`                                                                                                          | Create in Task 4                                                        | Human-readable command/result/source-authority record; not a new database evidence object and not a Stage 1 sign-off.                                                                    |
| `apps/api/src/payment/payment-order.service.ts`                                                                                                                                          | Read only                                                               | Produces `handleCallback(provider, payload, headers?, rawBody?)` and gates `FinanceService.settlePaymentOrder()` behind a verified paid event.                                           |
| `apps/api/src/finance/finance.service.ts`                                                                                                                                                | Read only                                                               | Produces `settlePaymentOrder(input: SettlePaymentOrderInput)` and owns the receipt/write-off/bill transaction and payment-order lock.                                                    |
| `apps/api/src/billing-automation/{billing-automation.service.ts,billing-automation.repository.ts,billing-maintenance-evidence.service.ts}`                                               | Read only                                                               | Produces real reconciliation/dispatch, stable job upsert, and the existing two-sequence maintenance fact behavior.                                                                       |
| `apps/api/test/{payment-settlement.spec.ts,subscription-journey-payment.spec.ts,billing-maintenance-evidence.service.spec.ts,billing-maintenance-evidence-postgres.integration.spec.ts}` | Read/run only                                                           | Existing evidence for allocation math, Journey waiting, fact source binding, sequence `1,2`, locking, and append-only constraints. Do not duplicate these assertions in a new framework. |
| `apps/api/test/helpers/{release-database-test-context.ts,runtime-domain-fixture.ts}`                                                                                                     | Read only                                                               | Existing suite-issued database context consumer and seed primitives. B5 must not take ownership or add cleanup/credential APIs.                                                          |
| `scripts/release/run-database-suite.mjs`, `scripts/release/database-test-launcher-runtime.mjs`                                                                                           | Read/run entry; runtime read only                                       | Existing self-contained fresh-suite lifecycle: discovery, cluster/database creation, migration checks, evidence custody/readback, success teardown, and retained-failure incident state. |
| `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/**`                                                                                                                         | Read only                                                               | Existing authority schema; no B5 migration is authorized.                                                                                                                                |

The only produced runtime interface is test coverage registered under the existing suite ID `api.billing-automation.postgres`; there is no new production API. B4 may consume the proven paid-bill precondition for activation, B6 may later consume confirmed receipt/write-off/bill facts, and A3 owns real WeChat/Staging validation. None of those consumers authorizes B5 to write their state.

---

### Task 1: Pin Callback Verification And Amount-Mismatch Boundaries

**Files:**

- Modify: `apps/api/test/portal-payment.spec.ts`
- Read: `apps/api/src/payment/payment-order.service.ts`
- Read: `apps/api/src/payment/mock-payment.provider.ts`
- Test: `apps/api/test/portal-payment.spec.ts`
- Test: `apps/api/test/payment-settlement.spec.ts`
- Test: `apps/api/test/subscription-journey-payment.spec.ts`

**Interfaces:**

- Consumes: `PaymentOrderService.handleCallback(provider: string, payload: unknown, headers?: Record<string, unknown>, rawBody?: Buffer)`.
- Consumes: `PaymentProvider.verifyCallback(payload: unknown, headers?: Record<string, unknown>, rawBody?: Buffer): Promise<VerifyPaymentCallbackResult>` and the current `createPaymentHarness()`.
- Proves: only `verified === true` plus a paid event reaches `FinanceService.settlePaymentOrder()`; an amount mismatch records callback/payment-order failure information but creates no receipt/allocation; duplicate success is exactly-once for money facts.
- Produces: no production interface and no provider-connectivity claim.

- [ ] **Step 1: Re-read the production gates and inventory already-passing coverage**

  Read `handleCallback()` and `completePaymentOrder()` in `payment-order.service.ts`, `settlePaymentOrder()` in `finance.service.ts`, and the named tests. Record the exact existing cases for route/provider mismatch, Mock-disabled rejection, verified non-paid event, provider-scoped lookup, duplicate callback, allocation cap, Journey wait, and settlement signal. This is evidence discovery, not a request to rewrite passing tests.

- [ ] **Step 2: Generate prerequisites in an independent clean checkout, then run the current focused unit baseline before editing**

  Run:

  ```powershell
  $prerequisiteStatus = @(git status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $prerequisiteStatus.Count -gt 0) {
    throw "B5_PREREQUISITE_CHECKOUT_NOT_CLEAN"
  }
  pnpm --filter @subscription-saas/shared build
  if ($LASTEXITCODE -ne 0) { throw "B5_SHARED_BUILD_FAILED" }
  pnpm prisma:generate
  if ($LASTEXITCODE -ne 0) { throw "B5_PRISMA_GENERATE_FAILED" }
  $generatedStatus = @(git status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $generatedStatus.Count -gt 0) {
    throw "B5_PREREQUISITE_GENERATION_DIRTIED_CHECKOUT"
  }
  pnpm --filter @subscription-saas/api exec vitest run test/portal-payment.spec.ts test/payment-settlement.spec.ts test/subscription-journey-payment.spec.ts
  if ($LASTEXITCODE -ne 0) { throw "B5_UNIT_BASELINE_FAILED" }
  ```

  Expected: the shared build, Prisma generation, and focused unit command each exit `0`, generation leaves the independent checkout clean, and the actual file/test/pass/fail counts are recorded. Do not cite P1's historical `303/4074` result. If an existing test fails, preserve its output in the Task 4 record and stop before changing assertions or production code.

- [ ] **Step 3: Strengthen the existing unverified-callback characterization**

  Do not add a duplicate invalid-callback test. In the existing `"records WeChat callback verification errors without marking the payment paid"` case, retain its real provider stub and current assertions, then add these authority checks:

  ```ts
  expect(harness.state.paymentRecords).toHaveLength(0);
  expect(harness.state.callbacks).toEqual([
    expect.objectContaining({
      errorMessage: "WECHATPAY_SERIAL_NOT_CONFIGURED",
      handled: false,
      paymentOrderId: null,
      verified: false
    })
  ]);
  expect(harness.state.bills[0]).toMatchObject({
    billStatus: BillStatus.PENDING,
    paidAmount: 0n,
    remainingAmount: 1000n
  });
  ```

  The current case already asserts `financeService.settlePaymentOrder` was not called and its payment order remains pending. `createPaymentHarness()` already returns `state`/`financeService`, and its `paymentCallbackLog.update` stub applies `errorMessage` through `Object.assign`; no harness-interface change is needed.

- [ ] **Step 4: Add the paid-event amount-mismatch characterization**

  Add this case beside the same callback group:

  ```ts
  it("rejects a verified partial amount without creating receipt or write-off facts", async () => {
    const harness = createPaymentHarness();
    harness.addBill({ id: "bill-partial-callback", remainingAmount: 1000n });
    const paymentOrder = await harness.service.createPortalPaymentOrder(
      { billIds: ["bill-partial-callback"], paymentChannel: PaymentChannel.MOCK },
      harness.currentCustomer("customer_a"),
      harness.context
    );
    const providerTradeNo = harness.state.paymentOrders.find(
      (candidate) => candidate.id === paymentOrder.id
    )!.providerTradeNo;

    await expect(
      harness.service.handleCallback("mock", {
        eventType: "mock.payment.success",
        paidAmount: 400,
        providerTradeNo,
        providerTransactionId: "partial-provider-transaction"
      })
    ).rejects.toThrow("支付金额与支付单金额不一致。");

    expect(harness.financeService.settlePaymentOrder).not.toHaveBeenCalled();
    expect(harness.state.paymentRecords).toHaveLength(0);
    expect(harness.state.bills[0]).toMatchObject({
      billStatus: BillStatus.PENDING,
      paidAmount: 0n,
      remainingAmount: 1000n
    });
    expect(harness.state.paymentOrders[0]).toMatchObject({
      paymentRecordId: null,
      paymentStatus: PaymentOrderStatus.FAILED
    });
    expect(harness.state.callbacks[0]).toMatchObject({
      handled: false,
      verified: true
    });
  });
  ```

- [ ] **Step 5: Strengthen the existing duplicate-callback assertion without duplicating the test**

  In `"handles mock paid callbacks idempotently"`, retain the existing two callback calls and add:

  ```ts
  expect(harness.state.paymentRecords).toHaveLength(1);
  expect(harness.state.callbacks).toHaveLength(2);
  expect(harness.state.callbacks.every((callback) => callback.verified && callback.handled)).toBe(
    true
  );
  expect(harness.state.bills[0]).toMatchObject({
    billStatus: BillStatus.PAID,
    paidAmount: 29900n,
    remainingAmount: 0n
  });
  ```

  This is a characterization assertion. Do not force it through a fake failing phase when the current behavior already conforms.

- [ ] **Step 6: Re-run the focused unit evidence**

  Run the Step 2 command. Expected: all three files pass, including the new amount-mismatch case and strengthened existing invalid/duplicate cases. Any failure is a counterexample; do not edit `apps/api/src/**` under this plan.

- [ ] **Step 7: Commit the unit-only validation increment after review**

  Recheck the release contracts/discovery and the exact file, then stage only the owned unit file and reject whitespace errors before the checkpoint commit:

  ```powershell
  pnpm release:contracts:verify
  if ($LASTEXITCODE -ne 0) { throw "B5_CONTRACT_VERIFY_FAILED" }
  pnpm release:database-tests:discover
  if ($LASTEXITCODE -ne 0) { throw "B5_DATABASE_DISCOVERY_FAILED" }
  pnpm exec prettier --check apps/api/test/portal-payment.spec.ts
  if ($LASTEXITCODE -ne 0) { throw "B5_UNIT_PRETTIER_FAILED" }
  git add apps/api/test/portal-payment.spec.ts
  if ($LASTEXITCODE -ne 0) { throw "B5_UNIT_STAGE_FAILED" }
  git diff --cached --check
  if ($LASTEXITCODE -ne 0) { throw "B5_UNIT_STAGED_DIFF_INVALID" }
  $staged = @(git diff --cached --name-only)
  if ($LASTEXITCODE -ne 0) { throw "B5_UNIT_STAGED_ENUM_FAILED" }
  if (($staged -join "`n") -ne 'apps/api/test/portal-payment.spec.ts') {
    throw "B5_UNIT_STAGED_SCOPE_INVALID: $($staged -join ',')"
  }
  git commit -m "test(payment): pin callback authority boundaries"
  if ($LASTEXITCODE -ne 0) { throw "B5_UNIT_CHECKPOINT_COMMIT_FAILED" }
  ```

  The staged-name output must contain exactly `apps/api/test/portal-payment.spec.ts`. This is a test-source checkpoint, not a claim that PostgreSQL validation passed.

---

### Task 2: Prove The Real PostgreSQL Payment Authority Chain And Replay

**Files:**

- Create: `apps/api/test/payment-authority.integration.spec.ts`
- Modify: `release/contracts/database-test-manifest.v1.json` only at `api.billing-automation.postgres.files`
- Read: `apps/api/src/payment/payment-order.service.ts`
- Read: `apps/api/src/finance/finance.service.ts`
- Read: `apps/api/test/helpers/release-database-test-context.ts`
- Read: `apps/api/test/helpers/runtime-domain-fixture.ts`
- Test: `apps/api/test/payment-authority.integration.spec.ts`

**Interfaces:**

- Consumes: existing `requiredReleaseDatabaseTestContext("apps/api/test/payment-authority.integration.spec.ts").databaseUrl` and `insertRuntimeOrderGraph(tx, input)`; no ambient `DATABASE_URL` and no credential parsing of its own.
- Consumes: real `PaymentOrderService.handleCallback()` and real `FinanceService.settlePaymentOrder()` with `AuditService` and `PrismaService`.
- Produces: PostgreSQL evidence that one verified paid callback transaction yields one confirmed `PaymentRecord`, exact `PaymentWriteOff`, exact `ReceivableBill` balance/status, and that deterministically overlapped duplicate callbacks append logs without duplicating money facts. This probe does not claim Journey-signal evidence.
- Produces: a discoverable file inside the existing `api.billing-automation.postgres` suite; no new suite ID or launcher.

- [ ] **Step 1: Add the focused integration file using the existing database context**

  Create the file with these imports and lifecycle. The database context is issued by the suite. Row cleanup stays local to B5 identifiers; the existing fresh runner alone owns the surrounding cluster/database lifecycle.

  ```ts
  import { ConfigService } from "@nestjs/config";
  import {
    BillStatus,
    BillType,
    PaymentChannel,
    PaymentOrderStatus,
    PaymentProviderType,
    PaymentStatus
  } from "@prisma/client";
  import type { Prisma } from "@prisma/client";
  import { randomUUID } from "node:crypto";
  import { afterAll, beforeAll, describe, expect, it } from "vitest";

  import { AuditService } from "../src/audit/audit.service";
  import { FinanceService } from "../src/finance/finance.service";
  import { MockPaymentProvider } from "../src/payment/mock-payment.provider";
  import { PaymentOrderService } from "../src/payment/payment-order.service";
  import { PrismaService } from "../src/prisma/prisma.service";
  import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
  import { insertRuntimeOrderGraph } from "./helpers/runtime-domain-fixture";

  const DATABASE_URL = requiredReleaseDatabaseTestContext(
    "apps/api/test/payment-authority.integration.spec.ts"
  ).databaseUrl;

  describe("active payment authority PostgreSQL integration", () => {
    let prisma: PrismaService;
    let audit: AuditService;
    let config: ConfigService;
    let service: PaymentOrderService;

    beforeAll(async () => {
      prisma = new PrismaService(new ConfigService({ DATABASE_POOL_MAX: "5", DATABASE_URL }));
      await prisma.onModuleInit();
      config = new ConfigService({
        APP_ENV: "test",
        PAYMENT_DEFAULT_CHANNEL: "MOCK",
        PAYMENT_MOCK_ENABLED: "true",
        PAYMENT_PROVIDER: "mock",
        WECHAT_PAY_ENABLED: "false"
      });
      audit = new AuditService(prisma);
      const finance = new FinanceService(audit, prisma);
      service = new PaymentOrderService(
        audit,
        config,
        finance,
        new MockPaymentProvider(config),
        {} as never,
        prisma
      );
    });

    afterAll(async () => {
      await prisma.onModuleDestroy();
    });
  ```

- [ ] **Step 2: Add one real amount-mismatch test**

  Add this test inside the describe block; `seedPaymentFixture()` and `deletePaymentFixture()` are defined in Step 4.

  ```ts
  it("keeps a verified partial callback outside receipt, write-off, and bill authority", async () => {
    const fixture = await seedPaymentFixture(prisma, "PARTIAL");
    try {
      await expect(
        service.handleCallback("mock", {
          eventType: "mock.payment.success",
          paidAmount: 400,
          providerTradeNo: fixture.providerTradeNo,
          providerTransactionId: `${fixture.providerTradeNo}:partial`
        })
      ).rejects.toThrow("支付金额与支付单金额不一致。");

      await expect(
        prisma.paymentOrder.findUniqueOrThrow({ where: { id: fixture.paymentOrderId } })
      ).resolves.toMatchObject({
        paymentRecordId: null,
        paymentStatus: PaymentOrderStatus.FAILED
      });
      await expect(
        prisma.receivableBill.findUniqueOrThrow({ where: { id: fixture.billId } })
      ).resolves.toMatchObject({
        billStatus: BillStatus.PENDING,
        paidAmount: 0n,
        remainingAmount: 1000n
      });
      await expect(
        prisma.paymentRecord.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(0);
      await expect(
        prisma.paymentWriteOff.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(0);
      await expect(
        prisma.paymentCallbackLog.findFirstOrThrow({
          where: { providerTradeNo: fixture.providerTradeNo }
        })
      ).resolves.toMatchObject({ handled: false, verified: true });
    } finally {
      await deletePaymentFixture(prisma, fixture);
    }
  });
  ```

- [ ] **Step 3: Add one real concurrent duplicate-callback test**

  Add this second test inside the describe block. The local `$transaction` wrapper releases only after both real interactive transaction callbacks have entered; its rejecting timer fails the test if the second entry never arrives. It does not replace `lockPaymentOrder`, change SQL, or introduce a sleep:

  ```ts
  it("settles concurrent duplicate verified callbacks exactly once across all money facts", async () => {
    const fixture = await seedPaymentFixture(prisma, "DUPLICATE");
    const awaitTwoTransactions = createTwoTransactionEntryBarrier();
    const gatedPrisma = withTransactionEntryBarrier(prisma, awaitTwoTransactions);
    const concurrentFinance = new FinanceService(audit, gatedPrisma);
    const concurrentService = new PaymentOrderService(
      audit,
      config,
      concurrentFinance,
      new MockPaymentProvider(config),
      {} as never,
      prisma
    );
    const payload = {
      eventType: "mock.payment.success",
      paidAmount: 1000,
      providerTradeNo: fixture.providerTradeNo,
      providerTransactionId: `${fixture.providerTradeNo}:transaction`
    };
    try {
      const results = await Promise.all([
        concurrentService.handleCallback("mock", payload),
        concurrentService.handleCallback("mock", payload)
      ]);

      expect(results.every((result) => result.handled && result.verified)).toBe(true);
      const paymentOrder = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: fixture.paymentOrderId }
      });
      expect(paymentOrder).toMatchObject({
        paidAmount: 1000n,
        paymentStatus: PaymentOrderStatus.PAID,
        providerTransactionId: payload.providerTransactionId
      });
      expect(paymentOrder.paymentRecordId).not.toBeNull();

      const paymentRecords = await prisma.paymentRecord.findMany({
        where: { orderId: fixture.orderId }
      });
      expect(paymentRecords).toHaveLength(1);
      expect(paymentOrder.paymentRecordId).toBe(paymentRecords[0]!.id);
      expect(paymentRecords[0]).toMatchObject({
        paymentAmount: 1000n,
        paymentStatus: PaymentStatus.CONFIRMED
      });
      const writeOffs = await prisma.paymentWriteOff.findMany({
        where: { orderId: fixture.orderId }
      });
      expect(writeOffs).toEqual([
        expect.objectContaining({
          billId: fixture.billId,
          paymentId: paymentRecords[0]!.id,
          writeOffAmount: 1000n
        })
      ]);
      await expect(
        prisma.receivableBill.findUniqueOrThrow({ where: { id: fixture.billId } })
      ).resolves.toMatchObject({
        billStatus: BillStatus.PAID,
        paidAmount: 1000n,
        remainingAmount: 0n
      });
      await expect(
        prisma.paymentCallbackLog.count({
          where: { handled: true, paymentOrderId: fixture.paymentOrderId, verified: true }
        })
      ).resolves.toBe(2);
      await expect(
        prisma.auditLog.count({
          where: {
            entityId: {
              in: [fixture.paymentOrderId, paymentRecords[0]!.id, writeOffs[0]!.id]
            },
            entityType: { in: ["payment_order", "payment_record", "payment_write_off"] },
            module: "payment"
          }
        })
      ).resolves.toBe(3);
    } finally {
      await deletePaymentFixture(prisma, fixture);
    }
  });
  ```

- [ ] **Step 4: Add the local barrier and seed/delete helpers; do not modify shared fixture ownership**

  Close the describe block and add these helpers. The barrier is test-local and has a real timeout rejection rather than `sleep`/timing luck:

  ```ts
  function createTwoTransactionEntryBarrier(timeoutMs = 5000) {
    let entered = 0;
    let release!: () => void;
    let reject!: (error: Error) => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gate = new Promise<void>((resolve, rejectGate) => {
      release = resolve;
      reject = rejectGate;
    });
    return async () => {
      entered += 1;
      if (entered === 1) {
        timer = setTimeout(
          () => reject(new Error("B5_TRANSACTION_ENTRY_BARRIER_TIMEOUT")),
          timeoutMs
        );
      }
      if (entered === 2) {
        clearTimeout(timer!);
        release();
      }
      await gate;
    };
  }

  function withTransactionEntryBarrier(
    prisma: PrismaService,
    enter: () => Promise<void>
  ): PrismaService {
    const runTransaction = prisma.$transaction.bind(prisma);
    const gated = Object.create(prisma) as PrismaService;
    Object.defineProperty(gated, "$transaction", {
      value: ((callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        runTransaction(async (tx) => {
          await enter();
          return callback(tx);
        })) as PrismaService["$transaction"]
    });
    return gated;
  }

  interface PaymentFixture {
    billId: string;
    orderId: string;
    paymentOrderId: string;
    providerTradeNo: string;
  }

  async function seedPaymentFixture(prisma: PrismaService, label: string): Promise<PaymentFixture> {
    const orderId = randomUUID();
    const billId = randomUUID();
    const paymentOrderId = randomUUID();
    const providerTradeNo = `b5-${label.toLowerCase()}-${randomUUID()}`;
    const graph = await prisma.$transaction(async (tx) => {
      const created = await insertRuntimeOrderGraph(tx, {
        label: `B5-PAYMENT-${label}`,
        orderId,
        vehicleId: null
      });
      await tx.receivableBill.create({
        data: {
          amount: 1000n,
          billNo: `B5-BILL-${randomUUID()}`,
          billStatus: BillStatus.PENDING,
          billType: BillType.MONTHLY_RENT,
          customerId: created.customerId,
          dueDate: new Date("2026-09-01T00:00:00.000Z"),
          id: billId,
          orderId,
          paidAmount: 0n,
          remainingAmount: 1000n,
          sourceKey: `b5-payment:${orderId}`
        }
      });
      await tx.paymentOrder.create({
        data: {
          amount: 1000n,
          customerId: created.customerId,
          id: paymentOrderId,
          items: { create: [{ amount: 1000n, billId }] },
          orderId,
          paymentChannel: PaymentChannel.MOCK,
          paymentOrderNo: `B5-PYO-${randomUUID()}`,
          paymentStatus: PaymentOrderStatus.PENDING,
          provider: PaymentProviderType.MOCK,
          providerTradeNo
        }
      });
      return created;
    });
    expect(graph.customerId).toMatch(/^[0-9a-f-]{36}$/);
    return { billId, orderId, paymentOrderId, providerTradeNo };
  }

  async function deletePaymentFixture(prisma: PrismaService, fixture: PaymentFixture) {
    const paymentRecordIds = (
      await prisma.paymentRecord.findMany({
        select: { id: true },
        where: { orderId: fixture.orderId }
      })
    ).map(({ id }) => id);
    await prisma.paymentCallbackLog.deleteMany({
      where: { paymentOrderId: fixture.paymentOrderId }
    });
    await prisma.paymentWriteOff.deleteMany({ where: { orderId: fixture.orderId } });
    await prisma.paymentOrderItem.deleteMany({
      where: { paymentOrderId: fixture.paymentOrderId }
    });
    await prisma.paymentOrder.deleteMany({ where: { id: fixture.paymentOrderId } });
    await prisma.paymentRecord.deleteMany({ where: { id: { in: paymentRecordIds } } });
    await prisma.receivableBill.deleteMany({ where: { id: fixture.billId } });
  }
  ```

  The fresh-suite lifecycle owns disposal of remaining runtime order prerequisites with its suite database. Do not create or export a shared cleanup helper solely for B5.

- [ ] **Step 5: Register the file in the existing billing PostgreSQL suite**

  Change only this existing manifest field:

  ```json
  "files": [
    "apps/api/test/billing-automation.integration.spec.ts",
    "apps/api/test/payment-authority.integration.spec.ts"
  ]
  ```

  Keep suite ID `api.billing-automation.postgres`, both chain-applicability entries, role, timeout, barrier, owner, and expected-count policy unchanged.

- [ ] **Step 6: Create a clean test-source checkpoint, then run the existing suite launcher**

  Stage the exact pair first so Git-based discovery can see the formerly untracked real test. The staged manifest must already enumerate `apps/api/test/payment-authority.integration.spec.ts` in `api.billing-automation.postgres.files`. Then run contracts/discovery/static/format review against that staged source and create a checkpoint that makes the launcher's source checkout clean:

  ```powershell
  git add apps/api/test/payment-authority.integration.spec.ts release/contracts/database-test-manifest.v1.json
  if ($LASTEXITCODE -ne 0) { throw "B5_PAYMENT_PG_STAGE_FAILED" }
  $expectedStaged = @(
    'apps/api/test/payment-authority.integration.spec.ts',
    'release/contracts/database-test-manifest.v1.json'
  ) | Sort-Object
  $staged = @(git diff --cached --name-only)
  if ($LASTEXITCODE -ne 0) { throw "B5_PAYMENT_PG_STAGED_ENUM_FAILED" }
  $staged = @($staged | Sort-Object)
  if (($staged -join "`n") -ne ($expectedStaged -join "`n")) {
    throw "B5_PAYMENT_PG_STAGED_SCOPE_INVALID: $($staged -join ',')"
  }
  pnpm release:contracts:verify
  if ($LASTEXITCODE -ne 0) { throw "B5_CONTRACT_VERIFY_FAILED" }
  pnpm release:database-tests:discover
  if ($LASTEXITCODE -ne 0) { throw "B5_DATABASE_DISCOVERY_FAILED" }
  pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
  if ($LASTEXITCODE -ne 0) { throw "B5_PAYMENT_PG_TSC_FAILED" }
  pnpm exec prettier --check apps/api/test/payment-authority.integration.spec.ts release/contracts/database-test-manifest.v1.json
  if ($LASTEXITCODE -ne 0) { throw "B5_PAYMENT_PG_PRETTIER_FAILED" }
  git diff --cached -- release/contracts/database-test-manifest.v1.json
  if ($LASTEXITCODE -ne 0) { throw "B5_PAYMENT_MANIFEST_REVIEW_FAILED" }
  git diff --cached --check
  if ($LASTEXITCODE -ne 0) { throw "B5_PAYMENT_PG_STAGED_DIFF_INVALID" }
  git commit -m "test(payment): add postgres authority probes"
  if ($LASTEXITCODE -ne 0) { throw "B5_PAYMENT_PG_CHECKPOINT_COMMIT_FAILED" }
  $remaining = @(git status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $remaining.Count -gt 0) {
    throw "B5_PAYMENT_PG_CHECKPOINT_NOT_CLEAN"
  }
  ```

  Discovery must report no unclassified database tests and must map `apps/api/test/payment-authority.integration.spec.ts` to `api.billing-automation.postgres`. The staged-name output must contain exactly the test and manifest paths above. The final porcelain status must then be empty. If another plan has uncommitted work in this checkout, serialize or use an already-approved isolated checkout; never stash user content or bypass `DATABASE_LAUNCHER_SOURCE_CHECKOUT_DIRTY`.

  Only from that clean checkpoint SHA, invoke the reusable source/ambient preflight defined in Task 4 Step 1. That preflight applies to the current reviewed checkpoint and does not require any later Task checkpoint. Then execute **only** the exact `Reusable in-session function definitions` fence in Task 4 Step 2 to load `Get-B5CanonicalDigest`, `Read-B5FreshResult`, and `Invoke-B5FreshSuite`; do not execute Task 4's unit/static or pair-reuse fences. Run:

  ```powershell
  $paymentResult = Invoke-B5FreshSuite 'api.billing-automation.postgres'
  $paymentResult | ConvertTo-Json -Depth 20
  if ($paymentResult.classification -ne 'PASS') {
    throw "B5_BLOCKED_COUNTEREXAMPLE: api.billing-automation.postgres"
  }
  ```

  Expected: the canonical current-run report has `collected = selected = executed = passed > 0` and `failed = skipped = todo = filtered = cancelled = 0`; its current receipt proves `contentDigest === readbackDigest === independentDigest`, after which the existing runner removes the suite database, cluster, and run directory. Record the actual report/receipt paths, digests, and lifecycle result; do not paste a historical count. If a probe produces a complete counted `FAILED` report, classify it `BLOCKED_COUNTEREXAMPLE`, preserve the test-source checkpoint and exact rows/error, verify its current receipt and normal cleanup, and stop without product edits. Only a failure with no complete report is `BLOCKED_INFRASTRUCTURE` with a retained current-run incident; do not retry or independently clean it.

- [ ] **Step 7: Independently review the PostgreSQL result without rewriting the checkpoint**

  Tie the observed report's `runId`, `operationId`, `suiteId`, `chain`, target identity, counts, terminal status, report digest, and custody readback equality to the checkpoint SHA. The commit message claims only that the probes were added; PostgreSQL PASS/BLOCKED status belongs in Task 4's separately reviewed record.

---

### Task 3: Prove Positive Billing Maintenance And Stable Replay

**Files:**

- Modify: `apps/api/test/billing-automation.integration.spec.ts`
- Read: `apps/api/src/billing-automation/billing-automation.service.ts`
- Read: `apps/api/src/billing-automation/billing-automation.repository.ts`
- Read/run: `apps/api/test/billing-maintenance-evidence-postgres.integration.spec.ts`
- Test: `apps/api/test/billing-automation.integration.spec.ts`

**Interfaces:**

- Consumes: `BillingAutomationService.enqueueDueSchedules(now?: Date): Promise<{ dueCount: number; enqueuedCount: number }>`.
- Consumes: `BillingAutomationRepository.enqueue(tx, input)`, whose stable `idempotencyKey` upsert is the database replay boundary.
- Consumes as existing evidence: `BillingMaintenanceEvidenceService.runMaintenance()` sequence `1,2`, advisory-lock, source-binding, and append-only tests in `api.database.release`.
- Proves: the real database contains a positive due schedule in both repeated scans, while one stable generation job exists; existing maintenance facts can record two calls, but this synthetic replay is not two elapsed real billing months and not Staging evidence.

- [ ] **Step 1: Add one positive repeated-dispatch case to the existing integration lifecycle**

  Add inside the existing `BillingAutomationRepository PostgreSQL integration` describe block:

  ```ts
  it("reports positive due work on repeated maintenance scans without duplicating the generation job", async () => {
    const orderId = randomUUID();
    const scheduleId = randomUUID();
    const now = new Date("2026-09-06T04:00:00.000Z");
    const periodStart = new Date("2026-09-10T00:00:00.000Z");
    const periodEnd = new Date("2026-10-09T00:00:00.000Z");
    const sourceKey = billingSourceKey(orderId, periodStart);
    const service = new BillingAutomationService(
      prisma,
      repository,
      {} as never,
      new AutoDebitScheduler(),
      {} as never,
      () => now
    );
    const dueBefore = await prisma.billingSchedule.count({
      where: { nextGenerateAt: { lte: now }, status: BillingScheduleStatus.ACTIVE }
    });
    await prisma.$transaction(async (tx) => {
      await insertRuntimeOrderGraph(tx, {
        label: "B5-MAINTENANCE-REPLAY",
        orderId,
        vehicleId: null
      });
      await tx.billingSchedule.create({
        data: {
          id: scheduleId,
          nextCycleNo: 1,
          nextGenerateAt: new Date("2026-09-06T03:59:00.000Z"),
          nextPeriodEnd: periodEnd,
          nextPeriodStart: periodStart,
          orderId,
          status: BillingScheduleStatus.ACTIVE
        }
      });
    });
    try {
      await expect(service.enqueueDueSchedules(now)).resolves.toEqual({
        dueCount: dueBefore + 1,
        enqueuedCount: dueBefore + 1
      });
      await expect(service.enqueueDueSchedules(now)).resolves.toEqual({
        dueCount: dueBefore + 1,
        enqueuedCount: dueBefore + 1
      });
      await expect(
        prisma.subscriptionAutomationJob.count({ where: { idempotencyKey: sourceKey } })
      ).resolves.toBe(1);
      await expect(
        prisma.subscriptionAutomationJob.findUniqueOrThrow({
          where: { idempotencyKey: sourceKey }
        })
      ).resolves.toMatchObject({
        billingScheduleId: scheduleId,
        jobType: SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
        orderId
      });
    } finally {
      await prisma.subscriptionAutomationJob.deleteMany({ where: { idempotencyKey: sourceKey } });
      await prisma.billingSchedule.deleteMany({ where: { id: scheduleId } });
    }
  });
  ```

  Add `BillingScheduleStatus` to the existing Prisma imports. Do not edit `runtime-domain-fixture.ts`.

- [ ] **Step 2: Create a clean billing test-source checkpoint**

  The fresh launcher rejects a dirty checkout, so validate source metadata/formatting first, stage only this owned test file, and create the test-source checkpoint before claiming database results:

  ```powershell
  pnpm release:contracts:verify
  if ($LASTEXITCODE -ne 0) { throw "B5_CONTRACT_VERIFY_FAILED" }
  pnpm release:database-tests:discover
  if ($LASTEXITCODE -ne 0) { throw "B5_DATABASE_DISCOVERY_FAILED" }
  pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
  if ($LASTEXITCODE -ne 0) { throw "B5_BILLING_PG_TSC_FAILED" }
  pnpm exec prettier --check apps/api/test/billing-automation.integration.spec.ts
  if ($LASTEXITCODE -ne 0) { throw "B5_BILLING_PG_PRETTIER_FAILED" }
  git add apps/api/test/billing-automation.integration.spec.ts
  if ($LASTEXITCODE -ne 0) { throw "B5_BILLING_PG_STAGE_FAILED" }
  git diff --cached --check
  if ($LASTEXITCODE -ne 0) { throw "B5_BILLING_PG_STAGED_DIFF_INVALID" }
  $staged = @(git diff --cached --name-only)
  if ($LASTEXITCODE -ne 0) { throw "B5_BILLING_PG_STAGED_ENUM_FAILED" }
  if (($staged -join "`n") -ne 'apps/api/test/billing-automation.integration.spec.ts') {
    throw "B5_BILLING_PG_STAGED_SCOPE_INVALID: $($staged -join ',')"
  }
  git commit -m "test(billing): add positive maintenance replay probe"
  if ($LASTEXITCODE -ne 0) { throw "B5_BILLING_PG_CHECKPOINT_COMMIT_FAILED" }
  $remaining = @(git status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $remaining.Count -gt 0) {
    throw "B5_BILLING_PG_CHECKPOINT_NOT_CLEAN"
  }
  ```

  The staged-name output must contain exactly `apps/api/test/billing-automation.integration.spec.ts`, discovery must still classify every real database test, and final porcelain status must be empty. This commit says only that the probe was added. If another plan has changes in this checkout, serialize or use an already-approved isolated checkout; never stash user content or bypass the dirty-source gate.

- [ ] **Step 3: Run the two existing fresh suites as separate lifecycles**

  Invoke the reusable Task 4 Step 1 source/ambient preflight for this current reviewed checkpoint; it does not require later Task work. Then execute **only** the exact `Reusable in-session function definitions` fence in Task 4 Step 2 to load `Get-B5CanonicalDigest`, `Read-B5FreshResult`, and `Invoke-B5FreshSuite`; do not execute Task 4's unit/static or pair-reuse fences. Run these sequentially from the same clean checkpoint SHA:

  ```powershell
  $billingResult = Invoke-B5FreshSuite 'api.billing-automation.postgres'
  $billingResult | ConvertTo-Json -Depth 20
  if ($billingResult.classification -ne 'PASS') {
    throw "B5_BLOCKED_COUNTEREXAMPLE: api.billing-automation.postgres"
  }
  $maintenanceFactResult = Invoke-B5FreshSuite 'api.database.release'
  $maintenanceFactResult | ConvertTo-Json -Depth 20
  if ($maintenanceFactResult.classification -ne 'PASS') {
    throw "B5_BLOCKED_COUNTEREXAMPLE: api.database.release"
  }
  ```

  The invocations create two different `runId`/cluster/database lifecycles; never merge their target identity or imply they ran on one database. In `api.billing-automation.postgres`, the new test must see at least its controlled due schedule on both scans and exactly one row for the stable source key. `enqueuedCount` is attempted/eligible dispatch count; job-table uniqueness is the idempotency authority. In `api.database.release`, existing tests remain the authority for facts allocated only as sequence `1` then `2`, run-lock serialization, no third fact, source-drift rejection, and append-only behavior. Record actual reports/readback receipts and do not call this two elapsed real billing months or actual Staging maintenance.

- [ ] **Step 4: Preserve and independently review the Task 3 current-run pair**

  For each separate invocation, tie the observed `runId`, `operationId`, target identity, counts, terminal status, report digest, custody `contentDigest`/`readbackDigest`/independent equality, classification, and lifecycle result to the Task 3 checkpoint SHA and exact suite input (`suiteId`, `chain=fresh`, manifest/discovery digests). Preserve `$billingResult` and `$maintenanceFactResult` or their exact non-secret serialized outputs as the pair Task 4 must consume when SHA and inputs remain unchanged. If the first complete report is `FAILED`, stop before the second. A complete counted `FAILED` report is custodized and cleaned and becomes `BLOCKED_COUNTEREXAMPLE`; only absence of a complete report yields a retained current-run incident and `BLOCKED_INFRASTRUCTURE`. Do not retry or clean an incident under B5.

---

### Task 4: Reject Ambient Inputs, Consume Current Fresh Lifecycles, And Publish A Truthful B5 Record

**Files:**

- Create: `docs/acceptance/2026-09-06-stage1-b5-payment-and-billing-validation-record.md`
- Read/run only: `scripts/release/run-database-suite.mjs`
- Read only: `scripts/release/database-test-launcher-runtime.mjs`
- Read only: `release/contracts/{database-test-manifest.v1.json,database-test-discovery.v1.json,postgres-image.v1.json,database-target-policies.v1.json}`

**Interfaces:**

- Consumes: source prerequisites plus canonical unit output and database-suite report/custody/readback artifacts generated by the existing fresh launcher in this execution only.
- Produces: a reviewable B5 validation record with source SHA, separate current-run identities, command/result equality, authority assertions, lifecycle disposition, limitations, and `PASS`, `BLOCKED_COUNTEREXAMPLE`, or `BLOCKED_INFRASTRUCTURE`.
- Does not produce: a fixed target record, release authorization, real-provider evidence, Staging acceptance, legal/closure evidence, a new billing fact, or a reusable credential.

- [ ] **Step 1: Apply the reusable source/ambient preflight to the current reviewed checkpoint**

  Run this source-only preflight immediately before each fresh-suite group, after the currently relevant exact test-source checkpoint is reviewed and committed. It does not require later Task checkpoints to exist: Task 2 may invoke it after the Task 2 checkpoint, and Task 3/final evidence may invoke it after the Task 3 checkpoint. It reads no credential value and no retired record/archive content:

  ```powershell
  $required = @(
    'release/contracts/database-test-manifest.v1.json',
    'release/contracts/database-test-discovery.v1.json',
    'release/contracts/postgres-image.v1.json',
    'release/contracts/database-target-policies.v1.json',
    'scripts/release/run-database-suite.mjs',
    'scripts/release/database-test-launcher-runtime.mjs',
    'apps/api/test/payment-authority.integration.spec.ts',
    'apps/api/test/billing-automation.integration.spec.ts'
  )
  $missing = @($required | Where-Object { -not (Test-Path -LiteralPath $_) })
  if ($missing.Count -gt 0) {
    throw "B5_SOURCE_PREREQUISITE_MISSING: $($missing -join ',')"
  }
  $retiredFixedPaths = @(
    '.release-local/controlled-target.v1.json',
    '.release-local/secrets'
  )
  $present = @($retiredFixedPaths | Where-Object { Test-Path -LiteralPath $_ })
  if ($present.Count -gt 0) {
    throw "B5_RETIRED_FIXED_PATH_PRESENT: $($present -join ',')"
  }
  $existingRunNames = @()
  if (Test-Path -LiteralPath '.release-local/runs') {
    $existingRunNames = @(
      Get-ChildItem -LiteralPath '.release-local/runs' -Directory |
      Select-Object -ExpandProperty Name
    )
  }
  if ($existingRunNames.Count -gt 0) {
    throw "B5_EXISTING_RUN_RESOURCE_PRESENT: $($existingRunNames -join ',')"
  }
  $ambientNames = @(Get-ChildItem Env: | Where-Object {
    $_.Name -match 'DATABASE_URL$' -or
    $_.Name -match '^(PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGSERVICE)$' -or
    $_.Name -match '^S1_RELEASE_DATABASE_'
  } | Select-Object -ExpandProperty Name)
  if ($ambientNames.Count -gt 0) {
    throw "B5_AMBIENT_DATABASE_ENV_PRESENT: $($ambientNames -join ',')"
  }
  $currentStatus = @(git status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0) { throw "B5_SOURCE_STATUS_FAILED" }
  if ($currentStatus.Count -gt 0) {
    throw "B5_SOURCE_CHECKOUT_DIRTY: $($currentStatus -join ',')"
  }
  $sourceShaRaw = git rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw "B5_SOURCE_SHA_FAILED" }
  $sourceSha = ($sourceShaRaw -join '').Trim()
  pnpm release:contracts:verify
  if ($LASTEXITCODE -ne 0) { throw "B5_CONTRACT_VERIFY_FAILED" }
  $discoveryStdout = @(
    & node scripts/release/discover-database-tests.mjs --mode verify
  )
  if ($LASTEXITCODE -ne 0) { throw "B5_DATABASE_DISCOVERY_FAILED" }
  $discoveryVerification = ($discoveryStdout -join '') | ConvertFrom-Json
  if ($discoveryVerification.unclassifiedCount -ne 0) {
    throw "B5_DATABASE_DISCOVERY_INCOMPLETE"
  }
  $inputDigestScript = @'
  import { readFile } from "node:fs/promises";
  import { sha256Canonical } from "./packages/release-foundation/src/index.mjs";
  const manifest = JSON.parse(await readFile("release/contracts/database-test-manifest.v1.json", "utf8"));
  const discovery = JSON.parse(await readFile("release/contracts/database-test-discovery.v1.json", "utf8"));
  process.stdout.write(JSON.stringify({
  schemaVersion: "b5-current-database-inputs.v1",
  manifestDigest: sha256Canonical(manifest),
  discoveryDigest: sha256Canonical(discovery),
  discovery
  }));
  '@
  $currentInputRaw = @(& node --input-type=module -e $inputDigestScript)
  if ($LASTEXITCODE -ne 0 -or $currentInputRaw.Count -ne 1) {
    throw "B5_CURRENT_INPUT_DIGEST_FAILED"
  }
  $currentInputIdentity = ($currentInputRaw -join '') | ConvertFrom-Json
  $currentManifestDigest = $currentInputIdentity.manifestDigest
  $currentDiscoveryDigest = $currentInputIdentity.discoveryDigest
  if (
    $currentManifestDigest -notmatch '^sha256:[0-9a-f]{64}$' -or
    $currentDiscoveryDigest -notmatch '^sha256:[0-9a-f]{64}$' -or
    $currentInputIdentity.discovery.contractVersion -ne 'database-test-discovery.v1'
  ) {
    throw "B5_CURRENT_INPUT_IDENTITY_INVALID"
  }
  ```

  `$currentStatus` must be empty; do not stash, discard, or hide another plan's/user's changes. Contract verification must pass, and the captured discovery verification JSON must report zero unclassified database tests with the new payment file mapped to `api.billing-automation.postgres`. Preserve `$currentInputIdentity` as the actual current discovery contract plus independently canonicalized manifest/discovery digests used by both suite invocation and Task 4 reuse checks. A missing/ambient/fixed-path/pre-existing-run result is `BLOCKED_INFRASTRUCTURE`: stop before invoking a suite and report names/paths only. Do not inspect or delete the refused path/resource.

- [ ] **Step 2: Run bounded checks and consume the Task 3 current-run pair when inputs are unchanged**

  Use the following three fences separately. Task 2/3 load only the explicitly labelled function-definition fence; they do not execute the surrounding Task 4 commands.

  First run the bounded unit/static commands:

  ```powershell
  pnpm --filter @subscription-saas/api exec vitest run test/portal-payment.spec.ts test/payment-settlement.spec.ts test/subscription-journey-payment.spec.ts test/billing-maintenance-evidence.service.spec.ts
  if ($LASTEXITCODE -ne 0) { throw "B5_FOCUSED_UNIT_SUITE_FAILED" }
  pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
  if ($LASTEXITCODE -ne 0) { throw "B5_API_TSC_FAILED" }
  ```

  **Reusable in-session function definitions — load this fence only before Task 2/3 suite calls:**

  ```powershell
  $canonicalDigestScript = @'
  import { sha256Canonical } from "./packages/release-foundation/src/index.mjs";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(sha256Canonical(JSON.parse(input)));
  '@
  function Get-B5CanonicalDigest([string]$json) {
    $digest = @($json | & node --input-type=module -e $canonicalDigestScript)
    if ($LASTEXITCODE -ne 0 -or $digest.Count -ne 1) {
      throw "B5_CANONICAL_DIGEST_FAILED"
    }
    return ($digest -join '').Trim()
  }

  function Invoke-B5FreshSuite([string]$suiteId) {
    $dirty = @(git status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0) {
      throw "B5_FRESH_CHECKOUT_NOT_CLEAN"
    }
    $runRoot = Join-Path (Get-Location) '.release-local/runs'
    $evidenceRoot = Join-Path (Get-Location) '.release-local/evidence'
    $receiptRoot = Join-Path $evidenceRoot 'receipts'
    $beforeRuns = @{}
    if (Test-Path -LiteralPath $runRoot) {
      Get-ChildItem -LiteralPath $runRoot -Directory | ForEach-Object {
        $beforeRuns[$_.FullName] = $true
      }
    }
    $beforeReceipts = @{}
    if (Test-Path -LiteralPath $receiptRoot) {
      Get-ChildItem -LiteralPath $receiptRoot -File | ForEach-Object {
        $beforeReceipts[$_.FullName] = $true
      }
    }

    $invocationSha = ((git rev-parse HEAD) -join '').Trim()
    if ($LASTEXITCODE -ne 0) { throw "B5_FRESH_SOURCE_SHA_FAILED" }
    $rawReport = @(
      & node scripts/release/run-database-suite.mjs --suite-id $suiteId --chain fresh
    )
    $suiteExit = $LASTEXITCODE
    $rawReportJson = $rawReport -join ''
    $report = $null
    if ($rawReport.Count -gt 0) {
      try {
        $report = $rawReportJson | ConvertFrom-Json
      } catch {
        $report = $null
      }
    }
    $newReceipts = @()
    if (Test-Path -LiteralPath $receiptRoot) {
      $newReceipts = @(
        Get-ChildItem -LiteralPath $receiptRoot -File | Where-Object {
          -not $beforeReceipts.ContainsKey($_.FullName)
        }
      )
    }
    $countKeys = @(
      'collected', 'selected', 'executed', 'passed', 'failed',
      'skipped', 'todo', 'filtered', 'cancelled'
    )
    $countsComplete = $null -ne $report -and $null -ne $report.counts -and @(
      $countKeys | Where-Object {
        $null -eq $report.counts.$_ -or
        (
          $report.counts.$_ -isnot [long] -and
          $report.counts.$_ -isnot [int]
        ) -or
        $report.counts.$_ -lt 0
      }
    ).Count -eq 0
    $completeReport =
      $null -ne $report -and
      $report.schemaVersion -eq 'database-suite-report.v1' -and
      $report.runId -match '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -and
      $report.suiteId -eq $suiteId -and
      $report.chain -eq 'fresh' -and
      $report.manifestDigest -eq $currentManifestDigest -and
      $report.discoveryDigest -eq $currentDiscoveryDigest -and
      $report.terminalStatus -in @('PASSED', 'FAILED') -and
      $countsComplete -and
      $report.counts.collected -eq ($report.counts.selected + $report.counts.filtered) -and
      $report.counts.selected -eq (
        $report.counts.executed + $report.counts.skipped + $report.counts.todo +
        $report.counts.cancelled
      ) -and
      $report.counts.executed -eq ($report.counts.passed + $report.counts.failed)

    if (-not $completeReport) {
      if ($suiteExit -eq 0) {
        throw "B5_SUCCEEDED_WITHOUT_COMPLETE_REPORT"
      }
      $newRuns = @()
      if (Test-Path -LiteralPath $runRoot) {
        $newRuns = @(
          Get-ChildItem -LiteralPath $runRoot -Directory | Where-Object {
            -not $beforeRuns.ContainsKey($_.FullName)
          }
        )
      }
      if ($newRuns.Count -ne 1) {
        throw "B5_CURRENT_RUN_IDENTITY_AMBIGUOUS"
      }
      $incidentPath = Join-Path $newRuns[0].FullName 'incident.json'
      if (-not (Test-Path -LiteralPath $incidentPath)) {
        throw "B5_CURRENT_RUN_INCIDENT_MISSING: $incidentPath"
      }
      $incident = Get-Content -LiteralPath $incidentPath -Raw | ConvertFrom-Json
      throw "B5_BLOCKED_INFRASTRUCTURE: $($incident | ConvertTo-Json -Compress); incidentPath=$incidentPath"
    }

    if ($newReceipts.Count -ne 1) {
      throw "B5_CURRENT_RECEIPT_IDENTITY_AMBIGUOUS"
    }
    $currentRunPath = Join-Path $runRoot $report.runId
    if (Test-Path -LiteralPath $currentRunPath) {
      throw "B5_COMPLETE_REPORT_LIFECYCLE_NOT_RETIRED: $currentRunPath"
    }
    if (
      (
        $report.terminalStatus -eq 'PASSED' -and
        (
          $suiteExit -ne 0 -or
          $report.counts.executed -le 0 -or
          $report.counts.passed -ne $report.counts.executed -or
          $report.counts.failed -ne 0 -or
          $report.counts.skipped -ne 0 -or
          $report.counts.todo -ne 0 -or
          $report.counts.filtered -ne 0 -or
          $report.counts.cancelled -ne 0
        )
      ) -or
      ($report.terminalStatus -eq 'FAILED' -and ($suiteExit -ne 1 -or $report.counts.failed -le 0))
    ) {
      throw "B5_REPORT_EXIT_STATUS_MISMATCH"
    }
    $candidate = [pscustomobject]@{
      sourceSha = $invocationSha
      report = $report
      rawReportJson = $rawReportJson
      receiptPath = $newReceipts[0].FullName
      suiteExit = $suiteExit
      classification = if ($report.terminalStatus -eq 'PASSED') {
        'PASS'
      } else {
        'BLOCKED_COUNTEREXAMPLE'
      }
      lifecycle = 'COMPLETE_REPORT_RUN_DIRECTORY_REMOVED'
    }
    return Read-B5FreshResult $candidate $suiteId $false
  }

  function Read-B5FreshResult(
    [object]$candidate,
    [string]$suiteId,
    [bool]$stopOnFailed = $true
  ) {
    if (
      $null -eq $candidate -or
      $candidate.sourceSha -notmatch '^[0-9a-f]{40}$' -or
      -not (Test-Path -LiteralPath $candidate.receiptPath)
    ) {
      throw "B5_PRESENT_PAIR_CORRUPT: $suiteId"
    }
    $receipt = Get-Content -LiteralPath $candidate.receiptPath -Raw | ConvertFrom-Json
    if (
      $receipt.contentDigest -notmatch '^sha256:[0-9a-f]{64}$' -or
      $receipt.readbackDigest -notmatch '^sha256:[0-9a-f]{64}$'
    ) {
      throw "B5_PRESENT_PAIR_DIGEST_FORMAT_INVALID: $suiteId"
    }
    $evidenceRoot = Join-Path (Get-Location) '.release-local/evidence'
    $receiptRoot = Join-Path $evidenceRoot 'receipts'
    $expectedReceiptPath = Join-Path $receiptRoot "$($receipt.receiptId).json"
    $contentPath = Join-Path $evidenceRoot (
      'evidence/' + $receipt.contentDigest.Substring('sha256:'.Length) + '.json'
    )
    if (
      [IO.Path]::GetFullPath($candidate.receiptPath) -ne [IO.Path]::GetFullPath($expectedReceiptPath) -or
      ($candidate.reportPath -and [IO.Path]::GetFullPath($candidate.reportPath) -ne [IO.Path]::GetFullPath($contentPath)) -or
      -not (Test-Path -LiteralPath $contentPath)
    ) {
      throw "B5_PRESENT_PAIR_PATH_INVALID: $suiteId"
    }
    $storedRaw = Get-Content -LiteralPath $contentPath -Raw
    $storedReport = $storedRaw | ConvertFrom-Json
    $rawReportJson = [string]$candidate.rawReportJson
    if ([string]::IsNullOrWhiteSpace($rawReportJson)) {
      throw "B5_PRESENT_PAIR_RAW_REPORT_MISSING: $suiteId"
    }
    $stdoutReport = $rawReportJson | ConvertFrom-Json
    $independentDigest = 'sha256:' + (
      Get-FileHash -LiteralPath $contentPath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    $stdoutCanonicalDigest = Get-B5CanonicalDigest $rawReportJson
    $storedCanonicalDigest = Get-B5CanonicalDigest $storedRaw
    $countKeys = @(
      'collected', 'selected', 'executed', 'passed', 'failed',
      'skipped', 'todo', 'filtered', 'cancelled'
    )
    $storedCountMismatch = @(
      $countKeys | Where-Object { $storedReport.counts.$_ -ne $stdoutReport.counts.$_ }
    ).Count -gt 0
    if (
      $stdoutReport.schemaVersion -ne 'database-suite-report.v1' -or
      $stdoutReport.runId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
      $stdoutReport.suiteId -ne $suiteId -or
      $stdoutReport.chain -ne 'fresh' -or
      $stdoutReport.manifestDigest -notmatch '^sha256:[0-9a-f]{64}$' -or
      $stdoutReport.discoveryDigest -notmatch '^sha256:[0-9a-f]{64}$' -or
      $stdoutReport.counts.collected -ne ($stdoutReport.counts.selected + $stdoutReport.counts.filtered) -or
      $stdoutReport.counts.selected -ne (
        $stdoutReport.counts.executed + $stdoutReport.counts.skipped +
        $stdoutReport.counts.todo + $stdoutReport.counts.cancelled
      ) -or
      $stdoutReport.counts.executed -ne (
        $stdoutReport.counts.passed + $stdoutReport.counts.failed
      ) -or
      $receipt.attestationRef -ne "local-controlled-nonpromotable://$($stdoutReport.runId)/$suiteId" -or
      $receipt.contentDigest -ne $receipt.readbackDigest -or
      $receipt.contentDigest -ne $independentDigest -or
      $receipt.contentDigest -ne $stdoutCanonicalDigest -or
      $receipt.contentDigest -ne $storedCanonicalDigest -or
      $storedReport.runId -ne $stdoutReport.runId -or
      $storedReport.suiteId -ne $stdoutReport.suiteId -or
      $storedReport.terminalStatus -ne $stdoutReport.terminalStatus -or
      $storedCountMismatch -or
      ($candidate.independentDigest -and $candidate.independentDigest -ne $independentDigest) -or
      ($candidate.stdoutCanonicalDigest -and $candidate.stdoutCanonicalDigest -ne $stdoutCanonicalDigest) -or
      ($candidate.storedCanonicalDigest -and $candidate.storedCanonicalDigest -ne $storedCanonicalDigest)
    ) {
      throw "B5_PRESENT_PAIR_CORRUPT: $suiteId"
    }
    if ($stopOnFailed -and (
      $stdoutReport.terminalStatus -eq 'FAILED' -and
      $candidate.suiteExit -eq 1 -and
      $stdoutReport.counts.failed -gt 0 -and
      $candidate.classification -eq 'BLOCKED_COUNTEREXAMPLE'
    )) {
      throw "B5_BLOCKED_COUNTEREXAMPLE_PRESENT_PAIR: $suiteId"
    }
    if (
      (
        $stdoutReport.terminalStatus -eq 'PASSED' -and
        (
          $candidate.suiteExit -ne 0 -or
          $stdoutReport.counts.executed -le 0 -or
          $stdoutReport.counts.passed -ne $stdoutReport.counts.executed -or
          $stdoutReport.counts.failed -ne 0 -or
          $stdoutReport.counts.skipped -ne 0 -or
          $stdoutReport.counts.todo -ne 0 -or
          $stdoutReport.counts.filtered -ne 0 -or
          $stdoutReport.counts.cancelled -ne 0 -or
          $candidate.classification -ne 'PASS'
        )
      ) -or
      (
        $stdoutReport.terminalStatus -eq 'FAILED' -and
        (
          $candidate.suiteExit -ne 1 -or
          $stdoutReport.counts.failed -le 0 -or
          $candidate.classification -ne 'BLOCKED_COUNTEREXAMPLE'
        )
      ) -or
      $stdoutReport.terminalStatus -notin @('PASSED', 'FAILED') -or
      (Test-Path -LiteralPath (Join-Path '.release-local/runs' $stdoutReport.runId))
    ) {
      throw "B5_PRESENT_PAIR_CORRUPT: $suiteId"
    }
    return [pscustomobject]@{
      sourceSha = $candidate.sourceSha
      report = $storedReport
      rawReportJson = $rawReportJson
      reportPath = $contentPath
      receipt = $receipt
      receiptPath = $expectedReceiptPath
      independentDigest = $independentDigest
      stdoutCanonicalDigest = $stdoutCanonicalDigest
      storedCanonicalDigest = $storedCanonicalDigest
      suiteExit = $candidate.suiteExit
      classification = $candidate.classification
      lifecycle = 'COMPLETE_REPORT_RUN_DIRECTORY_REMOVED'
    }
  }
  ```

  Task 4 now revalidates or replaces the pair using this separate fence:

  ```powershell
  $billingCandidate = Get-Variable billingResult -ValueOnly -ErrorAction SilentlyContinue
  $maintenanceCandidate = Get-Variable maintenanceFactResult -ValueOnly -ErrorAction SilentlyContinue
  $hasBillingCandidate = $null -ne $billingCandidate
  $hasMaintenanceCandidate = $null -ne $maintenanceCandidate
  if ($hasBillingCandidate -xor $hasMaintenanceCandidate) {
    throw "B5_PRESENT_PAIR_INCOMPLETE"
  }

  $replacementReason = $null
  if ($hasBillingCandidate -and $hasMaintenanceCandidate) {
    $billingResult = Read-B5FreshResult $billingCandidate 'api.billing-automation.postgres'
    $maintenanceFactResult = Read-B5FreshResult $maintenanceCandidate 'api.database.release'
    $inputChanges = @()
    if ($billingResult.sourceSha -ne $sourceSha -or $maintenanceFactResult.sourceSha -ne $sourceSha) {
      $inputChanges += 'sourceSha'
    }
    if (
      $billingResult.report.manifestDigest -ne $currentManifestDigest -or
      $maintenanceFactResult.report.manifestDigest -ne $currentManifestDigest
    ) {
      $inputChanges += 'manifestDigest'
    }
    if (
      $billingResult.report.discoveryDigest -ne $currentDiscoveryDigest -or
      $maintenanceFactResult.report.discoveryDigest -ne $currentDiscoveryDigest
    ) {
      $inputChanges += 'discoveryDigest'
    }
    if ($inputChanges.Count -gt 0) {
      $replacementReason = "CURRENT_INPUT_CHANGED: $($inputChanges -join ',')"
    }
  } else {
    $replacementReason = 'TASK3_CURRENT_PAIR_ABSENT'
  }

  if ($null -ne $replacementReason) {
    Write-Output "B5_TASK4_REPLACEMENT_REASON=$replacementReason"
    $billingResult = Invoke-B5FreshSuite 'api.billing-automation.postgres'
    $billingResult | ConvertTo-Json -Depth 20
    if ($billingResult.classification -ne 'PASS') {
      throw "B5_BLOCKED_COUNTEREXAMPLE: api.billing-automation.postgres"
    }
    $maintenanceFactResult = Invoke-B5FreshSuite 'api.database.release'
    $maintenanceFactResult | ConvertTo-Json -Depth 20
    if ($maintenanceFactResult.classification -ne 'PASS') {
      throw "B5_BLOCKED_COUNTEREXAMPLE: api.database.release"
    }
  }
  ```

  Task 4 must first re-read both Task 3 receipt files and content-addressed report bytes, revalidate raw-file and canonical digests from the preserved original JSON text, and compare each report's manifest/discovery digests to the independently recomputed current values—not merely to each other. Never canonicalize a PowerShell-reserialized report object. It consumes the pair when those checks and the current SHA/suite/chain inputs match; do not launch two replacement suites merely to publish the record. A present `FAILED`, incomplete, or corrupt pair stops immediately and can never fall through to replacement. Run a replacement pair only when the pair is wholly absent or a fully revalidated PASS pair has an explicitly named current source/manifest/discovery input change, and record `$replacementReason`. This is reuse of the just-observed Task 3 pair, not reuse of historical P1 evidence.

  Each invoked suite independently provisions, migrates, verifies, tests, custodizes/readbacks, and—after either complete `PASSED` or counted `FAILED` report—removes its own suite database, cluster, secrets, and run directory. A complete `FAILED` report must have exit `1`, a verified current receipt, and classification `BLOCKED_COUNTEREXAMPLE`; stop before the next invocation. Only when no complete report exists may the wrapper consult the single new current-run incident and classify `BLOCKED_INFRASTRUCTURE`; do not retry, mutate, or clean that retained resource. The before/after sets identify only artifacts created by the current invocation; do not open pre-existing receipts, runs, incidents, or retired archives. Do not manually run Prisma migrate/generate/validate commands around the launcher. Hand main/R2 the exact emitted current-run `incidentPath`, `runId`, `containerId`, and `errorCode` for incident disposition. Do not run full product/DB matrices, snapshot, provider, browser, Staging, signing, or deployment commands under B5.

- [ ] **Step 3: Write the validation record from observed outputs**

  Create the record only after all dirty-sensitive fresh suite calls finish. It must contain these sections and real values, never blank markers:

  ```markdown
  # Stage 1 B5 Payment And Billing Validation Record

  Status: PASS | BLOCKED_COUNTEREXAMPLE | BLOCKED_INFRASTRUCTURE
  Scope: active payment authority and synthetic billing-maintenance positive replay only

  ## Execution identity

  - Source SHA: the exact 40-lowercase-hex SHA tested
  - Source-only prerequisites: actual discovery verification JSON, captured current discovery contract, independently canonicalized current manifest/discovery digests, and zero ambient/fixed-path names
  - Task 3 current-run pair (or documented input-change replacement pair): actual suiteId/runId/operationId/chain and exact shared checkpoint SHA
  - Reuse decision: receipt/report-byte re-read result plus exact current SHA, independently recomputed manifest/discovery digests, suite IDs, and chain comparison proving whether Task 4 consumed the Task 3 pair without rerun; otherwise record the exact allowed replacement reason

  ## Command results

  For every command: start/end time, exit code, actual test counts, canonical report path,
  report digest, receipt path, contentDigest, readbackDigest, and equality result where emitted.
  For each fresh suite separately: database name/OID/target fingerprint and role-boundary
  observation from its report; PostgreSQL image/version and migration/schema observation only
  where the current runner actually emits it. Never invent a field absent from suite output.

  ## Fresh lifecycle disposition

  - Complete PASSED report: exit 0, current receipt content/readback/independent digests match, and
    suite database, cluster, secrets, and current run directory were removed by the launcher.
  - Complete counted FAILED report: exit 1, current receipt content/readback/independent digests
    match, normal cleanup removed the current run, and status is BLOCKED_COUNTEREXAMPLE.
  - No complete report: DISPOSITION_PENDING; list only current-run incident path, runId,
    containerId, errorCode, failed phase, and next owner; status is BLOCKED_INFRASTRUCTURE. State
    that B5 performed no retry, mutation, or cleanup of the retained incident resource.

  ## Authority observations

  - Unverified or non-paid callback: callback log retained; no money fact mutation.
  - Verified amount mismatch: no PaymentRecord, PaymentWriteOff, or bill balance mutation.
  - Concurrent duplicate verified callbacks: two callback logs; one confirmed PaymentRecord;
    exact write-off total; one final bill transition; payment-order/payment-record binding retained.
  - Journey: partial bill authority remains WAITING_CUSTOMER; only zero remaining authority completes.
  - Maintenance: a positive due schedule is observed twice; one stable generation job exists.
  - Existing maintenance facts: sequence 1 then 2 and no third fact under exact source binding.

  ## Limitations

  - Mock callback verification is not WeChat cryptographic verification or provider connectivity.
  - Fresh synthetic PostgreSQL is not a legal snapshot and is not Staging.
  - Repeated due-work replay is not two elapsed real billing months.
  - No B6 closure, waiver, write-down, legal, vehicle release, or completion claim is made.
  - No auto-debit behavior is validated or enabled.
  - The new PostgreSQL payment probe does not inject JourneySignal; existing focused coverage owns
    settlement-signal evidence, while this probe owns only money-fact authority.

  ## Counterexamples and disposition

  State either that none were observed in the bounded commands, or list the exact failing test,
  error, authoritative pre/post rows, retained current-run disposition (if any), and the named
  production entry that needs a separate plan.
  ```

  Choose `PASS` only when every bounded command passes, the exact Task 3 current-run pair (or a justified input-change replacement pair) has two verified current receipts and complete cleanup, and every authority observation is supported by those outputs. Use `BLOCKED_COUNTEREXAMPLE` for a complete counted `FAILED` report or other product-invariant failure, and `BLOCKED_INFRASTRUCTURE` only for source/ambient failure or a launcher failure with no complete report; do not soften or omit either.

- [ ] **Step 4: Prove the validation stayed test-and-evidence only**

  Run:

  ```powershell
  git diff --exit-code -- apps/api/src apps/api/prisma packages/shared apps/web scripts/release
  if ($LASTEXITCODE -ne 0) { throw "B5_PRODUCT_SCOPE_DIFF_DETECTED" }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw "B5_WORKTREE_DIFF_INVALID" }
  ```

  Expected: the production/schema/shared/runner diff command exits `0`; `git diff --check` exits `0`. Review the actual diff and confirm the manifest checkpoint changed only the existing suite's file list. B5 never creates or changes a cleanup path. A retained abnormal resource remains untouched pending the exact disposition handoff.

- [ ] **Step 5: Commit only the evidence record after review**

  Re-run the required source contracts/discovery and exact formatting, then stage only the record and reject staged whitespace or scope drift:

  ```powershell
  pnpm release:contracts:verify
  if ($LASTEXITCODE -ne 0) { throw "B5_CONTRACT_VERIFY_FAILED" }
  pnpm release:database-tests:discover
  if ($LASTEXITCODE -ne 0) { throw "B5_DATABASE_DISCOVERY_FAILED" }
  pnpm exec prettier --check docs/acceptance/2026-09-06-stage1-b5-payment-and-billing-validation-record.md
  if ($LASTEXITCODE -ne 0) { throw "B5_RECORD_PRETTIER_FAILED" }
  git add docs/acceptance/2026-09-06-stage1-b5-payment-and-billing-validation-record.md
  if ($LASTEXITCODE -ne 0) { throw "B5_RECORD_STAGE_FAILED" }
  git diff --cached --check
  if ($LASTEXITCODE -ne 0) { throw "B5_RECORD_STAGED_DIFF_INVALID" }
  $staged = @(git diff --cached --name-only)
  if ($LASTEXITCODE -ne 0) { throw "B5_RECORD_STAGED_ENUM_FAILED" }
  if (
    ($staged -join "`n") -ne
    'docs/acceptance/2026-09-06-stage1-b5-payment-and-billing-validation-record.md'
  ) {
    throw "B5_RECORD_STAGED_SCOPE_INVALID: $($staged -join ',')"
  }
  git commit -m "docs(acceptance): record B5 payment billing validation"
  if ($LASTEXITCODE -ne 0) { throw "B5_RECORD_COMMIT_FAILED" }
  ```

  The staged-name output must contain exactly the record path. This documentation commit reports the already-observed clean-SHA outcomes; it must not imply the record itself was present during the dirty-sensitive fresh suite runs.

## Verified Existing API And Helper Fit

- `requiredReleaseDatabaseTestContext("apps/api/test/payment-authority.integration.spec.ts")` is the current exported guard: it requires launcher mode, validates the suite-issued context, and refuses callers absent from `allowedFiles` before returning `databaseUrl`. The new file uses that API verbatim and adds no environment/credential reader.
- `insertRuntimeOrderGraph(tx, { label, orderId, vehicleId: null })` is the current helper signature and returns the `customerId` needed by `ReceivableBill` and `PaymentOrder`. B5 does not change or duplicate the shared helper.
- Current constructors match the snippets: `new FinanceService(audit, prisma)` leaves only optional Journey/config arguments absent; `new PaymentOrderService(audit, config, finance, provider, wechatOAuth, prisma)` has six arguments; and `new BillingAutomationService(prisma, repository, finance, autoDebitScheduler, contractSegmentService, clock)` has six arguments.
- The callback-only code path does not call WeChat OAuth, so `{ } as never` is a bounded unused test dependency. `MockPaymentProvider` proves the application boundary only and must never be reported as provider cryptography/connectivity.
- The current `createPaymentHarness()` already returns `financeService` and `state`; no conditional harness work is authorized. The real PostgreSQL concurrency probe wraps only the existing `PrismaService.$transaction` callback entry to create a deterministic two-entry barrier, then executes the unchanged production transaction/locks/SQL.
- `api.billing-automation.postgres` is an existing `fresh`-applicable suite. Task 2 changes only its `files` array and requires discovery to prove the real new file is classified before the checkpoint commit.

## Cross-Package Handoff And Stop Conditions

- **B3 contract archive:** B5 initial-bill generation still reads archived-contract authority, but this plan does not retest or modify B3. B3 must land first only for an end-to-end order path; the focused payment fixture starts from an existing bill and is independently testable.
- **B4 activation:** B4 may consume B5's proven `ReceivableBill.remainingAmount === 0` plus confirmed receipt/write-off trace. B5 does not set delivery, Lease, period, vehicle, or activation facts.
- **B6 normal completion:** B6 owns closure/disposition/final settlement semantics. B5 provides no `settledAt`, waiver, written-off, legal, or order-completion mutation and no evidence for them.
- **R2 runner:** R2 owns the separate manual migrate/verify path and its H3 target, not a rewrite of the existing B5 fresh-suite lifecycle. B5 invokes only `run-database-suite.mjs --chain fresh`; any change to this entry, retained-resource disposition, or runner trust requires a separate exact scope and approval. B5 does not depend on real R1/R2 identities to validate synthetic business facts.
- **A1/A3 acceptance:** A3 owns actual WeChat cryptographic callback, customer browser, Staging, provider, and two meaningful operational maintenance executions. B5's Mock/synthetic evidence is necessary regression evidence but cannot satisfy those external gates.
- **Shared manifest:** serialize the single `api.billing-automation.postgres.files` edit with B3's additive suite entry; R2 owns a separate exact discovery-exception entry and does not modify the source suite manifest. Do not create a second billing suite or fixed target. The two required suite invocations have separate fresh lifecycle identities and must not be reported as one target.
- **Shared test surfaces:** serialize `portal-payment.spec.ts` with A1 and `billing-automation.integration.spec.ts` with any B4/B6 work. B5 does not own `runtime-domain-fixture.ts` or any production service.
- **Counterexample boundary:** a failure in `PaymentOrderService.handleCallback`, `FinanceService.settlePaymentOrder`, `BillingAutomationService.enqueueDueSchedules`, or `BillingAutomationRepository.enqueue` is evidence only. Name that exact entry and observed database state in the record, then request a new minimal fix approval; this plan contains no latent "modify as needed" authority.
