# Stage 1 B1 进件与业务等待独立验证实施计划

> **Status: DRAFT / PENDING_REVIEW.** This plan is not implementation approval.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Independently validate that A-line self-service and B-line sales-assisted intake converge on Application-owned review facts, while customer/manual waits and Application rejection/cancellation remain business outcomes rather than Journey technical failures.

**Architecture:** Keep `Application` and its review/deposit/status fields as the business authority. Exercise the existing `CustomerService -> SubscriptionJourneyService -> SubscriptionJourneyRepository -> SubscriptionJourneyWorker` boundaries with focused characterization tests; use the existing governed fresh database-suite launcher for persistent A/B convergence evidence. This first pass changes tests only because the audited implementation already exposes the required behavior; a test counterexample stops execution and requires a separately reviewed production-change amendment.

**Tech Stack:** TypeScript 6, NestJS 11, Prisma 7/PostgreSQL 17, Vitest 4, pnpm 11, existing release database-suite launcher.

**Spec:** `DEV_SPEC.md`; `docs/superpowers/specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md`; `docs/superpowers/plans/2026-09-06-stage1-mainline-minimal-release-implementation-plan.md`; `docs/superpowers/specs/2026-09-01-stage1-s0-authority-and-temporary-asset-governance-design.zh-CN.md`; `docs/acceptance/2026-09-06-stage1-mainline-execution-index.md`

中文审批摘要：本稿仅验证 A/B 进件、资料审核的业务等待及拒绝/取消与技术重试的区别；只修改三份现有测试。验证反例若要求产品修改，先停下独立报审。B2 方案/车辆/单次确认、实际 Staging 和 Task 30 均未授权。

## Global Constraints

- This is one of the five authorized planning documents. Its status remains `DRAFT / PENDING_REVIEW`; implementation requires a separate approval.
- The audited planning baseline is `4b93f8abf4697d3970205d3d37e78e8a55b4ebd6`. Re-read `git status --short` at execution time and do not overwrite unrelated work.
- P0/P1 admission is closed. Both controlled PostgreSQL targets were retired; `.release-local/controlled-target.v1.json` and the four fixed `.release-local/secrets/*.json` files are absent. Historical P1 results are context only, not a fresh B1 success claim.
- Unit tests and Prisma client generation do not require a database identity. Do not run ambient `prisma migrate status` against an ungoverned URL. The only B1 database command is the existing self-contained `run-database-suite.mjs --chain fresh` entry, which provisions per-run credentials/databases, writes its existing custody evidence, and cleans up through the existing lifecycle.
- Do not create another bootstrap, cleanup, target-record, credential, evidence-schema, or database-suite interface. Do not copy retired P1 run IDs, database IDs, container IDs, volume IDs, credential references, report digests, or passing counts into a new run.
- Do not read retirement archives or credential contents. Do not call cloud, GitHub, Staging, production, electronic-signature, payment, notification, or other external services.
- `Application` is authoritative for intake, material/credit review, customer intent, rejection, and cancellation. Journey Step/Job/ManualTask/Exception state is an orchestration projection and must not substitute for those facts.
- Preserve the active `SUBSCRIPTION` product line. Do not expose `RENT_TO_OWN`, add a business model, enum, RBAC permission, feature flag, migration, or schema field.
- B1 ends at Application intake validation and business terminal/wait outcomes. Do not change B2 final-plan publication, vehicle allocation/reservation CAS, exact customer confirmation, quote/order/contract creation, or their tests.
- Do not run `stage1-journey-business-wait-reconcile.mjs`: S0 registers it as an optional one-time script that remains default-denied, and B1 is validation rather than data repair.
- Existing conforming behavior gets characterization tests, not a fabricated RED. If any characterization test fails because production behavior contradicts the audited source contract, stop after preserving the exact failure output and source counterexample; do not edit production code until a separate amendment names the exact method, behavior, and approval boundary.
- All monetary assertions remain integer cents; all statuses use existing Prisma enums; test fixtures contain synthetic identifiers only.

---

## Audited Interfaces and Boundaries

