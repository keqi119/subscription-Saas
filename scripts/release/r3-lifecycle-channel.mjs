// Internal, bounded stdio transport for the existing lifecycle adapter. The
// caller must already own the admitted final container and H1 adapter. This is
// neither an authorization outlet nor an alternative to the actual Node tests.
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";

const CODE = "R3_LIFECYCLE_CHANNEL_FAILED";
const CHANNEL = "r3-lifecycle.v1";
const MAX_FRAME = 131072;
const MAX_DURATION = 20 * 60 * 1000;
const steps = Object.freeze(
  [
    ["provision", 0],
    ["provision", 1],
    ["migrate", 0],
    ["migrate", 1],
    ["grantRuntimeAccess", 0],
    ["grantRuntimeAccess", 1],
    ["runtimeRole", 0],
    ["migrationOwnership", 0],
    ["attemptRuntimeCreate", 0],
    ["runtimeRole", 1],
    ["migrationOwnership", 1],
    ["attemptRuntimeCreate", 1],
    ["cleanup", 0, "database-name"],
    ["cleanup", 0, "marker"],
    ["cleanup", 0],
    ["countDatabase", 0],
    ["siblingDatabase", 1],
    ["cleanup", 1],
    ["countOwned", null],
    ["complete", null]
  ].map(([action, shard, variant = null]) => Object.freeze({ action, shard, variant }))
);
const error = () => Object.assign(new Error(CODE), { code: CODE });
const same = (a, b) => sha256Canonical(a) === sha256Canonical(b);
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const copy = (value) => freeze(JSON.parse(JSON.stringify(value)));
function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
function expectedRequest(bindingDigest, index) {
  return { channel: CHANNEL, bindingDigest, sequence: index + 1, ...steps[index] };
}
function expectedError(step) {
  if (step.action === "attemptRuntimeCreate") return "42501";
  if (step.action === "cleanup" && step.variant) return "CLEANUP_IDENTITY_MISMATCH";
  return null;
}

function frames({ input, output, bindingDigest, signal }) {
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(bindingDigest ?? "") ||
    typeof input?.on !== "function" ||
    typeof output?.write !== "function" ||
    !signal ||
    typeof signal.addEventListener !== "function" ||
    signal.aborted
  )
    throw error();
  const transcript = [];
  let buffer = Buffer.alloc(0),
    waiting,
    queued,
    failure,
    disposed = false;
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
    input.removeListener("data", onData);
    input.removeListener("end", fail);
    input.removeListener("close", fail);
    input.removeListener("error", fail);
    output.removeListener("error", fail);
    output.removeListener("close", fail);
    input.pause();
  };
  const fail = () => {
    if (failure) return failure;
    failure = error();
    Object.defineProperty(failure, "originals", {
      value: Object.freeze({
        frames: Object.freeze([...transcript]),
        incompleteFrame: buffer.toString("base64")
      })
    });
    waiting?.reject(failure);
    waiting = undefined;
    rejectFailure(failure);
    dispose();
    return failure;
  };
  const onData = (chunk) => {
    try {
      if (!Buffer.isBuffer(chunk) || chunk.length + buffer.length > MAX_FRAME + 1) throw error();
      buffer = Buffer.concat([buffer, chunk]);
      let delimiter;
      while ((delimiter = buffer.indexOf(10)) >= 0) {
        if (delimiter === 0 || delimiter > MAX_FRAME || queued || transcript.length >= 40)
          throw error();
        const line = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, delimiter)
        );
        buffer = buffer.subarray(delimiter + 1);
        const value = JSON.parse(line);
        // Only the exact encoding used by this transport is accepted: duplicate
        // keys, whitespace alternatives and extra frames cannot be hidden.
        if (JSON.stringify(value) !== line) throw error();
        transcript.push(line);
        if (waiting) {
          const pending = waiting;
          waiting = undefined;
          pending.resolve(value);
        } else queued = { value };
      }
      if (buffer.length > MAX_FRAME) throw error();
    } catch {
      fail();
    }
  };
  const timer = setTimeout(fail, MAX_DURATION);
  signal.addEventListener("abort", fail, { once: true });
  input.on("data", onData);
  input.on("end", fail);
  input.on("close", fail);
  input.on("error", fail);
  output.on("error", fail);
  output.on("close", fail);
  if (signal.aborted || input.readableEnded || input.destroyed || output.destroyed) fail();
  return {
    failed,
    assertOpen() {
      if (failure || disposed || signal.aborted) throw fail();
    },
    receive() {
      if (failure || disposed || waiting) return Promise.reject(failure ?? error());
      if (queued) {
        const entry = queued;
        queued = undefined;
        return Promise.resolve(entry.value);
      }
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    async send(value) {
      if (failure || disposed) throw failure ?? error();
      const line = JSON.stringify(value);
      if (Buffer.byteLength(line) > MAX_FRAME || transcript.length >= 40) {
        fail();
        throw failure;
      }
      transcript.push(line);
      await Promise.race([
        failed,
        new Promise((resolve, reject) => {
          output.write(`${line}\n`, (cause) => {
            if (cause) {
              fail();
              reject(failure);
            } else resolve();
          });
        })
      ]);
    },
    finish() {
      if (failure || disposed || buffer.length || queued || waiting || transcript.length !== 40) {
        fail();
        throw failure ?? error();
      }
      dispose();
      return Object.freeze([...transcript]);
    },
    fail
  };
}

