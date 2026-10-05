import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { TextDecoder } from "node:util";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";

const ACCOUNT = "1457643390906675";
const BUCKET = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const CODE = "SNAPSHOT_OSS_ORIGINALS_INVALID";
const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const HEADERS = [
  "date",
  "x-oss-request-id",
  "content-length",
  "content-type",
  "last-modified",
  "etag",
  "x-oss-server-side-encryption"
];
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const check = (value) => {
  if (!value) fail();
};
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

async function parseXml(body, name) {
  check(Buffer.isBuffer(body) && body.length > 0 && body.length <= 1048576);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
  check(!/<!DOCTYPE|<!ENTITY/iu.test(source));
  const xml2js = createRequire(requireApi.resolve("ali-oss"))("xml2js");
  const parsed = await xml2js.parseStringPromise(source, {
    explicitRoot: true,
    explicitArray: false,
    strict: true
  });
  check(exact(parsed, [name]));
  let value = parsed[name];
  if (value && typeof value === "object" && Object.hasOwn(value, "$")) {
    check(exact(value.$, ["xmlns"]) && value.$.xmlns === "http://doc.oss-cn-hangzhou.aliyuncs.com");
    value = { ...value };
    delete value.$;
  }
  return value;
}

function original(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length <= 1048576);
  return { digest: sha256Bytes(bytes), bytesBase64: bytes.toString("base64") };
}