| Boundary                       | Existing interface and observed behavior                                                                                                                                                                                                                                                                                                    | B1 treatment                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-line intake                  | `CustomerService.createApplication(dto: CreateApplicationDto, user: RequestUser, context: RequestContext)` creates an Application without setting `applicationSource`; Prisma `Application.applicationSource @default(SALES_ASSISTED)` supplies the source. `submitApplication(...)` emits `APPLICATION_SUBMITTED` in the same transaction. | Characterize the Prisma default faithfully in the unit harness and prove no direct Order/Journey bypass at draft creation.                                                   |
| A-line intake                  | `PortalApplicationService.createApplication(...)` delegates to `CustomerService.createSelfServiceApplication(...)`, which writes `SELF_SERVICE`, `SUBMITTED`, four pending review statuses, pending deposit/null final deposit, intent snapshots, and an `APPLICATION_SUBMITTED` signal without Quote/Order creation.                       | Re-run the existing detailed A-line service test as read-only evidence.                                                                                                      |
| Readiness authority            | `CustomerService.validateJourneyApplication(tx, applicationId): Promise<ApplicationReadinessResult>` locks and reads Application, then calls `classifyApplicationReadiness(...)`.                                                                                                                                                           | Compose the real CustomerService with the real Journey service for both sources.                                                                                             |
| Business wait/terminal mapping | `SubscriptionJourneyService.validateApplicationJob(job)` calls the CustomerService and maps `WAITING_MANUAL` to `waitForManual`, `WAITING_CUSTOMER` to `waitForCustomer`, and `REJECTED` to Application release plus `rejectForApplication`.                                                                                                | Characterize exact calls and reason-code payloads; no Exception API is invoked on these normal returns.                                                                      |
| Technical failure              | `SubscriptionJourneyWorker.handleJob(...)` completes any normal handler result, including wait/rejected results; thrown errors are sanitized and sent to `rescheduleJob` or `deadLetterJob`.                                                                                                                                                | Expand the worker table to cover all B1 normal outcomes and keep a validation-job-specific retry assertion.                                                                  |
| Application terminal authority | `CustomerService.rejectApplication(...)` / `cancelApplication(...)` persist Application status, increment `journeyFactVersion`, clear the Application-owned soft hold, then call `SubscriptionJourneySignalService.terminateApplication(...)`. Portal cancel delegates to the same CustomerService method.                                  | Re-run current service tests and add integrated readiness assertions for `APPLICATION_REJECTED` and `APPLICATION_CANCELLED`; do not drive terminal truth from Journey state. |
| Persistent convergence         | `api.subscription-journey-golden-path.postgres` persists both `SELF_SERVICE` and `SALES_ASSISTED` entry facts and compares their Journey step/manual-task shape.                                                                                                                                                                            | Re-run unchanged through the existing fresh suite launcher. Its deterministic provider is DB-flow evidence, not external-provider evidence.                                  |

## File Ownership and Cross-Package Coordination

