import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";

import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";

const script = fileURLToPath(new URL("./prepare-snapshot-admission.mjs", import.meta.url));
const workflow = await readFile(
  new URL("../../.github/workflows/sanitized-snapshot.yml", import.meta.url)
);
const digest = `sha256:${"a".repeat(64)}`;

function authorization(sourceSha = "b".repeat(40)) {
  return {
    schemaVersion: "rc-dispatch-authorization.v1",
    authorizationId: "authorization-1",
    executionPurpose: "qualification",
    releaseAttemptId: "attempt-1",
    sourceSha,
    producerWorkflow: {
      path: ".github/workflows/sanitized-snapshot.yml",
      ref: "main",
      blobDigest: sha256Bytes(workflow)
    },
    rcWorkflow: {
      path: ".github/workflows/release-candidate-gate.yml",
      ref: "main",
      blobDigest: digest
    },
    buildProofDigest: digest,
    buildBundleDigest: digest,
    repositoryContractDigest: digest,
    adapterDigest: digest,
    issuer: "dispatch",
    issuedAt: "2026-09-03T00:00:00.000Z",
    notAfter: "2026-09-03T00:10:00.000Z",
    revocationPolicyDigest: digest
  };
}

async function fixture({ encodedAuth, overrides = {} } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "snapshot-admission-"));
  await mkdir(path.join(cwd, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(cwd, ".github", "workflows", "sanitized-snapshot.yml"), workflow);
  const outputPath = path.join(cwd, "github-output");
  await writeFile(outputPath, "");
  const env = {
    ...process.env,
    STAGE1_DISPATCH_AUTHORIZATION_BASE64:
      encodedAuth ?? Buffer.from(canonicalJson(authorization())).toString("base64"),
    STAGE1_ENVIRONMENT_POLICY_DIGEST: digest,
    GITHUB_REPOSITORY: "keqi119/subscription-Saas",
    GITHUB_REPOSITORY_ID: "1253231368",
    GITHUB_ACTOR_ID: "275060624",
    GITHUB_RUN_ID: "23456",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "b".repeat(40),
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF:
      "keqi119/subscription-Saas/.github/workflows/sanitized-snapshot.yml@refs/heads/main",
    GITHUB_OUTPUT: outputPath,
    ...overrides
  };
  return { cwd, outputPath, env };
}

async function run(fx) {
  return spawnSync(process.execPath, [script], { cwd: fx.cwd, env: fx.env, encoding: "utf8" });
}

test("writes canonical untrusted admission once and emits digest and complete runner labels", async () => {
  const fx = await fixture();
  try {
    const result = await run(fx);
    assert.equal(result.status, 0, result.stderr);
    const bytes = await readFile(
      path.join(fx.cwd, ".release-output", "snapshot-admission.v1.json")
    );
    const admission = JSON.parse(bytes);
    assert.equal(bytes.toString("utf8"), canonicalJson(admission));
    assert.equal(admission.producerRun.runId, "23456");
    assert.match(admission.route.label, /^stage1-snapshot-export-23456-[0-9a-f]{32}$/);
    const output = await readFile(fx.outputPath, "utf8");
    assert.equal(
      output,
      `admission_ref=${sha256Bytes(bytes)}\nroute_label=${admission.route.label}\nrunner_labels=${JSON.stringify(["self-hosted", "linux", "x64", "stage1-snapshot-export", admission.route.label])}\n`
    );
    assert.doesNotMatch(output, /authorization|signature|token/i);
    assert.equal((await run(fx)).status, 1, "second invocation must not overwrite admission");
  } finally {
    await rm(fx.cwd, { recursive: true, force: true });
  }
});

test("rejects malformed and noncanonical authorization bytes", async () => {
  for (const encodedAuth of [
    "%%%",
    Buffer.from(`${canonicalJson(authorization())}\n`).toString("base64")
  ]) {
    const fx = await fixture({ encodedAuth });
    try {
      const result = await run(fx);
      assert.equal(result.status, 1);
      assert.equal(await readFile(fx.outputPath, "utf8"), "");
    } finally {
      await rm(fx.cwd, { recursive: true, force: true });
    }
  }
});

test("rejects mismatched source SHA and fixed GitHub run bindings", async () => {
  for (const fxOptions of [
    { encodedAuth: Buffer.from(canonicalJson(authorization("c".repeat(40)))).toString("base64") },
    { overrides: { GITHUB_ACTOR_ID: "275060625" } },
    { overrides: { GITHUB_RUN_ATTEMPT: "2" } },
    { overrides: { GITHUB_REF: "refs/heads/other" } }
  ]) {
    const fx = await fixture(fxOptions);
    try {
      assert.equal((await run(fx)).status, 1);
      await assert.rejects(
        readFile(path.join(fx.cwd, ".release-output", "snapshot-admission.v1.json"))
      );
    } finally {
      await rm(fx.cwd, { recursive: true, force: true });
    }
  }
});
