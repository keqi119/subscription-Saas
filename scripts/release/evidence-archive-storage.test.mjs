import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  createEvidenceArchiveReaderTransport,
  createEvidenceArchiveWriterTransport
} from "./evidence-archive-storage.mjs";

const account = "1457643390906675";
const bucket = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const writerRole = `acs:ram::${account}:role/subscription-saas-stage1-archive-writer`;
const readerRole = `acs:ram::${account}:role/subscription-saas-stage1-archive-reader`;
const bytes = Buffer.from('{"schemaVersion":"approval-record.v1","decision":"approve"}');
const parsed = JSON.parse(bytes.toString());
const object = {
  proofType: parsed.schemaVersion,
  canonicalDigest: sha256Canonical(parsed),
  exactKey: `control-evidence/v1/${parsed.schemaVersion}/${sha256Canonical(parsed)}`,
  contentDigest: sha256Bytes(bytes),
  contentSizeBytes: bytes.length
};
const d = (x) => `sha256:${x.repeat(64)}`;
const date = "Thu, 01 Oct 2026 00:00:00 GMT";
const acl = `<AccessControlPolicy><Owner><ID>${account}</ID><DisplayName>owner</DisplayName></Owner><AccessControlList><Grant>private</Grant></AccessControlList></AccessControlPolicy>`;
const worm =
  "<WormConfiguration><WormId>worm-1</WormId><State>Locked</State><RetentionPeriodInDays>210</RetentionPeriodInDays><CreationDate>2026-09-01T00:00:00Z</CreationDate></WormConfiguration>";
const versioning =
  '<VersioningConfiguration xmlns="http://doc.oss-cn-hangzhou.aliyuncs.com"></VersioningConfiguration>';

function authorization(profile) {
  const writer = profile === "archive-create-only-writer";
  return {
    schemaVersion: "evidence-archive-authorization.v1",
    authorizationId: `auth-${profile}`,
    operationId: "op-1",
    profile,
    executor: {
      sourceDigest: d("1"),
      runtimeDigest: d("2"),
      principal: writer ? writerRole : readerRole,
      publicKeyDigest: d("3")
    },
    resource: {
      region: "oss-cn-shanghai",
      bucket,
      bucketFingerprint: d("4"),
      policyDigest: d("5")
    },
    objects: [{ ...object }],
    permissions: {
      actions: writer
        ? ["oss:PutObject"]
        : [
            "oss:HeadObject",
            "oss:GetObject",
            "oss:GetObjectAcl",
            "oss:GetBucketAcl",
            "oss:GetBucketWorm",
            "oss:GetBucketVersioning"
          ],
      conditionalCreate: writer,
      exactKeysOnly: true
    },
    chain: {
      changePlanDigest: d("6"),
      externalChangeApprovalDigest: d("7"),
      applyProofDigest: d("8"),
      resourceReadbackDigest: d("9"),
      predecessorTerminalReceiptDigest: writer ? null : d("a")
    },
    identities: { management: "management-principal", writer: writerRole, reader: readerRole },
    issuer: { id: "archive-control", keyId: "key-1" },
    issuedAt: "2026-10-01T00:00:00.000Z",
    notAfter: "2026-10-01T00:15:00.000Z",
    revocationPolicyDigest: d("b"),
    custodyPolicyDigest: d("c")
  };
}

function session(role) {
  return {
    arn: role.replace(":role/", ":assumed-role/") + "/session-1",
    accessKeyId: "STS.public-id",
    accessKeySecret: "never-export-this-secret",
    stsToken: "never-export-this-token",
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:10:00.000Z"
  };
}

function harness(role) {
  const calls = [],
    state = {
      clock: "2026-10-01T00:00:01.000Z",
      afterIdentity: null,
      afterRequest: null,
      afterPut: null,
      putError: null,
      encryption: "AES256",
      acl,
      versioning,
      content: bytes
    };
  const response = (body, headers = {}) => ({
    status: 200,
    content: Buffer.from(body),
    res: {
      status: 200,
      data: Buffer.from(body),
      headers: {
        date,
        "x-oss-request-id": `request-${calls.length}`,
        ...headers,
        authorization: "do-not-copy"
      }
    }
  });
  const objectHeaders = () => ({
    "content-length": String(state.content.length),
    etag: '"etag-one"',
    "last-modified": date,
    "x-oss-server-side-encryption": state.encryption
  });
  const client = {
    async put(key, body, options) {
      calls.push(["put", key, Buffer.from(body), options]);
      state.afterPut?.();
      if (state.putError) throw state.putError;
      return response(Buffer.alloc(0), { etag: '"etag-one"', "content-length": "0" });
    },
    async request(input) {
      calls.push(["request", input]);
      state.afterRequest?.();
      return response(
        input.subres === "acl" ? state.acl : input.subres === "worm" ? worm : state.versioning
      );
    },
    async head(key) {
      calls.push(["head", key]);
      return response(Buffer.alloc(0), objectHeaders());
    },
    async get(key) {
      calls.push(["get", key]);
      return response(state.content, objectHeaders());
    }
  };
  const deps = {
    now: () => new Date(state.clock),
    createOssClient(config) {
      calls.push(["client", config]);
      return client;
    },
    createStsClient() {
      return {
        async callApi() {
          calls.push(["identity"]);
          state.afterIdentity?.();
          return {
            statusCode: 200,
            body: {
              AccountId: account,
              Arn: session(role).arn,
              IdentityType: "AssumedRoleUser",
              RequestId: "sts-request-1"
            }
          };
        }
      };
    }
  };
  return { calls, state, deps };
}

