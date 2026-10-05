import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { TextDecoder } from "node:util";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { validateProducerCryptoAuthorization } from "../../packages/release-foundation/src/snapshot/producer-crypto-contracts.mjs";
import { readSnapshotStsIdentity } from "./snapshot-sts-identity.mjs";
import { readSnapshotOssOriginals } from "./snapshot-oss-originals.mjs";

const ACCOUNT = "1457643390906675";
const BUCKET = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const ENDPOINT = "https://oss-cn-shanghai.aliyuncs.com";
const MAX_SESSION_MS = 900000;
const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const addressing = JSON.parse(
  readFileSync(
    new URL("../../release/contracts/policies/snapshot-object-addressing.v2.json", import.meta.url),
    "utf8"
  )
);
const FIXED_OUTPUTS = [
  "snapshot.enc",
  "encryption-envelope.json",
  "snapshot-proof.json",
  "diagnostics.redacted.json",
  "data-result.json"
];
const OUTPUTS = new Map(
  addressing.outputs.map(({ filename, maxSizeBytes }) => [filename, maxSizeBytes])
);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(value, key) && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
    )
  );
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertPolicy() {
  if (
    addressing.contractVersion !== "snapshot-object-addressing.v2" ||
    addressing.prefixTemplate !== "snapshot-slots/v2/${releaseAttemptId}/${snapshotRunId}/" ||
    addressing.exactKeysOnly !== true ||
    addressing.versioning !== "Disabled" ||
    addressing.outputs.length !== 5 ||
    OUTPUTS.size !== 5 ||
    !FIXED_OUTPUTS.every(
      (filename) => OUTPUTS.get(filename) === (filename === "snapshot.enc" ? 1073741824 : 1048576)
    )
  ) {
    fail("SNAPSHOT_OSS_POLICY_INVALID");
  }
}

function identity(input) {
  const { releaseAttemptId, snapshotRunId } = input;
  if (
    typeof releaseAttemptId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseAttemptId) ||
    typeof snapshotRunId !== "string" ||
    !/^[1-9][0-9]*$/u.test(snapshotRunId)
  ) {
    fail("SNAPSHOT_OSS_IDENTITY_INVALID");
  }
  return `snapshot-slots/v2/${releaseAttemptId}/${snapshotRunId}/`;
}

function slot(prefix, key) {
  if (
    typeof key !== "string" ||
    !key.startsWith(prefix) ||
    !OUTPUTS.has(key.slice(prefix.length))
  ) {
    fail("SNAPSHOT_OSS_KEY_INVALID");
  }
  return {
    key,
    filename: key.slice(prefix.length),
    maxSizeBytes: OUTPUTS.get(key.slice(prefix.length))
  };
}

function readRequest(prefix, request) {
  if (!exact(request, ["key", "contentDigest", "sizeBytes"])) fail("SNAPSHOT_OSS_INPUT_INVALID");
  const subject = slot(prefix, request.key);
  if (
    typeof request.contentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(request.contentDigest) ||
    !Number.isSafeInteger(request.sizeBytes) ||
    request.sizeBytes < 1 ||
    request.sizeBytes > subject.maxSizeBytes
  )
    fail("SNAPSHOT_OSS_INPUT_INVALID");
  return { key: subject.key, contentDigest: request.contentDigest, sizeBytes: request.sizeBytes };
}

function time(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}

function sessionArn(value) {
  if (
    typeof value !== "string" ||
    !new RegExp(
      `^acs:ram::${ACCOUNT}:(?:assumed-role|role)/[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$`,
      "u"
    ).test(value)
  ) {
    fail("SNAPSHOT_OSS_SESSION_INVALID");
  }
  // AssumeRole and GetCallerIdentity spell the same STS principal differently.
  return value.replace(":role/", ":assumed-role/");
}

function session(value, now) {
  if (
    !exact(value, ["arn", "accessKeyId", "accessKeySecret", "stsToken", "issuedAt", "expiresAt"]) ||
    typeof value.arn !== "string" ||
    typeof value.accessKeyId !== "string" ||
    !/^STS\.[A-Za-z0-9._-]+$/u.test(value.accessKeyId) ||
    typeof value.accessKeySecret !== "string" ||
    !value.accessKeySecret ||
    typeof value.stsToken !== "string" ||
    !value.stsToken ||
    !Number.isFinite(time(value.issuedAt)) ||
    !Number.isFinite(time(value.expiresAt)) ||
    time(value.issuedAt) > now ||
    time(value.expiresAt) <= now ||
    time(value.expiresAt) - time(value.issuedAt) > MAX_SESSION_MS
  ) {
    fail("SNAPSHOT_OSS_SESSION_INVALID");
  }
  return {
    arn: sessionArn(value.arn),
    accessKeyId: value.accessKeyId,
    accessKeySecret: value.accessKeySecret,
    stsToken: value.stsToken,
    expiresAt: time(value.expiresAt)
  };
}

