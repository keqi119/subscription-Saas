// Root-private transport for the two dispatch-verifier originals. This neither
// authorizes an operation nor signs a custody observation or a revocation head.
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { clearTimeout, setTimeout } from "node:timers";
import { TextDecoder } from "node:util";
import { URL } from "node:url";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import {
  assertKernelFrame,
  snapshotKernelData
} from "../../packages/release-foundation/src/snapshot/environment-policy.mjs";
import { captureDispatchEvidenceScope } from "./dispatch-evidence-scope.mjs";

const ACCOUNT = "1457643390906675";
const BUCKET = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const TIMEOUT = 10000;
const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const requireOss = (name) => createRequire(requireApi.resolve("ali-oss"))(name);
const fail = (suffix) => {
  throw Object.assign(new Error(`DISPATCH_ARCHIVE_${suffix}`), {
    code: `DISPATCH_ARCHIVE_${suffix}`
  });
};
const frame = (value, keys) => assertKernelFrame(value, keys, "DISPATCH_ARCHIVE_INPUT_INVALID");
const requireThat = (value, suffix = "READBACK_INVALID") => {
  if (!value) fail(suffix);
};
const date = (value) => {
  requireThat(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value),
    "TIME_INVALID"
  );
  const ms = Date.parse(value);
  requireThat(Number.isFinite(ms) && new Date(ms).toISOString() === value, "TIME_INVALID");
  return ms;
};
const successful = (value) =>
  value?.res?.status === 200 && (value.status === undefined || value.status === 200);
const requestId = (value) => {
  requireThat(successful(value));
  const id = value.res.headers?.["x-oss-request-id"];
  requireThat(typeof id === "string" && id.length > 0 && id.length <= 256);
  return id;
};

async function bucketFacts(call, reader) {
  const acl = await call(() => reader.getBucketACL(BUCKET));
  const worm = await call(() => reader.getBucketWorm(BUCKET));
  const encryption = await call(() => reader.getBucketEncryption(BUCKET));
  const get = (subres, xmlResponse) =>
    call(() =>
      reader.request({ method: "GET", bucket: BUCKET, subres, successStatuses: [200], xmlResponse })
    );
  const versioning = await get("versioning", false);
  const policy = await get("policyStatus", true);
  const publicAccess = await get("publicAccessBlock", true);
  const ids = {
    acl: requestId(acl),
    worm: requestId(worm),
    encryption: requestId(encryption),
    versioning: requestId(versioning),
    policy: requestId(policy),
    publicAccess: requestId(publicAccess)
  };
  requireThat(
    acl.acl === "private" &&
      acl.owner?.id === ACCOUNT &&
      worm.state === "Locked" &&
      worm.days === "210" &&
      typeof worm.wormId === "string" &&
      worm.wormId.length > 0 &&
      typeof worm.creationDate === "string" &&
      Number.isFinite(Date.parse(worm.creationDate)) &&
      encryption.encryption?.SSEAlgorithm === "AES256" &&
      policy.data?.IsPublic === "false" &&
      publicAccess.data?.BlockPublicAccess === "true",
    "BUCKET_INVALID"
  );
  requireThat(
    Buffer.isBuffer(versioning.data) && versioning.data.length <= 65536,
    "BUCKET_INVALID"
  );
  let document;
  try {
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(versioning.data);
    requireThat(!/<!DOCTYPE|<!ENTITY/i.test(xml), "BUCKET_INVALID");
    document = await requireOss("xml2js").parseStringPromise(xml, {
      explicitRoot: true,
      explicitArray: true,
      strict: true
    });
    frame(document, ["VersioningConfiguration"]);
    const root = document.VersioningConfiguration;
    if (typeof root === "string") requireThat(root.trim() === "", "BUCKET_INVALID");
    else {
      requireThat(
        root &&
          typeof root === "object" &&
          !Array.isArray(root) &&
          Object.keys(root).every((key) => ["$", "Status"].includes(key)),
        "BUCKET_INVALID"
      );
      if (root.$ !== undefined) {
        frame(root.$, ["xmlns"]);
        requireThat(root.$.xmlns === "http://doc.oss-cn-hangzhou.aliyuncs.com", "BUCKET_INVALID");
      }
      requireThat(
        root.Status === undefined ||
          (Array.isArray(root.Status) && root.Status.length === 1 && root.Status[0] === ""),
        "BUCKET_INVALID"
      );
    }
  } catch {
    fail("BUCKET_INVALID");
  }
  return {
    name: BUCKET,
    ownerId: ACCOUNT,
    acl: "private",
    versioning: "Disabled",
    encryption: "AES256",
    policyPublic: false,
    blockPublicAccess: true,
    requestIds: ids,
    worm: {
      id: worm.wormId,
      state: "Locked",
      retentionDays: 210,
      creationDate: new Date(worm.creationDate).toISOString()
    }
  };
}

