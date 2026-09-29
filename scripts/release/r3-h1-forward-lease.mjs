// A single live H1 operation may install its admitted job's forwarding key.
// Removing this key does not terminate an already established SSH connection.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import childProcess from "node:child_process";
import path from "node:path";
import { createPublicKey } from "node:crypto";
import {
  encodeManualJson,
  sha256Bytes,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import { loadFixedManualProfile, readFixedR3JobAdmission } from "./manual-stage1-trust.mjs";

const CODE = "R3_H1_FORWARD_LEASE_UNAVAILABLE";
const SHUTDOWN_CODE = "R3_H1_FORWARD_SHUTDOWN_UNVERIFIED";
const KEY = "/etc/ssh/stage1-r3-forward/authorized_keys";
const SHUTDOWN_COMMANDS = [
  ["ss", "/usr/bin/ss", ["-H", "-ltn", "sport = :55440 or sport = :55441"], 0],
  ["pgrep", "/usr/bin/pgrep", ["-u", "994"], 1]
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (value) => {
  if (!value) fail();
};
function exact(value, fields) {
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === fields.length &&
      fields.every((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
      })
  );
}
function same(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}
async function command(binary, args, expected = 0) {
  const outcome = await new Promise((resolve) =>
    childProcess.execFile(
      binary,
      args,
      {
        shell: false,
        encoding: "buffer",
        timeout: 10000,
        maxBuffer: 65536,
        windowsHide: true,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" }
      },
      (error, stdout, stderr) =>
        resolve({ error, stdout: Buffer.from(stdout ?? ""), stderr: Buffer.from(stderr ?? "") })
    )
  );
  need((outcome.error?.code ?? 0) === expected && outcome.stderr.length <= 4096);
  return outcome.stdout.toString("utf8");
}
async function privateDirectory(directory) {
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current, { bigint: true });
    need(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === 0n &&
        (stat.mode & 0o022n) === 0n &&
        (await fs.realpath(current)) === current
    );
  }
}
async function heldFile(file, mode) {
  let before = await fs.lstat(file, { bigint: true });
  need(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.uid === 0n &&
      before.nlink === 1n &&
      (before.mode & 0o777n) === BigInt(mode) &&
      before.size <= 65536n
  );
  const handle = await fs.open(
    file,
    (mode === 0o644 ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW
  );
  try {
    const actual = await handle.stat({ bigint: true });
    need(
      same(before, actual) &&
        before.size === actual.size &&
        before.mtimeNs === actual.mtimeNs &&
        before.ctimeNs === actual.ctimeNs
    );
    const read = async () => {
      const stat = await handle.stat({ bigint: true });
      const visible = await fs.lstat(file, { bigint: true });
      need(
        same(before, stat) &&
          same(before, visible) &&
          stat.size <= 65536n &&
          stat.size === visible.size &&
          stat.mtimeNs === visible.mtimeNs &&
          stat.ctimeNs === visible.ctimeNs
      );
      const bytes = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        need(result.bytesRead > 0);
        offset += result.bytesRead;
      }
      const afterHeld = await handle.stat({ bigint: true });
      const afterVisible = await fs.lstat(file, { bigint: true });
      need(
        same(stat, afterHeld) &&
          same(stat, afterVisible) &&
          stat.size === afterHeld.size &&
          stat.size === afterVisible.size &&
          stat.mtimeNs === afterHeld.mtimeNs &&
          stat.mtimeNs === afterVisible.mtimeNs &&
          stat.ctimeNs === afterHeld.ctimeNs &&
          stat.ctimeNs === afterVisible.ctimeNs
      );
      return bytes;
    };
    const refreshOwnWrite = async () => {
      const held = await handle.stat({ bigint: true });
      const visible = await fs.lstat(file, { bigint: true });
      need(
        same(before, held) &&
          same(before, visible) &&
          held.size === visible.size &&
          held.mtimeNs === visible.mtimeNs &&
          held.ctimeNs === visible.ctimeNs
      );
      before = held;
    };
    return { file, handle, read, refreshOwnWrite, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
function sshKey(pem) {
  const key = createPublicKey(pem);
  need(key.asymmetricKeyType === "ed25519" && key.export({ type: "spki", format: "pem" }) === pem);
  const der = key.export({ type: "spki", format: "der" });
  const raw = der.subarray(-32);
  need(der.length === 44 && raw.length === 32);
  const type = Buffer.from("ssh-ed25519");
  const size = (n) => {
    const value = Buffer.alloc(4);
    value.writeUInt32BE(n);
    return value;
  };
  return `ssh-ed25519 ${Buffer.concat([size(type.length), type, size(raw.length), raw]).toString("base64")}`;
}
async function transport(preinstall) {
  const settings = Object.fromEntries(
    (
      await command("/usr/sbin/sshd", [
        "-T",
        "-C",
        "user=stage1-r3-forward,host=139.196.227.195,addr=127.0.0.1"
      ])
    )
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf(" ");
        return [line.slice(0, at), line.slice(at + 1)];
      })
  );
  const expected = {
    authenticationmethods: "publickey",
    pubkeyauthentication: "yes",
    passwordauthentication: "no",
    challengeresponseauthentication: "no",
    authorizedkeysfile: KEY,
    authorizedkeyscommand: "none",
    trustedusercakeys: "none",
    authorizedprincipalsfile: "none",
    authorizedprincipalscommand: "none",
    allowtcpforwarding: "remote",
    permitlisten: "127.0.0.1:55440 127.0.0.1:55441",
    permitopen: "none",
    allowstreamlocalforwarding: "no",
    allowagentforwarding: "no",
    x11forwarding: "no",
    permittty: "no",
    permituserrc: "no",
    permittunnel: "no",
    gatewayports: "no",
    maxsessions: "0",
    forcecommand: "/sbin/nologin"
  };
  for (const [field, value] of Object.entries(expected)) need(settings[field] === value);
  const outputRule = [
    "-p",
    "tcp",
    "-d",
    "127.0.0.1/32",
    "-m",
    "multiport",
    "--dports",
    "55440,55441",
    "-m",
    "owner",
    "!",
    "--uid-owner",
    "0",
    "-m",
    "comment",
    "--comment",
    "stage1-r3-loopback-root-only",
    "-j",
    "REJECT",
    "--reject-with",
    "tcp-reset"
  ];
  const inputRule = [
    "!",
    "-i",
    "lo",
    "-p",
    "tcp",
    "-d",
    "127.0.0.1/32",
    "-m",
    "multiport",
    "--dports",
    "55440,55441",
    "-m",
    "comment",
    "--comment",
    "stage1-r3-reject-nonloopback",
    "-j",
    "REJECT",
    "--reject-with",
    "tcp-reset"
  ];
  for (const [chain, rule, expectedFirst] of [
    [
      "OUTPUT",
      outputRule,
      "-A OUTPUT -d 127.0.0.1/32 -p tcp -m multiport --dports 55440,55441 -m owner ! --uid-owner 0 -m comment --comment stage1-r3-loopback-root-only -j REJECT --reject-with tcp-reset"
    ],
    [
      "INPUT",
      inputRule,
      "-A INPUT -d 127.0.0.1/32 ! -i lo -p tcp -m multiport --dports 55440,55441 -m comment --comment stage1-r3-reject-nonloopback -j REJECT --reject-with tcp-reset"
    ]
  ]) {
    await command("/usr/sbin/iptables", ["-w", "5", "-C", chain, ...rule]);
    const lines = (await command("/usr/sbin/iptables", ["-w", "5", "-S", chain])).split("\n");
    const first = lines.find((line) => line.startsWith(`-A ${chain} `));
    need(first === expectedFirst);
  }
  if (preinstall) {
    need(
      (await command("/usr/bin/ss", ["-H", "-ltn", "sport = :55440 or sport = :55441"])).trim() ===
        ""
    );
    need((await command("/usr/bin/pgrep", ["-u", "994"], 1)).trim() === "");
  }
}

export async function openR3H1ForwardLease(input) {
  let admission,
    key,
    locks = [],
    installed = null,
    closed = false,
    closing;
  const release = async () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      try {
        if (installed && key) {
          const current = await key.read();
          need(current.equals(installed));
          await key.handle.truncate(0);
          await key.handle.sync();
          await key.refreshOwnWrite();
          need((await key.read()).length === 0);
        }
      } finally {
        const outcomes = await Promise.allSettled([
          ...(key ? [key.close()] : []),
          ...locks.map((item) => item.close()),
          ...(admission ? [admission.close()] : [])
        ]);
        need(outcomes.every((outcome) => outcome.status === "fulfilled"));
      }
    })();
    return closing;
  };
  try {
    exact(input, ["repoRoot", "operationRef"]);
    need(
      process.platform === "linux" &&
        process.getuid?.() === 0 &&
        typeof input.repoRoot === "string" &&
        path.isAbsolute(input.repoRoot) &&
        path.normalize(input.repoRoot) === input.repoRoot &&
        typeof input.operationRef === "string" &&
        UUID.test(input.operationRef)
    );
    admission = await readFixedR3JobAdmission(input);
    const profile = await loadFixedManualProfile({ repoRoot: input.repoRoot });
    need(sha256Canonical(profile) === admission.spec.profileDigest);
    const scope = Object.freeze({
      targetPolicyDigest: admission.spec.targetPolicyDigest,
      creationSpecDigest: admission.creationSpecDigest,
      jobAdmissionDigest: admission.jobAdmissionDigest,
      buildProofDigest: admission.build.buildProofDigest,
      sourceSha: admission.sourceSha,
      phase: admission.spec.phase,
      chain: admission.spec.chain
    });
    const lockDir = path.join(profile.storage.journalRoot, "locks");
    await privateDirectory(lockDir);
    for (const slot of ["tcp://127.0.0.1:55440", "127.0.0.1:55441"]) {
      const name = `${sha256Canonical({ slot, kind: "r3-forward-slot" }).slice(7)}.json`;
      locks.push(await heldFile(path.join(lockDir, name), 0o600));
    }
    const lockBytes = await locks[0].read();
    need(lockBytes.equals(await locks[1].read()));
    const lock = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes));
    exact(lock, ["sessionId", "sessionNonce", "profileDigest", "scope", "pid"]);
    exact(lock.scope, Object.keys(scope));
    need(
      encodeManualJson(lock).equals(lockBytes) &&
        lock.pid === process.pid &&
        lock.profileDigest === sha256Canonical(profile) &&
        Object.keys(scope).every((field) => lock.scope[field] === scope[field])
    );
    await admission.recheck();
    await transport(true);
    await privateDirectory(path.dirname(KEY));
    key = await heldFile(KEY, 0o644);
    need((await key.read()).length === 0);
    await admission.recheck();
    for (const item of locks) need((await item.read()).equals(lockBytes));
    const line = Buffer.from(
      `restrict,port-forwarding,permitlisten="127.0.0.1:55440",permitlisten="127.0.0.1:55441" ${sshKey(admission.admission.host.forwardingPublicKeyPem)} r3-${input.operationRef}\n`
    );
    need((await key.handle.write(line, 0, line.length, 0)).bytesWritten === line.length);
    await key.handle.sync();
    installed = line;
    await key.refreshOwnWrite();
    need((await key.read()).equals(line));
    const recheck = async () => {
      try {
        need(!closed);
        await admission.recheck();
        for (const item of locks) need((await item.read()).equals(lockBytes));
        need((await key.read()).equals(line));
        await transport(false);
        await admission.recheck();
        for (const item of locks) need((await item.read()).equals(lockBytes));
        need((await key.read()).equals(line));
      } catch {
        fail();
      }
    };
    await recheck();
    return Object.freeze({
      admission: admission.admission,
      profile,
      scope,
      recheck,
      close: release
    });
  } catch {
    await release().catch(() => {});
    fail();
  }
}

