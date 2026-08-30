import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  BILLING_MAINTENANCE_FORBIDDEN_DOMAINS,
  BILLING_MAINTENANCE_FORBIDDEN_KEYS,
  buildBillingMaintenanceCycleEvidence,
  canonicalBillingMaintenanceEvidenceJson,
  pollBillingMaintenanceCycleEvidence,
  validateBillingMaintenanceCycleEvidenceOptions
} from "./billing-maintenance-cycle-evidence-core.mjs";
import {
  main as billingMaintenanceEvidenceMain,
  queryBillingMaintenanceCycleFacts
} from "./billing-maintenance-cycle-evidence.mjs";

const RUN_ID = "a".repeat(64);
const RELEASE_SHA = "b".repeat(40);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const DATABASE_IDENTITY_SHA256 = "d".repeat(64);
const NOT_BEFORE = "2026-08-31T01:00:00Z";
const SOURCE = {
  databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
  evidenceRunId: RUN_ID,
  imageDigest: IMAGE_DIGEST,
  releaseSha: RELEASE_SHA
};
const OPTIONS = {
  expectedDatabaseIdentitySha256: DATABASE_IDENTITY_SHA256,
  expectedImageDigest: IMAGE_DIGEST,
  expectedReleaseSha: RELEASE_SHA,
  notBefore: NOT_BEFORE,
  runId: RUN_ID,
  timeoutSeconds: 60
};

test("exports only canonical public-safe proof after two exact database facts", () => {
  const rows = [completedFact(2), completedFact(1)];

  const evidence = buildBillingMaintenanceCycleEvidence(rows, OPTIONS);
  const serialized = canonicalBillingMaintenanceEvidenceJson(evidence);

  assert.equal(evidence.operation, "BILLING_MAINTENANCE_CYCLE_EVIDENCE");
  assert.equal(evidence.safe, true);
  assert.equal(evidence.schemaVersion, 1);
  assert.deepEqual(
    evidence.cycles.map(({ cycleId, sequence }) => ({ cycleId, sequence })),
    [
      { cycleId: "00000000-0000-4000-8000-000000000001", sequence: 1 },
      { cycleId: "00000000-0000-4000-8000-000000000002", sequence: 2 }
    ]
  );
  assert.equal(evidence.cycles[0].reconciliationSummary.dryRun, false);
  assert.deepEqual(Object.keys(evidence.cycles[0].beforeCounts), [
    ...BILLING_MAINTENANCE_FORBIDDEN_KEYS
  ]);
  assert.equal(serialized, canonicalBillingMaintenanceEvidenceJson(JSON.parse(serialized)));
  assert.doesNotMatch(
    serialized,
    /"(?:orderId|orderNo|customerId|customerNo|customerPhone|vehicleId|vehicleVin|token|url|databaseUrl|rawItems|items)"/i
  );
});

for (const [label, rows] of [
  ["zero", []],
  ["one", [completedFact(1)]]
]) {
  test(`rejects ${label} stored facts instead of inferring completion from elapsed time`, () => {
    assertEvidenceCode(
      () => buildBillingMaintenanceCycleEvidence(rows, OPTIONS),
      "BILLING_MAINTENANCE_FACTS_INCOMPLETE"
    );
  });
}

for (const [label, rows] of [
  ["wrong first sequence", [{ ...completedFact(1), sequence: 2 }, completedFact(2)]],
  ["duplicate sequence", [completedFact(1), { ...completedFact(2), sequence: 1 }]],
  [
    "duplicate cycle id",
    [completedFact(1), { ...completedFact(2), id: "00000000-0000-4000-8000-000000000001" }]
  ]
]) {
  test(`rejects ${label}`, () => {
    assertEvidenceCode(
      () => buildBillingMaintenanceCycleEvidence(rows, OPTIONS),
      "BILLING_MAINTENANCE_SEQUENCE_INVALID"
    );
  });
}

