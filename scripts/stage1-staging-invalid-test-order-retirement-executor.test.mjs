import assert from "node:assert/strict";
import test from "node:test";

import {
  STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET as TARGET,
  classifyStage1StagingInvalidTestOrderRetirement as classify
} from "./stage1-staging-invalid-test-order-retirement-core.mjs";

const executor = await import("./stage1-staging-invalid-test-order-retirement-executor.mjs").catch(
  () => ({})
);
const operatorId = "11111111-1111-4111-8111-111111111111";

function required(name) {
  assert.equal(typeof executor[name], "function", `${name} must be exported`);
  return executor[name];
}

test("dry-run uses RepeatableRead and performs zero writes", async () => {
  const calls = [];
  const tx = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`unexpected transaction access: ${String(property)}`);
      }
    }
  );
  const prisma = {
    async $transaction(work, options) {
      calls.push(["transaction", options]);
      return work(tx);
    }
  };

  const result = await required("executeStage1StagingInvalidTestOrderRetirement")({
    expectedEvidenceDigest: null,
    generatedAt: "2026-08-29T00:00:00.000Z",
    loadSnapshot: async (db, input) => {
      assert.equal(db, tx);
      assert.deepEqual(input, { operatorId });
      return cleanSnapshot();
    },
    mode: "dry-run",
    operatorId,
    prisma
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.safeToApply, true);
  assert.equal(result.report.applied, null);
  assert.equal(result.report.classification.disposition, "CANDIDATE");
  assert.equal(result.report.generatedAt, "2026-08-29T00:00:00.000Z");
  assert.deepEqual(calls, [
    ["transaction", { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 120_000 }]
  ]);
});

test("blocked dry-run returns nonzero without attempting writes", async () => {
  const snapshot = cleanSnapshot();
  snapshot.blockingCounts.receivableBills = 1;
  const result = await executeDryRun(snapshot);

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.safeToApply, false);
  assert.equal(result.report.classification.disposition, "BLOCKED");
  assert.ok(
    result.report.classification.blockers.some(({ relation }) => relation === "receivableBills")
  );
});

test("executor rejects unknown modes", async () => {
  await assert.rejects(
    required("executeStage1StagingInvalidTestOrderRetirement")({
      expectedEvidenceDigest: null,
      mode: "preview",
      operatorId,
      prisma: {}
    }),
    /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_MODE_INVALID/
  );
});

