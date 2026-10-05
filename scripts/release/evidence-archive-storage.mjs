import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { validateEvidenceArchiveAuthorization } from "../../packages/release-foundation/src/snapshot/custody-contracts.mjs";
import {
  assertEvidenceArchiveOriginal,
  buildEvidenceArchiveRamPolicy
} from "./evidence-archive-ram-policy.mjs";
import { readSnapshotStsIdentity } from "./snapshot-sts-identity.mjs";

const CODE = "EVIDENCE_ARCHIVE_STORAGE_INVALID";
const ACCOUNT = "1457643390906675";
const BUCKET = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const ENDPOINT = "https://oss-cn-shanghai.aliyuncs.com";
const WRITER = `acs:ram::${ACCOUNT}:role/subscription-saas-stage1-archive-writer`;
const READER = `acs:ram::${ACCOUNT}:role/subscription-saas-stage1-archive-reader`;
const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const responseHeaders = [
  "date",
  "x-oss-request-id",
  "content-length",
  "content-type",
  "last-modified",
  "etag",
  "x-oss-server-side-encryption"
];
const fail = (code = CODE) => {
  throw Object.assign(new Error(code), { code });
};
const check = (condition, code = CODE) => {
  if (!condition) fail(code);
};

function dependencies(value) {
  assertKernelFrame(value, Reflect.ownKeys(value), CODE);
  check(
    Reflect.ownKeys(value).every((key) =>
      ["createOssClient", "createStsClient", "now"].includes(key)
    )
  );
  const captured = snapshotKernelData(value, CODE, true);
  check(Object.values(captured).every((entry) => typeof entry === "function"));
  return {
    now: captured.now ?? (() => new Date()),
    createOssClient:
      captured.createOssClient ?? ((options) => new (requireApi("ali-oss"))(options)),
    createStsClient: captured.createStsClient
  };
}

function current(now) {
  const value = now();
  check(
    value instanceof Date && Number.isFinite(value.getTime()),
    "EVIDENCE_ARCHIVE_CLOCK_INVALID"
  );
  return value.getTime();
}

function instant(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
  )
    return NaN;
  const time = Date.parse(value);
  const normalized = value.replace(
    /(?:\.(\d{1,3}))?Z$/u,
    (_, fraction = "") => `.${fraction.padEnd(3, "0")}Z`
  );
  return Number.isFinite(time) && new Date(time).toISOString() === normalized ? time : NaN;
}

function credential(value, role, authorization, now) {
  assertKernelFrame(
    value,
    ["arn", "accessKeyId", "accessKeySecret", "stsToken", "issuedAt", "expiresAt"],
    CODE
  );
  const captured = snapshotKernelData(value, CODE);
  const assumed = `${role.replace(":role/", ":assumed-role/")}/`;
  check(typeof captured.arn === "string", "EVIDENCE_ARCHIVE_SESSION_INVALID");
  const arn = captured.arn.replace(":role/", ":assumed-role/");
  const issued = instant(captured.issuedAt),
    expires = instant(captured.expiresAt);
  check(
    arn.startsWith(assumed) &&
      /^[A-Za-z0-9_-]{1,64}$/u.test(arn.slice(assumed.length)) &&
      /^STS\.[A-Za-z0-9._-]+$/u.test(captured.accessKeyId) &&
      typeof captured.accessKeySecret === "string" &&
      captured.accessKeySecret.length > 0 &&
      typeof captured.stsToken === "string" &&
      captured.stsToken.length > 0 &&
      Number.isFinite(issued) &&
      Number.isFinite(expires) &&
      issued <= now &&
      now < expires &&
      expires - issued <= 900_000 &&
      issued >= instant(authorization.issuedAt) &&
      now < instant(authorization.notAfter) &&
      issued < instant(authorization.notAfter),
    "EVIDENCE_ARCHIVE_SESSION_INVALID"
  );
  return {
    ...captured,
    arn,
    issuedAtMs: issued,
    expiresAtMs: expires,
    authorizationNotAfterMs: instant(authorization.notAfter)
  };
}

function assertLive(session, now) {
  const at = current(now);
  check(
    at >= session.issuedAtMs && at < session.expiresAtMs && at < session.authorizationNotAfterMs,
    "EVIDENCE_ARCHIVE_SESSION_INVALID"
  );
  return at;
}

