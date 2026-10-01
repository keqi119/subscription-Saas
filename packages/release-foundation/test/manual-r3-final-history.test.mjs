import assert from "node:assert/strict";
import test from "node:test";
import { selectSingleR3FinalUse } from "../src/manual-r3-final-history.mjs";

const candidate = (overrides = {}) => ({
  stage: "candidate-use",
  profileDigest: "profile",
  buildProofDigest: "build",
  sourceSha: "source",
  chain: "fresh",
  matchingSourceEvidenceDigest: "source-terminal",
  ci: {
    repository: "owner/repo",
    repositoryId: "1",
    runId: "2",
    runAttempt: 1,
    callerWorkflowPath: "caller"
  },
  ...overrides
});

test("R3 final history selects one authenticated candidate fact", () => {
  const selected = candidate();
  const facts = new Map([
    ["selected", selected],
    ["consumer", { ...candidate(), stage: "snapshot-consumer" }],
    ["other-ci", candidate({ ci: { ...selected.ci, runId: "3" } })]
  ]);
  const result = selectSingleR3FinalUse(facts, "selected");
  assert.equal(result.chosen, selected);
  assert.deepEqual(result.matchingRequestDigests, ["selected"]);
  assert.ok(Object.isFrozen(result.matchingRequestDigests));
});

test("R3 final history rejects a second candidate for the same CI and source", () => {
  const facts = new Map([
    ["selected", candidate()],
    ["retry", candidate()]
  ]);
  assert.throws(() => selectSingleR3FinalUse(facts, "selected"), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
});

test("R3 final history rejects a missing selected candidate", () => {
  assert.throws(() => selectSingleR3FinalUse(new Map(), "selected"), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
});
