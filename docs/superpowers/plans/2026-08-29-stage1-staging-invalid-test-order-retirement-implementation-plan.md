# Stage 1 Staging Invalid Test Order Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a one-time, Staging-only CLI that atomically retires the single invalid historical test order while preserving contracts and handover evidence.

**Architecture:** Follow the repository's three-file operational-tool pattern: a pure deterministic classifier, a Prisma executor with read-only dry-run and Serializable apply, and a credential-safe CLI wrapper. A hard-coded order/vehicle allowlist, active ADMIN operator validation, dry-run evidence digest, advisory/row locks, conditional updates, four audit rows, and replay classification prevent the tool from becoming a general cancellation surface.

**Tech Stack:** Node.js 22 ESM, `node:test`, Prisma 7 with PostgreSQL adapter, PostgreSQL Serializable transactions/advisory locks, pnpm 11.4.0, Vitest runtime-media contract.

**Spec:** `docs/superpowers/specs/2026-08-29-stage1-staging-invalid-test-order-retirement-design.zh-CN.md`

## Global Constraints

- The only permitted target is order `ORD20260726073922TFHF` / `c392fa54-4784-4e04-ad4a-bfe2fd7e2d10` and vehicle `VEH20260713140950K4BT` / `70565059-1841-4c97-a32c-7bd09ce0b90f` / VIN `TESTVINET50000001`.
- Apply is permitted only when normalized `DEPLOYMENT_ENV` or `APP_ENV` equals `staging` and `STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY=1` exactly.
- Apply requires a dry-run `evidenceDigest` and an active, undeleted user with an active, undeleted `ADMIN` role assignment.
- Do not add an API route, Admin/Portal UI, database migration, generic order selector, deletion, physical-return fact, BASE segment, or vehicle subscription period.
- Preserve existing contracts, e-sign tasks, file objects, handover records, `actualDeliveryAt`, `startDate`, `endDate`, `actualReturnAt`, and `contractId`.
- The only business transitions are order `ACTIVE → CANCELLED`, Lease `ACTIVE → COMPLETED`, BillingSchedule `PAUSED → CANCELLED`, and vehicle `LEASED → AVAILABLE`.
- Dry-run must be zero-write; apply must be one Serializable transaction; replay must be zero-write and zero-audit.
- Reports and audits must not expose customer identity, database URLs, object keys, signing URLs, or storage credentials.
- Do not run any Staging apply while implementing or testing. A later explicit user approval is required after deployment and dry-run review.
- Preserve unrelated local changes. Do not modify the root worktree's Docker mirror edits or temporary directories.
- Before code changes, run the repository-required migration status and Prisma validation preflight. Never run `prisma migrate reset`.

---

### Task 1: Lock the CLI Contract and Hard-Coded Target

**Files:**

- Create: `scripts/stage1-staging-invalid-test-order-retirement-core.mjs`
- Create: `scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs`

**Interfaces:**

- Produces `STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET` as a frozen object with `orderId`, `orderNo`, `vehicleId`, `vehicleNo`, and `vin`.
- Produces `parseStage1StagingInvalidTestOrderRetirementArgs(args)` returning `{ expectedEvidenceDigest, mode, operatorId, output, selectors }`.
- Produces `assertStage1StagingInvalidTestOrderRetirementTarget(selectors)` which throws a stable target-mismatch error before a Prisma client is created.
- Later tasks consume the exact parsed shape and constants; do not rename fields.

- [ ] **Step 1: Run the required clean-worktree and Prisma preflight**

Run:

```powershell
git status --short --branch
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm prisma:validate
```

Expected: only the committed design/plan history is present, migration status reports no pending migration, and Prisma validation exits 0. If dependencies are absent, run `pnpm install --frozen-lockfile` and repeat the three commands.

- [ ] **Step 2: Write failing parser and allowlist tests**

Create `scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs` with these first contract tests:

```js
import assert from "node:assert/strict";
import test from "node:test";

const core = await import("./stage1-staging-invalid-test-order-retirement-core.mjs").catch(
  () => ({})
);

function required(name) {
  assert.equal(typeof core[name], "function", `${name} must be exported`);
  return core[name];
}

const selectors = {
  orderId: "c392fa54-4784-4e04-ad4a-bfe2fd7e2d10",
  orderNo: "ORD20260726073922TFHF",
  vehicleId: "70565059-1841-4c97-a32c-7bd09ce0b90f",
  vehicleNo: "VEH20260713140950K4BT",
  vin: "TESTVINET50000001"
};

test("parses the exact dry-run contract", () => {
  const parse = required("parseStage1StagingInvalidTestOrderRetirementArgs");
  assert.deepEqual(
    parse([
      "--dry-run",
      "--order-id",
      selectors.orderId,
      "--order-no",
      selectors.orderNo,
      "--vehicle-id",
      selectors.vehicleId,
      "--vehicle-no",
      selectors.vehicleNo,
      "--vin",
      selectors.vin,
      "--operator-id",
      "11111111-1111-4111-8111-111111111111",
      "--output",
      "output/retirement-dry-run.json"
    ]),
    {
      expectedEvidenceDigest: null,
      mode: "dry-run",
      operatorId: "11111111-1111-4111-8111-111111111111",
      output: "output/retirement-dry-run.json",
      selectors
    }
  );
});

test("apply requires one lowercase sha256 evidence digest", () => {
  const parse = required("parseStage1StagingInvalidTestOrderRetirementArgs");
  const base = [
    "--apply",
    "--order-id",
    selectors.orderId,
    "--order-no",
    selectors.orderNo,
    "--vehicle-id",
    selectors.vehicleId,
    "--vehicle-no",
    selectors.vehicleNo,
    "--vin",
    selectors.vin,
    "--operator-id",
    "11111111-1111-4111-8111-111111111111"
  ];
  assert.throws(() => parse(base), /EXPECTED_EVIDENCE_DIGEST_REQUIRED/);
  assert.equal(
    parse([...base, "--expected-evidence-digest", "a".repeat(64)]).expectedEvidenceDigest,
    "a".repeat(64)
  );
});

test("rejects unknown, repeated, malformed, or mode-incompatible arguments", () => {
  const parse = required("parseStage1StagingInvalidTestOrderRetirementArgs");
  for (const args of [
    [],
    ["--dry-run", "--apply"],
    ["--dry-run", "--unknown", "x"],
    ["--dry-run", "--expected-evidence-digest", "a".repeat(64)],
    ["--dry-run", "--operator-id", "not-a-uuid"]
  ]) {
    assert.throws(() => parse(args), /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_/);
  }
});

test("target assertion accepts only the frozen five-field identity", () => {
  const assertTarget = required("assertStage1StagingInvalidTestOrderRetirementTarget");
  assert.doesNotThrow(() => assertTarget(selectors));
  for (const field of Object.keys(selectors)) {
    assert.throws(
      () => assertTarget({ ...selectors, [field]: `${selectors[field]}-other` }),
      /TARGET_MISMATCH/
    );
  }
});
```

