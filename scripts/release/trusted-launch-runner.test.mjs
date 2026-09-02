import assert from "node:assert/strict";
import test from "node:test";

import {
  createExecutionState,
  sha256Canonical,
  transitionExecution
} from "../../packages/release-foundation/src/index.mjs";
import {
  commandApprovalMode,
  loadCommandRegistry,
  loadTargetPolicies
} from "../../apps/release-runner/src/command-registry.mjs";
import {
  approvalAttestation,
  approvalPolicy,
  approvalRecord,
  custodyReceipt,
  digest,
  now,
  revocationArtifact,
  revocationAttestation,
  trustedAttestationVerifier
} from "../../packages/release-foundation/test/approval-fixtures.mjs";
import { trustedLaunchRunner } from "./trusted-launch-runner.mjs";

const sourceSha = "c".repeat(40);
const runnerDigest = digest("b");

function buildProof() {
  return {
    schemaVersion: "build-proof.v1",
    identity: {
      schemaVersion: "build-proof.identity.v1",
      images: Object.fromEntries(
        ["api", "web", "runner"].map((name) => [
          name,
          {
            name,
            registry: `ghcr.io/example/${name}`,
            platform: "linux/amd64",
            imageDigest: name === "runner" ? runnerDigest : digest("a"),
            sourceRevision: sourceSha
          }
        ])
      ),
      sourceSha,
      migrationCatalogDigest: digest("1"),
      repositoryContractDigest: digest("2")
    },
    provenance: {
      generatedAt: "2026-09-02T07:00:00.000Z",
      ciRunRef: "ci://release/1",
      attestationRef: "attestation://release/1",
      checkoutRef: sourceSha,
      baseImages: [{ name: "node", resolvedDigest: digest("3") }],
      materials: [{ name: "repository", reference: sourceSha }],
      registryResolutionEvidenceDigest: digest("4")
    }
  };
}

function requestFor(command, overrides = {}) {
  const proof = buildProof();
  const environmentClass = command === "repair.execute" ? "staging" : "ci-fresh";
  const capabilityProfile =
    command === "repair.execute" ? "repair" : command === "schema.migrate" ? "migrate" : "verify";
  const executionScope =
    command === "repair.execute"
      ? "repair"
      : command === "schema.migrate"
        ? "migration-schema"
        : "verify";
  const request = {
    buildProof: proof,
    buildProofDigest: sha256Canonical(proof),
    actualRunnerDigest: runnerDigest,
    environmentClass,
    executionScope,
    capabilityProfile,
    secretReference: `secret://runner/${capabilityProfile}`,
    targetPolicyId: "s1-runner-controlled",
    target:
      environmentClass === "staging"
        ? {
            hostname: "staging-postgres",
            databaseName: "subscription_saas_staging",
            tlsMode: "require"
          }
        : {
            hostname: "127.0.0.1",
            databaseName: `s1ci_${"d".repeat(24)}`,
            tlsMode: "require"
          },
    baselineManifestIdentityDigest: digest("5"),
    baselineManifestDigest: digest("6"),
    databaseIdentityDigest: digest("7"),
    operationId: "f1fe589f-79f8-429e-9b09-d2f777b1431e",
    attemptId: "01710f65-23f7-4c66-b6bb-14f557fdac6e",
    idempotencyKey: "operation-launch-key-1",
    phase: command === "schema.migrate" || command === "repair.execute" ? "apply" : "verify",
    inputDigest: digest("8"),
    planDigest: digest("f")
  };
  const [commandId, commandVersion] = `${command}@1`.split("@");
  request.launchAttestation = {
    schemaVersion: "launch-attestation.v1",
    attestationId: "89a2f553-b1a3-452c-8eb9-ea349de35c95",
    issuer: "trusted-ci",
    issuedAt: "2026-09-02T07:00:00.000Z",
    notAfter: "2026-09-02T09:00:00.000Z",
    sourceSha,
    buildProofDigest: request.buildProofDigest,
    runnerDigest,
    executionScope,
    environmentClass,
    targetPolicyDigest: digest("9"),
    secretReference: request.secretReference,
    capability: capabilityProfile,
    commandId,
    commandVersion
  };
  return Object.assign(request, overrides);
}

