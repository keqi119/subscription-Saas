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
