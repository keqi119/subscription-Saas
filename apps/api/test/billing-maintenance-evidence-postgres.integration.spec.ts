import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BillingAutomationService } from "../src/billing-automation/billing-automation.service";
import { BILLING_MAINTENANCE_FORBIDDEN_DOMAINS } from "../src/billing-automation/billing-maintenance-forbidden-domains";
import { BillingMaintenanceEvidenceRepository } from "../src/billing-automation/billing-maintenance-evidence.repository";
import { BillingMaintenanceEvidenceService } from "../src/billing-automation/billing-maintenance-evidence.service";
import { hashBillingMaintenanceDatabaseIdentity } from "../src/billing-automation/billing-maintenance-evidence.types";
import { PrismaService } from "../src/prisma/prisma.service";

const DATABASE_URL = requiredDisposableDatabaseUrl();
const RELEASE_SHA = "b".repeat(40);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;

describe("BillingMaintenanceEvidence PostgreSQL behavior", () => {
  let databaseIdentitySha256: string;
  let prisma: PrismaService;
  let repository: BillingMaintenanceEvidenceRepository;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL }));
    await prisma.onModuleInit();
    repository = new BillingMaintenanceEvidenceRepository(prisma);
    const identity = await repository.runInObservationTransaction((tx) =>
      repository.loadDatabaseIdentity(tx)
    );
    databaseIdentitySha256 = hashBillingMaintenanceDatabaseIdentity(identity);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("is connected to the exact approved disposable database", async () => {
    const identity = await repository.runInObservationTransaction((tx) =>
      repository.loadDatabaseIdentity(tx)
    );

    expect(identity.databaseName).toBe("subscription_saas_stage1_task2_20260831_01");
    expect(identity.systemIdentifier).toMatch(/^[0-9]+$/);
  });

  it("counts the exact versioned forbidden set while excluding its own fact table", async () => {
    const counts = await repository.runInObservationTransaction((tx) =>
      repository.loadForbiddenCounts(tx)
    );

    expect(Object.keys(counts)).toEqual(
      BILLING_MAINTENANCE_FORBIDDEN_DOMAINS.map(({ delegate }) => delegate)
    );
    expect(Object.keys(counts)).not.toContain("billingMaintenanceCycleFact");
    expect(Object.values(counts).every((count) => Number.isSafeInteger(count) && count >= 0)).toBe(
      true
    );
  });

  it("accepts the minimal public-safe completed summaries", async () => {
    const [row] = await prisma.$queryRaw<Array<Record<string, boolean>>>(Prisma.sql`
      WITH summary AS (
        SELECT ${JSON.stringify({
          blockedCount: 0,
          blockerCodes: [],
          createdCount: 0,
          eligibleCount: 0,
          existingCount: 0,
          leaseActivationCount: 0
        })}::jsonb AS value
      )
      SELECT
        billing_maintenance_reconciliation_summary_is_valid(
          value,
          0
        ) AS "reconciliationValid",
        billing_maintenance_enqueue_summary_is_valid(
          ${JSON.stringify({ dueCount: 0, enqueuedCount: 0 })}::jsonb
        ) AS "enqueueValid",
        jsonb_typeof(value) = 'object' AS "objectValid",
        value ?& ARRAY[
          'blockedCount', 'blockerCodes', 'createdCount', 'eligibleCount',
          'existingCount', 'leaseActivationCount'
        ] AS "requiredKeysValid",
        (value - ARRAY[
          'blockedCount', 'blockerCodes', 'createdCount', 'eligibleCount',
          'existingCount', 'leaseActivationCount'
        ]) = '{}'::jsonb AS "extraKeysValid",
        billing_maintenance_json_nonnegative_integer(value -> 'blockedCount')
          AS "blockedCountValid",
        (value ->> 'blockedCount')::integer = 0 AS "blockedCountMatches",
        jsonb_typeof(value -> 'blockerCodes') = 'array' AS "blockerCodesValid",
        (
          SELECT COALESCE(jsonb_agg(to_jsonb(code) ORDER BY code), '[]'::jsonb)
          FROM (
            SELECT DISTINCT jsonb_array_elements_text(value -> 'blockerCodes') AS code
          ) AS codes
        ) = value -> 'blockerCodes' AS "normalizedCodesValid"
      FROM summary
    `);

    expect(row).toEqual({
      blockedCountMatches: true,
      blockedCountValid: true,
      blockerCodesValid: true,
      enqueueValid: true,
      extraKeysValid: true,
      normalizedCodesValid: true,
      objectValid: true,
      reconciliationValid: true,
      requiredKeysValid: true
    });
  });

  it("serializes concurrent producers on the run lock and allocates only sequence 1 then 2", async () => {
    const evidenceRunId = randomRunId();
    const firstReconciliationStarted = deferred<void>();
    const releaseFirstReconciliation = deferred<void>();
    let reconciliationCalls = 0;
    const billing = billingDouble(async () => {
      reconciliationCalls += 1;
      if (reconciliationCalls === 1) {
        firstReconciliationStarted.resolve();
        await releaseFirstReconciliation.promise;
      }
    });
    const first = evidenceService(billing, evidenceRunId);
    const second = evidenceService(billing, evidenceRunId);

    const firstResult = first.runMaintenance();
    await firstReconciliationStarted.promise;
    const secondResult = second.runMaintenance();
    expect(await waitForAdvisoryWait(prisma)).toBe(true);
    expect(reconciliationCalls).toBe(1);

    releaseFirstReconciliation.resolve();
    await Promise.all([firstResult, secondResult]);

    const facts = await prisma.billingMaintenanceCycleFact.findMany({
      orderBy: { sequence: "asc" },
      where: { evidenceRunId }
    });
    expect(facts.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(new Set(facts.map(({ id }) => id)).size).toBe(2);
    expect(facts[0]!.completedAt.getTime()).toBeLessThanOrEqual(facts[1]!.cycleStartedAt.getTime());
    expect(
      facts.every(
        ({ beforeCounts, afterCounts }) =>
          JSON.stringify(beforeCounts) === JSON.stringify(afterCounts)
      )
    ).toBe(true);
  });

  it("rolls back an invalid final insert after independently completed business calls", async () => {
    const evidenceRunId = randomRunId();
    const billing = billingDouble();
    const invalidRepository = Object.create(repository) as BillingMaintenanceEvidenceRepository;
    invalidRepository.insertCompletedFact = vi.fn(async (tx, input) =>
      tx.billingMaintenanceCycleFact.create({
        data: {
          ...input,
          beforeCounts: []
        }
      })
    );
    const service = new BillingMaintenanceEvidenceService(
      billing as unknown as BillingAutomationService,
      invalidRepository,
      evidenceConfig(evidenceRunId)
    );

    await expectDatabaseCode(service.runMaintenance(), "23514");

    expect(billing.reconcileSchedules).toHaveBeenCalledOnce();
    expect(billing.enqueueDueSchedules).toHaveBeenCalledOnce();
    await expect(
      prisma.billingMaintenanceCycleFact.count({ where: { evidenceRunId } })
    ).resolves.toBe(0);
  });

  it("enforces uniqueness, sequence, source, time, JSON-object, privacy, and append-only constraints", async () => {
    const evidenceRunId = randomRunId();
    await evidenceService(billingDouble(), evidenceRunId).runMaintenance();
    const fact = await prisma.billingMaintenanceCycleFact.findUniqueOrThrow({
      where: { evidenceRunId_sequence: { evidenceRunId, sequence: 1 } }
    });

    await expectDatabaseCode(
      prisma.$executeRaw(Prisma.sql`
        INSERT INTO "billing_maintenance_cycle_fact"
        SELECT gen_random_uuid(), "status", "evidence_run_id", "sequence", "release_sha",
          "image_digest", "database_identity_sha256", "forbidden_domain_set_version",
          "forbidden_domain_set_sha256", "cycle_started_at", "reconciliation_completed_at",
          "enqueue_completed_at", "completed_at", "blocked_count", "reconciliation_summary",
          "enqueue_summary", "before_counts", "before_counts_sha256", "after_counts",
          "after_counts_sha256", "created_at"
        FROM "billing_maintenance_cycle_fact" WHERE "id" = ${fact.id}::uuid
      `),
      "23505"
    );
    await expectCloneConstraint(prisma, fact.id, randomRunId(), Prisma.sql`3`, "sequence");
    await expectCloneConstraint(
      prisma,
      fact.id,
      randomRunId(),
      Prisma.sql`${"B".repeat(40)}`,
      "release"
    );
    await expectCloneConstraint(
      prisma,
      fact.id,
      randomRunId(),
      Prisma.sql`"reconciliation_completed_at" - interval '1 second'`,
      "enqueue_time"
    );
    await expectCloneConstraint(prisma, fact.id, randomRunId(), Prisma.sql`'[]'::jsonb`, "counts");
    await expectCloneConstraint(
      prisma,
      fact.id,
      randomRunId(),
      Prisma.sql`"reconciliation_summary" || '{"items":[]}'::jsonb`,
      "summary"
    );

    await expectDatabaseCode(
      prisma.$executeRaw`UPDATE "billing_maintenance_cycle_fact" SET "blocked_count" = 1 WHERE "id" = ${fact.id}::uuid`,
      "55000"
    );
    await expectDatabaseCode(
      prisma.$executeRaw`DELETE FROM "billing_maintenance_cycle_fact" WHERE "id" = ${fact.id}::uuid`,
      "55000"
    );
  });

  function evidenceService(billing: ReturnType<typeof billingDouble>, evidenceRunId: string) {
    return new BillingMaintenanceEvidenceService(
      billing as unknown as BillingAutomationService,
      repository,
      evidenceConfig(evidenceRunId)
    );
  }

  function evidenceConfig(evidenceRunId: string) {
    return new ConfigService({
      BILLING_MAINTENANCE_EVIDENCE_DATABASE_IDENTITY_SHA256: databaseIdentitySha256,
      BILLING_MAINTENANCE_EVIDENCE_ENABLED: "true",
      BILLING_MAINTENANCE_EVIDENCE_IMAGE_DIGEST: IMAGE_DIGEST,
      BILLING_MAINTENANCE_EVIDENCE_RELEASE_SHA: RELEASE_SHA,
      BILLING_MAINTENANCE_EVIDENCE_RUN_ID: evidenceRunId
    });
  }
});

