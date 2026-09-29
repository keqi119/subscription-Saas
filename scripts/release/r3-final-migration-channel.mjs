// Fixed conversation on the already-owned migration container's private stdin.
// Transport and self-reported results do not authenticate an image or grant a
// capability: H1 must supply its independently verified input and assessor.
import { randomBytes } from "node:crypto";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";

const CHANNEL = "r3-final-migration.v1";
const CODE = "R3_FINAL_MIGRATION_CHANNEL_FAILED";
const FRAME_LIMIT = 32 * 1024 * 1024;
const TOTAL_LIMIT = 64 * 1024 * 1024;
const error = () => Object.assign(new Error(CODE), { code: CODE });
const need = (value) => {
  if (!value) throw error();
};
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const digest = (value) => /^sha256:[0-9a-f]{64}$/u.test(value ?? "");
const copy = (value) => JSON.parse(JSON.stringify(value));

function frames({ incoming, outgoing, signal, expectedIncoming }) {
  need(incoming?.on && outgoing?.write && signal?.addEventListener && !signal.aborted);
  const controller = new AbortController(),
    transcript = [];
  let buffer = Buffer.alloc(0),
    received = 0,
    bytes = 0,
    queued,
    waiting,
    failure,
    disposed = false,
    permitIncoming = true;
  let rejectFailure;
  const failed = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  failed.catch(() => {});
  const originals = () =>
    Object.freeze({
      transcript: Object.freeze(transcript.slice()),
      incompleteBytes: buffer.length,
      incompleteDigest: sha256Bytes(buffer)
    });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", fail);
    incoming.removeListener("data", onData);
    incoming.removeListener("end", onEnd);
    incoming.removeListener("close", onEnd);
    incoming.removeListener("error", fail);
    outgoing.removeListener("error", fail);
    outgoing.removeListener("close", fail);
    incoming.pause();
  };
  const fail = () => {
    if (failure) return failure;
    failure = error();
    Object.defineProperty(failure, "originals", { value: originals() });
    controller.abort();
    waiting?.reject(failure);
    waiting = undefined;
    rejectFailure(failure);
    dispose();
    return failure;
  };
  function retain(value, line) {
    need(transcript.length < 11);
    // Never retain the credential-bearing START bytes, including on failures.
    transcript.push(
      value.type === "START"
        ? Object.freeze({
            type: "START",
            bytes: Buffer.byteLength(line),
            digest: sha256Bytes(Buffer.from(line))
          })
        : line
    );
  }
  function onData(chunk) {
    try {
      need(
        Buffer.isBuffer(chunk) && permitIncoming && buffer.length + chunk.length <= FRAME_LIMIT + 1
      );
      bytes += chunk.length;
      need(bytes <= TOTAL_LIMIT);
      buffer = Buffer.concat([buffer, chunk]);
      let index;
      while ((index = buffer.indexOf(10)) !== -1) {
        need(
          index > 0 &&
            index <= FRAME_LIMIT &&
            !queued &&
            permitIncoming &&
            received < expectedIncoming
        );
        const line = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, index));
        const value = JSON.parse(line);
        need(JSON.stringify(value) === line);
        if (value.type === "START") need(index <= 1048576);
        retain(value, line);
        buffer.fill(0, 0, index + 1);
        buffer = buffer.subarray(index + 1);
        received++;
        permitIncoming = false;
        // No next message is legal until our reply. Reject partial trailing
        // bytes as well as complete frames before the resolved waiter resumes.
        need(buffer.length === 0);
        if (waiting) {
          const pending = waiting;
          waiting = undefined;
          pending.resolve(value);
        } else queued = value;
      }
    } catch {
      fail();
    }
  }
  function onEnd() {
    // A final frame and EOF may be delivered before receive() resumes. The
    // caller still validates that frame's exact type, binding and predecessor.
    if (received !== expectedIncoming || buffer.length) fail();
  }
  const timer = setTimeout(fail, 45 * 60 * 1000);
  signal.addEventListener("abort", fail, { once: true });
  incoming.on("data", onData);
  incoming.on("end", onEnd);
  incoming.on("close", onEnd);
  incoming.on("error", fail);
  outgoing.on("error", fail);
  outgoing.on("close", fail);
  const check = () => {
    if (failure || disposed || signal.aborted) throw fail();
  };
  if (signal.aborted || incoming.destroyed || incoming.readableEnded || outgoing.destroyed) fail();
  return {
    signal: controller.signal,
    failed,
    check,
    fail,
    async receive() {
      check();
      need(!waiting);
      if (queued) {
        const value = queued;
        queued = undefined;
        return value;
      }
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    async send(value) {
      check();
      const line = JSON.stringify(value),
        length = Buffer.byteLength(line) + 1;
      need(length <= FRAME_LIMIT + 1 && (bytes += length) <= TOTAL_LIMIT);
      retain(value, line);
      // Exactly one reply may follow this frame. A second unsolicited frame
      // fails synchronously even if a receive promise was already resolved.
      permitIncoming = received < expectedIncoming;
      await Promise.race([
        failed,
        new Promise((resolve, reject) => {
          outgoing.write(`${line}\n`, (cause) => (cause ? reject(fail()) : resolve()));
        })
      ]);
      check();
    },
    async work(callback) {
      check();
      const value = await Promise.race([
        failed,
        Promise.resolve().then(() => {
          check();
          return callback();
        })
      ]);
      check();
      return value;
    },
    finish() {
      check();
      need(
        received === expectedIncoming &&
          transcript.length === 11 &&
          !buffer.length &&
          !queued &&
          !waiting
      );
      dispose();
      return Object.freeze(transcript.slice());
    }
  };
}

