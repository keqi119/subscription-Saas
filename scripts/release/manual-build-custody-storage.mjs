import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import { TextDecoder } from "node:util";

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

async function assertVersioningDisabled(reader) {
  const code = "MANUAL_BUILD_STORAGE_BUCKET_INVALID";
  // getBucketVersioning uses explicitRoot:false and always synthesizes Status.
  // A successful response with the wrong XML root must never mean Disabled.
  const raw = await sanitizedCall(() => reader.request({ method: "GET", bucket: BUCKET,
    subres: "versioning", successStatuses: [200], xmlResponse: false }), code);
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

async function assertBucket(reader) {
  const code = "MANUAL_BUILD_STORAGE_BUCKET_INVALID";
  const acl = await sanitizedCall(() => reader.getBucketACL(BUCKET), code);
  const worm = await sanitizedCall(() => reader.getBucketWorm(BUCKET), code);
  await assertVersioningDisabled(reader);
  const encryption = await sanitizedCall(() => reader.getBucketEncryption(BUCKET), code);
  const request = (subres) => reader.request({ method: "GET", bucket: BUCKET, subres,
    successStatuses: [200], xmlResponse: true });
  const policy = await sanitizedCall(() => request("policyStatus"), code);
  const publicAccess = await sanitizedCall(() => request("publicAccessBlock"), code);
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

async function metadata(reader, key) {
  const code = "MANUAL_BUILD_STORAGE_METADATA_INVALID";
  await assertBucket(reader);
  const head = await sanitizedCall(() => reader.head(key), code);
  const acl = await sanitizedCall(() => reader.getACL(key), code);
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