const shutdownFail = () => {
  throw Object.assign(new Error(SHUTDOWN_CODE), { code: SHUTDOWN_CODE });
};
const shutdownNeed = (value) => {
  if (!value) shutdownFail();
};
const shutdownRef = (bytes) => ({ digest: sha256Bytes(bytes), bytes: bytes.length });
const shutdownIdentity = (stat) =>
  Object.fromEntries(
    ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs", "rdev"].map(
      (field) => [field, String(stat[field])]
    )
  );
function shutdownValidateIdentity(value) {
  const fields = [
    "dev",
    "ino",
    "mode",
    "uid",
    "gid",
    "nlink",
    "size",
    "mtimeNs",
    "ctimeNs",
    "rdev"
  ];
  exact(value, fields);
  for (const field of fields)
    shutdownNeed(typeof value[field] === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value[field]));
}
function shutdownTime(value) {
  shutdownNeed(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.parse(value)).toISOString() === value
  );
  return Date.parse(value);
}
function shutdownFreeze(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    Object.values(value).forEach(shutdownFreeze);
    Object.freeze(value);
  }
  return value;
}

// Independent readback after the hosted side has stopped its SSH connections.
// This observes state only; it never truncates a key, kills a process, or releases a lock.
export async function observeR3H1ForwardShutdown(...args) {
  const rawInputs = {};
  const startedAt = new Date().toISOString();
  const processes = [];
  let keyRecord = null;
  let keyHandle = null;
  const evidence = (status) => {
    const observation = shutdownFreeze({
      schemaVersion: "manual-r3-h1-forward-shutdown.v1",
      status,
      promotionEligible: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      key: keyRecord,
      processes: processes.map((entry) => ({
        ...entry,
        args: [...entry.args],
        executable: { ...entry.executable },
        stdout: entry.stdout && { ...entry.stdout },
        stderr: entry.stderr && { ...entry.stderr }
      }))
    });
    return {
      observation,
      observationDigest: sha256Canonical(observation),
      rawInputs: Object.freeze(
        Object.fromEntries(
          Object.entries(rawInputs).map(([name, bytes]) => [name, Buffer.from(bytes)])
        )
      )
    };
  };
  try {
    shutdownNeed(args.length === 0 && process.platform === "linux" && process.getuid?.() === 0);
    await privateDirectory(path.dirname(KEY));
    const before = await fs.lstat(KEY, { bigint: true });
    shutdownNeed(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.uid === 0n &&
        before.gid === 0n &&
        before.nlink === 1n &&
        before.mode === 0o100644n &&
        before.size <= 65536n
    );
    keyHandle = await fs.open(KEY, constants.O_RDONLY | constants.O_NOFOLLOW);
    const held = await keyHandle.stat({ bigint: true });
    shutdownNeed(
      JSON.stringify(shutdownIdentity(held)) === JSON.stringify(shutdownIdentity(before))
    );
    const keyBytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < keyBytes.length) {
      const result = await keyHandle.read(keyBytes, offset, keyBytes.length - offset, offset);
      shutdownNeed(result.bytesRead > 0);
      offset += result.bytesRead;
    }
    rawInputs.key = keyBytes;
    const afterReadHeld = await keyHandle.stat({ bigint: true });
    const afterReadVisible = await fs.lstat(KEY, { bigint: true });
    shutdownNeed(
      JSON.stringify(shutdownIdentity(before)) ===
        JSON.stringify(shutdownIdentity(afterReadHeld)) &&
        JSON.stringify(shutdownIdentity(before)) ===
          JSON.stringify(shutdownIdentity(afterReadVisible))
    );
    keyRecord = {
      path: KEY,
      observedAt: new Date().toISOString(),
      identity: shutdownIdentity(before),
      contents: shutdownRef(keyBytes)
    };
    shutdownNeed(keyBytes.length === 0);
    const run = async ([name, command, args, expected]) => {
      const executable = await fs.stat(command, { bigint: true });
      shutdownNeed(
        executable.isFile() &&
          executable.uid === 0n &&
          (executable.mode & 0o170000n) === 0o100000n &&
          (executable.mode & 0o111n) !== 0n &&
          (executable.mode & 0o022n) === 0n
      );
      const call = {
        name,
        command,
        args: [...args],
        executable: shutdownIdentity(executable),
        startedAt: new Date().toISOString(),
        pid: null,
        closedAt: null,
        exitCode: null,
        signal: null,
        stdout: null,
        stderr: null
      };
      processes.push(call);
      const outcome = await new Promise((resolve) => {
        let child,
          deadlineTimer,
          drainTimer,
          size = 0;
        let settled = false,
          timedOut = false,
          overflow = false,
          spawnError = false;
        const stdout = [],
          stderr = [];
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadlineTimer);
          clearTimeout(drainTimer);
          resolve({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            timedOut,
            overflow,
            spawnError
          });
        };
        const killAndDrain = () => {
          if (timedOut || settled) return;
          timedOut = true;
          try {
            child?.kill("SIGKILL");
          } catch {
            /* Exit must be observed via close. */
          }
          if (!settled) drainTimer = setTimeout(settle, 2000);
        };
        try {
          child = childProcess.spawn(command, args, {
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" }
          });
          call.pid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
          const collect = (target) => (chunk) => {
            if (settled) return;
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > 65536) {
              overflow = true;
              killAndDrain();
            } else target.push(bytes);
          };
          child.stdout.on("data", collect(stdout));
          child.stderr.on("data", collect(stderr));
          child.once("error", () => {
            spawnError = true;
            killAndDrain();
          });
          child.once("close", (exitCode, signal) => {
            if (settled) return;
            Object.assign(call, { closedAt: new Date().toISOString(), exitCode, signal });
            settle();
          });
          deadlineTimer = setTimeout(killAndDrain, 10000);
        } catch {
          spawnError = true;
          if (child) killAndDrain();
          else settle();
        }
      });
      call.stdout = shutdownRef(outcome.stdout);
      call.stderr = shutdownRef(outcome.stderr);
      rawInputs[`${name}.stdout`] = Buffer.from(outcome.stdout);
      rawInputs[`${name}.stderr`] = Buffer.from(outcome.stderr);
      shutdownNeed(
        !outcome.timedOut &&
          !outcome.overflow &&
          !outcome.spawnError &&
          call.pid !== null &&
          call.closedAt !== null &&
          call.exitCode === expected &&
          call.signal === null &&
          outcome.stdout.length === 0 &&
          outcome.stderr.length === 0 &&
          JSON.stringify(shutdownIdentity(await fs.stat(command, { bigint: true }))) ===
            JSON.stringify(call.executable)
      );
    };
    for (const command of SHUTDOWN_COMMANDS) await run(command);
    const finalHeld = await keyHandle.stat({ bigint: true });
    const finalVisible = await fs.lstat(KEY, { bigint: true });
    shutdownNeed(
      JSON.stringify(shutdownIdentity(before)) === JSON.stringify(shutdownIdentity(finalHeld)) &&
        JSON.stringify(shutdownIdentity(before)) === JSON.stringify(shutdownIdentity(finalVisible))
    );
    await keyHandle.close();
    keyHandle = null;
    return evidence("OBSERVED");
  } catch {
    if (keyHandle) await keyHandle.close().catch(() => {});
    throw Object.assign(new Error(SHUTDOWN_CODE), {
      code: SHUTDOWN_CODE,
      ...evidence("INCOMPLETE")
    });
  }
}