test("rejects wrong archive scope before STS or OSS access", async () => {
  const f = harness(writerRole),
    auth = authorization("archive-create-only-writer");
  auth.resource.bucket = "other-bucket";
  await assert.rejects(
    createEvidenceArchiveWriterTransport(
      {
        authorization: auth,
        originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
        session: session(writerRole)
      },
      f.deps
    )
  );
  assert.deepEqual(f.calls, []);
});

test("writer verifies independent STS identity and conditionally creates only exact original bytes", async () => {
  const f = harness(writerRole);
  const transport = await createEvidenceArchiveWriterTransport(
    {
      authorization: authorization("archive-create-only-writer"),
      originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
      session: session(writerRole)
    },
    f.deps
  );
  const result = await transport.createOnly({ exactKey: object.exactKey, originalBytes: bytes });
  assert.equal(transport.identityOriginal.Arn, session(writerRole).arn);
  assert.deepEqual(
    f.calls.map((x) => x[0]),
    ["identity", "client", "put"]
  );
  assert.equal(f.calls[2][3].headers["x-oss-forbid-overwrite"], "true");
  assert.equal(f.calls[2][3].headers["x-oss-object-acl"], "private");
  assert.equal(f.calls[2][3].headers["x-oss-server-side-encryption"], "AES256");
  assert.equal(result.putObservation.record.response.headers["x-oss-request-id"], "request-3");
  assert.equal(JSON.stringify(result).includes("never-export"), false);
  assert.equal(JSON.stringify(result).includes("do-not-copy"), false);
  await assert.rejects(transport.createOnly({ exactKey: object.exactKey, originalBytes: bytes }));
  assert.equal(f.calls.filter((x) => x[0] === "put").length, 1);
});

test("writer refuses known overwrite and never retries an unknown PUT", async () => {
  const f = harness(writerRole);
  const transport = await createEvidenceArchiveWriterTransport(
    {
      authorization: authorization("archive-create-only-writer"),
      originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
      session: session(writerRole)
    },
    f.deps
  );
  f.state.putError = { status: 409, code: "FileAlreadyExists" };
  await assert.rejects(transport.createOnly({ exactKey: object.exactKey, originalBytes: bytes }), {
    code: "EVIDENCE_ARCHIVE_OVERWRITE_REFUSED"
  });
  assert.equal(f.calls.filter((x) => x[0] === "put").length, 1);
  const g = harness(writerRole);
  const another = await createEvidenceArchiveWriterTransport(
    {
      authorization: authorization("archive-create-only-writer"),
      originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
      session: session(writerRole)
    },
    g.deps
  );
  g.state.putError = new Error("network lost after send; secret never-export-this-secret");
  await assert.rejects(another.createOnly({ exactKey: object.exactKey, originalBytes: bytes }), {
    code: "EVIDENCE_ARCHIVE_WRITE_OUTCOME_UNKNOWN"
  });
  await assert.rejects(another.createOnly({ exactKey: object.exactKey, originalBytes: bytes }), {
    code: "EVIDENCE_ARCHIVE_PUT_ALREADY_ATTEMPTED"
  });
  assert.equal(g.calls.filter((x) => x[0] === "put").length, 1);
});

test("reader verifies independent STS identity and retains actual safe OSS originals", async () => {
  const f = harness(readerRole);
  const transport = await createEvidenceArchiveReaderTransport(
    { authorization: authorization("archive-readback-reader"), session: session(readerRole) },
    f.deps
  );
  const result = await transport.readback({ exactKey: object.exactKey });
  assert.equal(result.identityOriginal.Arn, session(readerRole).arn);
  assert.deepEqual(
    result.evidence.records.map((r) => r.operation),
    [
      "GetBucketAcl",
      "GetBucketWorm",
      "GetBucketVersioning",
      "HeadObject",
      "GetObjectAcl",
      "GetObject"
    ]
  );
  assert.equal(result.bucket.acl, "private");
  assert.equal(result.bucket.versioning, "Disabled");
  assert.equal(result.bucket.worm.retentionDays, 210);
  assert.equal(result.head.digest, object.contentDigest);
  assert.equal(result.get.digest, object.contentDigest);
  assert.equal(result.evidence.records[4].response.body.bytes > 0, true);
  assert.equal(JSON.stringify(result).includes("never-export"), false);
  assert.equal(JSON.stringify(result).includes("do-not-copy"), false);
});

