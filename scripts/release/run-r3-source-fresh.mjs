#!/usr/bin/env node
// The fixed owner and hosted callers keep their original native holders alive.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey } from "node:crypto";
import childProcess from "node:child_process";
import readline from "node:readline/promises";
import {
  loadFixedManualProfile,
  readFixedR3JobAdmission,
  readTrustedR3SourceCompletion,
  readTrustedR3FinalCompletion
} from "./manual-stage1-trust.mjs";
import { launchR3TargetCreate } from "./launch-manual-stage1.mjs";
import { openR3HostedCreationControl } from "./r3-hosted-creation-control.mjs";
import { assertR3H1EvidenceReady, openR3H1EvidenceDelivery } from "./r3-h1-evidence-delivery.mjs";
import { openR3HostedEvidenceDelivery } from "./r3-hosted-evidence-delivery.mjs";
import { readR3HostedOperationKey } from "./r3-operation-inputs.mjs";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";
import { buildR3FinalGateEvidence, validateR3FinalGateEvidence } from "./r3-final-evidence.mjs";
import {
  r3FailureTracker,
  getR3FailureDiagnostic,
  closeR3FailureResources
} from "./r3-failure-diagnostic.mjs";
import {
  assertR3StartupActive,
  cancelR3Startup,
  createR3StartupDeadline,
  enterR3StartupDeadline,
  r3StartupAbortSignal,
  r3StartupRemainingMs
} from "./r3-startup-deadline.mjs";

const CODE = "R3_SOURCE_FRESH_CALLER_INVALID";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTALLED_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/u, "");
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (condition) => {
  if (!condition) fail();
};
const delay = (ms, signal = null) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason ??
          Object.assign(new Error("R3_STARTUP_CANCELLED"), { code: "R3_STARTUP_CANCELLED" })
      );
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        signal.reason ??
          Object.assign(new Error("R3_STARTUP_CANCELLED"), { code: "R3_STARTUP_CANCELLED" })
      );
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
function inputs(input) {
  need(
    input &&
      Reflect.ownKeys(input).length === 2 &&
      [Object.prototype, null].includes(Object.getPrototypeOf(input)) &&
      ["repoRoot", "operationRef"].every((name) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
      }) &&
      Object.hasOwn(input, "repoRoot") &&
      Object.hasOwn(input, "operationRef") &&
      typeof input.repoRoot === "string" &&
      path.isAbsolute(input.repoRoot) &&
      path.normalize(input.repoRoot) === input.repoRoot &&
      typeof input.operationRef === "string" &&
      UUID.test(input.operationRef) &&
      process.platform === "linux" &&
      process.getuid?.() === 0
  );
}
const same = (a, b) =>
  ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
    (field) => a[field] === b[field]
  );
