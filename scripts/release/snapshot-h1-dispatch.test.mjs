import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { createInstalledH1DispatchVerification } from "./snapshot-h1-dispatch.mjs";
import { admitH1Snapshot } from "./snapshot-h1-admit.mjs";
import {
  readAndSignH1CurrentRevocation,
  readH1SnapshotDispatchInputs,
  verifyH1ArchivedDispatchPacket
} from "./snapshot-h1-signing.mjs";

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const signer = {
    issuer: "fixture",
    keyId: "fixture-key",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" })
  };
  const signBody = (body, domain, name) => ({
    algorithm: "Ed25519",
    issuer: signer.issuer,
    keyId: signer.keyId,
    subjectDigest: sha256Canonical(body),
    signature: sign(
      null,
      Buffer.from(canonicalJson({ domain, [name]: body })),
      keys.privateKey
    ).toString("base64")
  });
  const policyDigest = `sha256:${"a".repeat(64)}`;
  const body = {
    schemaVersion: "i0-revocation-state.v1",
    policyDigest,
    sequence: 3,
    revokedAuthorizationIds: ["previous-attempt"],
    revokedAuthorizationDigests: []
  };
  const digest = sha256Canonical(body);
  const key = `control-evidence/v1/i0-revocation-state.v1/${digest}`;
  const uploadedAt = "2026-10-06T00:00:00.000Z";
  const now = "2026-10-06T00:01:00.000Z";
  const retainUntil = new Date(Date.parse(uploadedAt) + 210 * 86400000).toISOString();
  const archive = {
    reference: key,
    objectKey: key,
    objectVersion: "null-version-disabled",
    terminalAt: uploadedAt,
    snapshotExpiresAt: null,
    downstreamRetainUntil: new Date(Date.parse(uploadedAt) + 180 * 86400000).toISOString(),
    legalHoldUntil: null
  };
  const custody = {
    signer,
    writerIdentity: "writer",
    readerIdentity: "independent-reader",
    storeRef: "fixture-store",
    owner: "release-engineering",
    readers: ["audit"]
  };
  const receipt = {
    schemaVersion: "custody-receipt.v1",
    receiptId: "90d96a42-b007-4050-9c86-7d98a926a1d0",
    contentDigest: digest,
    contentSizeBytes: Buffer.byteLength(canonicalJson(body)),
    storeRef: custody.storeRef,
    uploadedAt,
    readbackAt: now,
    readbackDigest: digest,
    owner: custody.owner,
    readers: custody.readers,
    retainUntil,
    expiryDisposition: "review",
    attestationRef: "fixture-attestation"
  };
  const { reference, ...location } = archive;
  assert.equal(reference, key);
  const observation = {
    schemaVersion: "authoritative-custody-observation.v1",
    issuer: signer.issuer,
    keyId: signer.keyId,
    ...location,
    contentDigest: digest,
    contentSizeBytes: receipt.contentSizeBytes,
    receiptDigest: sha256Canonical(receipt),
    storeRef: custody.storeRef,
    writerIdentity: custody.writerIdentity,
    readerIdentity: custody.readerIdentity,
    conditionalCreate: "created",
    headDigest: digest,
    getDigest: digest,
    acl: "private",
    lastModified: uploadedAt,
    readbackAt: now,
    worm: { id: "fixture-worm", state: "Locked", retentionDays: 210, retainUntil }
  };
  return {
    kind: "state",
    now,
    trustPolicy: { custody, revocation: { signer, policyDigest } },
    packet: {
      body,
      archive,
      receipt,
      observation,
      signature: signBody(body, body.schemaVersion, "state"),
      observationSignature: signBody(observation, observation.schemaVersion, "observation")
    }
  };
}

test("archived current head requires real body and custody signatures with exact content address", () => {
  const input = fixture();
  const result = verifyH1ArchivedDispatchPacket(input);
  assert.deepEqual(result.body.revokedAuthorizationIds, ["previous-attempt"]);
  assert.notEqual(result, input.packet);
  input.packet.body.revokedAuthorizationIds.length = 0;
  assert.deepEqual(result.body.revokedAuthorizationIds, ["previous-attempt"]);
  assert.throws(() => verifyH1ArchivedDispatchPacket(input), {
    code: "H1_SNAPSHOT_SIGNING_REJECTED"
  });
});

test("a valid body signature cannot substitute an archive key, custody observation or policy", () => {
  for (const mutate of [
    (value) => {
      value.packet.archive.objectKey += "-other";
    },
    (value) => {
      value.packet.observation.readerIdentity = "writer";
    },
    (value) => {
      value.trustPolicy.revocation.policyDigest = `sha256:${"b".repeat(64)}`;
    },
    (value) => {
      value.now = "2026-10-05T00:00:00.000Z";
    }
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => verifyH1ArchivedDispatchPacket(value), {
      code: "H1_SNAPSHOT_SIGNING_REJECTED"
    });
  }
});

test("installed dispatch and fresh-head entry reject injected source, key, path and state", async () => {
  await assert.rejects(createInstalledH1DispatchVerification({ evidenceSource: {} }), {
    code: "H1_DISPATCH_SOURCE_REJECTED"
  });
  await assert.rejects(readH1SnapshotDispatchInputs({ path: "/tmp/authority" }), {
    code: "H1_SNAPSHOT_SIGNING_REJECTED"
  });
  let read = false;
  await assert.rejects(
    readAndSignH1CurrentRevocation({
      policyDigest: `sha256:${"a".repeat(64)}`,
      authorizationDigest: `sha256:${"b".repeat(64)}`,
      nonce: "c".repeat(64),
      get state() {
        read = true;
        throw Error("injected");
      }
    }),
    { code: "H1_SNAPSHOT_SIGNING_REJECTED" }
  );
  assert.equal(read, false);
  await assert.rejects(
    readAndSignH1CurrentRevocation({
      policyDigest: `sha256:${"a".repeat(64)}`,
      authorizationDigest: `sha256:${"b".repeat(64)}`,
      nonce: "old"
    }),
    { code: "H1_SNAPSHOT_SIGNING_REJECTED" }
  );
});

test("root admission rejects authority injection and mismatched public job selection before reads", async () => {
  await assert.rejects(admitH1Snapshot({ selection: {}, approvalSelection: {}, rootPolicy: {} }), {
    code: "H1_SNAPSHOT_ADMIT_REJECTED"
  });
  const input = {
    selection: {
      repository: { id: "1253231368", name: "keqi119/subscription-Saas" },
      runId: "10",
      runAttempt: 1,
      sourceSha: "a".repeat(40),
      admissionJobId: "11",
      jobId: "12",
      artifactId: "13",
      artifactName: "snapshot-admission"
    },
    approvalSelection: { runId: "10", runAttempt: 1, jobId: "999", deploymentId: "14" }
  };
  await assert.rejects(admitH1Snapshot(input), { code: "H1_SNAPSHOT_ADMIT_REJECTED" });
});