test("rejects overlapping maintenance cycles", () => {
  const second = completedFact(2);
  second.cycleStartedAt = new Date("2026-08-31T01:00:03.999Z");

  assertEvidenceCode(
    () => buildBillingMaintenanceCycleEvidence([completedFact(1), second], OPTIONS),
    "BILLING_MAINTENANCE_TIME_INVALID"
  );
});

test("rejects facts whose cycle began before the approved not-before instant", () => {
  const first = completedFact(1);
  first.cycleStartedAt = new Date("2026-08-31T00:59:59.999Z");

  assertEvidenceCode(
    () => buildBillingMaintenanceCycleEvidence([first, completedFact(2)], OPTIONS),
    "BILLING_MAINTENANCE_TIME_INVALID"
  );
});

for (const [label, mutation] of [
  ["run", { evidenceRunId: "e".repeat(64) }],
  ["release", { releaseSha: "e".repeat(40) }],
  ["image", { imageDigest: `sha256:${"e".repeat(64)}` }],
  ["database", { databaseIdentitySha256: "e".repeat(64) }],
  ["forbidden version", { forbiddenDomainSetVersion: "stage1-acceptance-forbidden-domains/v9" }],
  ["forbidden hash", { forbiddenDomainSetSha256: "e".repeat(64) }]
]) {
  test(`rejects ${label} source-binding drift`, () => {
    const first = { ...completedFact(1), ...mutation };

    assertEvidenceCode(
      () => buildBillingMaintenanceCycleEvidence([first, completedFact(2)], OPTIONS),
      "BILLING_MAINTENANCE_SOURCE_BINDING_MISMATCH"
    );
  });
}

test("rejects a completed cycle with a blocked reconciliation", () => {
  const first = completedFact(1);
  first.blockedCount = 1;
  first.reconciliationSummary = {
    ...first.reconciliationSummary,
    blockedCount: 1,
    blockerCodes: ["ACTIVE_ORDER_INVALID"]
  };

  assertEvidenceCode(
    () => buildBillingMaintenanceCycleEvidence([first, completedFact(2)], OPTIONS),
    "BILLING_MAINTENANCE_BLOCKED"
  );
});

for (const [label, mutate] of [
  [
    "changed within-cycle count",
    (fact) => {
      fact.afterCounts = { ...fact.afterCounts, auditLog: 1 };
      fact.afterCountsSha256 = independentHash(fact.afterCounts);
    }
  ],
  [
    "missing forbidden key",
    (fact) => {
      const { auditLog: _removed, ...counts } = fact.beforeCounts;
      fact.beforeCounts = counts;
      fact.beforeCountsSha256 = independentHash(counts);
    }
  ],
  [
    "extra forbidden key",
    (fact) => {
      fact.beforeCounts = { ...fact.beforeCounts, unexpectedDomain: 0 };
      fact.beforeCountsSha256 = independentHash(fact.beforeCounts);
    }
  ],
  [
    "negative forbidden count",
    (fact) => {
      fact.beforeCounts = { ...fact.beforeCounts, auditLog: -1 };
      fact.beforeCountsSha256 = independentHash(fact.beforeCounts);
    }
  ],
  ["wrong before hash", (fact) => (fact.beforeCountsSha256 = "f".repeat(64))],
  ["wrong after hash", (fact) => (fact.afterCountsSha256 = "f".repeat(64))]
]) {
  test(`rejects ${label}`, () => {
    const first = completedFact(1);
    mutate(first);

    assertEvidenceCode(
      () => buildBillingMaintenanceCycleEvidence([first, completedFact(2)], OPTIONS),
      "BILLING_MAINTENANCE_COUNTS_INVALID"
    );
  });
}

