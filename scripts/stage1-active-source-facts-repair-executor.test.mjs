import assert from "node:assert/strict";
import test from "node:test";

const executor = await import("./stage1-active-source-facts-repair-executor.mjs").catch(() => ({}));
const core = await import("./stage1-active-source-facts-repair-core.mjs");

function requiredExport(module, name) {
  assert.equal(typeof module[name], "function", `${name} must be exported`);
  return module[name];
}

test("dry-run uses RepeatableRead and performs zero writes", async () => {
  const calls = [];
  const tx = forbiddenWriteClient(calls);
  const prisma = {
    async $transaction(work, options) {
      assert.deepEqual(options, repeatableReadOptions());
      calls.push("transaction.begin");
      const result = await work(tx);
      calls.push("transaction.commit");
      return result;
    }
  };

  const result = await requiredExport(
    executor,
    "executeStage1ActiveSourceFactsRepair"
  )({
    classify: () => cleanClassification(),
    generatedAt: "2026-08-28T00:00:00.000Z",
    loadSnapshot: async (db) => {
      assert.equal(db, tx);
      calls.push("snapshot.load");
      return { orders: [] };
    },
    mode: "dry-run",
    prisma
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.safeToApply, true);
  assert.equal(result.report.applied, null);
  assert.deepEqual(calls, ["transaction.begin", "snapshot.load", "transaction.commit"]);
});

test("unsafe apply locks and reloads but remains read-only and nonzero", async () => {
  const harness = createApplyHarness();
  const unsafe = cleanClassification({
    exceptions: [{ code: "ACTIVATION_TIMESTAMP_CONFLICT", orderId: "order-1" }],
    summary: {
      actions: { ARCHIVE_CONTRACT: 0, BIND_CONTRACT: 0, SET_ORDER_DATES: 0 },
      candidates: 0,
      exceptions: 1,
      inspectedOrders: 1,
      unchanged: 0
    }
  });

  const result = await requiredExport(
    executor,
    "executeStage1ActiveSourceFactsRepair"
  )({
    classify: () => unsafe,
    loadSnapshot: async () => harness.snapshot(),
    mode: "apply",
    prisma: harness.prisma
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.safeToApply, false);
  assert.deepEqual(result.report.applied, {
    audits: 0,
    blocked: true,
    contractsUpdated: 0,
    ordersUpdated: 0,
    skippedUnchanged: 0
  });
  assert.equal(harness.state.audits.length, 0);
  assert.equal(harness.state.order.contractId, null);
  assert.deepEqual(harness.calls, [
    "transaction.begin",
    "advisory.lock",
    "tables.lock",
    "transaction.commit"
  ]);
});

test("apply locks, reloads, updates authority, and audits atomically", async () => {
  const harness = createApplyHarness();

  const result = await requiredExport(
    executor,
    "executeStage1ActiveSourceFactsRepair"
  )({
    generatedAt: "2026-08-28T00:00:00.000Z",
    loadSnapshot: async () => harness.snapshot(),
    mode: "apply",
    prisma: harness.prisma
  });

  assert.equal(result.exitCode, 0);
  assert.equal(harness.state.contract.status, "ARCHIVED");
  assert.equal(harness.state.contract.archivedAt.toISOString(), "2026-08-26T03:53:26.694Z");
  assert.equal(harness.state.order.contractId, harness.state.contract.id);
  assert.equal(harness.state.order.startDate.toISOString(), "2026-08-26T00:00:00.000Z");
  assert.equal(harness.state.order.endDate.toISOString(), "2027-08-25T00:00:00.000Z");
  assert.deepEqual(harness.state.audits.map(({ entityType }) => entityType).sort(), [
    "contract",
    "subscription_order"
  ]);
  assert.deepEqual(result.report.applied, {
    audits: 2,
    blocked: false,
    contractsUpdated: 1,
    ordersUpdated: 1,
    skippedUnchanged: 0
  });
  const serializedAudits = JSON.stringify(harness.state.audits);
  assert.doesNotMatch(serializedAudits, /signed\/private\/contract-1\.pdf/);
  assert.doesNotMatch(serializedAudits, /objectKey|signedDocumentObjectKey|DATABASE_URL/);
  assert.match(serializedAudits, /evidenceDigest/);
});

test("a stale conditional update aborts and rolls back every earlier write", async () => {
  const harness = createApplyHarness({ staleOrderUpdate: true });

  await assert.rejects(
    requiredExport(
      executor,
      "executeStage1ActiveSourceFactsRepair"
    )({
      loadSnapshot: async () => harness.snapshot(),
      mode: "apply",
      prisma: harness.prisma
    }),
    /STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_STALE_ORDER:order-1/
  );

  assert.equal(harness.state.contract.status, "SIGNED");
  assert.equal(harness.state.contract.archivedAt, null);
  assert.equal(harness.state.order.contractId, null);
  assert.equal(harness.state.audits.length, 0);
});

test("a later audit failure rolls back contract, order, and all audits", async () => {
  const harness = createApplyHarness({ failAuditAt: 2 });

  await assert.rejects(
    requiredExport(
      executor,
      "executeStage1ActiveSourceFactsRepair"
    )({
      loadSnapshot: async () => harness.snapshot(),
      mode: "apply",
      prisma: harness.prisma
    }),
    /INJECTED_AUDIT_FAILURE/
  );

  assert.equal(harness.state.contract.status, "SIGNED");
  assert.equal(harness.state.contract.archivedAt, null);
  assert.equal(harness.state.order.contractId, null);
  assert.equal(harness.state.order.startDate, null);
  assert.equal(harness.state.order.endDate, null);
  assert.equal(harness.state.audits.length, 0);
});

test("serialized concurrent apply and replay produce one repair and two audits", async () => {
  const harness = createApplyHarness({ serializeTransactions: true });
  const execute = requiredExport(executor, "executeStage1ActiveSourceFactsRepair");
  const input = (generatedAt) => ({
    generatedAt,
    loadSnapshot: async () => harness.snapshot(),
    mode: "apply",
    prisma: harness.prisma
  });

  const [first, concurrent] = await Promise.all([
    execute(input("2026-08-28T00:00:00.000Z")),
    execute(input("2026-08-28T00:00:01.000Z"))
  ]);
  const replay = await execute(input("2026-08-28T00:00:02.000Z"));

  assert.deepEqual(
    [first, concurrent].map(({ report }) => report.applied.ordersUpdated).sort(),
    [0, 1]
  );
  assert.equal(replay.report.applied.ordersUpdated, 0);
  assert.equal(replay.report.applied.skippedUnchanged, 1);
  assert.equal(harness.state.audits.length, 2);
  assert.equal(harness.calls.filter((call) => call === "advisory.lock").length, 3);
});

test("snapshot loader selects only classifier facts in deterministic order", async () => {
  const queries = [];
  const orderRow = baseOrder();
  const contractRow = baseContract();
  const taskRow = baseTask();
  const fileRow = baseFile();
  const deliveryRow = baseDelivery();
  const leaseRow = baseLease();
  const segmentRow = { id: "segment-1", orderId: "order-1" };
  const periodRow = { id: "period-1", orderId: "order-1" };
  const records = {
    contract: [contractRow],
    contractESignTask: [taskRow],
    fileObject: [fileRow],
    lease: [leaseRow],
    subscriptionContractSegment: [segmentRow],
    subscriptionOrder: [orderRow],
    vehicleDelivery: [deliveryRow],
    vehicleSubscriptionPeriod: [periodRow]
  };
  const db = Object.fromEntries(
    Object.entries(records).map(([name, rows]) => [
      name,
      {
        findMany: async (query) => {
          queries.push([name, query]);
          return structuredClone(rows);
        }
      }
    ])
  );

  const snapshot = await requiredExport(executor, "loadStage1ActiveSourceFactsRepairSnapshot")(db);

  assert.equal(queries.length, 8);
  for (const [, query] of queries) assert.deepEqual(query.orderBy, { id: "asc" });
  assert.deepEqual(snapshot.orders, [
    {
      ...orderRow,
      contractSegments: [segmentRow],
      contracts: [
        {
          ...contractRow,
          eSignTasks: [taskRow],
          file: fileRow
        }
      ],
      deliveries: [deliveryRow],
      lease: leaseRow,
      leases: [leaseRow],
      subscriptionPeriods: [periodRow]
    }
  ]);
  assert.deepEqual(Object.keys(queryFor(queries, "subscriptionOrder").select).sort(), [
    "actualDeliveryAt",
    "contractId",
    "customerId",
    "deletedAt",
    "endDate",
    "id",
    "orderNo",
    "orderStatus",
    "periodMonths",
    "startDate",
    "vehicleId"
  ]);
  assert.deepEqual(Object.keys(queryFor(queries, "contractESignTask").select).sort(), [
    "completedAt",
    "contractId",
    "customerId",
    "deletedAt",
    "documentType",
    "id",
    "orderId",
    "signedDocumentObjectKey",
    "signingStage",
    "taskStatus"
  ]);
  assert.deepEqual(queryFor(queries, "fileObject").select, {
    id: true,
    mimeType: true,
    objectKey: true,
    sizeBytes: true
  });
});

function cleanClassification(overrides = {}) {
  return {
    candidates: [],
    exceptions: [],
    summary: {
      actions: { ARCHIVE_CONTRACT: 0, BIND_CONTRACT: 0, SET_ORDER_DATES: 0 },
      candidates: 0,
      exceptions: 0,
      inspectedOrders: 0,
      unchanged: 0
    },
    unchanged: [],
    ...overrides
  };
}

function forbiddenWriteClient(calls) {
  const forbidden = (name) => async () => {
    calls.push(name);
    throw new Error(`${name} is forbidden`);
  };
  return {
    $queryRawUnsafe: forbidden("queryRawUnsafe"),
    auditLog: { create: forbidden("audit.create") },
    contract: { updateMany: forbidden("contract.updateMany") },
    subscriptionOrder: { updateMany: forbidden("order.updateMany") }
  };
}

function createApplyHarness({
  failAuditAt = null,
  serializeTransactions = false,
  staleOrderUpdate = false
} = {}) {
  const state = {
    audits: [],
    contract: baseContract(),
    delivery: baseDelivery(),
    file: baseFile(),
    lease: baseLease(),
    order: baseOrder(),
    task: baseTask()
  };
  const calls = [];
  let tail = Promise.resolve();
  let auditAttempts = 0;

  async function run(work, options) {
    assert.deepEqual(options, serializableOptions());
    const previous = tail;
    let release;
    if (serializeTransactions) {
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
    }
    calls.push("transaction.begin");
    const before = structuredClone(state);
    const tx = {
      $queryRawUnsafe: async (query) => {
        if (query.includes("pg_advisory_xact_lock")) calls.push("advisory.lock");
        else if (query.includes("LOCK TABLE")) calls.push("tables.lock");
        else throw new Error(`Unexpected lock query: ${query}`);
        return [];
      },
      auditLog: {
        create: async ({ data }) => {
          auditAttempts += 1;
          if (auditAttempts === failAuditAt) throw new Error("INJECTED_AUDIT_FAILURE");
          state.audits.push(structuredClone(data));
          calls.push("audit.create");
          return data;
        }
      },
      contract: {
        updateMany: async ({ data, where }) => {
          if (!matchesContractWhere(state.contract, where)) return { count: 0 };
          Object.assign(state.contract, structuredClone(data));
          calls.push("contract.updateMany");
          return { count: 1 };
        }
      },
      subscriptionOrder: {
        updateMany: async ({ data, where }) => {
          if (staleOrderUpdate || !matchesOrderWhere(state.order, where)) return { count: 0 };
          Object.assign(state.order, structuredClone(data));
          calls.push("order.updateMany");
          return { count: 1 };
        }
      }
    };
    try {
      const result = await work(tx);
      calls.push("transaction.commit");
      return result;
    } catch (error) {
      Object.assign(state, before);
      calls.push("transaction.rollback");
      throw error;
    } finally {
      release?.();
    }
  }

  return {
    calls,
    prisma: { $transaction: run },
    snapshot: () => ({
      orders: [
        {
          ...structuredClone(state.order),
          contractSegments: [],
          contracts: [
            {
              ...structuredClone(state.contract),
              eSignTasks: [structuredClone(state.task)],
              file: structuredClone(state.file)
            }
          ],
          deliveries: [structuredClone(state.delivery)],
          lease: structuredClone(state.lease),
          leases: [structuredClone(state.lease)],
          subscriptionPeriods: []
        }
      ]
    }),
    state
  };
}

function matchesContractWhere(contract, where) {
  return (
    contract.id === where.id &&
    contract.deletedAt === where.deletedAt &&
    contract.status === where.status &&
    contract.archivedAt === where.archivedAt
  );
}

function matchesOrderWhere(order, where) {
  return (
    order.id === where.id &&
    order.deletedAt === where.deletedAt &&
    order.contractId === where.contractId &&
    order.startDate === where.startDate &&
    order.endDate === where.endDate &&
    order.actualDeliveryAt.getTime() === where.actualDeliveryAt.getTime() &&
    where.orderStatus.in.includes(order.orderStatus)
  );
}

function baseOrder() {
  return {
    actualDeliveryAt: new Date("2026-08-26T03:53:26.694Z"),
    contractId: null,
    customerId: "customer-1",
    deletedAt: null,
    endDate: null,
    id: "order-1",
    orderNo: "ORD-1",
    orderStatus: "ACTIVE",
    periodMonths: 12,
    startDate: null,
    vehicleId: "vehicle-1"
  };
}

function baseContract() {
  return {
    archivedAt: null,
    businessType: "SUBSCRIPTION",
    contractNo: "CON-1",
    contractSnapshot: { terms: "signed" },
    customerId: "customer-1",
    deletedAt: null,
    fileId: "file-1",
    id: "contract-1",
    orderId: "order-1",
    signedAt: new Date("2026-08-26T03:50:00.000Z"),
    status: "SIGNED"
  };
}

function baseTask() {
  return {
    completedAt: new Date("2026-08-26T03:53:26.694Z"),
    contractId: "contract-1",
    customerId: "customer-1",
    deletedAt: null,
    documentType: "SUBSCRIPTION_CONTRACT",
    id: "task-1",
    orderId: "order-1",
    signedDocumentObjectKey: "signed/private/contract-1.pdf",
    signingStage: "STAGE1_SUBSCRIPTION_CONTRACT",
    taskStatus: "COMPLETED"
  };
}

function baseFile() {
  return {
    id: "file-1",
    mimeType: "application/pdf",
    objectKey: "signed/private/contract-1.pdf",
    sizeBytes: 2048n
  };
}

function baseDelivery() {
  return {
    customerId: "customer-1",
    deletedAt: null,
    deliveredAt: new Date("2026-08-26T03:53:26.694Z"),
    deliveryStatus: "DELIVERED",
    id: "delivery-1",
    orderId: "order-1",
    vehicleId: "vehicle-1"
  };
}

function baseLease() {
  return {
    activatedAt: new Date("2026-08-26T03:53:26.694Z"),
    deletedAt: null,
    id: "lease-1",
    orderId: "order-1",
    status: "ACTIVE"
  };
}

function queryFor(queries, name) {
  return queries.find(([model]) => model === name)?.[1];
}

function repeatableReadOptions() {
  return { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 120_000 };
}

function serializableOptions() {
  return { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 };
}