function revocationClient(policy, artifactOverrides = {}) {
  const artifact = revocationArtifact(policy, artifactOverrides);
  return {
    attestationVerifier: trustedAttestationVerifier(),
    async listSuccessfulWorkflowRuns() {
      return {
        runs: [{ runNumber: artifact.sequence, runId: artifact.workflowRunId, runAttempt: 1 }],
        nextCursor: null
      };
    },
    async downloadRunArtifact() {
      return {
        artifact,
        attestation: revocationAttestation(artifact),
        custodyReceipt: custodyReceipt(artifact)
      };
    }
  };
}

function revocationFailureClient(policy, code, record) {
  if (code === "APPROVAL_REVOCATIONS_MISSING") {
    return {
      attestationVerifier: trustedAttestationVerifier(),
      listSuccessfulWorkflowRuns: async () => ({ runs: [], nextCursor: null }),
      downloadRunArtifact: async () => undefined
    };
  }
  if (code === "APPROVAL_REVOCATIONS_LIST_INCOMPLETE") {
    return {
      attestationVerifier: trustedAttestationVerifier(),
      listSuccessfulWorkflowRuns: async () => ({ runs: [], nextCursor: "repeated" }),
      downloadRunArtifact: async () => undefined
    };
  }
  if (code === "APPROVAL_REVOCATIONS_UNAVAILABLE") {
    return {
      attestationVerifier: trustedAttestationVerifier(),
      listSuccessfulWorkflowRuns: async () => Promise.reject(new Error("network")),
      downloadRunArtifact: async () => undefined
    };
  }
  const overrides = {};
  if (code === "APPROVAL_REVOCATIONS_EXPIRED") {
    overrides.notAfter = "2026-09-02T07:59:59.000Z";
  }
  if (code === "APPROVAL_REVOCATIONS_POLICY_MISMATCH") {
    overrides.policyDigest = digest("0");
  }
  if (code === "APPROVAL_REVOKED") {
    overrides.revocations = [
      {
        approvalId: record.approvalId,
        approvalRecordDigest: sha256Canonical(record),
        reason: "operator-revoked",
        revokedAt: "2026-09-02T07:58:00.000Z"
      }
    ];
  }
  const artifact = revocationArtifact(policy, overrides);
  const runNumber =
    code === "APPROVAL_REVOCATIONS_ROLLBACK" ? artifact.sequence + 1 : artifact.sequence;
  return {
    attestationVerifier: trustedAttestationVerifier(),
    async listSuccessfulWorkflowRuns() {
      return {
        runs: [{ runNumber, runId: artifact.workflowRunId, runAttempt: 1 }],
        nextCursor: null
      };
    },
    async downloadRunArtifact() {
      return {
        artifact,
        attestation: revocationAttestation(
          artifact,
          code === "APPROVAL_REVOCATIONS_ATTESTATION_INVALID"
            ? { subjectDigest: digest("0") }
            : code === "APPROVAL_REVOCATIONS_ISSUER_UNTRUSTED"
              ? { issuer: "https://issuer.invalid" }
              : {}
        ),
        custodyReceipt: custodyReceipt(artifact)
      };
    }
  };
}