function scope(authorization, profile) {
  validateEvidenceArchiveAuthorization(authorization);
  check(
    authorization.profile === profile &&
      authorization.resource.region === "oss-cn-shanghai" &&
      authorization.resource.bucket === BUCKET &&
      authorization.identities.writer === WRITER &&
      authorization.identities.reader === READER,
    "EVIDENCE_ARCHIVE_SCOPE_INVALID"
  );
  return new Map(authorization.objects.map((object) => [object.exactKey, object]));
}

function assertDebugDisabled() {
  const debug = createRequire(requireApi.resolve("ali-oss"))("debug");
  check(!debug.enabled("ali-oss"), "EVIDENCE_ARCHIVE_DEBUG_UNSAFE");
}

function client(session, createOssClient) {
  let result;
  try {
    result = createOssClient({
      bucket: BUCKET,
      region: "oss-cn-shanghai",
      endpoint: ENDPOINT,
      secure: true,
      authorizationV4: true,
      retryMax: 0,
      accessKeyId: session.accessKeyId,
      accessKeySecret: session.accessKeySecret,
      stsToken: session.stsToken
    });
  } catch {
    fail("EVIDENCE_ARCHIVE_CLIENT_INVALID");
  }
  check(result && typeof result === "object", "EVIDENCE_ARCHIVE_CLIENT_INVALID");
  return result;
}

function safeResponse(operation, result, body, objectKey, principal, now, requestHeaders = {}) {
  const observedAt = new Date(current(now)).toISOString();
  const headers = result?.res?.headers,
    selected = {};
  check(
    result?.res?.status === 200 &&
      (result.status === undefined || result.status === 200) &&
      headers &&
      typeof headers === "object" &&
      !Array.isArray(headers) &&
      Buffer.isBuffer(body)
  );
  check(
    headers["content-range"] === undefined &&
      headers["content-encoding"] === undefined &&
      headers["x-oss-version-id"] === undefined
  );
  for (const name of responseHeaders) {
    const value = headers[name];
    if (value !== undefined) {
      check(
        typeof value === "string" &&
          value.length > 0 &&
          value.length <= 2048 &&
          [...value].every((character) => {
            const code = character.charCodeAt(0);
            return code >= 32 && code !== 127;
          })
      );
      selected[name] = value;
    }
  }
  check(
    typeof selected.date === "string" &&
      Number.isFinite(Date.parse(selected.date)) &&
      Date.parse(selected.date) <= Date.parse(observedAt)
  );
  check(typeof selected["x-oss-request-id"] === "string");
  if (operation !== "HeadObject" && selected["content-length"] !== undefined)
    check(selected["content-length"] === String(body.length));
  return {
    recordVersion: "evidence-archive-oss-response.v1",
    operation,
    bucket: BUCKET,
    objectKey,
    principal,
    observedAt,
    requestHeaders,
    response: {
      status: result.res.status,
      headers: selected,
      body: { digest: sha256Bytes(body), bytes: body.length }
    }
  };
}

function original(bytes) {
  return { digest: sha256Bytes(bytes), bytesBase64: bytes.toString("base64") };
}

async function parseXml(bytes, rootName) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1_048_576);
  let parsed;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    check(!/<!DOCTYPE|<!ENTITY/iu.test(source));
    const xml2js = createRequire(requireApi.resolve("ali-oss"))("xml2js");
    parsed = await xml2js.parseStringPromise(source, {
      explicitRoot: true,
      explicitArray: false,
      strict: true
    });
  } catch {
    fail("EVIDENCE_ARCHIVE_READBACK_INVALID");
  }
  check(
    parsed && Object.keys(parsed).length === 1 && Object.hasOwn(parsed, rootName),
    "EVIDENCE_ARCHIVE_READBACK_INVALID"
  );
  let root = parsed[rootName];
  if (root && typeof root === "object" && Object.hasOwn(root, "$")) {
    check(
      Object.keys(root.$).length === 1 &&
        root.$.xmlns === "http://doc.oss-cn-hangzhou.aliyuncs.com",
      "EVIDENCE_ARCHIVE_READBACK_INVALID"
    );
    root = { ...root };
    delete root.$;
  }
  return root;
}

function aclPrivate(value) {
  return (
    value &&
    Object.keys(value).length === 2 &&
    value.Owner?.ID === ACCOUNT &&
    typeof value.Owner.DisplayName === "string" &&
    value.AccessControlList?.Grant === "private" &&
    Object.keys(value.AccessControlList).length === 1
  );
}

