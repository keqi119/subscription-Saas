import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createSnapshotPublisherTransport,
  createSnapshotReaderTransport
} from "./snapshot-oss-storage.mjs";

const owner = "1457643390906675";
const bucket = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const now = "2026-10-01T00:00:00.000Z";
const writerArn = `acs:ram::${owner}:assumed-role/snapshot-writer/session-1`;
const readerArn = `acs:ram::${owner}:assumed-role/snapshot-reader/session-1`;
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const session = (arn, suffix) => ({
  arn,
  accessKeyId: `STS.${suffix}`,
  accessKeySecret: `${suffix}-secret`,
  stsToken: `${suffix}-token`,
  issuedAt: now,
  expiresAt: "2026-10-01T00:10:00.000Z"
});
const key = "snapshot-slots/v2/attempt-1/12345/snapshot.enc";
const identity = { releaseAttemptId: "attempt-1", snapshotRunId: "12345" };
const res = (headers = {}, data = Buffer.alloc(0)) => ({
  res: {
    status: 200,
    data,
    headers: {
      date: "Thu, 01 Oct 2026 00:00:00 GMT",
      "x-oss-request-id": "read-request",
      ...headers
    }
  },
  status: 200
});

function fixture() {
  const objects = new Map(),
    calls = [],
    clients = [],
    state = { conflict: false, corrupt: false, unknown: false };
  const createOssClient = (options) => {
    clients.push(options);
    assert.equal(options.bucket, bucket);
    assert.equal(options.endpoint, "https://oss-cn-shanghai.aliyuncs.com");
    assert.equal(options.authorizationV4, true);
    assert.equal(options.secure, true);
    assert.equal(options.retryMax, 0);
    if (options.accessKeyId === "STS.writer")
      return {
        put: async (actualKey, bytes, settings) => {
          calls.push(["put", actualKey]);
          assert.deepEqual(settings.headers, {
            "x-oss-forbid-overwrite": "true",
            "x-oss-object-acl": "private",
            "x-oss-server-side-encryption": "AES256"
          });
          if (state.conflict)
            throw Object.assign(new Error("private vendor text"), {
              status: 409,
              code: "FileAlreadyExists"
            });
          objects.set(actualKey, Buffer.from(bytes));
          if (state.unknown) throw new Error("private vendor text");
          return {
            res: {
              status: 200,
              data: state.missingBody ? undefined : Buffer.alloc(0),
              headers: {
                date: "Thu, 01 Oct 2026 00:00:00 GMT",
                "x-oss-request-id": "put-request",
                etag: '"etag-one"',
                authorization: "must-not-leak"
              }
            }
          };
        }
      };
    return {
      getBucketACL: async () => ({ ...res(), acl: "private", owner: { id: owner } }),
      getBucketWorm: async () => ({
        ...res(),
        state: "Locked",
        days: "210",
        wormId: "worm-id",
        creationDate: now
      }),
      request: async ({ subres }) => {
        const bodies = {
          acl: "<AccessControlPolicy><Owner><ID>1457643390906675</ID><DisplayName>owner</DisplayName></Owner><AccessControlList><Grant>private</Grant></AccessControlList></AccessControlPolicy>",
          worm: `<WormConfiguration><WormId>worm-id</WormId><State>Locked</State><RetentionPeriodInDays>210</RetentionPeriodInDays><CreationDate>${now}</CreationDate></WormConfiguration>`,
          versioning:
            '<VersioningConfiguration xmlns="http://doc.oss-cn-hangzhou.aliyuncs.com"></VersioningConfiguration>'
        };
        const data = Buffer.from(bodies[subres]);
        return { ...res({}, data), data };
      },
      head: async (actualKey) => {
        calls.push(["head", actualKey]);
        return res({
          "content-length": String(objects.get(actualKey).length),
          etag: '"etag-one"',
          "last-modified": "Thu, 01 Oct 2026 00:00:00 GMT",
          "x-oss-server-side-encryption": "AES256"
        });
      },
      get: async (actualKey) => {
        calls.push(["get", actualKey]);
        const bytes = objects.get(actualKey);
        return {
          ...res(
            {
              "content-length": String(bytes.length),
              etag: '"etag-one"',
              "last-modified": "Thu, 01 Oct 2026 00:00:00 GMT",
              "x-oss-server-side-encryption": "AES256"
            },
            state.corrupt ? Buffer.from("wrong") : Buffer.from(bytes)
          ),
          content: state.corrupt ? Buffer.from("wrong") : Buffer.from(bytes)
        };
      }
    };
  };
  return {
    state,
    calls,
    clients,
    objects,
    dependencies: {
      createOssClient,
      now: () => new Date(now),
      createStsClient: (options) => ({
        callApi: async () => ({
          statusCode: 200,
          body: {
            AccountId: owner,
            Arn: options.accessKeyId === "STS.writer" ? writerArn : readerArn,
            IdentityType: "AssumedRoleUser",
            RequestId: "identity-request"
          }
        })
      })
    }
  };
}