| Path                                                                                                                                                                                                                                                  | Planned ownership         | Concrete consumers / coordination                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/application-review-api.spec.ts`                                                                                                                                                                                                        | **Modify — Task 1 only.** | Exercises `CustomerService.createApplication`; protects B-line callers in `CustomerController.createApplication` and `CustomerController.submitApplication`, which are used by `apps/web/src/app/applications/page.tsx` and `apps/web/src/app/applications/[id]/page.tsx`. |
| `apps/api/test/subscription-journey-application.spec.ts`                                                                                                                                                                                              | **Modify — Task 2 only.** | Composes `CustomerService.validateJourneyApplication` with `SubscriptionJourneyService.validateApplicationJob`; downstream repository projections are consumed by Admin/Portal Journey APIs.                                                                               |
| `apps/api/test/subscription-journey-worker.spec.ts`                                                                                                                                                                                                   | **Modify — Task 3 only.** | Protects the handler/worker result boundary used by `SubscriptionJourneyHandlers.handle` and `SubscriptionJourneyWorker.runOnce`.                                                                                                                                          |
| `apps/api/test/self-service-application.spec.ts`                                                                                                                                                                                                      | **Read/Test only.**       | Existing A-line service characterization for `CustomerController.createSelfServiceApplication` and `PortalApplicationService.createApplication`; portal web consumer is `apps/web/src/app/portal/catalog/[id]/page.tsx`.                                                   |
| `apps/api/test/subscription-journey-golden-path.e2e-spec.ts`                                                                                                                                                                                          | **Read/Test only.**       | Existing PostgreSQL A/B convergence test selected by `api.subscription-journey-golden-path.postgres`.                                                                                                                                                                      |
| `release/contracts/database-test-manifest.v1.json`                                                                                                                                                                                                    | **Read only.**            | Existing suite identity, file selection, PG role, chain applicability, timeout, and custody policy remain unchanged. Coordinate with release owners if another approved plan edits this shared manifest.                                                                   |
| `scripts/release/run-database-suite.mjs` and `scripts/release/database-test-launcher-runtime.mjs`                                                                                                                                                     | **Read/Execute only.**    | Existing release-owned fresh provisioning, migration, test context, custody, and cleanup lifecycle. B1 creates no parallel helper.                                                                                                                                         |
| `apps/api/src/customer/customer.service.ts`; `apps/api/src/customer/customer.controller.ts`; `apps/api/src/portal/portal-application.service.ts`; `apps/api/src/portal/portal-application.controller.ts`                                              | **Read only.**            | Application authority and Admin/Portal callers. Any future edit requires an exact counterexample and separate serialized approval because these are shared business files.                                                                                                 |
| `apps/api/src/subscription-journey/application-readiness.ts`; `subscription-journey.service.ts`; `subscription-journey-signal.service.ts`; `subscription-journey.repository.ts`; `subscription-journey.handlers.ts`; `subscription-journey.worker.ts` | **Read only.**            | Readiness classification and orchestration projection. Shared with B2–B6 and release recovery work; B1 does not change runtime behavior.                                                                                                                                   |
| `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/**`, `package.json`, `apps/api/package.json`, `packages/shared/**`, `apps/web/**`                                                                                                        | **Read only.**            | Schema default, scripts, shared auth, and UI consumers are evidence sources only; no B1 change is authorized.                                                                                                                                                              |

## Fresh Execution Preflight

- [ ] **Step 1: Confirm the approved source and worktree state without mutating Git**

Run:

```powershell
git rev-parse HEAD
git status --short
$b1BaseSha = (git rev-parse HEAD).Trim()
```

Expected: the SHA is the implementation-approved descendant of planning baseline `4b93f8abf4697d3970205d3d37e78e8a55b4ebd6`; every pre-existing change is classified before touching the three owned test files.

Record `$b1BaseSha` in the local non-secret task handoff. After each B1 commit, record its exact SHA separately; other approved R/B commits may interleave, so neither `HEAD~3` nor a contiguous commit range proves B1 ownership.

- [ ] **Step 2: Confirm the retired fixed target remains absent without opening archives or secrets**

Run:

```powershell
@(
  '.release-local/controlled-target.v1.json',
  '.release-local/secrets/bootstrap.json',
  '.release-local/secrets/migrate.json',
  '.release-local/secrets/verify.json',
  '.release-local/secrets/runtime-test.json'
) | ForEach-Object { [pscustomobject]@{ Path = $_; Exists = Test-Path -LiteralPath $_ } }
```

Expected: all five `Exists` values are `False`. If any is `True`, stop; do not read it, migrate it, delete it, or reuse it under B1.

- [ ] **Step 3: Generate local code prerequisites without database access**

Run:

```powershell
pnpm --filter @subscription-saas/shared build
pnpm prisma:generate
```

Expected: both commands exit `0`. These are source-generation steps and do not establish a database or release-candidate identity.

---

### Task 1: Characterize B-Line Application Intake Without an Order Bypass

**Files:**

- Modify: `apps/api/test/application-review-api.spec.ts` (the existing B-line draft test and `tx.application.create` harness)
- Read/Test: `apps/api/test/self-service-application.spec.ts`
- Read: `apps/api/src/customer/customer.service.ts:1404`
- Read: `apps/api/prisma/schema.prisma:3306`

**Interfaces:**

- Consumes: `CustomerService.createApplication(dto: CreateApplicationDto, user: RequestUser, context: RequestContext)` and Prisma's `Application.applicationSource` default `SALES_ASSISTED`.
- Produces: a unit contract proving B-line creation returns a `DRAFT` `SALES_ASSISTED` Application, creates no `SubscriptionOrder`, and emits no Journey submission signal until `submitApplication(...)`; no runtime API changes.

- [ ] **Step 1: Tighten the existing B-line draft test around the real Prisma default and no-bypass boundary**

Replace the existing `allows an incomplete customer to have a sales-assisted draft` assertion body with the following exact assertions while keeping its incomplete-customer fixture:

```ts
const application = await harness.service.createApplication(
  {
    customerId: "customer-1",
    intendedModel: "ET5"
  },
  harness.user,
  harness.context
);

expect(application).toMatchObject({
  applicationSource: ApplicationSource.SALES_ASSISTED,
  status: ApplicationStatus.DRAFT
});
expect(harness.tx.application.create).toHaveBeenCalledWith({
  data: expect.not.objectContaining({
    applicationSource: expect.anything()
  })
});
expect(harness.tx.subscriptionOrder.create).not.toHaveBeenCalled();
expect(harness.journeySignal.record).not.toHaveBeenCalled();
expect(harness.tx.customerIdentity.upsert).not.toHaveBeenCalled();
```

In the same test file, add `import { readFileSync } from "node:fs";`, then add this independent public-schema assertion beside the B-line draft case:

```ts
it("declares SALES_ASSISTED as the Prisma Application source default", () => {
  const schemaSource = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const application = schemaSource.match(/^model\s+Application\s*\{([\s\S]*?)^\}/m);
  expect(application, "Prisma model Application is missing").toBeDefined();
  const declarations = (application?.[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => /^applicationSource\s/.test(line));

  expect(declarations).toHaveLength(1);
  expect(declarations[0]).toMatch(
    /^applicationSource\s+ApplicationSource\s+@default\(SALES_ASSISTED\)\s+@map\("application_source"\)$/
  );
});
```

This narrowly isolates the `Application` model, strips line comments, requires exactly one `applicationSource` declaration, and asserts its public schema type/default/map. Prisma 7 runtime DMMF exposes the field kind/type but not `default`/`hasDefaultValue`, so it is not used as default authority. The draft case separately proves that service input omits `applicationSource`, while the existing real PostgreSQL golden-path fixture remains the persistence proof. Do not add another database suite, helper, dependency, `getDMMF` call, or private API.

- [ ] **Step 2: Run the focused test once and confirm the only failure is the unit harness's missing Prisma default**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/application-review-api.spec.ts -t "allows an incomplete customer to have a sales-assisted draft|declares SALES_ASSISTED as the Prisma Application source default"
```

Expected: the public-schema assertion passes, while the focused draft case fails because the current in-memory `tx.application.create` retains the harness's prior `SELF_SERVICE` value instead of applying the independently verified `SALES_ASSISTED` default. The production method and schema are not changed.

- [ ] **Step 3: Make the unit harness emulate the existing Prisma default**

In `createApplicationReviewHarness`, change only the `tx.application.create` fixture merge to include:

```ts
state.application = makeApplication(now, {
  ...state.application,
  ...data,
  applicationSource: data.applicationSource ?? ApplicationSource.SALES_ASSISTED,
  createdAt: now,
  id: "application-created",
  status: data.status ?? ApplicationStatus.DRAFT
});
```

- [ ] **Step 4: Run both A- and B-line intake characterizations**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/application-review-api.spec.ts test/self-service-application.spec.ts
```

Expected: PASS; all selected tests execute with `failed=0`, `skipped=0`, and `todo=0`. The existing A-line test continues to assert `SELF_SERVICE`, `SUBMITTED`, pending review/deposit, review reservation, submission signal, and no Quote/Order creation.

- [ ] **Step 5: Commit the isolated B-line intake characterization**

```powershell
pnpm exec prettier --check apps/api/test/application-review-api.spec.ts
git diff --check
git add -- apps/api/test/application-review-api.spec.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "test: validate B-line application intake authority"
git rev-parse HEAD
```

The staged list must contain only this task's test file. Preserve the returned commit SHA as B1 Task 1 evidence; any unrelated staged content stops the commit.

---

### Task 2: Compose Real Application Readiness With Journey Business Outcomes

**Files:**

- Modify: `apps/api/test/subscription-journey-application.spec.ts`
- Read: `apps/api/src/subscription-journey/application-readiness.ts:1`
- Read: `apps/api/src/customer/customer.service.ts:1718`
- Read: `apps/api/src/subscription-journey/subscription-journey.service.ts:920`
- Read: `apps/api/src/subscription-journey/subscription-journey.repository.ts:250`

**Interfaces:**

- Consumes: `CustomerService.validateJourneyApplication(tx, applicationId): Promise<ApplicationReadinessResult>` and `SubscriptionJourneyService.validateApplicationJob(job): Promise<Prisma.InputJsonValue>`.
- Produces: composed unit contracts for both A/B manual waits, customer supplementation, and Application-owned rejection/cancellation reason codes. The contracts assert Journey repository commands are selected from Application facts and never mark validation complete for wait/terminal outcomes.

- [ ] **Step 1: Add a composed harness that uses the real CustomerService classifier**

Add this helper beside the existing `validationTransaction` helper:

```ts
function composedValidationHarness(
  applicationOverrides: Record<string, unknown>,
  journeyOverrides: Record<string, unknown> = {}
) {
  const application = readyApplication(applicationOverrides);
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: application.id }]),
    application: {
      findUnique: vi.fn(async () => application)
    },
    subscriptionJourney: validationTransaction(journeyOverrides).subscriptionJourney
  };
  const repository = {
    completeStep: vi.fn(async () => undefined),
    rejectForApplication: vi.fn(async () => undefined),
    waitForCustomer: vi.fn(async () => undefined),
    waitForManual: vi.fn(async () => undefined)
  };
  const customerService = new CustomerService({} as never, {} as never, {} as never, {} as never);
  const service = new SubscriptionJourneyService(
    repository as never,
    transactionHost(tx) as never,
    customerService
  );
  return { application, repository, service, tx };
}
```

- [ ] **Step 2: Characterize identical A/B manual-wait classification from Application facts**

Add this test inside `subscription journey application validation`:

```ts
it.each([ApplicationSource.SELF_SERVICE, ApplicationSource.SALES_ASSISTED])(
  "derives the %s manual wait from Application review facts",
  async (source) => {
    const harness = composedValidationHarness({
      applicationSource: source,
      creditReviewStatus: OrderReviewStatus.PENDING,
      depositStatus: DepositStatus.PENDING_CONFIRM,
      finalDepositAmount: null,
      journeyFactVersion: 7,
      materialReviewStatus: OrderReviewStatus.PENDING
    });

    await expect(harness.service.validateApplicationJob(validationJob())).resolves.toEqual({
      action: "APPLICATION_VALIDATION_WAITING_MANUAL",
      applicationId: harness.application.id,
      factVersion: 7,
      reasonCodes: [
        "MATERIAL_REVIEW_PENDING",
        "CREDIT_REVIEW_PENDING",
        "DEPOSIT_CONFIRMATION_PENDING"
      ]
    });
    expect(harness.tx.application.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: harness.application.id } })
    );
    expect(harness.repository.waitForManual).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        factVersion: 7,
        journeyId: "journey-1",
        stepId: "step-validation"
      })
    );
    expect(harness.repository.completeStep).not.toHaveBeenCalled();
    expect(harness.repository.rejectForApplication).not.toHaveBeenCalled();
  }
);
```

- [ ] **Step 3: Characterize customer supplementation as a normal business wait**

Add:

```ts
it("derives customer supplementation from Application material facts", async () => {
  const harness = composedValidationHarness({
    applicationSource: ApplicationSource.SELF_SERVICE,
    journeyFactVersion: 8,
    materialReviewStatus: OrderReviewStatus.NEED_MORE_INFO,
    status: ApplicationStatus.NEED_MORE_INFO
  });

  await expect(harness.service.validateApplicationJob(validationJob())).resolves.toEqual({
    action: "APPLICATION_VALIDATION_WAITING_CUSTOMER",
    applicationId: harness.application.id,
    factVersion: 8,
    reasonCodes: ["MATERIAL_SUPPLEMENT_REQUIRED"]
  });
  expect(harness.repository.waitForCustomer).toHaveBeenCalledWith(
    harness.tx,
    expect.objectContaining({
      factVersion: 8,
      payload: {
        factVersion: 8,
        reasonCodes: ["MATERIAL_SUPPLEMENT_REQUIRED"]
      }
    })
  );
  expect(harness.repository.completeStep).not.toHaveBeenCalled();
  expect(harness.repository.rejectForApplication).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Characterize Application rejection and cancellation as business terminal outcomes**

Add:

```ts
it.each([
  [ApplicationStatus.REJECTED, "APPLICATION_REJECTED"],
  [ApplicationStatus.CANCELLED, "APPLICATION_CANCELLED"]
] as const)(
  "terminates validation from authoritative Application status %s",
  async (status, reasonCode) => {
    const harness = composedValidationHarness({
      journeyFactVersion: 9,
      softReservedVehicleId: null,
      status
    });

    await expect(harness.service.validateApplicationJob(validationJob())).resolves.toEqual({
      action: "APPLICATION_VALIDATION_REJECTED",
      applicationId: harness.application.id,
      factVersion: 9,
      reasonCodes: [reasonCode]
    });
    expect(harness.repository.rejectForApplication).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({
        activeJobId: "job-validation",
        factVersion: 9,
        payload: { factVersion: 9, reasonCodes: [reasonCode] }
      })
    );
    expect(harness.repository.waitForCustomer).not.toHaveBeenCalled();
    expect(harness.repository.waitForManual).not.toHaveBeenCalled();
    expect(harness.repository.completeStep).not.toHaveBeenCalled();
  }
);
```

The word `REJECTED` in the Journey action is the existing repository terminal command name; the payload preserves the distinct Application reason code for cancellation versus rejection.

- [ ] **Step 5: Run the composed contracts and existing Application mutation contracts**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/subscription-journey-application.spec.ts test/application-review-api.spec.ts
```

Expected: PASS without changing runtime source. The existing `application-review-api.spec.ts` cases also pass for Application status/fact-version mutation, soft-hold release, and `terminateApplication(...)` calls on rejection/cancellation. If a new composed test fails due to runtime behavior rather than test wiring, stop and report the exact failing case and source method.

- [ ] **Step 6: Commit the Application-to-Journey characterization**

```powershell
pnpm exec prettier --check apps/api/test/subscription-journey-application.spec.ts
git diff --check
git add -- apps/api/test/subscription-journey-application.spec.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "test: validate application-owned journey waits"
git rev-parse HEAD
```

The staged list must contain only this test file; record this exact Task 2 commit SHA rather than assuming it immediately follows Task 1.

---

### Task 3: Lock the Worker Boundary Between Business Outcomes and Technical Failures

**Files:**

- Modify: `apps/api/test/subscription-journey-worker.spec.ts`
- Read: `apps/api/src/subscription-journey/subscription-journey.handlers.ts:10`
- Read: `apps/api/src/subscription-journey/subscription-journey.worker.ts:106`

**Interfaces:**

- Consumes: `SubscriptionJourneyHandlers.handle(job): Promise<Prisma.InputJsonValue>` and the worker rule that resolved handler values call `completeJob`, while thrown failures call `rescheduleJob` or `deadLetterJob`.
- Produces: a table-driven B1 contract for `APPLICATION_VALIDATION_WAITING_MANUAL`, `APPLICATION_VALIDATION_WAITING_CUSTOMER`, and `APPLICATION_VALIDATION_REJECTED`, plus an explicit retry assertion for a thrown validation execution error.

- [ ] **Step 1: Expand the existing single manual-wait worker test to all B1 normal outcomes**

Replace `completes an application-review business wait without retry or dead-letter` with:

```ts
it.each([
  {
    action: "APPLICATION_VALIDATION_WAITING_MANUAL",
    reasonCodes: ["MATERIAL_REVIEW_PENDING"]
  },
  {
    action: "APPLICATION_VALIDATION_WAITING_CUSTOMER",
    reasonCodes: ["MATERIAL_SUPPLEMENT_REQUIRED"]
  },
  {
    action: "APPLICATION_VALIDATION_REJECTED",
    reasonCodes: ["APPLICATION_REJECTED"]
  }
] as const)("completes $action without retry or dead-letter", async (result) => {
  const job = claimedJob({
    jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION
  });
  const harness = createWorkerHarness({ jobs: [job] });
  harness.handlers.handle.mockResolvedValueOnce({
    action: result.action,
    applicationId: "application-1",
    factVersion: 3,
    reasonCodes: [...result.reasonCodes]
  } as never);

  await harness.worker.runOnce();

  expect(harness.repository.completeJob).toHaveBeenCalledWith(
    expect.anything(),
    job.id,
    job.leaseToken,
    expect.objectContaining({ action: result.action })
  );
  expect(harness.repository.rescheduleJob).not.toHaveBeenCalled();
  expect(harness.repository.deadLetterJob).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Make the existing retry test explicit about a validation technical failure**

Rename `applies bounded jitter when rescheduling a retryable job` to `reschedules a thrown application-validation execution error` and construct the job explicitly:

```ts
vi.spyOn(Math, "random").mockReturnValue(1);
const job = claimedJob({
  attemptCount: 0,
  jobType: SubscriptionJourneyJobType.VALIDATE_APPLICATION
});
const harness = createWorkerHarness({
  handlerError: new Error("database unavailable"),
  jobs: [job]
});

await harness.worker.runOnce();

expect(harness.repository.completeJob).not.toHaveBeenCalled();
expect(harness.repository.rescheduleJob).toHaveBeenCalledWith(
  expect.anything(),
  job.id,
  job.leaseToken,
  {
    delayMs: 36_000,
    error: {
      code: "JOURNEY_EXECUTION_ERROR",
      message: "Subscription journey operation failed.",
      retryable: true
    }
  }
);
expect(harness.repository.deadLetterJob).not.toHaveBeenCalled();
```

The sanitized message prevents the underlying database text from becoming evidence output.

- [ ] **Step 3: Run the worker boundary tests**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/subscription-journey-worker.spec.ts
```

Expected: PASS. Every normal B1 result completes its job without retry/dead-letter; the thrown validation error does not complete the job and is rescheduled with sanitized `JOURNEY_EXECUTION_ERROR`.

- [ ] **Step 4: Commit the isolated worker classification contract**

```powershell
pnpm exec prettier --check apps/api/test/subscription-journey-worker.spec.ts
git diff --check
git add -- apps/api/test/subscription-journey-worker.spec.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "test: separate journey business waits from failures"
git rev-parse HEAD
```

The staged list must contain only this test file; record the exact Task 3 commit SHA. Review formatting and all staged changes before committing.

---

### Task 4: Produce Fresh B1 Validation Evidence Through Existing Entrypoints

**Files:**

- Test: `apps/api/test/application-review-api.spec.ts`
- Test: `apps/api/test/self-service-application.spec.ts`
- Test: `apps/api/test/subscription-journey-application.spec.ts`
- Test: `apps/api/test/subscription-journey-worker.spec.ts`
- Test: `apps/api/test/subscription-journey-golden-path.e2e-spec.ts`
- Read/Execute: `release/contracts/database-test-manifest.v1.json`
- Read/Execute: `scripts/release/run-database-suite.mjs`
- Do not create or modify a committed evidence manifest.

**Interfaces:**

- Consumes: the four focused unit files and existing suite ID `api.subscription-journey-golden-path.postgres` with `chain=fresh` and `databaseRole=runtime-equivalent-test`.
- Produces: fresh command results tied to the execution SHA, plus the launcher's existing canonical report/custody receipt/readback. These are local controlled non-promotable validation evidence, not candidate, snapshot, Staging, browser, or provider evidence.

- [ ] **Step 1: Run the complete focused B1 unit selection**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/application-review-api.spec.ts test/self-service-application.spec.ts test/subscription-journey-application.spec.ts test/subscription-journey-worker.spec.ts
```

Expected: exit `0`; every selected test passes with no failed, skipped, or todo test. Record the actual source SHA and actual counts from this run; do not reuse the historical P1 count `4074/4074`.

- [ ] **Step 2: Run static checks limited to the owned test changes**

Run:

```powershell
pnpm --filter @subscription-saas/api exec eslint test/application-review-api.spec.ts test/subscription-journey-application.spec.ts test/subscription-journey-worker.spec.ts
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
git diff --check
```

Expected: all commands exit `0`; `git diff --check` has no output.

- [ ] **Step 3: Run the existing self-contained fresh PostgreSQL A/B convergence suite and bind its receipt**

Run exactly once. Inventory receipt **filenames only** before and after the invocation, parse only the launcher's stdout as the report, then bind the single new receipt to that report and independently hash its content-addressed report:

```powershell
$suiteId = 'api.subscription-journey-golden-path.postgres'
$evidenceRoot = Join-Path (Get-Location) '.release-local/evidence'
$receiptRoot = Join-Path $evidenceRoot 'receipts'
$beforeReceiptNames = @()
if (Test-Path -LiteralPath $receiptRoot) {
  $beforeReceiptNames = @(
    Get-ChildItem -LiteralPath $receiptRoot -File | Select-Object -ExpandProperty Name
  )
}
$stdout = @(
  & node scripts/release/run-database-suite.mjs --suite-id $suiteId --chain fresh
)
$suiteExit = $LASTEXITCODE
$afterReceiptNames = @()
if (Test-Path -LiteralPath $receiptRoot) {
  $afterReceiptNames = @(
    Get-ChildItem -LiteralPath $receiptRoot -File | Select-Object -ExpandProperty Name
  )
}
if ($suiteExit -ne 0) { throw "B1_FRESH_SUITE_FAILED" }
$stdoutJson = $stdout -join ''
$report = $stdoutJson | ConvertFrom-Json
$newReceiptNames = @($afterReceiptNames | Where-Object { $_ -notin $beforeReceiptNames })
if ($newReceiptNames.Count -ne 1) {
  throw "B1_CURRENT_RECEIPT_IDENTITY_AMBIGUOUS: $($newReceiptNames -join ',')"
}
$receiptPath = Join-Path $receiptRoot $newReceiptNames[0]
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
$canonicalDigestScript = @'
import { sha256Canonical } from "./packages/release-foundation/src/index.mjs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(sha256Canonical(JSON.parse(input)));
'@
function Get-B1CanonicalDigest([string]$json) {
  $digest = @($json | & node --input-type=module -e $canonicalDigestScript)
  if ($LASTEXITCODE -ne 0 -or $digest.Count -ne 1) {
    throw "B1_CANONICAL_DIGEST_FAILED"
  }
  return ($digest -join '').Trim()
}
if (
  $report.runId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
  $report.suiteId -ne $suiteId -or
  $report.terminalStatus -ne 'PASSED' -or
  $report.counts.collected -ne 1 -or
  $report.counts.selected -ne 1 -or
  $report.counts.executed -ne 1 -or
  $report.counts.passed -ne 1 -or
  $report.counts.failed -ne 0 -or
  $report.counts.skipped -ne 0 -or
  $report.counts.todo -ne 0 -or
  $report.counts.filtered -ne 0 -or
  $report.counts.cancelled -ne 0
) {
  throw "B1_STDOUT_REPORT_IDENTITY_INVALID"
}
$expectedAttestation = "local-controlled-nonpromotable://$($report.runId)/$($report.suiteId)"
if (
  $receipt.attestationRef -ne $expectedAttestation -or
  $newReceiptNames[0] -ne "$($receipt.receiptId).json"
) {
  throw "B1_CURRENT_RECEIPT_BINDING_MISMATCH"
}
if (
  $receipt.contentDigest -notmatch '^sha256:[0-9a-f]{64}$' -or
  $receipt.readbackDigest -notmatch '^sha256:[0-9a-f]{64}$'
) {
  throw "B1_CURRENT_RECEIPT_DIGEST_FORMAT_INVALID"
}
$contentPath = Join-Path $evidenceRoot (
  'evidence/' + $receipt.contentDigest.Substring('sha256:'.Length) + '.json'
)
$independentDigest = 'sha256:' + (
  Get-FileHash -LiteralPath $contentPath -Algorithm SHA256
).Hash.ToLowerInvariant()
$storedRaw = Get-Content -LiteralPath $contentPath -Raw
$storedReport = $storedRaw | ConvertFrom-Json
$stdoutCanonicalDigest = Get-B1CanonicalDigest $stdoutJson
$storedCanonicalDigest = Get-B1CanonicalDigest $storedRaw
$countKeys = @(
  'collected', 'selected', 'executed', 'passed', 'failed',
  'skipped', 'todo', 'filtered', 'cancelled'
)
$storedCountMismatch = @(
  $countKeys | Where-Object { $storedReport.counts.$_ -ne $report.counts.$_ }
).Count -gt 0
if (
  $receipt.contentDigest -ne $receipt.readbackDigest -or
  $receipt.contentDigest -ne $independentDigest -or
  $receipt.contentDigest -ne $stdoutCanonicalDigest -or
  $receipt.contentDigest -ne $storedCanonicalDigest -or
  $storedReport.runId -ne $report.runId -or
  $storedReport.suiteId -ne $report.suiteId -or
  $storedReport.terminalStatus -ne $report.terminalStatus -or
  $storedCountMismatch
) {
  throw "B1_CURRENT_RECEIPT_REPORT_MISMATCH"
}
$currentRunPath = Join-Path (Get-Location) ".release-local/runs/$($report.runId)"
if (Test-Path -LiteralPath $currentRunPath) {
  throw "B1_SUCCESS_LIFECYCLE_NOT_RETIRED: $currentRunPath"
}
[pscustomobject]@{
  beforeReceiptNames = $beforeReceiptNames
  afterReceiptNames = $afterReceiptNames
  runId = $report.runId
  suiteId = $report.suiteId
  independentDigest = $independentDigest
  stdoutCanonicalDigest = $stdoutCanonicalDigest
  storedCanonicalDigest = $storedCanonicalDigest
  terminalStatus = $report.terminalStatus
  counts = $report.counts
} | ConvertTo-Json -Depth 5
```

Expected: exit `0`; the parsed stdout report has exact `runId`/`suiteId`, `terminalStatus=PASSED`, `collected=selected=executed=passed=1`, and `failed=skipped=todo=filtered=cancelled=0`. Exactly one receipt filename appears in the after-minus-before set. Before constructing the content path, both receipt digests match the strict `sha256:<64 lowercase hex>` form. The receipt attestation and filename bind the exact stdout identity, the stored report repeats the stdout identity/status/counts, and the receipt content/readback digest equals both the independent raw-file SHA-256 and the existing canonical helper's digest of the original stdout/stored JSON text. Never feed a `ConvertFrom-Json` object back through `ConvertTo-Json` for this digest. The launcher then cleans up through its existing lifecycle. Do not manually create a target, inspect credentials, retry a failed/unknown cleanup under a different ID, or copy P1 evidence.

- [ ] **Step 4: Read back only the non-secret result references emitted by this fresh run**

Record in the implementation handoff:

```text
source SHA
exact command and exit code
actual unit selected/passed/failed/skipped/todo counts
before/after receipt filename inventories and the single new receipt filename
exact stdout report runId and suiteId
independent raw-file hash plus stdout/stored canonical report hashes
custody receipt id and content/readback/raw/canonical digest equality
cleanup terminal status
```

Expected: `contentDigest == readbackDigest`, cleanup is terminally successful, and no fixed controlled target or fixed secret file is left behind. The handoff must label this evidence `local-controlled-nonpromotable` and state that deterministic providers do not prove external services.

- [ ] **Step 5: Reconfirm scope and absence of unauthorized files**

Run:

```powershell
git status --short
```

Use `git show --format=fuller --stat` and `git diff-tree --no-commit-id --name-only -r` separately for each exact B1 commit SHA recorded in Tasks 1–3. Expected: those three commits change only the three owned test files; there is no modification to production source, Prisma schema/migrations, package files, release contracts, the database launcher, web code, or B2 tests. Do not infer ownership from `HEAD~3`; other approved work may interleave. Local `.release-local` evidence may exist according to the existing launcher policy and is not staged.

## Stop Conditions and Review Gate

Stop B1 implementation and return to review when any of the following occurs:

- A/B intake creates a Quote, Order, or Contract before Application review/final-plan flow;
- B-line Application does not resolve to `SALES_ASSISTED`, or A-line does not persist `SELF_SERVICE` and pending intake facts;
- a manual/customer wait calls worker retry/dead-letter handling, or a thrown technical failure completes the job as a business wait;
- rejection/cancellation is inferred from Journey projection without the corresponding Application status, or Application mutation fails to terminate the Journey projection;
- the fix would touch `customer.service.ts`, Journey runtime source, Prisma schema/migrations, RBAC, feature flags, web behavior, package scripts, release contracts, or database lifecycle code;
- the fresh launcher reports failed/skipped/todo/filtered/cancelled work, cleanup is `UNKNOWN`, digest readback differs, or the fixed retired target/secrets reappear.

For a runtime counterexample, the review request must identify the exact failing test, actual/expected values, exact source method and lines, affected Admin/Portal callers, and why the minimal production change remains B1 rather than B2. Until that amendment is approved, preserve the failure evidence and make no production change.

## Completion Criteria

B1 is ready for review only when Tasks 1–4 are complete, the three test-only commits are independently reviewable, focused unit/static checks pass, the unchanged governed fresh database suite passes with complete zero-failure accounting and verified cleanup, and the handoff explicitly records the remaining limits: no snapshot chain, candidate image, Staging, browser, provider, or customer-data validation was performed.
