// Private final-container stdio only. Admission and actual process exit remain
// with the owning H1 holder; the lifecycle authority stays in its held adapter.
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import {
  openR3LifecycleHostChannel,
  openR3LifecycleRunnerChannel
} from "./r3-lifecycle-channel.mjs";
import {
  assertR3FinalLifecycleOriginals,
  executeR3LifecycleSuite
} from "./r3-lifecycle-test-runner.mjs";

const CODE = "R3_FINAL_RUNTIME_CHANNEL_FAILED";
const CHANNEL = "r3-final-runtime.v1";
const MAX_FRAME = 32 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const LIFECYCLE = "node.release-database-lifecycle.postgres";
const error = () => Object.assign(new Error(CODE), { code: CODE });
const requireThat = (condition) => {
  if (!condition) throw error();
};
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const same = (a, b) => sha256Canonical(a) === sha256Canonical(b);
const copy = (value) => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function validateInput(input) {
  requireThat(exact(input, ["envelope", "credentials", "runtimePreparations", "lifecycleContext"]));
  const { envelope, credentials, lifecycleContext: context } = input;
  requireThat(
    envelope?.schemaVersion === "database-test-launch-envelope.v2" && envelope.phase === "final"
  );
  requireThat(
    exact(context, ["runId", "target", "policy", "reservations"]) &&
      context.runId === envelope.operationId
  );
  requireThat(same(context.reservations, envelope.suiteAssignments[LIFECYCLE].reservations));
  const databases = Object.values(envelope.suiteAssignments)
    .filter((a) => a.kind === "suite")
    .flatMap((a) => Object.values(a.databases));
  requireThat(
    databases.length > 0 && new Set(databases.map((d) => d.databaseName)).size === databases.length
  );
  requireThat(
    exact(
      credentials,
      databases.map((d) => d.databaseName)
    )
  );
  for (const database of databases) {
    const credential = credentials[database.databaseName];
    requireThat(
      exact(credential, ["username", "password", "capabilityProfile"]) &&
        credential.username === database.runtimeRole &&
        credential.capabilityProfile === "runtime-test" &&
        typeof credential.password === "string" &&
        credential.password.length > 0
    );
    const digest = sha256Bytes(Buffer.from(credential.password));
    requireThat(
      digest === database.runtimeCredentialFingerprint &&
        digest !== database.migrationCredentialFingerprint
    );
  }
}
function validateSelection(selection, envelope) {
  requireThat(
    selection?.suiteId === LIFECYCLE &&
      selection.r3ExecutionMode === "lifecycle-owned" &&
      selection.runId === envelope.runId &&
      selection.chain === envelope.chain &&
      selection.manifestDigest === envelope.databaseTestManifestDigest &&
      selection.discoveryDigest === envelope.databaseTestDiscoveryDigest &&
      same(selection.databaseAssignment, envelope.suiteAssignments[LIFECYCLE])
  );
}

