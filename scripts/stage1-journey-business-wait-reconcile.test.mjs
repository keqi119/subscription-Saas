import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBusinessWaitReconciliation,
  summarizeBusinessWaitReconciliation
} from "./stage1-journey-business-wait-reconcile-core.mjs";
import {
  executeBusinessWaitReconciliation,
  parseMode
} from "./stage1-journey-business-wait-reconcile.mjs";

test("revalidates only a legacy application-validation business-wait exception", () => {
  assert.deepEqual(classifyBusinessWaitReconciliation(candidate()), {
    action: "REVALIDATE_APPLICATION",
    proposedOutcome: "WAITING_MANUAL",
    reason: "legacy business-wait exception can use the canonical validator",
    reasonCodes: [
      "MATERIAL_REVIEW_PENDING",
      "CREDIT_REVIEW_PENDING",
      "DEPOSIT_CONFIRMATION_PENDING"
    ]
  });
});

test("previews customer, ready, and rejected outcomes from current application facts", () => {
  assert.equal(
    classifyBusinessWaitReconciliation(candidate({ materialReviewStatus: "NEED_MORE_INFO" }))
      .proposedOutcome,
    "WAITING_CUSTOMER"
  );
  assert.equal(
    classifyBusinessWaitReconciliation(
      candidate({
        creditReviewStatus: "APPROVED",
        depositStatus: "CONFIRMED",
        finalDepositAmountPresent: true,
        materialReviewStatus: "APPROVED"
      })
    ).proposedOutcome,
    "READY"
  );
  assert.equal(
    classifyBusinessWaitReconciliation(candidate({ creditReviewStatus: "REJECTED" }))
      .proposedOutcome,
    "REJECTED"
  );
});

test("reports non-legacy, mixed, advanced, and non-open exceptions without mutation", () => {
  assert.deepEqual(
    classifyBusinessWaitReconciliation(candidate({ exceptionCodes: ["FADADA_PROVIDER_REJECTED"] })),
    {
      action: "REPORT_ONLY",
      proposedOutcome: null,
      reason: "open exception code is outside the legacy business-wait allowlist",
      reasonCodes: []
    }
  );
  assert.equal(
    classifyBusinessWaitReconciliation(
      candidate({
        exceptionCodes: ["JOURNEY_APPLICATION_MATERIALS_INCOMPLETE", "JOURNEY_EXECUTION_ERROR"]
      })
    ).action,
    "REPORT_ONLY"
  );
  assert.equal(
    classifyBusinessWaitReconciliation(candidate({ currentStepCode: "FINAL_PLAN_DECISION" }))
      .action,
    "NONE"
  );
  assert.equal(
    classifyBusinessWaitReconciliation(candidate({ exceptionStatus: "RESOLVED" })).action,
    "NONE"
  );
});

test("summary exposes operational identifiers and facts but no customer PII", () => {
  const report = summarizeBusinessWaitReconciliation([
    candidate({ customerName: "Sensitive Name", mobile: "13800000000" }),
    candidate({
      applicationId: "application-2",
      exceptionCodes: ["JOURNEY_EXECUTION_ERROR"],
      journeyId: "journey-2"
    })
  ]);

  assert.deepEqual(report.counts, {
    NONE: 0,
    REPORT_ONLY: 1,
    REVALIDATE_APPLICATION: 1
  });
  assert.deepEqual(report.results[0], {
    action: "REVALIDATE_APPLICATION",
    applicationId: "application-1",
    currentFactVersion: 4,
    journeyId: "journey-1",
    oldErrorCodes: ["JOURNEY_APPLICATION_MATERIALS_INCOMPLETE"],
    proposedOutcome: "WAITING_MANUAL",
    reason: "legacy business-wait exception can use the canonical validator",
    reasonCodes: [
      "MATERIAL_REVIEW_PENDING",
      "CREDIT_REVIEW_PENDING",
      "DEPOSIT_CONFIRMATION_PENDING"
    ]
  });
  assert.doesNotMatch(JSON.stringify(report), /Sensitive Name|13800000000/);
});

test("requires an explicit dry-run or apply mode", () => {
  assert.equal(parseMode(["--dry-run"]), "dry-run");
  assert.equal(parseMode(["--apply"]), "apply");
  assert.throws(() => parseMode([]), /Specify exactly one/);
  assert.throws(() => parseMode(["--apply", "--dry-run"]), /Specify exactly one/);
});