function current(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    fail("SNAPSHOT_OSS_CLOCK_INVALID");
  return value.getTime();
}

function assertLive(sessionValue, now) {
  if (sessionValue.expiresAt <= current(now)) fail("SNAPSHOT_OSS_SESSION_INVALID");
}

function dependencies(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).some(
      (key) => !["createOssClient", "createStsClient", "now"].includes(key)
    )
  ) {
    fail("SNAPSHOT_OSS_INPUT_INVALID");
  }
  if (value.now !== undefined && typeof value.now !== "function")
    fail("SNAPSHOT_OSS_INPUT_INVALID");
  if (value.createOssClient !== undefined && typeof value.createOssClient !== "function")
    fail("SNAPSHOT_OSS_INPUT_INVALID");
  if (value.createStsClient !== undefined && typeof value.createStsClient !== "function")
    fail("SNAPSHOT_OSS_INPUT_INVALID");
  return {
    now: value.now ?? (() => new Date()),
    createOssClient: value.createOssClient ?? ((options) => new (requireApi("ali-oss"))(options)),
    createStsClient: value.createStsClient
  };
}

function assertDebugDisabled() {
  const debug = createRequire(requireApi.resolve("ali-oss"))("debug");
  if (debug.enabled("ali-oss")) fail("SNAPSHOT_OSS_DEBUG_UNSAFE");
}

function client(sessionValue, construct) {
  let result;
  try {
    result = construct({
      bucket: BUCKET,
      region: "oss-cn-shanghai",
      endpoint: ENDPOINT,
      secure: true,
      authorizationV4: true,
      retryMax: 0,
      accessKeyId: sessionValue.accessKeyId,
      accessKeySecret: sessionValue.accessKeySecret,
      stsToken: sessionValue.stsToken
    });
  } catch {
    fail("SNAPSHOT_OSS_CLIENT_INVALID");
  }
  if (!result || typeof result !== "object") fail("SNAPSHOT_OSS_CLIENT_INVALID");
  return result;
}

function allowedBytes(input, prefix) {
  if (!exact(input, ["key", "bytes", "contentDigest"]) || !(input.bytes instanceof Uint8Array)) {
    fail("SNAPSHOT_OSS_INPUT_INVALID");
  }
  const subject = slot(prefix, input.key);
  const bytes = Buffer.from(input.bytes);
  if (
    bytes.length < 1 ||
    bytes.length > subject.maxSizeBytes ||
    input.contentDigest !== digest(bytes)
  ) {
    fail("SNAPSHOT_OSS_INPUT_INVALID");
  }
  if (subject.filename === "snapshot.enc") {
    // The encrypted payload is opaque; publication requires the caller's completed crypto boundary.
    return { ...subject, bytes };
  }
  let parsed;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      canonicalJson(parsed) !== text
    )
      throw new Error();
    const forbidden =
      /(?:private.?key|password|access.?key|security.?token|sts.?token|client.?secret|credential)/iu;
    const check = (value, path = []) => {
      if (value && typeof value === "object")
        for (const [key, child] of Object.entries(value)) {
          if (forbidden.test(key)) {
            // This is a closed, public v2 authorization assertion, never key
            // material. All other private-key/credential fields stay denied.
            if (
              subject.filename !== "data-result.json" ||
              [...path, key].join(".") !== "cryptoAuthorization.handoff.privateKey" ||
              child !== false
            )
              throw new Error();
            validateProducerCryptoAuthorization(parsed.cryptoAuthorization);
          }
          check(child, [...path, key]);
        }
      // Fixed hash encodings can legitimately contain digit runs resembling identifiers.
      if (typeof value === "string" && /^(?:sha256:[0-9a-f]{64}|[0-9a-f]{40})$/u.test(value))
        return;
      if (
        typeof value === "string" &&
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|\b(?:sk|gh[oprsu])[-_][A-Za-z0-9_-]{16,}\b|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@|(?<![0-9])1[3-9][0-9]{9}(?![0-9])|(?<![0-9])[1-9][0-9]{16}[0-9Xx](?![0-9])/u.test(
          value
        )
      )
        throw new Error();
    };
    check(parsed);
  } catch {
    fail("SNAPSHOT_OSS_INPUT_INVALID");
  }
  return { ...subject, bytes };
}

