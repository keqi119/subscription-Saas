#!/usr/bin/env node
// The fixed owner and hosted callers keep their original native holders alive.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey } from "node:crypto";
import childProcess from "node:child_process";
import readline from "node:readline/promises";
import { loadFixedManualProfile, readFixedR3JobAdmission } from "./manual-stage1-trust.mjs";
import { launchR3TargetCreate } from "./launch-manual-stage1.mjs";
import { openR3HostedCreationControl } from "./r3-hosted-creation-control.mjs";
import { openR3H1EvidenceDelivery } from "./r3-h1-evidence-delivery.mjs";
import { openR3HostedEvidenceDelivery } from "./r3-hosted-evidence-delivery.mjs";
import { readR3HostedOperationKey } from "./r3-operation-inputs.mjs";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { sha256Bytes } from "../../packages/release-foundation/src/digest.mjs";

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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    need(!failed());
    const bytes = await stableRead("/etc/ssh/stage1-r3-forward/authorized_keys", 0o644);
    if (bytes.length) {
      need(bytes.equals(expected));
      return;
    }
    await delay(500);
  }
  fail();
}
async function ownerAcknowledgement(executionRecordDigest, expiresAt) {
  need(process.stdin.isTTY === true && DIGEST.test(executionRecordDigest));
  const remaining = Date.parse(expiresAt) - Date.now();
  need(Number.isFinite(remaining) && remaining > 0);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question(
      `Source manifest completed. To acknowledge this exact terminal record, type ACK ${executionRecordDigest}\n> `,
      { signal: AbortSignal.timeout(Math.min(remaining, 2147483647)) }
    );
    need(answer === `ACK ${executionRecordDigest}`);
  } finally {
    terminal.close();
  }
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

export async function runR3SourceFreshH1(input) {
  let admission,
    native,
    delivery,
    launch,
    launchFailure,
    nativeClosed = false,
    deliveryClosed = false;
  try {
    inputs(input);
    input = Object.freeze({ ...input });
    admission = await readFixedR3JobAdmission(input);
    need(admission.spec.phase === "source" && admission.spec.chain === "fresh");
    const profile = await loadFixedManualProfile({ repoRoot: input.repoRoot });
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
    delivery = await openR3H1EvidenceDelivery(input);
    native = await launch;
    await native.importHostedEvidence(await delivery.receiveCreation());
    await native.provisionPostgres();
    await native.provisionDatabases();
    await native.recordDestination();
    await native.completeCreation();
    const result = await native.runSourceManifest();
    need(result.executionStatus === "SUCCEEDED" && DIGEST.test(result.executionRecordDigest));
    const executionBytes = await original(profile, "journal", result.executionRecordDigest);
    await ownerAcknowledgement(result.executionRecordDigest, admission.admission.expiresAt);
    const acknowledgement = await native.acknowledgeSource({
      executionRecordDigest: result.executionRecordDigest
    });
    const acknowledgementBytes = await original(
      profile,
      "archive",
      acknowledgement.acknowledgementRecordDigest
    );
    await delivery.publishCleanupRequest({ executionBytes, acknowledgementBytes });
    const cleanupBytes = await delivery.receiveCleanup();
    const imported = await native.importHostedCleanupEvidence(cleanupBytes);
    need(imported.bundleDigest === sha256Bytes(cleanupBytes));
    await delivery.publishCleanupImported({ bundleDigest: imported.bundleDigest });
    await waitForwardExit();
    await native.completeCleanup();
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
    await delivery.publishClosed({ sessionBytes });
    await delivery.close();
    deliveryClosed = true;
    return Object.freeze({
      status: "CLOSED",
      operationRef: input.operationRef,
      sessionRecordDigest,
      promotionEligible: false
    });
  } catch {
    fail();
  } finally {
    if (launch && !native) native = await launch.catch(() => undefined);
    if (!nativeClosed) await native?.close().catch(() => {});
    if (!deliveryClosed) await delivery?.close().catch(() => {});
    await admission?.close();
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
  const unexpected = exit.then(() => {
    if (!stopping) fail();
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

export async function runR3SourceFreshHosted(input) {
  let key,
    control,
    delivery,
    forward,
    forwardClosed = false,
    deliveryClosed = false;
  try {
    inputs(input);
    input = Object.freeze({ ...input });
    need(input.repoRoot === INSTALLED_ROOT);
    key = await readR3HostedOperationKey({ operationRef: input.operationRef });
    const creationSpecBytes = key.creationSpecBytes,
      jobAdmissionBytes = key.jobAdmissionBytes;
    const spec = JSON.parse(creationSpecBytes);
    need(spec.phase === "source" && spec.chain === "fresh");
    delivery = await openR3HostedEvidenceDelivery({ creationSpecBytes, jobAdmissionBytes });
    control = await openR3HostedCreationControl({ creationSpecBytes, jobAdmissionBytes });
    await key.recheck();
    forward = forwardChild(key, control.socketPath);
    const active = (promise) => Promise.race([promise, forward.unexpected]);
    await active(control.created);
    await active(
      delivery.sendCreation(await control.exportEvidence({ privateKey: key.privateKey }))
    );
    await active(delivery.receiveCleanupRequest());
    await active(control.postgresForward);
    await active(control.cleanupOwnedTarget());
    await key.recheck();
    const bytes = await control.exportCleanupEvidence({ privateKey: key.privateKey });
    await active(delivery.sendCleanup(bytes));
    await active(delivery.receiveCleanupImported({ bundleDigest: sha256Bytes(bytes) }));
    await forward.close();
    forwardClosed = true;
    const closed = await delivery.receiveClosed();
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
      promotionEligible: false
    });
  } catch {
    fail();
  } finally {
    if (!forwardClosed) await forward?.close().catch(() => {});
    if (!deliveryClosed) await delivery?.close().catch(() => {});
    await control?.close().catch(() => {});
    await key?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    need(
      args.length === 4 &&
        args[0] === "--side" &&
        ["h1", "hosted"].includes(args[1]) &&
        args[2] === "--operation-ref" &&
        UUID.test(args[3])
    );
    const run = args[1] === "h1" ? runR3SourceFreshH1 : runR3SourceFreshHosted;
    const result = await run({ repoRoot: INSTALLED_ROOT, operationRef: args[3] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(`${CODE}\n`);
    process.exitCode = 1;
  }
}
