import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateContract } from "../../packages/release-foundation/src/index.mjs";

async function workflow(name) {
  return readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
}

test("approval policy is versioned and permits only the registered protected modes", async () => {
  const policy = JSON.parse(
    await readFile(new URL("../../release/contracts/approval-policies.v1.json", import.meta.url))
  );
  assert.doesNotThrow(() => validateContract("approval-policy.v1", policy));
  assert.deepEqual(policy.approvalModes, ["ci-policy", "human"]);
  assert.equal(policy.authorities.human.environment, "s1-database-operation-approval");
  assert.equal(policy.revocationSource.workflowRef, "refs/heads/main");
  assert.equal(policy.revocationSource.maximumPublicationDelaySeconds, 1800);
});

test("operation approval workflow uses protected environments, first attempts, attestation and readback", async () => {
  const text = await workflow("release-operation-approval.yml");
  for (const required of [
    "github.ref == 'refs/heads/main'",
    "github.run_attempt == 1",
    "s1-database-operation-approval",
    "environment:",
    "id-token: write",
    "attestations: write",
    "actions/attest-build-provenance@v2",
    "actions/download-artifact@v4",
    "approval-record.custody-receipt.v1.json",
    "retention-days: 180"
  ]) {
    assert.match(text, new RegExp(required.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("revocation workflow publishes protected first-attempt heartbeats without caller-selected history", async () => {
  const text = await workflow("release-approval-revocations.yml");
  for (const required of [
    "schedule:",
    'cron: "*/20 * * * *"',
    "github.run_attempt == 1",
    "s1-approval-revocations",
    "cancel-in-progress: false",
    "gh api --paginate",
    "gh attestation verify",
    "previousArtifactDigest:",
    "actions/attest-build-provenance@v2",
    "approval-revocations.custody-receipt.v1.json"
  ]) {
    assert.match(text, new RegExp(required.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const inputBlock = text.slice(text.indexOf("workflow_dispatch:"), text.indexOf("schedule:"));
  assert.doesNotMatch(inputBlock, /previousArtifactDigest|artifactUrl|workflowRef|sequence/);
});