function objectFacts(record, object) {
  const h = record.response.headers;
  check(
    h["content-length"] === String(object.contentSizeBytes) &&
      typeof h.etag === "string" &&
      h.etag.length > 0 &&
      Number.isFinite(Date.parse(h["last-modified"])) &&
      Date.parse(h["last-modified"]) <= Date.parse(record.observedAt) &&
      h["x-oss-server-side-encryption"] === "AES256",
    "EVIDENCE_ARCHIVE_READBACK_INVALID"
  );
  return {
    key: object.exactKey,
    digest: object.contentDigest,
    sizeBytes: object.contentSizeBytes,
    version: "null-version-disabled",
    etag: h.etag,
    lastModified: new Date(h["last-modified"]).toISOString(),
    requestId: h["x-oss-request-id"]
  };
}

function wormFacts(worm) {
  check(
    worm &&
      Object.keys(worm).length === 4 &&
      typeof worm.WormId === "string" &&
      worm.WormId &&
      worm.State === "Locked" &&
      worm.RetentionPeriodInDays === "210" &&
      Number.isFinite(Date.parse(worm.CreationDate))
  );
  return { id: worm.WormId, state: "Locked", retentionDays: 210, creationDate: worm.CreationDate };
}

function assertVersioningDisabled(versioning) {
  check(
    (typeof versioning === "string" && versioning.trim() === "") ||
      (versioning &&
        typeof versioning === "object" &&
        Object.keys(versioning).every((key) => key === "Status") &&
        (versioning.Status === undefined || versioning.Status === ""))
  );
}

// Offline verification at the later signing boundary. Reuse the transport's
// parsers and response projection; summaries alone are not readback originals.
export async function verifyEvidenceArchiveReaderObservation(input) {
  assertKernelFrame(
    input,
    ["result", "object", "identityOriginal", "startedAt", "observedAt"],
    CODE
  );
  const { result, object, identityOriginal, startedAt, observedAt } = snapshotKernelData(
    input,
    CODE
  );
  assertKernelFrame(
    result,
    ["identityOriginal", "bucket", "head", "get", "observedAt", "evidence"],
    CODE
  );
  assertKernelFrame(result.evidence, ["records", "originals"], CODE);
  const { records, originals } = result.evidence;
  check(
    Array.isArray(records) &&
      records.length === 6 &&
      Array.isArray(originals) &&
      originals.length === 12 &&
      canonicalJson(result.identityOriginal) === canonicalJson(identityOriginal) &&
      instant(startedAt) <= instant(result.observedAt) &&
      instant(result.observedAt) <= instant(observedAt)
  );
  const decode = (entry) => {
    assertKernelFrame(entry, ["digest", "bytesBase64"], CODE);
    check(typeof entry.bytesBase64 === "string" && entry.bytesBase64.length <= 1398104);
    const body = Buffer.from(entry.bytesBase64, "base64");
    check(
      body.toString("base64") === entry.bytesBase64 &&
        sha256Bytes(body) === entry.digest &&
        body.length <= 1048576
    );
    return body;
  };
  const operations = [
    "GetBucketAcl",
    "GetBucketWorm",
    "GetBucketVersioning",
    "HeadObject",
    "GetObjectAcl",
    "GetObject"
  ];
  const bodies = [];
  let previousAt = instant(startedAt);
  for (let index = 0; index < records.length; index++) {
    const record = records[index],
      body = decode(originals[index * 2]);
    check(
      decode(originals[index * 2 + 1]).equals(Buffer.from(canonicalJson(record))) &&
        previousAt <= instant(record.observedAt) &&
        instant(record.observedAt) <= instant(result.observedAt)
    );
    const rebuilt = safeResponse(
      operations[index],
      { res: { status: record.response?.status, headers: record.response?.headers } },
      body,
      index < 3 ? null : object.exactKey,
      identityOriginal.Arn,
      () => new Date(record.observedAt)
    );
    check(canonicalJson(rebuilt) === canonicalJson(record));
    previousAt = instant(record.observedAt);
    bodies.push(body);
  }
  check(
    aclPrivate(await parseXml(bodies[0], "AccessControlPolicy")) &&
      aclPrivate(await parseXml(bodies[4], "AccessControlPolicy"))
  );
  const worm = wormFacts(await parseXml(bodies[1], "WormConfiguration"));
  assertVersioningDisabled(await parseXml(bodies[2], "VersioningConfiguration"));
  const head = objectFacts(records[3], object),
    get = objectFacts(records[5], object);
  check(
    bodies[3].length === 0 &&
      head.etag === get.etag &&
      head.lastModified === get.lastModified &&
      Date.parse(worm.creationDate) <= Date.parse(head.lastModified) &&
      canonicalJson(head) === canonicalJson(result.head) &&
      canonicalJson(get) === canonicalJson(result.get) &&
      canonicalJson(result.bucket) ===
        canonicalJson({ acl: "private", ownerId: ACCOUNT, versioning: "Disabled", worm })
  );
  assertEvidenceArchiveOriginal(object, bodies[5]);
  return result;
}

