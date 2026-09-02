import assert from "node:assert/strict";
import test from "node:test";

import {
  assertApplyAllowed,
  createExecutionState,
  transitionExecution
} from "../src/execution-state-machine.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const operationId = "d6e87e1c-a1cb-49eb-b6f5-58ac6b411872";
const idempotencyKey = "stage1-operation-key-1";
const dryAttempt = "3103fd61-7c06-47da-9c5e-9196b936b221";
const applyAttempt = "6fc6e2ea-bb01-43e8-86e5-9b5b5a60c839";
const replayAttempt = "8c52ae70-e787-45dc-b6b1-a5bbb1dd44f1";

function dryRunSucceeded() {
  return transitionExecution(createExecutionState({ operationId, idempotencyKey }), {
    type: "DRY_RUN_SUCCEEDED",
    attemptId: dryAttempt,
    planDigest: digest("1"),
    proofDigest: digest("2")
  });
}

function startApply(state = dryRunSucceeded()) {
  return transitionExecution(state, {
    type: "APPLY_STARTED",
    operationId,
    idempotencyKey,
    attemptId: applyAttempt,
    approvedPlanDigest: digest("1"),
    recomputedPlanDigest: digest("1")
  });
}

test("supports normal dry-run, apply, proof, and replay attempts", () => {
  let state = startApply();
  state = transitionExecution(state, { type: "APPLY_COMMITTED" });
  state = transitionExecution(state, {
    type: "ATTEMPT_PROVED",
    proofDigest: digest("3")
  });
  assert.equal(state.status, "SUCCEEDED");
  assert.equal(state.predecessorProofDigest, digest("3"));

  state = transitionExecution(state, {
    type: "REPLAY_STARTED",
    operationId,
    idempotencyKey,
    attemptId: replayAttempt
  });
  state = transitionExecution(state, {
    type: "ATTEMPT_PROVED",
    proofDigest: digest("4")
  });
  assert.equal(state.status, "SUCCEEDED");
  assert.equal(state.activeAttempt.phase, "replay");
});

test("rejects apply when the locked recomputed plan changed", () => {
  const state = dryRunSucceeded();
  assert.throws(
    () =>
      assertApplyAllowed({
        state,
        operationId,
        idempotencyKey,
        approvedPlanDigest: digest("1"),
        recomputedPlanDigest: digest("9")
      }),
    { code: "PLAN_CHANGED_SINCE_APPROVAL" }
  );
  assert.equal(state.status, "DRY_RUN_SUCCEEDED");
});

test("process loss before a known rollback is failed, not unknown", () => {
  const state = transitionExecution(startApply(), {
    type: "PROCESS_LOST",
    commitState: "not-committed"
  });
  assert.equal(state.status, "FAILED");
  assert.equal(state.terminalClass, "FAILED");
});

test("process loss after commit-before-proof requires same-key reconcile", () => {
  const committed = transitionExecution(startApply(), { type: "APPLY_COMMITTED" });
  const unknown = transitionExecution(committed, {
    type: "PROCESS_LOST",
    commitState: "committed-result-unproved"
  });
  assert.equal(unknown.status, "INTERRUPTED_UNKNOWN");
  assert.throws(
    () =>
      assertApplyAllowed({
        state: unknown,
        operationId,
        idempotencyKey,
        approvedPlanDigest: digest("1"),
        recomputedPlanDigest: digest("1")
      }),
    { code: "UNKNOWN_REQUIRES_RECONCILE" }
  );

  let reconciling = transitionExecution(unknown, {
    type: "RECONCILE_STARTED",
    operationId,
    idempotencyKey,
    attemptId: replayAttempt
  });
  assert.equal(reconciling.status, "RECONCILING");
  reconciling = transitionExecution(reconciling, {
    type: "RECONCILE_RESOLVED",
    databaseOutcome: "committed",
    proofDigest: digest("5")
  });
  assert.equal(reconciling.status, "SUCCEEDED");
  assert.equal(reconciling.activeAttempt.phase, "reconcile");
});

test("reconcile and replay reject a different operation or idempotency key", () => {
  const committed = transitionExecution(startApply(), { type: "APPLY_COMMITTED" });
  const unknown = transitionExecution(committed, {
    type: "PROCESS_LOST",
    commitState: "unknown"
  });
  assert.throws(
    () =>
      transitionExecution(unknown, {
        type: "RECONCILE_STARTED",
        operationId,
        idempotencyKey: "another-key",
        attemptId: replayAttempt
      }),
    { code: "EXECUTION_IDEMPOTENCY_KEY_MISMATCH" }
  );
});

test("launcher records preflight rejection without a database post-state", () => {
  const state = transitionExecution(createExecutionState({ operationId, idempotencyKey }), {
    type: "PREFLIGHT_REJECTED",
    attemptId: dryAttempt,
    phase: "apply",
    reasonCode: "RUNNER_DIGEST_MISMATCH"
  });
  assert.equal(state.status, "PREFLIGHT_REJECTED");
  assert.equal(state.terminalClass, "PREFLIGHT_REJECTED");
  assert.equal(state.activeAttempt.reasonCode, "RUNNER_DIGEST_MISMATCH");
  assert.equal("postStateObservationDigest" in state, false);
});