function resultValue(action, value, context, shard) {
  if (["migrate", "grantRuntimeAccess", "cleanup", "complete"].includes(action)) return null;
  if (action === "provision") {
    const names = [
      "recordVersion",
      "targetFingerprint",
      "databaseName",
      "databaseOid",
      "marker",
      "runId",
      "suiteId",
      "shard",
      "roles",
      "secretReferences",
      "createdAt"
    ];
    const reservation = context.reservations[shard];
    if (
      !exactKeys(value, names) ||
      value.recordVersion !== "provisioned-database.v1" ||
      value.targetFingerprint !== context.target.clusterFingerprint ||
      value.databaseName !== reservation.databaseName ||
      !/^[0-9]+$/u.test(value.databaseOid ?? "") ||
      typeof value.marker !== "string" ||
      value.runId !== context.runId ||
      value.suiteId !== "database-lifecycle" ||
      value.shard !== shard ||
      !same(value.roles, reservation.roles) ||
      !exactKeys(value.secretReferences, Object.keys(reservation.roles)) ||
      Object.values(value.secretReferences).some(
        (v) => typeof v !== "string" || !v || /postgres(?:ql)?:\/\//iu.test(v)
      ) ||
      typeof value.createdAt !== "string" ||
      Number.isNaN(Date.parse(value.createdAt))
    )
      throw error();
    return copy(value);
  }
  const columns = {
    runtimeRole: ["super", "createdb", "createrole", "bypassrls", "login"],
    migrationOwnership: [
      "schemaOwner",
      "migrationOwner",
      "canCreate",
      "memberships",
      "migrationCount"
    ],
    countDatabase: ["count"],
    siblingDatabase: ["databaseName"],
    countOwned: ["count"]
  }[action];
  if (
    !columns ||
    !exactKeys(value, ["rows"]) ||
    !Array.isArray(value.rows) ||
    value.rows.length > 1 ||
    value.rows.some(
      (row) => !exactKeys(row, columns) || Object.values(row).some((v) => typeof v !== "string")
    )
  )
    throw error();
  return copy(value);
}

