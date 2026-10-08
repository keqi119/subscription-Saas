import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import {
  createR3StartupDeadline,
  runWithR3StartupDeadline,
  assertR3StartupActive,
  markR3StartupConnected,
  recordR3StartupPhase,
  cancelR3Startup,
  settledR3StartupExecFile,
  waitR3StartupConnected,
  currentR3StartupScope
} from "./r3-startup-deadline.mjs";

const operationRef = "54a88ca5-7e62-474a-b3c6-69f34eb6f420";
const ci = { runId: "37787742897", jobId: "113348580001" };
const stepName = (phase, chain) =>
  phase === "source"
    ? `Execute the held source ${chain} exchange through verified CLOSED`
    : "Execute final migration, database tests, API and Web through verified CLOSED";
const admissionFor = (phase = "source", chain = "fresh") => ({
  phase,
  chain,
  expiresAt: new Date(Date.now() + 1200000).toISOString(),
  ci: {
    ...ci,
    jobName: phase === "source" ? `source-${chain}` : `final-${chain} / execute`
  }
});
const jobBytes = (startedAt, name, admission, steps = undefined) =>
  Buffer.from(
    JSON.stringify({
      id: 113348580001,
      run_id: 37787742897,
      name: admission.ci.jobName,
      steps: steps ?? [
        {
          number: 9,
          name,
          status: "in_progress",
          conclusion: null,
          started_at: startedAt,
          completed_at: null
        }
      ]
    })
  );

test("R3 startup deadline binds each chain's exact live Execute step and job identity", () => {
  for (const [phase, chain] of [
    ["source", "fresh"],
    ["source", "snapshot"],
    ["final", "fresh"],
    ["final", "snapshot"]
  ]) {
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const admission = admissionFor(phase, chain);
    const deadline = createR3StartupDeadline({
      rawJob: jobBytes(startedAt, stepName(phase, chain), admission),
      admission,
      operationRef
    });

    assert.deepEqual(
      {
        operationRef: deadline.operationRef,
        runId: deadline.runId,
        jobId: deadline.jobId,
        executeStartedAt: deadline.executeStartedAt,
        deadlineAtMs: deadline.deadlineAtMs
      },
      {
        operationRef,
        runId: ci.runId,
        jobId: ci.jobId,
        executeStartedAt: startedAt,
        deadlineAtMs: Date.parse(startedAt) + 600000
      }
    );
  }
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const admission = {
    ...admissionFor(),
    expiresAt: new Date(Date.parse(startedAt) + 120000).toISOString()
  };
  assert.equal(
    createR3StartupDeadline({
      rawJob: jobBytes(startedAt, stepName("source", "fresh"), admission),
      admission,
      operationRef
    }).deadlineAtMs,
    Date.parse(admission.expiresAt)
  );
});

test("R3 startup deadline rejects invalid Execute evidence and survives a wall-clock rollback", async (t) => {
  const expired = new Date(Date.now() - 600001).toISOString();
  const admission = admissionFor();
  assert.throws(
    () =>
      createR3StartupDeadline({
        rawJob: jobBytes(expired, stepName("source", "fresh"), admission),
        admission,
        operationRef
      }),
    { code: "R3_STARTUP_DEADLINE_EXCEEDED" }
  );

  const live = new Date(Date.now() - 1000).toISOString();
  const step = JSON.parse(jobBytes(live, stepName("source", "fresh"), admission).toString())
    .steps[0];
  assert.throws(
    () =>
      createR3StartupDeadline({
        rawJob: jobBytes(live, stepName("source", "fresh"), admission, [
          step,
          { ...step, number: 10 }
        ]),
        admission,
        operationRef
      }),
    { code: "R3_STARTUP_DEADLINE_INVALID" }
  );
  assert.throws(
    () =>
      createR3StartupDeadline({
        rawJob: jobBytes(live, "Execute", admission, [{ ...step, name: "Execute" }]),
        admission,
        operationRef
      }),
    { code: "R3_STARTUP_DEADLINE_INVALID" }
  );

  const wallNow = Date.now(),
    monotonicAdmission = {
      ...admissionFor(),
      expiresAt: new Date(wallNow + 100).toISOString()
    },
    monotonicStarted = new Date(wallNow).toISOString(),
    monotonicDeadline = createR3StartupDeadline({
      rawJob: jobBytes(monotonicStarted, stepName("source", "fresh"), monotonicAdmission),
      admission: monotonicAdmission,
      operationRef
    });
  mock.method(Date, "now", () => wallNow);
  t.after(() => mock.restoreAll());
  await runWithR3StartupDeadline(monotonicDeadline, async () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    assert.throws(assertR3StartupActive, { code: "R3_STARTUP_DEADLINE_EXCEEDED" });
  });
});

