import test from "node:test";
import assert from "node:assert/strict";
import { runR3SourceFreshH1, runR3SourceFreshHosted } from "./run-r3-source-fresh.mjs";
import { r3FailureTracker, getR3FailureDiagnostic } from "./r3-failure-diagnostic.mjs";
import * as diagnostics from "./r3-failure-diagnostic.mjs";
import * as launcher from "./launch-manual-stage1.mjs";

test("creation ACK archive failure keeps its exact boundary through caller wrapping", async () => {
  for (const [failAt, stage] of [
    [1, "ACK_RESPONSE"],
    [2, "ACK_BODY"]
  ]) {
    const saved = [],
      records = [];
    const archive = {
      raw: async (bytes) => {
        saved.push(Buffer.from(bytes));
        if (saved.length === failAt)
          throw Object.assign(new Error("private-archive-credential"), {
            code: "H1_INPUT_UNAVAILABLE"
          });
        return "private-archive-reference";
      }
    };
    await assert.rejects(
      async () => {
        try {
          await launcher.recordR3CreationAck(
            archive,
            { status: 202, headers: {}, body: Buffer.alloc(0) },
            records
          );
        } catch (cause) {
          throw r3FailureTracker("H1_CALLER").decorate(new Error("fixed"), cause);
        }
      },
      (error) => {
        const fact = getR3FailureDiagnostic(error);
        assert.equal(fact?.component, "H1_CREATE");
        assert.equal(fact?.stage, stage);
        assert.equal(fact?.causeCode, "H1_INPUT_UNAVAILABLE");
        assert.equal(fact?.completed, false);
        assert.equal(JSON.stringify(fact).includes("private-"), false);
        return true;
      }
    );
    assert.equal(saved.length, failAt);
    assert.deepEqual(records, []);
  }
});

test("creation ACK archives in order before validation and accepts only empty 202", async () => {
  for (const response of [
    { status: 202, headers: {}, body: Buffer.alloc(0) },
    { status: 200, headers: {}, body: Buffer.alloc(0) },
    { status: 202, headers: {}, body: Buffer.from("private-body") }
  ]) {
    const saved = [],
      records = [];
    const archive = {
      raw: async (bytes) => {
        saved.push(Buffer.from(bytes));
        return `raw-${saved.length}`;
      }
    };
    const outcome = launcher.recordR3CreationAck(archive, response, records);
    if (response.status === 202 && response.body.length === 0) await outcome;
    else
      await assert.rejects(outcome, (error) => {
        assert.equal(error.code, "R3_TARGET_CREATE_UNAVAILABLE");
        const fact = getR3FailureDiagnostic(error);
        assert.equal(fact?.stage, "ACK_VALIDATE");
        assert.equal(fact?.completed, false);
        assert.equal(JSON.stringify(fact).includes("private-"), false);
        return true;
      });
    assert.equal(saved.length, 2);
    assert.deepEqual(JSON.parse(saved[0]), { status: response.status, headers: {} });
    assert.deepEqual(saved[1], response.body);
    assert.deepEqual(records, [{ name: "creation-ack", response: "raw-1", body: "raw-2" }]);
  }
});

test("finally cleanup preserves the primary failure and attempts every closer", async () => {
  const tracker = r3FailureTracker("H1_CALLER");
  tracker.enter("CREATION");
  const primary = tracker.decorate(new Error("fixed"), { code: "ECONNRESET" });
  const closed = [];
  await assert.rejects(
    async () =>
      diagnostics.closeR3FailureResources(tracker, primary, [
        async () => {
          closed.push(1);
          throw Object.assign(new Error("secret"), { code: "EACCES" });
        },
        async () => {
          closed.push(2);
        }
      ]),
    (error) => {
      assert.equal(error.failureDiagnostic?.stage, "CREATION");
      assert.equal(error.failureDiagnostic?.causeCode, "ECONNRESET");
      assert.equal(error.failureDiagnostic?.cleanupCode, "EACCES");
      assert.equal(JSON.stringify(error).includes("secret"), false);
      return true;
    }
  );
  assert.deepEqual(closed, [1, 2]);
});

test("fixed callers preserve the failed boundary without publishing rejected input", async () => {
  const secret = "credential-must-not-appear-in-diagnostics";
  for (const [run, component] of [
    [runR3SourceFreshH1, "H1_CALLER"],
    [runR3SourceFreshHosted, "HOSTED_CALLER"]
  ]) {
    await assert.rejects(run({ secret }), (error) => {
      assert.equal(error.code, "R3_SOURCE_FRESH_CALLER_INVALID");
      assert.deepEqual(error.failureDiagnostic, {
        schemaVersion: "r3-failure-diagnostic.v1",
        component,
        stage: "INPUT",
        completed: false,
        causeCode: "R3_SOURCE_FRESH_CALLER_INVALID",
        cleanupCode: null,
        sshExitCode: null,
        sshSignal: null
      });
      assert.equal(JSON.stringify(error.failureDiagnostic).includes(secret), false);
      return true;
    });
  }
});

test("startup cutoff failures preserve only the fixed startup cause code", () => {
  const tracker = r3FailureTracker("H1_CREATE");
  tracker.enter("SIGN");
  const failure = tracker.decorate(
    new Error("fixed"),
    Object.assign(new Error("deadline"), { code: "R3_STARTUP_DEADLINE_EXCEEDED" })
  );
  assert.equal(getR3FailureDiagnostic(failure).causeCode, "R3_STARTUP_DEADLINE_EXCEEDED");
  assert.equal(JSON.stringify(getR3FailureDiagnostic(failure)).includes("deadline"), false);
});