async function stableRead(file, mode = 0o600) {
  const before = await fs.lstat(file, { bigint: true });
  need(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.uid === 0n &&
      before.gid === 0n &&
      before.nlink === 1n &&
      (before.mode & 0o7777n) === BigInt(mode) &&
      before.size <= 1048576n
  );
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    need(same(before, await handle.stat({ bigint: true })));
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      need(result.bytesRead > 0);
      offset += result.bytesRead;
    }
    need(
      same(before, await handle.stat({ bigint: true })) &&
        same(before, await fs.lstat(file, { bigint: true }))
    );
    return bytes;
  } finally {
    await handle.close();
  }
}
async function original(profile, role, digest) {
  need(DIGEST.test(digest) && ["archive", "journal"].includes(role));
  const root = profile.storage[`${role}Root`];
  for (const directory of [root, `${root}/objects`]) {
    const stat = await fs.lstat(directory, { bigint: true });
    need(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === 0n &&
        stat.gid === 0n &&
        (stat.mode & 0o7777n) === 0o700n
    );
  }
  const bytes = await stableRead(`${root}/objects/${digest.slice(7)}.json`);
  need(sha256Bytes(bytes) === digest && encodeManualJson(JSON.parse(bytes)).equals(bytes));
  return bytes;
}
async function persistSourceEvidence(repoRoot, chain, kind, bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1048576);
  need(
    ["fresh", "snapshot"].includes(chain) &&
      (kind === "gate" || kind === "final" || (chain === "snapshot" && kind === "metadata"))
  );
  const directories = [
    path.join(repoRoot, ".release-output"),
    path.join(repoRoot, `.release-output/${kind === "final" ? "final" : "source"}-${chain}`)
  ];
  for (const directory of directories) {
    try {
      await fs.mkdir(directory, { mode: 0o755 });
      await fs.chmod(directory, 0o755);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(directory, { bigint: true });
    need(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === 0n &&
        stat.gid === 0n &&
        (stat.mode & 0o7777n) === 0o755n
    );
  }
  const file = path.join(
    directories[1],
    kind === "gate"
      ? `source-gate-${chain}.v1.json`
      : kind === "final"
        ? `final-native-${chain}.v1.json`
        : "snapshot-metadata.v1.json"
  );
  const handle = await fs.open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644
  );
  try {
    // This is public gate evidence, readable by the subsequent Actions steps.
    // No private native originals or signing material are copied here.
    await handle.chmod(0o644);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  need((await stableRead(file, 0o644)).equals(bytes));
  const parent = await fs.open(
    directories[1],
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return file;
}
async function waitForwardKey(admission, operationRef, failed) {
  const publicKey = createPublicKey(admission.host.forwardingPublicKeyPem);
  need(publicKey.asymmetricKeyType === "ed25519");
  const blob = Buffer.concat([
    Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
    publicKey.export({ type: "spki", format: "der" }).subarray(-32)
  ]);
  const expected = Buffer.from(
    `restrict,port-forwarding,permitlisten="127.0.0.1:55440",permitlisten="127.0.0.1:55441" ssh-ed25519 ${blob.toString("base64")} r3-${operationRef}\n`
  );
  const signal = r3StartupAbortSignal();
  while (true) {
    assertR3StartupActive();
    need(!failed());
    const bytes = await stableRead("/etc/ssh/stage1-r3-forward/authorized_keys", 0o644);
    assertR3StartupActive();
    if (bytes.length) {
      need(!failed());
      need(bytes.equals(expected));
      return;
    }
    await delay(Math.min(500, r3StartupRemainingMs()), signal);
  }
}
async function ownerAnswer(prompt, expiresAt) {
  need(process.stdin.isTTY === true);
  const remaining = Date.parse(expiresAt) - Date.now();
  need(Number.isFinite(remaining) && remaining > 0);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const startupSignal = r3StartupAbortSignal(),
      timeout = Math.min(remaining, r3StartupRemainingMs() ?? remaining),
      timeoutSignal = AbortSignal.timeout(Math.min(timeout, 2147483647));
    return await terminal.question(prompt, {
      signal: startupSignal ? AbortSignal.any([timeoutSignal, startupSignal]) : timeoutSignal
    });
  } finally {
    terminal.close();
  }
}
async function ownerAcknowledgement(executionRecordDigest, expiresAt, phase = "source") {
  need(DIGEST.test(executionRecordDigest));
  const answer = await ownerAnswer(
    `${phase === "final" ? "Final" : "Source"} manifest completed. To acknowledge this exact terminal record, type ACK ${executionRecordDigest}\n> `,
    expiresAt
  );
  need(answer === `ACK ${executionRecordDigest}`);
}
async function ownerSourceSelection(profile, expiresAt, chain, repoRoot) {
  const answer = await ownerAnswer(
    `Select the CLOSED ${chain} source terminal by typing SOURCE <sha256 digest>\n> `,
    expiresAt
  );
  need(typeof answer === "string" && /^SOURCE sha256:[0-9a-f]{64}$/u.test(answer));
  const terminalDigest = answer.slice(7);
  const terminal = JSON.parse(await original(profile, "journal", terminalDigest));
  need(
    terminal.kind === "execution" &&
      terminal.stage === "candidate-use" &&
      terminal.status === "SUCCEEDED" &&
      UUID.test(terminal.operationId)
  );
  const held = await readTrustedR3SourceCompletion({
    repoRoot,
    operationRef: terminal.operationId,
    executionRecordDigest: terminalDigest
  });
  try {
    await held.recheck();
    need(
      held.scope.phase === "source" &&
        held.scope.chain === chain &&
        typeof held.closedAt === "string" &&
        held.executionRecordDigest === terminalDigest &&
        DIGEST.test(held.sourceGateEvidenceDigest)
    );
    const sourceGateEvidenceBytes = encodeManualJson(held.sourceGateEvidence);
    need(sha256Bytes(sourceGateEvidenceBytes) === held.sourceGateEvidenceDigest);
    return { matchingSourceEvidenceDigest: terminalDigest, sourceGateEvidenceBytes };
  } finally {
    await held.close();
  }
}
async function ownerSnapshotInput(destinationDigest, expiresAt) {
  need(DIGEST.test(destinationDigest));
  const answer = await ownerAnswer(
    `Snapshot destination: ${destinationDigest}\nPrepare the existing fixed snapshot input index and permission for this destination and current job. Select its input UUID with SNAPSHOT <uuid>; this does not grant source permission.\n> `,
    expiresAt
  );
  need(typeof answer === "string" && answer.startsWith("SNAPSHOT ") && UUID.test(answer.slice(9)));
  return answer.slice(9);
}
async function readProcess(binary, args) {
  return new Promise((resolve, reject) =>
    childProcess.execFile(
      binary,
      args,
      {
        shell: false,
        timeout: 10000,
        maxBuffer: 8192,
        encoding: "buffer",
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" }
      },
      (error, stdout, stderr) => {
        const code = error?.code ?? 0;
        if (![0, 1].includes(code) || stderr.length)
          reject(Object.assign(new Error(CODE), { code: CODE }));
        else resolve({ code, stdout: Buffer.from(stdout).toString() });
      }
    )
  );
}
async function waitForwardExit() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ports = await readProcess("/usr/bin/ss", [
      "-H",
      "-ltn",
      "sport = :55440 or sport = :55441"
    ]);
    const processes = await readProcess("/usr/bin/pgrep", ["-u", "994"]);
    need(ports.code === 0);
    if (!ports.stdout.trim() && processes.code === 1 && !processes.stdout.trim()) return;
    await delay(250);
  }
  fail();
}

