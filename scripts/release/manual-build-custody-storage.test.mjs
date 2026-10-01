import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";
import test from "node:test";
import { URL, URLSearchParams } from "node:url";
import { custodyEvidence, sha256Bytes } from "../../packages/release-foundation/src/index.mjs";
import { createManualBuildCustodyStorage } from "./manual-build-custody-storage.mjs";

const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const requireOss = createRequire(requireApi.resolve("ali-oss"));
const vendorDebug = requireOss("debug");
const OSS = requireApi("ali-oss");

const bucket = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const owner = "1457643390906675";
const writerRole = `acs:ram::${owner}:role/subscription-saas-stage1-evidence-writer`;
const readerRole = `acs:ram::${owner}:role/subscription-saas-stage1-evidence-audit-reader`;
const now = new Date("2026-09-27T01:00:01.000Z");
const identity = {
  sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  repository: "keqi119/subscription-Saas", workflowPath: ".github/workflows/docker-images.yml",
  sourceRef: "refs/heads/main", runId: "123456789", runAttempt: 1,
  protectedEnvironment: "trusted-image-build"
};
const env = {
  GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_REPOSITORY: identity.repository, GITHUB_SHA: identity.sourceSha,
  GITHUB_REF: identity.sourceRef, GITHUB_RUN_ID: identity.runId, GITHUB_RUN_ATTEMPT: "1",
  GITHUB_WORKFLOW_REF: `${identity.repository}/${identity.workflowPath}@${identity.sourceRef}`,
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://vstoken.actions.githubusercontent.com/oidctoken?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-request-token"
};
test.before(() => { for (const [key, value] of Object.entries(env)) process.env[key] = value; });
const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
test.after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function fixture() {
  const objects = new Map(), calls = [], clients = [], http = [];
  const state = { bucketAcl: "private", days: "210", worm: "Locked", versionStatus: undefined,
    algorithm: "AES256", isPublic: "false", block: "true", objectAcl: "private",
    headHeaders: {}, getHeaders: {}, getStatus: 200, putError: undefined, stsChange: undefined, versionXml: undefined };
  const res = (headers = {}, status = 200) => ({ status, headers });
  const dependencies = {
    now: () => new Date(now),
    fetch: async (url, options) => {
      http.push({ url: String(url), options });
      assert.equal(options.redirect, "error");
      if (String(url).startsWith("https://vstoken.actions.githubusercontent.com/")) {
        assert.equal(new URL(url).searchParams.get("audience"), "sts.aliyuncs.com");
        assert.equal(options.headers.Authorization, "Bearer runtime-request-token");
        return { status: 200, json: async () => ({ value: "verified-oidc-token" }) };
      }
      assert.equal(String(url), "https://sts.aliyuncs.com/");
      assert.equal(options.method, "POST");
      const request = new URLSearchParams(options.body);
      assert.equal(request.get("Action"), "AssumeRoleWithOIDC");
      assert.equal(request.get("Version"), "2015-04-01");
      assert.equal(request.get("OIDCToken"), "verified-oidc-token");
      assert.equal(request.get("OIDCProviderArn"), `acs:ram::${owner}:oidc-provider/github-actions-stage1`);
      assert.equal(request.get("DurationSeconds"), "900");
      const role = request.get("RoleArn"), session = request.get("RoleSessionName");
      assert.ok([writerRole, readerRole].includes(role));
      const tag = role === writerRole ? "writer" : "reader";
      assert.equal(session, `stage1-${tag}-123456789-attempt-1`);
      const response = {
        AssumedRoleUser: { Arn: `${role}/${session}`, AssumedRoleId: `role-id:${session}` },
        OIDCTokenInfo: { Issuer: "https://token.actions.githubusercontent.com",
          Subject: "repo:keqi119/subscription-Saas:environment:trusted-image-build",
          ClientIds: "sts.aliyuncs.com", VerificationInfo: "Success",
          IssuanceTime: "2026-09-27T01:00:00Z", ExpirationTime: "2026-09-27T01:05:00Z" },
        Credentials: { AccessKeyId: `STS.${tag}`, AccessKeySecret: `${tag}-secret`,
          SecurityToken: `${tag}-temporary-token`, Expiration: "2026-09-27T01:15:00Z" }
      };
      state.stsChange?.(response, tag);
      return { status: 200, json: async () => response };
    },
    createOssClient: (options) => {
      clients.push(options);
      assert.equal(options.bucket, bucket);
      assert.equal(options.endpoint, "https://oss-cn-shanghai.aliyuncs.com");
      assert.equal(options.region, "oss-cn-shanghai");
      assert.equal(options.secure, true); assert.equal(options.authorizationV4, true);
      assert.equal(options.retryMax, 0);
      if (options.accessKeyId === "STS.writer") return {
        put: async (key, bytes, options) => {
          calls.push(["put", key]);
          assert.deepEqual(options.headers, { "x-oss-forbid-overwrite": "true",
            "x-oss-object-acl": "private", "x-oss-server-side-encryption": "AES256" });
          assert.equal(options.mime, "application/json");
          if (objects.has(key)) throw Object.assign(new Error("vendor secret"), { status: 409, code: "FileAlreadyExists" });
          objects.set(key, Buffer.from(bytes));
          if (state.putError) throw state.putError;
          return { res: res() };
        }
      };
      assert.equal(options.accessKeyId, "STS.reader");
      const acl = () => ({ acl: state.objectAcl, owner: { id: owner }, res: res() });
      return {
        getBucketACL: async (name) => {
          assert.equal(name, bucket); calls.push(["bucket"]);
          return { acl: state.bucketAcl, owner: { id: owner }, res: res() };
        },
        getBucketWorm: async () => ({ state: state.worm, days: state.days, wormId: "locked-id",
          creationDate: "2026-09-01T00:00:00Z", res: res(), status: 200 }),
        getBucketVersioning: async () => {
          const parsed = state.versionXml === undefined ? undefined : await OSS.prototype.parseXML(Buffer.from(state.versionXml));
          return { versionStatus: parsed === undefined ? state.versionStatus : parsed.Status, res: res(), status: 200 };
        },
        getBucketEncryption: async () => ({ encryption: { SSEAlgorithm: state.algorithm }, res: res(), status: 200 }),
        request: async (request) => {
          if (request.subres === "versioning") {
            assert.deepEqual(request, { method: "GET", bucket, subres: "versioning",
              successStatuses: [200], xmlResponse: false });
            const xml = state.versionXml ?? `<VersioningConfiguration xmlns="http://doc.oss-cn-hangzhou.aliyuncs.com">${state.versionStatus === undefined ? "" : `<Status>${state.versionStatus}</Status>`}</VersioningConfiguration>`;
            return { data: Buffer.from(xml), res: res(), status: 200 };
          }
          assert.deepEqual(request, { method: "GET", bucket, subres: request.subres,
            successStatuses: [200], xmlResponse: true });
          assert.ok(["policyStatus", "publicAccessBlock"].includes(request.subres));
          return { data: request.subres === "policyStatus" ? { IsPublic: state.isPublic } : { BlockPublicAccess: state.block }, res: res(), status: 200 };
        },
        head: async (key) => {
          calls.push(["head", key]);
          return { res: res({ "content-length": String(objects.get(key).length),
            "last-modified": "Sun, 27 Sep 2026 01:00:00 GMT", "x-oss-server-side-encryption": "AES256",
            ...state.headHeaders }), status: 200 };
        },
        getACL: async (key) => { calls.push(["acl", key]); return acl(); },
        get: async (key) => { calls.push(["get", key]); return { content: objects.get(key),
          res: res({ "content-length": String(objects.get(key).length), ...state.getHeaders }, state.getStatus) }; }
      };
    }
  };
  return { state, dependencies, calls, clients, http, objects,
    open: () => createManualBuildCustodyStorage({ buildIdentity: { ...identity } }, dependencies) };
}
function upload(bytes = Buffer.from('{ "raw": true }\n')) {
  const contentDigest = sha256Bytes(bytes);
  return { key: `evidence/${contentDigest.slice(7)}.json`, bytes, contentDigest,
    requestedAt: now.toISOString(), retainUntil: "2026-12-26T01:00:01.000Z" };
}
const rejected = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code); assert.equal(error.message, code); assert.equal(error.cause, undefined);
  return true;
});

