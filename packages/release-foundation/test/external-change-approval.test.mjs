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
    subjectDigest: sha256Canonical({ releaseAttemptId: "attempt" }),
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
          expectedPreStateDigest: digest,
          subject: approval.subject,
          subjectDigest: sha256Canonical(approval.subject)
        },
        trust: {
          issuer: "independent-root",
          keyId: "root-1",
          publicKey: keys.publicKey,
          revocationPublicKey: keys.publicKey,
          revocationPolicyDigest: digest,
          approverImmutableId: "reviewer"
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
    subjectDigest: sha256Canonical({ releaseAttemptId: "attempt" }),
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
      expectedPreStateDigest: digest,
      subject: approval.subject,
      subjectDigest: sha256Canonical(approval.subject)
    },
    trust: {
      issuer: "independent-root",
      keyId: "root-1",
      publicKey: keys.publicKey,
      revocationPublicKey: keys.publicKey,
      revocationPolicyDigest: digest,
      approverImmutableId: "reviewer"
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
  // A pinned approver is authority; optional actor/author labels do not invent
  // an unapproved two-person policy.
  assert.equal(
    (
      await verifyExternalChangeApproval({
        ...input,
        expected: { ...input.expected, planAuthorId: "reviewer", workflowActorId: "reviewer" }
      })
    ).status,
    "verified"
  );
  let readbacks = 0;
  const forbidReadback = {
    async readCurrent() {
      readbacks++;
      throw new Error("unexpected readback");
    }
  };
  for (const expected of [
    {
      ...input.expected,
      subject: { releaseAttemptId: "other-attempt" },
      subjectDigest: sha256Canonical({ releaseAttemptId: "other-attempt" })
    },
    {
      ...input.expected,
      subject: { infrastructureChangeId: "b".repeat(32) },
      subjectDigest: sha256Canonical({ infrastructureChangeId: "b".repeat(32) })
    },
    { ...input.expected, subjectDigest: `sha256:${"b".repeat(64)}` },
    { ...input.expected, subject: undefined },
    { ...input.expected, subjectDigest: undefined }
  ]) {
    await assert.rejects(
      verifyExternalChangeApproval({ ...input, expected, revocationClient: forbidReadback }),
      { code: "EXTERNAL_CHANGE_APPROVAL_SUBJECT_MISMATCH" }
    );
  }
  for (const approverImmutableId of [undefined, "", "other-approver"]) {
    await assert.rejects(
      verifyExternalChangeApproval({
        ...input,
        trust: { ...input.trust, approverImmutableId },
        revocationClient: forbidReadback
      }),
      { code: "EXTERNAL_CHANGE_APPROVAL_APPROVER_UNTRUSTED" }
    );
  }
  assert.equal(readbacks, 0);
  const wrongDigestBody = { ...base, subjectDigest: `sha256:${"b".repeat(64)}` };
  await assert.rejects(
    verifyExternalChangeApproval({
      ...input,
      approval: {
        ...wrongDigestBody,
        protected: {
          ...protectedHeader,
          signature: signed(keys.privateKey, { ...wrongDigestBody, protected: protectedHeader })
        }
      }
    }),
    { code: "EXTERNAL_CHANGE_APPROVAL_SUBJECT_MISMATCH" }
  );
  const revokedBody = { ...revocationBody, revokedOperationIds: ["op-1"] };
  await assert.rejects(
    verifyExternalChangeApproval({
      ...input,
      revocationClient: {
        async readCurrent() {
          return { ...revokedBody, signature: signed(keys.privateKey, revokedBody) };
        }
      }
    }),
    { code: "EXTERNAL_CHANGE_APPROVAL_REVOKED" }
  );
  for (const custody of [
    null,
    { reference: "wrong", contentDigest: sha256Canonical(approval), immutable: true },
    { reference: approval.custodyReference, contentDigest: digest, immutable: true },
    {
      reference: approval.custodyReference,
      contentDigest: sha256Canonical(approval),
      immutable: false
    }
  ]) {
    await assert.rejects(
      verifyExternalChangeApproval({
        ...input,
        custodyClient: {
          async read() {
            return custody;
          }
        }
      }),
      { code: "EXTERNAL_CHANGE_APPROVAL_CUSTODY_INVALID" }
    );
  }
  await assert.rejects(
    verifyExternalChangeApproval({
      ...input,
      custodyClient: {
        async read() {
          throw new Error("offline");
        }
      }
    }),
    { code: "EXTERNAL_CHANGE_APPROVAL_CUSTODY_UNAVAILABLE" }
  );
  await assert.rejects(
    verifyExternalChangeApproval({
      ...input,
      revocationClient: {
        async readCurrent() {
          throw new Error("offline");
        }
      }
    }),
    { code: "EXTERNAL_CHANGE_APPROVAL_UNAVAILABLE" }
  );
  const staleBody = { ...revocationBody, notAfter: "2026-09-04T00:15:00.000Z" };
  await assert.rejects(
    verifyExternalChangeApproval({
      ...input,
      revocationClient: {
        async readCurrent() {
          return { ...staleBody, signature: signed(keys.privateKey, staleBody) };
        }
      }
    }),
    { code: "EXTERNAL_CHANGE_APPROVAL_REVOCATION_EXPIRED" }
  );
  await assert.rejects(
    verifyExternalChangeApproval({
      ...input,
      revocationClient: {
        async readCurrent() {
          return { ...revocation, signature: "AAAA" };
        }
      }
    }),
    { code: "EXTERNAL_CHANGE_APPROVAL_REVOCATION_INVALID" }
  );
  const missingDigest = structuredClone(approval);
  delete missingDigest.subjectDigest;
  await assert.rejects(verifyExternalChangeApproval({ ...input, approval: missingDigest }), {
    code: "EXTERNAL_CHANGE_APPROVAL_CONTRACT_INVALID"
  });
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
