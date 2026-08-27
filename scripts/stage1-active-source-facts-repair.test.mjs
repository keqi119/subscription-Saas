import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import test from "node:test";

const cli = await import("./stage1-active-source-facts-repair.mjs").catch(() => ({}));

function requiredExport(name) {
  assert.equal(typeof cli[name], "function", `${name} must be exported`);
  return cli[name];
}

test("apply confirmation requires the narrowly named exact value 1", () => {
  const validate = requiredExport("assertStage1ActiveSourceFactsRepairApplyConfirmation");

  assert.doesNotThrow(() => validate("dry-run", {}));
  assert.doesNotThrow(() => validate("apply", { STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_APPLY: "1" }));
  for (const env of [
    {},
    { STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_APPLY: "true" },
    { STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_APPLY: " 1 " },
    { GENERIC_APPLY: "1" }
  ]) {
    assert.throws(
      () => validate("apply", env),
      /STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_APPLY_CONFIRMATION_REQUIRED/
    );
  }
});

test("CLI awaits stdout, writes optional output, and returns blocker exit code", async () => {
  const writes = [];
  const prisma = { marker: "prisma" };
  const report = {
    applied: null,
    classification: {
      candidates: [],
      exceptions: [{ code: "CONTRACT_AUTHORITY_MISSING", orderId: "order-1" }],
      summary: {},
      unchanged: []
    },
    generatedAt: "2026-08-28T00:00:00.000Z",
    mode: "dry-run",
    safeToApply: false
  };
  let releaseStdout;
  let outputWritten = false;
  const pending = requiredExport("runStage1ActiveSourceFactsRepairCli")({
    args: ["--dry-run", "--output", "output/source-facts.json"],
    createPrisma: async () => prisma,
    env: {},
    execute: async (input) => {
      assert.deepEqual(input, { mode: "dry-run", prisma });
      return { exitCode: 1, report };
    },
    writeOutput: async (path, contents) => {
      outputWritten = true;
      writes.push([path, contents]);
    },
    writeStdout: () =>
      new Promise((resolve) => {
        releaseStdout = resolve;
      })
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outputWritten, false);
  releaseStdout();
  const exitCode = await pending;
  const json = `${JSON.stringify(report, null, 2)}\n`;
  assert.equal(exitCode, 1);
  assert.deepEqual(writes, [["output/source-facts.json", json]]);
});

test("stdout writer resolves after the stream callback and cleans error listeners", async () => {
  const writeStdout = requiredExport("writeStage1ActiveSourceFactsRepairStdout");
  let release;
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      release = callback;
    }
  });
  let completed = false;
  const pending = writeStdout("report\n", stream).then(() => {
    completed = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  release();
  await pending;
  assert.equal(completed, true);
  assert.equal(stream.listenerCount("error"), 0);
});

test("process failures and disconnect failures expose one credential-safe error", async () => {
  const runProcess = requiredExport("runStage1ActiveSourceFactsRepairProcess");
  const publicError = requiredExport("stage1ActiveSourceFactsRepairPublicError");
  const secret = "postgresql://secret-user:secret-password@prod.invalid/database";
  const stderr = [];
  let disconnects = 0;

  const exitCode = await runProcess({
    disconnect: async () => {
      disconnects += 1;
      throw new Error(`disconnect failed: ${secret}`);
    },
    run: async () => {
      throw new Error(`connect failed: ${secret}`);
    },
    writeStderr: (contents) => stderr.push(contents)
  });

  assert.equal(exitCode, 1);
  assert.equal(disconnects, 1);
  assert.deepEqual(publicError(new Error(secret)), {
    error: "STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_FAILED"
  });
  assert.deepEqual(stderr, [
    `${JSON.stringify({ error: "STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_FAILED" })}\n`
  ]);
  assert.doesNotMatch(stderr.join(""), /secret|password|postgresql|prod/);
});

test("package scripts expose dry-run, apply, and test entry points", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );

  assert.equal(
    packageJson.scripts["stage1:active-source-facts:dry-run"],
    "node scripts/stage1-active-source-facts-repair.mjs --dry-run"
  );
  assert.equal(
    packageJson.scripts["stage1:active-source-facts:apply"],
    "node scripts/stage1-active-source-facts-repair.mjs --apply"
  );
  assert.equal(
    packageJson.scripts["stage1:active-source-facts:test"],
    "node --test scripts/stage1-active-source-facts-repair-core.test.mjs scripts/stage1-active-source-facts-repair-executor.test.mjs scripts/stage1-active-source-facts-repair.test.mjs"
  );
});