export function assessR3H1ForwardShutdown({ observationBytes, rawInputs, now }) {
  try {
    shutdownNeed(
      Buffer.isBuffer(observationBytes) &&
        observationBytes.length > 0 &&
        observationBytes.length <= 1048576
    );
    const observation = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(observationBytes)
    );
    shutdownNeed(encodeManualJson(observation).equals(observationBytes));
    exact(observation, [
      "schemaVersion",
      "status",
      "promotionEligible",
      "startedAt",
      "finishedAt",
      "key",
      "processes"
    ]);
    shutdownNeed(
      observation.schemaVersion === "manual-r3-h1-forward-shutdown.v1" &&
        observation.status === "OBSERVED" &&
        observation.promotionEligible === false
    );
    const started = shutdownTime(observation.startedAt),
      finished = shutdownTime(observation.finishedAt);
    shutdownNeed(started <= finished && finished <= shutdownTime(now));
    exact(rawInputs, ["key", "ss.stdout", "ss.stderr", "pgrep.stdout", "pgrep.stderr"]);
    for (const bytes of Object.values(rawInputs))
      shutdownNeed(Buffer.isBuffer(bytes) && bytes.length <= 65536);
    exact(observation.key, ["path", "observedAt", "identity", "contents"]);
    shutdownNeed(
      observation.key.path === KEY &&
        started <= shutdownTime(observation.key.observedAt) &&
        shutdownTime(observation.key.observedAt) <= finished
    );
    shutdownValidateIdentity(observation.key.identity);
    shutdownNeed(
      observation.key.identity.uid === "0" &&
        observation.key.identity.gid === "0" &&
        observation.key.identity.mode === String(0o100644) &&
        observation.key.identity.nlink === "1" &&
        observation.key.identity.size === "0"
    );
    exact(observation.key.contents, ["digest", "bytes"]);
    shutdownNeed(
      rawInputs.key.length === 0 &&
        observation.key.contents.bytes === 0 &&
        observation.key.contents.digest === sha256Bytes(rawInputs.key)
    );
    shutdownNeed(Array.isArray(observation.processes) && observation.processes.length === 2);
    let previous = shutdownTime(observation.key.observedAt);
    for (const [index, [name, command, args, expected]] of SHUTDOWN_COMMANDS.entries()) {
      const entry = observation.processes[index];
      exact(entry, [
        "name",
        "command",
        "args",
        "executable",
        "startedAt",
        "pid",
        "closedAt",
        "exitCode",
        "signal",
        "stdout",
        "stderr"
      ]);
      shutdownNeed(
        entry.name === name &&
          entry.command === command &&
          sha256Canonical(entry.args) === sha256Canonical(args) &&
          Number.isSafeInteger(entry.pid) &&
          entry.pid > 0 &&
          entry.exitCode === expected &&
          entry.signal === null &&
          previous <= shutdownTime(entry.startedAt) &&
          shutdownTime(entry.startedAt) <= shutdownTime(entry.closedAt) &&
          shutdownTime(entry.closedAt) <= finished
      );
      shutdownValidateIdentity(entry.executable);
      shutdownNeed(
        entry.executable.uid === "0" &&
          typeof entry.executable.mode === "string" &&
          /^(?:0|[1-9][0-9]*)$/u.test(entry.executable.mode) &&
          Number.isSafeInteger(Number(entry.executable.mode)) &&
          Number(entry.executable.mode) <= 0o177777 &&
          (Number(entry.executable.mode) & 0o170000) === 0o100000 &&
          (Number(entry.executable.mode) & 0o111) !== 0 &&
          (Number(entry.executable.mode) & 0o022) === 0
      );
      for (const stream of ["stdout", "stderr"]) {
        exact(entry[stream], ["digest", "bytes"]);
        const bytes = rawInputs[`${name}.${stream}`];
        shutdownNeed(
          entry[stream].digest === sha256Bytes(bytes) &&
            entry[stream].bytes === bytes.length &&
            bytes.length === 0
        );
      }
      previous = shutdownTime(entry.closedAt);
    }
    return shutdownFreeze(JSON.parse(JSON.stringify(observation)));
  } catch {
    shutdownFail();
  }
}
