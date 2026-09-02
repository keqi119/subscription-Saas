import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, sha256Canonical } from "../../packages/release-foundation/src/index.mjs";

import { aggregateReleaseProof } from "./aggregate-release-proof.mjs";
import { assembleReleaseAggregateInput } from "./assemble-release-aggregate-input.mjs";
import { assembleS1ExitInput } from "./assemble-s1-exit-input.mjs";
import { createFinalAttemptHistory } from "./create-final-attempt-history.mjs";
import { exportFinalComposeEnvironment } from "./export-final-compose-environment.mjs";
import {
  aggregateInput,
  buildProof,
  custodyRecord,
  digest,
  finalEvidence,
  sourceEvidence,
  uuid
} from "./task29r-proof-fixtures.mjs";

async function withTempRoot(name, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), name));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeCanonical(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, canonicalJson(value));
}

function runtimeFixture(chain) {
  return {
    schemaVersion: "final-compose-runtime.v1",
    chain,
    manifestReference: "baseline-manifest.v1.json",
    manifestDigest: digest("1"),
    targetReference: "final-compose-target.v1.json",
    targetDigest: digest("2"),
    apiRuntimeCredentialReference: "api-runtime-credential.secret",
    verifyCredentialReference: "verify-credential.secret",
    custodyPolicyReference: "custody-policy.v1.json",
    custodyPolicyDigest: digest("3"),
    attestationRef: "github-attestation://runs/901/runtime",
    apiManifestId: `manifest-${chain}`,
    apiSessionNonce: `session-${chain}`,
    apiBase: "http://127.0.0.1:33001/api",
    webBase: "http://127.0.0.1:33000",
    publicApiBase: "http://127.0.0.1:33001/api",
    embeddedApiBase: "http://127.0.0.1:33001/api",
    composeSecretFiles: {
      postgresPassword: "postgres-password.secret",
      migrationCredential: "migration-credential.secret",
      verifyCredential: "verify-credential.secret",
      databaseTestCredential: "database-test-credential.secret",
      databaseTestSourceCredential: "database-test-source-credential.secret"
    }
  };
}

function targetFixture(chain) {
  const marker = chain === "fresh" ? "1" : "2";
  return {
    schemaVersion: "final-compose-target.v1",
    chain,
    hostname: "postgres",
    hostAccessHostname: "127.0.0.1",
    port: chain === "fresh" ? 35432 : 35433,
    databaseName: `s1ci_${marker.repeat(24)}`,
    databaseOid: chain === "fresh" ? "11001" : "11002",
    databaseIdentityFingerprint: digest("4"),
    apiRuntimeRole: `s1a_${marker.repeat(24)}`,
    testRuntimeRole: `s1r_${marker.repeat(24)}`,
    migrationRole: `s1m_${marker.repeat(24)}`,
    verifyRole: `s1v_${marker.repeat(24)}`,
    apiRuntimeCredentialFingerprint: digest("5"),
    testRuntimeCredentialFingerprint: digest("6"),
    verifyCredentialFingerprint: digest("7"),
    marker: `subscription-s1-ephemeral/v1:${marker.repeat(24)}`,
    tlsMode: "require"
  };
}

test("exports only fixed Compose interpolation from the protected launch bundle", async () => {
  await withTempRoot("s1-final-env-", async (root) => {
    const proof = buildProof();
    const launchRoot = path.join(root, ".release-local", "launch", "fresh");
    const githubEnvFile = path.join(root, "github.env");
    await writeCanonical(
      path.join(launchRoot, "final-compose-runtime.v1.json"),
      runtimeFixture("fresh")
    );
    await writeCanonical(
      path.join(launchRoot, "final-compose-target.v1.json"),
      targetFixture("fresh")
    );
    const result = await exportFinalComposeEnvironment({
      chain: "fresh",
      buildProof: proof,
      launchRoot,
      githubEnvFile
    });
    const content = await readFile(githubEnvFile, "utf8");
    assert.match(
      content,
      new RegExp(
        `RELEASE_RUNNER_IMAGE=${proof.identity.images.runner.registry}@${proof.identity.images.runner.imageDigest}`,
        "u"
      )
    );
    assert.match(content, /RELEASE_RUNNER_LAUNCH_ENVELOPE_FILE=.*migration-dry-run\.json/u);
    assert.equal(content.includes("PASSWORD="), false);
    assert.equal(result.RELEASE_GATE_API_PORT, "33001");
  });
});

