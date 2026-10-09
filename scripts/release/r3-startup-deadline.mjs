import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";

const state = new AsyncLocalStorage();
const STEP_NAMES = Object.freeze({
  "source:fresh": "Execute the held source fresh exchange through verified CLOSED",
  "source:snapshot": "Execute the held source snapshot exchange through verified CLOSED",
  "final:fresh": "Execute final migration, database tests, API and Web through verified CLOSED",
  "final:snapshot": "Execute final migration, database tests, API and Web through verified CLOSED"
});
const PHASES = Object.freeze([
  "evidence_gate",
  "session_ready",
  "lease_ready",
  "attempt_allocated",
  "sign_started",
  "authorization_persisted",
  "socket_connected"
]);
const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};

function decodeJob(rawJob) {
  if (!Buffer.isBuffer(rawJob) || rawJob.length < 1 || rawJob.length > 1048576)
    fail("R3_STARTUP_DEADLINE_INVALID");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawJob));
  } catch {
    fail("R3_STARTUP_DEADLINE_INVALID");
  }
}

export function createR3StartupDeadline({ rawJob, admission, operationRef }) {
  try {
    if (
      !admission ||
      !admission.ci ||
      typeof admission.expiresAt !== "string" ||
      !isoUtc.test(admission.expiresAt) ||
      !uuid.test(operationRef) ||
      !["source", "final"].includes(admission.phase) ||
      !["fresh", "snapshot"].includes(admission.chain) ||
      !/^[1-9][0-9]*$/u.test(admission.ci.runId) ||
      !/^[1-9][0-9]*$/u.test(admission.ci.jobId)
    )
      fail("R3_STARTUP_DEADLINE_INVALID");
    const job = decodeJob(rawJob),
      expectedName = STEP_NAMES[`${admission.phase}:${admission.chain}`];
    if (
      job.id !== Number(admission.ci.jobId) ||
      job.run_id !== Number(admission.ci.runId) ||
      job.name !== admission.ci.jobName ||
      !Array.isArray(job.steps)
    )
      fail("R3_STARTUP_DEADLINE_INVALID");
    const steps = job.steps.filter((step) => step?.name === expectedName);
    if (
      steps.length !== 1 ||
      !Number.isSafeInteger(steps[0].number) ||
      steps[0].number < 1 ||
      steps[0].status !== "in_progress" ||
      steps[0].conclusion !== null ||
      steps[0].completed_at !== null ||
      typeof steps[0].started_at !== "string" ||
      !isoUtc.test(steps[0].started_at)
    )
      fail("R3_STARTUP_DEADLINE_INVALID");
    if (job.steps.filter((step) => step?.number === steps[0].number).length !== 1)
      fail("R3_STARTUP_DEADLINE_INVALID");
    const started = Date.parse(steps[0].started_at),
      admissionExpires = Date.parse(admission.expiresAt),
      deadlineAtMs = Math.min(started + 600000, admissionExpires);
    if (
      !Number.isFinite(started) ||
      !Number.isFinite(admissionExpires) ||
      new Date(admissionExpires).toISOString().slice(0, 19) !== admission.expiresAt.slice(0, 19) ||
      new Date(started).toISOString().slice(0, 19) !== steps[0].started_at.slice(0, 19)
    )
      fail("R3_STARTUP_DEADLINE_INVALID");
    if (started > Date.now() || Date.now() >= deadlineAtMs) fail("R3_STARTUP_DEADLINE_EXCEEDED");
    return Object.freeze({
      deadlineAtMs,
      executeStartedAt: new Date(started).toISOString(),
      operationRef,
      runId: admission.ci.runId,
      jobId: admission.ci.jobId
    });
  } catch (error) {
    if (["R3_STARTUP_DEADLINE_INVALID", "R3_STARTUP_DEADLINE_EXCEEDED"].includes(error?.code))
      throw error;
    fail("R3_STARTUP_DEADLINE_INVALID");
  }
}

function sameBinding(left, right) {
  return (
    left.deadlineAtMs === right.deadlineAtMs &&
    left.executeStartedAt === right.executeStartedAt &&
    left.operationRef === right.operationRef &&
    left.runId === right.runId &&
    left.jobId === right.jobId
  );
}