test("snapshot loader reads only the hard-coded target and classifier facts", async () => {
  const { calls, db, maxConcurrentReads } = snapshotDatabase();
  const snapshot = await required("loadStage1StagingInvalidTestOrderRetirementSnapshot")(db, {
    operatorId
  });

  assert.equal(snapshot.order.id, TARGET.orderId);
  assert.equal(snapshot.vehicle.id, TARGET.vehicleId);
  assert.equal(snapshot.operator.id, operatorId);
  assert.deepEqual(snapshot.vehicle.activeOtherOrders, []);
  assert.deepEqual(snapshot.vehicle.activeOtherLeases, []);
  assert.deepEqual(snapshot.vehicle.activeRestrictions, []);
  assert.deepEqual(snapshot.vehicle.activeSubscriptionPeriods, []);
  assert.deepEqual(snapshot.evidenceReferences.handoverWorkflowJobs, [
    {
      eSignTaskId: "00000000-0000-4000-8000-000000000003",
      handoverId: "bfc5a943-0000-4000-8000-000000000000",
      id: "00000000-0000-4000-8000-000000000004",
      jobStatus: "COMPLETED",
      workOrderId: "00000000-0000-4000-8000-000000000005"
    }
  ]);
  assert.deepEqual(
    snapshot.evidenceReferences.fileObjects,
    cleanSnapshot().evidenceReferences.fileObjects
  );
  assert.deepEqual(
    snapshot.evidenceReferences.evidenceFiles,
    cleanSnapshot().evidenceReferences.evidenceFiles
  );
  assert.deepEqual(snapshot.blockingCounts, emptyBlockingCounts());
  assert.deepEqual(snapshot.journey, cleanSnapshot().journey);

  const orderRead = calls.find(
    ([model, method]) => model === "subscriptionOrder" && method === "findUnique"
  );
  assert.deepEqual(orderRead[2].where, { id: TARGET.orderId });
  const vehicleRead = calls.find(
    ([model, method]) => model === "vehicle" && method === "findUnique"
  );
  assert.deepEqual(vehicleRead[2].where, { id: TARGET.vehicleId });
  const otherLeaseRead = calls.find(
    ([model, method]) => model === "lease" && method === "findMany"
  );
  assert.deepEqual(otherLeaseRead[2].where.status, { not: "COMPLETED" });
  const activePeriodRead = calls.find(
    ([model, method]) => model === "vehicleSubscriptionPeriod" && method === "findMany"
  );
  assert.deepEqual(activePeriodRead[2].where, {
    endedAt: null,
    vehicleId: TARGET.vehicleId
  });
  const userRead = calls.find(([model, method]) => model === "user" && method === "findUnique");
  assert.deepEqual(userRead[2].where, { id: operatorId });
  const journeyRead = calls.find(
    ([model, method]) => model === "subscriptionJourney" && method === "findUnique"
  );
  assert.deepEqual(journeyRead[2].where, { orderId: TARGET.orderId });
  assert.equal(journeyRead[2].select.jobs.select.payload, undefined);
  assert.equal(journeyRead[2].select.outboxRows.select.payload, undefined);
  const evidenceFileRead = calls.find(
    ([model, method]) => model === "vehicleDeliveryEvidenceFile" && method === "findMany"
  );
  assert.deepEqual(evidenceFileRead[2].where, {
    evidenceItemId: { in: ["00000000-0000-4000-8000-000000000006"] }
  });
  const fileObjectRead = calls.find(
    ([model, method]) => model === "fileObject" && method === "findMany"
  );
  assert.deepEqual(fileObjectRead[2].where, {
    id: {
      in: ["00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000013"]
    }
  });
  assert.equal(fileObjectRead[2].select.objectKey, undefined);
  assert.equal(maxConcurrentReads(), 1);

  const serializedQueries = JSON.stringify(calls);
  assert.doesNotMatch(
    serializedQueries,
    /mobile|passwordHash|objectKey|signedObjectKey|accessToken|requestSnapshot|responseSnapshot|payload/
  );
  assert.equal(calls.filter(([, method]) => method === "count").length, 29);
});

test("loader scopes prohibited counts to the order and asset work orders to order or vehicle", async () => {
  const { calls, db } = snapshotDatabase();
  await required("loadStage1StagingInvalidTestOrderRetirementSnapshot")(db, { operatorId });

  for (const [model, method, query] of calls.filter(([, method]) => method === "count")) {
    if (model === "assetWorkOrder") {
      assert.deepEqual(query.where, {
        OR: [{ orderId: TARGET.orderId }, { vehicleId: TARGET.vehicleId }]
      });
    } else {
      assert.equal(query.where.orderId, TARGET.orderId, model);
    }
  }
});