test("rejects environment-file injection before exporting Compose interpolation", async () => {
  await withTempRoot("s1-final-env-", async (root) => {
    const launchRoot = path.join(root, ".release-local", "launch", "fresh");
    const runtime = runtimeFixture("fresh");
    runtime.apiManifestId = "manifest\nINJECTED=true";
    await writeCanonical(path.join(launchRoot, "final-compose-runtime.v1.json"), runtime);
    await writeCanonical(
      path.join(launchRoot, "final-compose-target.v1.json"),
      targetFixture("fresh")
    );
    await assert.rejects(
      exportFinalComposeEnvironment({
        chain: "fresh",
        buildProof: buildProof(),
        launchRoot,
        githubEnvFile: path.join(root, "github.env")
      }),
      { code: "FINAL_COMPOSE_ENVIRONMENT_INVALID" }
    );
  });
});

test("creates a selected final attempt history from actual final evidence", () => {
  const proof = buildProof();
  const source = sourceEvidence("fresh", proof);
  const final = finalEvidence("fresh", proof, source);
  final.priorFailureProofDigests = [];
  const history = createFinalAttemptHistory({
    chain: "fresh",
    buildProof: proof,
    sourceGateEvidence: source,
    finalComposeEvidence: final
  });
  assert.equal(history.chain, "fresh");
  assert.deepEqual(
    history.attempts.map(({ proofDigest }) => proofDigest),
    [sha256Canonical(final)]
  );
  assert.equal(history.attempts[0].terminalStatus, "PASSED");
});

test("rejects a selected final attempt when unbound prior failures are claimed", () => {
  const proof = buildProof();
  const source = sourceEvidence("fresh", proof);
  const final = finalEvidence("fresh", proof, source);
  assert.throws(
    () =>
      createFinalAttemptHistory({
        chain: "fresh",
        buildProof: proof,
        sourceGateEvidence: source,
        finalComposeEvidence: final
      }),
    { code: "FINAL_ATTEMPT_PRIOR_HISTORY_REQUIRED" }
  );
});

test("assembles the aggregate exclusively from one current-run artifact directory", async () => {
  await withTempRoot("s1-aggregate-input-", async (root) => {
    const expected = aggregateInput();
    const files = {
      "build-proof.v1.json": expected.buildProof,
      "snapshot-metadata.v1.json": expected.snapshotMetadata,
      "source-gate-fresh.v1.json": expected.sourceGateEvidence.fresh,
      "source-gate-snapshot.v1.json": expected.sourceGateEvidence.snapshot,
      "final-compose-fresh.v1.json": expected.finalComposeEvidence.fresh,
      "final-compose-snapshot.v1.json": expected.finalComposeEvidence.snapshot,
      "build-proof-custody-record.v1.json": expected.custodyRecords.buildProof,
      "snapshot-metadata-custody-record.v1.json": expected.custodyRecords.snapshotMetadata,
      "source-gate-fresh-custody-record.v1.json": expected.custodyRecords.sourceFresh,
      "source-gate-snapshot-custody-record.v1.json": expected.custodyRecords.sourceSnapshot,
      "final-compose-fresh-custody-record.v1.json": expected.custodyRecords.finalFresh,
      "final-compose-snapshot-custody-record.v1.json": expected.custodyRecords.finalSnapshot,
      "final-attempt-history-fresh.v1.json": {
        chain: "fresh",
        attempts: expected.attemptHistory.fresh
      },
      "final-attempt-history-snapshot.v1.json": {
        chain: "snapshot",
        attempts: expected.attemptHistory.snapshot
      }
    };
    await Promise.all(
      Object.entries(files).map(([name, value], index) =>
        writeCanonical(path.join(root, `artifact-${index}`, name), value)
      )
    );
    const assembled = await assembleReleaseAggregateInput({
      inputRoot: root,
      environment: {
        GITHUB_REPOSITORY: "keqi119/subscription-Saas",
        GITHUB_WORKFLOW_REF: `keqi119/subscription-Saas/.github/workflows/release-candidate-gate.yml@refs/heads/main`,
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: expected.buildProof.identity.sourceSha,
        GITHUB_RUN_ID: "901",
        GITHUB_RUN_ATTEMPT: "1"
      },
      now: () => new Date("2026-09-03T03:00:00.000Z")
    });
    assert.equal(
      aggregateReleaseProof(assembled).sourceSha,
      expected.buildProof.identity.sourceSha
    );
  });
});