// The caller supplies a fixed-slot expected object, verified STS ARN, and clock.
export async function readSnapshotOssOriginals(reader, expected, principal, now) {
  check(
    reader &&
      typeof reader.request === "function" &&
      typeof reader.head === "function" &&
      typeof reader.get === "function" &&
      exact(expected, ["key", "contentDigest", "sizeBytes"]) &&
      typeof expected.key === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(expected.contentDigest) &&
      Number.isSafeInteger(expected.sizeBytes) &&
      expected.sizeBytes > 0 &&
      typeof principal === "string" &&
      typeof now === "function"
  );
  expected = { ...expected };
  let previous = -Infinity;
  const time = () => {
    const value = now();
    check(value instanceof Date && Number.isFinite(value.getTime()) && value.getTime() >= previous);
    previous = value.getTime();
    return value.toISOString();
  };
  const records = {},
    originals = [];
  const capture = (name, operation, response, body, objectKey) => {
    const observedAt = time(),
      headers = response?.res?.headers,
      selected = {};
    check(
      response?.res?.status === 200 &&
        (response.status === undefined || response.status === 200) &&
        headers &&
        typeof headers === "object" &&
        !Array.isArray(headers) &&
        Buffer.isBuffer(body) &&
        (operation === "GetObject" || body.length <= 1048576) &&
        headers["content-range"] === undefined &&
        headers["content-encoding"] === undefined &&
        headers["x-oss-version-id"] === undefined
    );
    for (const key of HEADERS) {
      const value = headers[key];
      if (value !== undefined) {
        check(
          typeof value === "string" &&
            value.length > 0 &&
            value.length <= 2048 &&
            !/[\r\n\0]/u.test(value)
        );
        selected[key] = value;
      }
    }
    check(
      typeof selected["x-oss-request-id"] === "string" &&
        typeof selected.date === "string" &&
        Number.isFinite(Date.parse(selected.date)) &&
        Date.parse(selected.date) <= Date.parse(observedAt) &&
        (operation === "HeadObject" ||
          selected["content-length"] === undefined ||
          selected["content-length"] === String(body.length))
    );
    const record = {
      recordVersion: "r3-snapshot-oss-response.v1",
      operation,
      bucket: BUCKET,
      objectKey,
      principal,
      observedAt,
      requestHeaders: {},
      response: {
        status: response.res.status,
        headers: selected,
        body: { digest: sha256Bytes(body), bytes: body.length }
      }
    };
    records[name] = record;
    if (operation !== "GetObject") originals.push(original(body));
    originals.push(original(Buffer.from(canonicalJson(record))));
    return record;
  };
  const request = (subres, object) =>
    reader.request({
      method: "GET",
      bucket: BUCKET,
      ...(object ? { object } : {}),
      subres,
      successStatuses: [200],
      xmlResponse: false
    });
  const facts = (record) => {
    const h = record.response.headers;
    check(
      h["content-length"] === String(expected.sizeBytes) &&
        typeof h.etag === "string" &&
        Number.isFinite(Date.parse(h["last-modified"])) &&
        h["x-oss-server-side-encryption"] === "AES256" &&
        Date.parse(h["last-modified"]) <= Date.parse(record.observedAt)
    );
    return {
      key: expected.key,
      version: "null-version-disabled",
      etag: h.etag,
      digest: expected.contentDigest,
      sizeBytes: expected.sizeBytes,
      lastModified: new Date(h["last-modified"]).toISOString(),
      requestId: h["x-oss-request-id"]
    };
  };
  try {
    const bucketAclResponse = await request("acl");
    const bucketAclBody = bucketAclResponse?.res?.data;
    const bucketAcl = await parseXml(bucketAclBody, "AccessControlPolicy");
    check(
      exact(bucketAcl, ["Owner", "AccessControlList"]) &&
        exact(bucketAcl.Owner, ["ID", "DisplayName"]) &&
        bucketAcl.Owner.ID === ACCOUNT &&
        typeof bucketAcl.Owner.DisplayName === "string" &&
        exact(bucketAcl.AccessControlList, ["Grant"]) &&
        bucketAcl.AccessControlList.Grant === "private"
    );
    capture("bucketAcl", "GetBucketAcl", bucketAclResponse, bucketAclBody, null);

    const wormResponse = await request("worm");
    const wormBody = wormResponse?.res?.data;
    const worm = await parseXml(wormBody, "WormConfiguration");
    check(
      exact(worm, ["WormId", "State", "RetentionPeriodInDays", "CreationDate"]) &&
        typeof worm.WormId === "string" &&
        worm.WormId.length > 0 &&
        worm.State === "Locked" &&
        worm.RetentionPeriodInDays === "210" &&
        Number.isFinite(Date.parse(worm.CreationDate))
    );
    capture("worm", "GetBucketWorm", wormResponse, wormBody, null);

    const versionResponse = await request("versioning");
    const versionBody = versionResponse?.res?.data;
    const version = await parseXml(versionBody, "VersioningConfiguration");
    check(
      (typeof version === "string" && version.trim() === "") ||
        ((exact(version, []) || exact(version, ["Status"])) &&
          (version.Status === undefined || version.Status === ""))
    );
    capture("versioning", "GetBucketVersioning", versionResponse, versionBody, null);

    const headResponse = await reader.head(expected.key);
    const headBody = headResponse?.res?.data;
    check(Buffer.isBuffer(headBody) && headBody.length === 0);
    const headRecord = capture("head", "HeadObject", headResponse, headBody, expected.key);
    const head = facts(headRecord);
    check(Date.parse(worm.CreationDate) <= Date.parse(head.lastModified));

    const objectAclResponse = await request("acl", expected.key);
    const objectAclBody = objectAclResponse?.res?.data;
    const objectAcl = await parseXml(objectAclBody, "AccessControlPolicy");
    check(
      exact(objectAcl, ["Owner", "AccessControlList"]) &&
        exact(objectAcl.Owner, ["ID", "DisplayName"]) &&
        objectAcl.Owner.ID === ACCOUNT &&
        typeof objectAcl.Owner.DisplayName === "string" &&
        exact(objectAcl.AccessControlList, ["Grant"]) &&
        objectAcl.AccessControlList.Grant === "private"
    );
    capture("objectAcl", "GetObjectAcl", objectAclResponse, objectAclBody, expected.key);

    const getResponse = await reader.get(expected.key);
    const getBody = getResponse?.res?.data;
    check(
      Buffer.isBuffer(getBody) &&
        Buffer.isBuffer(getResponse.content) &&
        getBody.equals(getResponse.content) &&
        getBody.length === expected.sizeBytes &&
        sha256Bytes(getBody) === expected.contentDigest
    );
    const getRecord = capture("get", "GetObject", getResponse, getBody, expected.key);
    const get = facts(getRecord);
    check(head.etag === get.etag && head.lastModified === get.lastModified);
    const bucket = {
      acl: "private",
      ownerId: ACCOUNT,
      versioning: "Disabled",
      worm: {
        id: worm.WormId,
        state: "Locked",
        retentionDays: 210,
        creationDate: worm.CreationDate
      }
    };
    return { bucket, head, get, observedAt: time(), evidence: { records, originals } };
  } catch {
    fail();
  }
}