function billingDouble(beforeReconciliation = async () => undefined) {
  return {
    enqueueDueSchedules: vi.fn(async () => ({ dueCount: 0, enqueuedCount: 0 })),
    reconcileSchedules: vi.fn(async () => {
      await beforeReconciliation();
      return {
        blockedCount: 0,
        createdCount: 0,
        dryRun: false,
        eligibleCount: 0,
        existingCount: 0,
        items: [],
        leaseActivationCount: 0
      };
    })
  };
}

async function expectCloneConstraint(
  prisma: PrismaService,
  factId: string,
  evidenceRunId: string,
  replacement: Prisma.Sql,
  target: "counts" | "enqueue_time" | "release" | "sequence" | "summary"
) {
  const sequence = target === "sequence" ? replacement : Prisma.sql`"sequence"`;
  const release = target === "release" ? replacement : Prisma.sql`"release_sha"`;
  const enqueueTime = target === "enqueue_time" ? replacement : Prisma.sql`"enqueue_completed_at"`;
  const counts = target === "counts" ? replacement : Prisma.sql`"before_counts"`;
  const summary = target === "summary" ? replacement : Prisma.sql`"reconciliation_summary"`;
  await expectDatabaseCode(
    prisma.$executeRaw(Prisma.sql`
      INSERT INTO "billing_maintenance_cycle_fact"
      SELECT gen_random_uuid(), "status", ${evidenceRunId}, ${sequence}, ${release},
        "image_digest", "database_identity_sha256", "forbidden_domain_set_version",
        "forbidden_domain_set_sha256", "cycle_started_at", "reconciliation_completed_at",
        ${enqueueTime}, "completed_at", "blocked_count", ${summary}, "enqueue_summary",
        ${counts}, "before_counts_sha256", "after_counts", "after_counts_sha256", "created_at"
      FROM "billing_maintenance_cycle_fact" WHERE "id" = ${factId}::uuid
    `),
    "23514"
  );
}

async function expectDatabaseCode(promise: Promise<unknown>, expected: string) {
  try {
    await promise;
    throw new Error(`Expected PostgreSQL error ${expected}`);
  } catch (error) {
    expect(databaseErrorCode(error)).toBe(expected);
  }
}

function databaseErrorCode(error: unknown) {
  return collectStrings(error).find((value) => ["23505", "23514", "55000"].includes(value));
}

function collectStrings(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value as Record<string, unknown>).flatMap((child) =>
    collectStrings(child, seen)
  );
}

async function waitForAdvisoryWait(prisma: PrismaService) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await prisma.$queryRaw<Array<{ waiting: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "waiting"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `);
    if (Number(row?.waiting) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function randomRunId() {
  return randomBytes(32).toString("hex");
}

function requiredDisposableDatabaseUrl(value = process.env.DATABASE_URL) {
  if (!value) throw new Error("DATABASE_URL is required for billing evidence integration tests");
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Billing evidence integration tests require a loopback database");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (databaseName !== "subscription_saas_stage1_task2_20260831_01") {
    throw new Error(
      "Billing evidence integration tests require subscription_saas_stage1_task2_20260831_01"
    );
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}
