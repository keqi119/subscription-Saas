// Fixed, non-TTY Docker attach transport. Session admission and container-exit
// observation belong to the caller; a closed socket is never proof of exit.
import http from "node:http";
import { PassThrough } from "node:stream";

const CODE = "R3_ENGINE_ATTACH_UNAVAILABLE";
const FRAME_LIMIT = 2 * 1024 * 1024;
const STREAM_LIMIT = 64 * 1024 * 1024;
const HANDSHAKE_MS = 15_000;
const OVERALL_MS = 45 * 60_000;
const CLOSE_MS = 1_000;
const ID = /^[0-9a-f]{64}$/u;
const failure = (cause) => {
  const error = Object.assign(new Error(CODE), { code: CODE });
  if (cause) Object.defineProperty(error, "cause", { value: cause });
  return error;
};

export function openR3EngineAttach({ containerId, signal }) {
  return openR3EngineAttachWithRequest({ containerId, signal }, http.request);
}

// Internal request injection for bounded protocol tests; endpoint/options stay fixed.
export function openR3EngineAttachWithRequest({ containerId, signal }, requestFactory) {
  if (!ID.test(containerId) || signal?.aborted || typeof requestFactory !== "function")
    throw failure();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const startedAt = new Date().toISOString();
  let request;
  let socket;
  let upgraded = false;
  let ended = false;
  let closing = false;
  let settled = false;
  let closeCause;
  let headerTimer;
  let overallTimer;
  let closeTimer;
  let receivedBytes = 0;
  let sentBytes = 0;
  let frames = 0;
  let pending = Buffer.alloc(0);
  let remaining = null;
  let output;
  let waitingDrain = false;
  const outgoing = [];

  let resolveCompleted;
  let rejectCompleted;
  let resolveReady;
  let rejectReady;
  let readySettled = false;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  completed.catch(() => {});
  const finishReady = (cause) => {
    if (readySettled) return;
    readySettled = true;
    if (cause) rejectReady(failure(cause));
    else resolveReady();
  };

  const finish = (cause) => {
    if (settled) return;
    settled = true;
    finishReady(cause ?? failure());
    clearTimeout(headerTimer);
    clearTimeout(overallTimer);
    clearTimeout(closeTimer);
    signal?.removeEventListener("abort", onAbort);
    stdin.destroy();
    stdout.end();
    stderr.end();
    if (cause) rejectCompleted(failure(cause));
    else
      resolveCompleted(
        Object.freeze({
          status: closing ? "CLOSED" : "STREAM_ENDED",
          startedAt,
          finishedAt: new Date().toISOString(),
          frames,
          receivedBytes,
          sentBytes,
          socketClosed: upgraded && socket?.destroyed === true
        })
      );
  };
  const destroy = (cause, explicit = false) => {
    if (settled || closing) return;
    closing = true;
    closeCause = cause;
    if (explicit) closeCause = undefined;
    finishReady(closeCause ?? failure());
    closeTimer = setTimeout(() => finish(closeCause ?? failure()), CLOSE_MS);
    socket?.destroy();
    request?.destroy();
  };
  const onAbort = () => destroy(failure());
  const malformed = () => destroy(failure());

  const pump = () => {
    if (settled || closing || waitingDrain) return;
    while (pending.length) {
      if (remaining === null) {
        if (pending.length < 8) break;
        const stream = pending[0];
        const size = pending.readUInt32BE(4);
        if (
          (stream !== 1 && stream !== 2) ||
          pending[1] !== 0 ||
          pending[2] !== 0 ||
          pending[3] !== 0 ||
          size > FRAME_LIMIT ||
          receivedBytes + size > STREAM_LIMIT
        )
          return malformed();
        pending = pending.subarray(8);
        remaining = size;
        output = stream === 1 ? stdout : stderr;
        receivedBytes += size;
        if (remaining === 0) {
          frames++;
          remaining = null;
          continue;
        }
      }
      if (!pending.length) break;
      const count = Math.min(remaining, pending.length);
      const piece = pending.subarray(0, count);
      pending = pending.subarray(count);
      remaining -= count;
      if (remaining === 0) {
        frames++;
        remaining = null;
      }
      if (!output.write(piece)) {
        waitingDrain = true;
        socket.pause();
        output.once("drain", () => {
          waitingDrain = false;
          pump();
          if (!waitingDrain && !closing) socket.resume();
        });
        break;
      }
    }
  };
  const ingest = (chunk) => {
    if (settled || closing) return;
    if (!Buffer.isBuffer(chunk) || pending.length + chunk.length > STREAM_LIMIT + 8)
      return malformed();
    pending = Buffer.concat([pending, chunk]);
    pump();
  };
  const flushStdin = () => {
    if (!upgraded || closing || settled) return;
    while (outgoing.length) {
      const chunk = outgoing.shift();
      if (!socket.write(chunk)) {
        stdin.pause();
        socket.once("drain", () => {
          stdin.resume();
          flushStdin();
        });
        break;
      }
    }
  };
  stdin.on("data", (chunk) => {
    sentBytes += chunk.length;
    if (sentBytes > STREAM_LIMIT) return malformed();
    outgoing.push(chunk);
    flushStdin();
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    request = requestFactory({
      hostname: "127.0.0.1",
      port: 55440,
      method: "POST",
      path: `/v1.45/containers/${containerId}/attach?logs=0&stream=1&stdin=1&stdout=1&stderr=1`,
      headers: { Connection: "Upgrade", Upgrade: "tcp" },
      agent: false
    });
    request.once("upgrade", (response, upgradedSocket, head) => {
      if (closing || settled) return upgradedSocket.destroy();
      if (
        response?.statusCode !== 101 ||
        String(response.headers?.upgrade ?? "").toLowerCase() !== "tcp" ||
        !String(response.headers?.connection ?? "")
          .toLowerCase()
          .split(/\s*,\s*/u)
          .includes("upgrade") ||
        String(response.headers?.["content-type"] ?? "")
          .split(";")[0]
          .toLowerCase() !== "application/vnd.docker.multiplexed-stream"
      ) {
        upgradedSocket.destroy();
        return malformed();
      }
      clearTimeout(headerTimer);
      socket = upgradedSocket;
      upgraded = true;
      socket.on("data", ingest);
      socket.once("error", (cause) => destroy(cause));
      socket.once("end", () => {
        ended = true;
        if (pending.length || remaining !== null) malformed();
      });
      socket.once("close", () => {
        if (closing) finish(closeCause);
        else if (ended && !pending.length && remaining === null) finish();
        else finish(failure());
      });
      if (head?.length) ingest(head);
      flushStdin();
      if (!closing) finishReady();
    });
    request.once("response", (response) => {
      response.destroy?.();
      malformed(); // With an Upgrade request, even a 200 raw response is not hijacked.
    });
    request.once("error", (cause) => destroy(cause));
    request.once("close", () => {
      if (!upgraded) finish(closing ? closeCause : failure());
    });
    headerTimer = setTimeout(malformed, HANDSHAKE_MS);
    overallTimer = setTimeout(malformed, OVERALL_MS);
    request.end();
    if (signal?.aborted) onAbort();
  } catch (cause) {
    destroy(cause);
  }
  const close = () => {
    destroy(undefined, true);
    return completed;
  };
  return Object.freeze({ stdin, stdout, stderr, ready, completed, close });
}