async function launchFixture({
  commandKey = "schema.migrate@1",
  recordMutate,
  client,
  checkpointStore,
  executionState,
  executionJournal,
  handler
} = {}) {
  const policy = approvalPolicy();
  const request = requestFor(commandKey.split("@")[0]);
  const registry = await loadCommandRegistry();
  const targetPolicies = await loadTargetPolicies();
  const command = registry.commands.find(
    ({ commandId, commandVersion }) => `${commandId}@${commandVersion}` === commandKey
  );
  const bindings = {
    buildProofDigest: request.buildProofDigest,
    baselineManifestIdentityDigest: request.baselineManifestIdentityDigest,
    baselineManifestDigest: request.baselineManifestDigest,
    databaseIdentityDigest: request.databaseIdentityDigest,
    commandId: command.commandId,
    commandVersion: command.commandVersion,
    executionScope: request.executionScope,
    operationId: request.operationId,
    inputDigest: request.inputDigest,
    planDigest: request.planDigest,
    approvalPolicyDigest: sha256Canonical(policy)
  };
  let record = approvalRecord(policy, { bindings });
  if (commandApprovalMode(command, request.environmentClass, request.phase) === "human") {
    const authority = policy.authorities.human;
    record = approvalRecord(policy, {
      approvalMode: "human",
      authority: {
        issuer: authority.issuer,
        subject: authority.allowedSubjects[0],
        repository: policy.repository,
        workflowPath: authority.workflowPath,
        workflowRef: authority.workflowRef,
        environment: authority.environment
      },
      bindings
    });
  }
  record = recordMutate ? recordMutate(record) : record;
  let secretReads = 0;
  let databaseConnections = 0;
  let checkpoint;
  const journalEntries = [];
  const monotonicStore = checkpointStore ?? {
    trustPolicy: "append-only-monotonic/v1",
    async read() {
      return checkpoint;
    },
    async writeMonotonic(next) {
      if (
        checkpoint &&
        (next.sequence < checkpoint.sequence ||
          (next.sequence === checkpoint.sequence &&
            next.artifactDigest !== checkpoint.artifactDigest))
      ) {
        return { accepted: false };
      }
      checkpoint = { sequence: next.sequence, artifactDigest: next.artifactDigest };
      return { accepted: true };
    }
  };
  const launch = () =>
    trustedLaunchRunner({
      commandKey,
      request,
      registry,
      targetPolicies,
      approvalPolicy: policy,
      approvalRecord: record,
      approvalAttestation: approvalAttestation(record),
      approvalAttestationVerifier: trustedAttestationVerifier(),
      approvalCustodyReceipt: custodyReceipt(record),
      githubClient:
        typeof client === "function"
          ? client({ policy, record })
          : (client ?? revocationClient(policy)),
      revocationCheckpointStore: monotonicStore,
      executionState,
      executionJournal: executionJournal ?? {
        trustPolicy: "append-only-execution-state/v1",
        async append(entry) {
          journalEntries.push(entry);
          return {
            accepted: true,
            stateDigest: entry.stateDigest,
            readbackDigest: entry.stateDigest
          };
        }
      },
      readCredential: async () => {
        secretReads += 1;
        return { username: "runner_role", password: "not-exposed" };
      },
      connectDatabase: async () => {
        databaseConnections += 1;
        return {
          async observeIdentity() {
            return {
              databaseName: request.target.databaseName,
              databaseOid: 42,
              role: "runner_role",
              tls: true,
              schemas: ["public"],
              extensions: ["pgcrypto"],
              migrationHead: "migration-1"
            };
          }
        };
      },
      credentialFileReference: "C:/run/secrets/capability.json",
      handler,
      now
    });
  return {
    launch,
    counts: () => ({ secretReads, databaseConnections }),
    journalEntries,
    policy,
    request,
    registry,
    targetPolicies
  };
}

test("launches a protected ci-policy command only after approval and revocation verification", async () => {
  const fixture = await launchFixture();
  const result = await fixture.launch();
  assert.equal(result.terminalStatus, "PASSED");
  assert.deepEqual(fixture.counts(), { secretReads: 1, databaseConnections: 1 });
});

test("launches a protected human command with the human authority", async () => {
  const fixture = await launchFixture({ commandKey: "repair.execute@1" });
  const result = await fixture.launch();
  assert.equal(result.terminalStatus, "PASSED");
  assert.deepEqual(fixture.counts(), { secretReads: 1, databaseConnections: 1 });
});