test("apply updates four states and creates four correlated audits atomically", async () => {
  const harness = createApplyHarness();
  const evidenceDigest = classify(harness.snapshot()).evidenceDigest;
  const correlationId = "22222222-2222-4222-8222-222222222222";
  const changedAt = new Date("2026-08-29T01:00:00.000Z");

  const result = await executeApply(harness, {
    evidenceDigest,
    now: () => changedAt,
    randomUuid: () => correlationId
  });

  assert.equal(harness.state.order.orderStatus, "CANCELLED");
  assert.equal(harness.state.lease.status, "COMPLETED");
  assert.equal(harness.state.billingSchedule.status, "CANCELLED");
  assert.equal(harness.state.billingSchedule.version, 1);
  assert.equal(harness.state.billingSchedule.cancelledAt.toISOString(), changedAt.toISOString());
  assert.equal(harness.state.billingSchedule.pauseReason, "STAGING_INVALID_TEST_DATA_RETIREMENT");
  assert.equal(harness.state.vehicle.status, "AVAILABLE");
  assert.equal(harness.state.order.actualReturnAt, null);
  assert.equal(harness.state.order.actualDeliveryAt.toISOString(), "2026-07-31T03:01:04.000Z");
  assert.equal(harness.state.auditLogs.length, 4);
  assert.ok(harness.calls.includes("database.identity"));
  assert.ok(harness.calls.includes("relations.lock"));
  const relationLock = harness.calls.find((call) => call.startsWith("LOCK TABLE"));
  for (const relation of [
    '"user"',
    '"user_role"',
    '"role"',
    '"subscription_journey"',
    '"subscription_journey_step"',
    '"subscription_journey_job"',
    '"subscription_journey_manual_task"',
    '"subscription_journey_event"',
    '"subscription_journey_exception"',
    '"subscription_journey_outbox"'
  ]) {
    assert.match(relationLock, new RegExp(relation));
  }
  assert.deepEqual(
    [...new Set(harness.state.auditLogs.map(({ afterSnapshot }) => afterSnapshot.correlationId))],
    [correlationId]
  );
  assert.deepEqual(result.report.applied, {
    auditsCreated: 4,
    billingSchedulesUpdated: 1,
    blocked: false,
    correlationId,
    leasesUpdated: 1,
    ordersUpdated: 1,
    skippedUnchanged: 0,
    vehiclesUpdated: 1
  });
  assert.equal(result.exitCode, 0);

  const audits = JSON.stringify(harness.state.auditLogs);
  assert.doesNotMatch(audits, /objectKey|signedDocumentObjectKey|DATABASE_URL|private\//);
  assert.match(audits, /STAGING_INVALID_TEST_DATA_RETIREMENT/);
  assert.match(audits, new RegExp(evidenceDigest));
});

test("apply returns a Prisma-deserializable boolean advisory lock row", async () => {
  const harness = createApplyHarness();
  const evidenceDigest = classify(harness.snapshot()).evidenceDigest;

  await executeApply(harness, { evidenceDigest });

  assert.equal(harness.advisoryLockQueries.length, 1);
  assert.match(harness.advisoryLockQueries[0], /SELECT TRUE AS locked FROM pg_advisory_xact_lock/);
});

test("blocked apply locks and reclassifies but performs zero business writes", async () => {
  const harness = createApplyHarness();
  harness.state.blockingCounts.receivableBills = 1;
  const result = await executeApply(harness, { evidenceDigest: "a".repeat(64) });

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.safeToApply, false);
  assert.deepEqual(result.report.applied, {
    auditsCreated: 0,
    billingSchedulesUpdated: 0,
    blocked: true,
    correlationId: null,
    leasesUpdated: 0,
    ordersUpdated: 0,
    skippedUnchanged: 0,
    vehiclesUpdated: 0
  });
  assert.equal(harness.calls.filter((call) => call.endsWith("updateMany")).length, 0);
  assert.equal(harness.state.auditLogs.length, 0);
});

test("apply rejects a non-staging database before relation locks or business writes", async () => {
  const harness = createApplyHarness({ databaseName: "subscription_saas_prod" });
  await assert.rejects(
    executeApply(harness),
    /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_DATABASE_IDENTITY_MISMATCH/
  );

  assert.ok(harness.calls.includes("database.identity"));
  assert.equal(harness.calls.includes("relations.lock"), false);
  assert.equal(
    harness.calls.some((call) => call.endsWith("updateMany")),
    false
  );
  assert.deepEqual(harness.state.order.orderStatus, "ACTIVE");
});

