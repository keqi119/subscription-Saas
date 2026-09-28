// Internal native OSS read. The held source/snapshot session owns authority and lifetime.
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import { encodeManualJson } from "../../packages/release-foundation/src/index.mjs";
import {
  checkedPrivatePath,
  pinPrivateInput,
  readCapturedOssXml,
  sameIdentity,
  samePublicDirectory
} from "./manual-runner-source-inputs.mjs";

const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const requireOss = createRequire(requireApi.resolve("ali-oss"));
const BUCKET = "subscription-saas-stage1-snapshot-8fb45106fba9-cn-shanghai";
const ACCOUNT = "1457643390906675";
const ROLE = `acs:ram::${ACCOUNT}:role/subscription-saas-stage1-snapshot-consumer`;
const REGION = "oss-cn-shanghai";
const MAX_BYTES = 1073741824;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CODE = "R3_SNAPSHOT_PAYLOAD_UNAVAILABLE";

function fail() {
  throw Object.assign(new Error(CODE), { code: CODE });
}
function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && "value" in descriptor;
    })
  );
}
function requireThat(value) {
  if (!value) fail();
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function safeHeaders(value) {
  requireThat(value && typeof value === "object" && !Array.isArray(value));
  const result = {};
  for (const [name, content] of Object.entries(value)) {
    requireThat(
      /^[a-z0-9-]+$/u.test(name) &&
        typeof content === "string" &&
        content.length <= 2048 &&
        !/[\r\n\0]/u.test(content)
    );
    // Only the fixed nonsecret metadata needed for this readback crosses the boundary.
    if (
      [
        "date",
        "x-oss-request-id",
        "content-length",
        "last-modified",
        "etag",
        "x-oss-server-side-encryption",
        "content-type"
      ].includes(name)
    )
      result[name] = content;
  }
  return result;
}
function observed(result, expectedStatus = 200) {
  const status = result?.res?.status ?? result?.status;
  const headers = safeHeaders(result?.res?.headers);
  requireThat(
    status === expectedStatus &&
      result?.status !== 206 &&
      result?.status !== 304 &&
      typeof headers.date === "string" &&
      new Date(Date.parse(headers.date)).toUTCString() === headers.date &&
      typeof headers["x-oss-request-id"] === "string" &&
      /^[A-Za-z0-9-]+$/u.test(headers["x-oss-request-id"])
  );
  return freeze({ status, headers });
}
function objectHeaders(result, subject) {
  const evidence = observed(result);
  const h = result.res.headers;
  requireThat(
    h["content-range"] === undefined &&
      h["content-encoding"] === undefined &&
      h["x-oss-version-id"] === undefined &&
      h["x-oss-server-side-encryption"] === "AES256" &&
      h["content-length"] === String(subject.ciphertextSizeBytes) &&
      h.etag?.replace(/^"|"$/gu, "") === subject.etag &&
      typeof h["last-modified"] === "string" &&
      new Date(Date.parse(h["last-modified"])).toUTCString() === h["last-modified"] &&
      Date.parse(h["last-modified"]) === Date.parse(subject.lastModified)
  );
  return evidence;
}
function checkSubject(subject) {
  requireThat(
    exact(subject, [
      "bucket",
      "region",
      "key",
      "version",
      "etag",
      "ciphertextDigest",
      "ciphertextSizeBytes",
      "lastModified",
      "writerPrincipal"
    ]) && Object.isFrozen(subject)
  );
  requireThat(
    subject.bucket === BUCKET &&
      subject.region === REGION &&
      subject.version === "null-version-disabled" &&
      typeof subject.key === "string" &&
      subject.key.length <= 1024 &&
      /^snapshot-slots\/v2\/[^/*?]+\/[1-9][0-9]*\/snapshot\.enc$/u.test(subject.key) &&
      typeof subject.etag === "string" &&
      /^[A-Za-z0-9._-]{1,128}$/u.test(subject.etag) &&
      DIGEST.test(subject.ciphertextDigest) &&
      Number.isSafeInteger(subject.ciphertextSizeBytes) &&
      subject.ciphertextSizeBytes >= 1 &&
      subject.ciphertextSizeBytes <= MAX_BYTES &&
      typeof subject.lastModified === "string" &&
      Number.isFinite(Date.parse(subject.lastModified)) &&
      new Date(Date.parse(subject.lastModified)).toISOString() === subject.lastModified &&
      typeof subject.writerPrincipal === "string" &&
      subject.writerPrincipal.startsWith(`acs:ram::${ACCOUNT}:`)
  );
}
function checkSignal(signal) {
  requireThat(
    signal &&
      typeof signal === "object" &&
      typeof signal.addEventListener === "function" &&
      !signal.aborted
  );
}
function sameChain(left, right, privateRoot, changingDirectory = null) {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.path === right[index].path &&
        (item.path === privateRoot || item.path.startsWith(privateRoot + path.sep)
          ? sameIdentity(item.stat, right[index].stat, item.path !== changingDirectory)
          : samePublicDirectory(item.stat, right[index].stat))
    )
  );
}
async function stsCall(client, action, query, signal) {
  checkSignal(signal);
  const OpenApi = requireApi("@alicloud/openapi-client");
  const Util = createRequire(requireApi.resolve("@alicloud/openapi-client"))("@alicloud/tea-util");
  const result = await client.callApi(
    new OpenApi.Params({
      action,
      version: "2015-04-01",
      protocol: "HTTPS",
      pathname: "/",
      method: "POST",
      authType: "AK",
      bodyType: "json",
      reqBodyType: "formData",
      style: "RPC"
    }),
    new OpenApi.OpenApiRequest({ query }),
    new Util.RuntimeOptions({
      autoretry: false,
      maxAttempts: 1,
      connectTimeout: 10000,
      readTimeout: 30000
    })
  );
  checkSignal(signal);
  requireThat(
    result?.statusCode === 200 &&
      result.body &&
      typeof result.body === "object" &&
      typeof result.body.RequestId === "string" &&
      /^[A-Za-z0-9-]+$/u.test(result.body.RequestId)
  );
  return result.body;
}
async function currentIdentity(credentials, arn, signal) {
  const OpenApi = requireApi("@alicloud/openapi-client");
  const client = new OpenApi.default(
    new OpenApi.Config({
      accessKeyId: credentials.AccessKeyId,
      accessKeySecret: credentials.AccessKeySecret,
      securityToken: credentials.SecurityToken,
      endpoint: "sts.aliyuncs.com",
      protocol: "HTTPS",
      signatureAlgorithm: "v2"
    })
  );
  const body = await stsCall(client, "GetCallerIdentity", {}, signal);
  requireThat(body.AccountId === ACCOUNT && body.Arn === arn);
  return freeze({ AccountId: body.AccountId, Arn: body.Arn, RequestId: body.RequestId });
}
async function rawXml(result, root) {
  const raw = result?.data;
  requireThat(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 16384);
  return {
    source: new TextDecoder("utf-8", { fatal: true }).decode(raw),
    value: await readCapturedOssXml(raw, root)
  };
}
async function verifiedAcl(result) {
  const response = observed(result);
  const { source, value } = await rawXml(result, "AccessControlPolicy");
  requireThat(
    exact(value, ["Owner", "AccessControlList"]) &&
      value.Owner?.ID === ACCOUNT &&
      typeof value.Owner?.DisplayName === "string" &&
      value.AccessControlList?.Grant === "private"
  );
  return freeze({ ...response, acl: "private", ownerId: ACCOUNT, rawXml: source });
}
async function bucketReadback(client, signal) {
  checkSignal(signal);
  const acl = await client.request({
    method: "GET",
    bucket: BUCKET,
    subres: "acl",
    successStatuses: [200],
    xmlResponse: false
  });
  checkSignal(signal);
  const aclResponse = await verifiedAcl(acl);
  const worm = await client.request({
    method: "GET",
    bucket: BUCKET,
    subres: "worm",
    successStatuses: [200],
    xmlResponse: false
  });
  checkSignal(signal);
  const wormResponse = observed(worm);
  const wormRaw = await rawXml(worm, "WormConfiguration");
  requireThat(
    exact(wormRaw.value, ["WormId", "State", "RetentionPeriodInDays", "CreationDate"]) &&
      wormRaw.value.State === "Locked" &&
      wormRaw.value.RetentionPeriodInDays === "210" &&
      typeof wormRaw.value.WormId === "string" &&
      wormRaw.value.WormId.length > 0 &&
      Number.isFinite(Date.parse(wormRaw.value.CreationDate))
  );
  const version = await client.request({
    method: "GET",
    bucket: BUCKET,
    subres: "versioning",
    successStatuses: [200],
    xmlResponse: false
  });
  checkSignal(signal);
  const versionResponse = observed(version);
  requireThat(Buffer.isBuffer(version.data) && version.data.length <= 16384);
  const xml = requireOss("xml2js");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(version.data);
  requireThat(!/<!DOCTYPE|<!ENTITY/iu.test(source));
  const parsed = await xml.parseStringPromise(source, {
    explicitRoot: true,
    explicitArray: true,
    strict: true
  });
  requireThat(exact(parsed, ["VersioningConfiguration"]));
  const config = parsed.VersioningConfiguration;
  requireThat(
    (typeof config === "string" && config.trim() === "") ||
      (config &&
        typeof config === "object" &&
        !Array.isArray(config) &&
        Reflect.ownKeys(config).every((key) => ["$", "Status"].includes(key)) &&
        (config.$ === undefined ||
          (exact(config.$, ["xmlns"]) &&
            config.$.xmlns === "http://doc.oss-cn-hangzhou.aliyuncs.com")) &&
        (config.Status === undefined ||
          (Array.isArray(config.Status) && config.Status.length === 1 && config.Status[0] === "")))
  );
  return freeze({
    bucketAcl: aclResponse,
    worm: {
      ...wormResponse,
      state: wormRaw.value.State,
      days: wormRaw.value.RetentionPeriodInDays,
      wormId: wormRaw.value.WormId,
      creationDate: wormRaw.value.CreationDate,
      rawXml: wormRaw.source
    },
    versioning: { ...versionResponse, rawXml: source }
  });
}

export async function fetchR3SnapshotCiphertext(input) {
  let bootstrap, fileHandle, tempPath, tempIdentity, client, getStream;
  const closeOwned = async () => {
    if (typeof getStream?.destroy === "function") getStream.destroy();
    getStream = null;
    const results = await Promise.allSettled(
      [bootstrap?.close(), fileHandle?.close()].filter(Boolean)
    );
    bootstrap?.bytes.fill(0);
    bootstrap = null;
    fileHandle = null;
    client = null;
    if (tempPath) {
      try {
        const current = await fs.lstat(tempPath, { bigint: true });
        if (
          current.isFile() &&
          current.nlink === 1n &&
          tempIdentity &&
          sameIdentity(current, tempIdentity, false)
        )
          await fs.unlink(tempPath);
      } catch (error) {
        if (error?.code !== "ENOENT") fail();
      }
      tempPath = null;
    }
    if (results.some((result) => result.status === "rejected")) fail();
  };
  try {
    requireThat(
      process.platform === "linux" &&
        exact(input, ["profile", "operationRef", "subject", "recheck", "signal"]) &&
        UUID.test(input.operationRef) &&
        typeof input.recheck === "function"
    );
    const { profile, operationRef, subject, recheck, signal } = input;
    checkSignal(signal);
    checkSubject(subject);
    requireThat(
      profile &&
        typeof profile === "object" &&
        typeof profile.storage?.credentialRoot === "string" &&
        path.isAbsolute(profile.storage.credentialRoot) &&
        path.resolve(profile.storage.credentialRoot) === profile.storage.credentialRoot
    );
    // The installed ali-oss logger prints authorization and STS headers.
    requireThat(!requireOss("debug").enabled("ali-oss"));
    const principal = { platform: "posix", uid: process.getuid() };
    const privateRoot = profile.storage.credentialRoot;
    const options = { principal, privateRoot };
    const directory = path.join(privateRoot, "r3", operationRef, "consumer", "ciphertext");
    const target = path.join(directory, "snapshot.enc");
    await recheck();
    checkSignal(signal);
    const dirChain = await checkedPrivatePath(directory, { ...options, directory: true });
    requireThat((await fs.readdir(directory)).length === 0);
    bootstrap = await pinPrivateInput(
      path.join(privateRoot, "snapshot-reader", "bootstrap.json"),
      options,
      16384
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bootstrap.bytes);
    const boot = JSON.parse(decoded);
    requireThat(
      exact(boot, ["accessKeyId", "accessKeySecret"]) &&
        typeof boot.accessKeyId === "string" &&
        /^[A-Za-z0-9.]{4,128}$/u.test(boot.accessKeyId) &&
        typeof boot.accessKeySecret === "string" &&
        boot.accessKeySecret.length >= 4 &&
        boot.accessKeySecret.length <= 512 &&
        encodeManualJson(boot).equals(bootstrap.bytes)
    );
    const OpenApi = requireApi("@alicloud/openapi-client");
    const sts = new OpenApi.default(
      new OpenApi.Config({
        accessKeyId: boot.accessKeyId,
        accessKeySecret: boot.accessKeySecret,
        endpoint: "sts.aliyuncs.com",
        protocol: "HTTPS",
        signatureAlgorithm: "v2"
      })
    );
    const arn = `${ROLE}/s1r3-${operationRef}`;
    const assumed = await stsCall(
      sts,
      "AssumeRole",
      { RoleArn: ROLE, RoleSessionName: `s1r3-${operationRef}`, DurationSeconds: "900" },
      signal
    );
    const credentials = assumed.Credentials;
    const expires = Date.parse(credentials?.Expiration);
    requireThat(
      assumed.AssumedRoleUser?.Arn === arn &&
        arn !== subject.writerPrincipal &&
        subject.writerPrincipal !== ROLE &&
        !subject.writerPrincipal.startsWith(`${ROLE}/`) &&
        typeof credentials?.AccessKeyId === "string" &&
        /^STS\./u.test(credentials.AccessKeyId) &&
        typeof credentials?.AccessKeySecret === "string" &&
        credentials.AccessKeySecret.length > 0 &&
        typeof credentials?.SecurityToken === "string" &&
        credentials.SecurityToken.length > 0 &&
        Number.isFinite(expires) &&
        expires > Date.now() &&
        expires <= Date.now() + 960000
    );
    const beforeIdentity = await currentIdentity(credentials, arn, signal);
    const OSS = requireApi("ali-oss");
    client = new OSS({
      bucket: BUCKET,
      region: REGION,
      endpoint: "https://oss-cn-shanghai.aliyuncs.com",
      secure: true,
      authorizationV4: true,
      retryMax: 0,
      accessKeyId: credentials.AccessKeyId,
      accessKeySecret: credentials.AccessKeySecret,
      stsToken: credentials.SecurityToken,
      refreshSTSTokenInterval: 900000
    });
    const bucket = await bucketReadback(client, signal);
    const head = await client.head(subject.key);
    checkSignal(signal);
    const headResponse = objectHeaders(head, subject);
    const acl = await client.request({
      method: "GET",
      bucket: BUCKET,
      object: subject.key,
      subres: { acl: "" },
      successStatuses: [200],
      xmlResponse: false
    });
    checkSignal(signal);
    const aclResponse = await verifiedAcl(acl);
    const get = await client.getStream(subject.key);
    getStream = get?.stream;
    checkSignal(signal);
    const getResponse = objectHeaders(get, subject);
    requireThat(get.stream && typeof get.stream.pipe === "function");
    const currentDir = await checkedPrivatePath(directory, { ...options, directory: true });
    requireThat(
      sameChain(currentDir, dirChain, privateRoot) && (await fs.readdir(directory)).length === 0
    );
    tempPath = path.join(directory, `.snapshot-${randomUUID()}.tmp`);
    fileHandle = await fs.open(
      tempPath,
      fsNative.constants.O_CREAT |
        fsNative.constants.O_EXCL |
        fsNative.constants.O_WRONLY |
        fsNative.constants.O_NOFOLLOW,
      0o600
    );
    tempIdentity = await fileHandle.stat({ bigint: true });
    const hash = createHash("sha256");
    let count = 0;
    const counter = new Transform({
      transform(chunk, encoding, callback) {
        count += chunk.length;
        if (count > subject.ciphertextSizeBytes || count > MAX_BYTES)
          return callback(new Error(CODE));
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(get.stream, counter, fileHandle.createWriteStream(), { signal });
    getStream = null;
    fileHandle = null;
    checkSignal(signal);
    requireThat(
      count === subject.ciphertextSizeBytes &&
        `sha256:${hash.digest("hex")}` === subject.ciphertextDigest
    );
    fileHandle = await fs.open(
      tempPath,
      fsNative.constants.O_RDONLY | fsNative.constants.O_NOFOLLOW
    );
    requireThat(sameIdentity(await fileHandle.stat({ bigint: true }), tempIdentity, false));
    await fileHandle.sync();
    const afterIdentity = await currentIdentity(credentials, arn, signal);
    await bootstrap.recheck();
    const finalDir = await checkedPrivatePath(directory, { ...options, directory: true });
    requireThat(
      sameChain(finalDir, dirChain, privateRoot, directory) &&
        (await fs.readdir(directory)).length === 1 &&
        (await fs.readdir(directory))[0] === path.basename(tempPath)
    );
    const stagedStat = await fileHandle.stat({ bigint: true });
    requireThat(
      stagedStat.isFile() &&
        stagedStat.nlink === 1n &&
        stagedStat.size === BigInt(count) &&
        (stagedStat.mode & 0o777n) === 0o600n
    );
    await fs.link(tempPath, target);
    await fs.unlink(tempPath);
    tempPath = null;
    const dirHandle = await fs.open(
      directory,
      fsNative.constants.O_RDONLY | fsNative.constants.O_DIRECTORY | fsNative.constants.O_NOFOLLOW
    );
    try {
      requireThat(
        sameIdentity(
          await dirHandle.stat({ bigint: true }),
          (await checkedPrivatePath(directory, { ...options, directory: true })).at(-1).stat
        )
      );
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
    const publishedChain = await checkedPrivatePath(directory, { ...options, directory: true });
    requireThat(
      sameChain(publishedChain, dirChain, privateRoot, directory) &&
        (await fs.readdir(directory)).length === 1 &&
        (await fs.readdir(directory))[0] === "snapshot.enc"
    );
    const pinned = (await checkedPrivatePath(target, options)).at(-1).stat;
    requireThat(sameIdentity(pinned, await fileHandle.stat({ bigint: true })));
    await recheck();
    checkSignal(signal);
    requireThat(Date.now() < expires);
    const facts = freeze({
      path: target,
      ciphertextDigest: subject.ciphertextDigest,
      ciphertextSizeBytes: count,
      readerPrincipal: arn,
      identityExpiresAt: credentials.Expiration
    });
    const observations = freeze({
      beforeIdentity,
      afterIdentity,
      bucket,
      head: headResponse,
      objectAcl: aclResponse,
      get: getResponse
    });
    let closed = false;
    let closePromise;
    const openingReplays = new Set();
    const replayStreams = new Set();
    const recheckHeld = async () => {
      try {
        // STS bounds the authenticated download, not the lifetime of its pinned
        // local artifact. Later replays make no cloud call; the native holder
        // separately rechecks its session, revocations and destination authority.
        requireThat(!closed && !signal.aborted);
        await bootstrap.recheck();
        const currentDir = await checkedPrivatePath(directory, { ...options, directory: true });
        requireThat(sameChain(currentDir, publishedChain, privateRoot));
        const current = (await checkedPrivatePath(target, options)).at(-1).stat;
        requireThat(
          sameIdentity(current, pinned) &&
            sameIdentity(current, await fileHandle.stat({ bigint: true }))
        );
      } catch {
        fail();
      }
    };
    const openReplay = () => {
      const opening = (async () => {
        try {
          await recheckHeld();
          const handle = await fs.open(
            target,
            fsNative.constants.O_RDONLY | fsNative.constants.O_NOFOLLOW
          );
          try {
            requireThat(sameIdentity(await handle.stat({ bigint: true }), pinned));
            await recheckHeld();
            requireThat(!closed && !signal.aborted);
            const replay = handle.createReadStream({ autoClose: true });
            replayStreams.add(replay);
            replay.once("close", () => replayStreams.delete(replay));
            return replay;
          } catch {
            await handle.close();
            fail();
          }
        } catch {
          fail();
        }
      })();
      openingReplays.add(opening);
      opening.then(
        () => openingReplays.delete(opening),
        () => openingReplays.delete(opening)
      );
      return opening;
    };
    const closeReplay = () => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled([...openingReplays]);
        await Promise.allSettled(
          [...replayStreams].map(async (stream) => {
            if (stream.closed) return;
            const done = new Promise((resolve) => stream.once("close", resolve));
            stream.destroy();
            await done;
          })
        );
        await closeOwned();
      })();
      return closePromise;
    };
    return Object.freeze({
      facts,
      observations,
      source: Object.freeze({ open: openReplay }),
      recheck: recheckHeld,
      close: closeReplay
    });
  } catch {
    try {
      await closeOwned();
    } catch {
      /* fixed failure below */
    }
    fail();
  }
}