- [ ] **Step 3: Run the parser tests and confirm RED**

Run:

```powershell
node --test scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs
```

Expected: FAIL because the new core exports do not exist.

- [ ] **Step 4: Implement the strict parser and target assertion**

Create `scripts/stage1-staging-invalid-test-order-retirement-core.mjs` beginning with the exact public contract:

```js
export const STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET = Object.freeze({
  orderId: "c392fa54-4784-4e04-ad4a-bfe2fd7e2d10",
  orderNo: "ORD20260726073922TFHF",
  vehicleId: "70565059-1841-4c97-a32c-7bd09ce0b90f",
  vehicleNo: "VEH20260713140950K4BT",
  vin: "TESTVINET50000001"
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const OPTION_FIELDS = new Map([
  ["--order-id", "orderId"],
  ["--order-no", "orderNo"],
  ["--vehicle-id", "vehicleId"],
  ["--vehicle-no", "vehicleNo"],
  ["--vin", "vin"]
]);

export function assertStage1StagingInvalidTestOrderRetirementTarget(selectors) {
  for (const [field, expected] of Object.entries(
    STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET
  )) {
    if (selectors?.[field] !== expected) {
      throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET_MISMATCH");
    }
  }
}
```

Implement the argument loop with one-use tracking for every option. Require all five selectors and `operatorId`; validate UUIDs; allow `--output value` and `--output=value`; forbid `expectedEvidenceDigest` in dry-run and require a lowercase SHA-256 in apply. End by calling `assertStage1StagingInvalidTestOrderRetirementTarget(selectors)` before returning the parsed object.

- [ ] **Step 5: Run the parser tests and confirm GREEN**

Run:

```powershell
node --test scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs
```

Expected: all parser and hard-coded target tests PASS.

- [ ] **Step 6: Commit the CLI contract**

Run:

```powershell
git add scripts/stage1-staging-invalid-test-order-retirement-core.mjs scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs
git commit -m "test: lock staging test-order retirement contract"
```

Expected: one commit containing only the core contract and its tests.

---

### Task 2: Build the Deterministic Classifier and Evidence Digest

**Files:**

- Modify: `scripts/stage1-staging-invalid-test-order-retirement-core.mjs`
- Modify: `scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs`

**Interfaces:**

- Consumes the frozen target and strict selector contract from Task 1.
- Produces `classifyStage1StagingInvalidTestOrderRetirement(snapshot)` returning `{ blockers, candidate, disposition, evidenceDigest, summary }`.
- `disposition` is exactly `CANDIDATE`, `UNCHANGED`, or `BLOCKED`.
- `candidate` is null unless the disposition is `CANDIDATE`; then it contains the four entity IDs and fixed transitions.
- Task 3 consumes this result without reinterpreting blocker codes.

- [ ] **Step 1: Add failing clean-candidate, blocker, digest, and replay tests**

Extend the core test with a `cleanSnapshot()` fixture whose target state is:

```js
function cleanSnapshot(overrides = {}) {
  return {
    auditLogs: [],
    billingSchedule: {
      cancelledAt: null,
      id: "36054e6d-5104-4daf-b8a7-cb7e956fc436",
      lastGeneratedBillId: null,
      pauseReason: "legacy-test-order",
      status: "PAUSED",
      version: 0
    },
    blockingCounts: {
      assetWorkOrders: 0,
      automationJobs: 0,
      collectionCases: 0,
      contractSegments: 0,
      debitAttempts: 0,
      depositLedgers: 0,
      entitlementAccounts: 0,
      entitlementGrants: 0,
      entitlementUsages: 0,
      orderChanges: 0,
      paymentMandates: 0,
      paymentOrders: 0,
      paymentRecords: 0,
      paymentWriteOffs: 0,
      receivableBills: 0,
      renewalConsiderations: 0,
      returnDamages: 0,
      returns: 0,
      subscriptionChanges: 0,
      subscriptionPeriods: 0
    },
    evidenceReferences: {
      contracts: [{ id: "contract-legacy", status: "SIGNED" }],
      eSignTasks: [{ id: "esign-legacy", taskStatus: "COMPLETED" }],
      handovers: [{ id: "bfc5a943-0000-4000-8000-000000000000", status: "ARCHIVED" }]
    },
    lease: { deletedAt: null, id: "lease-legacy", status: "ACTIVE" },
    operator: {
      deletedAt: null,
      id: "11111111-1111-4111-8111-111111111111",
      roles: [{ code: "ADMIN", deletedAt: null, roleDeletedAt: null, roleStatus: "ACTIVE" }],
      status: "ACTIVE"
    },
    order: {
      actualDeliveryAt: "2026-07-31T03:01:04.000Z",
      actualReturnAt: null,
      contractId: null,
      deletedAt: null,
      endDate: null,
      id: selectors.orderId,
      orderNo: selectors.orderNo,
      orderStatus: "ACTIVE",
      startDate: null,
      vehicleId: selectors.vehicleId
    },
    vehicle: {
      activeOtherLeases: [],
      activeOtherOrders: [],
      activeRestrictions: [],
      currentSalePriceAmount: 18500000n,
      deletedAt: null,
      id: selectors.vehicleId,
      salePriceStatus: "EFFECTIVE",
      status: "LEASED",
      vehicleNo: selectors.vehicleNo,
      vin: selectors.vin
    },
    vehicleDeliveries: [],
    ...overrides
  };
}
```

Add these assertions:

```js
test("classifies only the exact empty-history active tuple as a candidate", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const result = classify(cleanSnapshot());
  assert.equal(result.disposition, "CANDIDATE");
  assert.equal(result.blockers.length, 0);
  assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.candidate.transitions, {
    billingSchedule: ["PAUSED", "CANCELLED"],
    lease: ["ACTIVE", "COMPLETED"],
    order: ["ACTIVE", "CANCELLED"],
    vehicle: ["LEASED", "AVAILABLE"]
  });
});

test("every prohibited relation fails closed with its stable count code", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  for (const field of Object.keys(cleanSnapshot().blockingCounts)) {
    const input = cleanSnapshot();
    input.blockingCounts[field] = 1;
    assert.match(classify(input).blockers[0].code, /^RELATED_/);
  }
});

test("rejects delivery, return facts, vehicle occupation, restrictions, and invalid price", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const cases = [
    ["VEHICLE_DELIVERY_PRESENT", { vehicleDeliveries: [{ id: "delivery-1" }] }],
    [
      "ORDER_ACTUAL_RETURN_PRESENT",
      { order: { ...cleanSnapshot().order, actualReturnAt: "2026-08-29T00:00:00Z" } }
    ],
    [
      "VEHICLE_OTHER_ACTIVE_ORDER",
      { vehicle: { ...cleanSnapshot().vehicle, activeOtherOrders: [{ id: "other" }] } }
    ],
    [
      "VEHICLE_ACTIVE_RESTRICTION",
      { vehicle: { ...cleanSnapshot().vehicle, activeRestrictions: [{ id: "restriction" }] } }
    ],
    [
      "VEHICLE_SALE_PRICE_NOT_EFFECTIVE",
      { vehicle: { ...cleanSnapshot().vehicle, salePriceStatus: "PENDING_INITIALIZE" } }
    ]
  ];
  for (const [code, overrides] of cases) {
    assert.ok(classify(cleanSnapshot(overrides)).blockers.some((row) => row.code === code));
  }
});

test("evidence digest is deterministic and public output is credential safe", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const left = classify(cleanSnapshot());
  const right = classify(cleanSnapshot());
  assert.equal(left.evidenceDigest, right.evidenceDigest);
  assert.doesNotMatch(
    JSON.stringify(left),
    /objectKey|signedDocumentObjectKey|DATABASE_URL|mobile/
  );
});

test("recognizes only a complete matching four-audit replay", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const before = classify(cleanSnapshot());
  const terminal = terminalSnapshot(cleanSnapshot(), before.evidenceDigest);
  assert.equal(classify(terminal).disposition, "UNCHANGED");
  terminal.auditLogs.pop();
  assert.ok(classify(terminal).blockers.some(({ code }) => code === "RETIREMENT_AUDIT_MISMATCH"));
});

test("mixed initial and terminal states never auto-continue", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const input = cleanSnapshot();
  input.order.orderStatus = "CANCELLED";
  assert.ok(classify(input).blockers.some(({ code }) => code === "PARTIAL_RETIREMENT_STATE"));
});
```

Implement `terminalSnapshot` in the test by changing the four statuses, setting schedule cancellation fields, and adding four audit fixture rows that share one correlation ID, the fixed reason code, operator ID, and the candidate digest.

- [ ] **Step 2: Run the classifier tests and confirm RED**

Run:

```powershell
node --test scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs
```

Expected: parser tests remain green and classifier tests FAIL because the classifier is not exported.

- [ ] **Step 3: Implement canonical hashing and fail-closed classification**

Add to the core module:

```js
import { createHash } from "node:crypto";

const RETIREMENT_REASON = "STAGING_INVALID_TEST_DATA_RETIREMENT";
const TERMINAL = Object.freeze({
  billingSchedule: "CANCELLED",
  lease: "COMPLETED",
  order: "CANCELLED",
  vehicle: "AVAILABLE"
});

export function classifyStage1StagingInvalidTestOrderRetirement(snapshot = {}) {
  if (isTerminalTuple(snapshot)) {
    const replay = inspectRetirementAudits(snapshot.auditLogs);
    const blockers = [...inspectStableIdentityAndForbiddenFacts(snapshot), ...replay.blockers];
    const evidenceDigest = replay.evidenceDigest ?? digestEvidence(snapshot);
    return result(blockers.length === 0 ? "UNCHANGED" : "BLOCKED", blockers, null, evidenceDigest);
  }

  const blockers = inspectCandidateSnapshot(snapshot);
  const evidenceDigest = digestEvidence(snapshot);
  if (!isInitialTuple(snapshot) && touchesRetirementTuple(snapshot)) {
    blockers.push({ code: "PARTIAL_RETIREMENT_STATE" });
  }
  const disposition = blockers.length === 0 ? "CANDIDATE" : "BLOCKED";
  return result(
    disposition,
    blockers,
    disposition === "CANDIDATE" ? candidate(snapshot) : null,
    evidenceDigest
  );
}
```

Implement `digestEvidence` with recursively sorted object keys, sorted record arrays by `id`, ISO Date normalization, and BigInt string normalization. Hash only allowlisted state/identity fields and evidence reference IDs/statuses; exclude customer data, object keys, URLs, credentials, `auditLogs`, and volatile report timestamps. For terminal replay, retrieve the original candidate digest from the four audit snapshots and verify all four rows agree before comparing audit identity; do not hash terminal states and call that the original digest.

Define one stable blocker code for every prerequisite in spec section 6. Sort blockers by `code` and then `entityId`, so repeated classification serializes identically.

- [ ] **Step 4: Run the classifier tests and confirm GREEN**

Run:

```powershell
node --test scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs
```

Expected: all tests PASS and repeated runs produce the same digest.

- [ ] **Step 5: Commit the classifier**

Run:

```powershell
git add scripts/stage1-staging-invalid-test-order-retirement-core.mjs scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs
git commit -m "feat: classify invalid staging test order retirement"
```

Expected: the commit contains only deterministic classification and tests.

---

### Task 3: Add the Snapshot Loader and Zero-Write Dry-Run Executor

**Files:**

- Create: `scripts/stage1-staging-invalid-test-order-retirement-executor.mjs`
- Create: `scripts/stage1-staging-invalid-test-order-retirement-executor.test.mjs`

**Interfaces:**

- Consumes `classifyStage1StagingInvalidTestOrderRetirement` and the frozen target.
- Produces `loadStage1StagingInvalidTestOrderRetirementSnapshot(db, { operatorId })` in the Task 2 snapshot shape.
- Produces `executeStage1StagingInvalidTestOrderRetirement({ expectedEvidenceDigest, generatedAt, mode, operatorId, prisma })` returning `{ exitCode, report }`.
- Dry-run report is `{ applied: null, classification, generatedAt, mode: "dry-run", safeToApply }`.

- [ ] **Step 1: Write failing dry-run and loader-contract tests**

Create the executor test with import guards and a forbidden-write transaction client. Assert:

```js
test("dry-run uses RepeatableRead and performs zero writes", async () => {
  const calls = [];
  const tx = forbiddenWriteClient(calls);
  const prisma = {
    async $transaction(work, options) {
      assert.equal(options.isolationLevel, "RepeatableRead");
      return work(tx);
    }
  };
  const result = await required("executeStage1StagingInvalidTestOrderRetirement")({
    expectedEvidenceDigest: null,
    generatedAt: "2026-08-29T00:00:00.000Z",
    loadSnapshot: async () => cleanSnapshot(),
    mode: "dry-run",
    operatorId: "11111111-1111-4111-8111-111111111111",
    prisma
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.safeToApply, true);
  assert.equal(result.report.applied, null);
  assert.equal(calls.length, 0);
});

test("blocked dry-run returns nonzero without attempting writes", async () => {
  const input = cleanSnapshot();
  input.blockingCounts.receivableBills = 1;
  const result = await executeDryRun(input);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.safeToApply, false);
  assert.equal(result.report.classification.disposition, "BLOCKED");
});
```

Add a fake Prisma query recorder and assert the loader:

- queries the hard-coded order ID and vehicle ID rather than arbitrary CLI selectors;
- selects the operator's nondeleted role assignments and Role code/status/deletedAt;
- selects the target order, Lease, BillingSchedule, vehicle, VehicleDelivery, VehicleReturn, contracts, e-sign tasks, handovers and audit rows;
- computes every prohibited relation count from exact order/vehicle predicates;
- queries other active orders/leases and active operational restrictions for the vehicle;
- selects only fields needed by the classifier and orders evidence references by `id`.

- [ ] **Step 2: Run executor tests and confirm RED**

Run:

```powershell
node --test scripts/stage1-staging-invalid-test-order-retirement-executor.test.mjs
```

Expected: FAIL because executor exports do not exist.

- [ ] **Step 3: Implement the loader and dry-run executor**

Start the executor with:

```js
import {
  STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET as TARGET,
  classifyStage1StagingInvalidTestOrderRetirement
} from "./stage1-staging-invalid-test-order-retirement-core.mjs";
import { randomUUID } from "node:crypto";

const TRANSACTION_BASE = { maxWait: 10_000, timeout: 120_000 };

export async function executeStage1StagingInvalidTestOrderRetirement({
  classify = classifyStage1StagingInvalidTestOrderRetirement,
  expectedEvidenceDigest,
  generatedAt = new Date().toISOString(),
  loadSnapshot = loadStage1StagingInvalidTestOrderRetirementSnapshot,
  mode,
  now = () => new Date(),
  operatorId,
  prisma,
  randomUuid = randomUUID
}) {
  if (mode === "dry-run") {
    const classification = await prisma.$transaction(
      async (tx) => classify(await loadSnapshot(tx, { operatorId })),
      { ...TRANSACTION_BASE, isolationLevel: "RepeatableRead" }
    );
    const safeToApply = classification.disposition !== "BLOCKED";
    return {
      exitCode: safeToApply ? 0 : 1,
      report: { applied: null, classification, generatedAt, mode, safeToApply }
    };
  }
  if (mode !== "apply") {
    throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_MODE_INVALID");
  }
  return executeApply({
    classify,
    expectedEvidenceDigest,
    generatedAt,
    loadSnapshot,
    mode,
    now,
    operatorId,
    prisma,
    randomUuid
  });
}
```

Use exact `findUnique/findMany/count` calls scoped to `TARGET.orderId` and `TARGET.vehicleId`. Keep evidence rows restricted to IDs, identity links, lifecycle statuses, timestamps, and deletion flags. Do not select customer names/mobile, file object keys, signing URLs, contract snapshots, or raw handover evidence payloads.

- [ ] **Step 4: Run core and executor tests and confirm GREEN**

Run:

```powershell
node --test scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs scripts/stage1-staging-invalid-test-order-retirement-executor.test.mjs
```

Expected: all Task 1–3 tests PASS.

- [ ] **Step 5: Commit dry-run support**

Run:

```powershell
git add scripts/stage1-staging-invalid-test-order-retirement-executor.mjs scripts/stage1-staging-invalid-test-order-retirement-executor.test.mjs
git commit -m "feat: add staging retirement dry-run executor"
```

Expected: one independently reviewable dry-run commit.

---

### Task 4: Implement Atomic Apply, Audit, Rollback, and Replay

**Files:**

- Modify: `scripts/stage1-staging-invalid-test-order-retirement-executor.mjs`
- Modify: `scripts/stage1-staging-invalid-test-order-retirement-executor.test.mjs`

**Interfaces:**

- Extends the Task 3 executor's apply path; public signature does not change.
- Apply report is `{ auditsCreated, billingSchedulesUpdated, blocked, correlationId, leasesUpdated, ordersUpdated, skippedUnchanged, vehiclesUpdated }`.
- Produces no new database table or API interface.

- [ ] **Step 1: Add failing atomic-apply and conditional-update tests**

Add a stateful fake Prisma harness and these assertions:

```js
test("apply updates the four states and creates four correlated audits atomically", async () => {
  const harness = createApplyHarness();
  const dryRunDigest = classify(harness.snapshot()).evidenceDigest;
  const result = await execute({
    expectedEvidenceDigest: dryRunDigest,
    generatedAt: "2026-08-29T01:00:00.000Z",
    mode: "apply",
    operatorId: harness.operatorId,
    prisma: harness.prisma,
    randomUuid: () => "22222222-2222-4222-8222-222222222222"
  });
  assert.equal(harness.state.order.orderStatus, "CANCELLED");
  assert.equal(harness.state.lease.status, "COMPLETED");
  assert.equal(harness.state.billingSchedule.status, "CANCELLED");
  assert.equal(harness.state.vehicle.status, "AVAILABLE");
  assert.equal(harness.state.order.actualReturnAt, null);
  assert.equal(harness.state.audits.length, 4);
  assert.equal(new Set(harness.state.audits.map((a) => a.afterSnapshot.correlationId)).size, 1);
  assert.equal(result.report.applied.ordersUpdated, 1);
});

test("apply rejects a stale dry-run evidence digest before any update", async () => {
  const harness = createApplyHarness();
  await assert.rejects(
    execute({
      expectedEvidenceDigest: "0".repeat(64),
      mode: "apply",
      operatorId: harness.operatorId,
      prisma: harness.prisma
    }),
    /EVIDENCE_DIGEST_MISMATCH/
  );
  assert.equal(harness.state.audits.length, 0);
  assert.equal(harness.state.order.orderStatus, "ACTIVE");
});

test("a conditional update or audit failure rolls back all earlier writes", async () => {
  for (const failure of ["schedule", "lease", "order", "vehicle", "audit-4"]) {
    const harness = createApplyHarness({ failure });
    const digest = classify(harness.snapshot()).evidenceDigest;
    await assert.rejects(
      execute({
        expectedEvidenceDigest: digest,
        mode: "apply",
        operatorId: harness.operatorId,
        prisma: harness.prisma
      })
    );
    assert.deepEqual(harness.businessState(), harness.initialBusinessState());
    assert.equal(harness.state.audits.length, 0);
  }
});

test("serialized concurrent apply and replay commit once and audit once", async () => {
  const harness = createApplyHarness({ serializeTransactions: true });
  const digest = classify(harness.snapshot()).evidenceDigest;
  const input = {
    expectedEvidenceDigest: digest,
    mode: "apply",
    operatorId: harness.operatorId,
    prisma: harness.prisma
  };
  const [left, right] = await Promise.all([execute(input), execute(input)]);
  const replay = await execute(input);
  assert.deepEqual([left, right].map((x) => x.report.applied.ordersUpdated).sort(), [0, 1]);
  assert.equal(replay.report.applied.skippedUnchanged, 1);
  assert.equal(harness.state.audits.length, 4);
});
```