test("apply rejects a stale dry-run evidence digest before any update", async () => {
  const harness = createApplyHarness();
  await assert.rejects(
    executeApply(harness, { evidenceDigest: "0".repeat(64) }),
    /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_EVIDENCE_DIGEST_MISMATCH/
  );

  assert.equal(harness.state.order.orderStatus, "ACTIVE");
  assert.equal(harness.state.lease.status, "ACTIVE");
  assert.equal(harness.state.billingSchedule.status, "PAUSED");
  assert.equal(harness.state.vehicle.status, "LEASED");
  assert.equal(harness.state.auditLogs.length, 0);
  assert.ok(harness.calls.includes("transaction.rollback"));
});

test("each conditional update or audit failure rolls back every earlier write", async () => {
  for (const failure of ["schedule", "lease", "order", "vehicle", "audit-4"]) {
    const harness = createApplyHarness({ failure });
    const initial = harness.businessState();
    const evidenceDigest = classify(harness.snapshot()).evidenceDigest;

    await assert.rejects(executeApply(harness, { evidenceDigest }), undefined, failure);

    assert.deepEqual(harness.businessState(), initial, failure);
    assert.equal(harness.state.auditLogs.length, 0, failure);
    assert.ok(harness.calls.includes("transaction.rollback"), failure);
  }
});

test("serialized concurrent apply and replay commit once and audit once", async () => {
  const harness = createApplyHarness({ serializeTransactions: true });
  const evidenceDigest = classify(harness.snapshot()).evidenceDigest;
  const input = { evidenceDigest };

  const [left, right] = await Promise.all([
    executeApply(harness, input),
    executeApply(harness, input)
  ]);
  const replay = await executeApply(harness, input);

  assert.deepEqual([left, right].map(({ report }) => report.applied.ordersUpdated).sort(), [0, 1]);
  assert.equal(replay.report.applied.skippedUnchanged, 1);
  assert.equal(replay.report.applied.ordersUpdated, 0);
  assert.equal(harness.state.auditLogs.length, 4);
  assert.equal(harness.calls.filter((call) => call === "advisory.lock").length, 3);
});

test("apply refuses a partial retirement state instead of continuing it", async () => {
  const harness = createApplyHarness();
  harness.state.order.orderStatus = "CANCELLED";
  const result = await executeApply(harness, { evidenceDigest: "a".repeat(64) });

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.applied.blocked, true);
  assert.ok(
    result.report.classification.blockers.some(({ code }) => code === "PARTIAL_RETIREMENT_STATE")
  );
  assert.equal(harness.state.lease.status, "ACTIVE");
  assert.equal(harness.state.auditLogs.length, 0);
});

async function executeDryRun(snapshot) {
  const execute = required("executeStage1StagingInvalidTestOrderRetirement");
  return execute({
    expectedEvidenceDigest: null,
    loadSnapshot: async () => snapshot,
    mode: "dry-run",
    operatorId,
    prisma: { $transaction: (work) => work({}) }
  });
}

async function executeApply(harness, overrides = {}) {
  const execute = required("executeStage1StagingInvalidTestOrderRetirement");
  return execute({
    expectedEvidenceDigest: overrides.evidenceDigest ?? classify(harness.snapshot()).evidenceDigest,
    generatedAt: "2026-08-29T01:00:00.000Z",
    loadSnapshot: async () => harness.snapshot(),
    mode: "apply",
    now: overrides.now ?? (() => new Date("2026-08-29T01:00:00.000Z")),
    operatorId,
    prisma: harness.prisma,
    randomUuid: overrides.randomUuid ?? (() => "22222222-2222-4222-8222-222222222222")
  });
}