function objectFacts(response, expected, at) {
  const id = requestId(response),
    h = response.res.headers;
  requireThat(
    h["content-length"] === String(expected.contentSizeBytes) &&
      typeof h.etag === "string" &&
      h.etag.length > 0 &&
      h["x-oss-version-id"] === undefined &&
      h["content-range"] === undefined &&
      h["content-encoding"] === undefined &&
      h["x-oss-server-side-encryption"] === "AES256" &&
      typeof h["last-modified"] === "string"
  );
  const modified = Date.parse(h["last-modified"]);
  requireThat(Number.isFinite(modified) && modified <= at);
  return { requestId: id, etag: h.etag, lastModified: new Date(modified).toISOString() };
}

async function readBounded(stream, size) {
  requireThat(
    stream &&
      typeof stream[Symbol.asyncIterator] === "function" &&
      typeof stream.destroy === "function"
  );
  const parts = [];
  let length = 0,
    timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stream.destroy(new Error("DISPATCH_ARCHIVE_READ_TIMEOUT"));
  }, TIMEOUT);
  try {
    for await (const chunk of stream) {
      requireThat(chunk instanceof Uint8Array);
      length += chunk.byteLength;
      requireThat(length <= size);
      parts.push(Buffer.from(chunk));
    }
    requireThat(!timedOut && length === size);
    return Buffer.concat(parts, length);
  } catch {
    fail("READBACK_INVALID");
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
}