function frames({ incoming, outgoing, signal, host }) {
  requireThat(
    typeof incoming?.on === "function" &&
      typeof outgoing?.write === "function" &&
      signal &&
      !signal.aborted
  );
  const controller = new AbortController();
  const transcript = [];
  let buffer = Buffer.alloc(0),
    sequence = 0,
    bindingDigest = null,
    permitIncoming = host,
    queued,
    waiting,
    failure,
    disposed = false,
    total = 0;
  let rejectFailure;
  const failed = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  failed.catch(() => {});
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", fail);
    incoming.removeListener("data", onData);
    for (const name of ["end", "close", "error"]) incoming.removeListener(name, fail);
    for (const name of ["close", "error"]) outgoing.removeListener(name, fail);
    incoming.pause();
  };
  const fail = () => {
    if (failure) return failure;
    failure = error();
    Object.defineProperty(failure, "originals", {
      value: Object.freeze({
        transcript: Object.freeze([...transcript]),
        incompleteBytes: buffer.length,
        incompleteDigest: sha256Bytes(buffer)
      })
    });
    buffer = Buffer.alloc(0);
    waiting?.reject(failure);
    waiting = undefined;
    rejectFailure(failure);
    controller.abort();
    dispose();
    return failure;
  };
  const check = () => {
    if (failure || signal.aborted) throw fail();
  };
  const retain = (frame, raw) => {
    total += Buffer.byteLength(raw);
    requireThat(total <= MAX_TOTAL && transcript.length < 49);
    // START contains runtime credentials. Neither raw START nor malformed input
    // bytes are retained in success or failure originals.
    transcript.push(
      Object.freeze(
        frame.type === "START"
          ? {
              sequence: frame.sequence,
              type: frame.type,
              digest: sha256Bytes(Buffer.from(raw)),
              bytes: Buffer.byteLength(raw)
            }
          : { sequence: frame.sequence, type: frame.type, raw }
      )
    );
  };
  const onData = (chunk) => {
    try {
      check();
      requireThat(permitIncoming && !queued);
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      requireThat(buffer.length <= MAX_FRAME);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      // Reject even a partial unsolicited next frame before dispatching work.
      requireThat(newline === buffer.length - 1);
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline));
      const frame = JSON.parse(raw);
      requireThat(
        exact(frame, ["channel", "bindingDigest", "sequence", "type", "payload"]) &&
          JSON.stringify(frame) === raw &&
          frame.channel === CHANNEL &&
          frame.sequence === sequence
      );
      requireThat(
        frame.type === "START" && !host && sequence === 1
          ? /^sha256:[0-9a-f]{64}$/u.test(frame.bindingDigest)
          : frame.bindingDigest === bindingDigest
      );
      retain(frame, raw);
      sequence++;
      permitIncoming = false;
      buffer = Buffer.alloc(0);
      if (waiting) {
        const current = waiting;
        waiting = undefined;
        current.resolve(frame);
      } else queued = frame;
    } catch {
      fail();
    }
  };
  const timer = setTimeout(fail, 120 * 60 * 1000);
  signal.addEventListener("abort", fail, { once: true });
  incoming.on("data", onData);
  for (const name of ["end", "close", "error"]) incoming.on(name, fail);
  for (const name of ["close", "error"]) outgoing.on(name, fail);
  const work = async (callback) => {
    check();
    const value = await Promise.race([
      Promise.resolve().then(() => {
        check();
        return callback();
      }),
      failed
    ]);
    check();
    return value;
  };
  return {
    signal: controller.signal,
    check,
    fail,
    work,
    bind(value) {
      requireThat(bindingDigest === null);
      bindingDigest = value;
    },
    async receive(type) {
      check();
      requireThat(!waiting);
      let frame;
      if (queued) {
        frame = queued;
        queued = undefined;
      } else
        frame = await new Promise((resolve, reject) => {
          waiting = { resolve, reject };
        });
      check();
      requireThat(frame.type === type);
      return frame;
    },
    send(type, payload) {
      check();
      requireThat(!permitIncoming && !queued && !buffer.length);
      const frame = { channel: CHANNEL, bindingDigest, sequence, type, payload };
      const raw = JSON.stringify(frame);
      requireThat(Buffer.byteLength(raw) + 1 <= MAX_FRAME);
      retain(frame, raw);
      sequence++;
      permitIncoming = true;
      outgoing.write(`${raw}\n`);
    },
    finish(result) {
      check();
      requireThat(sequence === 49 && !buffer.length && !queued && !waiting);
      dispose();
      return Object.freeze({ result, transcript: Object.freeze([...transcript]) });
    }
  };
}

// Only this bridge parses the inner channel. Real process stdin/stdout always
// belong exclusively to the outer parser, including during lifecycle execution.
function bridge(io) {
  const input = new PassThrough(),
    output = new PassThrough();
  let queued, waiting;
  output.on("data", (bytes) => {
    try {
      io.check();
      requireThat(bytes.length <= 131072 && !queued);
      const text = bytes.toString("utf8");
      requireThat(text.endsWith("\n") && text.indexOf("\n") === text.length - 1);
      const value = JSON.parse(text);
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve(value);
      } else queued = value;
    } catch {
      io.fail();
    }
  });
  return {
    input,
    output,
    put(value) {
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      requireThat(bytes.length <= 131072);
      input.write(bytes);
    },
    take() {
      return io.work(() => {
        if (queued) {
          const value = queued;
          queued = undefined;
          return value;
        }
        requireThat(!waiting);
        return new Promise((resolve) => {
          waiting = resolve;
        });
      });
    },
    close() {
      input.destroy();
      output.destroy();
    }
  };
}
const payload = (frame, keys) => {
  requireThat(exact(frame.payload, keys));
  return frame.payload;
};