function createApplyHarness({
  databaseName = "subscription_saas_staging",
  failure = null,
  serializeTransactions = false
} = {}) {
  const state = cleanSnapshot();
  const advisoryLockQueries = [];
  const calls = [];
  let auditAttempts = 0;
  let tail = Promise.resolve();

  async function run(work, options) {
    assert.deepEqual(options, {
      isolationLevel: "Serializable",
      maxWait: 10_000,
      timeout: 120_000
    });
    const previous = tail;
    let release;
    if (serializeTransactions) {
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
    }
    const before = structuredClone(state);
    calls.push("transaction.begin");
    const tx = {
      $queryRawUnsafe: async (query) => {
        if (query.includes("current_database()")) {
          calls.push("database.identity");
          return [{ databaseName }];
        }
        if (query.startsWith("LOCK TABLE")) {
          calls.push("relations.lock", query);
        } else if (query.includes("pg_advisory_xact_lock")) {
          advisoryLockQueries.push(query);
          calls.push("advisory.lock");
          return [{ locked: true }];
        } else if (query.includes("FOR UPDATE")) calls.push("row.lock");
        else throw new Error(`UNEXPECTED_LOCK_QUERY:${query}`);
        return [];
      },
      auditLog: {
        create: async ({ data }) => {
          auditAttempts += 1;
          if (failure === `audit-${auditAttempts}`) throw new Error("INJECTED_AUDIT_FAILURE");
          state.auditLogs.push(structuredClone(data));
          calls.push("audit.create");
          return data;
        }
      },
      billingSchedule: {
        updateMany: async ({ data, where }) => {
          if (failure === "schedule" || !matchesSchedule(state.billingSchedule, where)) {
            return { count: 0 };
          }
          applyData(state.billingSchedule, data);
          calls.push("billingSchedule.updateMany");
          return { count: 1 };
        }
      },
      lease: {
        updateMany: async ({ data, where }) => {
          if (failure === "lease" || !matchesLease(state.lease, where)) return { count: 0 };
          applyData(state.lease, data);
          calls.push("lease.updateMany");
          return { count: 1 };
        }
      },
      subscriptionOrder: {
        updateMany: async ({ data, where }) => {
          if (failure === "order" || !matchesOrder(state.order, where)) return { count: 0 };
          applyData(state.order, data);
          calls.push("subscriptionOrder.updateMany");
          return { count: 1 };
        }
      },
      vehicle: {
        updateMany: async ({ data, where }) => {
          if (failure === "vehicle" || !matchesVehicle(state.vehicle, where)) return { count: 0 };
          applyData(state.vehicle, data);
          calls.push("vehicle.updateMany");
          return { count: 1 };
        }
      }
    };
    try {
      const result = await work(tx);
      calls.push("transaction.commit");
      return result;
    } catch (error) {
      replaceObject(state, before);
      calls.push("transaction.rollback");
      throw error;
    } finally {
      release?.();
    }
  }

  return {
    advisoryLockQueries,
    businessState: () => ({
      billingSchedule: structuredClone(state.billingSchedule),
      lease: structuredClone(state.lease),
      order: structuredClone(state.order),
      vehicle: structuredClone(state.vehicle)
    }),
    calls,
    prisma: { $transaction: run },
    snapshot: () => structuredClone(state),
    state
  };
}

function matchesSchedule(record, where) {
  return (
    record.cancelledAt === where.cancelledAt &&
    record.id === where.id &&
    record.lastGeneratedBillId === where.lastGeneratedBillId &&
    record.orderId === where.orderId &&
    record.status === where.status &&
    record.version === where.version
  );
}

function matchesLease(record, where) {
  return (
    record.deletedAt === where.deletedAt &&
    record.id === where.id &&
    record.orderId === where.orderId &&
    record.status === where.status
  );
}

function matchesOrder(record, where) {
  return (
    record.actualReturnAt === where.actualReturnAt &&
    record.deletedAt === where.deletedAt &&
    record.id === where.id &&
    record.orderNo === where.orderNo &&
    record.orderStatus === where.orderStatus &&
    record.vehicleId === where.vehicleId
  );
}

function matchesVehicle(record, where) {
  return (
    record.currentSalePriceAmount === where.currentSalePriceAmount &&
    record.deletedAt === where.deletedAt &&
    record.id === where.id &&
    record.salePriceStatus === where.salePriceStatus &&
    record.status === where.status &&
    record.vehicleNo === where.vehicleNo &&
    record.vin === where.vin
  );
}

function applyData(record, data) {
  for (const [field, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in value) {
      record[field] += value.increment;
    } else {
      record[field] = structuredClone(value);
    }
  }
}

