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
    [
      "transaction",
      { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 120_000 }
    ]
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
    result.report.classification.blockers.some(
      ({ relation }) => relation === "receivableBills"
    )
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
  const { calls, db } = snapshotDatabase();
  const snapshot = await required("loadStage1StagingInvalidTestOrderRetirementSnapshot")(db, {
    operatorId
  });

  assert.equal(snapshot.order.id, TARGET.orderId);
  assert.equal(snapshot.vehicle.id, TARGET.vehicleId);
  assert.equal(snapshot.operator.id, operatorId);
  assert.deepEqual(snapshot.vehicle.activeOtherOrders, []);
  assert.deepEqual(snapshot.vehicle.activeOtherLeases, []);
  assert.deepEqual(snapshot.vehicle.activeRestrictions, []);
  assert.deepEqual(snapshot.evidenceReferences.handoverWorkflowJobs, [
    {
      handoverId: "bfc5a943-0000-4000-8000-000000000000",
      id: "00000000-0000-4000-8000-000000000004",
      jobStatus: "COMPLETED",
      workOrderId: "00000000-0000-4000-8000-000000000005"
    }
  ]);
  assert.deepEqual(snapshot.blockingCounts, emptyBlockingCounts());

  const orderRead = calls.find(
    ([model, method]) => model === "subscriptionOrder" && method === "findUnique"
  );
  assert.deepEqual(orderRead[2].where, { id: TARGET.orderId });
  const vehicleRead = calls.find(
    ([model, method]) => model === "vehicle" && method === "findUnique"
  );
  assert.deepEqual(vehicleRead[2].where, { id: TARGET.vehicleId });
  const userRead = calls.find(([model, method]) => model === "user" && method === "findUnique");
  assert.deepEqual(userRead[2].where, { id: operatorId });

  const serializedQueries = JSON.stringify(calls);
  assert.doesNotMatch(
    serializedQueries,
    /mobile|passwordHash|objectKey|signedObjectKey|accessToken|requestSnapshot|responseSnapshot|payload/
  );
  assert.equal(calls.filter(([, method]) => method === "count").length, 29);
});

test("loader scopes every prohibited relation count to the target order", async () => {
  const { calls, db } = snapshotDatabase();
  await required("loadStage1StagingInvalidTestOrderRetirementSnapshot")(db, { operatorId });

  for (const [model, method, query] of calls.filter(([, method]) => method === "count")) {
    assert.equal(query.where.orderId, TARGET.orderId, model);
  }
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

function snapshotDatabase() {
  const calls = [];
  const record = (model, method, result) => async (query) => {
    calls.push([model, method, query]);
    return structuredClone(result);
  };
  const count = (model) => async (query) => {
    calls.push([model, "count", query]);
    return 0;
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
    vehicleDeliveryHandover: {
      findMany: record(
        "vehicleDeliveryHandover",
        "findMany",
        cleanSnapshot().evidenceReferences.handovers
      )
    },
    vehicleHandoverWorkOrder: {
      findMany: record("vehicleHandoverWorkOrder", "findMany", [
        { id: "00000000-0000-4000-8000-000000000005" }
      ])
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
    vehicleSubscriptionPeriod: { count: count("vehicleSubscriptionPeriod") }
  };
  return { calls, db };
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
          deletedAt: null,
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
          taskStatus: "COMPLETED"
        }
      ],
      handovers: [
        {
          archiveStatus: "ARCHIVED",
          deletedAt: null,
          id: "bfc5a943-0000-4000-8000-000000000000",
          orderId: TARGET.orderId,
          status: "ARCHIVED"
        }
      ],
      handoverWorkflowJobs: [
        {
          handoverId: "bfc5a943-0000-4000-8000-000000000000",
          id: "00000000-0000-4000-8000-000000000004",
          jobStatus: "COMPLETED",
          workOrderId: "00000000-0000-4000-8000-000000000005"
        }
      ]
    },
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
      roles: [
        { code: "ADMIN", deletedAt: null, roleDeletedAt: null, roleStatus: "ACTIVE" }
      ],
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
