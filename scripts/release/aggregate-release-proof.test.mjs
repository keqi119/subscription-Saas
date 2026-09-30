import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sha256Canonical } from "../../packages/release-foundation/src/index.mjs";

import { aggregateReleaseProof } from "./aggregate-release-proof.mjs";
import { aggregateInput, digest } from "./task29r-proof-fixtures.mjs";

test("selects one same-run, custodied fresh/snapshot proof set", () => {
  const input = aggregateInput();
  const result = aggregateReleaseProof(input);
  assert.equal(result.schemaVersion, "release-aggregate-proof.v1");
  assert.equal(result.sourceSha, input.buildProof.identity.sourceSha);
  assert.equal(result.workflowRun.runId, "901");
  assert.equal(
    result.finalComposeEvidence.fresh,
    sha256Canonical(input.finalComposeEvidence.fresh)
  );
  assert.equal(result.attemptHistoryDigest, sha256Canonical(input.attemptHistory));
});

for (const [name, mutate, code] of [
  [
    "cross-run source evidence",
    (input) =>
      (input.sourceGateEvidence.fresh.provenance.ciRunRef =
        "github://keqi119/subscription-Saas/actions/runs/902/attempts/1"),
    "RELEASE_WORKFLOW_RUN_MISMATCH"
  ],
  [
    "replacement image",
    (input) =>
      (input.finalComposeEvidence.fresh.releaseImages.api = `ghcr.io/x/api@${digest("f")}`),
    "RELEASE_IMAGE_BUNDLE_MISMATCH"
  ],
  [
    "changed test manifest",
    (input) => (input.sourceGateEvidence.snapshot.databaseTestManifestDigest = digest("0")),
    "RELEASE_TEST_MANIFEST_MISMATCH"
  ],
  [
    "uncustodied final evidence",
    (input) => (input.custodyRecords.finalSnapshot.receipt.readbackDigest = digest("0")),
    "RELEASE_CUSTODY_INCOMPLETE"
  ],
  [
    "erased failed attempt",
    (input) => input.attemptHistory.snapshot.shift(),
    "RELEASE_ATTEMPT_HISTORY_INCOMPLETE"
  ],
  [
    "spliced retry input",
    (input) => (input.attemptHistory.fresh[0].inputIdentityDigest = digest("0")),
    "RELEASE_RETRY_INPUT_MISMATCH"
  ],
  [
    "duplicate overwritten attempt proof",
    (input) =>
      (input.attemptHistory.snapshot[0].proofDigest = input.attemptHistory.fresh[0].proofDigest),
    "RELEASE_ATTEMPT_PROOF_OVERWRITTEN"
  ]
]) {
  test(`rejects ${name}`, () => {
    const input = structuredClone(aggregateInput());
    mutate(input);
    assert.throws(() => aggregateReleaseProof(input), { code });
  });
}

test("release workflow contains only same-run final and generated-exit DAG inputs", async () => {
  const workflow = await readFile(".github/workflows/release-candidate-gate.yml", "utf8");
  for (const forbidden of [
    "finalExecutionRunId",
    "finalExecutionArtifactName",
    "exitEvidenceRunId",
    "exitEvidenceArtifactName",
    "--evidence-input-file"
  ]) {
    assert.equal(workflow.includes(forbidden), false, forbidden);
  }
  assert.match(workflow, /final-fresh:[\s\S]*needs:[\s\S]*source-fresh[\s\S]*admit-build/u);
  assert.match(workflow, /final-snapshot:[\s\S]*needs:[\s\S]*source-snapshot[\s\S]*admit-build/u);
  assert.match(workflow, /aggregate-proof:[\s\S]*needs:[\s\S]*final-fresh[\s\S]*final-snapshot/u);
  assert.match(workflow, /generate-exit-evidence:[\s\S]*needs:[\s\S]*aggregate-proof/u);
  assert.match(workflow, /checkpoint-custody:[\s\S]*needs:[\s\S]*generate-exit-evidence/u);
  assert.match(workflow, /release-owner-attestations\.yml[\s\S]*--source-digest "\$GITHUB_SHA"/u);
  assert.match(workflow, /sanitized-snapshot\.yml[\s\S]*--source-ref refs\/heads\/main/u);
  assert.doesNotMatch(workflow, /audit-s1-exit/u);
  const fresh = workflow.split("  source-fresh:\n")[1]?.split("  source-snapshot:\n")[0];
  assert.ok(fresh);
  assert.match(fresh, /runs-on: ubuntu-24\.04/u);
  assert.match(fresh, /environment: trusted-source-database-gate/u);
  assert.match(fresh, /SOURCE_FRESH_CREATION_SPEC: \$\{\{ inputs.sourceFreshCreationSpec \}\}/u);
  assert.match(fresh, /prepareR3SourceFreshHostedJob/u);
  assert.match(fresh, /id: attest-job[\s\S]*job-admission\.json[\s\S]*id: upload-job/u);
  assert.equal((fresh.match(/include-hidden-files: true/gu) ?? []).length, 3);
  assert.match(fresh, /runR3SourceFreshHosted[\s\S]*status !== "CLOSED"/u);
  assert.equal((fresh.match(/stage1-root "\$\(command -v node\)"/gu) ?? []).length, 2);
  assert.match(
    fresh,
    /sudo "\$\(command -v node\)" scripts\/release\/workflow-custody-record\.mjs/u
  );
  assert.doesNotMatch(fresh, /run-source-database-gate\.mjs|source-fresh\.raw\.json/u);
  assert.match(
    fresh,
    /id: attest\n[\s\S]*id: upload\n[\s\S]*Freeze the same-run source custody record/u
  );
});

test("owner facts have a protected, attested and read-back producer", async () => {
  const workflow = await readFile(".github/workflows/release-owner-attestations.yml", "utf8");
  for (const required of [
    "github.ref == 'refs/heads/main'",
    "github.run_attempt == 1",
    "environment: s1-owner-attestation",
    "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
    "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    "s1-owner-attestations.v1.json",
    "retention-days: 180",
    "cmp .release-output/owner-bundle"
  ]) {
    assert.equal(workflow.includes(required), true, required);
  }
});
