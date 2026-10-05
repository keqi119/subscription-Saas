import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import { TextDecoder } from "node:util";
import { encodeManualJson, sha256Bytes } from "../../packages/release-foundation/src/index.mjs";

const BUCKET = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const OWNER = "1457643390906675";
const REPOSITORY = "keqi119/subscription-Saas";
const WORKFLOW = ".github/workflows/docker-images.yml";
const REF = "refs/heads/main";
const ENVIRONMENT = "trusted-image-build";
const AUDIENCE = "sts.aliyuncs.com";
const ISSUER = "https://token.actions.githubusercontent.com";
const PROVIDER = `acs:ram::${OWNER}:oidc-provider/github-actions-stage1`;
const WRITER_ROLE = `acs:ram::${OWNER}:role/subscription-saas-stage1-evidence-writer`;
const READER_ROLE = `acs:ram::${OWNER}:role/subscription-saas-stage1-evidence-audit-reader`;
const RETENTION_MS = 210 * 24 * 60 * 60 * 1000;
const IDENTITY_KEYS = ["sourceSha", "repository", "workflowPath", "sourceRef", "runId", "runAttempt", "protectedEnvironment"];
const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));

function requireOssDependency(name) {
  return createRequire(requireApi.resolve("ali-oss"))(name);
}

function assertVendorDebugDisabled() {
  // The installed SDK's createRequest logger prints authorization and STS headers.
  // Inspect its real debug instance's namespace rules before obtaining any tokens.
  if (requireOssDependency("debug").enabled("ali-oss")) fail("MANUAL_BUILD_STORAGE_DEBUG_UNSAFE");
}

function fail(code) {
  // Never attach vendor errors, response bodies, URLs or temporary credentials.
  throw Object.assign(new Error(code), { code });
}

function exactDataObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && "value" in descriptor;
    });
}