function replaceObject(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, structuredClone(source));
}

function snapshotDatabase() {
  const calls = [];
  let activeReads = 0;
  let maximumConcurrentReads = 0;
  const read = async (operation) => {
    activeReads += 1;
    maximumConcurrentReads = Math.max(maximumConcurrentReads, activeReads);
    try {
      await Promise.resolve();
      return operation();
    } finally {
      activeReads -= 1;
    }
  };
  const record = (model, method, result) => async (query) => {
    return read(() => {
      calls.push([model, method, query]);
      return structuredClone(result);
    });
  };
  const count = (model) => async (query) => {
    return read(() => {
      calls.push([model, "count", query]);
      return 0;
    });
  };
  const db = {
    assetWorkOrder: { count: count("assetWorkOrder") },
    auditLog: {
      findMany: record("auditLog", "findMany", [])
    },
    billingSchedule: {
      findUnique: record("billingSchedule", "findUnique", cleanSnapshot().billingSchedule)
    },
    collectionAction: { count: count("collectionAction") },
    collectionCase: { count: count("collectionCase") },
    collectionCaseBill: { count: count("collectionCaseBill") },
    contract: {
      findMany: record("contract", "findMany", cleanSnapshot().evidenceReferences.contracts)
    },
    contractESignTask: {
      findMany: record(
        "contractESignTask",
        "findMany",
        cleanSnapshot().evidenceReferences.eSignTasks
      )
    },
    debitAttempt: { count: count("debitAttempt") },
    depositLedger: { count: count("depositLedger") },
    fileObject: {
      findMany: record("fileObject", "findMany", cleanSnapshot().evidenceReferences.fileObjects)
    },
    insuranceClaim: { count: count("insuranceClaim") },
    lease: {
      findMany: record("lease", "findMany", []),
      findUnique: record("lease", "findUnique", cleanSnapshot().lease)
    },
    orderChange: { count: count("orderChange") },
    orderEntitlementAccount: { count: count("orderEntitlementAccount") },
    orderEntitlementGrant: { count: count("orderEntitlementGrant") },
    orderEntitlementUsage: { count: count("orderEntitlementUsage") },
    orderMileageReview: { count: count("orderMileageReview") },
    paymentMandate: { count: count("paymentMandate") },
    paymentOrder: { count: count("paymentOrder") },
    paymentRecord: { count: count("paymentRecord") },
    paymentWriteOff: { count: count("paymentWriteOff") },
    receivableBill: { count: count("receivableBill") },
    renewalConsideration: { count: count("renewalConsideration") },
    revenueRightAssignment: { count: count("revenueRightAssignment") },
    serviceCase: { count: count("serviceCase") },
    subscriptionAutomationJob: { count: count("subscriptionAutomationJob") },
    subscriptionChangeOrder: { count: count("subscriptionChangeOrder") },
    subscriptionClosureCase: { count: count("subscriptionClosureCase") },
    subscriptionContractSegment: { count: count("subscriptionContractSegment") },
    subscriptionJourney: {
      findUnique: record("subscriptionJourney", "findUnique", cleanSnapshot().journey)
    },
    subscriptionOrder: {
      findMany: record("subscriptionOrder", "findMany", []),
      findUnique: record("subscriptionOrder", "findUnique", cleanSnapshot().order)
    },
    user: {
      findUnique: record("user", "findUnique", {
        ...cleanSnapshot().operator,
        roles: [
          {
            deletedAt: null,
            role: { code: "ADMIN", deletedAt: null, status: "ACTIVE" }
          }
        ]
      })
    },
    vehicle: {
      findUnique: record("vehicle", "findUnique", cleanSnapshot().vehicle)
    },
    vehicleCostLedgerEntry: { count: count("vehicleCostLedgerEntry") },
    vehicleDelivery: {
      findMany: record("vehicleDelivery", "findMany", [])
    },
    vehicleDeliveryEvidenceFile: {
      findMany: record(
        "vehicleDeliveryEvidenceFile",
        "findMany",
        cleanSnapshot().evidenceReferences.evidenceFiles
      )
    },
    vehicleDeliveryEvidenceItem: {
      findMany: record(
        "vehicleDeliveryEvidenceItem",
        "findMany",
        cleanSnapshot().evidenceReferences.evidenceItems
      )
    },
    vehicleDeliveryHandover: {
      findMany: record(
        "vehicleDeliveryHandover",
        "findMany",
        cleanSnapshot().evidenceReferences.handovers
      )
    },
    vehicleHandoverWorkOrder: {
      findMany: record(
        "vehicleHandoverWorkOrder",
        "findMany",
        cleanSnapshot().evidenceReferences.handoverWorkOrders
      )
    },
    vehicleHandoverWorkflowJob: {
      findMany: record(
        "vehicleHandoverWorkflowJob",
        "findMany",
        cleanSnapshot().evidenceReferences.handoverWorkflowJobs
      )
    },
    vehicleMileageReading: { count: count("vehicleMileageReading") },
    vehicleOperationalRestriction: {
      findMany: record("vehicleOperationalRestriction", "findMany", [])
    },
    vehicleReturn: { count: count("vehicleReturn") },
    vehicleReturnDamage: { count: count("vehicleReturnDamage") },
    vehicleSubscriptionPeriod: {
      count: count("vehicleSubscriptionPeriod"),
      findMany: record("vehicleSubscriptionPeriod", "findMany", [])
    }
  };
  return { calls, db, maxConcurrentReads: () => maximumConcurrentReads };
}