Also assert all update payloads leave contract/handover fields untouched, schedule `version` increments once, schedule `cancelledAt` uses the injected transaction time, `pauseReason` becomes `STAGING_INVALID_TEST_DATA_RETIREMENT`, and all four audit JSON objects are credential-safe.

- [ ] **Step 2: Run apply tests and confirm RED**

Run:

```powershell
node --test scripts/stage1-staging-invalid-test-order-retirement-executor.test.mjs
```

Expected: dry-run tests pass and new apply tests FAIL.

- [ ] **Step 3: Implement locking, reclassification, four conditional updates, and audit**

Implement apply with this control flow:

```js
const APPLY_LOCK_KEY = "stage1-staging-invalid-test-order-retirement:apply";
const RETIREMENT_REASON = "STAGING_INVALID_TEST_DATA_RETIREMENT";

async function executeApply(input) {
  const outcome = await input.prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", APPLY_LOCK_KEY);
      await lockTargetRows(tx);
      const snapshot = await input.loadSnapshot(tx, { operatorId: input.operatorId });
      const classification = input.classify(snapshot);
      if (classification.disposition === "BLOCKED") {
        return blockedOutcome(classification);
      }
      if (classification.evidenceDigest !== input.expectedEvidenceDigest) {
        throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_EVIDENCE_DIGEST_MISMATCH");
      }
      if (classification.disposition === "UNCHANGED") {
        return unchangedOutcome(classification);
      }

      const correlationId = input.randomUuid();
      const changedAt = input.now();
      await cancelSchedule(tx, snapshot, changedAt);
      await completeLease(tx, snapshot, input.operatorId);
      await cancelOrder(tx, snapshot, input.operatorId);
      await releaseVehicle(tx, snapshot, input.operatorId);
      await createAudits(tx, snapshot, {
        changedAt,
        correlationId,
        evidenceDigest: classification.evidenceDigest,
        operatorId: input.operatorId
      });
      await assertPostconditions(tx, { correlationId, operatorId: input.operatorId });
      return appliedOutcome(classification, correlationId);
    },
    { ...TRANSACTION_BASE, isolationLevel: "Serializable" }
  );
  return toPublicResult(outcome, input.generatedAt);
}
```

`lockTargetRows` must issue parameterized `SELECT ... FOR UPDATE` statements for the hard-coded order, Lease, BillingSchedule and vehicle in the stable order shown above. Every update uses `updateMany` with the original ID/status/deletedAt/identity predicate and calls `assertSingleUpdate`. The vehicle update directly permits only the hard-coded `LEASED` row after the classifier has verified effective positive sale price, zero current period, zero active restriction and zero other active order/lease.

Create four `AuditLog` rows with `module = "STAGE1_STAGING_TEST_DATA_RETIREMENT"`, `action = "UPDATE"`, entity types `billing_schedule`, `lease`, `subscription_order`, and `vehicle`, the same `operatorId`, and snapshots limited to entity ID/business number, before/after status, fixed reason, `correlationId`, `evidenceDigest`, and changed fields.

`assertPostconditions` must reload the four rows and count forbidden executable/occupancy records before allowing commit. It must verify `actualReturnAt` remains null and the vehicle has no nonterminal order other than the now-cancelled target.

- [ ] **Step 4: Run core and executor tests and confirm GREEN**

Run:

```powershell
node --test scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs scripts/stage1-staging-invalid-test-order-retirement-executor.test.mjs
```

Expected: all tests PASS, including injected rollback, concurrency, audit, and replay tests.

- [ ] **Step 5: Commit atomic apply**

Run:

```powershell
git add scripts/stage1-staging-invalid-test-order-retirement-executor.mjs scripts/stage1-staging-invalid-test-order-retirement-executor.test.mjs
git commit -m "feat: retire invalid staging order atomically"
```

Expected: one commit containing the complete transaction and no CLI/runtime changes.

---

### Task 5: Add the Credential-Safe CLI and Package Commands

**Files:**

- Create: `scripts/stage1-staging-invalid-test-order-retirement.mjs`
- Create: `scripts/stage1-staging-invalid-test-order-retirement.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes the Task 1 parser and Task 3/4 executor.
- Produces `assertStage1StagingInvalidTestOrderRetirementApplyEnvironment(mode, env)`.
- Produces `runStage1StagingInvalidTestOrderRetirementCli(dependencies)` and `runStage1StagingInvalidTestOrderRetirementProcess(dependencies)` for isolated tests.
- Produces root scripts `stage1:staging-invalid-test-order-retirement:dry-run`, `:apply`, and `:test`.

- [ ] **Step 1: Write failing environment, output-order, redaction, and package-script tests**

Create the CLI test with:

```js
test("apply requires staging and the exact narrowly named confirmation", () => {
  const validate = required("assertStage1StagingInvalidTestOrderRetirementApplyEnvironment");
  assert.doesNotThrow(() => validate("dry-run", {}));
  assert.doesNotThrow(() =>
    validate("apply", {
      DEPLOYMENT_ENV: "staging",
      STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY: "1"
    })
  );
  for (const env of [
    {},
    { DEPLOYMENT_ENV: "production", STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY: "1" },
    { APP_ENV: "staging", STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_APPLY: "true" }
  ]) {
    assert.throws(() => validate("apply", env), /RETIREMENT_(STAGING|APPLY_CONFIRMATION)_REQUIRED/);
  }
});