test("launches approval-none only for a read-only registered command", async () => {
  const registry = await loadCommandRegistry();
  const targetPolicies = await loadTargetPolicies();
  const request = requestFor("release.verify");
  let secretReads = 0;
  const result = await trustedLaunchRunner({
    commandKey: "release.verify@1",
    request,
    registry,
    targetPolicies,
    approvalPolicy: approvalPolicy(),
    readCredential: async () => {
      secretReads += 1;
      return { username: "verify_role", password: "not-exposed" };
    },
    connectDatabase: async () => ({
      async observeIdentity() {
        return {
          databaseName: request.target.databaseName,
          databaseOid: 43,
          role: "verify_role",
          tls: true,
          schemas: ["public"],
          extensions: [],
          migrationHead: null
        };
      }
    }),
    credentialFileReference: "C:/run/secrets/verify.json",
    executionJournal: {
      trustPolicy: "append-only-execution-state/v1",
      async append() {
        assert.fail("successful preflight must not append a launcher terminal state");
      }
    },
    now
  });
  assert.equal(result.terminalStatus, "PASSED");
  assert.equal(secretReads, 1);
});

for (const [name, options, code] of [
  [
    "expired approval",
    {
      recordMutate: (record) => ({
        ...record,
        notAfter: "2026-09-02T07:59:59.000Z"
      })
    },
    "APPROVAL_EXPIRED"
  ],
  [
    "binding drift",
    {
      recordMutate: (record) => ({
        ...record,
        bindings: { ...record.bindings, planDigest: digest("0") }
      })
    },
    "APPROVAL_BINDING_MISMATCH"
  ],
  [
    "unavailable revocation source",
    {
      client: {
        listSuccessfulWorkflowRuns: async () => Promise.reject(new Error("network")),
        downloadRunArtifact: async () => undefined
      }
    },
    "APPROVAL_REVOCATIONS_UNAVAILABLE"
  ],
  [
    "untrusted approval authority",
    {
      recordMutate: (record) => ({
        ...record,
        authority: { ...record.authority, subject: "team:untrusted" }
      })
    },
    "APPROVAL_AUTHORITY_UNTRUSTED"
  ],
  [
    "revoked approval",
    { client: ({ policy, record }) => revocationFailureClient(policy, "APPROVAL_REVOKED", record) },
    "APPROVAL_REVOKED"
  ]
]) {
  test(`fails closed before credentials for ${name}`, async () => {
    const fixture = await launchFixture(options);
    await assert.rejects(fixture.launch(), { code });
    assert.deepEqual(fixture.counts(), { secretReads: 0, databaseConnections: 0 });
  });
}

test("does not accept caller supplied revocations when the trusted source is missing", async () => {
  const fixture = await launchFixture({
    client: {
      listSuccessfulWorkflowRuns: async () => ({ runs: [], nextCursor: null }),
      downloadRunArtifact: async () => undefined
    }
  });
  fixture.request.revocations = { sequence: 999, revocations: [] };
  await assert.rejects(fixture.launch(), { code: "APPROVAL_REVOCATIONS_MISSING" });
  assert.deepEqual(fixture.counts(), { secretReads: 0, databaseConnections: 0 });
});

test("rejects a revocation history older than the append-only launcher checkpoint", async () => {
  const fixture = await launchFixture({
    checkpointStore: {
      trustPolicy: "append-only-monotonic/v1",
      async read() {
        return { sequence: 13, artifactDigest: digest("d") };
      },
      async writeMonotonic() {
        assert.fail("rollback must not update the checkpoint");
      }
    }
  });
  await assert.rejects(fixture.launch(), { code: "APPROVAL_REVOCATIONS_ROLLBACK" });
  assert.deepEqual(fixture.counts(), { secretReads: 0, databaseConnections: 0 });
});