export function openR3LifecycleHostChannel({ adapter, ...options }) {
  const io = frames(options);
  const records = new Map();
  const completed = (async () => {
    try {
      for (let index = 0; index < steps.length; index++) {
        const request = await io.receive();
        const expected = expectedRequest(options.bindingDigest, index);
        if (!exactKeys(request, Object.keys(expected)) || !same(request, expected)) throw error();
        const step = steps[index];
        const base = {
          channel: CHANNEL,
          bindingDigest: options.bindingDigest,
          sequence: index + 1
        };
        let response;
        try {
          let value;
          if (step.action !== "complete") {
            let argument = records.get(step.shard);
            if (step.action === "provision") argument = step.shard;
            else if (step.action === "countOwned") argument = undefined;
            else if (!argument) throw error();
            if (step.variant === "database-name")
              argument = { ...argument, databaseName: `${argument.databaseName}_forged` };
            if (step.variant === "marker") argument = { ...argument, marker: "forged" };
            // A resolved receive can precede a malformed trailing frame or an
            // abort in the same turn. Check synchronously before invoking the
            // privileged callback; racing afterward cannot undo its effects.
            io.assertOpen();
            value = await Promise.race([io.failed, adapter[step.action](argument)]);
            if (step.action === "provision") records.set(step.shard, value);
          }
          if (expectedError(step)) throw error();
          response = {
            ...base,
            status: "ok",
            value: resultValue(step.action, value, adapter, step.shard)
          };
        } catch (cause) {
          response = {
            ...base,
            status: "error",
            code: expectedError(step) === cause?.code ? cause.code : CODE
          };
        }
        await io.send(response);
        if (response.code === CODE) throw error();
      }
      return io.finish();
    } catch {
      throw io.fail();
    }
  })();
  // The process supervisor must observe completed, terminate on failure, and
  // retain host adapter observations. This helper does not kill a container.
  completed.catch(() => {});
  return Object.freeze({ completed });
}

export function openR3LifecycleRunnerChannel({ context, ...options }) {
  const fixed = copy(context);
  const io = frames(options);
  const records = new Map();
  let pending = Promise.resolve(),
    index = 0,
    stopped = false;
  const invoke = (action, argument) => {
    const next = pending.then(async () => {
      try {
        if (stopped || index >= steps.length) throw error();
        const step = steps[index];
        if (action !== step.action) throw error();
        if (action === "provision") {
          if (argument !== step.shard) throw error();
        } else if (!["complete", "countOwned"].includes(action)) {
          let expected = records.get(step.shard);
          if (!expected) throw error();
          if (step.variant === "database-name")
            expected = { ...expected, databaseName: `${expected.databaseName}_forged` };
          if (step.variant === "marker") expected = { ...expected, marker: "forged" };
          if (!same(argument, expected)) throw error();
        } else if (argument !== undefined) throw error();
        await io.send(expectedRequest(options.bindingDigest, index));
        const response = await io.receive();
        io.assertOpen();
        const base = {
          channel: CHANNEL,
          bindingDigest: options.bindingDigest,
          sequence: index + 1
        };
        const isError = response?.status === "error";
        if (
          !exactKeys(response, [...Object.keys(base), "status", isError ? "code" : "value"]) ||
          Object.keys(base).some((key) => response[key] !== base[key])
        )
          throw error();
        if (isError) {
          if (!expectedError(step) || response.code !== expectedError(step)) throw error();
          index++;
          return { denied: response.code };
        }
        if (response.status !== "ok" || expectedError(step)) throw error();
        const value = resultValue(action, response.value, fixed, step.shard);
        if (
          ["migrate", "grantRuntimeAccess", "cleanup", "complete"].includes(action) &&
          response.value !== null
        )
          throw error();
        if (action === "provision") records.set(step.shard, value);
        index++;
        if (action === "complete") {
          stopped = true;
          return { value: io.finish() };
        }
        return { value };
      } catch {
        stopped = true;
        throw io.fail();
      }
    });
    pending = next.catch(() => {});
    return next.then((result) => {
      if (result.denied) throw Object.assign(new Error(result.denied), { code: result.denied });
      return result.value;
    });
  };
  const methods = [...new Set(steps.map((s) => s.action))].filter(
    (action) => action !== "complete"
  );
  return Object.freeze({
    adapter: Object.freeze({
      ...fixed,
      ...Object.fromEntries(
        methods.map((action) => [action, (argument) => invoke(action, argument)])
      )
    }),
    finish: () => invoke("complete")
  });
}
