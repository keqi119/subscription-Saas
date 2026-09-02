import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExecutionProof,
  buildPostStateObservation,
  deterministicPlanDigest
} from "../src/proof-builders.mjs";
import { sha256Canonical, validateContract } from "../src/index.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const operationId = "3e43aede-690e-4547-bfcc-4b23fc44769c";
const attemptId = "1365dc5c-9b10-4f6b-b53e-14fe13ca4b12";
const runId = "bc0db308-715b-4b0f-a951-fc735b8c88e7";

function observationInput(overrides = {}) {
  return {
    operationId,
    attemptId,
    runId,
    baselineManifestIdentityDigest: digest("1"),
    baselineManifestDigest: digest("2"),
    commandId: "schema.migrate",
    commandVersion: "1",
    planDigest: digest("3"),
    databaseIdentityFingerprint: digest("4"),
    postMigrationHead: "20260831010000_billing_maintenance_cycle_fact",
    postSchemaDigest: digest("5"),
    configurationFingerprint: digest("6"),
    postconditions: [
      {
        id: "schema-diff-zero",
        status: "PASSED",
        expectedDigest: digest("7"),
        actualDigest: digest("7")
      }
    ],
    observedAt: "2026-09-02T09:00:00.000Z",
    ...overrides
  };
}

function proofInput(overrides = {}) {
  return {
    operationId,
    attemptId,
    phase: "apply",
    predecessorProofDigest: digest("8"),
    status: "SUCCEEDED",
    buildProofDigest: digest("9"),
    baselineManifestIdentityDigest: digest("1"),
    baselineManifestDigest: digest("2"),
    executionScope: "migration-schema",
    command: {
      id: "schema.migrate",
      version: "1",
      capability: "migrate",
      approvalMode: "ci-policy"
    },
    databaseIdentityFingerprint: digest("4"),
    inputDigest: digest("a"),
    planDigest: digest("3"),
    outputDigest: digest("b"),
    postconditionsStatus: "PASSED",
    timing: {
      startedAt: "2026-09-02T08:59:00.000Z",
      completedAt: "2026-09-02T09:00:01.000Z"
    },
    toolVersion: "release-runner/1",
    error: null,
    references: {
      launcher: "launcher://run/1",
      policy: "policy://s1-release-operations",
      approval: "approval://98fa300a-bf12-4ac8-854a-b60dd70cdd17"
    },
    ...overrides
  };
}

test("post-state cannot reference its future execution proof", () => {
  assert.throws(
    () => buildPostStateObservation(observationInput({ executionProofDigest: digest("f") })),
    { code: "POST_STATE_FORWARD_REFERENCE_FORBIDDEN" }
  );
});

test("builds observation before proof and binds the observation digest", () => {
  const observation = buildPostStateObservation(observationInput());
  const proof = buildExecutionProof({
    postStateObservation: observation,
    ...proofInput()
  });
  assert.doesNotThrow(() => validateContract("post-state-observation.v1", observation));
  assert.doesNotThrow(() => validateContract("execution-proof.v1", proof));
  assert.equal(proof.postStateObservationDigest, sha256Canonical(observation));
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(proof), true);
});

test("rejects caller supplied post-state digest and cross-attempt observations", () => {
  const observation = buildPostStateObservation(observationInput());
  assert.throws(
    () =>
      buildExecutionProof({
        postStateObservation: observation,
        postStateObservationDigest: digest("0"),
        ...proofInput()
      }),
    { code: "EXECUTION_PROOF_DIGEST_OVERRIDE_FORBIDDEN" }
  );
  assert.throws(
    () =>
      buildExecutionProof({
        postStateObservation: observation,
        ...proofInput({ attemptId: "e79ae19c-e43a-4fb8-8446-a37af39291f1" })
      }),
    { code: "EXECUTION_PROOF_OBSERVATION_MISMATCH" }
  );
});

test("deterministic plan digest excludes provenance timestamps", () => {
  const identity = {
    schemaVersion: "deterministic-plan.identity.v1",
    commandId: "schema.migrate",
    commandVersion: "1",
    targets: [{ migration: "20260831010000_billing_maintenance_cycle_fact" }]
  };
  const first = deterministicPlanDigest({
    schemaVersion: "deterministic-plan.v1",
    identity,
    provenance: { generatedAt: "2026-09-02T08:00:00.000Z" }
  });
  const second = deterministicPlanDigest({
    schemaVersion: "deterministic-plan.v1",
    identity,
    provenance: { generatedAt: "2026-09-02T09:00:00.000Z" }
  });
  assert.equal(first, second);
});