function cleanSnapshot() {
  return {
    auditLogs: [],
    billingSchedule: {
      cancelledAt: null,
      id: "36054e6d-5104-4daf-b8a7-cb7e956fc436",
      lastGeneratedBillId: null,
      orderId: TARGET.orderId,
      pauseReason: "legacy-test-order",
      status: "PAUSED",
      version: 0
    },
    blockingCounts: emptyBlockingCounts(),
    evidenceReferences: {
      contracts: [
        {
          contractVersionId: "00000000-0000-4000-8000-000000000012",
          deletedAt: null,
          fileId: "00000000-0000-4000-8000-000000000011",
          id: "00000000-0000-4000-8000-000000000001",
          orderId: TARGET.orderId,
          status: "SIGNED"
        }
      ],
      eSignTasks: [
        {
          contractId: "00000000-0000-4000-8000-000000000001",
          deletedAt: null,
          id: "00000000-0000-4000-8000-000000000003",
          orderId: TARGET.orderId,
          sourceId: "00000000-0000-4000-8000-000000000001",
          sourceType: "CONTRACT",
          taskStatus: "COMPLETED"
        }
      ],
      evidenceFiles: [
        {
          evidenceItemId: "00000000-0000-4000-8000-000000000006",
          fileId: "00000000-0000-4000-8000-000000000013",
          id: "00000000-0000-4000-8000-000000000007",
          lifecycleStatus: "ACTIVE",
          replacedById: null
        }
      ],
      evidenceItems: [
        {
          handoverId: "bfc5a943-0000-4000-8000-000000000000",
          id: "00000000-0000-4000-8000-000000000006",
          orderId: TARGET.orderId,
          reviewStatus: "APPROVED",
          status: "ACCEPTED",
          vehicleDeliveryId: null
        }
      ],
      fileObjects: [
        {
          contentSha256: "a".repeat(64),
          createdAt: new Date("2026-07-31T02:00:00.000Z"),
          id: "00000000-0000-4000-8000-000000000011",
          sizeBytes: 1024n
        },
        {
          contentSha256: "b".repeat(64),
          createdAt: new Date("2026-07-31T02:30:00.000Z"),
          id: "00000000-0000-4000-8000-000000000013",
          sizeBytes: 2048n
        }
      ],
      handovers: [
        {
          archiveStatus: "ARCHIVED",
          deletedAt: null,
          handoverContractId: null,
          handoverESignTaskId: "00000000-0000-4000-8000-000000000003",
          id: "bfc5a943-0000-4000-8000-000000000000",
          orderId: TARGET.orderId,
          signedDocumentFileId: "00000000-0000-4000-8000-000000000013",
          sourceDocumentFileId: "00000000-0000-4000-8000-000000000011",
          stage1ContractId: "00000000-0000-4000-8000-000000000001",
          status: "ARCHIVED"
        }
      ],
      handoverWorkOrders: [
        {
          handoverId: "bfc5a943-0000-4000-8000-000000000000",
          id: "00000000-0000-4000-8000-000000000005",
          orderId: TARGET.orderId,
          status: "FIELD_COMPLETED"
        }
      ],
      handoverWorkflowJobs: [
        {
          eSignTaskId: "00000000-0000-4000-8000-000000000003",
          handoverId: "bfc5a943-0000-4000-8000-000000000000",
          id: "00000000-0000-4000-8000-000000000004",
          jobStatus: "COMPLETED",
          workOrderId: "00000000-0000-4000-8000-000000000005"
        }
      ]
    },
    journey: terminalJourney(),
    lease: {
      activatedAt: new Date("2026-07-31T03:01:04.000Z"),
      deletedAt: null,
      id: "44444444-4444-4444-8444-444444444444",
      orderId: TARGET.orderId,
      status: "ACTIVE"
    },
    operator: {
      deletedAt: null,
      id: operatorId,
      roles: [{ code: "ADMIN", deletedAt: null, roleDeletedAt: null, roleStatus: "ACTIVE" }],
      status: "ACTIVE"
    },
    order: {
      actualDeliveryAt: new Date("2026-07-31T03:01:04.000Z"),
      actualReturnAt: null,
      contractId: null,
      deletedAt: null,
      endDate: null,
      id: TARGET.orderId,
      orderNo: TARGET.orderNo,
      orderStatus: "ACTIVE",
      startDate: null,
      vehicleId: TARGET.vehicleId
    },
    vehicle: {
      activeOtherLeases: [],
      activeOtherOrders: [],
      activeRestrictions: [],
      activeSubscriptionPeriods: [],
      currentSalePriceAmount: 18500000n,
      deletedAt: null,
      id: TARGET.vehicleId,
      salePriceStatus: "EFFECTIVE",
      status: "LEASED",
      vehicleNo: TARGET.vehicleNo,
      vin: TARGET.vin
    },
    vehicleDeliveries: []
  };
}