export async function runR3FinalHostChannel({
  input,
  incoming,
  outgoing,
  signal,
  lifecycleAdapter,
  assessLifecycle,
  assessResult
}) {
  const io = frames({ incoming, outgoing, signal, host: true });
  let inner;
  try {
    input = freeze(copy(input));
    validateInput(input);
    requireThat(typeof assessLifecycle === "function" && typeof assessResult === "function");
    for (const key of ["runId", "target", "policy", "reservations"])
      requireThat(same(lifecycleAdapter[key], input.lifecycleContext[key]));
    const binding = sha256Canonical(input),
      envelope = input.envelope;
    const hello = payload(await io.receive("HELLO"), ["challenge"]);
    requireThat(/^[0-9a-f]{64}$/u.test(hello.challenge));
    io.bind(binding);
    io.send("START", { challenge: hello.challenge, input });
    input = undefined;
    const { selection } = payload(await io.receive("LIFECYCLE_BEGIN"), ["selection"]);
    validateSelection(selection, envelope);
    inner = bridge(io);
    const lifecycle = openR3LifecycleHostChannel({
      adapter: lifecycleAdapter,
      input: inner.input,
      output: inner.output,
      bindingDigest: binding,
      signal: io.signal
    });
    lifecycle.completed.catch(() => io.fail());
    io.send("LIFECYCLE_READY", { selectionDigest: sha256Canonical(selection) });
    for (let step = 0; step < 20; step++) {
      inner.put(payload(await io.receive("LIFECYCLE"), ["frame"]).frame);
      io.send("LIFECYCLE", { frame: await inner.take() });
    }
    await io.work(() => lifecycle.completed);
    const { originals } = payload(await io.receive("LIFECYCLE_ORIGINALS"), ["originals"]);
    assertR3FinalLifecycleOriginals(originals);
    const assessed = await io.work(() =>
      assessLifecycle({ selection: copy(selection), originals: copy(originals) })
    );
    requireThat(exact(assessed, ["report", "originals"]) && same(assessed.originals, originals));
    io.send("LIFECYCLE_RESULT", assessed);
    const { result } = payload(await io.receive("MANIFEST_RESULT"), ["result"]);
    await io.work(() => assessResult(copy(result)));
    const resultDigest = sha256Canonical(result);
    io.send("FINISH", { resultDigest });
    requireThat(
      payload(await io.receive("FINISHED"), ["resultDigest"]).resultDigest === resultDigest
    );
    return io.finish(result);
  } catch {
    throw io.fail();
  } finally {
    inner?.close();
  }
}

export async function runR3FinalRunnerChannel({
  incoming,
  outgoing,
  signal,
  executeManifest,
  executeLifecycleSuite = executeR3LifecycleSuite
}) {
  const io = frames({ incoming, outgoing, signal, host: false });
  let inner, pump;
  try {
    requireThat(
      typeof executeManifest === "function" && typeof executeLifecycleSuite === "function"
    );
    const challenge = randomBytes(32).toString("hex");
    io.send("HELLO", { challenge });
    const start = await io.receive("START");
    const { input, challenge: observed } = payload(start, ["challenge", "input"]);
    requireThat(observed === challenge && start.bindingDigest === sha256Canonical(input));
    validateInput(input);
    freeze(input);
    io.bind(start.bindingDigest);
    let used = false,
      complete = false;
    const executeLifecycle = async (selection) => {
      io.check();
      requireThat(!used);
      used = true;
      selection = freeze(copy(selection));
      validateSelection(selection, input.envelope);
      io.send("LIFECYCLE_BEGIN", { selection });
      requireThat(
        payload(await io.receive("LIFECYCLE_READY"), ["selectionDigest"]).selectionDigest ===
          sha256Canonical(selection)
      );
      inner = bridge(io);
      const lifecycle = openR3LifecycleRunnerChannel({
        context: input.lifecycleContext,
        input: inner.input,
        output: inner.output,
        bindingDigest: start.bindingDigest,
        signal: io.signal
      });
      pump = (async () => {
        for (let step = 0; step < 20; step++) {
          io.send("LIFECYCLE", { frame: await inner.take() });
          inner.put(payload(await io.receive("LIFECYCLE"), ["frame"]).frame);
        }
      })();
      pump.catch(() => io.fail());
      const originals = await io.work(() =>
        executeLifecycleSuite({
          adapter: lifecycle.adapter,
          signal: io.signal,
          recheck: async () => io.check()
        })
      );
      assertR3FinalLifecycleOriginals(originals);
      await io.work(() => lifecycle.finish());
      await io.work(() => pump);
      io.send("LIFECYCLE_ORIGINALS", { originals });
      const assessed = payload(await io.receive("LIFECYCLE_RESULT"), ["report", "originals"]);
      requireThat(same(assessed.originals, originals));
      complete = true;
      return assessed;
    };
    const result = await io.work(() =>
      executeManifest(input, { executeLifecycle, signal: io.signal })
    );
    requireThat(used && complete);
    io.send("MANIFEST_RESULT", { result });
    const resultDigest = sha256Canonical(result);
    requireThat(
      payload(await io.receive("FINISH"), ["resultDigest"]).resultDigest === resultDigest
    );
    io.send("FINISHED", { resultDigest });
    return io.finish(result);
  } catch {
    throw io.fail();
  } finally {
    inner?.close();
  }
}
