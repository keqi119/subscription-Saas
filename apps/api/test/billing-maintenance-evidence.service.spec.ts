import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { BillingAutomationService } from "../src/billing-automation/billing-automation.service";
import { BillingMaintenanceEvidenceRepository } from "../src/billing-automation/billing-maintenance-evidence.repository";
import { BillingMaintenanceEvidenceService } from "../src/billing-automation/billing-maintenance-evidence.service";
import {
  BILLING_MAINTENANCE_DATABASE_IDENTITY_VERSION,
  BillingMaintenanceEvidenceError,
  canonicalBillingMaintenanceJson
} from "../src/billing-automation/billing-maintenance-evidence.types";
import {
  BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
  BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION,
  BILLING_MAINTENANCE_FORBIDDEN_DOMAINS
} from "../src/billing-automation/billing-maintenance-forbidden-domains";

const RUN_ID = "a".repeat(64);
const RELEASE_SHA = "b".repeat(40);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const DATABASE_IDENTITY = {
  databaseName: "subscription_saas_stage1_task2",
  systemIdentifier: "7541900280213006521"
};
const DATABASE_IDENTITY_SHA256 = sha256(
  '{"databaseName":"subscription_saas_stage1_task2","systemIdentifier":"7541900280213006521","version":"billing-maintenance-database-identity/v1"}'
);
const TIMES = [
  new Date("2026-08-31T01:00:00.000Z"),
  new Date("2026-08-31T01:00:01.000Z"),
  new Date("2026-08-31T01:00:02.000Z"),
  new Date("2026-08-31T01:00:03.000Z")
];

