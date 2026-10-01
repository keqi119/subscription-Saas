import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeManualClusterFingerprint,
  encodeManualJson,
  encodeManualRunnerFrame,
  parseManualRunnerFrames,
  sha256Bytes,
  sha256Canonical,
  validateContract,
  validateManualRunnerProtocol,
  verifyManualHandoff
} from "@subscription-saas/release-foundation";
import { runnerError } from "./error-codes.mjs";
import { createPostgresConnector } from "./postgres-connector.mjs";
import { createDatabaseRuntimeAdapter } from "./database-runtime-adapter.mjs";
import { executeManualCommand } from "./manual-command-adapter.mjs";

const limit = 1048576;
const stdoutLimit = 2097152;
const activePrefix = Buffer.from("MS2 ", "ascii");
const profileFile = fileURLToPath(
  new URL("../../../release/contracts/manual-stage1-profile.v2.json", import.meta.url)
);
const aKeys = [
  "profileDigest",
  "sessionId",
  "sessionNonce",
  "operationId",
  "idempotencyKey",
  "attemptId",
  "runId"
];
const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));
const rawRef = (bytes) => ({ digest: sha256Bytes(bytes), bytes: bytes.length });
function requireBinding(condition) {
  if (!condition) throw runnerError("MANUAL_EVIDENCE_BINDING_MISMATCH");
}
function time(value) {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value)
    throw runnerError("MANUAL_TIME_INVALID");
  return epoch;
}
function same(left, right) {
  return sha256Canonical(left) === sha256Canonical(right);
}
function identity(left, right) {
  return ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"].every(
    (key) => left[key] === right[key]
  );
}
async function imageProfile() {
  const handles = [];
  try {
    const before = await fs.lstat(profileFile, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(limit) ||
      (await fs.realpath(profileFile)) !== profileFile
    )
      throw runnerError("MANUAL_PROFILE_INPUT_REQUIRED");
    const read = async () => {
      const handle = await fs.open(profileFile, "r");
      handles.push(handle);
      if (!identity(before, await handle.stat({ bigint: true })))
        throw runnerError("MANUAL_PROFILE_INPUT_REQUIRED");
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (BigInt(offset) !== before.size || !identity(before, await handle.stat({ bigint: true })))
        throw runnerError("MANUAL_PROFILE_INPUT_REQUIRED");
      return Buffer.from(bytes.subarray(0, offset));
    };
    const profileBytes = await read(),
      independentlyRead = await read();
    if (
      !profileBytes.equals(independentlyRead) ||
      !identity(before, await fs.lstat(profileFile, { bigint: true })) ||
      (await fs.realpath(profileFile)) !== profileFile
    )
      throw runnerError("MANUAL_PROFILE_INPUT_REQUIRED");
    const profile = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(profileBytes)
    );
    validateContract("manual-stage1-profile.v2", profile);
    if (!encodeManualJson(profile).equals(profileBytes))
      throw runnerError("MANUAL_PROFILE_INPUT_REQUIRED");
    return { profile, profileBytes };
  } catch (cause) {
    throw Object.assign(runnerError("MANUAL_PROFILE_INPUT_REQUIRED"), { cause });
  } finally {
    for (const handle of handles) await handle.close();
  }
}

