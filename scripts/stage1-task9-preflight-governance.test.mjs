import assert from "node:assert/strict";
import test from "node:test";

import { hashStage1CleanAcceptanceManifest } from "./stage1-clean-acceptance-baseline-core.mjs";
import { STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES } from "./stage1-clean-acceptance-baseline-snapshot.mjs";
import { readApprovedStage1AcceptanceManifest } from "./stage1-clean-acceptance-cli-core.mjs";
import {
  buildTask9ApprovalSummary,
  validateTask9DatabasePair,
  validateTask9DiscoverySelection
} from "./stage1-task9-preflight-governance.mjs";

const source =
  "postgresql://subscription_saas:secret@postgres:5432/subscription_saas_staging?schema=public";
const target =
  "postgresql://subscription_saas:secret@postgres:5432/subscription_saas_staging_acceptance_20260830t120000z?schema=public";
const vehicleId = "123e4567-e89b-42d3-a456-426614174000";

test("validates the exact source/target pair without exposing malformed credential URLs", () => {
  assert.deepEqual(
    validateTask9DatabasePair(
      source,
      target,
      "postgres",
      "subscription_saas",
      "subscription_saas_staging_acceptance_20260830t120000z"
    ),
    {
      code: "OK"
    }
  );
  const rejected = validateTask9DatabasePair(
    "postgresql://user:credential-leak@%",
    target,
    "postgres",
    "subscription_saas",
    "subscription_saas_staging_acceptance_20260830t120000z"
  );
  assert.notEqual(rejected.code, "OK");
  assert.doesNotMatch(JSON.stringify(rejected), /credential-leak/);
  assert.equal(
    validateTask9DatabasePair(
      source,
      target,
      "postgres",
      "subscription_saas",
      "subscription_saas_staging_acceptance_20260830t120001z"
    ).code,
    "TARGET_DATABASE_INVALID"
  );
});

test("requires one UUID candidate and canonical manifest hash with complete zero forbidden counts", () => {
  assert.deepEqual(
    validateTask9DiscoverySelection({ candidates: [{ id: vehicleId }] }, vehicleId),
    {
      code: "OK"
    }
  );
  assert.equal(
    validateTask9DiscoverySelection({ candidates: [] }, vehicleId).code,
    "VEHICLE_SELECTION_INVALID"
  );
  const manifest = { z: { b: 2, a: 1 }, a: ["b", { z: 1, a: 2 }] };
  const summary = buildTask9ApprovalSummary({
    safe: true,
    manifest: { ...manifest, safeToApply: true, exceptions: [] },
    manifestSha256: hashStage1CleanAcceptanceManifest({
      ...manifest,
      safeToApply: true,
      exceptions: []
    }),
    targetCountEvidence: { forbiddenCounts: expectedForbiddenCounts(), tableCounts: { users: 0 } }
  });
  assert.equal(summary.safe, true);
  assert.equal(summary.exceptionsCount, 0);
  assert.equal(
    summary.manifestSha256,
    hashStage1CleanAcceptanceManifest({ ...manifest, safeToApply: true, exceptions: [] })
  );
  assert.equal(
    buildTask9ApprovalSummary({
      safe: true,
      manifest: { safeToApply: true, exceptions: [] },
      manifestSha256: "a".repeat(64),
      targetCountEvidence: { forbiddenCounts: {} }
    }).code,
    "FORBIDDEN_COUNTS_INVALID"
  );
});

test("keeps Task 9 dry-run target-count evidence compatible with the approved-manifest reader", () => {
  const manifest = validManifest();
  const hash = hashStage1CleanAcceptanceManifest(manifest);
  const report = {
    manifest,
    manifestSha256: hash,
    mode: "dry-run",
    operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
    safe: true,
    targetCountEvidence: {
      forbiddenCountKeys: Object.keys(expectedForbiddenCounts()),
      forbiddenCounts: expectedForbiddenCounts(),
      tableCountKeys: ["user"],
      tableCounts: { user: 0 }
    }
  };
  assert.deepEqual(
    readApprovedStage1AcceptanceManifest(
      JSON.stringify(report),
      hash,
      hashStage1CleanAcceptanceManifest
    ),
    manifest
  );
});

test("rejects malformed or nonzero approved target-count evidence", () => {
  const manifest = validManifest();
  const hash = hashStage1CleanAcceptanceManifest(manifest);
  const valid = {
    forbiddenCountKeys: Object.keys(expectedForbiddenCounts()),
    forbiddenCounts: expectedForbiddenCounts(),
    tableCountKeys: ["user"],
    tableCounts: { user: 0 }
  };
  for (const evidence of [
    { ...valid, forbiddenCountKeys: [...valid.forbiddenCountKeys, valid.forbiddenCountKeys[0]] },
    { ...valid, forbiddenCounts: { ...valid.forbiddenCounts, extra: 0 } },
    { ...valid, tableCounts: [] },
    { ...valid, tableCounts: { user: 0.5 } },
    { ...valid, tableCounts: { user: 1 } }
  ]) {
    assert.throws(() =>
      readApprovedStage1AcceptanceManifest(
        JSON.stringify({
          manifest,
          manifestSha256: hash,
          mode: "dry-run",
          operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
          safe: true,
          targetCountEvidence: evidence
        }),
        hash,
        hashStage1CleanAcceptanceManifest
      )
    );
  }
});

function expectedForbiddenCounts() {
  return Object.fromEntries(STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES.map((key) => [key, 0]));
}

function validManifest() {
  return {
    schemaVersion: 1,
    operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
    gitSha: "b".repeat(40),
    imageRef: `registry.test/api@sha256:${"a".repeat(64)}`,
    source: digestContext(),
    target: digestContext(),
    selection: {
      adminDigest: "c".repeat(64),
      customerDigest: "d".repeat(64),
      vehicleDigests: ["e".repeat(64)]
    },
    counts: domains(0),
    rowDigests: domains("f".repeat(64)),
    exceptions: [],
    safeToApply: true,
    generatedAt: "2026-08-30T12:00:00.000Z",
    hashSalt: "f".repeat(64)
  };
}
function digestContext() {
  return {
    databaseDigest: "a".repeat(64),
    migrationCatalogDigest: "b".repeat(64),
    schemaDigest: "c".repeat(64)
  };
}
function domains(value) {
  return Object.fromEntries(
    ["access", "catalog", "customer", "templates", "vehicle"].map((key) => [key, value])
  );
}
