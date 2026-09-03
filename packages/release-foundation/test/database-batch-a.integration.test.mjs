import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { selectManifestSuites, sha256Canonical } from "../src/index.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const batchA = Object.freeze([
  [
    "api.asset-accounting.postgres",
    "apps/api/test/asset-accounting.repository.integration.spec.ts"
  ],
  ["api.asset-facts.postgres", "apps/api/test/asset-facts.repository.integration.spec.ts"],
  [
    "api.asset-operations.postgres",
    "apps/api/test/asset-operations.repository.integration.spec.ts"
  ],
  ["api.auto-debit-settlement.postgres", "apps/api/test/auto-debit-settlement.integration.spec.ts"],
  ["api.billing-automation.postgres", "apps/api/test/billing-automation.integration.spec.ts"],
  ["api.contract-segment.postgres", "apps/api/test/contract-segment.integration.spec.ts"],
  ["api.vehicle-availability.postgres", "apps/api/test/vehicle-availability.integration.spec.ts"],
  ["api.mileage-review.postgres", "apps/api/test/mileage-review-e2e.spec.ts"],
  ["api.sms.postgres", "apps/api/test/sms.integration.spec.ts"]
]);

async function loadManifest() {
  return JSON.parse(
    await readFile(resolve(repoRoot, "release/contracts/database-test-manifest.v1.json"), "utf8")
  );
}

test("batch A declares nine one-file suites with distinct assignments", async () => {
  const manifest = await loadManifest();
  const expectedIds = batchA.map(([suiteId]) => suiteId);
  const batch = manifest.batches.find(({ batchId }) => batchId === "batch-a");
  assert.deepEqual(batch?.suiteIds, expectedIds);
  for (const [suiteId, file] of batchA) {
    const suite = manifest.suites.find((candidate) => candidate.suiteId === suiteId);
    assert.deepEqual(suite?.files, [file]);
    assert.equal(suite?.parallelism.mode, "parallel");
  }

  const selections = selectManifestSuites({
    manifest,
    discoveryDigest: sha256Canonical({ discovery: "batch-a" }),
    discoveryUnclassifiedCount: 0,
    chain: "fresh",
    batchId: "batch-a",
    runId: "batch-a-run",
    secretRootRef: ".release-local/runs/batch-a-run"
  });
  assert.equal(new Set(selections.map(({ assignment }) => assignment.databaseName)).size, 9);
  assert.equal(
    new Set(selections.map(({ assignment }) => assignment.secretReferences["runtime-test"])).size,
    9
  );
});

test("batch A source files require the canonical launcher context without ambient fallback", async () => {
  for (const [, file] of batchA) {
    const source = await readFile(resolve(repoRoot, ...file.split("/")), "utf8");
    assert.match(source, /requiredReleaseDatabaseTestContext\(/);
    assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);
    assert.doesNotMatch(source, /postgres(?:ql)?:\/\//i);
    assert.doesNotMatch(source, /\b(?:test|it|describe)\.(?:skip|only)\s*\(/);
  }
});
