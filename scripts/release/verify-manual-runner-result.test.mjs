import assert from "node:assert/strict";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

const verifier = await import("./verify-manual-runner-result.mjs").catch((error) => {
  if (
    error.code === "ERR_MODULE_NOT_FOUND" &&
    error.url?.endsWith("/verify-manual-runner-result.mjs")
  )
    return null;
  throw error;
});
const operationRef = "abcdefab-1111-4111-8111-abcdefabcdef";

test("manual result verifier accepts only the fixed operation selector before IO", async (t) => {
  assert.equal(typeof verifier?.verifyManualRunnerResult, "function");
  let io = 0,
    getters = 0;
  const deny = () => {
    io++;
    throw new Error("unexpected native IO");
  };
  for (const name of ["open", "readFile", "writeFile", "lstat", "readdir", "mkdir"])
    t.mock.method(fs, name, deny);
  for (const name of ["spawn", "execFile"]) t.mock.method(childProcess, name, deny);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const accessor = Object.defineProperty({}, "operationRef", {
    enumerable: true,
    get() {
      getters++;
      return operationRef;
    }
  });
  for (const input of [
    undefined,
    null,
    [],
    {},
    { operationRef: operationRef.toUpperCase() },
    { operationRef: "latest" },
    { operationRef: "/tmp/evidence.json" },
    { operationRef: "sha256:" + "a".repeat(64) },
    { operationRef, archiveRoot: "/tmp" },
    { operationRef, assessment: { executionStatus: "SUCCEEDED" } },
    { operationRef, runProcess: () => ({ exitCode: 0 }) },
    Object.create({ operationRef }),
    accessor
  ])
    await assert.rejects(verifier.verifyManualRunnerResult(input), {
      code: "MANUAL_RESULT_IDENTITY_MISMATCH"
    });
  assert.equal(io, 0);
  assert.equal(getters, 0);
});

test("manual result verifier refuses missing fixed H1 without writes or external execution", async (t) => {
  assert.equal(typeof verifier?.verifyManualRunnerResult, "function");
  let reads = 0,
    effects = 0;
  t.mock.method(fs, "lstat", async () => {
    reads++;
    throw Object.assign(new Error("fixed H1 unavailable"), { code: "ENOENT" });
  });
  const deny = () => {
    effects++;
    throw new Error("unexpected side effect");
  };
  for (const name of ["writeFile", "mkdir", "unlink", "rename"]) t.mock.method(fs, name, deny);
  for (const name of ["spawn", "execFile"]) t.mock.method(childProcess, name, deny);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(verifier.verifyManualRunnerResult({ operationRef }), {
    code: "MANUAL_RESULT_INCOMPLETE"
  });
  assert.ok(reads > 0);
  assert.equal(effects, 0);
});