async function receiveAuthorization(frame, childChallenge, challengeBytes) {
  // Shared parsing already checked closed shapes. These comparisons bind the
  // consumed pipe values to this process and fixed image inputs before READY.
  const { profile, profileBytes } = await imageProfile();
  const p = frame.payload,
    request = p.request,
    process = p.process,
    readback = p.processReadback;
  const requestDigest = sha256Canonical(request),
    processDigest = sha256Canonical(process);
  requireBinding(sha256Bytes(profileBytes) === request.profileDigest);
  requireBinding(
    p.launchContext.containerId === request.containerId &&
      p.launchContext.runnerImageDigest === request.runnerImageDigest &&
      request.childChallenge === childChallenge
  );
  for (const artifact of [p.allocation, process])
    requireBinding(aKeys.every((field) => artifact[field] === request[field]));
  requireBinding(sha256Canonical(p.allocation) === request.attemptAllocationDigest);
  requireBinding(
    process.requestDigest === requestDigest &&
      process.attemptAllocationDigest === request.attemptAllocationDigest &&
      process.closedAt === null &&
      process.protocol.parentFrames.length === 0
  );
  const launches = process.events.filter(
    (event) => event.source === "parent" && event.tool === "runner" && event.event === "SPAWNED"
  );
  requireBinding(
    launches.length === 1 &&
      launches[0].processSequence === 0 &&
      launches[0].containerId === request.containerId
  );
  requireBinding(same(process.protocol.stdoutPrefix, rawRef(challengeBytes)));
  requireBinding(sha256Canonical(p.baseline) === request.baselineManifestDigest);
  const context = p.targetContext,
    physical = p.baseline.identity.physicalIdentity;
  requireBinding(
    context.runId === request.runId &&
      context.profileDigest === request.profileDigest &&
      same(context.targetIntent, request.targetIntent) &&
      context.databaseOid === request.physicalIdentity.databaseOid &&
      context.databaseOid === physical.databaseOid
  );
  const clusterFingerprint = computeManualClusterFingerprint(context.cluster);
  requireBinding(
    clusterFingerprint === request.physicalIdentity.clusterFingerprint &&
      clusterFingerprint === physical.clusterFingerprint
  );
  requireBinding(
    readback.schemaVersion === "manual-operation-record.v2" &&
      readback.retentionDays === profile.storage.retentionDays &&
      readback.subjectType === "r2-artifact" &&
      readback.purpose === "archive-readback" &&
      readback.storageRole === "archive" &&
      readback.outcome === "MATCH" &&
      readback.reasonCode === null
  );
  requireBinding(
    readback.subjectDigest === processDigest &&
      readback.observedDigest === processDigest &&
      readback.profileDigest === request.profileDigest &&
      readback.ownerId === request.ownerId
  );
  if (
    !(
      time(process.recordedAt) <= time(readback.observedAt) &&
      time(readback.observedAt) <= time(readback.recordedAt) &&
      time(readback.recordedAt) <= Date.now()
    )
  )
    throw runnerError("MANUAL_TIME_INVALID");
  const binding = Object.fromEntries(
    Object.entries(p.authorization.payload).filter(
      ([key]) =>
        !["schemaVersion", "authorizationId", "issuedAt", "expiresAt", "requestDigest"].includes(
          key
        )
    )
  );
  const requestBytes = encodeManualJson(request),
    authorizationBytes = encodeManualJson(p.authorization);
  const decision = verifyManualHandoff({
    authorization: p.authorization,
    receipt: p.receipt,
    profile,
    request: { binding, canonicalBytes: requestBytes },
    childObservation: { ...p.launchContext, childChallenge },
    now: new Date().toISOString()
  });
  return {
    decision,
    profile,
    request,
    targetContext: context,
    baseline: p.baseline,
    profileBytes,
    requestBytes,
    authorizationBytes,
    processEvidence: process,
    authorizeFrameBytes: Buffer.from(frame.frameBytes),
    binding: {
      ...pick(request, [
        ...aKeys,
        "attemptAllocationDigest",
        "containerId",
        "runnerImageDigest",
        "childChallenge"
      ]),
      requestDigest,
      authorizationDigest: sha256Canonical(p.authorization)
    }
  };
}

function receiveCredential(frame, authorization) {
  requireBinding(same(frame.payload.binding, authorization.binding));
  const bytes = Buffer.from(frame.payload.credential, "utf8");
  try {
    if (bytes.length > limit) throw runnerError("MANUAL_CREDENTIAL_INVALID");
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "username") ||
      !Object.hasOwn(value, "password") ||
      typeof value.username !== "string" ||
      typeof value.password !== "string" ||
      value.password.length === 0 ||
      value.password.includes("\0") ||
      !encodeManualJson(value).equals(bytes)
    )
      throw runnerError("MANUAL_CREDENTIAL_INVALID");
    const targets = authorization.profile.allowedTargets.filter(
      (target) =>
        target.endpointPolicyId === authorization.request.targetIntent.endpointPolicyId &&
        target.databaseName === authorization.request.targetIntent.databaseName
    );
    if (
      targets.length !== 1 ||
      value.username !== targets[0].roles[authorization.request.capability]
    )
      throw runnerError("MANUAL_CREDENTIAL_INVALID");
    return Object.freeze({
      username: value.username,
      password: value.password,
      capabilityProfile: authorization.request.capability
    });
  } catch {
    // JSON diagnostics can include input text. No secret diagnostic escapes.
    throw runnerError("MANUAL_CREDENTIAL_INVALID");
  } finally {
    bytes.fill(0);
    frame.payload.credential = "";
  }
}

