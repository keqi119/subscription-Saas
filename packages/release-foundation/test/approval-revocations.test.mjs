import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchLatestTrustedRevocations,
  publishRevocationArtifact,
  verifyRevocationArtifact,
  verifyTrustedArtifactAttestation
} from "../src/approval-revocations.mjs";
import {
  approvalPolicy,
  custodyReceipt,
  digest,
  now,
  revocationArtifact,
  revocationAttestation,
  trustedAttestationVerifier
} from "./approval-fixtures.mjs";

async function verifyFixture(overrides = {}) {
  const policy = approvalPolicy();
  const artifact = revocationArtifact(policy, overrides.artifact);
  const envelope = revocationAttestation(artifact, overrides.attestation);
  const attestation = await verifyTrustedArtifactAttestation({
    envelope,
    verifier: trustedAttestationVerifier(),
    subjectDigest: (await import("../src/digest.mjs")).sha256Canonical(artifact)
  });
  return {
    artifact,
    policy,
    attestation,
    custodyReceipt: custodyReceipt(artifact, overrides.custodyReceipt),
    observedHeadSequence: overrides.observedHeadSequence ?? artifact.sequence,
    expectedPreviousArtifactDigest:
      overrides.expectedPreviousArtifactDigest ?? policy.revocationSource.checkpointArtifactDigest,
    now: overrides.now ?? now
  };
}

test("verifies the current attested revocation head", async () => {
  const verified = verifyRevocationArtifact(await verifyFixture());
  assert.equal(verified.sequence, 12);
  assert.equal(Object.isFrozen(verified), true);
});

for (const [name, mutate, code] of [
  ["missing artifact", (f) => (f.artifact = undefined), "APPROVAL_REVOCATIONS_MISSING"],
  ["expiry", (f) => (f.now = new Date("2026-09-02T09:00:00.000Z")), "APPROVAL_REVOCATIONS_EXPIRED"],
  [
    "policy",
    (f) => (f.artifact.policyDigest = digest("0")),
    "APPROVAL_REVOCATIONS_POLICY_MISMATCH"
  ],
  ["rollback", (f) => (f.observedHeadSequence = 13), "APPROVAL_REVOCATIONS_ROLLBACK"],
  [
    "chain",
    (f) => (f.expectedPreviousArtifactDigest = digest("8")),
    "APPROVAL_REVOCATIONS_CHAIN_BROKEN"
  ]
]) {
  test(`fails closed for invalid revocation ${name}`, async () => {
    const input = await verifyFixture();
    mutate(input);
    assert.throws(() => verifyRevocationArtifact(input), { code });
  });
}

test("rejects an invalid attestation subject before artifact verification", async () => {
  await assert.rejects(() => verifyFixture({ attestation: { subjectDigest: digest("0") } }), {
    code: "ARTIFACT_ATTESTATION_INVALID"
  });
});

test("rejects a cryptographically verified but untrusted revocation issuer", async () => {
  const input = await verifyFixture({ attestation: { issuer: "https://issuer.invalid" } });
  assert.throws(() => verifyRevocationArtifact(input), {
    code: "APPROVAL_REVOCATIONS_ISSUER_UNTRUSTED"
  });
});

test("rejects revocation custody that does not match the policy", async () => {
  const input = await verifyFixture({ custodyReceipt: { owner: "another-owner" } });
  assert.throws(() => verifyRevocationArtifact(input), {
    code: "APPROVAL_REVOCATIONS_CUSTODY_INVALID"
  });
});

test("rejects a same-sequence artifact with a different previously observed digest", async () => {
  const input = await verifyFixture();
  input.previouslyObserved = {
    sequence: input.artifact.sequence,
    artifactDigest: digest("0")
  };
  assert.throws(() => verifyRevocationArtifact(input), {
    code: "APPROVAL_REVOCATIONS_ROLLBACK"
  });
});