function makeState(binding) {
  if (
    !binding ||
    !Number.isSafeInteger(binding.deadlineAtMs) ||
    typeof binding.executeStartedAt !== "string" ||
    !uuid.test(binding.operationRef) ||
    !/^[1-9][0-9]*$/u.test(binding.runId) ||
    !/^[1-9][0-9]*$/u.test(binding.jobId)
  )
    fail("R3_STARTUP_DEADLINE_INVALID");
  const wallRemaining = binding.deadlineAtMs - Date.now();
  if (wallRemaining <= 0) fail("R3_STARTUP_DEADLINE_EXCEEDED");
  const monoNow = performance.now();
  const context = {
    ...binding,
    abortController: new AbortController(),
    connected: false,
    emitted: false,
    reason: null,
    phaseMarks: new Map(),
    phaseSummaryEmitted: false,
    scopeEnteredAt: new Date().toISOString(),
    startedAtMonoMs: monoNow,
    deadlineAtMonoMs: monoNow + wallRemaining,
    timer: null,
    connectedWaiters: new Set()
  };
  const preciseRemaining = Math.min(
    context.deadlineAtMs - Date.now(),
    context.deadlineAtMonoMs - performance.now()
  );
  if (preciseRemaining <= 0) fail("R3_STARTUP_DEADLINE_EXCEEDED");
  const remaining = Math.ceil(preciseRemaining);
  context.timer = setTimeout(() => abortState(context, "R3_STARTUP_DEADLINE_EXCEEDED"), remaining);
  context.timer.unref?.();
  return context;
}

function abortState(context, reason) {
  if (context.connected || context.reason) return;
  context.reason = reason;
  context.abortController.abort(Object.assign(new Error(reason), { code: reason }));
}

function activeContext(explicit) {
  return explicit ?? state.getStore() ?? null;
}

export function currentR3StartupScope() {
  const context = state.getStore();
  if (!context) return null;
  return Object.freeze({
    deadlineAtMs: context.deadlineAtMs,
    executeStartedAt: context.executeStartedAt,
    operationRef: context.operationRef,
    runId: context.runId,
    jobId: context.jobId,
    signal: context.abortController.signal,
    connected: context.connected
  });
}

export function enterR3StartupDeadline(binding) {
  const previous = state.getStore();
  if (previous) {
    if (!sameBinding(previous, binding)) fail("R3_STARTUP_DEADLINE_INVALID");
    return { scope: previous, restore() {} };
  }
  const context = makeState(binding);
  state.enterWith(context);
  let restored = false;
  return {
    scope: context,
    restore() {
      if (restored) return;
      restored = true;
      clearTimeout(context.timer);
      state.enterWith(previous);
    }
  };
}

export async function runWithR3StartupDeadline(binding, action) {
  if (typeof action !== "function") fail("R3_STARTUP_DEADLINE_INVALID");
  const current = state.getStore();
  if (current) {
    if (!sameBinding(current, binding)) fail("R3_STARTUP_DEADLINE_INVALID");
    assertR3StartupActive();
    return action();
  }
  const context = makeState(binding);
  try {
    return await state.run(context, async () => {
      assertR3StartupActive();
      return action();
    });
  } finally {
    clearTimeout(context.timer);
  }
}

export function assertR3StartupActive(explicit) {
  const context = activeContext(explicit);
  if (!context || context.connected) return;
  if (
    !context.reason &&
    (Date.now() >= context.deadlineAtMs || performance.now() >= context.deadlineAtMonoMs)
  )
    abortState(context, "R3_STARTUP_DEADLINE_EXCEEDED");
  if (context.reason) fail(context.reason);
}

export function r3StartupRemainingMs(explicit) {
  const context = activeContext(explicit);
  if (!context || context.connected) return null;
  assertR3StartupActive(context);
  const preciseRemaining = Math.min(
    context.deadlineAtMs - Date.now(),
    context.deadlineAtMonoMs - performance.now()
  );
  if (preciseRemaining <= 0) {
    abortState(context, "R3_STARTUP_DEADLINE_EXCEEDED");
    fail("R3_STARTUP_DEADLINE_EXCEEDED");
  }
  return Math.ceil(preciseRemaining);
}

export function r3StartupAbortSignal(explicit) {
  const context = activeContext(explicit);
  return context && !context.connected ? context.abortController.signal : null;
}

export function cancelR3Startup(reason = "R3_STARTUP_CANCELLED", explicit) {
  if (!["R3_STARTUP_CANCELLED", "R3_STARTUP_DEADLINE_EXCEEDED"].includes(reason))
    fail("R3_STARTUP_DEADLINE_INVALID");
  const context = activeContext(explicit);
  if (context) abortState(context, reason);
}

export function recordR3StartupPhase(stage, explicit) {
  const context = activeContext(explicit);
  if (!context || context.connected || context.phaseSummaryEmitted || !PHASES.includes(stage))
    return false;
  if (context.phaseMarks.has(stage) || PHASES.indexOf(stage) !== context.phaseMarks.size)
    return false;
  context.phaseMarks.set(
    stage,
    Math.min(600000, Math.max(0, Math.floor(performance.now() - context.startedAtMonoMs)))
  );
  return true;
}