test("consumption failure remains the primary boundary through cleanup and caller wrapping", async () => {
  const tracker = r3FailureTracker("H1_CREATE");
  let posted = false;
  let failure;
  try {
    await tracker.run("CONSUME", async () => {
      throw Object.assign(new Error("private request body"), { code: "MANUAL_SESSION_UNVERIFIED" });
    });
    posted = true;
  } catch (cause) {
    failure = tracker.decorate(new Error("fixed"), cause, { code: "EACCES" });
  }
  const wrapped = r3FailureTracker("H1_CALLER").decorate(new Error("fixed"), failure);
  assert.equal(posted, false);
  assert.deepEqual(getR3FailureDiagnostic(wrapped), {
    schemaVersion: "r3-failure-diagnostic.v1",
    component: "H1_CREATE",
    stage: "CONSUME",
    completed: false,
    causeCode: "MANUAL_SESSION_UNVERIFIED",
    cleanupCode: "EACCES",
    sshExitCode: null,
    sshSignal: null
  });
});

test("untrusted diagnostic fields, getters, messages and SSH output never become diagnostics", () => {
  const secret = "private-token-must-stay-private";
  const untrusted = { message: secret, stack: secret, failureDiagnostic: { stage: secret } };
  Object.defineProperty(untrusted, "code", {
    get() {
      throw new Error(secret);
    }
  });
  assert.equal(getR3FailureDiagnostic(untrusted), null);
  const tracker = r3FailureTracker("SSH_FORWARD");
  const failure = tracker.decorate(new Error("fixed"), untrusted, null, {
    code: 255,
    signal: "SIGTERM",
    stdout: secret,
    stderr: secret
  });
  assert.equal(failure.failureDiagnostic.causeCode, "UNCLASSIFIED");
  assert.equal(failure.failureDiagnostic.sshExitCode, 255);
  assert.equal(failure.failureDiagnostic.sshSignal, "SIGTERM");
  assert.equal(JSON.stringify(failure.failureDiagnostic).includes(secret), false);
  const rejected = tracker.decorate(new Error("fixed"), { code: secret }, null, {
    code: secret,
    signal: secret
  });
  assert.equal(rejected.failureDiagnostic.sshExitCode, null);
  assert.equal(rejected.failureDiagnostic.sshSignal, null);
  assert.equal(JSON.stringify(rejected.failureDiagnostic).includes(secret), false);
});

test("internal transport cause is finite and does not expose an error message", () => {
  const error = Object.assign(new Error("private request bytes"), {
    code: "R3_ENGINE_EXCHANGE_UNAVAILABLE"
  });
  diagnostics.markR3FailureCause(error, "R3_POST_RESPONSE_INCOMPLETE");
  diagnostics.markR3FailureCause(error, "R3_CONNECTED_SOCKET_CLOSED");
  const result = r3FailureTracker("H1_CREATE").decorate(new Error("fixed"), error);
  assert.equal(result.failureDiagnostic.causeCode, "R3_POST_RESPONSE_INCOMPLETE");
  assert.equal(JSON.stringify(result.failureDiagnostic).includes("private"), false);
  assert.throws(() => diagnostics.markR3FailureCause(error, "private"));
});

test("safe admission and history codes survive wrapping without exposing their messages", () => {
  for (const causeCode of [
    "R3_JOB_ADMISSION_UNAVAILABLE",
    "R3_HISTORY_CONTEXT_UNAVAILABLE",
    "MANUAL_EVIDENCE_INPUT_REQUIRED",
    "MANUAL_AUTHORIZATION_CONSUMED"
  ]) {
    const cause = Object.assign(new Error("private-job-response"), { code: causeCode });
    const error = diagnostics.inheritR3FailureCause(
      Object.assign(new Error("fixed"), { code: "H1_INPUT_UNAVAILABLE" }),
      cause
    );
    const wrapped = r3FailureTracker("H1_CREATE").decorate(new Error("fixed"), error);
    assert.equal(wrapped.failureDiagnostic.causeCode, causeCode);
    assert.equal(JSON.stringify(wrapped.failureDiagnostic).includes("private-job-response"), false);
  }
});

test("job admission classifies only finite command causes and retains an existing startup cause", () => {
  const secret = "private-gh-token-and-response";
  const command = Object.assign(new Error(secret), {
    code: 1,
    stdout: secret,
    stderr: secret,
    path: secret
  });
  diagnostics.markR3JobAdmissionCause(command, "R3_JOB_RUN_API_COMMAND_FAILED");
  const wrapped = diagnostics.inheritR3FailureCause(
    Object.assign(new Error("fixed"), { code: "R3_JOB_ADMISSION_UNAVAILABLE" }),
    command
  );
  const failure = r3FailureTracker("H1_CALLER").decorate(new Error("fixed"), wrapped);
  assert.equal(wrapped.code, "R3_JOB_ADMISSION_UNAVAILABLE");
  assert.equal(failure.failureDiagnostic.causeCode, "R3_JOB_RUN_API_COMMAND_FAILED");
  assert.equal(JSON.stringify(failure.failureDiagnostic).includes(secret), false);
  assert.throws(() => diagnostics.markR3JobAdmissionCause(command, secret));

  const deadline = Object.assign(new Error(secret), { code: "R3_STARTUP_DEADLINE_EXCEEDED" });
  diagnostics.markR3JobAdmissionCause(deadline, "R3_JOB_RUN_API_COMMAND_TIMEOUT");
  const preserved = r3FailureTracker("H1_CALLER").decorate(new Error("fixed"), deadline);
  assert.equal(preserved.failureDiagnostic.causeCode, "R3_STARTUP_DEADLINE_EXCEEDED");
});
