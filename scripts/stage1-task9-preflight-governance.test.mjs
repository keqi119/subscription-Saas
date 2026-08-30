import assert from "node:assert/strict";
import test from "node:test";

import { hashStage1CleanAcceptanceManifest } from "./stage1-clean-acceptance-baseline-core.mjs";
import { STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES } from "./stage1-clean-acceptance-baseline-snapshot.mjs";
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
  assert.deepEqual(validateTask9DatabasePair(source, target, "postgres", "subscription_saas"), {
    code: "OK"
  });
  const rejected = validateTask9DatabasePair(
    "postgresql://user:credential-leak@%",
    target,
    "postgres",
    "subscription_saas"
  );
  assert.notEqual(rejected.code, "OK");
  assert.doesNotMatch(JSON.stringify(rejected), /credential-leak/);
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

function expectedForbiddenCounts() {
  return Object.fromEntries(STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES.map((key) => [key, 0]));
}
