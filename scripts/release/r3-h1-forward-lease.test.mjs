import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

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
