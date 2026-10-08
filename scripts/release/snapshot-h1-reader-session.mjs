// Fixed, one-shot H1 dispatch reader session issuer. The protected parent owns
// inode disposal and expiry waiting; this module never rotates or retries STS.
import { Buffer } from "node:buffer";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import { assertH1KeyMemory, assertH1KeyVolume } from "./snapshot-h1-key-volume.mjs";

const CODE = "H1_DISPATCH_READER_SESSION_REJECTED";
const ROLE = "acs:ram::1457643390906675:role/subscription-saas-stage1-archive-reader";
export const READER_SESSION_PATHS = Object.freeze({
  main: "/var/lib/stage1-volumes/main",
  credential: "/var/lib/stage1-volumes/main/credential",
  reader: "/var/lib/stage1-volumes/main/credential/evidence-archive-reader",
  authority: "/var/lib/stage1-volumes/main/snapshot-authority",
  config: "/var/lib/stage1-volumes/main/credential/evidence-archive-reader/config.json",
  session: "/var/lib/stage1-volumes/main/snapshot-authority/reader-session.json"
});
const check = (ok) => {
  if (!ok) throw Error(CODE);
};
const mode = (stat) => stat.mode & 0o777;
const same = (a, b) =>
  ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeMs", "ctimeMs"].every(
    (key) => a[key] === b[key]
  );

async function protectedDefault() {
  await assertH1KeyVolume();
  assertH1KeyMemory();
}

async function assumeRoleDefault({
  accessKeyId,
  accessKeySecret,
  roleArn,
  sessionName,
  durationSeconds
}) {
  const requireApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
  const OpenApi = requireApi("@alicloud/openapi-client");
  const Util = createRequire(requireApi.resolve("@alicloud/openapi-client"))("@alicloud/tea-util");
  const client = new OpenApi.default(
    new OpenApi.Config({
      accessKeyId,
      accessKeySecret,
      endpoint: "sts.aliyuncs.com",
      protocol: "HTTPS",
      signatureAlgorithm: "v2"
    })
  );
  return client.callApi(
    new OpenApi.Params({
      action: "AssumeRole",
      version: "2015-04-01",
      protocol: "HTTPS",
      pathname: "/",
      method: "POST",
      authType: "AK",
      bodyType: "json",
      reqBodyType: "formData",
      style: "RPC"
    }),
    new OpenApi.OpenApiRequest({
      query: {
        RoleArn: roleArn,
        RoleSessionName: sessionName,
        DurationSeconds: String(durationSeconds)
      }
    }),
    new Util.RuntimeOptions({
      autoretry: false,
      maxAttempts: 1,
      connectTimeout: 10000,
      readTimeout: 30000
    })
  );
}