describe("BillingMaintenanceEvidenceService", () => {
  it.each([undefined, "false", "TRUE", " true ", "1"])(
    "preserves ordinary maintenance without evidence snapshots when enabled=%s",
    async (enabled) => {
      const harness = createHarness({ enabled });

      const result = await harness.service.runMaintenance();

      expect(result.blockedCount).toBe(0);
      expect(harness.billing.reconcileSchedules).toHaveBeenCalledWith({ dryRun: false });
      expect(harness.billing.enqueueDueSchedules).toHaveBeenCalledOnce();
      expect(harness.repository.runInObservationTransaction).not.toHaveBeenCalled();
      expect(harness.repository.loadForbiddenCounts).not.toHaveBeenCalled();
    }
  );

  it("holds the run advisory lock while observing before/after facts around independent business operations", async () => {
    const harness = createHarness({ enabled: "true" });

    await harness.service.runMaintenance();

    expect(harness.calls).toEqual([
      "observation.begin",
      "advisory.lock",
      "database.identity",
      "facts.load",
      "database.time",
      "counts.before",
      "reconcile",
      "database.time",
      "enqueue",
      "database.time",
      "counts.after",
      "database.time",
      "fact.insert",
      "observation.end"
    ]);
    expect(harness.repository.acquireEvidenceRunLock).toHaveBeenCalledWith(harness.tx, RUN_ID);
    expect(harness.billing.reconcileSchedules).toHaveBeenCalledWith({ dryRun: false });
  });

  it("allocates only sequence 1 then 2 and keeps all source bindings exact", async () => {
    const first = createHarness({ enabled: "true" });
    await first.service.runMaintenance();
    expect(first.inserted[0]).toMatchObject({
      databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
      evidenceRunId: RUN_ID,
      forbiddenDomainSetSha256: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
      forbiddenDomainSetVersion: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION,
      imageDigest: IMAGE_DIGEST,
      releaseSha: RELEASE_SHA,
      sequence: 1,
      status: "COMPLETED"
    });

    const second = createHarness({ enabled: "true", facts: [completedFact(1)] });
    await second.service.runMaintenance();
    expect(second.inserted[0]?.sequence).toBe(2);
  });

  it("stores only counts and sorted blocker codes and hashes canonical count maps", async () => {
    const beforeCounts = { auditLog: 0, billingSchedule: 2, receivableBill: 1 };
    const afterCounts = { auditLog: 3, billingSchedule: 2, receivableBill: 1 };
    const secret = "orderId=order-secret customer=13800138000 token=token-secret /portal/bills/1";
    const harness = createHarness({
      afterCounts,
      beforeCounts,
      enabled: "true",
      reconciliation: {
        blockedCount: 3,
        createdCount: 1,
        dryRun: false,
        eligibleCount: 4,
        existingCount: 0,
        items: [
          {
            action: "BLOCKED",
            blockerCode: "Z_BLOCKER",
            orderId: secret,
            orderNo: secret,
            url: secret
          },
          {
            action: "BLOCKED",
            blockerCode: "A_BLOCKER",
            orderId: "another-secret",
            orderNo: "another-secret"
          },
          {
            action: "BLOCKED",
            blockerCode: "Z_BLOCKER",
            orderId: "duplicate-secret",
            orderNo: "duplicate-secret"
          }
        ],
        leaseActivationCount: 2
      }
    });

    await harness.service.runMaintenance();

    const fact = harness.inserted[0]!;
    expect(fact.blockedCount).toBe(3);
    expect(fact.reconciliationSummary).toEqual({
      blockedCount: 3,
      blockerCodes: ["A_BLOCKER", "Z_BLOCKER"],
      createdCount: 1,
      eligibleCount: 4,
      existingCount: 0,
      leaseActivationCount: 2
    });
    expect(fact.enqueueSummary).toEqual({ dueCount: 2, enqueuedCount: 1 });
    expect(JSON.stringify(fact)).not.toContain(secret);
    expect(JSON.stringify(fact)).not.toContain("orderId");
    expect(JSON.stringify(fact)).not.toContain("orderNo");
    expect(fact.beforeCountsSha256).toBe(
      sha256('{"auditLog":0,"billingSchedule":2,"receivableBill":1}')
    );
    expect(fact.afterCountsSha256).toBe(
      sha256('{"auditLog":3,"billingSchedule":2,"receivableBill":1}')
    );
  });

  it("uses a deterministic versioned hash for the queried database identity", async () => {
    const harness = createHarness({ enabled: "true" });

    await harness.service.runMaintenance();

    expect(BILLING_MAINTENANCE_DATABASE_IDENTITY_VERSION).toBe(
      "billing-maintenance-database-identity/v1"
    );
    expect(harness.inserted[0]?.databaseIdentitySha256).toBe(DATABASE_IDENTITY_SHA256);
    expect(
      canonicalBillingMaintenanceJson({
        version: BILLING_MAINTENANCE_DATABASE_IDENTITY_VERSION,
        systemIdentifier: DATABASE_IDENTITY.systemIdentifier,
        databaseName: DATABASE_IDENTITY.databaseName
      })
    ).toBe(
      '{"databaseName":"subscription_saas_stage1_task2","systemIdentifier":"7541900280213006521","version":"billing-maintenance-database-identity/v1"}'
    );
  });

  it.each([
    ["run id", { BILLING_MAINTENANCE_EVIDENCE_RUN_ID: "A".repeat(64) }],
    ["release sha", { BILLING_MAINTENANCE_EVIDENCE_RELEASE_SHA: "b".repeat(39) }],
    ["image digest", { BILLING_MAINTENANCE_EVIDENCE_IMAGE_DIGEST: "c".repeat(64) }],
    [
      "database identity hash",
      { BILLING_MAINTENANCE_EVIDENCE_DATABASE_IDENTITY_SHA256: "D".repeat(64) }
    ]
  ])("rejects a malformed %s before business maintenance", async (_label, overrides) => {
    const harness = createHarness({ enabled: "true", config: overrides });

    await expect(harness.service.runMaintenance()).rejects.toMatchObject({
      code: "BILLING_MAINTENANCE_EVIDENCE_CONFIGURATION_INVALID"
    });
    expect(harness.billing.reconcileSchedules).not.toHaveBeenCalled();
    expect(harness.repository.insertCompletedFact).not.toHaveBeenCalled();
  });

  it("rejects an actual database identity mismatch without leaking either hash", async () => {
    const expected = "d".repeat(64);
    const harness = createHarness({
      config: { BILLING_MAINTENANCE_EVIDENCE_DATABASE_IDENTITY_SHA256: expected },
      enabled: "true"
    });

    let thrown: unknown;
    try {
      await harness.service.runMaintenance();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BillingMaintenanceEvidenceError);
    expect(thrown).toMatchObject({ code: "BILLING_MAINTENANCE_DATABASE_IDENTITY_MISMATCH" });
    expect(String(thrown)).not.toContain(expected);
    expect(String(thrown)).not.toContain(DATABASE_IDENTITY_SHA256);
    expect(harness.billing.reconcileSchedules).not.toHaveBeenCalled();
  });

  it("rejects source drift between sequence 1 and 2", async () => {
    const harness = createHarness({
      enabled: "true",
      facts: [{ ...completedFact(1), imageDigest: `sha256:${"d".repeat(64)}` }]
    });

    await expect(harness.service.runMaintenance()).rejects.toMatchObject({
      code: "BILLING_MAINTENANCE_SOURCE_BINDING_CONFLICT"
    });
    expect(harness.billing.reconcileSchedules).not.toHaveBeenCalled();
    expect(harness.repository.loadForbiddenCounts).not.toHaveBeenCalled();
  });

  it("runs third-cycle maintenance while still holding the run lock without taking expensive snapshots", async () => {
    const harness = createHarness({
      enabled: "true",
      facts: [completedFact(1), completedFact(2)]
    });

    await harness.service.runMaintenance();

    expect(harness.billing.reconcileSchedules).toHaveBeenCalledWith({ dryRun: false });
    expect(harness.billing.enqueueDueSchedules).toHaveBeenCalledOnce();
    expect(harness.repository.loadForbiddenCounts).not.toHaveBeenCalled();
    expect(harness.repository.readDatabaseTime).not.toHaveBeenCalled();
    expect(harness.repository.insertCompletedFact).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([
      "observation.begin",
      "advisory.lock",
      "database.identity",
      "facts.load",
      "reconcile",
      "enqueue",
      "observation.end"
    ]);
  });

  it.each(["beforeSnapshot", "reconciliation", "enqueue", "afterSnapshot", "insert"] as const)(
    "does not complete a fact when %s fails",
    async (failure) => {
      const harness = createHarness({ enabled: "true", failure });

      await expect(harness.service.runMaintenance()).rejects.toThrow(
        `synthetic ${failure} failure`
      );

      if (failure === "insert") {
        expect(harness.persisted).toEqual([]);
      } else {
        expect(harness.repository.insertCompletedFact).not.toHaveBeenCalled();
      }
    }
  );
});

