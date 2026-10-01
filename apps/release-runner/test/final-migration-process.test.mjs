import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { prismaMigrateDeployArgs } from "../src/database-runtime-adapter.mjs";
import { createFinalMigrationProcessRunner } from "../src/final-migration-process.mjs";

const repoRoot = path.resolve("app-fixture");
const prisma = path.resolve(repoRoot, "apps/release-runner/node_modules/.bin/prisma");
const schema = path.resolve(repoRoot, "apps/api/prisma/schema.prisma");

function fakeChild(onKill = () => {}) {
  const child = new EventEmitter();
  child.pid = 2_000_000_000;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    onKill(signal, child);
    return true;
  };
  return child;
}

test("allows only fixed commands and records a real clean nonzero close without environment", async () => {
  const originals = [];
  const spawns = [];
  const child = fakeChild();
  const runner = createFinalMigrationProcessRunner({
    repoRoot,
    originals,
    spawnProcess(command, args, options) {
      spawns.push({ command, args, options });
      queueMicrotask(() => {
        child.stdout.write("diff found\n");
        child.stderr.write("details\n");
        child.emit("close", 2, null);
      });
      return child;
    }
  });
  await assert.rejects(runner("/bin/sh", ["-c", "true"], { environment: {} }), {
    code: "FINAL_MIGRATION_PROCESS_INVALID"
  });
  assert.equal(spawns.length, 0);
  const environment = { DATABASE_URL: "private" };
  const result = await runner(prisma, prismaMigrateDeployArgs({ schema, repoRoot }), {
    environment
  });
  assert.deepEqual(result, {
    exitCode: 2,
    signal: null,
    stdout: "diff found\n",
    stderr: "details\n"
  });
  assert.equal(spawns[0].options.shell, false);
  assert.equal(spawns[0].options.cwd, repoRoot);
  assert.equal(spawns[0].options.env, environment);
  assert.equal(originals.length, 1);
  assert.equal(originals[0].exitCode, 2);
  assert.equal(originals[0].closed, true);
  assert.equal(JSON.stringify(originals).includes("private"), false);
});

test("output above two MiB terminates and rejects with a bounded original", async () => {
  const originals = [];
  const kills = [];
  const child = fakeChild((signal, target) => {
    kills.push(signal);
    queueMicrotask(() => target.emit("close", null, signal));
  });
  const runner = createFinalMigrationProcessRunner({
    repoRoot,
    originals,
    spawnProcess: () => {
      queueMicrotask(() => child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 65)));
      return child;
    }
  });
  await assert.rejects(runner("psql", ["--version"], { environment: {} }), {
    code: "FINAL_MIGRATION_PROCESS_INVALID"
  });
  assert.deepEqual(kills, ["SIGTERM"]);
  assert.equal(originals[0].truncated, true);
  assert.ok(Buffer.byteLength(originals[0].stdout) <= 2 * 1024 * 1024);
});

test("retained output across calls stays within the 16 MiB total cap", async () => {
  const originals = [];
  let calls = 0;
  const runner = createFinalMigrationProcessRunner({
    repoRoot,
    originals,
    spawnProcess: () => {
      const child = fakeChild((signal, target) => {
        queueMicrotask(() => target.emit("close", null, signal));
      });
      const amount = ++calls <= 8 ? 2 * 1024 * 1024 : 1;
      queueMicrotask(() => {
        child.stdout.write(Buffer.alloc(amount, 65));
        if (calls <= 8) child.emit("close", 0, null);
      });
      return child;
    }
  });
  for (let index = 0; index < 8; index++) await runner("psql", ["--version"], { environment: {} });
  await assert.rejects(runner("psql", ["--version"], { environment: {} }), {
    code: "FINAL_MIGRATION_PROCESS_INVALID"
  });
  assert.equal(
    originals.reduce((sum, original) => sum + Buffer.byteLength(original.stdout), 0),
    16 * 1024 * 1024
  );
  assert.equal(originals.at(-1).truncated, true);
});

test("timeout with no close fails within the hard drain deadline and never invents an exit", async () => {
  const originals = [];
  const kills = [];
  const child = fakeChild((signal) => kills.push(signal));
  const runner = createFinalMigrationProcessRunner({
    repoRoot,
    originals,
    spawnProcess: () => child
  });
  const began = Date.now();
  await assert.rejects(runner("psql", ["--version"], { environment: {}, timeoutMs: 1 }), {
    code: "FINAL_MIGRATION_PROCESS_INVALID"
  });
  assert.ok(Date.now() - began < 5000);
  assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(originals[0].closed, false);
  assert.equal(originals[0].exitCode, null);
  assert.equal(originals[0].signal, null);
  assert.equal(originals[0].timedOut, true);
  await assert.rejects(runner.drain(), { code: "FINAL_MIGRATION_PROCESS_INVALID" });
});

test("drain waits for an aborted child to close before originals are snapshotted", async () => {
  const controller = new AbortController();
  const originals = [];
  const child = fakeChild((signal, target) => {
    setTimeout(() => target.emit("close", null, signal), 10);
  });
  const runner = createFinalMigrationProcessRunner({
    repoRoot,
    signal: controller.signal,
    originals,
    spawnProcess: () => child
  });
  const running = runner("psql", ["--version"], { environment: {} });
  controller.abort();
  const drained = runner.drain();
  await assert.rejects(running, { code: "FINAL_MIGRATION_PROCESS_INVALID" });
  await drained;
  assert.equal(originals.length, 1);
  assert.equal(originals[0].closed, true);
  assert.equal(originals[0].aborted, true);
  await assert.rejects(runner("psql", ["--version"], { environment: {} }), {
    code: "FINAL_MIGRATION_PROCESS_INVALID"
  });
});