export const runR3SourceFreshH1 = (input) => runR3SourceH1(input, "fresh");
export const runR3SourceSnapshotH1 = (input) => runR3SourceH1(input, "snapshot");
export const runR3FinalFreshH1 = (input) => runR3SourceH1(input, "fresh", "final");
export const runR3FinalSnapshotH1 = (input) => runR3SourceH1(input, "snapshot", "final");

async function runR3SourceH1(input, chain, phase = "source") {
  const diagnostic = r3FailureTracker("H1_CALLER");
  let admission,
    native,
    delivery,
    launch,
    launchFailure,
    primaryFailure,
    nativeClosed = false,
    deliveryClosed = false,
    finalHistory,
    startupLease;
  try {
    inputs(input);
    input = Object.freeze({ ...input });
    admission = await diagnostic.run("ADMISSION", () => readFixedR3JobAdmission(input));
    need(admission.spec.phase === phase && admission.spec.chain === chain);
    const startupBinding = createR3StartupDeadline({
      rawJob: admission.rawInputs.job,
      admission: {
        ...admission.admission,
        phase: admission.spec.phase,
        chain: admission.spec.chain
      },
      operationRef: input.operationRef
    });
    startupLease = enterR3StartupDeadline(startupBinding);
    assertR3StartupActive();
    await assertR3H1EvidenceReady();
    assertR3StartupActive();
    const profile = await loadFixedManualProfile({ repoRoot: input.repoRoot });
    assertR3StartupActive();
    const selectedSource =
      phase === "final"
        ? await ownerSourceSelection(profile, admission.admission.expiresAt, chain, input.repoRoot)
        : null;
    diagnostic.enter("LAUNCH");
    launch = launchR3TargetCreate(input);
    launch.then(
      (value) => {
        native = value;
      },
      (error) => {
        launchFailure = error;
      }
    );
    // This is startup ordering only. The native holder itself owns the lease
    // and admission; observing a key never substitutes for either authority.
    await waitForwardKey(admission.admission, input.operationRef, () => launchFailure);
    assertR3StartupActive();
    delivery = await diagnostic.run("DELIVERY", () => openR3H1EvidenceDelivery(input));
    assertR3StartupActive();
    diagnostic.enter("CREATION");
    native = await launch;
    await native.importHostedEvidence(await delivery.receiveCreation());
    await native.provisionPostgres();
    await native.provisionDatabases();
    await native.recordDestination();
    const creation = await native.completeCreation();
    if (chain === "snapshot") {
      const inputReference = await ownerSnapshotInput(
        creation.destinationDigest,
        admission.admission.expiresAt
      );
      await native.consumeSnapshot({
        inputReference,
        ...(selectedSource
          ? { matchingSourceEvidenceDigest: selectedSource.matchingSourceEvidenceDigest }
          : {})
      });
      await native.fetchSnapshot();
      await native.decryptSnapshot();
      await native.copySnapshot();
      await native.restoreSnapshot();
      await native.cleanupSnapshot();
      await native.completeSnapshot();
    }
    diagnostic.enter("EXECUTION");
    const result = selectedSource
      ? await native.runFinalManifest(selectedSource)
      : await native.runSourceManifest();
    need(result.executionStatus === "SUCCEEDED" && DIGEST.test(result.executionRecordDigest));
    const sourceGateEvidenceBytes = selectedSource
      ? undefined
      : encodeManualJson(result.sourceGateEvidence);
    const snapshotMetadataBytes =
      chain === "snapshot" && !selectedSource
        ? encodeManualJson(result.snapshotMetadata)
        : undefined;
    const executionBytes = await original(profile, "journal", result.executionRecordDigest);
    await ownerAcknowledgement(result.executionRecordDigest, admission.admission.expiresAt, phase);
    const acknowledgement = await (
      selectedSource ? native.acknowledgeFinal : native.acknowledgeSource
    )({
      executionRecordDigest: result.executionRecordDigest
    });
    const acknowledgementBytes = await original(
      profile,
      "archive",
      acknowledgement.acknowledgementRecordDigest
    );
    diagnostic.enter("CLEANUP");
    await delivery.publishCleanupRequest({ executionBytes, acknowledgementBytes });
    const cleanupBytes = await delivery.receiveCleanup();
    const imported = await native.importHostedCleanupEvidence(cleanupBytes);
    need(imported.bundleDigest === sha256Bytes(cleanupBytes));
    await delivery.publishCleanupImported({ bundleDigest: imported.bundleDigest });
    await waitForwardExit();
    const cleanupReceipt = await native.completeCleanup();
    const sessionRecordDigest = await native.close();
    nativeClosed = true;
    const sessionBytes = await original(profile, "journal", sessionRecordDigest),
      session = JSON.parse(sessionBytes);
    need(
      session.kind === "session" &&
        session.status === "CLOSED" &&
        session.reasonCode === null &&
        session.sessionId === native.session.sessionId &&
        session.sessionNonce === native.session.sessionNonce
    );
    if (selectedSource) {
      finalHistory = await readTrustedR3FinalCompletion({
        repoRoot: input.repoRoot,
        operationRef: input.operationRef,
        executionRecordDigest: result.executionRecordDigest
      });
      const execution = JSON.parse(executionBytes);
      const request = JSON.parse(await original(profile, "journal", execution.requestDigest));
      const savedResult = JSON.parse(await original(profile, "archive", execution.resultDigest));
      const acknowledged = JSON.parse(acknowledgementBytes);
      const finalNativeEvidence = buildR3FinalGateEvidence({
        request,
        execution,
        result: savedResult,
        reconstructed: result.reconstructed,
        acknowledgement: acknowledged,
        cleanupReceipt,
        sessionRecord: session,
        attemptHistory: finalHistory.attemptHistory
      });
      const finalNativeEvidenceBytes = encodeManualJson(finalNativeEvidence);
      await finalHistory.recheck();
      await delivery.publishClosed({ sessionBytes, finalNativeEvidenceBytes });
    } else
      await delivery.publishClosed({
        sessionBytes,
        sourceGateEvidenceBytes,
        ...(snapshotMetadataBytes ? { snapshotMetadataBytes } : {})
      });
    await delivery.close();
    deliveryClosed = true;
    return Object.freeze({
      status: "CLOSED",
      operationRef: input.operationRef,
      sessionRecordDigest,
      promotionEligible: false
    });
  } catch (cause) {
    if (startupLease && !startupLease.scope.connected)
      cancelR3Startup("R3_STARTUP_CANCELLED", startupLease.scope);
    primaryFailure = diagnostic.decorate(
      Object.assign(new Error(CODE), { code: CODE }),
      launchFailure ?? cause
    );
    throw primaryFailure;
  } finally {
    if (launch && !native) {
      if (startupLease && !startupLease.scope.connected)
        cancelR3Startup("R3_STARTUP_CANCELLED", startupLease.scope);
      native = await launch.catch(() => undefined);
    }
    try {
      await closeR3FailureResources(diagnostic, primaryFailure, [
        () => !nativeClosed && native?.close(),
        () => !deliveryClosed && delivery?.close(),
        () => finalHistory?.close(),
        () => admission?.close()
      ]);
    } finally {
      startupLease?.restore();
    }
  }
}

