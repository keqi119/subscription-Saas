import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256Canonical } from "@subscription-saas/release-foundation";

test("exports the fixed-root runtime adapter factory", async () => {
  const runtime = await import("../src/runtime-adapters.mjs").catch(() => ({}));

  assert.equal(typeof runtime.createRuntimeAdapters, "function");
  assert.equal(typeof runtime.resolveRunnerReference, "function");
});

test("constructs the production runtime adapter set without caller-supplied code", async () => {
  const { createRuntimeAdapters } = await import("../src/runtime-adapters.mjs");

  const adapters = createRuntimeAdapters();

  assert.equal(adapters.trustPolicy, "runner-runtime-adapters/v1");
  assert.equal(typeof adapters.readEnvelope, "function");
  assert.equal(typeof adapters.launch, "function");
});

test("maps only fixed launch, secret and evidence references", async () => {
  const { resolveRunnerReference } = await import("../src/runtime-adapters.mjs");
  const roots = {
    launch: path.resolve("C:/runner/launch"),
    secrets: path.resolve("C:/runner/secrets"),
    evidence: path.resolve("C:/runner/evidence")
  };

  assert.equal(
    resolveRunnerReference("launch-file:///run/launch/request.json", roots),
    path.join(roots.launch, "request.json")
  );
  assert.equal(
    resolveRunnerReference("secret-file:///run/secrets/database-credential", roots),
    path.join(roots.secrets, "database-credential")
  );
  assert.equal(
    resolveRunnerReference("evidence-file:///evidence/journal.ndjson", roots),
    path.join(roots.evidence, "journal.ndjson")
  );
  assert.throws(() => resolveRunnerReference("launch-file:///run/launch/../secrets/value", roots), {
    code: "RUNNER_REFERENCE_FORBIDDEN"
  });
  assert.throws(() => resolveRunnerReference("file:///tmp/request.json", roots), {
    code: "RUNNER_REFERENCE_FORBIDDEN"
  });
});