const frame = (type, sequence, bindingDigest, fields = {}) => ({
  channel: CHANNEL,
  type,
  sequence,
  bindingDigest,
  ...fields
});
function checkFrame(value, type, sequence, bindingDigest, fields = []) {
  need(
    exact(value, ["channel", "type", "sequence", "bindingDigest", ...fields]) &&
      value.channel === CHANNEL &&
      value.type === type &&
      value.sequence === sequence &&
      value.bindingDigest === bindingDigest
  );
}
function checkResult(result, stage, bindingDigest, predecessorDigest, previous) {
  const fields =
    stage === "plan"
      ? ["baseline", "plan", "originals"]
      : stage === "apply"
        ? ["postStateObservation"]
        : stage === "verify"
          ? ["observation", "originals", "processOriginals"]
          : ["preparation"];
  need(
    exact(result, [
      "schemaVersion",
      "stage",
      "bindingDigest",
      "predecessorDigest",
      "baselineManifestIdentityDigest",
      "baselineManifestDigest",
      "planDigest",
      ...fields
    ]) &&
      result.schemaVersion === "r3-final-migration-result.v1" &&
      result.stage === stage &&
      result.bindingDigest === bindingDigest &&
      result.predecessorDigest === predecessorDigest &&
      ["baselineManifestIdentityDigest", "baselineManifestDigest", "planDigest"].every(
        (key) => digest(result[key]) && (!previous || result[key] === previous[key])
      )
  );
}

