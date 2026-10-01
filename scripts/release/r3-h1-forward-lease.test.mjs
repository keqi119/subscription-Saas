import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";

const lease = await import("./r3-h1-forward-lease.mjs").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url?.endsWith("/r3-h1-forward-lease.mjs"))
    return null;
  throw error;
});

test("R3 FORWARD LEASE rejects caller-selected authority before native IO", async (t) => {
  assert.equal(typeof lease?.openR3H1ForwardLease, "function");
  let effects = 0;
  const denied = () => {
    effects++;
    throw new Error("unexpected native access");
  };
  for (const name of ["open", "lstat", "readFile", "writeFile"]) t.mock.method(fs, name, denied);
  t.mock.method(childProcess, "execFile", denied);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const input = { repoRoot: path.resolve("unused"), operationRef: randomUUID() };
  for (const extra of [
    { keyFile: "/tmp/keys" },
    { verified: true },
    { io: {} },
    { now: () => new Date().toISOString() }
  ])
    await assert.rejects(lease.openR3H1ForwardLease({ ...input, ...extra }), {
      code: "R3_H1_FORWARD_LEASE_UNAVAILABLE"
    });
  await assert.rejects(
    lease.openR3H1ForwardLease(
      Object.defineProperty({ ...input }, "operationRef", { get: denied, enumerable: true })
    ),
    {
      code: "R3_H1_FORWARD_LEASE_UNAVAILABLE"
    }
  );
  assert.equal(effects, 0);
});

async function shutdownFixture(t, { listener = false, uidProcess = false, hang = false } = {}) {
  const oldPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const oldGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 0 });
  const keyPath = "/etc/ssh/stage1-r3-forward/authorized_keys";
  const stat = (directory = false, size = 0n) => ({
    dev: 1n,
    ino: 42n,
    mode: directory ? 0o40755n : 0o100644n,
    uid: 0n,
    gid: 0n,
    nlink: 1n,
    size,
    mtimeNs: 1n,
    ctimeNs: 1n,
    rdev: 0n,
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false
  });
  const executable = { ...stat(false, 100n), mode: 0o100755n };
  const calls = [];
  const kills = [];
  let resolveHung;
  const hung = new Promise((resolve) => {
    resolveHung = resolve;
  });
  t.mock.method(fs, "lstat", async (file) => stat(String(file) !== keyPath));
  t.mock.method(fs, "realpath", async (file) => String(file));
  t.mock.method(fs, "stat", async (file) => {
    assert.ok(["/usr/bin/ss", "/usr/bin/pgrep"].includes(file));
    return executable;
  });
  t.mock.method(fs, "open", async (file) => {
    assert.equal(file, keyPath);
    return {
      stat: async () => stat(),
      read: async () => ({ bytesRead: 0 }),
      close: async () => {}
    };
  });
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 200 + calls.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => {
      kills.push(signal);
      return true;
    };
    if (hang && command === "/usr/bin/ss") resolveHung();
    else
      queueMicrotask(() => {
        const output =
          command === "/usr/bin/ss" && listener
            ? "LISTEN 0 1 127.0.0.1:55440\n"
            : command === "/usr/bin/pgrep" && uidProcess
              ? "1234\n"
              : "";
        if (output) child.stdout.emit("data", Buffer.from(output));
        child.emit("close", command === "/usr/bin/pgrep" && !uidProcess ? 1 : 0, null);
      });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", oldPlatform);
    if (oldGetuid) Object.defineProperty(process, "getuid", oldGetuid);
    else delete process.getuid;
  });
  return { calls, kills, hung };
}

test("R3 H1 shutdown observes empty key, no listeners, and no UID process", async (t) => {
  const f = await shutdownFixture(t);
  const result = await lease.observeR3H1ForwardShutdown();
  assert.equal(result.observation.status, "OBSERVED");
  assert.equal(result.observationDigest.startsWith("sha256:"), true);
  assert.deepEqual(
    f.calls.map((call) => [call.command, call.args]),
    [
      ["/usr/bin/ss", ["-H", "-ltn", "sport = :55440 or sport = :55441"]],
      ["/usr/bin/pgrep", ["-u", "994"]]
    ]
  );
  assert.equal(result.observation.processes[0].exitCode, 0);
  assert.equal(result.observation.processes[1].exitCode, 1);
  assert.equal(result.rawInputs.key.length, 0);
  assert.equal(
    lease.assessR3H1ForwardShutdown({
      observationBytes: encodeManualJson(result.observation),
      rawInputs: result.rawInputs,
      now: new Date(Date.now() + 1000).toISOString()
    }).status,
    "OBSERVED"
  );
  for (const change of [
    (observation) => {
      observation.processes[0].executable.mode = 0o100755;
    },
    (observation) => {
      observation.key.identity.ino = "-1";
    }
  ]) {
    const altered = structuredClone(result.observation);
    change(altered);
    assert.throws(
      () =>
        lease.assessR3H1ForwardShutdown({
          observationBytes: encodeManualJson(altered),
          rawInputs: result.rawInputs,
          now: new Date(Date.now() + 1000).toISOString()
        }),
      { code: "R3_H1_FORWARD_SHUTDOWN_UNVERIFIED" }
    );
  }
});

test("R3 H1 shutdown retains incomplete evidence for listener or UID process", async (t) => {
  await t.test("listener", async (sub) => {
    const f = await shutdownFixture(sub, { listener: true });
    await assert.rejects(lease.observeR3H1ForwardShutdown(), (error) => {
      assert.equal(error.observation.status, "INCOMPLETE");
      assert.ok(error.rawInputs["ss.stdout"].length > 0);
      return true;
    });
    assert.equal(f.calls.length, 1);
  });
  await t.test("UID process", async (sub) => {
    const f = await shutdownFixture(sub, { uidProcess: true });
    await assert.rejects(lease.observeR3H1ForwardShutdown(), (error) => {
      assert.equal(error.observation.status, "INCOMPLETE");
      assert.ok(error.rawInputs["pgrep.stdout"].length > 0);
      return true;
    });
    assert.equal(f.calls.length, 2);
  });
});

test("R3 H1 shutdown bounds a child without close and preserves incomplete PID", async (t) => {
  const f = await shutdownFixture(t, { hang: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = lease.observeR3H1ForwardShutdown();
  await f.hung;
  t.mock.timers.tick(10000);
  t.mock.timers.tick(2000);
  const error = await Promise.race([
    pending.then(
      () => null,
      (failure) => failure
    ),
    new Promise((resolve) => setImmediate(() => resolve(null)))
  ]);
  assert.equal(error?.observation?.status, "INCOMPLETE");
  assert.equal(error.observation.processes[0].pid, 201);
  assert.equal(error.observation.processes[0].closedAt, null);
  assert.deepEqual(f.kills, ["SIGKILL"]);
  assert.equal(f.calls.length, 1);
});