/** Scoped transport only; authorization signatures and session terminal receipts belong to the caller. */
export async function createEvidenceArchiveWriterTransport(input, lowLevelDependencies = {}) {
  assertKernelFrame(input, ["authorization", "originals", "session"], CODE);
  const captured = snapshotKernelData(input, CODE);
  const objects = scope(captured.authorization, "archive-create-only-writer");
  buildEvidenceArchiveRamPolicy({
    authorization: captured.authorization,
    originals: captured.originals
  });
  const deps = dependencies(lowLevelDependencies),
    session = credential(captured.session, WRITER, captured.authorization, current(deps.now));
  assertDebugDisabled();
  const identityOriginal = await readSnapshotStsIdentity(
    { ...session, expiresAt: session.expiresAtMs },
    deps.now,
    deps.createStsClient
  );
  assertLive(session, deps.now);
  const writer = client(session, deps.createOssClient);
  check(typeof writer.put === "function", "EVIDENCE_ARCHIVE_CLIENT_INVALID");
  const originals = new Map(
    captured.originals.map((entry) => [entry.exactKey, entry.originalBytes])
  );
  const attempted = new Set();
  return Object.freeze({
    identityOriginal,
    async createOnly(request) {
      assertKernelFrame(request, ["exactKey", "originalBytes"], CODE);
      const subject = snapshotKernelData(request, CODE),
        object = objects.get(subject.exactKey);
      check(
        object &&
          Buffer.isBuffer(subject.originalBytes) &&
          subject.originalBytes.equals(originals.get(subject.exactKey)),
        "EVIDENCE_ARCHIVE_SCOPE_INVALID"
      );
      assertEvidenceArchiveOriginal(object, subject.originalBytes);
      check(!attempted.has(subject.exactKey), "EVIDENCE_ARCHIVE_PUT_ALREADY_ATTEMPTED");
      assertLive(session, deps.now);
      attempted.add(subject.exactKey);
      let result;
      const headers = {
        "x-oss-forbid-overwrite": "true",
        "x-oss-object-acl": "private",
        "x-oss-server-side-encryption": "AES256"
      };
      try {
        result = await writer.put(subject.exactKey, subject.originalBytes, {
          mime: "application/json",
          headers
        });
      } catch (error) {
        try {
          assertLive(session, deps.now);
        } catch {
          fail("EVIDENCE_ARCHIVE_WRITE_OUTCOME_UNKNOWN");
        }
        if (error?.status === 409 && ["FileAlreadyExists", "FileImmutable"].includes(error?.code))
          fail("EVIDENCE_ARCHIVE_OVERWRITE_REFUSED");
        fail("EVIDENCE_ARCHIVE_WRITE_OUTCOME_UNKNOWN");
      }
      let record;
      try {
        assertLive(session, deps.now);
        check(Buffer.isBuffer(result?.res?.data) && result.res.data.length === 0);
        record = safeResponse(
          "PutObject",
          result,
          result.res.data,
          subject.exactKey,
          session.arn,
          deps.now,
          headers
        );
        check(
          typeof record.response.headers.etag === "string" &&
            (record.response.headers["content-length"] === undefined ||
              record.response.headers["content-length"] === "0")
        );
        assertLive(session, deps.now);
      } catch {
        fail("EVIDENCE_ARCHIVE_WRITE_OUTCOME_UNKNOWN");
      }
      return Object.freeze({
        exactKey: subject.exactKey,
        contentDigest: object.contentDigest,
        contentSizeBytes: object.contentSizeBytes,
        requestId: record.response.headers["x-oss-request-id"],
        putObservation: { record, bodyBase64: "" }
      });
    }
  });
}