// Validate every object before the first irreversible conditional write.
export function assertSnapshotPublicationObject(input) {
  assertPolicy();
  if (!exact(input, ["releaseAttemptId", "snapshotRunId", "key", "bytes", "contentDigest"]))
    fail("SNAPSHOT_OSS_INPUT_INVALID");
  allowedBytes(
    { key: input.key, bytes: input.bytes, contentDigest: input.contentDigest },
    identity(input)
  );
}

function status200(result) {
  return result?.res?.status === 200 && (result.status === undefined || result.status === 200);
}

function headers(result) {
  const value = result?.res?.headers;
  if (
    !status200(result) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value["x-oss-version-id"] !== undefined ||
    value["content-range"] !== undefined ||
    value["content-encoding"] !== undefined
  )
    fail("SNAPSHOT_OSS_READBACK_INVALID");
  return value;
}

function responseFacts(result, expected, bytes) {
  const value = headers(result),
    length = value["content-length"];
  if (
    typeof length !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(length) ||
    Number(length) !== expected.sizeBytes ||
    typeof value.etag !== "string" ||
    !value.etag ||
    typeof value["last-modified"] !== "string" ||
    !Number.isFinite(Date.parse(value["last-modified"])) ||
    value["x-oss-server-side-encryption"] !== "AES256" ||
    (bytes && (bytes.length !== expected.sizeBytes || digest(bytes) !== expected.contentDigest))
  ) {
    fail("SNAPSHOT_OSS_READBACK_INVALID");
  }
  return Object.freeze({
    key: expected.key,
    version: "null-version-disabled",
    etag: value.etag,
    digest: expected.contentDigest,
    sizeBytes: expected.sizeBytes,
    lastModified: new Date(value["last-modified"]).toISOString(),
    requestId: value["x-oss-request-id"] ?? null
  });
}

async function bucketFacts(reader) {
  let acl, worm, raw;
  try {
    acl = await reader.getBucketACL(BUCKET);
    worm = await reader.getBucketWorm(BUCKET);
    raw = await reader.request({
      method: "GET",
      bucket: BUCKET,
      subres: "versioning",
      successStatuses: [200],
      xmlResponse: false
    });
  } catch {
    fail("SNAPSHOT_OSS_READBACK_UNKNOWN");
  }
  if (
    !status200(acl) ||
    acl.acl !== "private" ||
    acl.owner?.id !== ACCOUNT ||
    !status200(worm) ||
    worm.state !== "Locked" ||
    worm.days !== "210" ||
    typeof worm.wormId !== "string" ||
    !worm.wormId ||
    typeof worm.creationDate !== "string" ||
    !Number.isFinite(Date.parse(worm.creationDate)) ||
    !status200(raw) ||
    !Buffer.isBuffer(raw.data)
  )
    fail("SNAPSHOT_OSS_BUCKET_INVALID");
  let parsed;
  try {
    const xml2js = createRequire(requireApi.resolve("ali-oss"))("xml2js");
    parsed = await xml2js.parseStringPromise(
      new TextDecoder("utf-8", { fatal: true }).decode(raw.data),
      { explicitRoot: true, explicitArray: true, strict: true }
    );
  } catch {
    fail("SNAPSHOT_OSS_BUCKET_INVALID");
  }
  const root = parsed?.VersioningConfiguration;
  if (
    !parsed ||
    Object.keys(parsed).length !== 1 ||
    (typeof root === "string" && root.trim() !== "") ||
    (typeof root !== "string" &&
      (!root ||
        typeof root !== "object" ||
        Object.keys(root).some((key) => !["$", "Status"].includes(key)) ||
        root.$?.xmlns !== "http://doc.oss-cn-hangzhou.aliyuncs.com" ||
        (root.Status !== undefined &&
          (!Array.isArray(root.Status) || root.Status.length !== 1 || root.Status[0] !== ""))))
  ) {
    fail("SNAPSHOT_OSS_BUCKET_INVALID");
  }
  return Object.freeze({
    acl: "private",
    ownerId: ACCOUNT,
    versioning: "Disabled",
    worm: Object.freeze({
      id: worm.wormId,
      state: worm.state,
      retentionDays: Number(worm.days),
      creationDate: worm.creationDate
    })
  });
}