test("creates once through writer and independently reads exact physical run namespace and metadata", async () => {
  const f = fixture(), storage = await f.open(), input = upload();
  assert.equal(f.clients.length, 2);
  assert.equal(storage.writerIdentity, `${writerRole}/stage1-writer-123456789-attempt-1`);
  assert.deepEqual(Object.keys(storage).sort(), ["auditReaderIdentity", "createOnly", "read", "readMetadata", "readWithEvidence", "trustPolicy", "writerIdentity"]);
  const pending = storage.createOnly(input); input.bytes.fill(0);
  const created = await pending;
  const physical = input.key.replace("evidence/", "evidence/github-123456789-attempt-1/");
  assert.deepEqual(created, { created: true, storeRef: `oss://${bucket}/${physical}`,
    contentSizeBytes: 16, storedAt: "2026-09-27T01:00:00.000Z", retainUntil: "2027-04-25T01:00:00.000Z" });
  const metadata = await storage.readMetadata({ key: input.key, identity: "audit-reader" });
  assert.deepEqual(metadata, Object.fromEntries(Object.entries(created).filter(([key]) => key !== "created")));
  const raw = await storage.read({ key: input.key, identity: "audit-reader" });
  assert.equal(raw.toString(), '{ "raw": true }\n'); raw.fill(0);
  assert.equal(f.objects.get(physical).toString(), '{ "raw": true }\n');
  assert.ok(f.calls.filter(([op]) => ["put", "head", "acl", "get"].includes(op)).every(([, key]) => key === physical));
});