export function emitR3StartupPhaseSummary(explicit) {
  const context = activeContext(explicit);
  if (!context || context.phaseSummaryEmitted) return;
  context.phaseSummaryEmitted = true;
  const stages = PHASES.map((stage) => ({
    stage,
    elapsedMs: context.phaseMarks.get(stage) ?? null,
    completed: context.phaseMarks.has(stage)
  }));
  try {
    process.stderr.write(
      `${JSON.stringify({
        brand: "R3_STARTUP_PHASE_TIMING",
        operationRef: context.operationRef,
        runId: context.runId,
        jobId: context.jobId,
        elapsedOrigin: "scope_entered",
        scopeEnteredAt: context.scopeEnteredAt,
        executeStartedAt: context.executeStartedAt,
        deadlineAt: new Date(context.deadlineAtMs).toISOString(),
        stages
      })}\n`
    );
  } catch {}
}

export function waitR3StartupConnected() {
  const context = state.getStore();
  if (!context) fail("R3_STARTUP_DEADLINE_INVALID");
  if (context.connected) return Promise.resolve();
  assertR3StartupActive(context);
  return new Promise((resolve, reject) => {
    const settle = (error = null) => {
      context.connectedWaiters.delete(settle);
      context.abortController.signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () =>
      settle(
        Object.assign(new Error(context.reason ?? "R3_STARTUP_CANCELLED"), {
          code: context.reason ?? "R3_STARTUP_CANCELLED"
        })
      );
    context.connectedWaiters.add(settle);
    context.abortController.signal.addEventListener("abort", onAbort, { once: true });
    if (context.connected) settle();
    else if (context.abortController.signal.aborted) onAbort();
  });
}

export async function runR3StartupCleanup(action) {
  if (typeof action !== "function") fail("R3_STARTUP_DEADLINE_INVALID");
  return state.exit(action);
}

export function markR3StartupConnected(explicit) {
  const context = activeContext(explicit);
  if (!context) fail("R3_STARTUP_DEADLINE_INVALID");
  assertR3StartupActive(context);
  if (context.emitted) return;
  if (!context.phaseSummaryEmitted) {
    if (context.phaseMarks.size === PHASES.length - 1)
      context.phaseMarks.set(
        "socket_connected",
        Math.min(600000, Math.max(0, Math.floor(performance.now() - context.startedAtMonoMs)))
      );
    emitR3StartupPhaseSummary(context);
  }
  context.connected = true;
  context.emitted = true;
  clearTimeout(context.timer);
  for (const settle of [...context.connectedWaiters]) settle();
  process.stderr.write(
    `${JSON.stringify({
      brand: "R3_STARTUP_CONNECTED",
      operationRef: context.operationRef,
      runId: context.runId,
      jobId: context.jobId,
      executeStartedAt: context.executeStartedAt,
      connectedAt: new Date().toISOString()
    })}\n`
  );
}

export function settledR3StartupExecFile(file, args, options = {}) {
  const context = state.getStore(),
    remaining = context && !context.connected ? r3StartupRemainingMs(context) : null,
    requested = Number.isInteger(options.timeout) && options.timeout > 0 ? options.timeout : 60000,
    timeout = remaining === null ? requested : Math.max(1, Math.min(requested, remaining)),
    childOptions = { ...options, timeout };
  delete childOptions.signal;
  return new Promise((resolve, reject) => {
    let callbackDone = false,
      closed = false,
      result,
      killTimer,
      child;
    const forceStop = () => {
      if (!closed) child?.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        if (!closed) child?.kill("SIGKILL");
      }, 1000);
    };
    const onAbort = () => forceStop();
    const finish = () => {
      if (!callbackDone || !closed) return;
      clearTimeout(killTimer);
      context?.abortController.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    try {
      child = childProcess.execFile(file, args, childOptions, (error, stdout, stderr) => {
        result = { error, stdout, stderr };
        callbackDone = true;
        finish();
      });
      if (typeof child?.once !== "function") {
        child?.kill?.("SIGKILL");
        reject(
          Object.assign(new Error("R3_STARTUP_CHILD_CLOSE_UNAVAILABLE"), {
            code: "R3_STARTUP_CHILD_CLOSE_UNAVAILABLE"
          })
        );
        return;
      }
      child.once("close", () => {
        closed = true;
        finish();
      });
      if (context && !context.connected) {
        if (context.abortController.signal.aborted) onAbort();
        else context.abortController.signal.addEventListener("abort", onAbort, { once: true });
      }
    } catch (error) {
      reject(error);
    }
  });
}