for (const [label, mutate] of [
  [
    "unsafe reconciliation field",
    (fact) => {
      fact.reconciliationSummary = {
        ...fact.reconciliationSummary,
        orderId: "00000000-0000-4000-8000-000000000099"
      };
    }
  ],
  [
    "unsafe enqueue field",
    (fact) => {
      fact.enqueueSummary = { ...fact.enqueueSummary, rawItems: [] };
    }
  ],
  [
    "negative reconcile count",
    (fact) => {
      fact.reconciliationSummary = { ...fact.reconciliationSummary, eligibleCount: -1 };
    }
  ],
  [
    "reconciliation dryRun other than false",
    (fact) => {
      fact.reconciliationSummary = { ...fact.reconciliationSummary, dryRun: true };
    }
  ],
  [
    "negative enqueue count",
    (fact) => {
      fact.enqueueSummary = { ...fact.enqueueSummary, enqueuedCount: -1 };
    }
  ],
  [
    "non-empty blocker codes when blockedCount is zero",
    (fact) => {
      fact.reconciliationSummary = {
        ...fact.reconciliationSummary,
        blockerCodes: ["ACTIVE_ORDER_INVALID"]
      };
    }
  ]
]) {
  test(`rejects ${label}`, () => {
    const first = completedFact(1);
    mutate(first);

    assertEvidenceCode(
      () => buildBillingMaintenanceCycleEvidence([first, completedFact(2)], OPTIONS),
      "BILLING_MAINTENANCE_SUMMARY_INVALID"
    );
  });
}

test("bounded polling succeeds only after the database returns both actual rows", async () => {
  const responses = [[], [completedFact(1)], [completedFact(1), completedFact(2)]];
  const observations = [];
  let elapsed = 0;

  const evidence = await pollBillingMaintenanceCycleEvidence({
    ...OPTIONS,
    now: () => elapsed,
    pollIntervalMs: 50,
    queryFacts: async () => {
      const rows = responses.shift() ?? [];
      observations.push(rows.length);
      return rows;
    },
    wait: async (milliseconds) => {
      elapsed += milliseconds;
    }
  });

  assert.deepEqual(observations, [0, 1, 2]);
  assert.deepEqual(
    evidence.cycles.map(({ sequence }) => sequence),
    [1, 2]
  );
});

test("bounded polling times out without manufacturing evidence", async () => {
  let elapsed = 0;
  let queries = 0;

  await assert.rejects(
    pollBillingMaintenanceCycleEvidence({
      ...OPTIONS,
      now: () => elapsed,
      pollIntervalMs: 400,
      queryFacts: async () => {
        queries += 1;
        return [];
      },
      timeoutSeconds: 1,
      wait: async (milliseconds) => {
        elapsed += milliseconds;
      }
    }),
    (error) => error?.code === "BILLING_MAINTENANCE_EVIDENCE_TIMEOUT"
  );
  assert.ok(queries >= 1);
});

test("database query that never resolves is rejected by the remaining deadline", async () => {
  let deadlineTimers = 0;
  const polling = pollBillingMaintenanceCycleEvidence({
    ...OPTIONS,
    clearTimer: () => undefined,
    now: () => 0,
    queryFacts: () => new Promise(() => undefined),
    setTimer: (callback) => {
      deadlineTimers += 1;
      queueMicrotask(callback);
      return deadlineTimers;
    },
    timeoutSeconds: 1
  }).then(
    () => ({ kind: "resolved" }),
    (error) => ({ error, kind: "rejected" })
  );

  const outcome = await Promise.race([
    polling,
    new Promise((resolve) => setTimeout(() => resolve({ kind: "hung" }), 100))
  ]);

  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.error?.code, "BILLING_MAINTENANCE_EVIDENCE_TIMEOUT");
  assert.equal(deadlineTimers, 1);
});

test("database rows returned exactly at the deadline are not accepted", async () => {
  const observedTimes = [0, 1_000];
  await assert.rejects(
    pollBillingMaintenanceCycleEvidence({
      ...OPTIONS,
      clearTimer: () => undefined,
      now: () => observedTimes.shift() ?? 1_000,
      queryFacts: async () => [completedFact(1), completedFact(2)],
      setTimer: () => ({ pending: true }),
      timeoutSeconds: 1
    }),
    (error) => error?.code === "BILLING_MAINTENANCE_EVIDENCE_TIMEOUT"
  );
});