test("existing foundation issues a retention90 receipt using the same independent service facts", async () => {
  const f = fixture(), storage = await f.open();
  const receipt = await custodyEvidence({ value: { fixture: true },
    policy: { owner: "release-engineering", readers: ["release", "qa", "security", "audit"], retentionDays: 90, expiryDisposition: "review" },
    storage, now: () => new Date(now), createReceiptId: () => "550e8400-e29b-41d4-a716-446655440000",
    attestationRef: `sha256:${"a".repeat(64)}`, receiptContract: "custody-receipt.retention90.v1" });
  assert.equal(receipt.retainUntil, "2027-04-25T01:00:00.000Z");
  assert.equal(f.calls.filter(([op]) => op === "put").length, 2);
  assert.ok(f.objects.has("receipts/github-123456789-attempt-1/550e8400-e29b-41d4-a716-446655440000.json"));
});

test("identity and actual protected runtime drift fail before requesting any token", async () => {
  const f = fixture();
  await rejected(createManualBuildCustodyStorage({ buildIdentity: { ...identity, sourceSha: "b".repeat(40) } }, f.dependencies), "MANUAL_BUILD_STORAGE_IDENTITY_INVALID");
  process.env.GITHUB_RUN_ATTEMPT = "2";
  try { await rejected(f.open(), "MANUAL_BUILD_STORAGE_IDENTITY_INVALID"); }
  finally { process.env.GITHUB_RUN_ATTEMPT = "1"; }
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://attacker.example/token";
  try { await rejected(f.open(), "MANUAL_BUILD_STORAGE_OIDC_INVALID"); }
  finally { process.env.ACTIONS_ID_TOKEN_REQUEST_URL = env.ACTIONS_ID_TOKEN_REQUEST_URL; }
  assert.equal(f.http.length, 0); assert.equal(f.calls.length, 0);
});