function forwardChild(key, socketPath) {
  const args = [
    "-F",
    "/dev/null",
    "-N",
    "-T",
    "-p",
    "22",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `UserKnownHostsFile=${INSTALLED_ROOT}/release/contracts/stage1-r3-h1-known-hosts`,
    "-o",
    "HostKeyAlgorithms=ssh-ed25519",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-i",
    key.sshPrivateKeyPath,
    "-R",
    `127.0.0.1:55440:${socketPath}`,
    "-R",
    "127.0.0.1:55441:127.0.0.1:55441",
    "stage1-r3-forward@139.196.227.195"
  ];
  const child = childProcess.spawn("/usr/bin/ssh", args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" }
  });
  let ended = false,
    stopping = false,
    size = 0;
  const exit = new Promise((resolve) => {
    child.once("error", () => resolve({ code: null, signal: "SPAWN_ERROR" }));
    child.once("close", (code, signal) => {
      ended = true;
      resolve({ code, signal });
    });
  });
  const unexpected = exit.then((result) => {
    if (!stopping)
      throw r3FailureTracker("SSH_FORWARD").decorate(
        Object.assign(new Error(CODE), { code: CODE }),
        null,
        null,
        result
      );
  });
  unexpected.catch(() => {});
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      size += bytes.length;
      if (size > 65536) child.kill("SIGKILL");
    });
  return {
    unexpected,
    async close() {
      // An exit already observed before our stop cannot be relabelled as the
      // requested shutdown, even when it races the imported-notice response.
      need(!ended);
      stopping = true;
      if (!ended) child.kill("SIGTERM");
      let timer;
      try {
        const result = await Promise.race([
          exit,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error(CODE), { code: CODE })), 15000);
          })
        ]);
        need(
          result.signal === "SIGTERM" || (result.signal === null && [0, 255].includes(result.code))
        );
      } finally {
        clearTimeout(timer);
        if (!ended) child.kill("SIGKILL");
      }
    }
  };
}