test("builds an append-only journal and delegates one launch with lazy credential access", async () => {
  const { createRuntimeAdapters } = await import("../src/runtime-adapters.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "runner-runtime-"));
  const roots = {
    launch: path.join(root, "launch"),
    secrets: path.join(root, "secrets"),
    evidence: path.join(root, "evidence")
  };
  await Promise.all(Object.values(roots).map((directory) => mkdir(directory, { recursive: true })));
  const custodyPolicy = {
    owner: "release-engineering",
    readers: ["release", "qa", "security", "audit"],
    retentionDays: 180,
    expiryDisposition: "review"
  };
  const envelope = {
    capabilitySecretReference: "secret-file:///run/secrets/database-credential",
    journalReference: "evidence-file:///evidence/execution-journal.ndjson",
    revocationCheckpointReference: "evidence-file:///evidence/revocation-checkpoint.ndjson",
    custodyPolicyReference: "launch-file:///run/launch/custody-policy.v1.json",
    custodyPolicyDigest: sha256Canonical(custodyPolicy)
  };
  await writeFile(path.join(roots.launch, "envelope.json"), JSON.stringify(envelope));
  await writeFile(path.join(roots.launch, "custody-policy.v1.json"), JSON.stringify(custodyPolicy));
  await writeFile(
    path.join(roots.secrets, "database-credential"),
    JSON.stringify({
      username: "verify_role",
      password: "one-use",
      capabilityProfile: "verify"
    })
  );
  const launches = [];
  let databaseConnections = 0;
  const adapters = createRuntimeAdapters({
    roots,
    trustedLaunch: async (input) => {
      launches.push(input);
      const credential = await input.readCredential(input.credentialFileReference);
      await input.executionJournal.append({
        operationId: "7e73e4ca-9f36-4941-9683-6061a50ed1e6",
        terminalClass: "FAILED",
        stateDigest: `sha256:${"a".repeat(64)}`,
        state: { status: "FAILED" }
      });
      return { terminalStatus: "PASSED", username: credential.username };
    },
    connectDatabase: async () => {
      databaseConnections += 1;
    }
  });

  try {
    assert.deepEqual(
      await adapters.readEnvelope(path.join(roots.launch, "envelope.json")),
      envelope
    );
    const result = await adapters.launch({
      commandKey: "release.verify@1",
      request: {
        operationId: "7e73e4ca-9f36-4941-9683-6061a50ed1e6",
        capabilityProfile: "verify",
        launchAttestation: { attestationId: "launch-1" }
      },
      envelope
    });
    assert.equal(result.username, "verify_role");
    assert.equal(launches.length, 1);
    assert.equal(databaseConnections, 0);
    assert.match(
      await readFile(path.join(roots.evidence, "execution-journal.ndjson"), "utf8"),
      /"terminalClass":"FAILED"/
    );
    await assert.rejects(() => launches[0].readCredential(launches[0].credentialFileReference), {
      code: "RUNNER_CREDENTIAL_ALREADY_READ"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a capability credential mismatch before a database connection", async () => {
  const { createRuntimeAdapters } = await import("../src/runtime-adapters.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "runner-runtime-capability-"));
  const roots = {
    launch: path.join(root, "launch"),
    secrets: path.join(root, "secrets"),
    evidence: path.join(root, "evidence")
  };
  await Promise.all(Object.values(roots).map((directory) => mkdir(directory, { recursive: true })));
  const custodyPolicy = {
    owner: "release-engineering",
    readers: ["release", "qa", "security", "audit"],
    retentionDays: 180,
    expiryDisposition: "review"
  };
  await writeFile(path.join(roots.launch, "custody.json"), JSON.stringify(custodyPolicy));
  await writeFile(
    path.join(roots.secrets, "database-credential"),
    JSON.stringify({
      username: "combined_role",
      password: "one-use",
      capabilityProfile: "migrate"
    })
  );
  let connections = 0;
  const adapters = createRuntimeAdapters({
    roots,
    connectDatabase: async () => {
      connections += 1;
    },
    trustedLaunch: async (input) => input.readCredential(input.credentialFileReference)
  });
  const envelope = {
    capabilitySecretReference: "secret-file:///run/secrets/database-credential",
    journalReference: "evidence-file:///evidence/journal.ndjson",
    revocationCheckpointReference: "evidence-file:///evidence/checkpoint.ndjson",
    custodyPolicyReference: "launch-file:///run/launch/custody.json",
    custodyPolicyDigest: sha256Canonical(custodyPolicy)
  };

  try {
    await assert.rejects(
      () =>
        adapters.launch({
          commandKey: "db.schema.verify@1",
          request: {
            capabilityProfile: "verify",
            launchAttestation: { attestationId: "launch-1" }
          },
          envelope
        }),
      { code: "RUNNER_CAPABILITY_CREDENTIAL_MISMATCH" }
    );
    assert.equal(connections, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads only integrity-bound approval, revocation and dependency inputs", async () => {
  const { createRuntimeAdapters } = await import("../src/runtime-adapters.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "runner-runtime-artifacts-"));
  const roots = {
    launch: path.join(root, "launch"),
    secrets: path.join(root, "secrets"),
    evidence: path.join(root, "evidence")
  };
  await Promise.all(Object.values(roots).map((directory) => mkdir(directory, { recursive: true })));
  const artifacts = {
    "custody.json": {
      owner: "release-engineering",
      readers: ["release", "qa", "security", "audit"],
      retentionDays: 180,
      expiryDisposition: "review"
    },
    "approval.json": { approvalId: "approval-1" },
    "approval-attestation.json": { envelope: "approval-attestation" },
    "approval-custody.json": { receiptId: "approval-receipt" },
    "revocations.json": {
      runs: [
        {
          runNumber: 1,
          runId: "10",
          runAttempt: 1,
          artifact: { sequence: 1 },
          attestation: { envelope: "revocation-attestation" },
          custodyReceipt: { receiptId: "revocation-receipt" }
        }
      ]
    },
    "dependencies.json": { applyExecutionProof: { terminalStatus: "PASSED" } }
  };
  await Promise.all(
    Object.entries(artifacts).map(([file, value]) =>
      writeFile(path.join(roots.launch, file), JSON.stringify(value))
    )
  );
  let observed;
  const adapters = createRuntimeAdapters({
    roots,
    trustedLaunch: async (input) => {
      observed = input;
      return { terminalStatus: "PASSED" };
    }
  });
  const reference = (file) => `launch-file:///run/launch/${file}`;
  const envelope = {
    custodyPolicyReference: reference("custody.json"),
    custodyPolicyDigest: sha256Canonical(artifacts["custody.json"]),
    approvalRecordReference: reference("approval.json"),
    approvalRecordDigest: sha256Canonical(artifacts["approval.json"]),
    approvalAttestationReference: reference("approval-attestation.json"),
    approvalAttestationDigest: sha256Canonical(artifacts["approval-attestation.json"]),
    approvalCustodyReceiptReference: reference("approval-custody.json"),
    approvalCustodyReceiptDigest: sha256Canonical(artifacts["approval-custody.json"]),
    revocationHistoryReference: reference("revocations.json"),
    revocationHistoryDigest: sha256Canonical(artifacts["revocations.json"]),
    commandDependencyArtifactsReference: reference("dependencies.json"),
    commandDependencyArtifactsDigest: sha256Canonical(artifacts["dependencies.json"]),
    trustedAttestationClaims: [],
    capabilitySecretReference: "secret-file:///run/secrets/database-credential",
    journalReference: "evidence-file:///evidence/journal.ndjson",
    revocationCheckpointReference: "evidence-file:///evidence/checkpoint.ndjson"
  };

  try {
    await adapters.launch({
      commandKey: "db.migrate.deploy@1",
      request: {
        capabilityProfile: "migrate",
        launchAttestation: { attestationId: "launch-1" }
      },
      envelope
    });
    assert.deepEqual(observed.approvalRecord, artifacts["approval.json"]);
    assert.deepEqual(observed.approvalAttestation, artifacts["approval-attestation.json"]);
    assert.deepEqual(observed.approvalCustodyReceipt, artifacts["approval-custody.json"]);
    assert.deepEqual(observed.commandDependencyArtifacts, artifacts["dependencies.json"]);
    assert.equal(typeof observed.githubClient.listSuccessfulWorkflowRuns, "function");
    assert.equal(
      observed.githubClient.attestationVerifier.trustPolicy,
      "github-artifact-attestation/v1"
    );

    await assert.rejects(
      () =>
        adapters.launch({
          commandKey: "db.migrate.deploy@1",
          request: {
            capabilityProfile: "migrate",
            launchAttestation: { attestationId: "launch-1" }
          },
          envelope: { ...envelope, approvalRecordDigest: `sha256:${"0".repeat(64)}` }
        }),
      { code: "RUNNER_LAUNCH_ARTIFACT_DIGEST_MISMATCH" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