/** Internal transport only: caller must already have approved, short-lived publisher STS. */
export async function createSnapshotPublisherTransport(input, lowLevelDependencies = {}) {
  assertPolicy();
  if (!exact(input, ["releaseAttemptId", "snapshotRunId", "session"]))
    fail("SNAPSHOT_OSS_INPUT_INVALID");
  const prefix = identity(input),
    deps = dependencies(lowLevelDependencies);
  const credential = session(input.session, current(deps.now));
  assertDebugDisabled();
  const identityOriginal = await readSnapshotStsIdentity(
    credential,
    deps.now,
    deps.createStsClient
  );
  const writer = client(credential, deps.createOssClient);
  if (typeof writer.put !== "function") fail("SNAPSHOT_OSS_CLIENT_INVALID");
  return Object.freeze({
    identityOriginal,
    async createOnly(request) {
      const subject = allowedBytes(request, prefix);
      assertLive(credential, deps.now);
      let result;
      try {
        result = await writer.put(subject.key, subject.bytes, {
          mime:
            subject.filename === "snapshot.enc" ? "application/octet-stream" : "application/json",
          headers: {
            "x-oss-forbid-overwrite": "true",
            "x-oss-object-acl": "private",
            "x-oss-server-side-encryption": "AES256"
          }
        });
      } catch (error) {
        if (error?.status === 409 && ["FileAlreadyExists", "FileImmutable"].includes(error?.code)) {
          fail("SNAPSHOT_OSS_OVERWRITE_REFUSED");
        }
        fail("SNAPSHOT_OSS_WRITE_OUTCOME_UNKNOWN");
      }
      if (
        !status200(result) ||
        typeof result.res.headers?.["x-oss-request-id"] !== "string" ||
        !result.res.headers["x-oss-request-id"]
      )
        fail("SNAPSHOT_OSS_WRITE_OUTCOME_UNKNOWN");
      // ali-oss put() preserves the urllib response under `res`, including its
      // original body bytes. A completed PUT with no original is an unknown receipt.
      const nativeBody = result.res.data;
      const observedAt = new Date(current(deps.now)).toISOString();
      const sourceHeaders = result.res.headers;
      const capturedHeaders = {};
      for (const name of [
        "date",
        "x-oss-request-id",
        "etag",
        "content-length",
        "x-oss-version-id"
      ]) {
        const value = sourceHeaders[name];
        if (value !== undefined) {
          if (
            typeof value !== "string" ||
            value.length === 0 ||
            value.length > 2048 ||
            [...value].some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
            )
          )
            fail("SNAPSHOT_OSS_WRITE_OUTCOME_UNKNOWN");
          capturedHeaders[name] = value;
        }
      }
      if (
        !Buffer.isBuffer(nativeBody) ||
        nativeBody.length !== 0 ||
        !Number.isFinite(Date.parse(capturedHeaders.date)) ||
        Date.parse(capturedHeaders.date) > Date.parse(observedAt) ||
        !capturedHeaders["x-oss-request-id"] ||
        !capturedHeaders.etag ||
        capturedHeaders["x-oss-version-id"] !== undefined ||
        (capturedHeaders["content-length"] !== undefined &&
          capturedHeaders["content-length"] !== "0")
      )
        fail("SNAPSHOT_OSS_WRITE_OUTCOME_UNKNOWN");
      const body = Buffer.from(nativeBody);
      const putObservation = {
        record: {
          recordVersion: "r3-snapshot-oss-response.v1",
          operation: "PutObject",
          bucket: BUCKET,
          objectKey: subject.key,
          principal: credential.arn,
          observedAt,
          requestHeaders: { "x-oss-forbid-overwrite": "true" },
          response: {
            status: result.res.status,
            headers: capturedHeaders,
            body: { digest: digest(body), bytes: body.length }
          }
        },
        bodyBase64: body.toString("base64")
      };
      return Object.freeze({
        key: subject.key,
        digest: digest(subject.bytes),
        sizeBytes: subject.bytes.length,
        requestId: result.res.headers["x-oss-request-id"],
        etag: result.res.headers.etag ?? null,
        putObservation
      });
    }
  });
}