/** Independent exact-key reader; it never writes or establishes an authorization signature. */
export async function createEvidenceArchiveReaderTransport(input, lowLevelDependencies = {}) {
  assertKernelFrame(input, ["authorization", "session"], CODE);
  const captured = snapshotKernelData(input, CODE);
  const objects = scope(captured.authorization, "archive-readback-reader");
  const deps = dependencies(lowLevelDependencies),
    session = credential(captured.session, READER, captured.authorization, current(deps.now));
  assertDebugDisabled();
  const identityOriginal = await readSnapshotStsIdentity(
    { ...session, expiresAt: session.expiresAtMs },
    deps.now,
    deps.createStsClient
  );
  assertLive(session, deps.now);
  const reader = client(session, deps.createOssClient);
  check(
    ["request", "head", "get"].every((name) => typeof reader[name] === "function"),
    "EVIDENCE_ARCHIVE_CLIENT_INVALID"
  );
  return Object.freeze({
    identityOriginal,
    async readback(request) {
      assertKernelFrame(request, ["exactKey"], CODE);
      const { exactKey } = snapshotKernelData(request, CODE),
        object = objects.get(exactKey);
      check(object, "EVIDENCE_ARCHIVE_SCOPE_INVALID");
      assertLive(session, deps.now);
      const records = [],
        originals = [];
      const capture = (operation, result, body, key) => {
        const record = safeResponse(operation, result, body, key, session.arn, deps.now);
        records.push(record);
        originals.push(original(body), original(Buffer.from(canonicalJson(record))));
        return record;
      };
      const metadata = async (subres, key, operation, root) => {
        assertLive(session, deps.now);
        const result = await reader.request({
          method: "GET",
          bucket: BUCKET,
          ...(key ? { object: key } : {}),
          subres,
          successStatuses: [200],
          xmlResponse: false
        });
        assertLive(session, deps.now);
        const body = result?.res?.data,
          parsed = await parseXml(body, root);
        capture(operation, result, body, key ?? null);
        return parsed;
      };
      try {
        const bucketAcl = await metadata("acl", null, "GetBucketAcl", "AccessControlPolicy");
        check(aclPrivate(bucketAcl));
        const worm = await metadata("worm", null, "GetBucketWorm", "WormConfiguration");
        const observedWorm = wormFacts(worm);
        const versioning = await metadata(
          "versioning",
          null,
          "GetBucketVersioning",
          "VersioningConfiguration"
        );
        assertVersioningDisabled(versioning);
        assertLive(session, deps.now);
        const headResponse = await reader.head(exactKey);
        assertLive(session, deps.now);
        check(Buffer.isBuffer(headResponse?.res?.data) && headResponse.res.data.length === 0);
        const headRecord = capture("HeadObject", headResponse, headResponse.res.data, exactKey);
        const head = objectFacts(headRecord, object);
        check(Date.parse(worm.CreationDate) <= Date.parse(head.lastModified));
        const objectAcl = await metadata("acl", exactKey, "GetObjectAcl", "AccessControlPolicy");
        check(aclPrivate(objectAcl));
        assertLive(session, deps.now);
        const getResponse = await reader.get(exactKey);
        assertLive(session, deps.now);
        check(
          Buffer.isBuffer(getResponse?.res?.data) &&
            Buffer.isBuffer(getResponse.content) &&
            getResponse.content.equals(getResponse.res.data)
        );
        assertEvidenceArchiveOriginal(object, getResponse.content);
        const getRecord = capture("GetObject", getResponse, getResponse.res.data, exactKey);
        const get = objectFacts(getRecord, object);
        check(head.etag === get.etag && head.lastModified === get.lastModified);
        const observedAt = new Date(assertLive(session, deps.now)).toISOString();
        return Object.freeze({
          identityOriginal,
          bucket: {
            acl: "private",
            ownerId: ACCOUNT,
            versioning: "Disabled",
            worm: observedWorm
          },
          head,
          get,
          observedAt,
          evidence: { records, originals }
        });
      } catch {
        fail("EVIDENCE_ARCHIVE_READBACK_INVALID");
      }
    }
  });
}