describe("BillingMaintenanceEvidenceRepository", () => {
  it("maps re-ordered count rows by delegate and returns authority order", async () => {
    const rows = validForbiddenCountRows().reverse();
    const repository = new BillingMaintenanceEvidenceRepository({} as never);
    const tx = { $queryRaw: vi.fn().mockResolvedValue(rows) };

    const counts = await repository.loadForbiddenCounts(tx as never);

    expect(Object.keys(counts)).toEqual(
      BILLING_MAINTENANCE_FORBIDDEN_DOMAINS.map(({ delegate }) => delegate)
    );
    expect(counts.customerVerificationCode).toBe(11);
    expect(counts.smsSendLog).toBe(22);
    expect(counts.auditLog).toBe(33);
  });

  it.each([
    ["missing", () => validForbiddenCountRows().slice(1)],
    [
      "duplicate",
      () => {
        const rows = validForbiddenCountRows();
        rows[1] = rows[0]!;
        return rows;
      }
    ],
    ["extra", () => [...validForbiddenCountRows(), { count: 0n, delegate: "unexpectedDelegate" }]]
  ])("rejects %s count rows", async (_case, rows) => {
    const repository = new BillingMaintenanceEvidenceRepository({} as never);
    const tx = { $queryRaw: vi.fn().mockResolvedValue(rows()) };

    await expect(repository.loadForbiddenCounts(tx as never)).rejects.toMatchObject({
      code: "BILLING_MAINTENANCE_DATABASE_RESPONSE_INVALID"
    });
  });
});

