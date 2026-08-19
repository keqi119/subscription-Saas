import assert from "node:assert/strict";
import test from "node:test";

const executor = await import("./stage1c-period-backfill-executor.mjs").catch(() => ({}));
const cli = await import("./stage1c-period-backfill.mjs").catch(() => ({}));

function requiredExport(module, name) {
  assert.equal(typeof module[name], "function", `${name} must be exported`);
  return module[name];
}

test("dry-run classifies a repeatable-read snapshot without create, update, or audit writes", async () => {
  const calls = [];
  async function forbidden(name) {
    calls.push(name);
    throw new Error(`${name} must not be called`);
  }
  const database = {
    async $transaction(work, options) {
      assert.deepEqual(options, {
        isolationLevel: "RepeatableRead",
        maxWait: 10_000,
        timeout: 120_000
      });
      calls.push("transaction.begin");
      const result = await work(transactionClient);
      calls.push("transaction.commit");
      return result;
    }
  };
  const transactionClient = {
    auditLog: {
      create: () => forbidden("audit.create"),
      update: () => forbidden("audit.update")
    },
    vehicleSubscriptionPeriod: {
      create: () => forbidden("period.create"),
      update: () => forbidden("period.update"),
      updateMany: () => forbidden("period.updateMany"),
      upsert: () => forbidden("period.upsert")
    }
  };
  const result = await requiredExport(
    executor,
    "executeStage1cPeriodBackfill"
  )({
    classify: () => cleanReport(),
    generatedAt: "2026-08-19T00:00:00.000Z",
    loadSnapshot: async (db) => {
      assert.equal(db, transactionClient);
      calls.push("load");
      return emptySnapshot();
    },
    mode: "dry-run",
    prisma: database
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.report, {
    applied: null,
    classification: cleanReport(),
    generatedAt: "2026-08-19T00:00:00.000Z",
    mode: "dry-run",
    safeToApply: true
  });
  assert.deepEqual(calls, ["transaction.begin", "load", "transaction.commit"]);
});

test("candidate-set safety requires no conflict, ambiguity, overlap, omission, or invariant", () => {
  const isClean = requiredExport(executor, "isStage1cPeriodBackfillCandidateSetClean");

  assert.equal(isClean(cleanReport()), true);
  for (const unsafe of [
    { subscriptionPeriods: [{ disposition: "CONFLICT" }] },
    { ambiguities: [{ code: "MISSING_VEHICLE" }] },
    { overlaps: [{ code: "SUBSCRIPTION_PERIOD_OVERLAP" }] },
    { segmentOmissions: [{ code: "CONTRACT_SEGMENT_UNRESOLVED" }] },
    { invariantViolations: [{ code: "ONE_ORDER_MULTIPLE_CURRENT_PERIODS" }] },
    { subscriptionPeriods: [{ disposition: "UNKNOWN" }] },
    { subscriptionPeriods: [{}] }
  ]) {
    assert.equal(isClean(cleanReport(unsafe)), false);
  }
});

test("unsafe apply is read-only, returns nonzero, and reports every blocker", async () => {
  const calls = [];
  const unsafe = cleanReport({
    ambiguities: [{ code: "MISSING_VEHICLE" }],
    invariantViolations: [{ code: "PERSISTED_SOURCE_IDENTITY_CONFLICT" }],
    overlaps: [{ code: "SUBSCRIPTION_PERIOD_OVERLAP" }],
    segmentOmissions: [{ code: "CONTRACT_SEGMENT_UNRESOLVED" }],
    subscriptionPeriods: [candidate("CONFLICT"), candidate("UNCHANGED")]
  });
  const prisma = transactionalDatabase({ calls });

  const result = await requiredExport(
    executor,
    "executeStage1cPeriodBackfill"
  )({
    classify: () => unsafe,
    generatedAt: "2026-08-19T00:00:00.000Z",
    loadSnapshot: async () => emptySnapshot(),
    mode: "apply",
    prisma
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.report.applied, {
    blocked: true,
    inserted: 0,
    skippedUnchanged: 1
  });
  assert.equal(result.report.safeToApply, false);
  assert.deepEqual(calls, [
    "transaction.begin",
    "fact.lock",
    "source.lock",
    "lock",
    "transaction.commit"
  ]);
});

test("clean apply inserts only CREATE rows, skips UNCHANGED, and audits each insert once", async () => {
  const calls = [];
  const createdRows = [];
  const auditRows = [];
  const report = cleanReport({
    subscriptionPeriods: [
      candidate("CREATE", { orderId: "00000000-0000-4000-8000-000000000002" }),
      candidate("UNCHANGED", {
        orderId: "00000000-0000-4000-8000-000000000003"
      })
    ]
  });
  const prisma = transactionalDatabase({ auditRows, calls, createdRows });

  const result = await requiredExport(
    executor,
    "executeStage1cPeriodBackfill"
  )({
    classify: () => report,
    generatedAt: "2026-08-19T00:00:00.000Z",
    loadSnapshot: async () => emptySnapshot(),
    mode: "apply",
    prisma
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.report.applied, {
    blocked: false,
    inserted: 1,
    skippedUnchanged: 1
  });
  assert.equal(createdRows.length, 1);
  assert.equal(createdRows[0].orderId, "00000000-0000-4000-8000-000000000002");
  assert.equal(auditRows.length, 1);
  assert.deepEqual(auditRows[0], {
    action: "CREATE",
    afterSnapshot: {
      ...createdRows[0],
      createdAt: "2026-08-19T00:00:00.000Z",
      id: "00000000-0000-4000-8000-100000000001",
      startConfirmedAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z"
    },
    beforeSnapshot: undefined,
    entityId: "00000000-0000-4000-8000-100000000001",
    entityType: "vehicle_subscription_period",
    module: "asset_facts",
    operatorId: undefined
  });
  assert.deepEqual(calls, [
    "transaction.begin",
    "fact.lock",
    "source.lock",
    "lock",
    "period.create",
    "audit.create",
    "transaction.commit"
  ]);
});

test("transaction-scoped locking makes concurrent apply and replay insert one fact and one audit", async () => {
  const calls = [];
  const createdRows = [];
  const auditRows = [];
  const prisma = transactionalDatabase({
    auditRows,
    calls,
    createdRows,
    serializeTransactions: true
  });
  const classify = (snapshot) =>
    cleanReport({
      subscriptionPeriods:
        snapshot.existingSubscriptionPeriods.length === 0
          ? [candidate("CREATE")]
          : [candidate("UNCHANGED")]
    });
  const loadSnapshot = async () => ({
    ...emptySnapshot(),
    existingSubscriptionPeriods: [...createdRows]
  });
  const execute = requiredExport(executor, "executeStage1cPeriodBackfill");

  const [first, concurrentReplay] = await Promise.all([
    execute({
      classify,
      generatedAt: "2026-08-19T00:00:00.000Z",
      loadSnapshot,
      mode: "apply",
      prisma
    }),
    execute({
      classify,
      generatedAt: "2026-08-19T00:00:01.000Z",
      loadSnapshot,
      mode: "apply",
      prisma
    })
  ]);
  const replay = await execute({
    classify,
    generatedAt: "2026-08-19T00:00:02.000Z",
    loadSnapshot,
    mode: "apply",
    prisma
  });

  assert.equal(first.report.applied.inserted, 1);
  assert.equal(concurrentReplay.report.applied.inserted, 0);
  assert.equal(replay.report.applied.inserted, 0);
  assert.equal(createdRows.length, 1);
  assert.equal(auditRows.length, 1);
  assert.equal(calls.filter((call) => call === "lock").length, 3);
  assert.equal(calls.filter((call) => call === "transaction.begin").length, 3);
  assert.equal(calls.filter((call) => call === "transaction.commit").length, 3);
});

test("snapshot loader selects every classifier field with explicit liveness and deterministic ordering", async () => {
  const queries = [];
  const db = snapshotDatabase(queries);

  const snapshot = await requiredExport(executor, "loadStage1cPeriodBackfillSnapshot")(db);

  assert.deepEqual(snapshot, emptySnapshot());
  assert.equal(queries.length, 11);
  for (const [, query] of queries) {
    assert.deepEqual(query.orderBy, { id: "asc" });
  }

  const orders = queryFor(queries, "subscriptionOrder");
  assert.deepEqual(Object.keys(orders.select).sort(), [
    "actualReturnAt",
    "contractId",
    "customerId",
    "deletedAt",
    "id",
    "orderNo",
    "orderStatus",
    "vehicleId"
  ]);
  assert.deepEqual(queryFor(queries, "customer").select, {
    customerNo: true,
    deletedAt: true,
    id: true,
    name: true,
    status: true
  });
  assert.deepEqual(queryFor(queries, "lease").select, {
    activatedAt: true,
    deletedAt: true,
    id: true,
    orderId: true,
    status: true
  });
  assert.deepEqual(queryFor(queries, "vehicleDelivery").select, {
    customerId: true,
    deletedAt: true,
    deliveredAt: true,
    deliveryStatus: true,
    id: true,
    orderId: true,
    vehicleId: true
  });
  assert.deepEqual(queryFor(queries, "vehicleReturn").select, {
    customerId: true,
    deletedAt: true,
    id: true,
    orderId: true,
    returnedAt: true,
    returnStatus: true,
    vehicleId: true
  });
  assert.deepEqual(queryFor(queries, "subscriptionContractSegment").select, {
    endDate: true,
    id: true,
    orderId: true,
    segmentNo: true,
    sourceContractId: true,
    startDate: true,
    status: true
  });

  assert.deepEqual(queryFor(queries, "vehicle").select, {
    deletedAt: true,
    id: true,
    plateNo: true,
    status: true,
    vehicleNo: true,
    vin: true
  });
  assert.deepEqual(queryFor(queries, "contract").select, {
    contractNo: true,
    customerId: true,
    deletedAt: true,
    id: true,
    orderId: true,
    status: true
  });

  const periodFields = Object.keys(queryFor(queries, "vehicleSubscriptionPeriod").select).sort();
  assert.deepEqual(periodFields, [
    "contractId",
    "contractSegmentId",
    "customerId",
    "endReason",
    "endSnapshot",
    "endSourceId",
    "endSourceKey",
    "endSourceType",
    "endedAt",
    "id",
    "orderId",
    "startReason",
    "startSnapshot",
    "startSourceId",
    "startSourceKey",
    "startSourceType",
    "startedAt",
    "vehicleId"
  ]);
});

test("snapshot loader composes separately loaded authority and evidence rows", async () => {
  const order = {
    actualReturnAt: null,
    contractId: null,
    customerId: "customer-1",
    deletedAt: null,
    id: "order-1",
    orderNo: "ORDER-1",
    orderStatus: "ACTIVE",
    vehicleId: "vehicle-1"
  };
  const customer = {
    customerNo: "CUSTOMER-1",
    deletedAt: null,
    id: "customer-1",
    name: "Customer One",
    status: "ACTIVE"
  };
  const lease = {
    activatedAt: new Date("2026-08-01T00:00:00.000Z"),
    deletedAt: null,
    id: "lease-1",
    orderId: "order-1",
    status: "ACTIVE"
  };
  const delivery = {
    customerId: "customer-1",
    deletedAt: null,
    deliveredAt: new Date("2026-08-01T00:00:00.000Z"),
    deliveryStatus: "DELIVERED",
    id: "delivery-1",
    orderId: "order-1",
    vehicleId: "vehicle-1"
  };
  const vehicleReturn = {
    customerId: "customer-1",
    deletedAt: null,
    id: "return-1",
    orderId: "order-1",
    returnedAt: null,
    returnStatus: "PENDING",
    vehicleId: "vehicle-1"
  };
  const segment = {
    endDate: new Date("2026-12-31T00:00:00.000Z"),
    id: "segment-1",
    orderId: "order-1",
    segmentNo: "SEGMENT-1",
    sourceContractId: null,
    startDate: new Date("2026-08-01T00:00:00.000Z"),
    status: "ACTIVE"
  };
  const db = recordDatabase({
    customer: [customer],
    lease: [lease],
    subscriptionContractSegment: [segment],
    subscriptionOrder: [order],
    vehicleDelivery: [delivery],
    vehicleReturn: [vehicleReturn]
  });

  const snapshot = await requiredExport(executor, "loadStage1cPeriodBackfillSnapshot")(db);

  assert.deepEqual(snapshot.orders, [
    {
      ...order,
      contractSegments: [segment],
      customer,
      deliveries: [delivery],
      lease,
      returns: [vehicleReturn]
    }
  ]);
});

test("snapshot loader serializes queries for interactive transaction clients", async () => {
  let activeQueries = 0;
  let maximumActiveQueries = 0;
  const db = Object.fromEntries(
    [
      "assetOwner",
      "contract",
      "customer",
      "lease",
      "subscriptionOrder",
      "subscriptionContractSegment",
      "vehicle",
      "vehicleDelivery",
      "vehicleOwnershipPeriod",
      "vehicleReturn",
      "vehicleSubscriptionPeriod"
    ].map((name) => [
      name,
      {
        async findMany() {
          activeQueries += 1;
          maximumActiveQueries = Math.max(maximumActiveQueries, activeQueries);
          await new Promise((resolve) => setImmediate(resolve));
          activeQueries -= 1;
          return [];
        }
      }
    ])
  );

  await requiredExport(executor, "loadStage1cPeriodBackfillSnapshot")(db);

  assert.equal(maximumActiveQueries, 1);
});

test("apply confirmation is narrowly named and requires the exact value 1", () => {
  const validate = requiredExport(cli, "assertStage1cPeriodBackfillApplyConfirmation");

  assert.doesNotThrow(() => validate("dry-run", {}));
  assert.doesNotThrow(() => validate("apply", { STAGE1C_PERIOD_BACKFILL_APPLY: "1" }));
  for (const env of [
    {},
    { STAGE1C_PERIOD_BACKFILL_APPLY: "true" },
    { STAGE1C_PERIOD_BACKFILL_APPLY: " 1 " },
    { GENERIC_APPLY: "1" }
  ]) {
    assert.throws(
      () => validate("apply", env),
      /STAGE1C_PERIOD_BACKFILL_APPLY_CONFIRMATION_REQUIRED/
    );
  }
});

test("CLI uses Task 6 parsing, emits JSON, writes optional output, and returns unsafe exit code", async () => {
  const stdout = [];
  const writes = [];
  const prisma = { marker: "fake-prisma" };
  const expectedReport = {
    applied: null,
    classification: cleanReport({ ambiguities: [{ code: "MISSING_VEHICLE" }] }),
    generatedAt: "2026-08-19T00:00:00.000Z",
    mode: "dry-run",
    safeToApply: false
  };

  const exitCode = await requiredExport(
    cli,
    "runStage1cPeriodBackfillCli"
  )({
    args: ["--dry-run", "--output", "output/report.json"],
    createPrisma: async () => prisma,
    env: {},
    execute: async (input) => {
      assert.deepEqual(input, { mode: "dry-run", prisma });
      return { exitCode: 1, report: expectedReport };
    },
    writeOutput: async (path, contents) => writes.push([path, contents]),
    writeStdout: (contents) => stdout.push(contents)
  });

  const expectedJson = `${JSON.stringify(expectedReport, null, 2)}\n`;
  assert.equal(exitCode, 1);
  assert.deepEqual(stdout, [expectedJson]);
  assert.deepEqual(writes, [["output/report.json", expectedJson]]);
});

test("public CLI failures never include the database URL or credentials", () => {
  const publicError = requiredExport(cli, "stage1cPeriodBackfillPublicError");
  const secretUrl = "postgresql://secret-user:secret-password@prod.example.invalid/prod";

  assert.deepEqual(publicError(new Error(`connect failed: ${secretUrl}`)), {
    error: "STAGE1C_PERIOD_BACKFILL_FAILED"
  });
  assert.doesNotMatch(JSON.stringify(publicError(new Error(secretUrl))), /secret|postgresql|prod/);
});

test("process cleanup failures use the same credential-safe public error", async () => {
  const stderr = [];
  const secretUrl = "postgresql://secret-user:secret-password@prod.example.invalid/prod";

  const exitCode = await requiredExport(
    cli,
    "runStage1cPeriodBackfillProcess"
  )({
    disconnect: async () => {
      throw new Error(`disconnect failed: ${secretUrl}`);
    },
    run: async () => 0,
    writeStderr: (contents) => stderr.push(contents)
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(stderr, [`${JSON.stringify({ error: "STAGE1C_PERIOD_BACKFILL_FAILED" })}\n`]);
  assert.doesNotMatch(stderr.join(""), /secret|postgresql|prod/);
});

function cleanReport(overrides = {}) {
  return {
    ambiguities: [],
    counters: {
      activeOrders: 0,
      closedPeriods: 0,
      existingOpenPeriods: 0,
      leasedVehicles: 0,
      oneOrderMultipleCurrentAnomalies: 0,
      overlaps: 0,
      ownershipUnknownVehicles: 0,
      proposedOpenPeriods: 0
    },
    invariantViolations: [],
    overlaps: [],
    ownership: { proposedPeriods: [], unknownVehicles: [] },
    segmentOmissions: [],
    sourceCounts: {
      assetOwners: 0,
      contracts: 0,
      existingOwnershipPeriods: 0,
      existingSubscriptionPeriods: 0,
      orders: 0,
      vehicles: 0
    },
    subscriptionPeriods: [],
    ...overrides
  };
}

function emptySnapshot() {
  return {
    assetOwners: [],
    contracts: [],
    existingOwnershipPeriods: [],
    existingSubscriptionPeriods: [],
    orders: [],
    vehicles: []
  };
}

function candidate(disposition, overrides = {}) {
  const orderId = overrides.orderId ?? "00000000-0000-4000-8000-000000000001";
  const payload = {
    contractId: null,
    contractSegmentId: null,
    customerId: "00000000-0000-4000-8000-000000000011",
    endedAt: null,
    endReason: null,
    endSnapshot: null,
    endSourceId: null,
    endSourceKey: null,
    endSourceType: null,
    orderId,
    startedAt: "2026-08-01T00:00:00.000Z",
    startReason: "BACKFILL",
    startSnapshot: { authority: {}, metadata: {} },
    startSourceId: orderId,
    startSourceKey: `stage1c-period-backfill:subscription-order:${orderId}`,
    startSourceType: "SUBSCRIPTION_ORDER",
    vehicleId: "00000000-0000-4000-8000-000000000021",
    ...overrides.payload
  };
  return {
    disposition,
    orderId,
    orderNo: `ORDER-${orderId.slice(-3)}`,
    payload,
    sourceKey: payload.startSourceKey
  };
}

function transactionalDatabase({
  auditRows = [],
  calls,
  createdRows = [],
  serializeTransactions = false
}) {
  let factLockTail = Promise.resolve();

  async function runTransaction(work) {
    calls.push("transaction.begin");
    let releaseFactLock;
    const tx = {
      $executeRaw(strings) {
        const query = strings.join("?").replace(/\s+/g, " ").trim();
        if (/LOCK TABLE "vehicle_subscription_period"/.test(query)) {
          calls.push("fact.lock");
          if (!serializeTransactions) return Promise.resolve(0);
          const previous = factLockTail;
          factLockTail = new Promise((resolve) => {
            releaseFactLock = resolve;
          });
          return previous.then(() => 0);
        }
        assert.match(query, /LOCK TABLE "asset_owner"/);
        calls.push("source.lock");
        return Promise.resolve(0);
      },
      $queryRaw(strings, ...values) {
        const query = strings.join("?");
        assert.match(query, /SELECT TRUE AS locked FROM pg_advisory_xact_lock/);
        assert.deepEqual(values, ["stage1c-period-backfill:apply"]);
        calls.push("lock");
        return Promise.resolve([{ locked: true }]);
      },
      auditLog: {
        async create({ data }) {
          calls.push("audit.create");
          auditRows.push(data);
          return { id: `audit-${auditRows.length}`, ...data };
        },
        update() {
          throw new Error("audit update is forbidden");
        }
      },
      vehicleSubscriptionPeriod: {
        async create({ data }) {
          calls.push("period.create");
          const row = {
            ...data,
            createdAt: new Date("2026-08-19T00:00:00.000Z"),
            id: `00000000-0000-4000-8000-10000000000${createdRows.length + 1}`,
            updatedAt: new Date("2026-08-19T00:00:00.000Z")
          };
          createdRows.push(row);
          return row;
        },
        update() {
          throw new Error("period update is forbidden");
        },
        updateMany() {
          throw new Error("period updateMany is forbidden");
        },
        upsert() {
          throw new Error("period upsert is forbidden");
        }
      }
    };
    try {
      const result = await work(tx);
      calls.push("transaction.commit");
      return result;
    } finally {
      releaseFactLock?.();
    }
  }

  return {
    $transaction(work, options) {
      assert.deepEqual(options, {
        isolationLevel: "RepeatableRead",
        maxWait: 10_000,
        timeout: 120_000
      });
      return runTransaction(work);
    }
  };
}

function snapshotDatabase(queries) {
  return Object.fromEntries(
    [
      "assetOwner",
      "contract",
      "customer",
      "lease",
      "subscriptionContractSegment",
      "subscriptionOrder",
      "vehicle",
      "vehicleDelivery",
      "vehicleOwnershipPeriod",
      "vehicleReturn",
      "vehicleSubscriptionPeriod"
    ].map((name) => [
      name,
      {
        findMany(query) {
          queries.push([name, query]);
          return Promise.resolve([]);
        }
      }
    ])
  );
}

function recordDatabase(recordsByDelegate) {
  return Object.fromEntries(
    [
      "assetOwner",
      "contract",
      "customer",
      "lease",
      "subscriptionContractSegment",
      "subscriptionOrder",
      "vehicle",
      "vehicleDelivery",
      "vehicleOwnershipPeriod",
      "vehicleReturn",
      "vehicleSubscriptionPeriod"
    ].map((name) => [
      name,
      {
        findMany() {
          return Promise.resolve(recordsByDelegate[name] ?? []);
        }
      }
    ])
  );
}

function queryFor(queries, name) {
  const query = queries.find(([delegate]) => delegate === name)?.[1];
  assert.ok(query, `missing ${name} query`);
  return query;
}