test("fetches every page and verifies the complete digest chain", async () => {
  const policy = approvalPolicy();
  const first = revocationArtifact(policy, {
    sequence: 11,
    workflowRunId: "5011",
    previousArtifactDigest: policy.revocationSource.checkpointArtifactDigest
  });
  const second = revocationArtifact(policy, {
    sequence: 12,
    workflowRunId: "5012",
    previousArtifactDigest: (await import("../src/digest.mjs")).sha256Canonical(first)
  });
  const pages = [
    { runs: [{ runNumber: 11, runId: "5011", runAttempt: 1 }], nextCursor: "page-2" },
    { runs: [{ runNumber: 12, runId: "5012", runAttempt: 1 }], nextCursor: null }
  ];
  const artifacts = new Map([
    ["5011", first],
    ["5012", second]
  ]);
  let calls = 0;
  const verified = await fetchLatestTrustedRevocations({
    policy,
    now,
    githubClient: {
      attestationVerifier: trustedAttestationVerifier(),
      async listSuccessfulWorkflowRuns({ cursor }) {
        assert.equal(cursor, calls === 0 ? undefined : "page-2");
        return pages[calls++];
      },
      async downloadRunArtifact({ runId, artifactName }) {
        assert.equal(artifactName, `${policy.revocationSource.artifactNamePrefix}${runId}`);
        const artifact = artifacts.get(runId);
        return {
          artifact,
          attestation: revocationAttestation(artifact),
          custodyReceipt: custodyReceipt(artifact)
        };
      }
    }
  });
  assert.equal(calls, 2);
  assert.equal(verified.sequence, 12);
});

test("rejects a valid older head after a newer checkpoint was observed", async () => {
  const policy = approvalPolicy();
  const artifact = revocationArtifact(policy);
  await assert.rejects(
    () =>
      fetchLatestTrustedRevocations({
        policy,
        now,
        previouslyObserved: { sequence: 13, artifactDigest: digest("d") },
        githubClient: {
          attestationVerifier: trustedAttestationVerifier(),
          async listSuccessfulWorkflowRuns() {
            return {
              runs: [
                { runNumber: artifact.sequence, runId: artifact.workflowRunId, runAttempt: 1 }
              ],
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
        }
      }),
    { code: "APPROVAL_REVOCATIONS_ROLLBACK" }
  );
});

test("publishes an attested revocation artifact through immutable custody", async () => {
  const policy = approvalPolicy();
  const artifact = revocationArtifact(policy);
  const objects = new Map();
  const receipt = await publishRevocationArtifact({
    artifact,
    policy,
    storage: {
      trustPolicy: "immutable-content-addressed/v1",
      writerIdentity: "protected-ci-writer",
      auditReaderIdentity: "audit-reader",
      async createOnly({ key, bytes, requestedAt, retainUntil }) {
        assert.equal(objects.has(key), false);
        objects.set(key, Buffer.from(bytes));
        return {
          created: true,
          storeRef: `artifact://release/${key}`,
          contentSizeBytes: Buffer.byteLength(bytes),
          storedAt: requestedAt,
          retainUntil
        };
      },
      async read({ key, identity }) {
        assert.equal(identity, "audit-reader");
        return objects.get(key);
      }
    },
    attestor: {
      async attestSubject(subject) {
        return {
          ...subject,
          issuer: policy.revocationSource.attestationIssuer,
          reference: "attestation://release/revocations-12"
        };
      }
    },
    now: () => now,
    createReceiptId: () => "edfc1a10-a2eb-42e9-8afa-474ddeddf5c4"
  });
  assert.equal(
    receipt.contentDigest,
    (await import("../src/digest.mjs")).sha256Canonical(artifact)
  );
  assert.equal(receipt.retainUntil, "2027-03-01T08:00:00.000Z");
});

for (const [name, client, code] of [
  [
    "incomplete listing",
    {
      attestationVerifier: trustedAttestationVerifier(),
      listSuccessfulWorkflowRuns: async () => ({ runs: [], nextCursor: "lost" }),
      downloadRunArtifact: async () => undefined
    },
    "APPROVAL_REVOCATIONS_LIST_INCOMPLETE"
  ],
  [
    "unavailable source",
    {
      listSuccessfulWorkflowRuns: async () => Promise.reject(new Error("network")),
      downloadRunArtifact: async () => undefined,
      attestationVerifier: trustedAttestationVerifier()
    },
    "APPROVAL_REVOCATIONS_UNAVAILABLE"
  ]
]) {
  test(`fails closed for ${name}`, async () => {
    await assert.rejects(
      () => fetchLatestTrustedRevocations({ policy: approvalPolicy(), githubClient: client, now }),
      { code }
    );
  });
}