test("target mismatch fails before Prisma creation", async () => {
  let prismaCreated = false;
  await assert.rejects(
    runCli({
      args: dryRunArgs({ orderNo: "ORD-WRONG" }),
      createPrisma: async () => {
        prismaCreated = true;
        return {};
      }
    }),
    /TARGET_MISMATCH/
  );
  assert.equal(prismaCreated, false);
});

test("CLI awaits stdout before writing the optional report", async () => {
  const events = [];
  let releaseStdout;
  const pending = runCli({
    args: dryRunArgs(),
    createPrisma: async () => ({ marker: "prisma" }),
    execute: async () => ({ exitCode: 0, report: { safeToApply: true } }),
    writeStdout: () =>
      new Promise((resolve) => {
        releaseStdout = () => {
          events.push("stdout");
          resolve();
        };
      }),
    writeOutput: async () => events.push("output")
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  releaseStdout();
  await pending;
  assert.deepEqual(events, ["stdout", "output"]);
});

test("process errors expose one stable credential-safe JSON object", async () => {
  const stderr = [];
  const exitCode = await runProcess({
    disconnect: async () => {
      throw new Error("postgresql://secret:password@host/db");
    },
    run: async () => {
      throw new Error("signedDocumentObjectKey=secret.pdf");
    },
    writeStderr: (value) => stderr.push(value)
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stderr[0]), {
    error: "STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_FAILED"
  });
  assert.doesNotMatch(stderr.join(""), /password|postgresql|secret\.pdf/);
});
```

Read `package.json` in the test and assert the three commands point to the exact entry file and three test files.

- [ ] **Step 2: Run CLI tests and confirm RED**

Run:

```powershell
node --test scripts/stage1-staging-invalid-test-order-retirement.test.mjs
```

Expected: FAIL because CLI exports and package scripts do not exist.

- [ ] **Step 3: Implement the CLI wrapper and package scripts**

Follow the existing source-facts CLI dependency-injection pattern. Validate arguments and target before `createPrisma()`, then validate apply environment, call the executor with parsed `expectedEvidenceDigest`, `operatorId`, and mode, await stdout, then write optional output.

Use this exact public error:

```js
export function stage1StagingInvalidTestOrderRetirementPublicError() {
  return { error: "STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_FAILED" };
}
```

Add to `package.json`:

```json
"stage1:staging-invalid-test-order-retirement:dry-run": "node scripts/stage1-staging-invalid-test-order-retirement.mjs --dry-run",
"stage1:staging-invalid-test-order-retirement:apply": "node scripts/stage1-staging-invalid-test-order-retirement.mjs --apply",
"stage1:staging-invalid-test-order-retirement:test": "node --test scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs scripts/stage1-staging-invalid-test-order-retirement-executor.test.mjs scripts/stage1-staging-invalid-test-order-retirement.test.mjs"
```

Create Prisma through `createRequire(resolve(repoRoot, "apps/api/package.json"))`, `@prisma/adapter-pg`, and `@prisma/client`. Require `DATABASE_URL`, normalize only localhost to `127.0.0.1`, load root and API `.env` files quietly, and always disconnect in the process wrapper.

- [ ] **Step 4: Run the dedicated command and confirm GREEN**

Run:

```powershell
pnpm stage1:staging-invalid-test-order-retirement:test
```

Expected: all core, executor, and CLI tests PASS without a database connection.

- [ ] **Step 5: Commit CLI and package commands**

Run:

```powershell
git add package.json scripts/stage1-staging-invalid-test-order-retirement.mjs scripts/stage1-staging-invalid-test-order-retirement.test.mjs
git commit -m "feat: expose staging retirement CLI"
```

Expected: one commit with no Docker changes.

---

### Task 6: Package the Tool in the API Runtime Image

**Files:**

- Modify: `Dockerfile.api`
- Modify: `apps/api/test/api-runtime-media.spec.ts`

**Interfaces:**

- Consumes the three script files from Tasks 1–5.
- Produces an API runtime image containing the core, executor, and CLI entry at `/app/scripts/`.

- [ ] **Step 1: Extend the runtime contract test first**

Add these file names to the existing `packages the Stage 1 contract-change release tooling` array in `apps/api/test/api-runtime-media.spec.ts`:

```ts
"stage1-staging-invalid-test-order-retirement-core.mjs",
"stage1-staging-invalid-test-order-retirement-executor.mjs",
"stage1-staging-invalid-test-order-retirement.mjs",
```

- [ ] **Step 2: Run the focused Vitest and confirm RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/api-runtime-media.spec.ts
```

Expected: FAIL listing the first missing Dockerfile `COPY` contract.

- [ ] **Step 3: Add the three runtime copies**

Add next to the existing Stage 1 repair tool copies in `Dockerfile.api`:

```dockerfile
COPY --from=build /app/scripts/stage1-staging-invalid-test-order-retirement-core.mjs ./scripts/stage1-staging-invalid-test-order-retirement-core.mjs
COPY --from=build /app/scripts/stage1-staging-invalid-test-order-retirement-executor.mjs ./scripts/stage1-staging-invalid-test-order-retirement-executor.mjs
COPY --from=build /app/scripts/stage1-staging-invalid-test-order-retirement.mjs ./scripts/stage1-staging-invalid-test-order-retirement.mjs
```

Do not change the npm registry, apt mirror, base image, or unrelated Docker instructions.

- [ ] **Step 4: Run the focused Vitest and dedicated CLI suite**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/api-runtime-media.spec.ts
pnpm stage1:staging-invalid-test-order-retirement:test
```

Expected: both commands PASS.

- [ ] **Step 5: Commit runtime packaging**

Run:

```powershell
git add Dockerfile.api apps/api/test/api-runtime-media.spec.ts
git commit -m "build: package staging retirement tooling"
```

Expected: one small Docker/runtime-test commit.

---

### Task 7: Verify the Complete Change and Prepare the Operational Handoff

**Files:**

- Modify only if verification exposes a defect: the exact source or test file responsible for that defect
- Verify: `docs/superpowers/specs/2026-08-29-stage1-staging-invalid-test-order-retirement-design.zh-CN.md`
- Verify: `docs/superpowers/plans/2026-08-29-stage1-staging-invalid-test-order-retirement-implementation-plan.md`

**Interfaces:**

- Consumes the completed CLI and runtime packaging.
- Produces a clean branch, reproducible verification evidence, and commands for a later separately approved Staging dry-run.

- [ ] **Step 1: Run focused regression suites**

Run:

```powershell
pnpm stage1:staging-invalid-test-order-retirement:test
pnpm stage1:active-source-facts:test
node --test scripts/subscription-segment-bootstrap-core.test.mjs scripts/subscription-segment-bootstrap-apply.test.mjs
node --test scripts/stage1c-period-backfill-core.test.mjs scripts/stage1c-period-backfill-executor.test.mjs
pnpm stage1:contract-change:bootstrap:test
pnpm --filter @subscription-saas/api exec vitest run test/api-runtime-media.spec.ts test/vehicle-availability.spec.ts
```

Expected: every suite PASS; no command contacts Staging.

- [ ] **Step 2: Run schema, formatting, static, and build gates**

Run:

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm prisma:validate
pnpm prisma:generate
pnpm format:check
pnpm -r lint
pnpm -r typecheck
pnpm -r build
```

Expected: migration status clean and every command exits 0.

- [ ] **Step 3: Run API/Web full tests**

Run:

```powershell
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
```

Expected: both full suites PASS. If a pre-existing unrelated failure appears, capture the exact failing test and prove it also fails on `origin/main` before classifying it as baseline.

- [ ] **Step 4: Check the final diff and repository state**

Run:

```powershell
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline --decorate origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected: no whitespace errors, no uncommitted files, and only the approved spec, plan, three script files, three test files, `package.json`, `Dockerfile.api`, and runtime-media test differ from `origin/main`.

- [ ] **Step 5: Perform the spec-coverage audit**

Confirm from tests and diff that:

```text
hard-coded one-order allowlist
strict Staging/apply gate
active ADMIN operator validation
dry-run digest required by apply
zero-write dry-run
Serializable single transaction
four conditional state changes
four correlated credential-safe audits
no actualReturnAt or evidence mutation
blocked partial state
zero-write replay
API runtime packaging
no migration, API route, or UI
```

Expected: every line maps to at least one automated test and one implementation path.

- [ ] **Step 6: Commit any verification-only correction and re-run its failed gate**

If verification required a correction, use a narrowly scoped commit:

```powershell
git add -- Dockerfile.api package.json apps/api/test/api-runtime-media.spec.ts scripts/stage1-staging-invalid-test-order-retirement-core.mjs scripts/stage1-staging-invalid-test-order-retirement-core.test.mjs scripts/stage1-staging-invalid-test-order-retirement-executor.mjs scripts/stage1-staging-invalid-test-order-retirement-executor.test.mjs scripts/stage1-staging-invalid-test-order-retirement.mjs scripts/stage1-staging-invalid-test-order-retirement.test.mjs
git commit -m "fix: close staging retirement verification gap"
```

Expected: no empty commit. Re-run the focused failing test plus Steps 1–4 after the correction.

- [ ] **Step 7: Prepare but do not execute the Staging dry-run command**

After the branch is merged and a new API image is deployed, the operational command will have this shape:

```powershell
$approvedOperatorId = Read-Host '输入本次已批准的 ACTIVE ADMIN 用户 UUID'
$releaseReportDirectory = '/opt/subscription-saas/reports/stage1-invalid-test-order-retirement-20260829'
pnpm stage1:staging-invalid-test-order-retirement:dry-run -- `
  --order-id c392fa54-4784-4e04-ad4a-bfe2fd7e2d10 `
  --order-no ORD20260726073922TFHF `
  --vehicle-id 70565059-1841-4c97-a32c-7bd09ce0b90f `
  --vehicle-no VEH20260713140950K4BT `
  --vin TESTVINET50000001 `
  --operator-id $approvedOperatorId `
  --output "$releaseReportDirectory/stage1-staging-invalid-test-order-retirement-dry-run.json"
```

Expected: this command remains documentation only during implementation. Do not substitute an operator UUID or run it until the user separately approves the deployed Staging dry-run.

---

## Execution Notes

- Use `superpowers:test-driven-development` for every implementation task: observe RED before adding production code and GREEN after the minimal implementation.
- Use `superpowers:verification-before-completion` before claiming the branch is ready.
- Keep each task's commit boundary. Do not squash locally while review is ongoing.
- This plan intentionally stops before Staging data mutation. Deployment, dry-run, backup verification, apply approval, apply/replay, and the later e-sign/source-facts/BASE/Stage 1C sequence are operational checkpoints outside the implementation PR.
