import assert from "node:assert/strict";
import test from "node:test";

import {
  applyContractChangeBootstrapPlan,
  buildContractChangeBootstrapPlan,
  parseContractChangeBootstrapMode,
  validateContractChangeFeatureFlags
} from "./stage1-contract-change-bootstrap-core.mjs";
import { executeContractChangeBootstrap } from "./stage1-contract-change-bootstrap.mjs";

test("requires one explicit dry-run or apply mode", () => {
  assert.equal(parseContractChangeBootstrapMode(["--dry-run"]), "dry-run");
  assert.equal(parseContractChangeBootstrapMode(["--apply"]), "apply");
  assert.throws(() => parseContractChangeBootstrapMode([]), /exactly one/);
  assert.throws(() => parseContractChangeBootstrapMode(["--apply", "--dry-run"]), /exactly one/);
});

test("validates four independent rollout flags and requires extension on staging", () => {
  const result = validateContractChangeFeatureFlags({
    DEPLOYMENT_ENV: "staging",
    SUBSCRIPTION_EARLY_TERMINATION_ENABLED: "true",
    SUBSCRIPTION_EXTENSION_ENABLED: "false",
    SUBSCRIPTION_MANAGED_OTHER_ENABLED: "true",
    SUBSCRIPTION_VEHICLE_SWAP_ENABLED: "TRUE"
  });

  assert.deepEqual(result.flags, {
    earlyTermination: true,
    extension: false,
    managedOther: true,
    vehicleSwap: false
  });
  assert.deepEqual(
    result.blockers.map((blocker) => blocker.code),
    ["FEATURE_FLAG_INVALID", "STAGING_EXTENSION_DISABLED"]
  );
});

test("plans only deterministic BASE and extension-detail repairs while reporting ambiguous facts", () => {
  const healthy = activeOrder({
    contractSegments: [],
    subscriptionChanges: [legacyExtensionChange()],
    subscriptionPeriods: [activePeriod()]
  });
  const ambiguous = activeOrder({
    id: "order-ambiguous",
    orderNo: "ORD-AMBIGUOUS",
    subscriptionChanges: [
      legacyExtensionChange({ id: "change-a", sourceSegmentId: null }),
      legacyExtensionChange({ id: "change-b", status: "QUOTED" })
    ],
    subscriptionPeriods: [
      activePeriod({ id: "period-a" }),
      activePeriod({ id: "period-b", vehicleId: "vehicle-other" })
    ]
  });

  const plan = buildContractChangeBootstrapPlan([healthy, ambiguous]);

  assert.equal(plan.baseSegments.candidates.length, 2);
  assert.deepEqual(
    plan.extensionDetails.candidates.map((candidate) => candidate.changeOrderId),
    ["change-legacy", "change-b"]
  );
  assert.deepEqual(
    plan.exceptions.map((exception) => exception.code).sort(),
    [
      "ACTIVE_SUBSCRIPTION_CHANGE_MULTIPLE",
      "ACTIVE_VEHICLE_PERIOD_MULTIPLE",
      "EXTENSION_DETAIL_SOURCE_INCOMPLETE"
    ]
  );
});

test("applies a missing extension detail idempotently without mutating the root", async () => {
  const order = activeOrder({
    contractSegments: [baseSegment()],
    subscriptionChanges: [legacyExtensionChange()],
    subscriptionPeriods: [activePeriod()]
  });
  const plan = buildContractChangeBootstrapPlan([order]);
  let storedDetail = null;
  let rootUpdateCount = 0;
  const tx = {
    $queryRawUnsafe: async () => [],
    subscriptionChangeOrder: {
      findUnique: async () => ({
        ...legacyExtensionChange(),
        extensionDetail: storedDetail
      }),
      update: async () => {
        rootUpdateCount += 1;
      }
    },
    subscriptionExtensionChangeDetail: {
      create: async ({ data }) => {
        storedDetail = { id: "detail-created", ...data };
        return storedDetail;
      },
      findUnique: async () => storedDetail
    }
  };
  const prisma = {
    $transaction: async (operation) => operation(tx)
  };

  const first = await applyContractChangeBootstrapPlan(prisma, plan);
  const second = await applyContractChangeBootstrapPlan(prisma, plan);

  assert.deepEqual(first.extensionDetails, { created: 1, existing: 0 });
  assert.deepEqual(second.extensionDetails, { created: 0, existing: 1 });
  assert.equal(rootUpdateCount, 0);
});

test("dry-run proves zero writes even when deterministic candidates exist", async () => {
  const records = [
    activeOrder({
      contractSegments: [],
      subscriptionChanges: [legacyExtensionChange()],
      subscriptionPeriods: [activePeriod()]
    })
  ];
  const prisma = {
    $transaction: async () => {
      throw new Error("DRY_RUN_WRITE_ATTEMPTED");
    }
  };

  const result = await executeContractChangeBootstrap({
    environment: {
      DEPLOYMENT_ENV: "test",
      SUBSCRIPTION_EARLY_TERMINATION_ENABLED: "false",
      SUBSCRIPTION_EXTENSION_ENABLED: "false",
      SUBSCRIPTION_MANAGED_OTHER_ENABLED: "false",
      SUBSCRIPTION_VEHICLE_SWAP_ENABLED: "false"
    },
    mode: "dry-run",
    prisma,
    records
  });

  assert.equal(result.applied, false);
  assert.equal(result.plan.baseSegments.candidates.length, 1);
  assert.equal(result.plan.extensionDetails.candidates.length, 1);
});

function activeOrder(overrides = {}) {
  return {
    contract: {
      contractSnapshot: { contractNo: "CON-1" },
      id: "contract-1",
      status: "ARCHIVED"
    },
    contractSegments: [],
    customerId: "customer-1",
    endDate: new Date("2027-08-26T00:00:00.000Z"),
    energyLimitCount: null,
    energyLimitKwh: null,
    finalPlanSnapshot: { plan: "baseline" },
    id: "order-1",
    mileageLimitKm: 20_000,
    monthlyFeeAmount: 100_000n,
    orderNo: "ORD-1",
    orderStatus: "ACTIVE",
    overMileageFeeAmount: 100n,
    productId: "product-1",
    productVersionId: "product-version-1",
    quoteSnapshot: { quote: "baseline" },
    startDate: new Date("2026-08-27T00:00:00.000Z"),
    subscriptionChanges: [],
    subscriptionPeriods: [],
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function activePeriod(overrides = {}) {
  return {
    endedAt: null,
    id: "period-1",
    startedAt: new Date("2026-08-27T01:00:00.000Z"),
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function baseSegment(overrides = {}) {
  return {
    id: "segment-base",
    segmentType: "BASE",
    sequenceNo: 1,
    ...overrides
  };
}

function legacyExtensionChange(overrides = {}) {
  return {
    changeType: "EXTENSION",
    extensionDetail: null,
    extensionMonths: 6,
    id: "change-legacy",
    priceOverrideApprovedAt: null,
    priceOverrideApprovedBy: null,
    priceOverrideReason: null,
    pricingMode: "CURRENT_VERSION",
    sourceSegmentId: "segment-base",
    status: "DRAFT",
    targetEndDate: new Date("2028-02-26T00:00:00.000Z"),
    targetStartDate: new Date("2027-08-27T00:00:00.000Z"),
    ...overrides
  };
}