test("R3 connected marker is emitted once only from an active verified startup scope", async (t) => {
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const admission = {
    ...admissionFor(),
    expiresAt: new Date(Date.now() + 100).toISOString()
  };
  const deadline = createR3StartupDeadline({
    rawJob: jobBytes(startedAt, stepName("source", "fresh"), admission),
    admission,
    operationRef
  });
  const writes = [];
  mock.method(process.stderr, "write", (chunk) => {
    writes.push(String(chunk));
    return true;
  });
  t.after(() => mock.restoreAll());

  await runWithR3StartupDeadline(deadline, async () => {
    assert.equal(currentR3StartupScope().operationRef, operationRef);
    assertR3StartupActive();
    const connected = waitR3StartupConnected();
    for (const stage of [
      "evidence_gate",
      "session_ready",
      "lease_ready",
      "attempt_allocated",
      "sign_started",
      "authorization_persisted"
    ])
      recordR3StartupPhase(stage);
    markR3StartupConnected();
    markR3StartupConnected();
    assert.equal(currentR3StartupScope().connected, true);
    await connected;
    await new Promise((resolve) => setTimeout(resolve, 130));
    assertR3StartupActive();
  });

  assert.equal(writes.length, 2);
  const timing = JSON.parse(writes[0]);
  assert.equal(timing.brand, "R3_STARTUP_PHASE_TIMING");
  assert.equal(timing.operationRef, operationRef);
  assert.equal(timing.stages.length, 7);
  assert.ok(timing.stages.every((stage) => stage.completed && Number.isInteger(stage.elapsedMs)));
  assert.ok(
    timing.stages.every(
      (stage, index, stages) => index === 0 || stages[index - 1].elapsedMs <= stage.elapsedMs
    )
  );
  const marker = JSON.parse(writes[1]);
  assert.deepEqual(Object.keys(marker).sort(), [
    "brand",
    "connectedAt",
    "executeStartedAt",
    "jobId",
    "operationRef",
    "runId"
  ]);
  assert.equal(marker.brand, "R3_STARTUP_CONNECTED");
  assert.equal(marker.operationRef, operationRef);
  assert.equal(marker.runId, ci.runId);
  assert.equal(marker.jobId, ci.jobId);
  assert.equal(marker.executeStartedAt, startedAt);
  assert.ok(Number.isFinite(Date.parse(marker.connectedAt)));
});

test("startup child abort waits for both exec callback and child close", async (t) => {
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const admission = admissionFor();
  const deadline = createR3StartupDeadline({
    rawJob: jobBytes(startedAt, stepName("source", "fresh"), admission),
    admission,
    operationRef
  });
  const child = new EventEmitter();
  child.kill = mock.fn(() => true);
  let callback;
  let receivedOptions;
  mock.method(childProcess, "execFile", (file, args, options, done) => {
    receivedOptions = options;
    callback = done;
    return child;
  });
  t.after(() => mock.restoreAll());

  await runWithR3StartupDeadline(deadline, async () => {
    const settled = settledR3StartupExecFile("/usr/bin/fake", ["check"], { timeout: 30000 });
    assert.ok(receivedOptions.timeout > 0 && receivedOptions.timeout <= 30000);
    await new Promise((resolve) => setImmediate(resolve));
    // The operation remains pending until the actual process close arrives.
    cancelR3Startup();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(child.kill.mock.callCount(), 1);
    let completed = false;
    settled.then(() => (completed = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    callback(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }), "", "");
    child.emit("close", null, "SIGKILL");
    const result = await settled;
    assert.equal(result.error.code, "ABORT_ERR");
  });
});
