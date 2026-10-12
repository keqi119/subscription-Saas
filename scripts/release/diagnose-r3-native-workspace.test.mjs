import test from "node:test";
import assert from "node:assert/strict";
import { publicFailureCode, recordPublicFailure } from "./diagnose-r3-native-workspace.mjs";

test("diagnostic artifact failure code cannot echo an arbitrary path or message", () => {
  assert.equal(publicFailureCode({ code: "ENOENT" }), "ENOENT");
  assert.equal(
    publicFailureCode({ code: "R3_WORKSPACE_OBSERVATION_INVALID" }),
    "R3_WORKSPACE_OBSERVATION_INVALID"
  );
  assert.equal(publicFailureCode({ code: "/home/runner/private-repo" }), "DIAGNOSTIC_PHASE_FAILED");
  assert.equal(publicFailureCode(new Error("secret pathname")), "DIAGNOSTIC_PHASE_FAILED");
});

test("cleanup observation failure preserves the original diagnostic failure", () => {
  const summary = {};
  recordPublicFailure(summary, "ACTIVE", { code: "R3_WORKSPACE_OBSERVATION_INVALID" });
  recordPublicFailure(summary, "ABSENT_AFTER", { code: "ENOENT" });
  assert.deepEqual(summary.failure, {
    phase: "ACTIVE",
    code: "R3_WORKSPACE_OBSERVATION_INVALID"
  });
  assert.deepEqual(summary.cleanupObservationFailure, { phase: "ABSENT_AFTER", code: "ENOENT" });
});
