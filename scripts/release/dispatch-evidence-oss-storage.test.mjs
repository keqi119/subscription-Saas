import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import test from "node:test";
import { URL } from "node:url";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";

const moduleUrl = new URL("./dispatch-evidence-oss-storage.mjs", import.meta.url);
const account = "1457643390906675";
const bucket = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const now = "2026-10-06T00:00:00.000Z";
const d = `sha256:${"a".repeat(64)}`;
const encode = (value) => Buffer.from(canonicalJson(value));
function originals() {
  return [
    {
      originalBytes: encode({
        schemaVersion: "rc-dispatch-authorization.v1",
        authorizationId: "auth-1",
        executionPurpose: "release-candidate",
        releaseAttemptId: "attempt-1",
        sourceSha: "b".repeat(40),
        producerWorkflow: {
          path: ".github/workflows/sanitized-snapshot.yml",
          ref: "main",
          blobDigest: d
        },
        rcWorkflow: {
          path: ".github/workflows/release-candidate-gate.yml",
          ref: "main",
          blobDigest: d
        },
        buildProofDigest: d,
        buildBundleDigest: d,
        repositoryContractDigest: d,
        adapterDigest: d,
        issuer: "keqi119",
        issuedAt: now,
        notAfter: "2026-10-06T00:15:00.000Z",
        revocationPolicyDigest: d
      })
    },
    {
      originalBytes: encode({
        schemaVersion: "i0-revocation-state.v1",
        policyDigest: d,
        sequence: 0,
        revokedAuthorizationIds: [],
        revokedAuthorizationDigests: []
      })
    }
  ];
}
function fixture(profile = "reader") {
  const items = originals(),
    objects = new Map(
      items.map(({ originalBytes }) => [
        `control-evidence/v1/${JSON.parse(originalBytes).schemaVersion}/${sha256Bytes(originalBytes)}`,
        Buffer.from(originalBytes)
      ])
    );
  const calls = [],
    state = {
      clock: now,
      public: false,
      corrupt: false,
      overrun: false,
      unknown: false,
      conflict: false,
      versioned: false,
      expireDuringRead: false
    };
  const ok = (headers = {}) => ({
    res: { status: 200, headers: { "x-oss-request-id": "request-1", ...headers } }
  });
  const headers = (key) => ({
    "content-length": String(objects.get(key).length),
    etag: '"etag"',
    "last-modified": "Tue, 06 Oct 2026 00:00:00 GMT",
    "x-oss-server-side-encryption": "AES256"
  });
  const client = {
    async put(key, bytes, options) {
      calls.push(["put", key, options]);
      if (state.conflict)
        throw Object.assign(new Error("secret vendor response"), {
          status: 409,
          code: "FileAlreadyExists"
        });
      if (state.unknown) throw new Error("secret vendor response");
      assert.deepEqual(bytes, objects.get(key));
      return ok({ etag: '"etag"' });
    },
    async getBucketACL() {
      calls.push(["bucket-acl"]);
      return { ...ok(), acl: "private", owner: { id: account } };
    },
    async getBucketWorm() {
      return {
        ...ok(),
        state: "Locked",
        days: "210",
        wormId: "worm-1",
        creationDate: "2026-09-01T00:00:00.000Z"
      };
    },
    async getBucketEncryption() {
      return { ...ok(), encryption: { SSEAlgorithm: "AES256" } };
    },
    async request({ subres }) {
      if (subres === "versioning")
        return {
          ...ok(),
          data: Buffer.from(state.versioned ? "<WrongRoot/>" : "<VersioningConfiguration/>")
        };
      return {
        ...ok(),
        data:
          subres === "policyStatus"
            ? { IsPublic: state.public ? "true" : "false" }
            : { BlockPublicAccess: "true" }
      };
    },
    async getACL(key) {
      calls.push(["object-acl", key]);
      return { ...ok(), acl: "private" };
    },
    async head(key) {
      calls.push(["head", key]);
      return ok(headers(key));
    },
    async getStream(key) {
      calls.push(["get", key]);
      if (state.expireDuringRead) state.clock = "2026-10-06T00:16:00.000Z";
      let bytes = Buffer.from(objects.get(key));
      if (state.corrupt) bytes[0] ^= 1;
      if (state.overrun) bytes = Buffer.concat([bytes, Buffer.from("extra")]);
      return { ...ok(headers(key)), stream: Readable.from([bytes]) };
    }
  };
  return {
    items,
    objects,
    state,
    calls,
    input: {
      profile,
      originals: items,
      session: {
        arn: `acs:ram::${account}:assumed-role/subscription-saas-stage1-archive-${profile}/session-1`,
        accessKeyId: "STS.example",
        accessKeySecret: "test-only-secret",
        stsToken: "test-only-token",
        issuedAt: now,
        expiresAt: "2026-10-06T00:15:00.000Z"
      }
    },
    deps: {
      now: () => new Date(state.clock),
      createOssClient(options) {
        calls.push(["client"]);
        assert.equal(options.bucket, bucket);
        assert.equal(options.endpoint, "https://oss-cn-shanghai.aliyuncs.com");
        assert.equal(options.retryMax, 0);
        assert.equal(options.authorizationV4, true);
        assert.equal(options.secure, true);
        return client;
      }
    }
  };
}