test("database rows resolving after the query deadline cannot become evidence", async () => {
  let queryResolved = false;
  const rows = new Promise((resolve) => {
    setTimeout(() => {
      queryResolved = true;
      resolve([completedFact(1), completedFact(2)]);
    }, 20);
  });

  await assert.rejects(
    pollBillingMaintenanceCycleEvidence({
      ...OPTIONS,
      clearTimer: clearTimeout,
      now: () => 0,
      queryFacts: () => rows,
      setTimer: (callback) => setTimeout(callback, 5),
      timeoutSeconds: 1
    }),
    (error) => error?.code === "BILLING_MAINTENANCE_EVIDENCE_TIMEOUT"
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(queryResolved, true);
});

test("successful database query clears its deadline timer", async () => {
  const activeTimers = new Set();
  let timersCreated = 0;
  const evidence = await pollBillingMaintenanceCycleEvidence({
    ...OPTIONS,
    clearTimer: (handle) => activeTimers.delete(handle),
    now: () => 0,
    queryFacts: async () => [completedFact(1), completedFact(2)],
    setTimer: (callback) => {
      const handle = { callback };
      timersCreated += 1;
      activeTimers.add(handle);
      return handle;
    }
  });

  assert.equal(evidence.cycles.length, 2);
  assert.equal(timersCreated, 1);
  assert.equal(activeTimers.size, 0);
});

test("database query uses a transaction and statement timeout below its remaining budget", async () => {
  const calls = [];
  const rows = [completedFact(1), completedFact(2)];
  const transactionClient = {
    $executeRawUnsafe: async (...args) => calls.push({ args, type: "statement-timeout" }),
    billingMaintenanceCycleFact: {
      findMany: async (args) => {
        calls.push({ args, type: "find-many" });
        return rows;
      }
    }
  };
  const prisma = {
    $transaction: async (operation, options) => {
      calls.push({ options, type: "transaction" });
      return operation(transactionClient);
    }
  };

  const result = await queryBillingMaintenanceCycleFacts(prisma, RUN_ID, 900);

  assert.equal(result, rows);
  assert.equal(calls[0].type, "transaction");
  assert.equal(calls[0].options.timeout, 900);
  assert.ok(calls[0].options.maxWait > 0 && calls[0].options.maxWait <= 900);
  assert.equal(calls[1].args[0], "SELECT set_config('statement_timeout', $1, true)");
  assert.ok(Number(calls[1].args[1]) > 0 && Number(calls[1].args[1]) < 900);
  assert.equal(calls[2].type, "find-many");
  assert.deepEqual(calls[2].args.where, { evidenceRunId: RUN_ID });
});

test("database transaction timeout is exposed as the stable exporter timeout", async () => {
  const prisma = {
    $transaction: async () => {
      const error = new Error("Transaction already closed: timeout");
      error.code = "P2028";
      throw error;
    }
  };

  await assert.rejects(
    queryBillingMaintenanceCycleFacts(prisma, RUN_ID, 900),
    (error) => error?.code === "BILLING_MAINTENANCE_EVIDENCE_TIMEOUT"
  );
});

test("CLI returns without partial stdout when disconnect never resolves", async () => {
  const rows = [completedFact(1), completedFact(2)];
  const transactionClient = {
    $executeRawUnsafe: async () => 1,
    billingMaintenanceCycleFact: { findMany: async () => rows }
  };
  const prisma = {
    $disconnect: () => new Promise(() => undefined),
    $transaction: async (operation) => operation(transactionClient),
    billingMaintenanceCycleFact: { findMany: async () => rows }
  };
  let stdout = "";
  let stderr = "";
  const execution = billingMaintenanceEvidenceMain(cliArguments(), {
    createPrismaClient: async () => prisma,
    databaseUrl: "postgresql://local:local@127.0.0.1:5432/local",
    disconnectTimeoutMilliseconds: 5,
    writeStderr: (value) => (stderr += value),
    writeStdout: (value) => (stdout += value)
  });

  const outcome = await Promise.race([
    execution.then((code) => ({ code, kind: "returned" })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "hung" }), 100))
  ]);

  assert.equal(outcome.kind, "returned");
  assert.equal(outcome.code, 0);
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).cycles.length, 2);
});