test("publisher uses only fixed slot, freezes bytes, and reader independently verifies actual bytes", async () => {
  const f = fixture();
  const publisher = await createSnapshotPublisherTransport(
    { ...identity, session: session(writerArn, "writer") },
    f.dependencies
  );
  assert.equal(f.clients.length, 1);
  assert.deepEqual(Object.keys(publisher), ["identityOriginal", "createOnly"]);
  assert.equal(publisher.identityOriginal.Arn, writerArn);
  const bytes = Buffer.from("PGDMP archive bytes");
  const expected = digest(bytes);
  const pending = publisher.createOnly({ key, bytes, contentDigest: expected });
  bytes.fill(0);
  const written = await pending;
  assert.equal(written.requestId, "put-request");
  assert.deepEqual(written.putObservation, {
    record: {
      recordVersion: "r3-snapshot-oss-response.v1",
      operation: "PutObject",
      bucket,
      objectKey: key,
      principal: writerArn,
      observedAt: now,
      requestHeaders: { "x-oss-forbid-overwrite": "true" },
      response: {
        status: 200,
        headers: {
          date: "Thu, 01 Oct 2026 00:00:00 GMT",
          "x-oss-request-id": "put-request",
          etag: '"etag-one"'
        },
        body: { digest: digest(Buffer.alloc(0)), bytes: 0 }
      }
    },
    bodyBase64: ""
  });
  assert.equal(digest(f.objects.get(key)), expected);
  const jsonKey = "snapshot-slots/v2/attempt-1/12345/data-result.json";
  const json = Buffer.from('{"status":"complete"}');
  await publisher.createOnly({ key: jsonKey, bytes: json, contentDigest: digest(json) });
  const metadata = Buffer.from(
    `{"ciphertextDigest":"sha256:${"a".repeat(10)}13800138000${"b".repeat(43)}"}`
  );
  await publisher.createOnly({ key: jsonKey, bytes: metadata, contentDigest: digest(metadata) });
  const phone = Buffer.from('{"phone":"13800138000"}');
  await assert.rejects(
    publisher.createOnly({ key: jsonKey, bytes: phone, contentDigest: digest(phone) }),
    { code: "SNAPSHOT_OSS_INPUT_INVALID" }
  );
  await assert.rejects(
    publisher.createOnly({
      key: jsonKey,
      bytes: Buffer.from('{ "status": "complete" }'),
      contentDigest: digest(Buffer.from('{ "status": "complete" }'))
    }),
    { code: "SNAPSHOT_OSS_INPUT_INVALID" }
  );
  await assert.rejects(
    publisher.createOnly({
      key: `${key}.other`,
      bytes: Buffer.from("x"),
      contentDigest: digest(Buffer.from("x"))
    }),
    { code: "SNAPSHOT_OSS_KEY_INVALID" }
  );
  const reader = await createSnapshotReaderTransport(
    { ...identity, session: session(readerArn, "reader"), writerArn },
    f.dependencies
  );
  assert.equal(f.clients.length, 2);
  assert.deepEqual(Object.keys(reader), [
    "identityOriginal",
    "readPublicJson",
    "readback",
    "readbackOriginals"
  ]);
  assert.equal(reader.identityOriginal.Arn, readerArn);
  const readback = await reader.readback({
    key,
    contentDigest: expected,
    sizeBytes: f.objects.get(key).length
  });
  assert.equal(readback.head.digest, expected);
  assert.equal(readback.get.digest, expected);
  assert.equal(readback.bucket.worm.state, "Locked");
  assert.equal(readback.bucket.versioning, "Disabled");
  assert.equal(readback.head.version, "null-version-disabled");
  const originalReadback = await reader.readbackOriginals({
    key,
    contentDigest: expected,
    sizeBytes: f.objects.get(key).length
  });
  assert.deepEqual(originalReadback.readerIdentityOriginal, reader.identityOriginal);
  assert.equal(originalReadback.expectedWriterArn, writerArn);
  assert.equal(originalReadback.evidence.records.get.principal, readerArn);
  assert.equal(originalReadback.evidence.originals.length, 11);
  await assert.rejects(
    reader.readbackOriginals({
      key: jsonKey,
      contentDigest: digest(metadata),
      sizeBytes: metadata.length
    }),
    { code: "SNAPSHOT_OSS_INPUT_INVALID" }
  );
  const document = await reader.readPublicJson({ key: jsonKey });
  assert.deepEqual(document.bytes, metadata);
  assert.equal(document.observation.get.digest, digest(metadata));
  await assert.rejects(reader.readPublicJson({ key }), { code: "SNAPSHOT_OSS_INPUT_INVALID" });
  f.state.corrupt = true;
  await assert.rejects(
    reader.readback({ key, contentDigest: expected, sizeBytes: f.objects.get(key).length }),
    { code: "SNAPSHOT_OSS_READBACK_INVALID" }
  );
});

