import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { selectManifestSuites, sha256Canonical } from "../src/index.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const batchB = Object.freeze([
  ["api.stage2-handover-pdf.postgres", "apps/api/test/stage2-handover-pdf.integration.spec.ts"],
  [
    "api.stage2-handover-provider-reconciliation.postgres",
    "apps/api/test/stage2-handover-provider-reconciliation.integration.spec.ts"
  ],
  [
    "api.stage2-handover-workflow.postgres",
    "apps/api/test/stage2-handover-workflow.repository.spec.ts"
  ],
  [
    "api.subscription-expiry-return.postgres",
    "apps/api/test/subscription-expiry-return.integration.spec.ts"
  ],
  [
    "api.subscription-journey-failure-recovery.postgres",
    "apps/api/test/subscription-journey-failure-recovery.e2e-spec.ts"
  ],
  [
    "api.subscription-journey-golden-path.postgres",
    "apps/api/test/subscription-journey-golden-path.e2e-spec.ts"
  ],
  [
    "api.subscription-journey-integrity.postgres",
    "apps/api/test/subscription-journey-integrity.integration.spec.ts"
  ],
  [
    "api.subscription-journey-repository.postgres",
    "apps/api/test/subscription-journey.repository.integration.spec.ts"
  ]
]);

async function loadManifest() {
  return JSON.parse(
    await readFile(resolve(repoRoot, "release/contracts/database-test-manifest.v1.json"), "utf8")
  );
}

test("batch B declares eight isolated one-file suites", async () => {
  const manifest = await loadManifest();
  const expectedIds = batchB.map(([suiteId]) => suiteId);
  const batch = manifest.batches.find(({ batchId }) => batchId === "batch-b");
  assert.deepEqual(batch?.suiteIds, expectedIds);

  for (const [suiteId, file] of batchB) {
    const suite = manifest.suites.find((candidate) => candidate.suiteId === suiteId);
    assert.deepEqual(suite?.files, [file]);
    assert.equal(suite?.parallelism.mode, "parallel");
  }

  const selections = selectManifestSuites({
    manifest,
    discoveryDigest: sha256Canonical({ discovery: "batch-b" }),
    discoveryUnclassifiedCount: 0,
    chain: "fresh",
    batchId: "batch-b",
    runId: "batch-b-run",
    secretRootRef: ".release-local/runs/batch-b-run"
  });
  assert.equal(new Set(selections.map(({ assignment }) => assignment.databaseName)).size, 8);
  const concurrentJourneySelections = selections.filter(({ suiteId }) =>
    [
      "api.subscription-journey-golden-path.postgres",
      "api.subscription-journey-integrity.postgres"
    ].includes(suiteId)
  );
  assert.equal(concurrentJourneySelections.length, 2);
  assert.notEqual(
    concurrentJourneySelections[0].assignment.databaseName,
    concurrentJourneySelections[1].assignment.databaseName
  );
});

test("batch B source files use only the injected runtime-equivalent database", async () => {
  for (const [, file] of batchB) {
    const source = await readFile(resolve(repoRoot, ...file.split("/")), "utf8");
    assert.match(source, /requiredReleaseDatabaseTestContext\(/);
    assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);
    assert.doesNotMatch(source, /postgres(?:ql)?:\/\//i);
    assert.doesNotMatch(source, /session_replication_role/);
    assert.doesNotMatch(source, /\b(?:test|it|describe)\.(?:skip|only)\s*\(/);
  }
});
