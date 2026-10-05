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