export const runR3SourceFreshHosted = (input) => runR3SourceHosted(input, "fresh");
export const runR3SourceSnapshotHosted = (input) => runR3SourceHosted(input, "snapshot");
export const runR3FinalFreshHosted = (input) => runR3SourceHosted(input, "fresh", "final");
export const runR3FinalSnapshotHosted = (input) => runR3SourceHosted(input, "snapshot", "final");

async function runR3SourceHosted(input, chain, phase = "source") {
  const diagnostic = r3FailureTracker("HOSTED_CALLER");
  let key,
    control,
    delivery,
    forward,
    primaryFailure,
    forwardClosed = false,
    deliveryClosed = false;
  try {
    inputs(input);
    input = Object.freeze({ ...input });
    need(input.repoRoot === INSTALLED_ROOT);
    key = await diagnostic.run("KEY", () =>
      readR3HostedOperationKey({ operationRef: input.operationRef })
    );
    const creationSpecBytes = key.creationSpecBytes,
      jobAdmissionBytes = key.jobAdmissionBytes;
    const spec = JSON.parse(creationSpecBytes);
    need(spec.phase === phase && spec.chain === chain);
    delivery = await diagnostic.run("DELIVERY", () =>
      openR3HostedEvidenceDelivery({ creationSpecBytes, jobAdmissionBytes })
    );
    control = await diagnostic.run("CONTROL", () =>
      openR3HostedCreationControl({ creationSpecBytes, jobAdmissionBytes })
    );
    await key.recheck();
    diagnostic.enter("FORWARD");
    forward = forwardChild(key, control.socketPath);
    const active = (promise) => Promise.race([promise, forward.unexpected]);
    await diagnostic.run("CREATION", () => active(control.created));
    await active(
      delivery.sendCreation(await control.exportEvidence({ privateKey: key.privateKey }))
    );
    diagnostic.enter("EXECUTION");
    await active(delivery.receiveCleanupRequest());
    await active(control.postgresForward);
    diagnostic.enter("CLEANUP");
    await active(control.cleanupOwnedTarget());
    await key.recheck();
    const bytes = await control.exportCleanupEvidence({ privateKey: key.privateKey });
    await active(delivery.sendCleanup(bytes));
    await active(delivery.receiveCleanupImported({ bundleDigest: sha256Bytes(bytes) }));
    await forward.close();
    forwardClosed = true;
    const closed = await delivery.receiveClosed();
    if (phase === "final") {
      const finalNativeEvidenceBytes = Buffer.from(closed.finalNativeEvidenceBytes);
      need(sha256Bytes(finalNativeEvidenceBytes) === closed.finalNativeEvidenceDigest);
      const finalNativeEvidence = JSON.parse(finalNativeEvidenceBytes);
      need(
        finalNativeEvidence.schemaVersion === "final-native-evidence.v1" &&
          finalNativeEvidence.chain === chain &&
          finalNativeEvidence.operationId === input.operationRef &&
          encodeManualJson(finalNativeEvidence).equals(finalNativeEvidenceBytes) &&
          validateR3FinalGateEvidence(finalNativeEvidence)
      );
      const finalNativeEvidenceFile = await persistSourceEvidence(
        input.repoRoot,
        chain,
        "final",
        finalNativeEvidenceBytes
      );
      await delivery.confirmClosedReceived();
      await delivery.close();
      deliveryClosed = true;
      await key.recheck();
      await fs.unlink(key.sshPrivateKeyPath);
      await fs.unlink(path.join(path.dirname(key.sshPrivateKeyPath), "signing-key.pem"));
      return Object.freeze({
        status: "CLOSED",
        operationRef: input.operationRef,
        sessionRecordDigest: closed.sessionDigest,
        finalNativeEvidence,
        finalNativeEvidenceDigest: closed.finalNativeEvidenceDigest,
        finalNativeEvidenceFile,
        promotionEligible: false
      });
    }
    const sourceGateEvidenceBytes = Buffer.from(closed.sourceGateEvidenceBytes);
    need(sha256Bytes(sourceGateEvidenceBytes) === closed.sourceGateEvidenceDigest);
    const sourceGateEvidence = JSON.parse(sourceGateEvidenceBytes);
    need(
      sourceGateEvidence.chain === chain &&
        encodeManualJson(sourceGateEvidence).equals(sourceGateEvidenceBytes)
    );
    let snapshotMetadataBytes, snapshotMetadata;
    if (chain === "snapshot") {
      snapshotMetadataBytes = Buffer.from(closed.snapshotMetadataBytes);
      need(
        sha256Bytes(snapshotMetadataBytes) === closed.snapshotMetadataDigest &&
          sourceGateEvidence.snapshot.snapshotMetadataDigest === closed.snapshotMetadataDigest
      );
      snapshotMetadata = JSON.parse(snapshotMetadataBytes);
      need(encodeManualJson(snapshotMetadata).equals(snapshotMetadataBytes));
    }
    const sourceGateEvidenceFile = await persistSourceEvidence(
      input.repoRoot,
      chain,
      "gate",
      sourceGateEvidenceBytes
    );
    const snapshotMetadataFile = snapshotMetadataBytes
      ? await persistSourceEvidence(input.repoRoot, chain, "metadata", snapshotMetadataBytes)
      : undefined;
    await delivery.confirmClosedReceived();
    await delivery.close();
    deliveryClosed = true;
    await key.recheck();
    // Only our pinned private files are removed after both signatures and the
    // exact CLOSED delivery. This is unlinking, not a physical erasure claim.
    await fs.unlink(key.sshPrivateKeyPath);
    await fs.unlink(path.join(path.dirname(key.sshPrivateKeyPath), "signing-key.pem"));
    return Object.freeze({
      status: "CLOSED",
      operationRef: input.operationRef,
      sessionRecordDigest: closed.sessionDigest,
      sourceGateEvidence,
      sourceGateEvidenceDigest: closed.sourceGateEvidenceDigest,
      sourceGateEvidenceFile,
      ...(snapshotMetadataBytes
        ? {
            snapshotMetadata,
            snapshotMetadataDigest: closed.snapshotMetadataDigest,
            snapshotMetadataFile
          }
        : {}),
      promotionEligible: false
    });
  } catch (cause) {
    primaryFailure = diagnostic.decorate(Object.assign(new Error(CODE), { code: CODE }), cause);
    throw primaryFailure;
  } finally {
    await closeR3FailureResources(diagnostic, primaryFailure, [
      () => !forwardClosed && forward?.close(),
      () => !deliveryClosed && delivery?.close(),
      () => control?.close(),
      () => key?.close()
    ]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    need(
      args.length >= 4 &&
        args.length <= 8 &&
        args.length % 2 === 0 &&
        args[0] === "--side" &&
        ["h1", "hosted"].includes(args[1]) &&
        args[2] === "--operation-ref" &&
        UUID.test(args[3])
    );
    const options = new Map();
    for (let index = 4; index < args.length; index += 2) {
      need(["--chain", "--phase"].includes(args[index]) && !options.has(args[index]));
      options.set(args[index], args[index + 1]);
    }
    const chain = options.get("--chain") ?? "fresh";
    const phase = options.get("--phase") ?? "source";
    need(["fresh", "snapshot"].includes(chain) && ["source", "final"].includes(phase));
    const run =
      args[1] === "h1"
        ? phase === "final"
          ? chain === "snapshot"
            ? runR3FinalSnapshotH1
            : runR3FinalFreshH1
          : chain === "snapshot"
            ? runR3SourceSnapshotH1
            : runR3SourceFreshH1
        : phase === "final"
          ? chain === "snapshot"
            ? runR3FinalSnapshotHosted
            : runR3FinalFreshHosted
          : chain === "snapshot"
            ? runR3SourceSnapshotHosted
            : runR3SourceFreshHosted;
    const result = await run({ repoRoot: INSTALLED_ROOT, operationRef: args[3] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (cause) {
    const diagnostic = getR3FailureDiagnostic(cause);
    if (diagnostic) process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    process.stderr.write(`${CODE}\n`);
    process.exitCode = 1;
  }
}
