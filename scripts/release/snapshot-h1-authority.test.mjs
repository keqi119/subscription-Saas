import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { runH1AttemptAuthority } from "./snapshot-h1-authority.mjs";
import { readH1SnapshotProductionInputs } from "./snapshot-h1-signing.mjs";

test("private authority rejects caller paths, sessions and operations before protected reads", async () => {
  for (const input of [
    { operation: "shell", request: {} },
    { operation: "jwt", request: { path: "/tmp/key.pem" } },
    { operation: "prepare-dispatch-reader", request: { path: "/tmp/key.pem" } },
    { operation: "prepare-dispatch-reader", request: { durationSeconds: 900 } },
    { operation: "seal", request: { proof: {} } },
    { operation: "publish", request: {} },
    { operation: "seal-destruction", request: {} },
    { operation: "seal-destruction", request: { receipt: {} } },
    { operation: "snapshot-final-readback", request: { session: {} } },
    { operation: "seal-completion", request: { completion: {} } },
    { operation: "seal-producer-terminal", request: { now: "2099" } },
    { operation: "publish", request: { session: {} } },
    { operation: "archive-write", request: { authorizationDigest: "x" } },
    {
      operation: "archive-read",
      request: { authorizationDigest: "sha256:" + "1".repeat(64), session: {} }
    },
    { operation: "archive-seal-write", request: { proof: {} } },
    { operation: "admit", request: { selection: {}, approvalSelection: {}, session: {} } },
    {
      operation: "recheck",
      request: { admission: {}, producerAuthorizationDigest: "x", deploymentId: "1", now: "2099" }
    }
  ])
    await assert.rejects(runH1AttemptAuthority(input), { code: "H1_ATTEMPT_AUTHORITY_REJECTED" });
  await assert.rejects(readH1SnapshotProductionInputs({ path: "/tmp/inputs.json" }), {
    code: "H1_SNAPSHOT_SIGNING_REJECTED"
  });
});

test("prepare-dispatch-reader accepts only empty request and reaches fixed protected issuer", async () => {
  if (process.platform !== "win32") return;
  await assert.rejects(
    runH1AttemptAuthority({ operation: "prepare-dispatch-reader", request: {} }),
    { code: "H1_DISPATCH_READER_SESSION_REJECTED" }
  );
});

test("completion authority routes only fixed identity selectors to protected H1 inputs", async () => {
  if (process.platform !== "win32") return;
  for (const operation of ["snapshot-final-readback", "seal-completion", "seal-producer-terminal"])
    await assert.rejects(
      runH1AttemptAuthority({
        operation,
        request: {
          releaseAttemptId: "11111111-1111-4111-8111-111111111111",
          snapshotRunId: "123",
          ...(operation === "seal-producer-terminal"
            ? { archiveAuthorizationDigest: "sha256:" + "1".repeat(64) }
            : {})
        }
      }),
      { code: "H1_SNAPSHOT_SIGNING_REJECTED" }
    );
});

test("archive authority routes fixed selectors to protected H1 inputs without requiring dispatch", async () => {
  if (process.platform !== "win32") return;
  for (const operation of [
    "archive-write",
    "archive-read",
    "archive-seal-write",
    "archive-seal-read"
  ])
    await assert.rejects(
      runH1AttemptAuthority({
        operation,
        request: { authorizationDigest: "sha256:" + "1".repeat(64) }
      }),
      { code: "H1_SNAPSHOT_SIGNING_REJECTED" }
    );
});

test("private authority does not evaluate caller getters", async () => {
  let invoked = false;
  await assert.rejects(
    runH1AttemptAuthority({
      get operation() {
        invoked = true;
        return "jwt";
      },
      request: {}
    }),
    { code: "H1_ATTEMPT_AUTHORITY_REJECTED" }
  );
  assert.equal(invoked, false);
});
