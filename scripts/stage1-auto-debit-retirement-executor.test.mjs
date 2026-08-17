import assert from "node:assert/strict";
import test from "node:test";

import { executeStage1AutoDebitRetirement } from "./stage1-auto-debit-retirement-executor.mjs";

const NOW = new Date("2026-08-18T08:00:00.000Z");

test("dry-run reports executable jobs without writes", async () => {
  const harness = createHarness([
    job({ id: "00000000-0000-4000-8000-000000000001" }),
    job({
      id: "00000000-0000-4000-8000-000000000002",
      jobStatus: "COMPLETED"
    })
  ]);

  const result = await executeStage1AutoDebitRetirement({
    mode: "dry-run",
    prisma: harness.prisma
  });

  assert.deepEqual(result, {
    exitCode: 0,
    report: {
      blockedProcessingCount: 0,
      byJobType: { SUBMIT_BILL_DEBIT: 2 },
      cancellableCount: 1,
      cancelledCount: 0,
      collectionMode: "ACTIVE_PAYMENT_ONLY",
      historicalCount: 1,
      mode: "dry-run",
      ok: true,
      postcondition: { executableJobCount: 1 },
      scannedCount: 2
    }
  });
  assert.equal(harness.updateCalls.length, 0);
  assert.equal(harness.audits.length, 0);
});

test("apply refuses while an auto-debit job holds a live lease", async () => {
  const harness = createHarness([
    job({
      id: "00000000-0000-4000-8000-000000000003",
      jobStatus: "PROCESSING",
      leaseExpiresAt: new Date("2026-08-18T08:00:01.000Z")
    })
  ]);

  const result = await executeStage1AutoDebitRetirement({
    mode: "apply",
    prisma: harness.prisma
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.report.ok, false);
  assert.equal(result.report.blockedProcessingCount, 1);
  assert.equal(result.report.postcondition.executableJobCount, 1);
  assert.equal(harness.updateCalls.length, 0);
  assert.equal(harness.audits.length, 0);
});

test("apply uses the database clock and locks jobs before lease classification", async () => {
  const harness = createHarness(
    [
      job({
        id: "00000000-0000-4000-8000-000000000008",
        jobStatus: "PROCESSING",
        leaseExpiresAt: new Date("2026-08-18T08:00:01.000Z")
      })
    ],
    { databaseNow: NOW }
  );
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : ["2026-08-18T09:00:00.000Z"]));
    }
  };

  try {
    const result = await executeStage1AutoDebitRetirement({
      mode: "apply",
      prisma: harness.prisma
    });

    assert.equal(result.exitCode, 2);
    assert.equal(result.report.blockedProcessingCount, 1);
    assert.deepEqual(harness.operations.slice(0, 3), ["lock", "database-now", "find"]);
    assert.equal(harness.updateCalls.length, 0);
  } finally {
    globalThis.Date = RealDate;
  }
});

test("apply cancels only eligible jobs and writes one audit per cancellation", async () => {
  const harness = createHarness([
    job({ id: "00000000-0000-4000-8000-000000000004" }),
    job({
      id: "00000000-0000-4000-8000-000000000005",
      jobStatus: "PROCESSING",
      jobType: "QUERY_DEBIT_ATTEMPT",
      leaseExpiresAt: new Date("2026-08-18T07:59:59.000Z")
    }),
    job({
      id: "00000000-0000-4000-8000-000000000006",
      jobStatus: "DEAD_LETTER"
    }),
    job({
      id: "00000000-0000-4000-8000-000000000007",
      jobStatus: "PENDING",
      jobType: "GENERATE_MONTHLY_RENT_BILL"
    })
  ]);

  const first = await executeStage1AutoDebitRetirement({
    mode: "apply",
    prisma: harness.prisma
  });

  assert.equal(first.exitCode, 0);
  assert.equal(first.report.cancelledCount, 2);
  assert.deepEqual(first.report.postcondition, { executableJobCount: 0 });
  assert.equal(harness.audits.length, 2);
  assert.deepEqual(
    harness.rows.map(({ id, jobStatus }) => ({ id, jobStatus })),
    [
      {
        id: "00000000-0000-4000-8000-000000000004",
        jobStatus: "CANCELLED"
      },
      {
        id: "00000000-0000-4000-8000-000000000005",
        jobStatus: "CANCELLED"
      },
      {
        id: "00000000-0000-4000-8000-000000000006",
        jobStatus: "DEAD_LETTER"
      },
      {
        id: "00000000-0000-4000-8000-000000000007",
        jobStatus: "PENDING"
      }
    ]
  );
  for (const audit of harness.audits) {
    assert.equal(audit.action, "UPDATE");
    assert.equal(audit.entityType, "subscription_automation_job");
    assert.equal(audit.module, "billing");
    assert.equal(audit.operatorId, null);
  }

  const second = await executeStage1AutoDebitRetirement({
    mode: "apply",
    prisma: harness.prisma
  });

  assert.equal(second.exitCode, 0);
  assert.equal(second.report.cancelledCount, 0);
  assert.equal(second.report.historicalCount, 3);
  assert.equal(harness.audits.length, 2);
});

function createHarness(initialRows, { databaseNow = NOW } = {}) {
  const rows = initialRows.map((row) => ({ ...row }));
  const audits = [];
  const operations = [];
  const updateCalls = [];
  const db = {
    $queryRawUnsafe: async (query) => {
      if (/FOR UPDATE/.test(query)) {
        operations.push("lock");
        return rows.map(({ id }) => ({ id }));
      }
      if (/clock_timestamp/.test(query)) {
        operations.push("database-now");
        return [{ now: databaseNow }];
      }
      throw new Error(`Unexpected query: ${query}`);
    },
    auditLog: {
      create: async ({ data }) => {
        audits.push(data);
        return data;
      }
    },
    subscriptionAutomationJob: {
      count: async ({ where }) =>
        rows.filter(
          (row) =>
            where.jobType.in.includes(row.jobType) && where.jobStatus.in.includes(row.jobStatus)
        ).length,
      findMany: async ({ where }) => {
        operations.push("find");
        return rows
          .filter((row) => where.jobType.in.includes(row.jobType))
          .map((row) => ({ ...row }));
      },
      updateMany: async ({ data, where }) => {
        updateCalls.push({ data, where });
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row || row.jobStatus !== where.jobStatus) {
          return { count: 0 };
        }
        if (
          row.jobStatus === "PROCESSING" &&
          (!row.leaseExpiresAt || row.leaseExpiresAt > where.leaseExpiresAt.lte)
        ) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }
    }
  };
  const prisma = {
    ...db,
    $transaction: async (operation) => operation(db)
  };
  return { audits, operations, prisma, rows, updateCalls };
}

function job(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    jobStatus: "PENDING",
    jobType: "SUBMIT_BILL_DEBIT",
    leaseExpiresAt: null,
    ...overrides
  };
}
