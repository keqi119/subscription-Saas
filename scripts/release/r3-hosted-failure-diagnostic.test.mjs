import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("hosted failure projection retains bounded engine facts without private evidence", async () => {
  const { projectR3HostedFailure } = await import("./r3-hosted-failure-diagnostic.mjs");
  const privateText = "private-token-and-daemon-log";
  const cause = Object.assign(new Error(privateText), {
    code: "R3_HOSTED_CREATION_CONTROL_INVALID",
    failureDiagnostic: {
      schemaVersion: "r3-failure-diagnostic.v1",
      component: "HOSTED_CREATE",
      stage: "ENGINE",
      completed: false,
      causeCode: "R3_HOSTED_CREATION_CONTROL_INVALID",
      cleanupCode: null,
      sshExitCode: null,
      sshSignal: null
    },
    evidence: {
      engineAttempt: {
        checkpoint: "INFO_STORAGE",
        httpStatus: 503,
        pid: 1234,
        exit: { exitCode: 1, signal: null },
        logPath: `/secret/${privateText}`,
        command: privateText,
        rawRefs: {
          ping: { digest: `sha256:${"a".repeat(64)}`, bytes: 2 },
          unsafe: { digest: `sha256:${"b".repeat(64)}`, bytes: 999 }
        },
        containerdFailure: {
          code: "R3_CONTAINERD_OBSERVATION_INVALID",
          rawInputs: { cmdline: Buffer.from(privateText) }
        }
      },
      creatorFailure: {
        creation: { status: "INCOMPLETE", ownedPaths: [privateText] },
        rawInputs: { stderr: Buffer.from(privateText) }
      }
    }
  });
  const result = projectR3HostedFailure(cause);
  assert.equal(result.component, "HOSTED_CREATE");
  assert.equal(result.stage, "ENGINE");
  assert.equal(result.engineAttempt.pid, 1234);
  assert.equal(result.engineAttempt.checkpoint, "INFO_STORAGE");
  assert.equal(result.engineAttempt.httpStatus, 503);
  assert.equal(result.engineAttempt.rawRefs.ping.bytes, 2);
  assert.equal(result.engineAttempt.rawRefs.unsafe, undefined);
  assert.equal(result.creatorFailure.status, "INCOMPLETE");
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.equal(JSON.stringify(result).includes("logPath"), false);
  assert.equal(JSON.stringify(result).includes("stderr"), false);
  cause.evidence.engineAttempt.httpStatus = 999;
  cause.evidence.engineAttempt.checkpoint = privateText;
  const invalid = projectR3HostedFailure(cause);
  assert.equal(invalid.engineAttempt.httpStatus, null);
  assert.equal(invalid.engineAttempt.checkpoint, null);
});

test("hosted failure writer creates one fixed JSON without replacing it", async (t) => {
  const { writeR3HostedFailureDiagnostic } = await import("./r3-hosted-failure-diagnostic.mjs");
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "r3-hosted-failure-"));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  const cause = Object.assign(new Error("secret"), {
    code: "R3_HOSTED_CREATION_CONTROL_INVALID",
    failureDiagnostic: {
      component: "HOSTED_CREATE",
      stage: "ENGINE",
      causeCode: "R3_HOSTED_CREATION_CONTROL_INVALID"
    },
    evidence: { engineAttempt: { pid: 1234, rawRefs: {} } }
  });
  const first = await writeR3HostedFailureDiagnostic(repoRoot, cause);
  assert.equal(first.endsWith("engine-diagnostic.v1.json"), true);
  const raw = await fs.readFile(first);
  assert.equal(JSON.parse(raw).engineAttempt.pid, 1234);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.dirname(first))).mode & 0o777, 0o755);
    assert.equal((await fs.stat(first)).mode & 0o777, 0o644);
  }
  await assert.rejects(writeR3HostedFailureDiagnostic(repoRoot, cause), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(first), raw);
  if (process.platform !== "win32") {
    await fs.unlink(first);
    await fs.symlink(path.join(repoRoot, "target.json"), first);
    await assert.rejects(writeR3HostedFailureDiagnostic(repoRoot, cause), { code: "EEXIST" });
  }
});