export async function runR3MigrationHostChannel({
  input,
  credential,
  incoming,
  outgoing,
  signal,
  assess
}) {
  need(typeof assess === "function");
  input = copy(input);
  credential = copy(credential);
  const bindingDigest = sha256Canonical(input),
    io = frames({ incoming, outgoing, signal, expectedIncoming: 6 });
  const results = [];
  try {
    const hello = await io.receive();
    io.check();
    checkFrame(hello, "HELLO", 0, null, ["challenge"]);
    need(/^[0-9a-f]{64}$/u.test(hello.challenge));
    await io.send(
      frame("START", 1, bindingDigest, { challenge: hello.challenge, input, credential })
    );
    credential = null;
    for (const [index, stage] of ["plan", "apply", "verify", "prepare"].entries()) {
      const reply = await io.receive();
      io.check();
      checkFrame(
        reply,
        ["PLAN", "APPLIED", "VERIFIED", "PREPARED"][index],
        index * 2 + 2,
        bindingDigest,
        ["result"]
      );
      const previous = results.at(-1);
      checkResult(
        reply.result,
        stage,
        bindingDigest,
        previous ? sha256Canonical(previous) : bindingDigest,
        previous
      );
      await io.work(() => assess({ stage, result: reply.result, input }));
      results.push(copy(reply.result));
      const predecessorDigest = sha256Canonical(reply.result);
      await io.send(
        frame(
          ["APPLY", "VERIFY", "PREPARE_RUNTIME", "FINISH"][index],
          index * 2 + 3,
          bindingDigest,
          {
            predecessorDigest,
            ...(stage === "plan" ? { planDigest: reply.result.planDigest } : {})
          }
        )
      );
    }
    const finished = await io.receive();
    io.check();
    checkFrame(finished, "FINISHED", 10, bindingDigest, ["predecessorDigest"]);
    need(finished.predecessorDigest === sha256Canonical(results.at(-1)));
    return Object.freeze({ results: Object.freeze(results), transcript: io.finish() });
  } catch {
    throw io.fail();
  }
}

export async function runR3MigrationRunnerChannel({ incoming, outgoing, signal, openRuntime }) {
  need(typeof openRuntime === "function");
  const io = frames({ incoming, outgoing, signal, expectedIncoming: 5 });
  const challenge = randomBytes(32).toString("hex");
  let runtime, start, failure, outcome;
  try {
    await io.send(frame("HELLO", 0, null, { challenge }));
    start = await io.receive();
    io.check();
    need(digest(start.bindingDigest));
    checkFrame(start, "START", 1, start.bindingDigest, ["challenge", "input", "credential"]);
    need(
      start.challenge === challenge &&
        sha256Canonical(start.input) === start.bindingDigest &&
        start.input?.schemaVersion === "r3-final-migration-input.v1" &&
        exact(start.credential, ["username", "password", "capabilityProfile"])
    );
    const bindingDigest = start.bindingDigest;
    runtime = await io.work(async () => {
      // Retain the handle even if transport failure wins the enclosing race.
      const opened = await openRuntime({
        input: start.input,
        credential: start.credential,
        signal: io.signal
      });
      runtime = opened;
      if (io.signal.aborted) await opened.close();
      return opened;
    });
    start.credential = null;
    let previous;
    for (const [index, stage] of ["plan", "apply", "verify", "prepare"].entries()) {
      const args =
        index === 0
          ? []
          : [
              {
                predecessorDigest: sha256Canonical(previous),
                ...(stage === "apply" ? { planDigest: previous.planDigest } : {})
              }
            ];
      const result = await io.work(() => runtime[stage](...args));
      checkResult(
        result,
        stage,
        bindingDigest,
        previous ? sha256Canonical(previous) : bindingDigest,
        previous
      );
      await io.send(
        frame(["PLAN", "APPLIED", "VERIFIED", "PREPARED"][index], index * 2 + 2, bindingDigest, {
          result
        })
      );
      const request = await io.receive();
      io.check();
      checkFrame(
        request,
        ["APPLY", "VERIFY", "PREPARE_RUNTIME", "FINISH"][index],
        index * 2 + 3,
        bindingDigest,
        ["predecessorDigest", ...(stage === "plan" ? ["planDigest"] : [])]
      );
      need(
        request.predecessorDigest === sha256Canonical(result) &&
          (stage !== "plan" || request.planDigest === result.planDigest)
      );
      previous = result;
    }
    await runtime.close();
    runtime = null;
    await io.send(
      frame("FINISHED", 10, bindingDigest, { predecessorDigest: sha256Canonical(previous) })
    );
    outcome = Object.freeze({ transcript: io.finish() });
  } catch {
    failure = io.fail();
  } finally {
    if (start) start.credential = null;
    try {
      await runtime?.close();
    } catch (cause) {
      failure ??= io.fail();
      Object.defineProperty(failure, "closeError", { value: cause });
    }
  }
  if (failure) throw failure;
  return outcome;
}