function assertIdentity(input) {
  const code = "MANUAL_BUILD_STORAGE_IDENTITY_INVALID";
  if (!exactDataObject(input, ["buildIdentity"]) || !exactDataObject(input.buildIdentity, IDENTITY_KEYS)) fail(code);
  const identity = { ...input.buildIdentity };
  if (typeof identity.sourceSha !== "string" || !/^[0-9a-f]{40}$/u.test(identity.sourceSha) ||
      identity.repository !== REPOSITORY || identity.workflowPath !== WORKFLOW || identity.sourceRef !== REF ||
      identity.runAttempt !== 1 || identity.protectedEnvironment !== ENVIRONMENT ||
      typeof identity.runId !== "string" || !/^[1-9][0-9]*$/u.test(identity.runId) ||
      !Number.isSafeInteger(Number(identity.runId))) fail(code);
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
      process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_SHA !== identity.sourceSha ||
      process.env.GITHUB_REF !== REF || process.env.GITHUB_RUN_ID !== identity.runId ||
      process.env.GITHUB_RUN_ATTEMPT !== "1" ||
      process.env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${WORKFLOW}@${REF}`) fail(code);
  let checkoutSha;
  try {
    checkoutSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch { fail(code); }
  if (checkoutSha !== identity.sourceSha) fail(code);
  return Object.freeze(identity);
}

function clock(now) {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail("MANUAL_BUILD_STORAGE_CLOCK_INVALID");
  return date.getTime();
}

async function sanitizedCall(callback, code) {
  try { return await callback(); } catch { fail(code); }
}

async function oidcToken(fetch) {
  const code = "MANUAL_BUILD_STORAGE_OIDC_INVALID";
  let url;
  try { url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL); } catch { fail(code); }
  // GitHub's protected runtime owns the endpoint and request bearer; neither is a caller option.
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !/^[a-z0-9-]+\.actions\.githubusercontent\.com$/u.test(url.hostname) ||
      typeof process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== "string" || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) fail(code);
  url.searchParams.set("audience", AUDIENCE);
  const response = await sanitizedCall(() => fetch(url, {
    method: "GET", redirect: "error", signal: globalThis.AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }
  }), "MANUAL_BUILD_STORAGE_OIDC_FAILED");
  if (response?.status !== 200) fail(code);
  const body = await sanitizedCall(() => response.json(), code);
  if (typeof body?.value !== "string" || body.value.length < 4 || body.value.length > 20000) fail(code);
  return body.value;
}

function validTime(value) {
  return typeof value === "string" && /Z$/u.test(value) && Number.isFinite(Date.parse(value));
}

async function assumeRole({ fetch, token, role, session, now }) {
  const code = "MANUAL_BUILD_STORAGE_STS_INVALID";
  const body = new URLSearchParams({ Action: "AssumeRoleWithOIDC", Version: "2015-04-01", Format: "JSON",
    Timestamp: new Date(clock(now)).toISOString().replace(/\.\d{3}Z$/u, "Z"), SignatureNonce: randomUUID(),
    OIDCProviderArn: PROVIDER, RoleArn: role, RoleSessionName: session, DurationSeconds: "900", OIDCToken: token });
  const response = await sanitizedCall(() => fetch("https://sts.aliyuncs.com/", {
    method: "POST", redirect: "error", signal: globalThis.AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString()
  }), "MANUAL_BUILD_STORAGE_STS_FAILED");
  if (response?.status !== 200) fail(code);
  const result = await sanitizedCall(() => response.json(), code);
  const info = result?.OIDCTokenInfo, credentials = result?.Credentials, current = clock(now);
  if (result?.AssumedRoleUser?.Arn !== `${role}/${session}` ||
      info?.Issuer !== ISSUER || info?.Subject !== `repo:${REPOSITORY}:environment:${ENVIRONMENT}` ||
      info?.ClientIds !== AUDIENCE || info?.VerificationInfo !== "Success" ||
      !validTime(info.IssuanceTime) || !validTime(info.ExpirationTime) ||
      Date.parse(info.IssuanceTime) > current || Date.parse(info.ExpirationTime) <= current ||
      Date.parse(info.IssuanceTime) >= Date.parse(info.ExpirationTime) ||
      !validTime(credentials?.Expiration) || Date.parse(credentials.Expiration) <= current ||
      typeof credentials.AccessKeyId !== "string" || !/^STS\..+/u.test(credentials.AccessKeyId) ||
      typeof credentials.AccessKeySecret !== "string" || !credentials.AccessKeySecret ||
      typeof credentials.SecurityToken !== "string" || !credentials.SecurityToken) fail(code);
  return { arn: result.AssumedRoleUser.Arn, accessKeyId: credentials.AccessKeyId,
    accessKeySecret: credentials.AccessKeySecret, stsToken: credentials.SecurityToken };
}

function successful(result) {
  return result?.res?.status === 200 && (result.status === undefined || result.status === 200);
}

async function assertVersioningDisabled(reader, capture) {
  const code = "MANUAL_BUILD_STORAGE_BUCKET_INVALID";
  // getBucketVersioning uses explicitRoot:false and always synthesizes Status.
  // A successful response with the wrong XML root must never mean Disabled.
  const raw = await sanitizedCall(() => reader.request({ method: "GET", bucket: BUCKET,
    subres: "versioning", successStatuses: [200], xmlResponse: false }), code);
  await capture?.("GetBucketVersioning", raw, raw?.data);
  if (!successful(raw) || !Buffer.isBuffer(raw.data)) fail(code);
  const parsed = await sanitizedCall(() => requireOssDependency("xml2js").parseStringPromise(
    new TextDecoder("utf-8", { fatal: true }).decode(raw.data),
    { explicitRoot: true, explicitArray: true, strict: true }
  ), code);
  if (!exactDataObject(parsed, ["VersioningConfiguration"])) fail(code);
  const configuration = parsed.VersioningConfiguration;
  if (typeof configuration === "string" && configuration.trim() === "") return;
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) ||
      Reflect.ownKeys(configuration).some((key) => !["$", "Status"].includes(key)) ||
      (configuration.$ !== undefined && (!exactDataObject(configuration.$, ["xmlns"]) ||
        configuration.$.xmlns !== "http://doc.oss-cn-hangzhou.aliyuncs.com")) ||
      (configuration.Status !== undefined && (!Array.isArray(configuration.Status) ||
        configuration.Status.length !== 1 || configuration.Status[0] !== ""))) fail(code);
}

async function assertBucket(reader, capture) {
  const code = "MANUAL_BUILD_STORAGE_BUCKET_INVALID";
  const acl = await sanitizedCall(() => reader.getBucketACL(BUCKET), code);
  await capture?.("GetBucketAcl", acl);
  const worm = await sanitizedCall(() => reader.getBucketWorm(BUCKET), code);
  await capture?.("GetBucketWorm", worm);
  await assertVersioningDisabled(reader, capture);
  const encryption = await sanitizedCall(() => reader.getBucketEncryption(BUCKET), code);
  await capture?.("GetBucketEncryption", encryption);
  const request = (subres) => reader.request({ method: "GET", bucket: BUCKET, subres,
    successStatuses: [200], xmlResponse: true });
  const policy = await sanitizedCall(() => request("policyStatus"), code);
  await capture?.("GetBucketPolicyStatus", policy);
  const publicAccess = await sanitizedCall(() => request("publicAccessBlock"), code);
  await capture?.("GetBucketPublicAccessBlock", publicAccess);
  if (![acl, worm, encryption, policy, publicAccess].every(successful) ||
      acl.acl !== "private" || acl.owner?.id !== OWNER || worm.state !== "Locked" || worm.days !== "210" ||
      typeof worm.wormId !== "string" || !worm.wormId || !validTime(worm.creationDate) ||
      encryption.encryption?.SSEAlgorithm !== "AES256" ||
      policy.data?.IsPublic !== "false" || publicAccess.data?.BlockPublicAccess !== "true") fail(code);
}

function physicalKey(key, runId) {
  if (typeof key !== "string" || !/^(?:evidence\/[0-9a-f]{64}|receipts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u.test(key)) {
    fail("MANUAL_BUILD_STORAGE_KEY_INVALID");
  }
  // Foundation keeps its logical keys; only verified protected-run identity selects this namespace.
  return key.replace("/", `/github-${runId}-attempt-1/`);
}

function assertReader(input) {
  if (!exactDataObject(input, ["key", "identity"]) || input.identity !== "audit-reader") fail("MANUAL_BUILD_STORAGE_READER_INVALID");
}

function fullResponse(result) {
  const headers = result?.res?.headers;
  return successful(result) && headers && typeof headers === "object" &&
    headers["content-range"] === undefined && headers["x-oss-version-id"] === undefined &&
    headers["content-encoding"] === undefined;
}

async function metadata(reader, key, capture) {
  const code = "MANUAL_BUILD_STORAGE_METADATA_INVALID";
  await assertBucket(reader, capture);
  const head = await sanitizedCall(() => reader.head(key), code);
  await capture?.("HeadObject", head);
  const acl = await sanitizedCall(() => reader.getACL(key), code);
  await capture?.("GetObjectAcl", acl);
  const headers = head?.res?.headers, modified = headers?.["last-modified"], length = headers?.["content-length"];
  if (!fullResponse(head) || !successful(acl) || acl.acl !== "private" || acl.owner?.id !== OWNER ||
      headers["x-oss-server-side-encryption"] !== "AES256" ||
      typeof length !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(length) || !Number.isSafeInteger(Number(length)) ||
      typeof modified !== "string" || !Number.isFinite(Date.parse(modified)) ||
      new Date(Date.parse(modified)).toUTCString() !== modified) fail(code);
  return Object.freeze({ storeRef: `oss://${BUCKET}/${key}`, contentSizeBytes: Number(length),
    storedAt: new Date(Date.parse(modified)).toISOString(), retainUntil: new Date(Date.parse(modified) + RETENTION_MS).toISOString() });
}

function canonicalTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

const READBACK_LIMIT = 1048576;
const READBACK_HEADERS = ["date", "x-oss-request-id", "content-length", "last-modified", "etag", "x-oss-server-side-encryption", "content-type"];
const READBACK_CODE = "MANUAL_BUILD_STORAGE_READBACK_INVALID";

function httpTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toUTCString() === value;
}

async function assertNativeProjection(operation, body, result) {
  if (["GetObject", "HeadObject"].includes(operation)) return;
  // Keep the native XML; explicitRoot prevents the SDK's root-dropping parser
  // from accepting an Error or unrelated service body as checked configuration.
  const parsed = await sanitizedCall(async () => {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (/<!DOCTYPE|<!ENTITY/iu.test(source)) fail(READBACK_CODE);
    return requireOssDependency("xml2js").parseStringPromise(source,
      { explicitRoot: true, explicitArray: false, strict: true });
  }, READBACK_CODE);
  const roots = { GetObjectAcl: "AccessControlPolicy", GetBucketAcl: "AccessControlPolicy",
    GetBucketWorm: "WormConfiguration", GetBucketVersioning: "VersioningConfiguration",
    GetBucketEncryption: "ServerSideEncryptionRule", GetBucketPolicyStatus: "PolicyStatus",
    GetBucketPublicAccessBlock: "PublicAccessBlockConfiguration" };
  const root = roots[operation];
  if (!root || !exactDataObject(parsed, [root])) fail(READBACK_CODE);
  let value = parsed[root];
  if (value && typeof value === "object" && value.$ !== undefined) {
    if (!exactDataObject(value.$, ["xmlns"]) || value.$.xmlns !== "http://doc.oss-cn-hangzhou.aliyuncs.com") fail(READBACK_CODE);
    value = { ...value }; delete value.$;
  }
  if (operation === "GetBucketVersioning") {
    if (typeof value === "string" && value.trim() === "") return;
    if ((!exactDataObject(value, []) && !exactDataObject(value, ["Status"])) || value.Status !== undefined && value.Status !== "") fail(READBACK_CODE);
    return;
  }
  let expected;
  if (["GetObjectAcl", "GetBucketAcl"].includes(operation)) {
    if (typeof result.owner?.displayName !== "string") fail(READBACK_CODE);
    expected = { Owner: { ID: result.owner?.id, DisplayName: result.owner.displayName }, AccessControlList: { Grant: result.acl } };
  } else if (operation === "GetBucketWorm") {
    expected = { WormId: result.wormId, State: result.state, RetentionPeriodInDays: result.days, CreationDate: result.creationDate };
  } else if (operation === "GetBucketEncryption") {
    const encryption = result.encryption;
    if (!encryption || typeof encryption !== "object" || Array.isArray(encryption) ||
        Object.keys(encryption).some((key) => !["SSEAlgorithm", "KMSMasterKeyID", "KMSDataEncryption"].includes(key)) ||
        Object.values(encryption).some((field) => typeof field !== "string")) fail(READBACK_CODE);
    expected = { ApplyServerSideEncryptionByDefault: { ...encryption } };
  } else if (operation === "GetBucketPolicyStatus") expected = { IsPublic: result.data?.IsPublic };
  else expected = { BlockPublicAccess: result.data?.BlockPublicAccess };
  const matches = await sanitizedCall(() => Buffer.from(encodeManualJson(value)).equals(Buffer.from(encodeManualJson(expected))), READBACK_CODE);
  if (!matches) fail(READBACK_CODE);
}