/** Independent read-only transport; it cannot publish or infer crypto/host terminal state. */
export async function createSnapshotReaderTransport(input, lowLevelDependencies = {}) {
  assertPolicy();
  if (!exact(input, ["releaseAttemptId", "snapshotRunId", "session", "writerArn"]))
    fail("SNAPSHOT_OSS_INPUT_INVALID");
  const prefix = identity(input),
    deps = dependencies(lowLevelDependencies);
  const credential = session(input.session, current(deps.now));
  const writerArn = sessionArn(input.writerArn);
  if (
    writerArn.slice(0, writerArn.lastIndexOf("/")) ===
    credential.arn.slice(0, credential.arn.lastIndexOf("/"))
  ) {
    fail("SNAPSHOT_OSS_SESSION_INVALID");
  }
  assertDebugDisabled();
  const identityOriginal = await readSnapshotStsIdentity(
    credential,
    deps.now,
    deps.createStsClient
  );
  const reader = client(credential, deps.createOssClient);
  if (
    ["getBucketACL", "getBucketWorm", "request", "head", "get"].some(
      (name) => typeof reader[name] !== "function"
    )
  ) {
    fail("SNAPSHOT_OSS_CLIENT_INVALID");
  }
  return Object.freeze({
    identityOriginal,
    // Bounded bootstrap for the signed publication marker and its public
    // documents. Returned JSON is untrusted until the H1 signatures validate.
    async readPublicJson(request) {
      if (!exact(request, ["key"])) fail("SNAPSHOT_OSS_INPUT_INVALID");
      const subject = slot(prefix, request.key);
      if (subject.filename === "snapshot.enc") fail("SNAPSHOT_OSS_INPUT_INVALID");
      assertLive(credential, deps.now);
      let head, get;
      try {
        head = await reader.head(subject.key);
      } catch (error) {
        if (error?.status === 404 && error?.code === "NoSuchKey")
          fail("SNAPSHOT_OSS_OBJECT_NOT_READY");
        fail("SNAPSHOT_OSS_READBACK_UNKNOWN");
      }
      const length = headers(head)["content-length"];
      if (
        typeof length !== "string" ||
        !/^[1-9][0-9]*$/.test(length) ||
        Number(length) > subject.maxSizeBytes
      )
        fail("SNAPSHOT_OSS_READBACK_INVALID");
      try {
        get = await reader.get(subject.key);
      } catch {
        fail("SNAPSHOT_OSS_READBACK_UNKNOWN");
      }
      if (!Buffer.isBuffer(get.content)) fail("SNAPSHOT_OSS_READBACK_INVALID");
      const expected = {
        key: subject.key,
        sizeBytes: Number(length),
        contentDigest: digest(get.content)
      };
      const headFacts = responseFacts(head, expected),
        getFacts = responseFacts(get, expected, get.content);
      if (headFacts.etag !== getFacts.etag || headFacts.lastModified !== getFacts.lastModified)
        fail("SNAPSHOT_OSS_READBACK_INVALID");
      allowedBytes(
        { key: subject.key, bytes: get.content, contentDigest: expected.contentDigest },
        prefix
      );
      const bucket = await bucketFacts(reader);
      assertLive(credential, deps.now);
      return {
        bytes: Buffer.from(get.content),
        observation: Object.freeze({
          bucket,
          readerArn: credential.arn,
          expectedWriterArn: writerArn,
          head: headFacts,
          get: getFacts
        })
      };
    },
    async readback(request) {
      const expected = readRequest(prefix, request);
      assertLive(credential, deps.now);
      const bucket = await bucketFacts(reader);
      let head, get;
      try {
        head = await reader.head(expected.key);
      } catch {
        fail("SNAPSHOT_OSS_READBACK_UNKNOWN");
      }
      const headFacts = responseFacts(head, expected);
      try {
        get = await reader.get(expected.key);
      } catch {
        fail("SNAPSHOT_OSS_READBACK_UNKNOWN");
      }
      if (!Buffer.isBuffer(get.content)) fail("SNAPSHOT_OSS_READBACK_INVALID");
      const getFacts = responseFacts(get, expected, get.content);
      if (headFacts.etag !== getFacts.etag || headFacts.lastModified !== getFacts.lastModified) {
        fail("SNAPSHOT_OSS_READBACK_INVALID");
      }
      assertLive(credential, deps.now);
      return Object.freeze({
        bucket,
        readerArn: credential.arn,
        expectedWriterArn: writerArn,
        head: headFacts,
        get: getFacts
      });
    },
    async readbackOriginals(request) {
      const expected = readRequest(prefix, request);
      if (expected.key !== prefix + "snapshot.enc") fail("SNAPSHOT_OSS_INPUT_INVALID");
      assertLive(credential, deps.now);
      const result = await readSnapshotOssOriginals(reader, expected, credential.arn, deps.now);
      assertLive(credential, deps.now);
      return Object.freeze({
        ...result,
        readerArn: credential.arn,
        expectedWriterArn: writerArn,
        readerIdentityOriginal: identityOriginal
      });
    }
  });
}