export async function createDispatchEvidenceStorage(input, lowLevelDependencies = {}) {
  frame(input, ["profile", "originals", "session"]);
  const captured = snapshotKernelData(input, "DISPATCH_ARCHIVE_INPUT_INVALID");
  const { profile, session } = captured;
  requireThat(profile === "writer" || profile === "reader", "INPUT_INVALID");
  const scope = captureDispatchEvidenceScope({ originals: captured.originals });
  const allowed = new Map(scope.map((object) => [object.exactKey, object]));
  frame(session, ["arn", "accessKeyId", "accessKeySecret", "stsToken", "issuedAt", "expiresAt"]);
  frame(lowLevelDependencies, Object.keys(lowLevelDependencies));
  requireThat(
    Object.keys(lowLevelDependencies).every((key) => ["now", "createOssClient"].includes(key)),
    "INPUT_INVALID"
  );
  requireThat(
    lowLevelDependencies.now === undefined || typeof lowLevelDependencies.now === "function",
    "INPUT_INVALID"
  );
  requireThat(
    lowLevelDependencies.createOssClient === undefined ||
      typeof lowLevelDependencies.createOssClient === "function",
    "INPUT_INVALID"
  );
  const clock = lowLevelDependencies.now ?? (() => new Date());
  let lastTime = date(session.issuedAt);
  const expires = date(session.expiresAt);
  requireThat(
    expires > lastTime &&
      expires - lastTime <= 900000 &&
      typeof session.arn === "string" &&
      new RegExp(
        `^acs:ram::${ACCOUNT}:(?:assumed-role|role)/subscription-saas-stage1-archive-${profile}/[A-Za-z0-9_-]{2,64}$`
      ).test(session.arn) &&
      typeof session.accessKeyId === "string" &&
      /^STS\.[A-Za-z0-9._-]+$/.test(session.accessKeyId) &&
      typeof session.accessKeySecret === "string" &&
      session.accessKeySecret.length > 0 &&
      typeof session.stsToken === "string" &&
      session.stsToken.length > 0,
    "SESSION_INVALID"
  );
  const live = () => {
    const value = clock();
    requireThat(value instanceof Date && Number.isFinite(value.getTime()), "TIME_INVALID");
    const at = value.getTime();
    requireThat(at >= lastTime && at < expires, "SESSION_INVALID");
    lastTime = at;
    return at;
  };
  live();
  requireThat(!requireOss("debug").enabled("ali-oss"), "DEBUG_UNSAFE");
  let client;
  try {
    client = (
      lowLevelDependencies.createOssClient ?? ((options) => new (requireApi("ali-oss"))(options))
    )({
      bucket: BUCKET,
      region: "oss-cn-shanghai",
      endpoint: "https://oss-cn-shanghai.aliyuncs.com",
      secure: true,
      authorizationV4: true,
      retryMax: 0,
      timeout: TIMEOUT,
      accessKeyId: session.accessKeyId,
      accessKeySecret: session.accessKeySecret,
      stsToken: session.stsToken
    });
  } catch {
    fail("CLIENT_INVALID");
  }
  const methods =
    profile === "writer"
      ? ["put"]
      : [
          "getBucketACL",
          "getBucketWorm",
          "getBucketEncryption",
          "request",
          "getACL",
          "head",
          "getStream"
        ];
  requireThat(
    client && methods.every((method) => typeof client[method] === "function"),
    "CLIENT_INVALID"
  );
  const selection = (request) => {
    frame(request, ["exactKey"]);
    const selected = allowed.get(request.exactKey);
    requireThat(selected, "KEY_INVALID");
    return selected;
  };
  const used = new Set();
  if (profile === "writer")
    return Object.freeze({
      async createOnly(request) {
        const subject = selection(request);
        live();
        requireThat(!used.has(subject.exactKey), "WRITE_ALREADY_ATTEMPTED");
        used.add(subject.exactKey);
        let result;
        try {
          result = await client.put(subject.exactKey, Buffer.from(subject.originalBytes), {
            mime: "application/json",
            headers: {
              "x-oss-forbid-overwrite": "true",
              "x-oss-object-acl": "private",
              "x-oss-server-side-encryption": "AES256"
            }
          });
        } catch (error) {
          if (error?.status === 409 && ["FileAlreadyExists", "FileImmutable"].includes(error?.code))
            fail("OVERWRITE_REFUSED");
          fail("WRITE_UNKNOWN");
        }
        let id;
        try {
          live();
          id = requestId(result);
        } catch {
          fail("WRITE_UNKNOWN");
        }
        return Object.freeze({
          exactKey: subject.exactKey,
          contentDigest: subject.contentDigest,
          contentSizeBytes: subject.contentSizeBytes,
          requestId: id,
          completedAt: new Date(lastTime).toISOString()
        });
      }
    });
  const call = async (run) => {
    live();
    let result;
    try {
      result = await run();
      live();
      return result;
    } catch {
      result?.stream?.destroy();
      fail("READBACK_UNKNOWN");
    }
  };
  return Object.freeze({
    async readback(request) {
      const subject = selection(request);
      live();
      const bucket = await bucketFacts(call, client);
      const acl = await call(() => client.getACL(subject.exactKey));
      const aclRequestId = requestId(acl);
      requireThat(acl.acl === "private");
      const head = objectFacts(await call(() => client.head(subject.exactKey)), subject, live());
      const response = await call(() => client.getStream(subject.exactKey, { timeout: TIMEOUT }));
      let originalBytes, get;
      try {
        get = objectFacts(response, subject, live());
        originalBytes = await readBounded(response.stream, subject.contentSizeBytes);
        requireThat(
          head.etag === get.etag &&
            head.lastModified === get.lastModified &&
            sha256Bytes(originalBytes) === subject.contentDigest &&
            originalBytes.equals(subject.originalBytes)
        );
      } finally {
        response.stream?.destroy();
      }
      const readbackAt = new Date(live()).toISOString();
      requireThat(Date.parse(bucket.worm.creationDate) <= Date.parse(head.lastModified));
      return Object.freeze({
        originalBytes,
        bucket,
        readbackAt,
        readerArn: session.arn.replace(":role/", ":assumed-role/"),
        object: {
          exactKey: subject.exactKey,
          contentDigest: subject.contentDigest,
          contentSizeBytes: subject.contentSizeBytes,
          version: "null-version-disabled",
          acl: "private",
          encryption: "AES256",
          etag: head.etag,
          lastModified: head.lastModified,
          retainUntil: new Date(Date.parse(head.lastModified) + 210 * 86400000).toISOString(),
          requestIds: { head: head.requestId, get: get.requestId, acl: aclRequestId }
        }
      });
    }
  });
}
