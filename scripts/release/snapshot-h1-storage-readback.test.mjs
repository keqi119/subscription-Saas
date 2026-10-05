import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { readH1SnapshotStorageOriginals } from "./snapshot-h1-publication.mjs";
import { readSnapshotOssOriginals } from "./snapshot-oss-originals.mjs";

test("signed publication and fresh OSS observations assemble resolvable R3 originals without claiming terminal", async () => {
  const bucket = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
  const account = "1457643390906675";
  const at = "2026-10-06T00:00:00.000Z";
  const after = "2026-10-06T00:01:00.000Z";
  const writerArn = `acs:ram::${account}:assumed-role/publisher/session`;
  const readerArn = `acs:ram::${account}:assumed-role/reader/session`;
  const identity = (Arn) => ({
    AccountId: account,
    Arn,
    IdentityType: "AssumedRoleUser",
    RequestId: "fixture-identity"
  });
  const expected = {
    releaseAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    snapshotRunId: "12345",
    sourceSha: "a".repeat(40),
    dispatchAuthorizationDigest: `sha256:${"b".repeat(64)}`
  };
  const prefix = `snapshot-slots/v2/${expected.releaseAttemptId}/${expected.snapshotRunId}/`;
  const ciphertext = Buffer.from("fixture-ciphertext");
  const record = {
    recordVersion: "r3-snapshot-oss-response.v1",
    operation: "PutObject",
    bucket,
    principal: writerArn,
    observedAt: at,
    requestHeaders: { "x-oss-forbid-overwrite": "true" },
    response: {
      status: 200,
      headers: { date: new Date(at).toUTCString(), "x-oss-request-id": "put", etag: '"etag"' },
      body: { digest: sha256Bytes(Buffer.alloc(0)), bytes: 0 }
    }
  };
  const publication = {
    ...expected,
    writerArn,
    writerIdentityOriginal: identity(writerArn),
    writerIssuedAt: at,
    writerExpiresAt: "2026-10-06T00:10:00.000Z",
    cryptoExitedAt: at,
    publishedAt: at,
    objects: [
      "snapshot.enc",
      "encryption-envelope.json",
      "snapshot-proof.json",
      "data-result.json"
    ].map((name) => ({
      key: prefix + name,
      digest: sha256Bytes(ciphertext),
      sizeBytes: ciphertext.length,
      requestId: "put",
      etag: '"etag"',
      putObservation: { record: { ...record, objectKey: prefix + name }, bodyBase64: "" }
    }))
  };
  const keys = generateKeyPairSync("ed25519");
  const signer = {
    issuer: "fixture",
    keyId: sha256Bytes(keys.publicKey.export({ type: "spki", format: "der" })),
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" })
  };
  const publicationBytes = Buffer.from(
    canonicalJson({
      publication,
      signature: {
        algorithm: "Ed25519",
        issuer: signer.issuer,
        keyId: signer.keyId,
        subjectDigest: sha256Canonical(publication),
        signature: sign(
          null,
          Buffer.from(
            canonicalJson({ domain: "h1-snapshot-publication.v1", subject: publication })
          ),
          keys.privateKey
        ).toString("base64")
      }
    })
  );
  const acl = `<AccessControlPolicy><Owner><ID>${account}</ID><DisplayName>owner</DisplayName></Owner><AccessControlList><Grant>private</Grant></AccessControlList></AccessControlPolicy>`;
  const bodies = {
    acl,
    versioning: "<VersioningConfiguration/>",
    worm: `<WormConfiguration><WormId>worm</WormId><State>Locked</State><RetentionPeriodInDays>210</RetentionPeriodInDays><CreationDate>${at}</CreationDate></WormConfiguration>`
  };
  const response = (data, headers = {}) => ({
    content: data,
    res: {
      status: 200,
      data,
      headers: { date: new Date(at).toUTCString(), "x-oss-request-id": "read", ...headers }
    }
  });
  const headers = {
    "content-length": String(ciphertext.length),
    etag: '"etag"',
    "last-modified": new Date(at).toUTCString(),
    "x-oss-server-side-encryption": "AES256"
  };
  let corruptIdentity = false;
  const reader = {
    readbackOriginals: async (request) => ({
      ...(await readSnapshotOssOriginals(
        {
          request: async ({ subres }) => response(Buffer.from(bodies[subres])),
          head: async () => response(Buffer.alloc(0), headers),
          get: async () => response(ciphertext, headers)
        },
        request,
        readerArn,
        () => new Date(after)
      )),
      readerArn,
      expectedWriterArn: writerArn,
      readerIdentityOriginal: identity(corruptIdentity ? writerArn : readerArn)
    })
  };
  const result = await readH1SnapshotStorageOriginals({
    reader,
    publicationBytes,
    expected,
    signer
  });
  const storage = result.storageReadback;
  assert.equal(storage.recordVersion, "r3-snapshot-storage-readback.v1");
  assert.equal(storage.writerIdentity, writerArn);
  assert.equal(storage.readerIdentity, readerArn);
  assert.equal("terminalAt" in result, false);
  const originals = new Map(
    result.originals.map(({ digest, bytesBase64 }) => [digest, Buffer.from(bytesBase64, "base64")])
  );
  for (const [digest, bytes] of originals) assert.equal(sha256Bytes(bytes), digest);
  for (const name of [
    "writerIdentityOriginal",
    "readerIdentityOriginal",
    "conditionalCreate",
    "head",
    "get",
    "bucketAcl",
    "objectAcl",
    "versioning",
    "worm"
  ]) {
    const raw = originals.get(storage[name].digest);
    assert.equal(raw.length, storage[name].bytes);
    const value = JSON.parse(raw);
    if (value.response && name !== "get")
      assert.equal(originals.get(value.response.body.digest).length, value.response.body.bytes);
  }
  assert.equal(originals.has(sha256Bytes(ciphertext)), false);
  corruptIdentity = true;
  await assert.rejects(
    readH1SnapshotStorageOriginals({ reader, publicationBytes, expected, signer }),
    { code: "H1_SNAPSHOT_PUBLICATION_REJECTED" }
  );
});
