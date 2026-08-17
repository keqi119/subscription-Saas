import assert from "node:assert/strict";
import test from "node:test";

import { buildRetirementPlan, parseMode } from "./stage1-auto-debit-retirement-core.mjs";

test("accepts only dry-run and apply modes", () => {
  assert.equal(parseMode(["--dry-run"]), "dry-run");
  assert.equal(parseMode(["--apply"]), "apply");
  assert.throws(() => parseMode([]), /STAGE1_AUTO_DEBIT_RETIREMENT_MODE_REQUIRED/);
  assert.throws(
    () => parseMode(["--dry-run", "--apply"]),
    /STAGE1_AUTO_DEBIT_RETIREMENT_MODE_CONFLICT/
  );
});

test("classifies executable, leased, and historical retired jobs", () => {
  const result = buildRetirementPlan(
    [
      job({ id: "pending-1", jobStatus: "PENDING" }),
      job({
        id: "expired-processing-1",
        jobStatus: "PROCESSING",
        jobType: "QUERY_DEBIT_ATTEMPT",
        leaseExpiresAt: new Date("2026-08-18T07:59:59.000Z")
      }),
      job({
        id: "leased-processing-1",
        jobStatus: "PROCESSING",
        jobType: "SEND_DEBIT_FAILURE_NOTICE",
        leaseExpiresAt: new Date("2026-08-18T08:00:01.000Z")
      }),
      job({
        id: "missing-lease-expiry-1",
        jobStatus: "PROCESSING",
        jobType: "SYNC_PAYMENT_MANDATE",
        leaseExpiresAt: null
      }),
      job({ id: "completed-1", jobStatus: "COMPLETED" }),
      job({ id: "dead-letter-1", jobStatus: "DEAD_LETTER" }),
      job({ id: "cancelled-1", jobStatus: "CANCELLED" }),
      job({
        id: "unrelated-1",
        jobStatus: "PENDING",
        jobType: "GENERATE_MONTHLY_RENT_BILL"
      })
    ],
    new Date("2026-08-18T08:00:00.000Z")
  );

  assert.deepEqual(result.cancellableIds, ["pending-1", "expired-processing-1"]);
  assert.deepEqual(result.blockedProcessingIds, ["leased-processing-1", "missing-lease-expiry-1"]);
  assert.equal(result.historicalCount, 3);
  assert.equal(result.scannedCount, 7);
  assert.deepEqual(result.byJobType, {
    QUERY_DEBIT_ATTEMPT: 1,
    SEND_DEBIT_FAILURE_NOTICE: 1,
    SUBMIT_BILL_DEBIT: 4,
    SYNC_PAYMENT_MANDATE: 1
  });
});

function job(overrides = {}) {
  return {
    id: "job-1",
    jobStatus: "PENDING",
    jobType: "SUBMIT_BILL_DEBIT",
    leaseExpiresAt: null,
    ...overrides
  };
}
