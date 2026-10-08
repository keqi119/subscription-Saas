import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createH1DispatchReaderSessionIssuerForTest,
  READER_SESSION_PATHS
} from "./snapshot-h1-reader-session.mjs";

const key = "not-a-real-secret";
function fixture(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "h1-reader-session-"));
  const main = path.join(root, "main");
  const credential = path.join(main, "credential");
  const reader = path.join(credential, "evidence-archive-reader");
  const authority = path.join(main, "snapshot-authority");
  for (const dir of [main, credential, reader, authority]) mkdirSync(dir, { mode: 0o700 });
  const config = path.join(reader, "config.json");
  const session = path.join(authority, "reader-session.json");
  writeFileSync(config, JSON.stringify({ accessKeyId: "LTAIexample", accessKeySecret: key }), {
    mode: 0o600
  });
  const calls = [];
  let looseConfig = false;
  let beforeReadback;
  const mapped = new Map(
    Object.entries({ main, credential, reader, authority, config, session }).map(([name, file]) => [
      READER_SESSION_PATHS[name],
      file
    ])
  );
  const local = (file) => {
    assert.ok(mapped.has(file), `unexpected production path: ${file}`);
    return mapped.get(file);
  };
  const opened = new Map();
  const fakeStat = (stat, file) => ({
    ...stat,
    mode:
      (stat.mode & ~0o777) |
      (file === config && looseConfig ? 0o644 : stat.isDirectory() ? 0o700 : 0o600),
    uid: 0,
    gid: 0,
    isFile: () => stat.isFile(),
    isDirectory: () => stat.isDirectory(),
    isSymbolicLink: () => stat.isSymbolicLink()
  });
  const io = {
    ...fs,
    lstatSync: (file) => fakeStat(fs.lstatSync(local(file)), local(file)),
    fstatSync: (fd) => fakeStat(fs.fstatSync(fd), opened.get(fd)),
    openSync: (file, flags, mode) => {
      const resolved = local(file);
      if (resolved === authority) return -42;
      if (resolved === session && !(flags & fs.constants.O_WRONLY)) beforeReadback?.();
      const fd = fs.openSync(resolved, flags, mode);
      opened.set(fd, resolved);
      return fd;
    },
    fsyncSync: (fd) => (fd === -42 ? undefined : fs.fsyncSync(fd)),
    closeSync: (fd) => {
      if (fd !== -42) {
        opened.delete(fd);
        fs.closeSync(fd);
      }
    }
  };
  const now = Date.parse("2026-10-08T00:00:00.000Z");
  const issuer = createH1DispatchReaderSessionIssuerForTest({
    io,
    assertProtected: async () => {
      calls.push("protected");
    },
    now: () => now,
    randomBytes: () => Buffer.from("0123456789abcdef", "hex"),
    assumeRole: async (request) => {
      calls.push(request);
      return {
        statusCode: 200,
        body: {
          RequestId: "request-1",
          AssumedRoleUser: { Arn: `${request.roleArn}/${request.sessionName}` },
          Credentials: {
            AccessKeyId: "STS.EXAMPLE",
            AccessKeySecret: "sts-secret",
            SecurityToken: "sts-token",
            Expiration: new Date(now + 900000).toISOString()
          }
        }
      };
    },
    ...overrides
  });
  return {
    root,
    config,
    session,
    calls,
    issuer,
    setLooseConfig: () => {
      looseConfig = true;
    },
    beforeReadback: (callback) => {
      beforeReadback = callback;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test("production paths and role are fixed; protected issuer creates only private session and returns digest", async () => {
  assert.equal(
    READER_SESSION_PATHS.session,
    "/var/lib/stage1-volumes/main/snapshot-authority/reader-session.json"
  );
  assert.equal(
    READER_SESSION_PATHS.config,
    "/var/lib/stage1-volumes/main/credential/evidence-archive-reader/config.json"
  );
  const f = fixture();
  try {
    const result = await f.issuer();
    assert.deepEqual(Object.keys(result).sort(), [
      "expiresAt",
      "issuedAt",
      "sessionDigest",
      "status"
    ]);
    assert.equal(result.status, "READER_SESSION_READY");
    assert.match(result.sessionDigest, /^sha256:[a-f0-9]{64}$/);
    const actual = readFileSync(f.session);
    const session = JSON.parse(actual.toString("utf8"));
    assert.equal(
      result.sessionDigest,
      `sha256:${createHash("sha256").update(actual).digest("hex")}`
    );
    assert.equal(session.accessKeySecret, "sts-secret");
    assert.equal(f.calls[0], "protected");
    assert.equal(
      f.calls[1].roleArn,
      "acs:ram::1457643390906675:role/subscription-saas-stage1-archive-reader"
    );
    assert.equal(f.calls[1].durationSeconds, 900);
    assert.doesNotMatch(JSON.stringify(result), /secret|sts-token|LTAIexample/i);
  } finally {
    f.cleanup();
  }
});

test("preflight rejects existing target before STS and never overwrites", async () => {
  const f = fixture();
  try {
    writeFileSync(f.session, "previous", { mode: 0o600 });
    await assert.rejects(f.issuer(), { code: "H1_DISPATCH_READER_SESSION_REJECTED" });
    assert.equal(readFileSync(f.session, "utf8"), "previous");
    assert.deepEqual(f.calls, ["protected"]);
  } finally {
    f.cleanup();
  }
});

test("preflight rejects loose private configuration before STS", async () => {
  const f = fixture();
  try {
    f.setLooseConfig();
    await assert.rejects(f.issuer(), { code: "H1_DISPATCH_READER_SESSION_REJECTED" });
    assert.deepEqual(f.calls, ["protected"]);
  } finally {
    f.cleanup();
  }
});

test("readback rejects a same-byte path replacement after exclusive creation", async () => {
  const f = fixture();
  try {
    f.beforeReadback(() => {
      const bytes = readFileSync(f.session);
      fs.unlinkSync(f.session);
      writeFileSync(f.session, bytes, { mode: 0o600 });
    });
    await assert.rejects(f.issuer(), { code: "H1_DISPATCH_READER_SESSION_REJECTED" });
    assert.equal(f.calls.length, 2);
  } finally {
    f.cleanup();
  }
});

test("invalid TTL and unknown issuance produce no session or credential output", async () => {
  let unknownCalls = 0;
  for (const assumeRole of [
    async (request) => ({
      statusCode: 200,
      body: {
        RequestId: "request-1",
        AssumedRoleUser: { Arn: `${request.roleArn}/${request.sessionName}` },
        Credentials: {
          AccessKeyId: "STS.EXAMPLE",
          AccessKeySecret: "sts-secret",
          SecurityToken: "sts-token",
          Expiration: "2026-10-08T00:13:00.000Z"
        }
      }
    }),
    async () => {
      unknownCalls += 1;
      throw new Error("sts-secret");
    }
  ]) {
    const f = fixture({ assumeRole });
    try {
      await assert.rejects(
        f.issuer(),
        (error) =>
          error.code === "H1_DISPATCH_READER_SESSION_REJECTED" &&
          !JSON.stringify(error).includes("sts-secret")
      );
      assert.throws(() => readFileSync(f.session));
    } finally {
      f.cleanup();
    }
  }
  assert.equal(unknownCalls, 1);
});