test("aggregate assembly rejects duplicate artifact basenames", async () => {
  await withTempRoot("s1-aggregate-input-", async (root) => {
    await writeCanonical(path.join(root, "a", "build-proof.v1.json"), buildProof());
    await writeCanonical(path.join(root, "b", "build-proof.v1.json"), buildProof());
    await assert.rejects(assembleReleaseAggregateInput({ inputRoot: root, environment: {} }), {
      code: "RELEASE_DAG_ARTIFACT_DUPLICATE"
    });
  });
});

test("assembles exit input only after aggregate custody and owner evidence exist", async () => {
  await withTempRoot("s1-exit-input-", async (root) => {
    const aggregateProof = aggregateReleaseProof(aggregateInput());
    const aggregateCustody = custodyRecord(aggregateProof, "8");
    const attestation = {
      schemaVersion: "s1-owner-attestation.v1",
      attestationId: uuid("7"),
      subject: {
        controlId: "legacy-external-owner-migration",
        sourceSha: aggregateProof.sourceSha,
        evidenceDigests: [aggregateProof.finalComposeEvidence.fresh]
      },
      owner: "release-operations",
      facts: [{ factId: "external-entry-closed", value: true }],
      validFrom: "2026-09-03T03:00:00.000Z",
      notAfter: "2026-09-04T03:00:00.000Z"
    };
    const ownerRecords = {
      schemaVersion: "s1-owner-attestations.v1",
      records: [{ attestation, custodyReceipt: custodyRecord(attestation, "9").receipt }]
    };
    const input = await assembleS1ExitInput({
      aggregateProof,
      aggregateCustodyRecord: aggregateCustody,
      ownerAttestations: ownerRecords,
      environment: {
        GITHUB_REPOSITORY: "keqi119/subscription-Saas",
        GITHUB_WORKFLOW_REF: `keqi119/subscription-Saas/.github/workflows/release-candidate-gate.yml@refs/heads/main`,
        GITHUB_RUN_ID: "901",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: aggregateProof.sourceSha
      },
      now: () => new Date("2026-09-03T03:20:00.000Z")
    });
    assert.equal(input.repositoryObservations[0].status, "EVIDENCED");
    assert.deepEqual(input.findings.p1, []);
    assert.deepEqual(input.findings.p2, ["Task30 independent exit audit pending"]);
  });
});

test("exit input assembly rejects aggregate custody from another workflow run", async () => {
  const aggregateProof = aggregateReleaseProof(aggregateInput());
  const aggregateCustody = custodyRecord(aggregateProof, "8");
  aggregateCustody.workflowRunRef =
    "github://keqi119/subscription-Saas/actions/runs/902/attempts/1";
  await assert.rejects(
    assembleS1ExitInput({
      aggregateProof,
      aggregateCustodyRecord: aggregateCustody,
      ownerAttestations: { schemaVersion: "s1-owner-attestations.v1", records: [] },
      environment: {
        GITHUB_REPOSITORY: "keqi119/subscription-Saas",
        GITHUB_WORKFLOW_REF: `keqi119/subscription-Saas/.github/workflows/release-candidate-gate.yml@refs/heads/main`,
        GITHUB_RUN_ID: "901",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: aggregateProof.sourceSha
      }
    }),
    { code: "S1_EXIT_AGGREGATE_CUSTODY_MISMATCH" }
  );
});