test("STS verified issuer, audience, subject and role are required before constructing clients", async () => {
  for (const mutate of [
    (r) => { r.AssumedRoleUser.Arn = `${readerRole}/wrong-session`; },
    (r) => { r.OIDCTokenInfo.Issuer = "https://attacker.example"; },
    (r) => { r.OIDCTokenInfo.ClientIds = "wrong-audience"; },
    (r) => { r.OIDCTokenInfo.Subject = "repo:keqi119/subscription-Saas:ref:refs/heads/main"; },
    (r) => { r.Credentials.Expiration = "2026-09-27T01:00:00Z"; },
    (r) => { r.OIDCTokenInfo.VerificationInfo = "Failed"; }
  ]) {
    const f = fixture(); f.state.stsChange = mutate;
    await rejected(f.open(), "MANUAL_BUILD_STORAGE_STS_INVALID");
    assert.equal(f.clients.length, 0); assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.state.stsChange = (response, tag) => {
    if (tag === "reader") response.Credentials.AccessKeyId = "STS.writer";
  };
  await rejected(f.open(), "MANUAL_BUILD_STORAGE_STS_INVALID");
  assert.equal(f.clients.length, 0);
});

test("public access, short or unlocked WORM, versioning, encryption and missing BPA refuse PUT", async () => {
  for (const change of [{ bucketAcl: "public-read" }, { days: "90" }, { worm: "InProgress" },
    { versionStatus: "Enabled" }, { algorithm: "KMS" }, { isPublic: "true" }, { block: undefined }]) {
    const f = fixture(); Object.assign(f.state, change);
    const storage = await f.open();
    await rejected(storage.createOnly(upload()), "MANUAL_BUILD_STORAGE_BUCKET_INVALID");
    assert.equal(f.calls.filter(([op]) => op === "put").length, 0);
  }
});

test("collision and ambiguous PUT timeout never retry or use later reads as success", async () => {
  const f = fixture(), storage = await f.open(), input = upload();
  await storage.createOnly(input);
  await rejected(storage.createOnly(input), "EVIDENCE_OVERWRITE_REFUSED");
  const g = fixture(); g.state.putError = Object.assign(new Error("secret=vendor-credential"), { code: "ConnectionTimeoutError" });
  const other = await g.open();
  await rejected(other.createOnly(upload()), "MANUAL_BUILD_STORAGE_WRITE_FAILED");
  assert.equal(g.objects.size, 1); assert.equal(g.calls.filter(([op]) => op === "put").length, 1);
  assert.equal(g.calls.filter(([op]) => ["get", "head", "acl"].includes(op)).length, 0);
});

test("wrong caller role, digest and physical prefix refuse IO", async () => {
  const f = fixture(), storage = await f.open(), input = upload();
  await rejected(storage.read({ key: input.key, identity: storage.writerIdentity }), "MANUAL_BUILD_STORAGE_READER_INVALID");
  await rejected(storage.readMetadata({ key: input.key, identity: "writer" }), "MANUAL_BUILD_STORAGE_READER_INVALID");
  await rejected(storage.createOnly({ ...input, contentDigest: `sha256:${"a".repeat(64)}` }), "MANUAL_BUILD_STORAGE_INPUT_INVALID");
  await rejected(storage.createOnly({ ...input, key: `evidence/github-123456789-attempt-1/${input.key.slice(9)}` }), "MANUAL_BUILD_STORAGE_KEY_INVALID");
  assert.equal(f.calls.length, 0);
});

test("Head metadata, object privacy and requested retention must be actual service facts", async () => {
  for (const change of [{ headHeaders: { "content-length": "-1" } },
    { headHeaders: { "last-modified": undefined } }, { headHeaders: { "x-oss-server-side-encryption": "KMS" } },
    { objectAcl: "default" }]) {
    const f = fixture(); Object.assign(f.state, change); const storage = await f.open();
    await rejected(storage.createOnly(upload()), "MANUAL_BUILD_STORAGE_METADATA_INVALID");
  }
  const f = fixture(), storage = await f.open();
  await rejected(storage.createOnly({ ...upload(), retainUntil: "2027-05-01T00:00:00.000Z" }), "MANUAL_BUILD_STORAGE_METADATA_INVALID");
});

test("audit-reader Get rejects partial, compressed and versioned bodies", async () => {
  const f = fixture(), storage = await f.open(), input = upload(); await storage.createOnly(input);
  for (const [status, headers] of [[206, {}], [200, { "content-encoding": "gzip" }],
    [200, { "x-oss-version-id": "v1" }], [200, { "content-range": "bytes 0-5/16" }]]) {
    f.state.getStatus = status; f.state.getHeaders = headers;
    await rejected(storage.read({ key: input.key, identity: "audit-reader" }), "MANUAL_BUILD_STORAGE_READ_INVALID");
  }
});

test("actual vendor debug enablement refuses credentials before HTTP and emits no secret logs", async () => {
  const previousNamespaces = vendorDebug.disable(), previousLog = vendorDebug.log, logs = [];
  vendorDebug.log = (...args) => logs.push(args);
  try {
    for (const namespaces of ["ali-oss", "*"]) {
      vendorDebug.enable(namespaces);
      assert.equal(vendorDebug.enabled("ali-oss"), true);
      const f = fixture();
      await rejected(f.open(), "MANUAL_BUILD_STORAGE_DEBUG_UNSAFE");
      assert.equal(f.http.length, 0); assert.equal(f.clients.length, 0);
      assert.deepEqual(logs, []);
    }
  } finally {
    vendorDebug.log = previousLog; vendorDebug.enable(previousNamespaces);
  }
});

test("versioning requires the actual XML root before accepting absent or empty Status", async () => {
  const f = fixture();
  f.state.versionXml = "<VersioningConfiguration><Status/></VersioningConfiguration>";
  const storage = await f.open(), input = upload(); await storage.createOnly(input);
  const puts = f.calls.filter(([op]) => op === "put").length;
  // The real SDK drops this wrong root and synthesizes versionStatus: undefined.
  f.state.versionXml = "<Error><Code>AccessDenied</Code></Error>";
  await rejected(storage.createOnly(upload(Buffer.from('{ "different": true }\n'))), "MANUAL_BUILD_STORAGE_BUCKET_INVALID");
  await rejected(storage.readMetadata({ key: input.key, identity: "audit-reader" }), "MANUAL_BUILD_STORAGE_BUCKET_INVALID");
  assert.equal(f.calls.filter(([op]) => op === "put").length, puts);
});

function nativeFixture() {
  const f = fixture(), input = upload(), requests = [], responses = new Map();
  const physical = input.key.replace("evidence/", "evidence/github-123456789-attempt-1/");
  const aclXml = `<?xml version="1.0" encoding="UTF-8"?>\n<AccessControlPolicy>\n <Owner><ID>${owner}</ID><DisplayName>owner-name</DisplayName></Owner>\n <AccessControlList><Grant>private</Grant></AccessControlList>\n</AccessControlPolicy>\n`;
  const bodies = {
    GetObject: input.bytes, HeadObject: Buffer.alloc(0), GetObjectAcl: Buffer.from(aclXml),
    GetBucketAcl: Buffer.from(aclXml),
    GetBucketWorm: Buffer.from('<WormConfiguration>\n<WormId>locked-id</WormId><State>Locked</State><RetentionPeriodInDays>210</RetentionPeriodInDays><CreationDate>2026-09-01T00:00:00Z</CreationDate>\n</WormConfiguration>'),
    GetBucketVersioning: Buffer.from('<VersioningConfiguration>\n  \n</VersioningConfiguration>'),
    GetBucketEncryption: Buffer.from('<ServerSideEncryptionRule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></ServerSideEncryptionRule>'),
    GetBucketPolicyStatus: Buffer.from('<PolicyStatus><IsPublic>false</IsPublic></PolicyStatus>'),
    GetBucketPublicAccessBlock: Buffer.from('<PublicAccessBlockConfiguration><BlockPublicAccess>true</BlockPublicAccess></PublicAccessBlockConfiguration>')
  };
  for (const [operation, body] of Object.entries(bodies)) responses.set(operation, {
    status: 200, data: Buffer.from(body), headers: {
      date: "Sun, 27 Sep 2026 01:00:01 GMT", "x-oss-request-id": `request-${operation}`,
      "content-length": String(operation === "HeadObject" ? input.bytes.length : body.length),
      "content-type": operation === "GetObject" || operation === "HeadObject" ? "application/json" : "application/xml",
      ...(["GetObject", "HeadObject"].includes(operation) ? {
        "last-modified": "Sun, 27 Sep 2026 01:00:00 GMT", etag: '"service-etag"', "x-oss-server-side-encryption": "AES256"
      } : {}), "x-oss-meta-secret": "not-collected", authorization: "not-collected"
    }
  });
  const original = f.dependencies.createOssClient;
  f.dependencies.createOssClient = (options) => {
    const client = original(options);
    if (options.accessKeyId === "STS.writer") return client;
    // Preserve the actual SDK methods and parser, replacing only its network
    // request boundary; no credential refresh timer or constructor is needed.
    const reader = Object.create(OSS.prototype);
    reader.options = options;
    reader.request = async (params) => {
      const subres = typeof params.subres === "object" ? Object.keys(params.subres)[0] : params.subres;
      const operation = params.object ? (subres === "acl" ? "GetObjectAcl" : params.method === "HEAD" ? "HeadObject" : "GetObject") : {
        acl: "GetBucketAcl", worm: "GetBucketWorm", versioning: "GetBucketVersioning", encryption: "GetBucketEncryption",
        policyStatus: "GetBucketPolicyStatus", publicAccessBlock: "GetBucketPublicAccessBlock"
      }[subres];
      assert.ok(operation); assert.equal(params.bucket, bucket);
      if (params.object) assert.equal(params.object, physical);
      requests.push(operation);
      const response = responses.get(operation);
      const data = params.xmlResponse ? await reader.parseXML(response.data) : response.data;
      f.state.afterParsed?.(operation, response);
      return { status: response.status, headers: response.headers, res: response, data };
    };
    return reader;
  };
  return { ...f, input, physical, requests, responses, bodies };
}

test("native readback retains exact source closure through actual SDK parsing without PUT or repeated reads", async () => {
  const f = nativeFixture(), storage = await f.open();
  const result = await storage.readWithEvidence({ key: f.input.key, identity: "audit-reader" });
  assert.deepEqual(Object.keys(result).sort(), ["aclEvidenceBytes", "bytes", "getEvidenceBytes", "headEvidenceBytes", "metadata", "rawBlobs", "readbackAt"]);
  assert.deepEqual(result.metadata, { storeRef: `oss://${bucket}/${f.physical}`, contentSizeBytes: 16,
    storedAt: "2026-09-27T01:00:00.000Z", retainUntil: "2027-04-25T01:00:00.000Z" });
  assert.equal(result.readbackAt, now.toISOString()); assert.deepEqual(result.bytes, f.input.bytes);
  const records = [result.getEvidenceBytes, result.headEvidenceBytes, result.aclEvidenceBytes].map((raw) => JSON.parse(raw));
  assert.deepEqual(records.map((r) => r.operation), ["GetObject", "HeadObject", "GetObjectAcl"]);
  const closure = new Set();
  function visit(raw, bucketRecord = false) {
    closure.add(sha256Bytes(raw)); const record = JSON.parse(raw);
    assert.deepEqual(Object.keys(record).sort(), ["bucket", "bucketChecks", "objectKey", "observedAt", "operation", "readerPrincipal", "recordVersion", "response"]);
    assert.equal(record.recordVersion, "manual-expected-oss-readback.v1"); assert.equal(record.bucket, bucket);
    assert.equal(record.objectKey, bucketRecord ? null : f.physical);
    assert.equal(record.readerPrincipal, `${readerRole}/stage1-reader-123456789-attempt-1`);
    assert.equal(record.observedAt, now.toISOString()); assert.equal(record.response.status, 200);
    assert.deepEqual(Object.keys(record.response.headers).sort(), ["content-length", "content-type", "date", "etag", "last-modified", "x-oss-request-id", "x-oss-server-side-encryption"]);
    const body = result.rawBlobs.get(record.response.body.digest); closure.add(record.response.body.digest);
    assert.equal(body.length, record.response.body.bytes); assert.deepEqual(body, f.bodies[record.operation]);
    assert.equal(record.response.headers["x-oss-request-id"], `request-${record.operation}`);
    for (const ref of record.bucketChecks) { const bytes = result.rawBlobs.get(ref.digest); assert.equal(bytes.length, ref.bytes); visit(bytes, true); }
  }
  for (const raw of [result.getEvidenceBytes, result.headEvidenceBytes, result.aclEvidenceBytes]) visit(raw);
  assert.deepEqual(records[1].bucketChecks.map((ref) => JSON.parse(result.rawBlobs.get(ref.digest)).operation), ["GetBucketAcl", "GetBucketWorm", "GetBucketVersioning", "GetBucketEncryption", "GetBucketPolicyStatus", "GetBucketPublicAccessBlock"]);
  assert.equal(records[0].bucketChecks.length, 0); assert.equal(records[2].bucketChecks.length, 0);
  assert.deepEqual([...result.rawBlobs.keys()].sort(), [...closure].sort());
  for (const [digest, bytes] of result.rawBlobs) { assert.equal(digest, sha256Bytes(bytes)); assert.ok(bytes.length <= 1048576); }
  assert.equal(f.requests.length, 9); assert.equal(new Set(f.requests).size, 9); assert.equal(f.calls.length, 0);
  assert.ok(!Buffer.concat([...result.rawBlobs.values()]).includes(Buffer.from("not-collected")));
  for (const response of f.responses.values()) response.data.fill(0);
  assert.deepEqual(result.bytes, f.input.bytes);
  const getBody = result.rawBlobs.get(records[0].response.body.digest); result.bytes.fill(0);
  assert.deepEqual(getBody, f.input.bytes); result.getEvidenceBytes.fill(0);
  assert.equal(JSON.parse(result.rawBlobs.get([...closure][0])).operation, "GetObject");
});

test("native readback refuses missing divergent malformed encoded or inconsistent service evidence", async () => {
  const cases = [
    ["missing ACL native body", (f) => { f.state.afterParsed = (op, res) => { if (op === "GetObjectAcl") delete res.data; }; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["divergent ACL root after SDK parsing", (f) => { f.state.afterParsed = (op, res) => { if (op === "GetObjectAcl") { res.data = Buffer.from('<Error><Code>AccessDenied</Code></Error>'); res.headers["content-length"] = String(res.data.length); } }; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["divergent private owner projection", (f) => { f.state.afterParsed = (op, res) => { if (op === "GetObjectAcl") res.data = Buffer.from(res.data.toString().replace(owner, "0000000000000000")); }; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["divergent WORM retention projection", (f) => { f.state.afterParsed = (op, res) => { if (op === "GetBucketWorm") res.data = Buffer.from(res.data.toString().replace('210', '090')); }; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["malformed XML", (f) => { f.responses.get("GetBucketAcl").data = Buffer.from('<AccessControlPolicy>'); }, "MANUAL_BUILD_STORAGE_BUCKET_INVALID"],
    ["encoded XML", (f) => { f.responses.get("GetBucketPolicyStatus").headers["content-encoding"] = "gzip"; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["missing actual HEAD buffer", (f) => { delete f.responses.get("HeadObject").data; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["nonempty HEAD buffer", (f) => { f.responses.get("HeadObject").data = Buffer.from('x'); }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["partial GET", (f) => { f.responses.get("GetObject").status = 206; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["versioned ACL", (f) => { f.responses.get("GetObjectAcl").headers["x-oss-version-id"] = "v1"; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["ranged WORM", (f) => { f.responses.get("GetBucketWorm").headers["content-range"] = "bytes 0-1/2"; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["over-limit native body", (f) => { f.responses.get("GetObject").data = Buffer.alloc(1048577); }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["wrong subject digest", (f) => { f.responses.get("GetObject").data = Buffer.from('{ "bad": true }\n '); }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["same length different ETag", (f) => { f.responses.get("GetObject").headers.etag = '"other-etag"'; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["missing request id", (f) => { delete f.responses.get("GetBucketPublicAccessBlock").headers["x-oss-request-id"]; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["nonstring bounded header", (f) => { f.responses.get("GetObject").headers.date = ["Sun, 27 Sep 2026 01:00:01 GMT"]; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["service storedAt after readback", (f) => { for (const op of ["GetObject", "HeadObject"]) f.responses.get(op).headers["last-modified"] = "Sun, 27 Sep 2026 01:00:02 GMT"; }, "MANUAL_BUILD_STORAGE_READBACK_INVALID"],
    ["clock goes backwards", (f) => { let count = 0; f.dependencies.now = () => new Date(count++ < 3 ? now : now.getTime() - 1); }, "MANUAL_BUILD_STORAGE_CLOCK_INVALID"]
  ];
  for (const [name, change, code] of cases) {
    const f = nativeFixture(); change(f); const storage = await f.open();
    await assert.rejects(storage.readWithEvidence({ key: f.input.key, identity: "audit-reader" }), (error) => {
      assert.equal(error.code, code, name); assert.equal(error.message, code, name); assert.equal(error.cause, undefined); return true;
    });
    assert.equal(f.calls.length, 0, name); assert.equal(new Set(f.requests).size, f.requests.length, name);
  }
});

test("native readback accepts only fixed evidence subjects and the audit reader before object IO", async () => {
  const f = nativeFixture(), storage = await f.open();
  for (const [input, code] of [
    [{ key: f.input.key, identity: "writer" }, "MANUAL_BUILD_STORAGE_READER_INVALID"],
    [{ key: f.input.key, identity: "audit-reader", bytes: f.input.bytes }, "MANUAL_BUILD_STORAGE_READER_INVALID"],
    [{ key: "receipts/550e8400-e29b-41d4-a716-446655440000.json", identity: "audit-reader" }, "MANUAL_BUILD_STORAGE_KEY_INVALID"],
    [{ key: f.physical, identity: "audit-reader" }, "MANUAL_BUILD_STORAGE_KEY_INVALID"]
  ]) await rejected(storage.readWithEvidence(input), code);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.calls, []);
});

test("native readback snapshots subject before caller key mutation across awaited responses", async () => {
  const outcomes = [], fixtures = [];
  for (const wrongBody of [true, false]) {
    const f = nativeFixture(), input = { key: f.input.key, identity: "audit-reader" };
    const changedBytes = Buffer.from('{ "raw": true } ');
    if (wrongBody) f.responses.get("GetObject").data = changedBytes;
    f.state.afterParsed = (operation) => {
      if (operation === "GetBucketAcl") input.key = wrongBody ? `evidence/${sha256Bytes(changedBytes).slice(7)}.json` : null;
    };
    const storage = await f.open();
    const [outcome] = await Promise.allSettled([storage.readWithEvidence(input)]);
    outcomes.push(outcome); fixtures.push(f);
  }
  assert.equal(outcomes[0].status, "rejected", "wrong body must be refused against the original subject digest");
  assert.equal(outcomes[0].reason.code, "MANUAL_BUILD_STORAGE_READBACK_INVALID");
  assert.equal(outcomes[0].reason.message, "MANUAL_BUILD_STORAGE_READBACK_INVALID");
  assert.equal(outcomes[1].status, "fulfilled", "normal subject must survive the caller replacing key with null");
  assert.deepEqual(outcomes[1].value.bytes, fixtures[1].input.bytes);
  assert.equal(outcomes[1].value.metadata.storeRef, `oss://${bucket}/${fixtures[1].physical}`);
  for (const name of ["getEvidenceBytes", "headEvidenceBytes", "aclEvidenceBytes"]) {
    assert.equal(JSON.parse(outcomes[1].value[name]).objectKey, fixtures[1].physical);
  }
});