test("dry-run reads and reports candidates without opening a transaction", async () => {
  const harness = reconciliationHarness();
  const result = await executeBusinessWaitReconciliation(harness.client, "dry-run");

  assert.equal(result.applied.length, 0);
  assert.equal(result.report.counts.REVALIDATE_APPLICATION, 1);
  assert.equal(harness.calls.transactions, 0);
  assert.equal(harness.calls.mutations.length, 0);
});

test("apply locks the aggregate, resolves only allowed exceptions, and writes event, outbox, and audit", async () => {
  const harness = reconciliationHarness();
  const result = await executeBusinessWaitReconciliation(harness.client, "apply");

  assert.deepEqual(result.applied, [{ action: "REVALIDATE_APPLICATION", journeyId: "journey-1" }]);
  assert.equal(harness.calls.locks.length, 3);
  assert.equal(harness.calls.exceptions[0].where.code.in.length, 2);
  assert.equal(harness.calls.events[0].data.eventType, "EXCEPTION_RESOLVED");
  assert.equal(harness.calls.outbox[0].data.eventType, "EXCEPTION_RESOLVED");
  assert.equal(harness.calls.audits[0].data.entityId, "application-1");
  assert.equal(harness.calls.journeys[0].data.status, "RUNNING");
  assert.equal(harness.calls.steps[0].data.status, "PENDING");
});

function candidate(overrides = {}) {
  return {
    applicationId: "application-1",
    applicationStatus: "SUBMITTED",
    creditReviewStatus: "PENDING",
    currentFactVersion: 4,
    currentStepCode: "APPLICATION_VALIDATION",
    currentStepStatus: "EXCEPTION",
    depositStatus: "PENDING_CONFIRM",
    exceptionCodes: ["JOURNEY_APPLICATION_MATERIALS_INCOMPLETE"],
    exceptionStatus: "OPEN",
    finalDepositAmountPresent: false,
    journeyId: "journey-1",
    journeyStatus: "EXCEPTION",
    materialReviewStatus: "PENDING",
    version: 2,
    ...overrides
  };
}

function reconciliationHarness() {
  const record = databaseJourney();
  const calls = {
    audits: [],
    events: [],
    exceptions: [],
    journeys: [],
    locks: [],
    mutations: [],
    outbox: [],
    steps: [],
    transactions: 0
  };
  const tx = {
    $queryRawUnsafe: async (...args) => {
      calls.locks.push(args);
      return [];
    },
    application: { findUnique: async () => record.application },
    auditLog: {
      create: async (input) => {
        calls.audits.push(input);
        calls.mutations.push(input);
      }
    },
    subscriptionJourney: {
      findUnique: async () => record,
      updateMany: async (input) => {
        calls.journeys.push(input);
        calls.mutations.push(input);
        return { count: 1 };
      }
    },
    subscriptionJourneyEvent: {
      create: async (input) => {
        calls.events.push(input);
        calls.mutations.push(input);
      }
    },
    subscriptionJourneyException: {
      updateMany: async (input) => {
        calls.exceptions.push(input);
        calls.mutations.push(input);
        return { count: 1 };
      }
    },
    subscriptionJourneyOutbox: {
      create: async (input) => {
        calls.outbox.push(input);
        calls.mutations.push(input);
      }
    },
    subscriptionJourneyStep: {
      update: async (input) => {
        calls.steps.push(input);
        calls.mutations.push(input);
      }
    }
  };
  const client = {
    $transaction: async (callback) => {
      calls.transactions += 1;
      return callback(tx);
    },
    subscriptionJourney: { findMany: async () => [record] }
  };
  return { calls, client };
}

function databaseJourney() {
  return {
    application: {
      creditReviewStatus: "PENDING",
      depositStatus: "PENDING_CONFIRM",
      finalDepositAmount: null,
      journeyFactVersion: 4,
      materialReviewStatus: "PENDING",
      status: "SUBMITTED"
    },
    applicationId: "application-1",
    currentStepCode: "APPLICATION_VALIDATION",
    currentStepStatus: "EXCEPTION",
    exceptions: [
      {
        code: "JOURNEY_APPLICATION_MATERIALS_INCOMPLETE",
        id: "exception-1",
        status: "OPEN"
      }
    ],
    id: "journey-1",
    status: "EXCEPTION",
    steps: [
      {
        code: "APPLICATION_VALIDATION",
        id: "step-1",
        status: "EXCEPTION"
      }
    ],
    version: 2
  };
}