function terminalJourney() {
  return {
    currentStepCode: "AUTHORITATIVE_ACTIVATION",
    currentStepStatus: "COMPLETED",
    events: [{ eventType: "JOURNEY_COMPLETED", id: "journey-event-1", sequence: 12 }],
    exceptions: [],
    id: "journey-1",
    jobs: [],
    manualTasks: [],
    orderId: TARGET.orderId,
    outboxRows: [],
    status: "COMPLETED",
    steps: [{ code: "AUTHORITATIVE_ACTIVATION", id: "journey-step-1", status: "COMPLETED" }]
  };
}

function emptyBlockingCounts() {
  return {
    assetWorkOrders: 0,
    automationJobs: 0,
    closureCases: 0,
    collectionActions: 0,
    collectionCaseBills: 0,
    collectionCases: 0,
    contractSegments: 0,
    costLedgerEntries: 0,
    debitAttempts: 0,
    depositLedgers: 0,
    entitlementAccounts: 0,
    entitlementGrants: 0,
    entitlementUsages: 0,
    insuranceClaims: 0,
    mileageReadings: 0,
    mileageReviews: 0,
    orderChanges: 0,
    paymentMandates: 0,
    paymentOrders: 0,
    paymentRecords: 0,
    paymentWriteOffs: 0,
    receivableBills: 0,
    renewalConsiderations: 0,
    returnDamages: 0,
    returns: 0,
    revenueRightAssignments: 0,
    serviceCases: 0,
    subscriptionChanges: 0,
    subscriptionPeriods: 0
  };
}
