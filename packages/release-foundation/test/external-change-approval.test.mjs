import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { canonicalJson, sha256Canonical, verifyExternalChangeApproval } from "../src/index.mjs";

const digest = `sha256:${"a".repeat(64)}`;
function signed(privateKey, body) {
  return sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64");
}
test("fails closed before custody when the approval signature is invalid", async () => {
  const keys = generateKeyPairSync("ed25519");
  const approval = {
    schemaVersion: "external-change-approval.v1",
    operationId: "op-1",
    subject: { releaseAttemptId: "attempt" },
    target: { resourceKind: "oidc-provider", resourceId: "provider" },
    planDigest: digest,
    expectedPreStateDigest: digest,
    approver: { immutableId: "reviewer" },
    issuedAt: "2026-09-04T00:00:00.000Z",
    notAfter: "2026-09-04T01:00:00.000Z",
    revocationPolicyDigest: digest,
    custodyReference: "custody://approval",
    protected: {
      issuer: "independent-root",
      keyId: "root-1",
      algorithm: "Ed25519",
      signature: "AAAA"
    }
  };
  let custodyCalls = 0;
  await assert.rejects(
    () =>
      verifyExternalChangeApproval({
        approval,
        expected: {
          operationId: "op-1",
          target: approval.target,
          planDigest: digest,
          expectedPreStateDigest: digest
        },
        trust: {
          issuer: "independent-root",
          keyId: "root-1",
          publicKey: keys.publicKey,
          revocationPublicKey: keys.publicKey,
          revocationPolicyDigest: digest
        },
        revocationClient: {
          async readCurrent() {
            throw new Error("should not read");
          }
        },
        custodyClient: {
          async read() {
            custodyCalls++;
          }
        },
        now: new Date("2026-09-04T00:30:00.000Z")
      }),
    { code: "EXTERNAL_CHANGE_APPROVAL_SIGNATURE_INVALID" }
  );
  assert.equal(custodyCalls, 0);
});

test("verifies pinned signatures, current revocation and immutable custody", async () => {
  const keys = generateKeyPairSync("ed25519");
  const base = {
    schemaVersion: "external-change-approval.v1",
    operationId: "op-1",
    subject: { releaseAttemptId: "attempt" },
    target: { resourceKind: "oidc-provider", resourceId: "provider" },
    planDigest: digest,
    expectedPreStateDigest: digest,
    approver: { immutableId: "reviewer" },
    issuedAt: "2026-09-04T00:00:00.000Z",
    notAfter: "2026-09-04T01:00:00.000Z",
    revocationPolicyDigest: digest,
    custodyReference: "custody://approval"
  };
  const protectedHeader = { issuer: "independent-root", keyId: "root-1", algorithm: "Ed25519" };
  const approval = {
    ...base,
    protected: {
      ...protectedHeader,
      signature: signed(keys.privateKey, { ...base, protected: protectedHeader })
    }
  };
  const revocationBody = {
    sequence: 2,
    policyDigest: digest,
    issuedAt: "2026-09-04T00:00:00.000Z",
    notAfter: "2026-09-04T01:00:00.000Z",
    revokedOperationIds: []
  };
  const revocation = { ...revocationBody, signature: signed(keys.privateKey, revocationBody) };
  const input = {
    approval,
    expected: {
      operationId: "op-1",
      target: approval.target,
      planDigest: digest,
      expectedPreStateDigest: digest
    },
    trust: {
      issuer: "independent-root",
      keyId: "root-1",
      publicKey: keys.publicKey,
      revocationPublicKey: keys.publicKey,
      revocationPolicyDigest: digest
    },
    revocationClient: {
      async readCurrent() {
        return revocation;
      }
    },
    custodyClient: {
      async read({ reference }) {
        return { reference, contentDigest: sha256Canonical(approval), immutable: true };
      }
    },
    now: new Date("2026-09-04T00:30:00.000Z")
  };
  const decision = await verifyExternalChangeApproval(input);
  assert.equal(decision.status, "verified");
  await assert.rejects(
    () =>
      verifyExternalChangeApproval({
        ...input,
        expected: { ...input.expected, planDigest: `sha256:${"b".repeat(64)}` }
      }),
    { code: "EXTERNAL_CHANGE_APPROVAL_BINDING_MISMATCH" }
  );
  await assert.rejects(
    () => verifyExternalChangeApproval({ ...input, previouslyObservedRevocation: { sequence: 3 } }),
    { code: "EXTERNAL_CHANGE_APPROVAL_REVOKED" }
  );
  await assert.rejects(
    () => verifyExternalChangeApproval({ ...input, now: new Date("2026-09-04T01:00:00.000Z") }),
    { code: "EXTERNAL_CHANGE_APPROVAL_EXPIRED" }
  );
});
