import assert from "node:assert/strict";
import test from "node:test";

import { sha256Canonical } from "@subscription-saas/release-foundation";

import { executeRegisteredCommand, verifyPreflight } from "../src/preflight.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const runnerDigest = `sha256:${"b".repeat(64)}`;
const sourceSha = "c".repeat(40);

function fixture(overrides = {}) {
  const command = {
    commandId: "release.verify",
    commandVersion: "1",
    category: "verify",
    dataImpact: "read-only",
    capabilityProfile: "verify",
    allowedEnvironments: ["ci-fresh", "ci-snapshot", "staging"],
    prohibitedEnvironments: ["production"],
    approvalMode: "none",
    allowedExecutionScopes: ["full-rc", "verify"]
  };
  const buildProof = {
    schemaVersion: "build-proof.v1",
    identity: {
      schemaVersion: "build-proof.identity.v1",
      images: {
        api: {
          name: "api",
          registry: "ghcr.io/example/api",
          platform: "linux/amd64",
          imageDigest: digest,
          sourceRevision: sourceSha
        },
        web: {
          name: "web",
          registry: "ghcr.io/example/web",
          platform: "linux/amd64",
          imageDigest: digest,
          sourceRevision: sourceSha
        },
        runner: {
          name: "runner",
          registry: "ghcr.io/example/runner",
          platform: "linux/amd64",
          imageDigest: runnerDigest,
          sourceRevision: sourceSha
        }
      },
      sourceSha,
      migrationCatalogDigest: digest,
      repositoryContractDigest: digest
    },
    provenance: {
      generatedAt: "2026-09-02T00:00:00.000Z",
      ciRunRef: "ci://1",
      attestationRef: "attestation://1",
      checkoutRef: sourceSha,
      baseImages: [{ name: "node", resolvedDigest: digest }],
      materials: [{ name: "repository", reference: sourceSha }],
      registryResolutionEvidenceDigest: digest
    }
  };
  const request = {
    buildProof,
    buildProofDigest: sha256Canonical(buildProof),
    actualRunnerDigest: runnerDigest,
    environmentClass: "ci-fresh",
    executionScope: "verify",
    capabilityProfile: "verify",
    secretReference: "secret://runner/verify",
    target: { hostname: "127.0.0.1", databaseName: `s1ci_${"d".repeat(24)}`, tlsMode: "require" },
    launchAttestation: {
      schemaVersion: "launch-attestation.v1",
      attestationId: "00000000-0000-4000-8000-000000000001",
      issuer: "trusted-ci",
      issuedAt: "2026-09-02T00:00:00.000Z",
      notAfter: "2026-09-02T01:00:00.000Z",
      sourceSha,
      buildProofDigest: sha256Canonical(buildProof),
      runnerDigest,
      executionScope: "verify",
      environmentClass: "ci-fresh",
      targetPolicyDigest: digest,
      secretReference: "secret://runner/verify",
      capability: "verify",
      commandId: "release.verify",
      commandVersion: "1"
    }
  };
  return {
    command,
    request,
    policy: {
      allowedEnvironments: ["ci-fresh", "ci-snapshot", "staging"],
      allowedHosts: ["127.0.0.1"],
      databaseNamePattern: "^s1ci_[0-9a-f]{24}$",
      requiredTlsMode: "require",
      secretReferencePattern: "^secret://[a-z0-9][a-z0-9./_-]+$"
    },
    ...overrides
  };
}

test("validates the complete pre-connection trust binding", () => {
  assert.equal(verifyPreflight(fixture()).status, "verified");
});

for (const [name, mutate, code] of [
  [
    "build proof digest",
    (f) => (f.request.buildProofDigest = digest),
    "RUNNER_BUILD_PROOF_DIGEST_MISMATCH"
  ],
  ["runner digest", (f) => (f.request.actualRunnerDigest = digest), "RUNNER_DIGEST_MISMATCH"],
  [
    "prohibited environment",
    (f) => (f.request.environmentClass = "production"),
    "RUNNER_ENVIRONMENT_PROHIBITED"
  ],
  [
    "unknown environment",
    (f) => (f.request.environmentClass = "development"),
    "RUNNER_ENVIRONMENT_UNKNOWN"
  ],
  ["capability", (f) => (f.request.capabilityProfile = "repair"), "RUNNER_CAPABILITY_MISMATCH"],
  [
    "execution scope",
    (f) => (f.request.executionScope = "repair"),
    "RUNNER_EXECUTION_SCOPE_PROHIBITED"
  ],
  [
    "mutable image identity",
    (f) => (f.request.actualRunnerDigest = "runner:latest"),
    "RUNNER_IMAGE_IDENTITY_MUTABLE"
  ],
  [
    "target host",
    (f) => (f.request.target.hostname = "db.example.invalid"),
    "RUNNER_TARGET_POLICY_REJECTED"
  ]
]) {
  test(`rejects invalid ${name} before secret or database access`, async () => {
    const input = fixture();
    mutate(input);
    let secretReads = 0;
    let databaseConnections = 0;
    await assert.rejects(
      () =>
        executeRegisteredCommand({
          ...input,
          readCredential: async () => secretReads++,
          connectDatabase: async () => databaseConnections++
        }),
      { code }
    );
    assert.equal(secretReads, 0);
    assert.equal(databaseConnections, 0);
  });
}
