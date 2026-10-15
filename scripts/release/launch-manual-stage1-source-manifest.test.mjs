import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { getR3FailureDiagnostic, r3FailureTracker } from "./r3-failure-diagnostic.mjs";

const launcher = fileURLToPath(new URL("./launch-manual-stage1.mjs", import.meta.url));

async function sourceManifestWith(boundary) {
  // Execute the real private entrypoint with only its external boundary replaced.
  const source = await readFile(launcher, "utf8");
  const begin = source.indexOf("  const runSourceManifest = async () => {");
  const end = source.indexOf("\n  const runLifecycle = async () => {", begin);
  assert.ok(begin >= 0 && end > begin);
  return vm.runInNewContext(`${source.slice(begin, end)}\nrunSourceManifest`, boundary);
}

function trustedFailure() {
  const cause = Object.assign(new Error("credential=do-not-report"), {
    code: "MANUAL_TIME_INVALID",
    credential: "do-not-report"
  });
  const tracker = r3FailureTracker("H1_CONSUME");
  tracker.enter("AUTHORIZATION");
  return tracker.decorate(cause, cause);
}

test("source manifest preserves trusted consume stage while redacting the cause", async () => {
  const cause = trustedFailure();
  const run = await sourceManifestWith({
    fs: { realpath: async () => "/repo" },
    repoRoot: "/repo",
    input: { repoRoot: "/repo" },
    consumeCandidateUse: async () => {
      throw cause;
    },
    code: "R3_TARGET_CREATE_UNAVAILABLE",
    r3FailureTracker
  });
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, "R3_TARGET_CREATE_UNAVAILABLE");
    assert.deepEqual(JSON.parse(JSON.stringify(getR3FailureDiagnostic(error))), {
      schemaVersion: "r3-failure-diagnostic.v1",
      component: "H1_CONSUME",
      stage: "AUTHORIZATION",
      completed: false,
      causeCode: "MANUAL_TIME_INVALID",
      cleanupCode: null,
      sshExitCode: null,
      sshSignal: null
    });
    assert.ok(!JSON.stringify(error).includes("do-not-report"));
    assert.ok(!String(error).includes("do-not-report"));
    return true;
  });
});

test("UNKNOWN manifest write failure does not mask the original diagnostic", async () => {
  const cause = trustedFailure();
  const writes = [];
  const run = await sourceManifestWith({
    fs: {
      realpath: async () => "/repo",
      readFile: async () => {
        throw cause;
      }
    },
    repoRoot: "/repo",
    input: { repoRoot: "/repo" },
    code: "R3_TARGET_CREATE_UNAVAILABLE",
    consumeCandidateUse: async () => {},
    recheckResources: async () => {},
    sourceStore: async (kind) => {
      writes.push(kind);
      if (kind === "manifest") throw new Error("manifest write failed");
      return "sha256:attempt";
    },
    fixed: { spec: { operationRef: "operation", sourceSha: "source" }, databaseTestManifest: {} },
    session: { sessionId: "session", sessionNonce: "nonce" },
    destinationRecord: { destinationDigest: "sha256:destination" },
    candidateUseRecord: { executionRecordDigest: "sha256:execution" },
    sha256Canonical: () => "sha256:manifest",
    path,
    r3FailureTracker
  });
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, "R3_TARGET_CREATE_UNAVAILABLE");
    assert.equal(getR3FailureDiagnostic(error)?.stage, "AUTHORIZATION");
    assert.equal(getR3FailureDiagnostic(error)?.causeCode, "MANUAL_TIME_INVALID");
    assert.equal(getR3FailureDiagnostic(error)?.cleanupCode, "UNCLASSIFIED");
    assert.ok(!JSON.stringify(error).includes("do-not-report"));
    return true;
  });
  assert.deepEqual(writes, ["attempt", "manifest"]);
});

test("source manifest still checks resources after consumption before starting tests", async () => {
  const events = [];
  const run = await sourceManifestWith({
    fs: { realpath: async () => "/repo" },
    repoRoot: "/repo",
    input: { repoRoot: "/repo" },
    code: "R3_TARGET_CREATE_UNAVAILABLE",
    consumeCandidateUse: async () => {
      events.push("consumed");
    },
    recheckResources: async () => {
      events.push("recheck");
      throw Object.assign(new Error("private resource changed"), {
        code: "MANUAL_BINDING_MISMATCH"
      });
    },
    sourceStore: async () => {
      events.push("attempt");
    },
    r3FailureTracker
  });
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, "R3_TARGET_CREATE_UNAVAILABLE");
    assert.equal(getR3FailureDiagnostic(error)?.causeCode, "MANUAL_BINDING_MISMATCH");
    return true;
  });
  assert.deepEqual(events, ["consumed", "recheck"]);
});