for (const [label, mutation] of [
  ["run id", { runId: "A".repeat(64) }],
  ["release SHA", { expectedReleaseSha: "b".repeat(39) }],
  ["image digest", { expectedImageDigest: "c".repeat(64) }],
  ["database identity", { expectedDatabaseIdentitySha256: "D".repeat(64) }],
  ["not-before", { notBefore: "2026-08-31" }],
  ["zero timeout", { timeoutSeconds: 0 }],
  ["oversized timeout", { timeoutSeconds: 901 }],
  ["fractional timeout", { timeoutSeconds: 1.5 }]
]) {
  test(`strictly rejects malformed ${label}`, () => {
    assertEvidenceCode(
      () => validateBillingMaintenanceCycleEvidenceOptions({ ...OPTIONS, ...mutation }),
      "BILLING_MAINTENANCE_OPTIONS_INVALID"
    );
  });
}

function completedFact(sequence) {
  const zeroCounts = Object.fromEntries(BILLING_MAINTENANCE_FORBIDDEN_KEYS.map((key) => [key, 0]));
  const offset = sequence === 1 ? 0 : 4;
  return {
    afterCounts: { ...zeroCounts },
    afterCountsSha256: independentHash(zeroCounts),
    beforeCounts: { ...zeroCounts },
    beforeCountsSha256: independentHash(zeroCounts),
    blockedCount: 0,
    completedAt: new Date(`2026-08-31T01:00:0${offset + 4}.000Z`),
    cycleStartedAt: new Date(`2026-08-31T01:00:0${offset + 1}.000Z`),
    databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
    enqueueCompletedAt: new Date(`2026-08-31T01:00:0${offset + 3}.000Z`),
    enqueueSummary: { dueCount: 0, enqueuedCount: 0 },
    evidenceRunId: RUN_ID,
    forbiddenDomainSetSha256: expectedForbiddenSetHash(),
    forbiddenDomainSetVersion: "stage1-acceptance-forbidden-domains/v1",
    id: `00000000-0000-4000-8000-00000000000${sequence}`,
    imageDigest: IMAGE_DIGEST,
    reconciliationCompletedAt: new Date(`2026-08-31T01:00:0${offset + 2}.000Z`),
    reconciliationSummary: {
      blockedCount: 0,
      blockerCodes: [],
      createdCount: 0,
      dryRun: false,
      eligibleCount: 0,
      existingCount: 0,
      leaseActivationCount: 0
    },
    releaseSha: RELEASE_SHA,
    sequence,
    status: "COMPLETED"
  };
}

function cliArguments() {
  return [
    "--run-id",
    RUN_ID,
    "--expected-release-sha",
    RELEASE_SHA,
    "--expected-image-digest",
    IMAGE_DIGEST,
    "--expected-database-identity-sha256",
    DATABASE_IDENTITY_SHA256,
    "--not-before",
    NOT_BEFORE,
    "--timeout-seconds",
    "1"
  ];
}

function independentHash(value) {
  return createHash("sha256").update(independentCanonicalJson(value), "utf8").digest("hex");
}

function independentCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${independentCanonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectedForbiddenSetHash() {
  return independentHash({
    domains: BILLING_MAINTENANCE_FORBIDDEN_DOMAINS,
    version: "stage1-acceptance-forbidden-domains/v1"
  });
}

function assertEvidenceCode(operation, code) {
  assert.throws(operation, (error) => error?.code === code);
}
