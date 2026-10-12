import test from "node:test";
import assert from "node:assert/strict";
import { withR3AttestationDiagnostic } from "./r3-attestation-diagnostic.mjs";

const digest = `sha256:${"a".repeat(64)}`;

test("attestation failure emits one bounded record and rethrows the same error", async () => {
  const failure = Object.assign(new Error("private token and path"), {
    code: 1,
    signal: "SIGTERM",
    stdout: "private stdout",
    stderr: "private stderr",
    path: "/private/path",
    argv: ["--token", "private"]
  });
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk) {
    writes.push(String(chunk));
    return true;
  };
  try {
    await assert.rejects(
      withR3AttestationDiagnostic(
        { kind: "proof", inputRawDigest: digest, operationRef: null },
        async () => {
          throw failure;
        }
      ),
      (caught) => caught === failure
    );
  } finally {
    process.stderr.write = original;
  }
  assert.equal(writes.length, 1);
  assert.equal(writes[0].endsWith("\n"), true);
  const record = JSON.parse(writes[0]);
  assert.equal(record.brand, "R3_ATTESTATION_FAILURE");
  assert.equal(record.diagnostic.kind, "proof");
  assert.equal(record.diagnostic.inputRawDigest, digest);
  assert.equal(record.diagnostic.childCode, 1);
  assert.equal(record.diagnostic.childSignal, "SIGTERM");
  assert.equal(/private|path|argv|stdout|stderr|token/.test(writes[0]), false);
});

test("successful action preserves its result without emitting diagnostics", async () => {
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk) {
    writes.push(String(chunk));
    return true;
  };
  try {
    assert.equal(
      await withR3AttestationDiagnostic(
        { kind: "receipt", inputRawDigest: digest, operationRef: null },
        async () => 42
      ),
      42
    );
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(writes, []);
});

test("binding and child metadata are restricted to exact safe values", async () => {
  let called = false;
  await assert.rejects(
    withR3AttestationDiagnostic(
      { kind: "historical-admission", inputRawDigest: digest, operationRef: null },
      async () => {
        called = true;
      }
    ),
    { name: "TypeError" }
  );
  assert.equal(called, false);
  const ref = "12345678-1234-4123-8123-123456789abc";
  const failure = Object.assign(new Error("private"), {
    code: "SECRET_CODE",
    signal: "SECRET_SIGNAL"
  });
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk) {
    writes.push(String(chunk));
    return true;
  };
  try {
    await assert.rejects(
      withR3AttestationDiagnostic(
        { kind: "historical-admission", inputRawDigest: digest, operationRef: ref },
        async () => {
          throw failure;
        }
      ),
      (caught) => caught === failure
    );
  } finally {
    process.stderr.write = original;
  }
  const record = JSON.parse(writes[0]).diagnostic;
  assert.equal(record.operationRef, ref);
  assert.equal(record.childCode, null);
  assert.equal(record.childSignal, null);
  assert.equal(writes[0].includes("SECRET"), false);
});