function createHarness(options: {
  afterCounts?: Record<string, number>;
  beforeCounts?: Record<string, number>;
  config?: Record<string, string>;
  enabled?: string;
  facts?: ReturnType<typeof completedFact>[];
  failure?: "beforeSnapshot" | "reconciliation" | "enqueue" | "afterSnapshot" | "insert";
  reconciliation?: Record<string, unknown>;
}) {
  const calls: string[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  const persisted: Array<Record<string, unknown>> = [];
  const tx = { kind: "observation-transaction" };
  let countReads = 0;
  let timeReads = 0;
  const billing = {
    enqueueDueSchedules: vi.fn(async () => {
      calls.push("enqueue");
      if (options.failure === "enqueue") throw new Error("synthetic enqueue failure");
      return { dueCount: 2, enqueuedCount: 1 };
    }),
    reconcileSchedules: vi.fn(async () => {
      calls.push("reconcile");
      if (options.failure === "reconciliation") {
        throw new Error("synthetic reconciliation failure");
      }
      return (
        options.reconciliation ?? {
          blockedCount: 0,
          createdCount: 0,
          dryRun: false,
          eligibleCount: 0,
          existingCount: 0,
          items: [],
          leaseActivationCount: 0
        }
      );
    })
  };
  const repository = {
    acquireEvidenceRunLock: vi.fn(async () => {
      calls.push("advisory.lock");
    }),
    findCompletedFacts: vi.fn(async () => {
      calls.push("facts.load");
      return options.facts ?? [];
    }),
    insertCompletedFact: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => {
      calls.push("fact.insert");
      inserted.push(input);
      if (options.failure === "insert") throw new Error("synthetic insert failure");
      persisted.push(input);
      return { id: "fact-id", ...input };
    }),
    loadDatabaseIdentity: vi.fn(async () => {
      calls.push("database.identity");
      return DATABASE_IDENTITY;
    }),
    loadForbiddenCounts: vi.fn(async () => {
      countReads += 1;
      calls.push(countReads === 1 ? "counts.before" : "counts.after");
      if (options.failure === "beforeSnapshot" && countReads === 1) {
        throw new Error("synthetic beforeSnapshot failure");
      }
      if (options.failure === "afterSnapshot" && countReads === 2) {
        throw new Error("synthetic afterSnapshot failure");
      }
      return countReads === 1
        ? (options.beforeCounts ?? { auditLog: 0 })
        : (options.afterCounts ?? { auditLog: 0 });
    }),
    readDatabaseTime: vi.fn(async () => {
      calls.push("database.time");
      const value = TIMES[timeReads];
      timeReads += 1;
      return value;
    }),
    runInObservationTransaction: vi.fn(async (operation: (value: unknown) => Promise<unknown>) => {
      calls.push("observation.begin");
      const result = await operation(tx);
      calls.push("observation.end");
      return result;
    })
  };
  const config = new ConfigService({
    BILLING_MAINTENANCE_EVIDENCE_DATABASE_IDENTITY_SHA256: DATABASE_IDENTITY_SHA256,
    BILLING_MAINTENANCE_EVIDENCE_ENABLED: options.enabled,
    BILLING_MAINTENANCE_EVIDENCE_IMAGE_DIGEST: IMAGE_DIGEST,
    BILLING_MAINTENANCE_EVIDENCE_RELEASE_SHA: RELEASE_SHA,
    BILLING_MAINTENANCE_EVIDENCE_RUN_ID: RUN_ID,
    ...options.config
  });
  const service = new BillingMaintenanceEvidenceService(
    billing as unknown as BillingAutomationService,
    repository as unknown as BillingMaintenanceEvidenceRepository,
    config
  );

  return { billing, calls, inserted, persisted, repository, service, tx };
}

function completedFact(sequence: 1 | 2) {
  return {
    databaseIdentitySha256: DATABASE_IDENTITY_SHA256,
    evidenceRunId: RUN_ID,
    forbiddenDomainSetSha256: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
    forbiddenDomainSetVersion: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION,
    imageDigest: IMAGE_DIGEST,
    releaseSha: RELEASE_SHA,
    sequence,
    status: "COMPLETED" as const
  };
}

function validForbiddenCountRows() {
  return BILLING_MAINTENANCE_FORBIDDEN_DOMAINS.map(({ delegate }) => ({
    count: BigInt(
      delegate === "customerVerificationCode"
        ? 11
        : delegate === "smsSendLog"
          ? 22
          : delegate === "auditLog"
            ? 33
            : 0
    ),
    delegate
  }));
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