test("rejects an unavailable monotonic checkpoint before credentials", async () => {
  const fixture = await launchFixture({ checkpointStore: {} });
  await assert.rejects(fixture.launch(), {
    code: "APPROVAL_REVOCATIONS_CHECKPOINT_UNAVAILABLE"
  });
  assert.deepEqual(fixture.counts(), { secretReads: 0, databaseConnections: 0 });
});

test("launcher journals a preflight rejection without a database observation", async () => {
  const fixture = await launchFixture();
  fixture.request.actualRunnerDigest = digest("0");
  await assert.rejects(fixture.launch(), { code: "RUNNER_DIGEST_MISMATCH" });
  assert.deepEqual(fixture.counts(), { secretReads: 0, databaseConnections: 0 });
  assert.equal(fixture.journalEntries.length, 1);
  assert.equal(fixture.journalEntries[0].terminalClass, "PREFLIGHT_REJECTED");
  assert.equal("postStateObservationDigest" in fixture.journalEntries[0].state, false);
});

test("launcher journals committed-result-unknown and refuses to invent a post-state", async () => {
  const operationId = "f1fe589f-79f8-429e-9b09-d2f777b1431e";
  const idempotencyKey = "operation-launch-key-1";
  let state = transitionExecution(createExecutionState({ operationId, idempotencyKey }), {
    type: "DRY_RUN_SUCCEEDED",
    attemptId: "823f76da-41da-4a1d-b29a-7b397471d05a",
    planDigest: digest("f"),
    proofDigest: digest("e")
  });
  state = transitionExecution(state, {
    type: "APPLY_STARTED",
    operationId,
    idempotencyKey,
    attemptId: "01710f65-23f7-4c66-b6bb-14f557fdac6e",
    approvedPlanDigest: digest("f"),
    recomputedPlanDigest: digest("f")
  });
  const fixture = await launchFixture({
    executionState: state,
    handler: async () => {
      throw Object.assign(new Error("RUNNER_PROCESS_LOST"), {
        code: "RUNNER_PROCESS_LOST",
        outcomeUnknown: true,
        commitState: "committed-result-unproved"
      });
    }
  });
  await assert.rejects(fixture.launch(), { code: "RUNNER_PROCESS_LOST" });
  assert.deepEqual(fixture.counts(), { secretReads: 1, databaseConnections: 1 });
  assert.equal(fixture.journalEntries.length, 1);
  assert.equal(fixture.journalEntries[0].terminalClass, "INTERRUPTED_UNKNOWN");
  assert.equal("postStateObservationDigest" in fixture.journalEntries[0].state, false);
});

test("launcher fails closed when its append-only execution journal is unavailable", async () => {
  const fixture = await launchFixture({ executionJournal: {} });
  await assert.rejects(fixture.launch(), { code: "EXECUTION_JOURNAL_UNAVAILABLE" });
  assert.deepEqual(fixture.counts(), { secretReads: 0, databaseConnections: 0 });
});

for (const code of [
  "APPROVAL_REVOCATIONS_MISSING",
  "APPROVAL_REVOCATIONS_ATTESTATION_INVALID",
  "APPROVAL_REVOCATIONS_ISSUER_UNTRUSTED",
  "APPROVAL_REVOCATIONS_EXPIRED",
  "APPROVAL_REVOCATIONS_POLICY_MISMATCH",
  "APPROVAL_REVOCATIONS_ROLLBACK",
  "APPROVAL_REVOCATIONS_LIST_INCOMPLETE"
]) {
  test(`fails closed before credentials: ${code}`, async () => {
    const fixture = await launchFixture({
      client: ({ policy, record }) => revocationFailureClient(policy, code, record)
    });
    await assert.rejects(fixture.launch(), { code });
    assert.deepEqual(fixture.counts(), { secretReads: 0, databaseConnections: 0 });
  });
}
