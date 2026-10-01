// Test-only SDK network boundary for the internal native ciphertext fetch.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Readable } from "node:stream";

const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const OSS = requireApi("ali-oss");
const OpenApi = requireApi("@alicloud/openapi-client");
const ACCOUNT = "1457643390906675";
const ROLE = `acs:ram::${ACCOUNT}:role/subscription-saas-stage1-snapshot-consumer`;

export const r3SnapshotBootstrapFixture = Object.freeze({
  accessKeyId: "LTAIbootstrap",
  accessKeySecret: "bootstrap-secret"
});

export function installR3SnapshotSdkFixture(
  t,
  { operationRef, subject, bytes, identity, headHeaders = {}, getHeaders = {}, bucketAclXml = null }
) {
  assert.equal(typeof operationRef, "string");
  assert.equal(typeof subject?.key, "string");
  assert.ok(bytes instanceof Uint8Array);
  const arn = `${ROLE}/s1r3-${operationRef}`;
  const callerArn = `acs:ram::${ACCOUNT}:assumed-role/subscription-saas-stage1-snapshot-consumer/s1r3-${operationRef}`;
  const data = Buffer.from(bytes);
  const headers = () => ({
    date: new Date().toUTCString(),
    "x-oss-request-id": "REQUEST-123",
    "content-length": String(data.length),
    "last-modified": new Date(subject.lastModified).toUTCString(),
    etag: `"${subject.etag}"`,
    "x-oss-server-side-encryption": "AES256"
  });
  const response = (extra = {}) => ({
    res: {
      status: 200,
      headers: { ...headers(), ...extra }
    },
    status: 200
  });
  const aclXml = `<AccessControlPolicy><Owner><ID>${ACCOUNT}</ID><DisplayName>owner</DisplayName></Owner><AccessControlList><Grant>private</Grant></AccessControlList></AccessControlPolicy>`;
  const wormXml =
    "<WormConfiguration><WormId>worm-1</WormId><State>Locked</State><RetentionPeriodInDays>210</RetentionPeriodInDays><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></WormConfiguration>";
  const originals = {
    callApi: OpenApi.default.prototype.callApi,
    request: OSS.prototype.request,
    head: OSS.prototype.head,
    getStream: OSS.prototype.getStream
  };
  let identityCalls = 0;
  let lastStream;
  OpenApi.default.prototype.callApi = async function (params, request, runtime) {
    assert.equal(runtime.autoretry, false);
    assert.equal(runtime.maxAttempts, 1);
    if (params.action === "AssumeRole") {
      assert.equal(request.query.RoleArn, ROLE);
      assert.equal(request.query.RoleSessionName, `s1r3-${operationRef}`);
      assert.equal(request.query.DurationSeconds, "900");
      return {
        statusCode: 200,
        body: {
          RequestId: "STS-ASSUME-123",
          AssumedRoleUser: { Arn: arn },
          Credentials: {
            AccessKeyId: "STS.mock",
            AccessKeySecret: "sts-secret",
            SecurityToken: "sts-token",
            Expiration: new Date(Date.now() + 850000).toISOString()
          }
        }
      };
    }
    assert.equal(params.action, "GetCallerIdentity");
    identityCalls++;
    return {
      statusCode: 200,
      body: {
        RequestId: `STS-IDENTITY-${identityCalls}`,
        AccountId: ACCOUNT,
        Arn: identity ?? callerArn,
        IdentityType: "AssumedRoleUser"
      }
    };
  };
  OSS.prototype.request = async (params) => {
    assert.equal(params.bucket, subject.bucket);
    assert.equal(params.method, "GET");
    assert.equal(params.xmlResponse, false);
    assert.deepEqual(params.successStatuses, [200]);
    if (params.object === undefined) {
      assert.ok(["acl", "worm", "versioning"].includes(params.subres));
      const xml =
        params.subres === "acl"
          ? (bucketAclXml ?? aclXml)
          : params.subres === "worm"
            ? wormXml
            : "<VersioningConfiguration/>";
      return { ...response(), data: Buffer.from(xml) };
    }
    assert.equal(params.object, subject.key);
    assert.deepEqual(params.subres, { acl: "" });
    return { ...response(), data: Buffer.from(aclXml) };
  };
  OSS.prototype.head = async (key) => {
    assert.equal(key, subject.key);
    return response(headHeaders);
  };
  OSS.prototype.getStream = async (key) => {
    assert.equal(key, subject.key);
    lastStream = Readable.from([data]);
    return {
      stream: lastStream,
      res: { status: 200, headers: { ...headers(), ...getHeaders } }
    };
  };
  t.after(() => {
    for (const [name, original] of Object.entries(originals))
      (name === "callApi" ? OpenApi.default.prototype : OSS.prototype)[name] = original;
  });
  return Object.freeze({
    get identityCalls() {
      return identityCalls;
    },
    get lastStream() {
      return lastStream;
    }
  });
}
