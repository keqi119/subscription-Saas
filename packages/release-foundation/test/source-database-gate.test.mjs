import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { runSourceDatabaseGate, selectManifestSuites, sha256Canonical } from "../src/index.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const batchC = Object.freeze([
  ["api.subscription-closure-schema.postgres", "apps/api/test/subscription-closure.schema.spec.ts"],
  [
    "api.subscription-closure-repository.postgres",
    "apps/api/test/subscription-closure.repository.integration.spec.ts"
  ],
  [
    "api.subscription-change-active-order.postgres",
    "apps/api/test/subscription-change-active-order.e2e-spec.ts"
  ],
  [
    "api.subscription-change-migration.postgres",
    "apps/api/test/subscription-change-migration.integration.spec.ts"
  ],
  [
    "api.subscription-extension.postgres",
    "apps/api/test/subscription-extension.integration.spec.ts"
  ],
  [
    "api.subscription-early-termination-change.postgres",
    "apps/api/test/subscription-early-termination-change.e2e-spec.ts"
  ],
  [
    "api.subscription-vehicle-swap.postgres",
    "apps/api/test/subscription-vehicle-swap.integration.spec.ts"
  ],
  [
    "api.subscription-vehicle-swap-e2e.postgres",
    "apps/api/test/subscription-vehicle-swap.e2e-spec.ts"
  ],
  [
    "api.subscription-vehicle-swap-failure-injection.postgres",
    "apps/api/test/subscription-vehicle-swap-failure-injection.spec.ts"
  ]
]);
const launcherBoundLegacySuites = Object.freeze([
  "apps/api/test/billing-maintenance-evidence-postgres.integration.spec.ts",
  "scripts/billing-maintenance-cycle-evidence-postgres.integration.test.mjs",
  "scripts/stage1-p0-subscription-closure-reconciliation.test.mjs"
]);

async function loadManifest() {
  return JSON.parse(
    await readFile(resolve(repoRoot, "release/contracts/database-test-manifest.v1.json"), "utf8")
  );
}

test("batch C declares nine one-file suites and source gate derives the manifest universe", async () => {
  const manifest = await loadManifest();
  const batch = manifest.batches.find(({ batchId }) => batchId === "batch-c");
  assert.deepEqual(
    batch?.suiteIds,
    batchC.map(([suiteId]) => suiteId)
  );
  for (const [suiteId, file] of batchC) {
    const suite = manifest.suites.find((candidate) => candidate.suiteId === suiteId);
    assert.deepEqual(suite?.files, [file]);
    assert.equal(suite?.databaseRole, "runtime-equivalent-test");
  }

  const selected = selectManifestSuites({
    manifest,
    discoveryDigest: sha256Canonical({ discovery: "source-gate" }),
    discoveryUnclassifiedCount: 0,
    chain: "fresh",
    suiteIds: manifest.suites.map(({ suiteId }) => suiteId),
    runId: "source-gate-run",
    secretRootRef: ".release-local/runs/source-gate-run"
  });
  assert.deepEqual(
    selected.map(({ suiteId }) => suiteId),
    manifest.suites.map(({ suiteId }) => suiteId)
  );

  for (const [, file] of batchC) {
    const source = await readFile(resolve(repoRoot, ...file.split("/")), "utf8");
    assert.match(source, /requiredReleaseDatabaseTestContext\(/);
    assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);
    assert.doesNotMatch(source, /session_replication_role/);
    assert.doesNotMatch(source, /\b(?:test|it|describe)\.(?:skip|only)\s*\(/);
  }
});

test("source gate rejects an incomplete aggregate count equation", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const suiteReport = {
    schemaVersion: "database-suite-report.v1",
    operationId: "source-gate-operation",
    runId: "source-gate-run",
    suiteId: "source-gate-suite",
    chain: "fresh",
    manifestDigest: digest,
    discoveryDigest: digest,
    target: {
      databaseName: `s1ci_${"a".repeat(24)}`,
      databaseOid: "19001",
      targetFingerprint: digest,
      roleAttributes: { superuser: false, createdb: false, createrole: false, bypassrls: false },
      canCreateSchema: false,
      schemaOwner: false,
      objectOwner: false
    },
    counts: {
      collected: 1,
      selected: 1,
      executed: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      todo: 0,
      filtered: 0,
      cancelled: 0
    },
    sanitizedLogDigest: digest,
    terminalStatus: "PASSED"
  };
  assert.throws(
    () =>
      runSourceDatabaseGate({
        manifestReport: {
          schemaVersion: "database-test-manifest-report.v1",
          runId: "source-gate-run",
          chain: "fresh",
          manifestDigest: digest,
          discoveryDigest: digest,
          suiteReports: [suiteReport],
          counts: {
            collected: 2,
            selected: 2,
            executed: 1,
            passed: 1,
            failed: 0,
            skipped: 0,
            todo: 0,
            filtered: 0,
            cancelled: 0
          },
          sanitizedLogDigest: digest,
          terminalStatus: "PASSED"
        },
        sourceSha: "a".repeat(40),
        migrationCatalogDigest: digest,
        repositoryContractDigest: digest,
        postgres: { imageDigest: digest, serverVersionNum: "170006" },
        schemaDiffDigest: digest,
        migrationStatusDigest: digest,
        provenance: {
          generatedAt: "2026-09-02T08:00:00.000Z",
          ciRunRef: "local-controlled://source-gate-run",
          executorVersion: "source-database-gate.v1"
        }
      }),
    { code: "DATABASE_TEST_COUNT_EQUATION_FAILED" }
  );
});

test("legacy PostgreSQL suites fail closed unless the release launcher injects their target", async () => {
  for (const file of launcherBoundLegacySuites) {
    const source = await readFile(resolve(repoRoot, ...file.split("/")), "utf8");
    assert.match(source, /requiredReleaseDatabaseTestContext\(/);
    assert.doesNotMatch(source, /requiredDisposableDatabase\(/);
    assert.doesNotMatch(source, /\{\s*skip\s*:/);
    assert.doesNotMatch(source, /\b(?:test|it|describe)\.(?:skip|only)\s*\(/);
  }
});

test("fixture loading is anchored to the repository instead of the caller working directory", async () => {
  const source = await readFile(
    resolve(repoRoot, "scripts/release/database-test-launcher-runtime.mjs"),
    "utf8"
  );
  for (const loader of ["runSchemaFixture", "runRuntimeSeedFixture"]) {
    const callStart = source.indexOf(`${loader}({`);
    assert.notEqual(callStart, -1, `${loader} call is missing`);
    assert.match(source.slice(callStart, callStart + 500), /\brepoRoot,/);
  }
});