function readbackCollector({ now, key, readerPrincipal }) {
  const raws = new Map(), records = new Map(), bucketChecks = [];
  let previousTime = -Infinity;
  const time = () => {
    let current;
    try { current = clock(now); } catch { fail("MANUAL_BUILD_STORAGE_CLOCK_INVALID"); }
    if (current < previousTime) fail("MANUAL_BUILD_STORAGE_CLOCK_INVALID");
    previousTime = current;
    return new Date(current).toISOString();
  };
  const addRaw = (source) => {
    if (!Buffer.isBuffer(source) || source.length > READBACK_LIMIT) fail(READBACK_CODE);
    const raw = Buffer.from(source), ref = { digest: sha256Bytes(raw), bytes: raw.length };
    if (raws.has(ref.digest) && !raws.get(ref.digest).equals(raw)) fail(READBACK_CODE);
    raws.set(ref.digest, raw); return ref;
  };
  return { raws, records, time,
    async capture(operation, result, nativeBody = result?.res?.data) {
      const observedAt = time();
      if (!fullResponse(result) || !Buffer.isBuffer(nativeBody) || nativeBody.length > READBACK_LIMIT || records.has(operation)) fail(READBACK_CODE);
      const body = Buffer.from(nativeBody), headers = {};
      for (const name of READBACK_HEADERS) {
        const value = result.res.headers[name];
        if (value !== undefined && (typeof value !== "string" || value.length > 1024 ||
            [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) fail(READBACK_CODE);
        headers[name] = value ?? null;
      }
      if (!httpTime(headers.date) || !headers["x-oss-request-id"] || !/^[A-Za-z0-9-]+$/u.test(headers["x-oss-request-id"])) fail(READBACK_CODE);
      const length = headers["content-length"], object = ["GetObject", "HeadObject", "GetObjectAcl"].includes(operation);
      if (length !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(length) || !Number.isSafeInteger(Number(length)) ||
          operation !== "HeadObject" && Number(length) !== body.length)) fail(READBACK_CODE);
      if (["GetObject", "HeadObject"].includes(operation) && (length === null || !httpTime(headers["last-modified"]) ||
          !headers.etag || headers["x-oss-server-side-encryption"] !== "AES256" ||
          !headers["content-type"] || operation === "HeadObject" && body.length !== 0)) fail(READBACK_CODE);
      if (operation === "GetObject" && (!Buffer.isBuffer(result.content) || !result.content.equals(body))) fail(READBACK_CODE);
      await assertNativeProjection(operation, body, result);
      // Canonical collector records contain SDK-parsed response fields. They are
      // not original HTTP header lines or an original wire message.
      const raw = Buffer.from(encodeManualJson({ recordVersion: "manual-expected-oss-readback.v1", operation,
        bucket: BUCKET, objectKey: object ? key : null, readerPrincipal, observedAt,
        response: { status: 200, headers, body: addRaw(body) },
        bucketChecks: operation === "HeadObject" ? [...bucketChecks] : [] }));
      const ref = addRaw(raw); records.set(operation, raw);
      if (!object) bucketChecks.push(ref);
    }
  };
}

/** Inactive protected-job binding: import has no IO; this function is never a CLI. */
export async function createManualBuildCustodyStorage(input, testOnlyLowLevelDependencies = {}) {
  const identity = assertIdentity(input);
  assertVendorDebugDisabled();
  if (!testOnlyLowLevelDependencies || typeof testOnlyLowLevelDependencies !== "object" ||
      Reflect.ownKeys(testOnlyLowLevelDependencies).some((key) => !["fetch", "createOssClient", "now"].includes(key))) {
    fail("MANUAL_BUILD_STORAGE_INPUT_INVALID");
  }
  const fetch = testOnlyLowLevelDependencies.fetch ?? globalThis.fetch;
  const now = testOnlyLowLevelDependencies.now ?? (() => new Date());
  const construct = testOnlyLowLevelDependencies.createOssClient ?? ((options) => {
    const OSS = requireApi("ali-oss");
    return new OSS(options);
  });
  const token = await oidcToken(fetch);
  const writer = await assumeRole({ fetch, token, role: WRITER_ROLE, session: `stage1-writer-${identity.runId}-attempt-1`, now });
  const reader = await assumeRole({ fetch, token, role: READER_ROLE, session: `stage1-reader-${identity.runId}-attempt-1`, now });
  if (writer.arn === reader.arn || writer.accessKeyId === reader.accessKeyId ||
      writer.accessKeySecret === reader.accessKeySecret || writer.stsToken === reader.stsToken) fail("MANUAL_BUILD_STORAGE_STS_INVALID");
  const options = (credentials) => ({ bucket: BUCKET, region: "oss-cn-shanghai", endpoint: "https://oss-cn-shanghai.aliyuncs.com",
    secure: true, authorizationV4: true, retryMax: 0, accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret, stsToken: credentials.stsToken });
  const writerClient = await sanitizedCall(() => construct(options(writer)), "MANUAL_BUILD_STORAGE_CLIENT_INVALID");
  const readerClient = await sanitizedCall(() => construct(options(reader)), "MANUAL_BUILD_STORAGE_CLIENT_INVALID");
  if (!writerClient || !readerClient || writerClient === readerClient) fail("MANUAL_BUILD_STORAGE_CLIENT_INVALID");
  return Object.freeze({
    trustPolicy: "immutable-content-addressed/v1", writerIdentity: writer.arn, auditReaderIdentity: "audit-reader",
    async createOnly(input) {
      if (!exactDataObject(input, ["key", "bytes", "contentDigest", "requestedAt", "retainUntil"]) ||
          !(input.bytes instanceof Uint8Array)) fail("MANUAL_BUILD_STORAGE_INPUT_INVALID");
      const bytes = Buffer.from(input.bytes), key = physicalKey(input.key, identity.runId);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (input.contentDigest !== digest || (input.key.startsWith("evidence/") && input.key !== `evidence/${digest.slice(7)}.json`) ||
          !canonicalTime(input.requestedAt) || !canonicalTime(input.retainUntil) ||
          Date.parse(input.retainUntil) <= Date.parse(input.requestedAt)) fail("MANUAL_BUILD_STORAGE_INPUT_INVALID");
      const requestedRetention = Date.parse(input.retainUntil);
      await assertBucket(readerClient);
      let result;
      try {
        result = await writerClient.put(key, bytes, { mime: "application/json", headers: {
          "x-oss-forbid-overwrite": "true", "x-oss-object-acl": "private", "x-oss-server-side-encryption": "AES256"
        } });
      } catch (error) {
        if (error?.status === 409 && ["FileAlreadyExists", "FileImmutable"].includes(error?.code)) fail("EVIDENCE_OVERWRITE_REFUSED");
        fail("MANUAL_BUILD_STORAGE_WRITE_FAILED");
      }
      if (!successful(result)) fail("MANUAL_BUILD_STORAGE_WRITE_FAILED");
      const facts = await metadata(readerClient, key);
      if (facts.contentSizeBytes !== bytes.length || Date.parse(facts.retainUntil) < requestedRetention) fail("MANUAL_BUILD_STORAGE_METADATA_INVALID");
      return Object.freeze({ created: true, ...facts });
    },
    async readMetadata(input) {
      assertReader(input);
      return metadata(readerClient, physicalKey(input.key, identity.runId));
    },
    async readWithEvidence(input) {
      assertReader(input);
      const logicalKey = input.key;
      if (typeof logicalKey !== "string" || !/^evidence\/[0-9a-f]{64}\.json$/u.test(logicalKey)) fail("MANUAL_BUILD_STORAGE_KEY_INVALID");
      const key = physicalKey(logicalKey, identity.runId), expectedDigest = `sha256:${logicalKey.slice(9, -5)}`;
      const collected = readbackCollector({ now, key, readerPrincipal: reader.arn });
      const facts = await metadata(readerClient, key, collected.capture);
      const result = await sanitizedCall(() => readerClient.get(key), "MANUAL_BUILD_STORAGE_READ_FAILED");
      await collected.capture("GetObject", result);
      const bytes = Buffer.from(result.content), head = JSON.parse(collected.records.get("HeadObject")),
        get = JSON.parse(collected.records.get("GetObject")), readbackAt = collected.time();
      if (sha256Bytes(bytes) !== expectedDigest || bytes.length !== facts.contentSizeBytes ||
          ["content-length", "last-modified", "etag", "x-oss-server-side-encryption", "content-type"].some((name) =>
            head.response.headers[name] !== get.response.headers[name]) || Date.parse(facts.storedAt) > Date.parse(readbackAt)) fail(READBACK_CODE);
      return Object.freeze({ metadata: facts, readbackAt, bytes,
        getEvidenceBytes: Buffer.from(collected.records.get("GetObject")),
        headEvidenceBytes: Buffer.from(collected.records.get("HeadObject")),
        aclEvidenceBytes: Buffer.from(collected.records.get("GetObjectAcl")),
        rawBlobs: new Map([...collected.raws].map(([digest, raw]) => [digest, Buffer.from(raw)])) });
    },
    async read(input) {
      assertReader(input);
      const key = physicalKey(input.key, identity.runId);
      const result = await sanitizedCall(() => readerClient.get(key), "MANUAL_BUILD_STORAGE_READ_FAILED");
      const length = result?.res?.headers?.["content-length"];
      if (!fullResponse(result) || !Buffer.isBuffer(result.content) ||
          typeof length !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(length) || Number(length) !== result.content.length) {
        fail("MANUAL_BUILD_STORAGE_READ_INVALID");
      }
      return Buffer.from(result.content);
    }
  });
}