// Re-run the fixed OSS parser over retained response originals. No request is
// sent: the replay reader can return only the six captured responses in order.
export async function verifySnapshotOssOriginals({
  observation,
  expected,
  ciphertext,
  startedAt,
  observedAt
}) {
  try {
    const names = ["bucketAcl", "worm", "versioning", "head", "objectAcl", "get"];
    const operations = [
      "GetBucketAcl",
      "GetBucketWorm",
      "GetBucketVersioning",
      "HeadObject",
      "GetObjectAcl",
      "GetObject"
    ];
    const time = (value) => {
      check(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(value));
      const parsed = Date.parse(value);
      check(Number.isFinite(parsed));
      return parsed;
    };
    check(
      exact(observation, [
        "bucket",
        "head",
        "get",
        "observedAt",
        "evidence",
        "readerArn",
        "expectedWriterArn",
        "readerIdentityOriginal"
      ]) &&
        exact(observation.evidence, ["records", "originals"]) &&
        exact(expected, ["key", "contentDigest", "sizeBytes"]) &&
        /^snapshot-slots\/v2\/[^/*?]+\/[1-9][0-9]*\/snapshot\.enc$/u.test(expected.key) &&
        Buffer.isBuffer(ciphertext) &&
        ciphertext.length === expected.sizeBytes &&
        ciphertext.length > 0 &&
        ciphertext.length <= 134217728 &&
        sha256Bytes(ciphertext) === expected.contentDigest &&
        typeof observation.readerArn === "string" &&
        /^acs:ram::1457643390906675:assumed-role\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u.test(
          observation.readerArn
        ) &&
        typeof observation.expectedWriterArn === "string" &&
        /^acs:ram::1457643390906675:assumed-role\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u.test(
          observation.expectedWriterArn
        ) &&
        observation.readerArn !== observation.expectedWriterArn &&
        exact(observation.readerIdentityOriginal, [
          "AccountId",
          "Arn",
          "IdentityType",
          "RequestId"
        ]) &&
        observation.readerIdentityOriginal.AccountId === ACCOUNT &&
        observation.readerIdentityOriginal.Arn === observation.readerArn &&
        observation.readerIdentityOriginal.IdentityType === "AssumedRoleUser" &&
        typeof observation.readerIdentityOriginal.RequestId === "string" &&
        /^[A-Za-z0-9-]{1,256}$/u.test(observation.readerIdentityOriginal.RequestId) &&
        Array.isArray(observation.evidence.originals) &&
        observation.evidence.originals.length === 11 &&
        exact(observation.evidence.records, names)
    );
    const start = time(startedAt),
      end = time(observedAt),
      completed = time(observation.observedAt);
    check(start <= completed && completed <= end);
    const retained = observation.evidence.originals;
    const decode = (item) => {
      check(
        exact(item, ["digest", "bytesBase64"]) &&
          typeof item.bytesBase64 === "string" &&
          item.bytesBase64.length <= 1398104 &&
          /^sha256:[0-9a-f]{64}$/u.test(item.digest)
      );
      const bytes = Buffer.from(item.bytesBase64, "base64");
      check(
        bytes.length <= 1048576 &&
          bytes.toString("base64") === item.bytesBase64 &&
          sha256Bytes(bytes) === item.digest
      );
      return bytes;
    };
    const responses = [];
    const clock = [];
    let index = 0;
    for (const [position, name] of names.entries()) {
      const record = observation.evidence.records[name];
      check(
        exact(record, [
          "recordVersion",
          "operation",
          "bucket",
          "objectKey",
          "principal",
          "observedAt",
          "requestHeaders",
          "response"
        ])
      );
      const body = name === "get" ? ciphertext : decode(retained[index++]);
      const recordBytes = decode(retained[index++]);
      check(
        recordBytes.equals(Buffer.from(canonicalJson(record))) &&
          record.recordVersion === "r3-snapshot-oss-response.v1" &&
          record.operation === operations[position] &&
          record.bucket === BUCKET &&
          record.objectKey ===
            (["head", "objectAcl", "get"].includes(name) ? expected.key : null) &&
          record.principal === observation.readerArn &&
          exact(record.requestHeaders, []) &&
          exact(record.response, ["status", "headers", "body"]) &&
          exact(record.response.body, ["digest", "bytes"]) &&
          record.response.status === 200 &&
          record.response.body.digest === sha256Bytes(body) &&
          record.response.body.bytes === body.length
      );
      const at = time(record.observedAt);
      check(at >= start && at <= completed && (clock.length === 0 || at >= time(clock.at(-1))));
      clock.push(record.observedAt);
      responses.push({
        status: 200,
        content: body,
        res: { status: 200, data: body, headers: record.response.headers }
      });
    }
    check(index === retained.length && time(clock.at(-1)) <= completed);
    clock.push(observation.observedAt);
    let next = 0;
    const take = (position) => {
      check(next === position);
      return responses[next++];
    };
    const reader = {
      request(input) {
        const position = next;
        const subres = ["acl", "worm", "versioning", null, "acl", null][position];
        check(
          subres !== null &&
            exact(input, [
              "method",
              "bucket",
              "subres",
              "successStatuses",
              "xmlResponse",
              ...(position === 4 ? ["object"] : [])
            ]) &&
            input.method === "GET" &&
            input.bucket === BUCKET &&
            input.subres === subres &&
            input.xmlResponse === false &&
            input.successStatuses.length === 1 &&
            input.successStatuses[0] === 200 &&
            (position !== 4 || input.object === expected.key)
        );
        return take(position);
      },
      head(key) {
        check(key === expected.key);
        return take(3);
      },
      get(key) {
        check(key === expected.key);
        return take(5);
      }
    };
    let tick = 0;
    const replayed = await readSnapshotOssOriginals(
      reader,
      expected,
      observation.readerArn,
      () => new Date(clock[tick++])
    );
    check(next === 6 && tick === 7);
    for (const field of ["bucket", "head", "get", "observedAt", "evidence"])
      check(canonicalJson(replayed[field]) === canonicalJson(observation[field]));
    return observation;
  } catch {
    fail();
  }
}
