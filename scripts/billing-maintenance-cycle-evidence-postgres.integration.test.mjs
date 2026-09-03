import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { requiredReleaseDatabaseTestContext } from "../packages/release-foundation/src/index.mjs";

import {
  BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
  BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION,
  BILLING_MAINTENANCE_FORBIDDEN_KEYS,
  hashBillingMaintenanceEvidenceDatabaseIdentity,
  hashBillingMaintenanceEvidenceValue
} from "./billing-maintenance-cycle-evidence-core.mjs";
import { createStage1AcceptancePrismaClient } from "./stage1-clean-acceptance-cli-core.mjs";

const BILLING_DATABASE = requiredReleaseDatabaseTestContext(import.meta.url);
const DATABASE_URL = BILLING_DATABASE.databaseUrl;
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(
  new URL("./billing-maintenance-cycle-evidence.mjs", import.meta.url)
);
const RELEASE_SHA = "b".repeat(40);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;

test("exports two real migrated facts and fails closed on mutation and source drift", async () => {
  const prisma = await createStage1AcceptancePrismaClient(DATABASE_URL, "billing-evidence", {
    repoRoot: REPOSITORY_ROOT
  });
  const evidenceRunId = randomBytes(32).toString("hex");
  try {
    const [identity] = await prisma.$queryRawUnsafe(
      'SELECT current_database() AS "databaseName", (pg_control_system()).system_identifier::text AS "systemIdentifier"'
    );
    assert.equal(identity.databaseName, BILLING_DATABASE.databaseName);
    assert.match(identity.systemIdentifier, /^[0-9]+$/);
    const databaseIdentitySha256 = hashBillingMaintenanceEvidenceDatabaseIdentity(identity);
    const beforeCounts = Object.fromEntries(
      BILLING_MAINTENANCE_FORBIDDEN_KEYS.map((key) => [key, 0])
    );
    const countsSha256 = hashBillingMaintenanceEvidenceValue(beforeCounts);
    const base = Date.now() - 30_000;
    const notBefore = new Date(base).toISOString();

    for (const sequence of [1, 2]) {
      const offset = sequence === 1 ? 0 : 4_000;
      await prisma.billingMaintenanceCycleFact.create({
        data: {
          afterCounts: beforeCounts,
          afterCountsSha256: countsSha256,
          beforeCounts,
          beforeCountsSha256: countsSha256,
          blockedCount: 0,
          completedAt: new Date(base + offset + 4_000),
          createdAt: new Date(base + offset + 4_000),
          cycleStartedAt: new Date(base + offset + 1_000),
          databaseIdentitySha256,
          enqueueCompletedAt: new Date(base + offset + 3_000),
          enqueueSummary: { dueCount: 0, enqueuedCount: 0 },
          evidenceRunId,
          forbiddenDomainSetSha256: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_SHA256,
          forbiddenDomainSetVersion: BILLING_MAINTENANCE_FORBIDDEN_DOMAIN_SET_VERSION,
          imageDigest: IMAGE_DIGEST,
          reconciliationCompletedAt: new Date(base + offset + 2_000),
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
        }
      });
    }

    const facts = await prisma.billingMaintenanceCycleFact.findMany({
      orderBy: { sequence: "asc" },
      where: { evidenceRunId }
    });
    assert.equal(facts.length, 2);
    assert.deepEqual(
      facts.map(({ sequence }) => sequence),
      [1, 2]
    );

    const success = runCli({
      databaseIdentitySha256,
      evidenceRunId,
      notBefore,
      releaseSha: RELEASE_SHA
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stderr, "");
    const evidence = JSON.parse(success.stdout);
    assert.equal(evidence.safe, true);
    assert.equal(evidence.source.evidenceRunId, evidenceRunId);
    assert.deepEqual(
      evidence.cycles.map(({ sequence }) => sequence),
      [1, 2]
    );
    assert.ok(evidence.cycles.every((cycle) => cycle.reconciliationSummary.dryRun === false));

    await assert.rejects(
      prisma.billingMaintenanceCycleFact.update({
        data: { blockedCount: 1 },
        where: { id: facts[0].id }
      }),
      (error) => databaseErrorCode(error) === "55000"
    );
    await assert.rejects(
      prisma.billingMaintenanceCycleFact.delete({ where: { id: facts[0].id } }),
      (error) => databaseErrorCode(error) === "55000"
    );

    const mismatch = runCli({
      databaseIdentitySha256,
      evidenceRunId,
      notBefore,
      releaseSha: "e".repeat(40)
    });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /BILLING_MAINTENANCE_SOURCE_BINDING_MISMATCH/);
    assert.doesNotMatch(
      `${mismatch.stdout}\n${mismatch.stderr}`,
      /postgresql:|subscription:subscription/
    );
  } finally {
    await prisma.$disconnect();
  }
});

function runCli({ databaseIdentitySha256, evidenceRunId, notBefore, releaseSha }) {
  return spawnSync(
    process.execPath,
    [
      CLI_PATH,
      "--run-id",
      evidenceRunId,
      "--expected-release-sha",
      releaseSha,
      "--expected-image-digest",
      IMAGE_DIGEST,
      "--expected-database-identity-sha256",
      databaseIdentitySha256,
      "--not-before",
      notBefore,
      "--timeout-seconds",
      "1"
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL },
      timeout: 15_000
    }
  );
}

function databaseErrorCode(error) {
  return collectStrings(error).find((value) => ["55000"].includes(value));
}

function collectStrings(value, seen = new WeakSet()) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((child) => collectStrings(child, seen));
}