function write(output, bytes) {
  return new Promise((resolve, reject) => {
    output.once("error", reject);
    output.write(bytes, (error) => {
      if (error) reject(error);
      else {
        output.removeListener("error", reject);
        resolve();
      }
    });
  });
}

function inputChannel(incoming) {
  let bytes = Buffer.alloc(0),
    count = 0,
    ready = false,
    ended = false,
    error = null,
    wake = null;
  const queued = [];
  const closedListeners = new Set();
  const notify = () => {
    wake?.();
    wake = null;
  };
  const pump = (async () => {
    try {
      for await (const chunk of incoming) {
        if (!Buffer.isBuffer(chunk)) throw runnerError("MANUAL_FRAME_INVALID");
        if (bytes.length + chunk.length > limit) throw runnerError("MANUAL_OUTPUT_LIMIT");
        bytes = Buffer.concat([bytes, chunk]);
        if (
          !bytes
            .subarray(0, Math.min(4, bytes.length))
            .equals(activePrefix.subarray(0, Math.min(4, bytes.length)))
        )
          throw runnerError("MANUAL_FRAME_INVALID");
        const parsed = parseManualRunnerFrames({
          direction: "parent-to-child",
          bytes,
          ended: false
        });
        if (
          !ready &&
          (parsed.frames.length > 1 ||
            (parsed.frames.length === 1 && parsed.pendingBytes.length > 0))
        )
          throw runnerError("MANUAL_FRAME_ORDER_INVALID");
        queued.push(...parsed.frames.slice(count));
        count = parsed.frames.length;
        notify();
      }
      parseManualRunnerFrames({ direction: "parent-to-child", bytes, ended: true });
    } catch (cause) {
      error = cause;
    } finally {
      ended = true;
      for (const listener of closedListeners)
        listener(error ?? runnerError("MANUAL_FRAME_INCOMPLETE"));
      notify();
    }
  })();
  return {
    async next() {
      while (true) {
        if (error) throw error;
        if (queued.length) return queued.shift();
        if (ended) throw runnerError("MANUAL_FRAME_INCOMPLETE");
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
    assertHealthy() {
      if (error) throw error;
    },
    assertOpen() {
      if (error) throw error;
      if (ended) throw runnerError("MANUAL_FRAME_INCOMPLETE");
    },
    ready() {
      ready = true;
    },
    onClose(listener) {
      closedListeners.add(listener);
      if (ended) listener(error ?? runnerError("MANUAL_FRAME_INCOMPLETE"));
      return () => closedListeners.delete(listener);
    },
    async close() {
      incoming.destroy?.();
      await pump;
      bytes.fill(0);
      queued.length = 0;
    }
  };
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function processCollector({ authorization, channel, output, stdoutFrames, manualContext }) {
  let sequence = 3,
    processSequence = 0,
    previousAck = null,
    queue = Promise.resolve(),
    failure;
  const parentFrames = [authorization.authorizeFrameBytes],
    running = new Set(),
    pending = new Set();
  const terminations = new Map(),
    closeRejectors = new Map();
  const terminate = (child) => {
    if (terminations.has(child)) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 1000);
    const incomplete = setTimeout(() => {
      closeRejectors.get(child)?.(runnerError("MANUAL_FRAME_INCOMPLETE"));
      closeRejectors.delete(child);
      terminations.delete(child);
    }, 3000);
    terminations.set(child, { force, incomplete });
  };
  const stop = (error) => {
    failure ??= error;
    for (const child of running) terminate(child);
  };
  const unsubscribe = channel.onClose(stop);
  const healthy = () => {
    if (failure) throw failure;
    channel.assertOpen();
  };
  async function emit(type, fields, acknowledge = true) {
    const operation = queue.then(async () => {
      healthy();
      const payload =
        type === "RESULT"
          ? fields
          : {
              binding: authorization.binding,
              previousAck,
              ...fields
            };
      if (payload.event) {
        payload.event.sequence = manualContext.processEvidence.events.length;
        payload.event.at = new Date().toISOString();
      }
      const frameBytes = encodeManualRunnerFrame({ protocol: "MS2", type, sequence, payload });
      const prefix = Buffer.concat([...stdoutFrames, frameBytes]);
      if (prefix.length > stdoutLimit) throw runnerError("MANUAL_OUTPUT_LIMIT");
      await write(output, frameBytes);
      stdoutFrames.push(frameBytes);
      sequence++;
      if (!acknowledge) return;
      const ack = await channel.next();
      healthy();
      validateManualRunnerProtocol({
        mode: "live-ack",
        profileBytes: authorization.profileBytes,
        requestBytes: authorization.requestBytes,
        authorizationBytes: authorization.authorizationBytes,
        previousProcessBytes: encodeManualJson(manualContext.processEvidence),
        childFrameBytes: frameBytes,
        ackFrameBytes: ack.frameBytes,
        stdoutPrefixBytes: prefix,
        parentFrameBytes: parentFrames
      });
      parentFrames.push(Buffer.from(ack.frameBytes));
      previousAck = rawRef(ack.frameBytes);
      if (ack.payload.subject.kind === "process")
        manualContext.processEvidence = freeze(ack.payload.subject.process);
    });
    queue = operation.catch(stop);
    return operation;
  }
  const event = (tool, index, status, argvDigest, values = {}) => ({
    sequence: 0,
    processSequence: index,
    source: "runner",
    tool,
    event: status,
    at: new Date().toISOString(),
    containerId: authorization.request.containerId,
    pid: null,
    argvDigest,
    exitCode: null,
    signal: null,
    reasonCode: null,
    stdout: null,
    stderr: null,
    ...values
  });
  function runProcess(command, args, options) {
    const work = (async () => {
      healthy();
      // Only the existing fixed runtime chooses these calls; no caller command seam.
      const tool =
        command === "psql" && same(args, ["--version"])
          ? "psql-version"
          : command === path.resolve("/app", "apps/release-runner/node_modules/.bin/prisma")
            ? args[0] === "--version"
              ? "prisma-version"
              : args[1] === "deploy"
                ? "prisma-deploy"
                : args.includes("--script")
                  ? "prisma-script"
                  : "prisma-diff"
            : null;
      if (!tool) throw runnerError("MANUAL_FRAME_INVALID");
      const index = ++processSequence,
        argvDigest = sha256Bytes(encodeManualJson({ command, args }));
      await emit("PREPARED", { event: event(tool, index, "PREPARED", argvDigest) });
      healthy();
      let child;
      try {
        child = spawn(command, args, {
          env: options.environment,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch {
        await emit("EVENT", {
          event: event(tool, index, "SPAWN_FAILED", argvDigest, {
            reasonCode: "MANUAL_PROCESS_SPAWN_FAILED"
          }),
          stdoutBase64: null,
          stderrBase64: null
        });
        throw runnerError("MANUAL_PROCESS_SPAWN_FAILED");
      }
      running.add(child);
      const stdout = [],
        stderr = [];
      let rawSize = 0,
        rawFailure,
        spawnFailure;
      const collect = (chunks) => (chunk) => {
        if (rawFailure || failure) return;
        if (!Buffer.isBuffer(chunk)) {
          rawFailure ??= runnerError("MANUAL_FRAME_INVALID");
          terminate(child);
          return;
        }
        chunks.push(Buffer.from(chunk));
        rawSize += chunk.length;
        if (rawSize > limit) {
          rawFailure ??= runnerError("MANUAL_OUTPUT_LIMIT");
          terminate(child);
        }
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      for (const stream of [child.stdout, child.stderr])
        stream.once("error", () => {
          rawFailure ??= runnerError("MANUAL_FRAME_INCOMPLETE");
          terminate(child);
        });
      child.once("error", () => {
        spawnFailure = runnerError("MANUAL_PROCESS_SPAWN_FAILED");
      });
      const spawned = new Promise((resolve) => {
        child.once("spawn", () => resolve(true));
        child.once("error", () => resolve(false));
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        terminate(child);
      }, options.timeoutMs ?? 300000);
      const closed = new Promise((resolve, reject) => {
        closeRejectors.set(child, (error) => {
          // Abandon this incomplete collection; no close event or outcome is inferred.
          clearTimeout(timer);
          running.delete(child);
          reject(error);
        });
        child.once("close", (exitCode, signal) => {
          clearTimeout(timer);
          const termination = terminations.get(child);
          clearTimeout(termination?.force);
          clearTimeout(termination?.incomplete);
          terminations.delete(child);
          closeRejectors.delete(child);
          running.delete(child);
          resolve({ exitCode, signal });
        });
      });
      closed.catch(() => {});
      try {
        if (!(await spawned)) {
          await closed;
          await emit("EVENT", {
            event: event(tool, index, "SPAWN_FAILED", argvDigest, {
              reasonCode: spawnFailure.code
            }),
            stdoutBase64: null,
            stderrBase64: null
          });
          throw spawnFailure;
        }
        await emit("EVENT", {
          event: event(tool, index, "SPAWNED", argvDigest, { pid: child.pid }),
          stdoutBase64: null,
          stderrBase64: null
        });
        const close = await closed;
        const stdoutBytes = Buffer.concat(stdout),
          stderrBytes = Buffer.concat(stderr);
        // Facts remain held as raw bytes before decoding or returning to requireSuccess.
        if (rawFailure) throw rawFailure;
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        let stdoutText, stderrText;
        try {
          stdoutText = decoder.decode(stdoutBytes);
          stderrText = decoder.decode(stderrBytes);
        } catch {
          throw runnerError("MANUAL_FRAME_INVALID");
        }
        await emit("EVENT", {
          event: event(tool, index, "CLOSED", argvDigest, {
            pid: child.pid,
            exitCode: close.exitCode,
            signal: close.signal,
            reasonCode: timedOut ? "MANUAL_PROCESS_TIMEOUT" : null,
            stdout: rawRef(stdoutBytes),
            stderr: rawRef(stderrBytes)
          }),
          stdoutBase64: stdoutBytes.toString("base64"),
          stderrBase64: stderrBytes.toString("base64")
        });
        if (timedOut) throw runnerError("MANUAL_PROCESS_TIMEOUT");
        return { ...close, stdout: stdoutText, stderr: stderrText };
      } catch (error) {
        stop(error);
        await closed;
        throw error;
      }
    })();
    pending.add(work);
    work.then(
      () => pending.delete(work),
      () => pending.delete(work)
    );
    return work;
  }
  return {
    runProcess,
    healthy,
    async settle() {
      await Promise.allSettled([...pending]);
      await queue;
      healthy();
    },
    async finish({ result, observation }) {
      const processDigest = sha256Canonical(manualContext.processEvidence);
      requireBinding(
        result.processEvidenceDigest === processDigest &&
          (observation === null || observation.processEvidenceDigest === processDigest)
      );
      if (observation) await emit("OBSERVATION", { observation });
      await emit("EVENT", {
        event: event("runner", 0, "DISPATCH_CLOSED", null, { reasonCode: result.reasonCode }),
        stdoutBase64: null,
        stderrBase64: null
      });
      await emit("ACK_RECEIVED", {}, false);
      await emit("RESULT", result, false);
      return result;
    },
    async close() {
      unsubscribe();
      stop(runnerError("MANUAL_FRAME_INCOMPLETE"));
      await Promise.allSettled([...pending]);
    }
  };
}

export async function runManualEntrypoint(input) {
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 3 ||
    !["input", "output", "environment"].every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor?.enumerable && "value" in descriptor;
    }) ||
    typeof input.input?.[Symbol.asyncIterator] !== "function" ||
    typeof input.output?.write !== "function" ||
    typeof input.output?.once !== "function" ||
    typeof input.output?.removeListener !== "function"
  )
    throw runnerError("MANUAL_ENTRYPOINT_INPUT_INVALID");
  const { input: incoming, output, environment } = input;
  if (
    environment?.RUNNER_EXECUTION_MODE !== "manual-stage1" ||
    environment.RUNNER_LAUNCH_ENVELOPE_FILE !== undefined
  )
    throw runnerError("RUNNER_EXECUTION_MODE_REJECTED");

  // This process owns the nonce before receiving any parent authorization.
  const childChallenge = randomBytes(32).toString("hex");
  const challengeBytes = encodeManualRunnerFrame({
    protocol: "MS2",
    type: "CHALLENGE",
    sequence: 0,
    payload: { childChallenge }
  });
  await write(output, challengeBytes);

  const channel = inputChannel(incoming);
  const stdoutFrames = [challengeBytes];
  let authorization, database, collector, credentialFrame;
  try {
    const frame = await channel.next();
    authorization = await receiveAuthorization(frame, childChallenge, challengeBytes);
    channel.assertHealthy();
    channel.ready();
    const readyBytes = encodeManualRunnerFrame({
      protocol: "MS2",
      type: "READY",
      sequence: 1,
      payload: { binding: authorization.binding, authorizeFrame: rawRef(frame.frameBytes) }
    });
    await write(output, readyBytes);
    stdoutFrames.push(readyBytes);
    credentialFrame = await channel.next();
    authorization.credential = receiveCredential(credentialFrame, authorization);
    const credentialReceivedBytes = encodeManualRunnerFrame({
      protocol: "MS2",
      type: "CREDENTIAL_RECEIVED",
      sequence: 2,
      payload: {
        binding: authorization.binding,
        authorizeFrame: rawRef(authorization.authorizeFrameBytes)
      }
    });
    await write(output, credentialReceivedBytes);
    stdoutFrames.push(credentialReceivedBytes);
    channel.assertOpen();
    const endpointPolicy = authorization.profile.allowedTargets.find(
      (target) =>
        target.endpointPolicyId === authorization.request.targetIntent.endpointPolicyId &&
        target.databaseName === authorization.request.targetIntent.databaseName
    );
    const manualContext = {
      endpointPolicy: freeze(endpointPolicy),
      approvedClusterObservation: freeze(authorization.targetContext),
      processEvidence: freeze(authorization.processEvidence)
    };
    collector = processCollector({ authorization, channel, output, stdoutFrames, manualContext });
    const target = {
      hostname: authorization.targetContext.cluster.serverAddress,
      port: authorization.targetContext.cluster.serverPort,
      databaseName: authorization.request.targetIntent.databaseName,
      tlsMode: "require"
    };
    database = await createPostgresConnector()({ credential: authorization.credential, target });
    collector.healthy();
    // Query effects and transaction continuations stop when the private pipe is lost.
    const guard = (context) => {
      for (const name of ["$queryRawUnsafe", "$executeRawUnsafe"]) {
        const original = context[name];
        context[name] = (...args) => {
          collector.healthy();
          return original(...args);
        };
      }
      const transaction = context.$transaction;
      context.$transaction = (callback) => {
        collector.healthy();
        return transaction((tx) => callback(guard(tx)));
      };
      return context;
    };
    guard(database);
    const runtime = createDatabaseRuntimeAdapter({
      database,
      credential: authorization.credential,
      target,
      runProcess: collector.runProcess
    });
    runtime.manualContext = manualContext;
    const outcome = await executeManualCommand({
      request: authorization.request,
      decision: authorization.decision,
      baseline: authorization.baseline,
      database,
      runtime
    });
    await collector.settle();
    const connected = database;
    database = null;
    await connected.close();
    return await collector.finish(outcome);
  } finally {
    try {
      await collector?.close();
      await database?.close();
    } finally {
      if (authorization) authorization.credential = null;
      credentialFrame?.frameBytes.fill(0);
      credentialFrame?.payloadBytes.fill(0);
      if (credentialFrame?.payload) credentialFrame.payload.credential = "";
      await channel.close();
    }
  }
}
