import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  computeManualClusterFingerprint,
  encodeManualJson,
  encodeManualRunnerFrame,
  parseManualRunnerFrames,
  sha256Bytes,
  sha256Canonical,
  validateContract,
  verifyManualHandoff
} from "@subscription-saas/release-foundation";
import { runnerError } from "./error-codes.mjs";

const limit = 1048576;
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
    async close() {
      incoming.destroy?.();
      await pump;
      bytes.fill(0);
      queued.length = 0;
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
  try {
    const frame = await channel.next();
    const authorization = await receiveAuthorization(frame, childChallenge, challengeBytes);
    channel.assertHealthy();
    channel.ready();
    await write(
      output,
      encodeManualRunnerFrame({
        protocol: "MS2",
        type: "READY",
        sequence: 1,
        payload: { binding: authorization.binding, authorizeFrame: rawRef(frame.frameBytes) }
      })
    );
    const credentialFrame = await channel.next();
    authorization.credential = receiveCredential(credentialFrame, authorization);
    await write(
      output,
      encodeManualRunnerFrame({
        protocol: "MS2",
        type: "CREDENTIAL_RECEIVED",
        sequence: 2,
        payload: {
          binding: authorization.binding,
          authorizeFrame: rawRef(authorization.authorizeFrameBytes)
        }
      })
    );
    channel.assertOpen();
    // The real connector/collector with the first PREPARED/live ACK remain WIP.
    throw runnerError("MANUAL_EVIDENCE_INPUT_REQUIRED");
  } finally {
    await channel.close();
  }
}