test("conditional overwrite and unknown write outcome never retry or expose vendor errors", async () => {
  const f = fixture();
  const publisher = await createSnapshotPublisherTransport(
    { ...identity, session: session(writerArn, "writer") },
    f.dependencies
  );
  const bytes = Buffer.from("PGDMP archive bytes"),
    input = { key, bytes, contentDigest: digest(bytes) };
  f.state.conflict = true;
  await assert.rejects(publisher.createOnly(input), { code: "SNAPSHOT_OSS_OVERWRITE_REFUSED" });
  f.state.conflict = false;
  f.state.unknown = true;
  await assert.rejects(publisher.createOnly(input), (error) => {
    assert.equal(error.code, "SNAPSHOT_OSS_WRITE_OUTCOME_UNKNOWN");
    assert.equal(error.message, error.code);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(f.calls.filter(([operation]) => operation === "put").length, 2);
  f.state.unknown = false;
  f.state.missingBody = true;
  await assert.rejects(publisher.createOnly(input), { code: "SNAPSHOT_OSS_WRITE_OUTCOME_UNKNOWN" });
  assert.equal(f.calls.filter(([operation]) => operation === "put").length, 3);
});

test("separate transports reject same identity and expired or overlong sessions", async () => {
  const f = fixture();
  await assert.rejects(
    createSnapshotReaderTransport(
      { ...identity, session: session(writerArn, "writer"), writerArn },
      f.dependencies
    ),
    { code: "SNAPSHOT_OSS_SESSION_INVALID" }
  );
  await assert.rejects(
    createSnapshotReaderTransport(
      {
        ...identity,
        session: session(
          `${writerArn.slice(0, writerArn.lastIndexOf("/"))}/different-session`,
          "reader"
        ),
        writerArn
      },
      f.dependencies
    ),
    { code: "SNAPSHOT_OSS_SESSION_INVALID" }
  );
  await assert.rejects(
    createSnapshotPublisherTransport(
      { ...identity, session: { ...session(writerArn, "writer"), expiresAt: now } },
      f.dependencies
    ),
    { code: "SNAPSHOT_OSS_SESSION_INVALID" }
  );
  await assert.rejects(
    createSnapshotPublisherTransport(
      {
        ...identity,
        session: { ...session(writerArn, "writer"), expiresAt: "2026-10-01T00:16:00.000Z" }
      },
      f.dependencies
    ),
    { code: "SNAPSHOT_OSS_SESSION_INVALID" }
  );
  assert.equal(f.clients.length, 0);
  const issuedArn = writerArn.replace(":assumed-role/", ":role/");
  await assert.rejects(
    createSnapshotReaderTransport(
      {
        ...identity,
        session: session(readerArn.replace("snapshot-reader", "snapshot-writer"), "reader"),
        writerArn: issuedArn
      },
      f.dependencies
    ),
    { code: "SNAPSHOT_OSS_SESSION_INVALID" }
  );
  await createSnapshotPublisherTransport(
    { ...identity, session: session(issuedArn, "writer") },
    f.dependencies
  );
});

test("reader freezes expected content and writer identity before asynchronous readback", async () => {
  const f = fixture();
  const bytes = Buffer.from("encrypted payload");
  f.objects.set(key, bytes);
  const input = { ...identity, session: session(readerArn, "reader"), writerArn };
  const reader = await createSnapshotReaderTransport(input, f.dependencies);
  const request = { key, contentDigest: digest(bytes), sizeBytes: bytes.length };
  const pending = reader.readback(request);
  input.writerArn = "unverified-writer";
  request.contentDigest = digest(Buffer.from("different"));
  request.sizeBytes = 1;
  const readback = await pending;
  assert.equal(readback.expectedWriterArn, writerArn);
  assert.equal(readback.get.digest, digest(bytes));
  assert.equal(readback.get.sizeBytes, bytes.length);
});
