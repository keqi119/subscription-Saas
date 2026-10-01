import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFixedManualOperation } from "../../../../scripts/release/manual-stage1-trust.mjs";
import { launchManualStage1 } from "../../../../scripts/release/launch-manual-stage1.mjs";
import { verifyManualRunnerResult } from "../../../../scripts/release/verify-manual-runner-result.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INPUT_CODES = new Set([
  "H1_INPUT_UNAVAILABLE",
  "MANUAL_OPERATION_INPUT_UNAVAILABLE",
  "TRUSTED_BUILD_UNAVAILABLE",
  "MANUAL_BUILD_CUSTODY_INPUT_REQUIRED",
  "H3_INPUT_UNAVAILABLE",
  "MANUAL_H3_B_INPUT_REQUIRED",
  "MANUAL_EXPECTED_SCHEMA_INPUT_REQUIRED"
]);
function realInputRequired(cause) {
  throw Object.assign(new Error("MANUAL_REAL_GATE_INPUT_REQUIRED", { cause }), {
    code: "MANUAL_REAL_GATE_INPUT_REQUIRED"
  });
}
function rejectInputFailure(cause) {
  if (INPUT_CODES.has(cause?.code)) realInputRequired(cause);
  throw cause;
}

test("manual migration uses the fixed approved operation and archives its actual apply", async (t) => {
  const operationRef = process.env.STAGE1_MANUAL_OPERATION_REF;
  if (typeof operationRef !== "string" || !UUID.test(operationRef)) realInputRequired();
  const fixed = await readFixedManualOperation({ repoRoot, operationRef }).catch(
    rejectInputFailure
  );
  const scenario = fixed.operation.scenario;
  assert.ok(["normal", "apply-interrupted"].includes(scenario));
  let interruptedError;
  try {
    const launched = await launchManualStage1({ operationRef, allowedStage: "migration" });
    assert.equal(scenario, "normal", "interrupted scenario must retain its original apply UNKNOWN");
    assert.deepEqual(Object.keys(launched).sort(), [
      "apply",
      "dryRun",
      "operationRef",
      "promotionEligible"
    ]);
    assert.equal(launched.operationRef, operationRef);
    assert.equal(launched.promotionEligible, false);
  } catch (cause) {
    if (scenario !== "apply-interrupted" || cause?.code !== "MANUAL_EVIDENCE_INCOMPLETE") {
      rejectInputFailure(cause);
    }
    interruptedError = cause;
  }
  // This fresh production verifier must prove the exact original interrupted apply;
  // catching the launcher error alone never makes this test successful.
  const result = await verifyManualRunnerResult({ operationRef }).catch(rejectInputFailure);
  const reopened = await readFixedManualOperation({ repoRoot, operationRef }).catch(
    rejectInputFailure
  );
  assert.equal(reopened.indexDigest, fixed.indexDigest);
  assert.deepEqual(reopened.operation, fixed.operation);
  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.promotionEligible, false);
  assert.match(result.recordDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(result.counts, {
    expectedCommands: scenario === "normal" ? 5 : 4,
    consumedCommands: 3,
    succeededCommands: scenario === "normal" ? 3 : 2,
    failedCommands: 0,
    interruptedCommands: scenario === "normal" ? 0 : 1,
    unresolvedCommands: scenario === "normal" ? 0 : 1
  });
  if (scenario === "apply-interrupted") assert.ok(interruptedError);
  t.diagnostic(
    JSON.stringify({
      operationRef,
      scenario,
      indexDigest: fixed.indexDigest,
      status: result.status,
      counts: result.counts,
      recordDigest: result.recordDigest,
      promotionEligible: result.promotionEligible
    })
  );
});
