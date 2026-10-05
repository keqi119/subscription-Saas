import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { readSnapshotOssOriginals, verifySnapshotOssOriginals } from "./snapshot-oss-originals.mjs";

const bucket = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const principal = "acs:ram::1457643390906675:assumed-role/reader/session-1";
const key = "snapshot-slots/v2/attempt-1/123/snapshot.enc";
const bytes = Buffer.from("ciphertext");
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const date = "Thu, 01 Oct 2026 00:00:00 GMT";
const acl = `<AccessControlPolicy><Owner><ID>1457643390906675</ID><DisplayName>owner</DisplayName></Owner><AccessControlList><Grant>private</Grant></AccessControlList></AccessControlPolicy>`;
const worm = `<WormConfiguration><WormId>worm-1</WormId><State>Locked</State><RetentionPeriodInDays>210</RetentionPeriodInDays><CreationDate>2026-09-01T00:00:00.000Z</CreationDate></WormConfiguration>`;
const versioning = `<VersioningConfiguration xmlns="http://doc.oss-cn-hangzhou.aliyuncs.com"></VersioningConfiguration>`;

function fixture() {
  const state = { acl, getBytes: bytes, missingBody: false, headSize: bytes.length },
    calls = [];
  const result = (body, headers = {}) => ({
    status: 200,
    data: Buffer.from(body),
    res: {
      status: 200,
      data: state.missingBody ? undefined : Buffer.from(body),
      headers: {
        date,
        "x-oss-request-id": `request-${calls.length}`,
        ...headers,
        authorization: "do-not-copy"
      }
    }
  });
  const objectHeaders = {
    "content-length": String(bytes.length),
    etag: '"etag-one"',
    "last-modified": date,
    "x-oss-server-side-encryption": "AES256"
  };
  const reader = {
    async request(input) {
      calls.push(input);
      const body = input.subres === "acl" ? state.acl : input.subres === "worm" ? worm : versioning;
      return result(body);
    },
    async head(actual) {
      calls.push(["head", actual]);
      return result(Buffer.alloc(0), {
        ...objectHeaders,
        "content-length": String(state.headSize)
      });
    },
    async get(actual) {
      calls.push(["get", actual]);
      return { ...result(state.getBytes, objectHeaders), content: Buffer.from(state.getBytes) };
    }
  };
  return { reader, state, calls };
}

test("collects six actual OSS originals and excludes ciphertext and unrelated headers", async () => {
  const f = fixture();
  const value = await readSnapshotOssOriginals(
    f.reader,
    { key, contentDigest: digest(bytes), sizeBytes: bytes.length },
    principal,
    () => new Date("2026-10-01T00:00:01.000Z")
  );
  assert.equal(value.bucket.acl, "private");
  assert.equal(value.evidence.records.bucketAcl.bucket, bucket);
  assert.equal(value.head.etag, '"etag-one"');
  assert.equal(value.get.digest, digest(bytes));
  assert.deepEqual(Object.keys(value.evidence.records), [
    "bucketAcl",
    "worm",
    "versioning",
    "head",
    "objectAcl",
    "get"
  ]);
  assert.equal(value.evidence.records.objectAcl.operation, "GetObjectAcl");
  assert.equal(value.evidence.records.get.response.body.digest, digest(bytes));
  assert.equal(value.evidence.records.get.response.body.bytes, bytes.length);
  assert.equal(value.evidence.records.get.principal, principal);
  assert.equal(
    value.evidence.originals.some((entry) => entry.bytesBase64 === bytes.toString("base64")),
    false
  );
  assert.equal(value.evidence.originals.length, 11);
  assert.equal(JSON.stringify(value).includes("do-not-copy"), false);
  assert.deepEqual(
    f.calls.map((call) => (Array.isArray(call) ? call[0] : call.subres)),
    ["acl", "worm", "versioning", "head", "acl", "get"]
  );
  assert.equal(f.calls[4].object, key);
});

test("rejects missing original body and malformed XML", async () => {
  const f = fixture();
  f.state.missingBody = true;
  await assert.rejects(
    readSnapshotOssOriginals(
      f.reader,
      { key, contentDigest: digest(bytes), sizeBytes: bytes.length },
      principal,
      () => new Date("2026-10-01T00:00:01.000Z")
    )
  );
  f.state.missingBody = false;
  f.state.acl = "<!DOCTYPE x><AccessControlPolicy/>";
  await assert.rejects(
    readSnapshotOssOriginals(
      f.reader,
      { key, contentDigest: digest(bytes), sizeBytes: bytes.length },
      principal,
      () => new Date("2026-10-01T00:00:01.000Z")
    )
  );
});

test("rejects GET bytes with the wrong ciphertext digest", async () => {
  const f = fixture();
  f.state.getBytes = Buffer.from("wrongbytes");
  await assert.rejects(
    readSnapshotOssOriginals(
      f.reader,
      { key, contentDigest: digest(bytes), sizeBytes: bytes.length },
      principal,
      () => new Date("2026-10-01T00:00:01.000Z")
    )
  );
});

test("rejects an unexpected HEAD size before downloading ciphertext", async () => {
  const f = fixture();
  f.state.headSize += 1;
  await assert.rejects(
    readSnapshotOssOriginals(
      f.reader,
      { key, contentDigest: digest(bytes), sizeBytes: bytes.length },
      principal,
      () => new Date("2026-10-01T00:00:01.000Z")
    )
  );
  assert.equal(
    f.calls.some((call) => Array.isArray(call) && call[0] === "get"),
    false
  );
});

test("replays exact stored OSS originals against ciphertext and rejects missing or altered evidence", async () => {
  const f = fixture();
  const expected = { key, contentDigest: digest(bytes), sizeBytes: bytes.length };
  const collected = await readSnapshotOssOriginals(
    f.reader,
    expected,
    principal,
    () => new Date("2026-10-01T00:00:01.000Z")
  );
  const observation = {
    ...collected,
    readerArn: principal,
    expectedWriterArn: "acs:ram::1457643390906675:assumed-role/writer/session-1",
    readerIdentityOriginal: {
      AccountId: "1457643390906675",
      Arn: principal,
      IdentityType: "AssumedRoleUser",
      RequestId: "reader-identity"
    }
  };
  const input = {
    observation,
    expected,
    ciphertext: bytes,
    startedAt: "2026-10-01T00:00:00.000Z",
    observedAt: "2026-10-01T00:00:02.000Z"
  };
  assert.deepEqual(await verifySnapshotOssOriginals(input), observation);
  const missing = globalThis.structuredClone(observation);
  missing.evidence.originals.pop();
  await assert.rejects(verifySnapshotOssOriginals({ ...input, observation: missing }));
  const tampered = globalThis.structuredClone(observation);
  tampered.evidence.records.head.response.headers.etag = '"changed"';
  const rewritten = Buffer.from(canonicalJson(tampered.evidence.records.head));
  tampered.evidence.originals[7] = {
    digest: digest(rewritten),
    bytesBase64: rewritten.toString("base64")
  };
  await assert.rejects(verifySnapshotOssOriginals({ ...input, observation: tampered }));
  const extra = globalThis.structuredClone(observation);
  extra.evidence.originals.push(extra.evidence.originals[0]);
  await assert.rejects(verifySnapshotOssOriginals({ ...input, observation: extra }));
  await assert.rejects(
    verifySnapshotOssOriginals({ ...input, ciphertext: Buffer.from("wrongbytes") })
  );
  await assert.rejects(
    verifySnapshotOssOriginals({
      ...input,
      startedAt: "2026-10-01T00:00:02.000Z"
    })
  );
});
