import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { runR3StartupTiming, startR3StartupTiming } from "./r3-startup-detail-timing.mjs";

const operationRef = "11111111-1111-4111-8111-111111111111";

test("startup detail preserves result and error identity while reporting in-flight and terminal stages", async (t) => {
  const writes = [];
  mock.method(process.stderr, "write", (chunk) => {
    writes.push(String(chunk));
    return true;
  });
  t.after(() => mock.restoreAll());
  const value = { private: "never-log-this" };
  assert.equal(await runR3StartupTiming(operationRef, "SIGN_REQUEST", async () => value), value);
  const error = new Error("never-log-this");
  await assert.rejects(
    runR3StartupTiming(operationRef, "SIGN_HISTORY", async () => {
      throw error;
    }),
    (actual) => actual === error
  );
  const records = writes.map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map(({ stage, event }) => [stage, event]),
    [
      ["SIGN_REQUEST", "START"],
      ["SIGN_REQUEST", "SUCCEEDED"],
      ["SIGN_HISTORY", "START"],
      ["SIGN_HISTORY", "FAILED"]
    ]
  );
  assert.ok(
    records.every(
      (record) =>
        record.brand === "R3_STARTUP_DETAIL_TIMING" && record.operationRef === operationRef
    )
  );
  assert.ok(
    records.every(
      (record) =>
        JSON.stringify(Object.keys(record).sort()) ===
        JSON.stringify(["at", "brand", "durationMs", "event", "operationRef", "stage"])
    )
  );
  assert.ok(
    records.every(
      (record) =>
        Date.parse(record.at) > 0 &&
        (record.durationMs === null || Number.isSafeInteger(record.durationMs))
    )
  );
  assert.ok(writes.every((line) => !line.includes("never-log-this") && line.length <= 1024));
});

test("startup detail remains passive when output fails and rejects unlisted stages without output", async (t) => {
  const writes = [];
  mock.method(process.stderr, "write", (chunk) => {
    writes.push(String(chunk));
    throw new Error("write failed");
  });
  t.after(() => mock.restoreAll());
  const value = {};
  assert.equal(await runR3StartupTiming(operationRef, "SIGN_ACTIVE", () => value), value);
  const marker = startR3StartupTiming(operationRef, "SECRET_STAGE");
  marker.succeeded();
  assert.equal(writes.length, 2);
});

test("import reopen and recheck boundaries emit finite stage records", async (t) => {
  const writes = [];
  mock.method(process.stderr, "write", (chunk) => {
    writes.push(JSON.parse(String(chunk)));
    return true;
  });
  t.after(() => mock.restoreAll());
  for (const stage of ["IMPORT_SPEC_REOPEN", "IMPORT_SPEC_RECHECK", "IMPORT_ADMISSION_RECHECK"])
    await runR3StartupTiming(operationRef, stage, () => undefined);
  assert.deepEqual(
    writes.map(({ stage, event }) => [stage, event]),
    [
      ["IMPORT_SPEC_REOPEN", "START"],
      ["IMPORT_SPEC_REOPEN", "SUCCEEDED"],
      ["IMPORT_SPEC_RECHECK", "START"],
      ["IMPORT_SPEC_RECHECK", "SUCCEEDED"],
      ["IMPORT_ADMISSION_RECHECK", "START"],
      ["IMPORT_ADMISSION_RECHECK", "SUCCEEDED"]
    ]
  );
});

test("startup detail leaves an in-flight START record and caps total output", async (t) => {
  const writes = [];
  mock.method(process.stderr, "write", (chunk) => {
    writes.push(String(chunk));
    return true;
  });
  t.after(() => mock.restoreAll());
  let resolve;
  const pending = runR3StartupTiming(
    operationRef,
    "SIGN_CONTEXT",
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  assert.equal(JSON.parse(writes.at(-1)).event, "START");
  resolve("finished");
  assert.equal(await pending, "finished");
  for (let index = 0; index < 100; index++)
    await runR3StartupTiming(operationRef, "SIGN_PERSIST", () => index);
  assert.ok(writes.length <= 64);
  assert.ok(Buffer.byteLength(writes.join("")) <= 12288);
  assert.ok(writes.every((line) => Buffer.byteLength(line) <= 1024));
});
