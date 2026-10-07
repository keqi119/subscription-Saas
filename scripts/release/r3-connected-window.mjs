// The connected control socket is intentionally single-use. This internal scope
// bounds the work performed before its one POST without accepting caller clocks.
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import childProcess from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";
import { markR3FailureCause } from "./r3-failure-diagnostic.mjs";

const state = new AsyncLocalStorage();
const CODE = "R3_CONNECTED_WINDOW_EXHAUSTED";
const fail = (code = CODE) => {
  throw markR3FailureCause(Object.assign(new Error(code), { code }), code);
};

export async function withR3ConnectedWindow(socket, action) {
  const current = state.getStore();
  if (current) return action();
  if (!socket || socket.destroyed) fail("R3_CONNECTED_SOCKET_CLOSED");
  const abort = new globalThis.AbortController();
  const started = performance.now();
  const context = {
    started,
    signal: abort.signal,
    stopReason: null,
    timer: null
  };
  const stop = (reason) => {
    context.stopReason ??= reason;
    abort.abort();
  };
  const onClose = () => stop("R3_CONNECTED_SOCKET_CLOSED");
  socket.once("close", onClose);
  socket.once("error", onClose);
  context.timer = setTimeout(() => stop(CODE), 90000);
  try {
    return await state.run(context, action);
  } finally {
    clearTimeout(context.timer);
    socket.off("close", onClose);
    socket.off("error", onClose);
  }
}

function remaining(limit) {
  const current = state.getStore();
  if (!current) return null;
  if (current.stopReason) fail(current.stopReason);
  const left = Math.floor(current.started + limit - performance.now());
  if (left <= 0) fail();
  return left;
}

export function checkR3ConnectedWindow() {
  remaining(90000);
}

export function connectedChildTimeout(original) {
  const left = remaining(90000);
  return left === null ? original : Math.min(original, left);
}

export function connectedChildSignal() {
  return state.getStore()?.signal;
}

export function connectedStopReason() {
  return state.getStore()?.stopReason;
}

// execFile can call back on an abort error before the child emits close. A
// connected operation must not leave a verification subprocess behind.
export function settledR3ExecFile(file, args, options) {
  if (!state.getStore())
    return new Promise((resolve) => {
      childProcess.execFile(file, args, options, (error, stdout, stderr) =>
        resolve({ error, stdout, stderr })
      );
    });
  return new Promise((resolve, reject) => {
    let callbackResult,
      callbackDone = false,
      closed = false,
      killTimer,
      abortTimer,
      child;
    const signal = options.signal;
    const forceKill = () => {
      if (!closed) child?.kill("SIGKILL");
    };
    const onAbort = () => {
      abortTimer ??= setTimeout(forceKill, 1000);
    };
    const finish = () => {
      if (!callbackDone || !closed) return;
      clearTimeout(killTimer);
      clearTimeout(abortTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(callbackResult);
    };
    child = childProcess.execFile(file, args, options, (error, stdout, stderr) => {
      callbackResult = { error, stdout, stderr };
      callbackDone = true;
      finish();
    });
    if (typeof child.once !== "function") {
      reject(new TypeError("R3_CONNECTED_CHILD_CLOSE_UNAVAILABLE"));
      return;
    }
    child.once("close", () => {
      closed = true;
      finish();
    });
    if (!closed) killTimer = setTimeout(forceKill, options.timeout + 1000);
    if (!closed) {
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function connectedPostTimeout() {
  checkR3ConnectedWindow();
  const timeout = Math.min(15000, remaining(110000));
  const current = state.getStore();
  if (current) {
    clearTimeout(current.timer);
  }
  return timeout;
}