test("reader refuses weak metadata without accepting bucket ACL as object ACL", async () => {
  for (const change of [
    (s) => {
      s.encryption = "";
    },
    (s) => {
      s.acl = acl.replace("private", "public-read");
    },
    (s) => {
      s.versioning = "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>";
    }
  ]) {
    const f = harness(readerRole);
    change(f.state);
    const transport = await createEvidenceArchiveReaderTransport(
      { authorization: authorization("archive-readback-reader"), session: session(readerRole) },
      f.deps
    );
    await assert.rejects(transport.readback({ exactKey: object.exactKey }), {
      code: "EVIDENCE_ARCHIVE_READBACK_INVALID"
    });
  }
});

test("accepts UTC STS seconds and rechecks authorization after identity readback", async () => {
  const f = harness(writerRole);
  const short = {
    ...session(writerRole),
    issuedAt: "2026-10-01T00:00:00Z",
    expiresAt: "2026-10-01T00:00:02Z"
  };
  const input = {
    authorization: authorization("archive-create-only-writer"),
    originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
    session: short
  };
  await createEvidenceArchiveWriterTransport(input, f.deps);

  const invalid = harness(writerRole);
  await assert.rejects(
    createEvidenceArchiveWriterTransport(
      { ...input, session: { ...short, expiresAt: "2026-10-32T00:00:02Z" } },
      invalid.deps
    ),
    { code: "EVIDENCE_ARCHIVE_SESSION_INVALID" }
  );
  assert.deepEqual(invalid.calls, []);

  const expired = harness(writerRole);
  const deadline = authorization("archive-create-only-writer");
  deadline.notAfter = "2026-10-01T00:00:02.000Z";
  expired.state.afterIdentity = () => {
    expired.state.clock = "2026-10-01T00:00:02.000Z";
  };
  await assert.rejects(
    createEvidenceArchiveWriterTransport(
      { ...input, authorization: deadline, session: session(writerRole) },
      expired.deps
    ),
    { code: "EVIDENCE_ARCHIVE_SESSION_INVALID" }
  );
  assert.deepEqual(
    expired.calls.map((entry) => entry[0]),
    ["identity"]
  );
});

test("reader stops before the next OSS call when authorization expires during metadata readback", async () => {
  const f = harness(readerRole);
  const auth = authorization("archive-readback-reader");
  auth.notAfter = "2026-10-01T00:00:02.000Z";
  const transport = await createEvidenceArchiveReaderTransport(
    { authorization: auth, session: session(readerRole) },
    f.deps
  );
  f.state.afterRequest = () => {
    f.state.clock = "2026-10-01T00:00:02.000Z";
  };
  await assert.rejects(transport.readback({ exactKey: object.exactKey }), {
    code: "EVIDENCE_ARCHIVE_READBACK_INVALID"
  });
  assert.equal(f.calls.filter((entry) => entry[0] === "request").length, 1);
});

test("writer treats an expired response as unknown and does not retry", async () => {
  const f = harness(writerRole);
  const auth = authorization("archive-create-only-writer");
  auth.notAfter = "2026-10-01T00:00:02.000Z";
  const transport = await createEvidenceArchiveWriterTransport(
    {
      authorization: auth,
      originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
      session: session(writerRole)
    },
    f.deps
  );
  f.state.afterPut = () => {
    f.state.clock = "2026-10-01T00:00:02.000Z";
  };
  await assert.rejects(transport.createOnly({ exactKey: object.exactKey, originalBytes: bytes }), {
    code: "EVIDENCE_ARCHIVE_WRITE_OUTCOME_UNKNOWN"
  });
  await assert.rejects(transport.createOnly({ exactKey: object.exactKey, originalBytes: bytes }), {
    code: "EVIDENCE_ARCHIVE_PUT_ALREADY_ATTEMPTED"
  });
  assert.equal(f.calls.filter((entry) => entry[0] === "put").length, 1);

  const g = harness(writerRole);
  const another = await createEvidenceArchiveWriterTransport(
    {
      authorization: auth,
      originals: [{ exactKey: object.exactKey, originalBytes: bytes }],
      session: session(writerRole)
    },
    g.deps
  );
  g.state.afterPut = () => {
    g.state.clock = "2026-10-01T00:00:02.000Z";
  };
  g.state.putError = { status: 409, code: "FileAlreadyExists" };
  await assert.rejects(another.createOnly({ exactKey: object.exactKey, originalBytes: bytes }), {
    code: "EVIDENCE_ARCHIVE_WRITE_OUTCOME_UNKNOWN"
  });
  assert.equal(g.calls.filter((entry) => entry[0] === "put").length, 1);
});