test("dispatch archive exports the finite transport", async () => {
  let module;
  try {
    module = await import(moduleUrl);
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  assert.equal(typeof module?.createDispatchEvidenceStorage, "function");
});

test("writer freezes only the two originals and uses conditional private encrypted writes once", async () => {
  const { createDispatchEvidenceStorage } = await import(moduleUrl);
  const f = fixture("writer"),
    storage = await createDispatchEvidenceStorage(f.input, f.deps);
  const key = [...f.objects.keys()][0];
  f.items[0].originalBytes.fill(0);
  assert.deepEqual(Object.keys(storage), ["createOnly"]);
  const result = await storage.createOnly({ exactKey: key });
  assert.equal(result.contentDigest, sha256Bytes(f.objects.get(key)));
  assert.deepEqual(f.calls.find(([op]) => op === "put")[2].headers, {
    "x-oss-forbid-overwrite": "true",
    "x-oss-object-acl": "private",
    "x-oss-server-side-encryption": "AES256"
  });
  await assert.rejects(storage.createOnly({ exactKey: key }));
  await assert.rejects(storage.createOnly({ exactKey: key + "/extra" }));
  assert.equal(f.calls.filter(([op]) => op === "put").length, 1);
});

test("reader binds actual private bucket, object ACL, headers and bounded original bytes", async () => {
  const { createDispatchEvidenceStorage } = await import(moduleUrl);
  const f = fixture(),
    storage = await createDispatchEvidenceStorage(f.input, f.deps);
  const key = [...f.objects.keys()][0];
  assert.deepEqual(Object.keys(storage), ["readback"]);
  const result = await storage.readback({ exactKey: key });
  assert.deepEqual(result.originalBytes, f.objects.get(key));
  assert.equal(result.bucket.worm.retentionDays, 210);
  assert.equal(result.bucket.versioning, "Disabled");
  assert.equal(result.object.acl, "private");
  assert.equal(result.object.version, "null-version-disabled");
  assert.equal(result.object.contentDigest, sha256Bytes(f.objects.get(key)));
  assert.ok(f.calls.some(([op]) => op === "object-acl"));
  for (const flag of ["public", "versioned", "corrupt", "overrun", "expireDuringRead"]) {
    const bad = fixture();
    bad.state[flag] = true;
    const reader = await createDispatchEvidenceStorage(bad.input, bad.deps);
    await assert.rejects(reader.readback({ exactKey: key }), { code: /DISPATCH_ARCHIVE_/ });
  }
});

test("wrong role, expired sessions and caller-selected keys are rejected before network", async () => {
  const { createDispatchEvidenceStorage } = await import(moduleUrl);
  for (const badSession of ["role", "expiry"]) {
    const f = fixture();
    if (badSession === "role")
      f.input.session.arn = f.input.session.arn.replace("archive-reader", "archive-writer");
    else f.input.session.expiresAt = now;
    await assert.rejects(createDispatchEvidenceStorage(f.input, f.deps));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(),
    storage = await createDispatchEvidenceStorage(f.input, f.deps);
  await assert.rejects(storage.readback({ exactKey: "control-evidence/v1/*" }));
  assert.deepEqual(f.calls, [["client"]]);
});

test("unknown writes preserve outcome, suppress vendor secrets and cannot be retried", async () => {
  const { createDispatchEvidenceStorage } = await import(moduleUrl);
  for (const conflict of [false, true]) {
    const f = fixture("writer");
    f.state.unknown = !conflict;
    f.state.conflict = conflict;
    const storage = await createDispatchEvidenceStorage(f.input, f.deps),
      key = [...f.objects.keys()][0];
    await assert.rejects(storage.createOnly({ exactKey: key }), {
      code: conflict ? "DISPATCH_ARCHIVE_OVERWRITE_REFUSED" : "DISPATCH_ARCHIVE_WRITE_UNKNOWN",
      message: conflict ? "DISPATCH_ARCHIVE_OVERWRITE_REFUSED" : "DISPATCH_ARCHIVE_WRITE_UNKNOWN"
    });
    await assert.rejects(storage.createOnly({ exactKey: key }));
    assert.equal(f.calls.filter(([op]) => op === "put").length, 1);
  }
});
