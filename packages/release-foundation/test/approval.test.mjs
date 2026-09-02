import assert from "node:assert/strict";
import test from "node:test";

import { verifyApproval } from "../src/approval.mjs";
import {
  verifyRevocationArtifact,
  verifyTrustedArtifactAttestation
} from "../src/approval-revocations.mjs";
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
} from "./approval-fixtures.mjs";

async function fixture() {
  const policy = approvalPolicy();
  const record = approvalRecord(policy);
  const artifact = revocationArtifact(policy);
  const verifiedRevocationAttestation = await verifyTrustedArtifactAttestation({
    envelope: revocationAttestation(artifact),
    verifier: trustedAttestationVerifier(),
    subjectDigest: (await import("../src/digest.mjs")).sha256Canonical(artifact)
  });
  const verifiedRevocations = verifyRevocationArtifact({
    artifact,
    policy,
    attestation: verifiedRevocationAttestation,
    custodyReceipt: custodyReceipt(artifact),
    observedHeadSequence: artifact.sequence,
    expectedPreviousArtifactDigest: policy.revocationSource.checkpointArtifactDigest,
    now
  });
  return {
    record,
    policy,
    attestation: approvalAttestation(record),
    attestationVerifier: trustedAttestationVerifier(),
    custodyReceipt: custodyReceipt(record),
    verifiedRevocations,
    expected: {
      ...record.bindings,
      environmentClass: "ci-fresh",
      dataImpact: "ddl",
      approvalMode: "ci-policy"
    },
    now
  };
}

test("returns an immutable verified approval decision", async () => {
  const decision = await verifyApproval(await fixture());
  assert.deepEqual(Object.keys(decision).sort(), [
    "approvalRecordDigest",
    "authority",
    "expiresAt",
    "status"
  ]);
  assert.equal(decision.status, "verified");
  assert.equal(Object.isFrozen(decision), true);
});

for (const field of [
  "buildProofDigest",
  "baselineManifestIdentityDigest",
  "baselineManifestDigest",
  "databaseIdentityDigest",
  "commandId",
  "commandVersion",
  "executionScope",
  "operationId",
  "inputDigest",
  "planDigest",
  "approvalPolicyDigest"
]) {
  test(`rejects approval bound to another ${field}`, async () => {
    const input = await fixture();
    const alternate = field.includes("Digest")
      ? digest("0")
      : field === "commandVersion"
        ? "2"
        : field === "executionScope"
          ? "verify"
          : "wrong";
    input.record = approvalRecord(input.policy, { bindings: { [field]: alternate } });
    input.attestation = approvalAttestation(input.record);
    input.custodyReceipt = custodyReceipt(input.record);
    await assert.rejects(() => verifyApproval(input), { code: "APPROVAL_BINDING_MISMATCH" });
  });
}

test("rejects untrusted authority and an invalid attestation subject", async () => {
  const authority = await fixture();
  authority.attestation = { ...authority.attestation, issuer: "https://issuer.invalid" };
  await assert.rejects(() => verifyApproval(authority), {
    code: "APPROVAL_AUTHORITY_UNTRUSTED"
  });

  const subject = await fixture();
  subject.attestation = { ...subject.attestation, subjectDigest: digest("0") };
  await assert.rejects(() => verifyApproval(subject), {
    code: "ARTIFACT_ATTESTATION_INVALID"
  });
});

test("rejects expired and revoked approval records", async () => {
  const expired = await fixture();
  expired.record = approvalRecord(expired.policy, { notAfter: "2026-09-02T07:59:59.000Z" });
  expired.attestation = approvalAttestation(expired.record);
  expired.custodyReceipt = custodyReceipt(expired.record);
  await assert.rejects(() => verifyApproval(expired), { code: "APPROVAL_EXPIRED" });

  const revoked = await fixture();
  const artifact = revocationArtifact(revoked.policy, {
    revocations: [
      {
        approvalId: revoked.record.approvalId,
        approvalRecordDigest: revoked.attestation.subjectDigest,
        reason: "operator-revoked",
        revokedAt: "2026-09-02T07:58:00.000Z"
      }
    ]
  });
  const verifiedRevocationAttestation = await verifyTrustedArtifactAttestation({
    envelope: revocationAttestation(artifact),
    verifier: trustedAttestationVerifier(),
    subjectDigest: (await import("../src/digest.mjs")).sha256Canonical(artifact)
  });
  revoked.verifiedRevocations = verifyRevocationArtifact({
    artifact,
    policy: revoked.policy,
    attestation: verifiedRevocationAttestation,
    custodyReceipt: custodyReceipt(artifact),
    observedHeadSequence: artifact.sequence,
    expectedPreviousArtifactDigest: revoked.policy.revocationSource.checkpointArtifactDigest,
    now
  });
  await assert.rejects(() => verifyApproval(revoked), { code: "APPROVAL_REVOKED" });
});

test("rejects raw caller-provided revocation JSON", async () => {
  const input = await fixture();
  input.verifiedRevocations = {
    artifactDigest: digest("1"),
    revokedApprovalIds: [],
    revokedRecordDigests: []
  };
  await assert.rejects(() => verifyApproval(input), {
    code: "APPROVAL_REVOCATIONS_UNVERIFIED"
  });
});

test("rejects an unverified approval attestation", async () => {
  const input = await fixture();
  input.attestationVerifier = undefined;
  await assert.rejects(() => verifyApproval(input), {
    code: "ARTIFACT_ATTESTATION_VERIFIER_UNTRUSTED"
  });
});

test("rejects approval custody that does not match the policy", async () => {
  const input = await fixture();
  input.custodyReceipt = { ...input.custodyReceipt, owner: "another-owner" };
  await assert.rejects(() => verifyApproval(input), { code: "APPROVAL_CUSTODY_INVALID" });
});