function issuer({ paths, io, assertProtected, assumeRole, randomBytes, now }) {
  const directory = (name) => {
    const stat = io.lstatSync(name);
    check(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === 0 &&
        stat.gid === 0 &&
        mode(stat) === 0o700
    );
    return stat;
  };
  const readConfig = (mainDev) => {
    const before = io.lstatSync(paths.config);
    check(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.uid === 0 &&
        before.gid === 0 &&
        before.nlink === 1 &&
        mode(before) === 0o600 &&
        before.dev === mainDev &&
        before.size > 0 &&
        before.size <= 2048
    );
    const fd = io.openSync(
      paths.config,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    let raw;
    try {
      check(same(before, io.fstatSync(fd)));
      raw = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < raw.length) {
        const count = io.readSync(fd, raw, offset, raw.length - offset, offset);
        check(count > 0);
        offset += count;
      }
      check(same(before, io.fstatSync(fd)) && same(before, io.lstatSync(paths.config)));
      const config = JSON.parse(raw.toString("utf8"));
      check(
        config &&
          Object.keys(config).sort().join(",") === "accessKeyId,accessKeySecret" &&
          /^[A-Za-z0-9.]{4,128}$/.test(config.accessKeyId) &&
          typeof config.accessKeySecret === "string" &&
          config.accessKeySecret.length >= 4 &&
          config.accessKeySecret.length <= 512
      );
      return config;
    } finally {
      raw?.fill(0);
      io.closeSync(fd);
    }
  };
  return async () => {
    try {
      await assertProtected();
      const main = directory(paths.main);
      for (const name of [paths.credential, paths.reader, paths.authority])
        check(directory(name).dev === main.dev);
      const config = readConfig(main.dev);
      try {
        io.lstatSync(paths.session);
        check(false);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const suffix = randomBytes(8).toString("hex");
      check(/^[a-f0-9]{16}$/.test(suffix));
      const sessionName = `h1-snapshot-reader-${suffix}`;
      const result = await assumeRole({
        ...config,
        roleArn: ROLE,
        sessionName,
        durationSeconds: 900
      });
      const issuedAt = new Date(now()).toISOString();
      const credentials = result?.body?.Credentials;
      const expires = credentials?.Expiration;
      const ttl = Date.parse(expires) - Date.parse(issuedAt);
      check(
        result?.statusCode === 200 &&
          /^[A-Za-z0-9-]{1,256}$/.test(result?.body?.RequestId) &&
          result?.body?.AssumedRoleUser?.Arn === `${ROLE}/${sessionName}` &&
          /^STS\.[A-Za-z0-9._-]+$/.test(credentials?.AccessKeyId) &&
          typeof credentials?.AccessKeySecret === "string" &&
          credentials.AccessKeySecret.length > 0 &&
          typeof credentials?.SecurityToken === "string" &&
          credentials.SecurityToken.length > 0 &&
          Number.isFinite(ttl) &&
          ttl >= 840000 &&
          ttl <= 900000
      );
      const session = {
        arn: result.body.AssumedRoleUser.Arn,
        accessKeyId: credentials.AccessKeyId,
        accessKeySecret: credentials.AccessKeySecret,
        stsToken: credentials.SecurityToken,
        issuedAt,
        expiresAt: new Date(Date.parse(expires)).toISOString()
      };
      const bytes = Buffer.from(canonicalJson(session));
      check(bytes.length > 0 && bytes.length <= 32768);
      const fd = io.openSync(
        paths.session,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600
      );
      let writtenStat;
      try {
        io.fchmodSync(fd, 0o600);
        let offset = 0;
        while (offset < bytes.length) {
          const count = io.writeSync(fd, bytes, offset, bytes.length - offset);
          check(count > 0);
          offset += count;
        }
        io.fsyncSync(fd);
        writtenStat = io.fstatSync(fd);
      } finally {
        io.closeSync(fd);
      }
      const dirfd = io.openSync(
        paths.authority,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      );
      try {
        io.fsyncSync(dirfd);
      } finally {
        io.closeSync(dirfd);
      }
      const installed = io.lstatSync(paths.session);
      check(
        installed.isFile() &&
          !installed.isSymbolicLink() &&
          installed.uid === 0 &&
          installed.gid === 0 &&
          installed.nlink === 1 &&
          mode(installed) === 0o600 &&
          installed.dev === main.dev &&
          installed.size === bytes.length &&
          same(writtenStat, installed)
      );
      const readfd = io.openSync(
        paths.session,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
      let readback;
      try {
        check(same(writtenStat, io.fstatSync(readfd)));
        readback = Buffer.alloc(bytes.length);
        let offset = 0;
        while (offset < readback.length) {
          const count = io.readSync(readfd, readback, offset, readback.length - offset, offset);
          check(count > 0);
          offset += count;
        }
        check(
          readback.equals(bytes) &&
            same(writtenStat, io.fstatSync(readfd)) &&
            same(writtenStat, io.lstatSync(paths.session))
        );
      } finally {
        readback?.fill(0);
        io.closeSync(readfd);
      }
      const sessionDigest = sha256Bytes(bytes);
      bytes.fill(0);
      return {
        status: "READER_SESSION_READY",
        issuedAt,
        expiresAt: session.expiresAt,
        sessionDigest
      };
    } catch {
      throw Object.assign(new Error(CODE), { code: CODE });
    }
  };
}

export function createH1DispatchReaderSessionIssuerForTest(dependencies) {
  return issuer({
    paths: READER_SESSION_PATHS,
    io: dependencies.io ?? fs,
    assertProtected: dependencies.assertProtected,
    assumeRole: dependencies.assumeRole,
    randomBytes: dependencies.randomBytes,
    now: dependencies.now
  });
}

export const prepareH1SnapshotDispatchReaderSession = issuer({
  paths: READER_SESSION_PATHS,
  io: fs,
  assertProtected: protectedDefault,
  assumeRole: assumeRoleDefault,
  randomBytes: cryptoRandomBytes,
  now: Date.now
});
